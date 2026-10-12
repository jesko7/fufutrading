/**
 * Ledger — deterministic accounting for one paper account. Shared by the live paper-trading
 * engine and the backtester so both produce identical P&L, fees, margin and liquidations.
 *
 * Spot: cash (USDT) + long-only holdings at average cost. Fees are charged in USDT.
 * Futures (USDⓈ-M perpetual, one-way mode): wallet balance in USDT, one net position per
 * symbol, cross or isolated margin, Binance maintenance-margin tiers, liquidation and
 * clearance fees, funding payments.
 */
import type { Market, SymbolId } from '../symbols';
import { SYMBOL_SPECS } from '../symbols';
import type { ClosedTrade, MarginMode, OrderSide, Position } from './types';
import { liquidationPrice, maintenanceMargin } from './brackets';

export type Marks = Partial<Record<SymbolId, number>>;

export interface FillInput {
  symbol: SymbolId;
  side: OrderSide;
  qty: number;
  price: number;
  fee: number;
  t: number;
  leverage?: number;
  marginMode?: MarginMode;
  reason?: string;
}

export interface FillResult {
  realized: number;
  closedQty: number;
  openedQty: number;
  closedTrade?: ClosedTrade;
  position?: Position;
}

export interface LiquidationResult {
  symbol: SymbolId;
  price: number;
  qty: number;
  side: 1 | -1;
  realized: number;
  clearanceFee: number;
  bankrupt: boolean;
  closedTrade: ClosedTrade;
}

let posSeq = 0;
const pid = () => `p${Date.now().toString(36)}${(posSeq++).toString(36)}`;

export class Ledger {
  wallet: number;
  readonly positions = new Map<SymbolId, Position>();
  realizedPnl = 0;
  feesPaid = 0;
  fundingPaid = 0;
  liquidationFees = 0;
  closedTrades: ClosedTrade[] = [];
  /** Lifetime fees/funding accumulated on currently open positions (for closed-trade records). */
  constructor(
    readonly market: Market,
    initialBalance: number,
  ) {
    this.wallet = initialBalance;
  }

  // ---------------------------------------------------------------- queries

  position(symbol: SymbolId): Position | undefined {
    return this.positions.get(symbol);
  }

  /** Signed position size (+ long, − short). */
  signedQty(symbol: SymbolId): number {
    const p = this.positions.get(symbol);
    return p ? p.side * p.qty : 0;
  }

  uPnl(p: Position, mark: number): number {
    return (mark - p.entry) * p.qty * p.side;
  }

  isolatedTotal(): number {
    let s = 0;
    for (const p of this.positions.values()) if (p.marginMode === 'isolated') s += p.isolatedMargin;
    return s;
  }

  crossWallet(): number {
    return this.wallet - this.isolatedTotal();
  }

  unrealized(marks: Marks): number {
    let s = 0;
    for (const p of this.positions.values()) {
      const m = marks[p.symbol];
      if (m && m > 0) s += this.uPnl(p, m);
    }
    return s;
  }

  /** Spot: cash + holdings value. Futures: margin balance (wallet + unrealized PnL). */
  equity(marks: Marks): number {
    if (this.market === 'spot') {
      let v = this.wallet;
      for (const p of this.positions.values()) v += p.qty * (marks[p.symbol] || p.entry);
      return v;
    }
    return this.wallet + this.unrealized(marks);
  }

  exposure(marks: Marks): number {
    let s = 0;
    for (const p of this.positions.values()) s += p.qty * (marks[p.symbol] || p.entry);
    return s;
  }

  maintMargin(p: Position, mark: number): number {
    if (this.market === 'spot') return 0;
    return maintenanceMargin(p.symbol, p.qty * mark);
  }

  initialMargin(p: Position, mark: number): number {
    if (this.market === 'spot') return p.qty * mark;
    return (p.qty * mark) / Math.max(1, p.leverage);
  }

  /** Cross margin ratio (maintenance margin / margin balance). */
  marginRatio(marks: Marks): number {
    if (this.market === 'spot') return 0;
    let mm = 0;
    let upnl = 0;
    for (const p of this.positions.values()) {
      if (p.marginMode !== 'cross') continue;
      const m = marks[p.symbol] || p.entry;
      mm += this.maintMargin(p, m);
      upnl += this.uPnl(p, m);
    }
    const mb = this.crossWallet() + upnl;
    if (mm === 0) return 0;
    return mb > 0 ? mm / mb : Infinity;
  }

  /** Margin committed to positions (initial margin at mark; isolated = allocated margin). */
  marginUsed(marks: Marks): number {
    if (this.market === 'spot') return 0;
    let s = 0;
    for (const p of this.positions.values()) s += p.marginMode === 'isolated' ? p.isolatedMargin : this.initialMargin(p, marks[p.symbol] || p.entry);
    return s;
  }

  /** Available balance for new orders (excluding margin reserved by open orders). */
  available(marks: Marks, reservedForOrders = 0): number {
    if (this.market === 'spot') return Math.max(0, this.wallet - reservedForOrders);
    let upnlCross = 0;
    let imCross = 0;
    for (const p of this.positions.values()) {
      if (p.marginMode !== 'cross') continue;
      const m = marks[p.symbol] || p.entry;
      upnlCross += this.uPnl(p, m);
      imCross += this.initialMargin(p, m);
    }
    // Binance does not let unrealized profit increase available balance beyond wallet for new positions
    return Math.max(0, this.crossWallet() + Math.min(0, upnlCross) - imCross - reservedForOrders);
  }

  liqPrice(p: Position, marks: Marks): number {
    if (this.market === 'spot') return NaN;
    if (p.marginMode === 'isolated') return liquidationPrice({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, wallet: p.isolatedMargin }, marks[p.symbol]);
    let otherMM = 0;
    let otherU = 0;
    for (const o of this.positions.values()) {
      if (o === p || o.marginMode !== 'cross') continue;
      const m = marks[o.symbol] || o.entry;
      otherMM += this.maintMargin(o, m);
      otherU += this.uPnl(o, m);
    }
    return liquidationPrice({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, wallet: this.crossWallet(), otherMM, otherUPnL: otherU }, marks[p.symbol]);
  }

  // ---------------------------------------------------------------- mutations

  private record(p: Position, exit: number, t: number, reason?: string): ClosedTrade {
    const notional = p.entry * p.qty;
    const ct: ClosedTrade = {
      id: p.id,
      symbol: p.symbol,
      market: p.market,
      side: p.side,
      qty: p.qty,
      entry: p.entry,
      exit,
      openedAt: p.openedAt,
      closedAt: t,
      pnl: p.realizedPnl - p.fees - p.funding,
      fees: p.fees,
      funding: p.funding,
      returnPct: notional > 0 ? ((p.realizedPnl - p.fees - p.funding) / (this.market === 'futures' ? notional / Math.max(1, p.leverage) : notional)) * 100 : 0,
      mae: p.side === 1 ? (p.minPrice - p.entry) / p.entry : (p.entry - p.maxPrice) / p.entry,
      mfe: p.side === 1 ? (p.maxPrice - p.entry) / p.entry : (p.entry - p.minPrice) / p.entry,
      exitReason: reason,
      leverage: p.leverage,
    };
    this.closedTrades.push(ct);
    return ct;
  }

  /** Track extremes for MAE/MFE. */
  observePrice(symbol: SymbolId, price: number): void {
    const p = this.positions.get(symbol);
    if (!p) return;
    if (price > p.maxPrice) p.maxPrice = price;
    if (price < p.minPrice) p.minPrice = price;
  }

  applyFill(f: FillInput): FillResult {
    if (!(f.qty > 0) || !(f.price > 0)) return { realized: 0, closedQty: 0, openedQty: 0 };
    this.wallet -= f.fee;
    this.feesPaid += f.fee;
    if (this.market === 'spot') return this.spotFill(f);
    return this.futuresFill(f);
  }

  private spotFill(f: FillInput): FillResult {
    const p = this.positions.get(f.symbol);
    if (f.side === 'buy') {
      this.wallet -= f.qty * f.price;
      if (p) {
        p.entry = (p.entry * p.qty + f.price * f.qty) / (p.qty + f.qty);
        p.qty += f.qty;
        p.fees += f.fee;
      } else {
        const np: Position = { id: pid(), symbol: f.symbol, market: 'spot', side: 1, qty: f.qty, entry: f.price, leverage: 1, marginMode: 'cross', isolatedMargin: 0, openedAt: f.t, realizedPnl: 0, fees: f.fee, funding: 0, maxPrice: f.price, minPrice: f.price };
        this.positions.set(f.symbol, np);
      }
      return { realized: 0, closedQty: 0, openedQty: f.qty, position: this.positions.get(f.symbol) };
    }
    // sell (validated by caller: qty <= holding)
    if (!p) return { realized: 0, closedQty: 0, openedQty: 0 };
    const q = Math.min(f.qty, p.qty);
    const realized = (f.price - p.entry) * q;
    this.wallet += q * f.price;
    this.realizedPnl += realized;
    p.realizedPnl += realized;
    p.fees += f.fee;
    p.qty -= q;
    const step = SYMBOL_SPECS[f.symbol].spot.stepSize;
    if (p.qty <= step / 10) {
      const ct = this.record({ ...p, qty: q }, f.price, f.t, f.reason);
      this.positions.delete(f.symbol);
      return { realized, closedQty: q, openedQty: 0, closedTrade: ct };
    }
    return { realized, closedQty: q, openedQty: 0, position: p };
  }

  private futuresFill(f: FillInput): FillResult {
    const dir: 1 | -1 = f.side === 'buy' ? 1 : -1;
    const lev = Math.max(1, f.leverage || 1);
    const mode: MarginMode = f.marginMode || 'cross';
    let p = this.positions.get(f.symbol);
    let remaining = f.qty;
    let realized = 0;
    let closedQty = 0;
    let closedTrade: ClosedTrade | undefined;
    if (p && p.side !== dir) {
      // reduce / close / flip
      const q = Math.min(remaining, p.qty);
      const r = (f.price - p.entry) * q * p.side;
      realized += r;
      closedQty = q;
      this.wallet += r;
      this.realizedPnl += r;
      p.realizedPnl += r;
      // fee share for this closing part
      p.fees += f.fee * (q / f.qty);
      if (p.marginMode === 'isolated') {
        const released = p.isolatedMargin * (q / p.qty);
        p.isolatedMargin -= released;
      }
      const before = p.qty;
      p.qty -= q;
      remaining -= q;
      const step = SYMBOL_SPECS[f.symbol].futures.stepSize;
      if (p.qty <= step / 10) {
        closedTrade = this.record({ ...p, qty: before }, f.price, f.t, f.reason);
        this.positions.delete(f.symbol);
        p = undefined;
      }
    }
    if (remaining > 1e-12) {
      const feePart = f.fee * (remaining / f.qty);
      if (p) {
        // increase same direction
        p.entry = (p.entry * p.qty + f.price * remaining) / (p.qty + remaining);
        p.qty += remaining;
        p.fees += feePart;
        if (p.marginMode === 'isolated') p.isolatedMargin += (remaining * f.price) / p.leverage;
      } else {
        p = {
          id: pid(),
          symbol: f.symbol,
          market: 'futures',
          side: dir,
          qty: remaining,
          entry: f.price,
          leverage: lev,
          marginMode: mode,
          isolatedMargin: mode === 'isolated' ? (remaining * f.price) / lev : 0,
          openedAt: f.t,
          realizedPnl: 0,
          fees: feePart,
          funding: 0,
          maxPrice: f.price,
          minPrice: f.price,
        };
        this.positions.set(f.symbol, p);
      }
    }
    return { realized, closedQty, openedQty: Math.max(0, remaining), closedTrade, position: p };
  }

  /** Funding settlement: positive rate → longs pay shorts. Returns amount paid (negative = received). */
  applyFunding(symbol: SymbolId, rate: number, mark: number): number {
    const p = this.positions.get(symbol);
    if (!p || this.market !== 'futures') return 0;
    const pay = p.qty * mark * rate * p.side;
    this.wallet -= pay;
    this.fundingPaid += pay;
    p.funding += pay;
    if (p.marginMode === 'isolated') p.isolatedMargin = Math.max(0, p.isolatedMargin - pay);
    return pay;
  }

  /** Add/remove isolated margin. */
  adjustIsolatedMargin(symbol: SymbolId, delta: number): boolean {
    const p = this.positions.get(symbol);
    if (!p || p.marginMode !== 'isolated') return false;
    if (delta > 0 && delta > this.crossWallet()) return false;
    if (delta < 0 && -delta > p.isolatedMargin) return false;
    p.isolatedMargin += delta;
    return true;
  }

  /**
   * Positions that must be liquidated at the given marks. Isolated positions are checked
   * individually; for cross margin the position with the largest maintenance margin is
   * returned first (the caller liquidates it and re-checks).
   */
  liquidationCandidates(marks: Marks): SymbolId[] {
    if (this.market !== 'futures') return [];
    const out: SymbolId[] = [];
    let crossMM = 0;
    let crossU = 0;
    let worst: Position | null = null;
    let worstMM = -1;
    for (const p of this.positions.values()) {
      const m = marks[p.symbol];
      if (!(m && m > 0)) continue;
      const mm = this.maintMargin(p, m);
      const u = this.uPnl(p, m);
      if (p.marginMode === 'isolated') {
        if (p.isolatedMargin + u <= mm) out.push(p.symbol);
      } else {
        crossMM += mm;
        crossU += u;
        if (mm > worstMM) {
          worstMM = mm;
          worst = p;
        }
      }
    }
    if (worst && crossMM > 0 && this.crossWallet() + crossU <= crossMM) out.push(worst.symbol);
    return out;
  }

  /**
   * Liquidate a position at `price`. A liquidation clearance fee (rate × notional) is charged
   * from the remaining margin; if the position is bankrupt the loss is capped at its margin
   * (the insurance fund covers the rest) and no clearance fee is charged.
   */
  liquidate(symbol: SymbolId, price: number, t: number, feeRate: number): LiquidationResult | null {
    const p = this.positions.get(symbol);
    if (!p) return null;
    const qty = p.qty;
    const r = (price - p.entry) * qty * p.side;
    const notional = qty * price;
    let realized = r;
    let fee = 0;
    let bankrupt = false;
    if (p.marginMode === 'isolated') {
      const remaining = p.isolatedMargin + r;
      if (remaining <= 0) {
        bankrupt = true;
        realized = -p.isolatedMargin;
      } else fee = Math.min(feeRate * notional, remaining);
    } else {
      const otherIso = this.isolatedTotal();
      const crossAfter = this.wallet - otherIso + r;
      if (crossAfter <= 0) {
        bankrupt = true;
        realized = -(this.wallet - otherIso);
      } else fee = Math.min(feeRate * notional, crossAfter);
    }
    this.wallet += realized - fee;
    this.realizedPnl += realized;
    this.liquidationFees += fee;
    this.feesPaid += fee;
    p.realizedPnl += realized;
    p.fees += fee;
    const closedTrade = this.record({ ...p, qty }, price, t, 'liquidation');
    this.positions.delete(symbol);
    return { symbol, price, qty, side: p.side, realized, clearanceFee: fee, bankrupt, closedTrade };
  }

  /** Serialisable state. */
  toJSON(): unknown {
    return {
      market: this.market,
      wallet: this.wallet,
      positions: [...this.positions.values()],
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      fundingPaid: this.fundingPaid,
      liquidationFees: this.liquidationFees,
    };
  }

  static fromJSON(j: any, initialBalance: number): Ledger {
    const l = new Ledger(j?.market || 'spot', initialBalance);
    if (!j) return l;
    l.wallet = j.wallet;
    for (const p of j.positions || []) l.positions.set(p.symbol, p);
    l.realizedPnl = j.realizedPnl || 0;
    l.feesPaid = j.feesPaid || 0;
    l.fundingPaid = j.fundingPaid || 0;
    l.liquidationFees = j.liquidationFees || 0;
    return l;
  }
}
