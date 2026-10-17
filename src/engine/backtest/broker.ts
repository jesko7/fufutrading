/**
 * StrategyBroker — order handling for backtests (Pine `strategy.*` and the Python Strategy API).
 *
 * Semantics follow TradingView's broker emulator:
 *  - orders created while a bar executes are processed from the next bar's open
 *    (or at the bar's close with process_orders_on_close);
 *  - `entry` reverses an opposite position and honours `pyramiding`;
 *  - orders with an existing id replace the pending order;
 *  - `exit` brackets (profit/loss in ticks or limit/stop prices, trailing stops) belong to an
 *    entry id and are OCA-reduce;
 *  - intrabar fills use the OHLC path (open → nearer extreme → other extreme → close) unless
 *    trade-level ticks are supplied for the bar, in which case fills follow the real sequence.
 * Accounting uses the same Ledger as live paper trading (fees, margin, liquidation, funding).
 */
import { Ledger } from '../../shared/trading/ledger';
import { barPath } from '../../shared/trading/matching';
import { maxLeverageFor, liquidationPrice } from '../../shared/trading/brackets';
import { floorToStep, type SymbolId } from '../../shared/symbols';

export interface BrokerConfig {
  symbol: SymbolId;
  market: 'spot' | 'futures';
  initialCapital: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  makerFee: number;
  takerFee: number;
  flatFee: number;
  /** commission per contract (Pine cash_per_contract) */
  perContractFee: number;
  slippageTicks: number;
  slippageBps: number;
  tick: number;
  step: number;
  minQty: number;
  limitFill: 'touch' | 'through';
  throughTicks: number;
  partialFills: boolean;
  participation: number;
  pyramiding: number;
  processOrdersOnClose: boolean;
  closeEntriesRule: 'FIFO' | 'ANY';
  defaultQty: { type: 'fixed' | 'cash' | 'percent_of_equity'; value: number };
  /** Allow shorting on spot (margin borrow). */
  allowShortSpot: boolean;
  /** Ignore orders before this bar index (indicator warm-up). */
  tradeFrom?: number;
  /** Real OHLC used for fills/equity when the script runs on synthetic bars (Heikin-Ashi). Same length as the script data. */
  fillData?: BarData;
  /** Annual borrow rate for spot shorts (assumption, e.g. 0.1 = 10%/yr), charged hourly. */
  borrowRateAnnual: number;
  liquidationFeeRate: number;
  /** Funding events (futures): time + rate. */
  funding?: { t: Float64Array; rate: Float64Array };
  /** Mark price close per bar (futures). Falls back to trade prices. */
  mark?: { h: Float64Array; l: Float64Array; c: Float64Array };
}

export const DEFAULT_BROKER: Omit<BrokerConfig, 'symbol'> = {
  market: 'spot',
  initialCapital: 10000,
  leverage: 1,
  marginMode: 'cross',
  makerFee: 0.001,
  takerFee: 0.001,
  flatFee: 0,
  perContractFee: 0,
  slippageTicks: 0,
  slippageBps: 0,
  tick: 0.01,
  step: 0.00001,
  minQty: 0,
  limitFill: 'through',
  throughTicks: 0,
  partialFills: false,
  participation: 0.25,
  pyramiding: 0,
  processOrdersOnClose: false,
  closeEntriesRule: 'FIFO',
  defaultQty: { type: 'percent_of_equity', value: 100 },
  allowShortSpot: false,
  borrowRateAnnual: 0,
  liquidationFeeRate: 0.0125,
};

export type OrderKind = 'entry' | 'order' | 'exit' | 'close';

export interface StratOrder {
  id: string;
  kind: OrderKind;
  dir: 1 | -1;
  qty: number;
  qtyPercent?: number;
  limit?: number;
  stop?: number;
  fromEntry?: string;
  profitTicks?: number;
  lossTicks?: number;
  trailPrice?: number;
  trailPoints?: number;
  trailOffset?: number;
  oca?: string;
  ocaType?: 'cancel' | 'reduce' | 'none';
  comment?: string;
  createdBar: number;
  immediately?: boolean;
  /** trailing state */
  trailActive?: boolean;
  trailStop?: number;
  /** stop-limit triggered */
  triggered?: boolean;
  filled?: number;
}

export interface OpenTrade {
  entryId: string;
  dir: 1 | -1;
  qty: number;
  entryPrice: number;
  entryBar: number;
  entryTime: number;
  commission: number;
  comment?: string;
  maxPrice: number;
  minPrice: number;
}

export interface ClosedTradeRec {
  entryId: string;
  exitId: string;
  dir: 1 | -1;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  profit: number;
  commission: number;
  funding: number;
  returnPct: number;
  mae: number;
  mfe: number;
  entryComment?: string;
  exitComment?: string;
  /** cumulative equity after the trade */
  cumProfit: number;
}

export interface FillRec {
  bar: number;
  t: number;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  id: string;
  kind: string;
}

export interface BarData {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  tc: Float64Array;
  length: number;
}

/**
 * A resting strategy order with concrete prices and quantities — what a live bot mirrors onto its
 * paper account. Exits carry the take-profit as `limit` and the stop-loss / trailing stop as `stop`.
 */
export interface PendingSnap {
  id: string;
  kind: OrderKind;
  /** 1 = buy, -1 = sell. */
  side: 1 | -1;
  /** Part of the quantity that closes existing exposure (reversal, exit). */
  closeQty: number;
  /** Part of the quantity that opens new exposure. */
  openQty: number;
  /** The exit covers the whole position. */
  closeAll: boolean;
  limit?: number;
  stop?: number;
  trailing?: boolean;
  fromEntry?: string;
  comment?: string;
}

/** A strategy's position and working orders after a bar (repaint check: live vs backtest). */
export interface StrategyState {
  /** Signed position size. */
  pos: number;
  /** Working orders, described and sorted ('buy 0.5 stop 63500.00 "Long"'). */
  orders: string[];
}

/** strategy.exit ids are namespaced internally so an exit may share its name with an entry. */
const EXIT_NS = '__exit_';
export const publicOrderId = (id: string): string => (id.startsWith(EXIT_NS) ? id.slice(EXIT_NS.length) : id);

/** Optional per-bar trade ticks for trade-level fills. */
/** `path: true` marks a reconstructed price path (bar magnifier) rather than real trades. */
export type TickProvider = (bar: number) => { t: Float64Array; p: Float64Array; q: Float64Array; path?: boolean } | null;

export class StrategyBroker {
  readonly cfg: BrokerConfig;
  readonly ledger: Ledger;
  pending: StratOrder[] = [];
  open: OpenTrade[] = [];
  closed: ClosedTradeRec[] = [];
  fills: FillRec[] = [];
  equity: Float64Array;
  drawdownMax = 0;
  peak: number;
  warnings = new Set<string>();
  liquidations = 0;
  fundingPaid = 0;
  borrowPaid = 0;
  i = 0;
  private fundingIdx = 0;
  private lastBorrowHour = -1;
  private cumProfit = 0;
  ticks: TickProvider | null = null;
  ticksUsedBars = 0;
  /** Bars after which the state is recorded into `states` (repaint check). */
  stateAt: Set<number> | null = null;
  states: Record<number, StrategyState> = {};

  data: BarData;

  constructor(cfg: Partial<BrokerConfig> & { symbol: SymbolId }, data: BarData) {
    this.cfg = { ...DEFAULT_BROKER, ...cfg } as BrokerConfig;
    this.data = cfg.fillData && cfg.fillData.length === data.length ? cfg.fillData : data;
    // spot shorting (margin borrow) needs a ledger that can hold negative positions: model it as 1x
    this.ledger = new Ledger(this.cfg.market === 'spot' && this.cfg.allowShortSpot ? 'futures' : this.cfg.market, this.cfg.initialCapital);
    if (this.cfg.market === 'spot' && this.cfg.allowShortSpot) this.cfg.leverage = 1;
    this.equity = new Float64Array(data.length).fill(NaN);
    this.peak = this.cfg.initialCapital;
  }

  // ------------------------------------------------------------------ state queries (strategy.* variables)

  get positionSize(): number {
    return this.open.reduce((s, t) => s + t.dir * t.qty, 0);
  }

  get positionAvgPrice(): number {
    const q = this.open.reduce((s, t) => s + t.qty, 0);
    return q ? this.open.reduce((s, t) => s + t.entryPrice * t.qty, 0) / q : NaN;
  }

  openProfit(price = this.data.c[this.i]): number {
    return this.open.reduce((s, t) => s + (price - t.entryPrice) * t.qty * t.dir, 0);
  }

  netProfit(): number {
    return this.closed.reduce((s, t) => s + t.profit, 0);
  }

  equityNow(price = this.data.c[this.i]): number {
    return this.ledger.equity({ [this.cfg.symbol]: price });
  }

  // ------------------------------------------------------------------ order submission

  submit(o: Omit<StratOrder, 'createdBar'>): void {
    // warm-up bars before the test range only feed indicators
    if (this.cfg.tradeFrom && this.i < this.cfg.tradeFrom) return;
    const order: StratOrder = { ...o, createdBar: this.i };
    // same id replaces a pending order of the same kind
    const idx = this.pending.findIndex((p) => p.id === order.id && (p.kind === order.kind || (p.kind !== 'exit' && order.kind !== 'exit')));
    if (idx >= 0) {
      const prev = this.pending[idx];
      if (order.kind === 'exit') {
        order.trailActive = prev.trailActive;
        order.trailStop = prev.trailStop;
      }
      this.pending[idx] = order;
    } else this.pending.push(order);
    if (order.immediately && (order.kind === 'close' || (order.kind === 'entry' && order.limit === undefined && order.stop === undefined))) {
      this.fillMarket(order, this.data.c[this.i], this.i);
      this.removeOrder(order);
    }
  }

  /** strategy.cancel: removes pending entries/orders and exits with this name. */
  cancel(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id && p.id !== EXIT_NS + id);
  }

  cancelAll(): void {
    this.pending = [];
  }

  private removeOrder(o: StratOrder): void {
    this.pending = this.pending.filter((p) => p !== o);
  }

  /**
   * Fill market orders still pending after the last bar as if the next bar opened at `price`.
   * Live bots act when a bar closes, which is the moment the next bar opens.
   */
  flushMarket(price = this.data.c[this.i]): void {
    if (!(price > 0)) return;
    const markets = this.pending.filter((p) => p.limit === undefined && p.stop === undefined && p.kind !== 'exit');
    if (!markets.length) return;
    const f0 = this.fills.length;
    const c0 = this.closed.length;
    const before = new Set(this.open);
    for (const m of markets) {
      this.removeOrder(m);
      this.fillMarket(m, price, this.i);
    }
    // these fills happen when the bar closes, i.e. at the next bar's open
    const t = this.data.tc && this.data.tc[this.i] > 0 ? this.data.tc[this.i] : this.data.t[this.i];
    for (let k = f0; k < this.fills.length; k++) {
      this.fills[k].t = t;
      this.fills[k].bar = this.i + 1;
    }
    for (let k = c0; k < this.closed.length; k++) {
      this.closed[k].exitTime = t;
      this.closed[k].exitBar = this.i + 1;
    }
    for (const tr of this.open) {
      if (before.has(tr)) continue;
      tr.entryTime = t;
      tr.entryBar = this.i + 1;
    }
  }

  /** Resting orders with resolved prices and quantities (market orders are not included — see flushMarket). */
  pendingSnapshot(price = this.data.c[this.i]): PendingSnap[] {
    const out: PendingSnap[] = [];
    const pos = this.positionSize;
    for (const o of this.pending) {
      if (o.kind === 'exit') {
        const trades = this.open.filter((t) => !o.fromEntry || t.entryId === o.fromEntry);
        if (!trades.length) continue;
        let q = trades.reduce((s, t) => s + t.qty, 0);
        if (o.qtyPercent !== undefined) q *= o.qtyPercent / 100;
        else if (o.qty > 0) q = Math.min(q, o.qty);
        q = this.roundQty(q);
        if (!(q > 0)) continue;
        const dir = trades[0].dir;
        const { tp, sl, trail } = this.exitLevels(o);
        const stop = trail !== undefined && sl !== undefined ? (dir === 1 ? Math.max(sl, trail) : Math.min(sl, trail)) : (trail ?? sl);
        if (tp === undefined && stop === undefined) continue;
        out.push({ id: publicOrderId(o.id), kind: 'exit', side: -dir as 1 | -1, closeQty: q, openQty: 0, closeAll: q >= Math.abs(pos) - 1e-12, limit: tp, stop, trailing: trail !== undefined && stop === trail, fromEntry: o.fromEntry, comment: o.comment });
        continue;
      }
      if (o.kind === 'close' || (o.limit === undefined && o.stop === undefined)) continue;
      const ref = o.limit ?? o.stop ?? price;
      if (!(ref > 0)) continue;
      let open = this.resolveQty(o, ref);
      let close = 0;
      if (o.kind === 'entry') {
        if (pos !== 0 && Math.sign(pos) === o.dir && this.open.filter((t) => t.dir === o.dir).length > this.cfg.pyramiding) continue;
        if (pos !== 0 && Math.sign(pos) !== o.dir) close = Math.abs(pos);
      } else if (pos !== 0 && Math.sign(pos) !== o.dir) {
        close = Math.min(Math.abs(pos), open);
        open -= close;
      }
      if (!(open + close > 0)) continue;
      out.push({ id: o.id, kind: o.kind, side: o.dir, closeQty: close, openQty: open, closeAll: false, limit: o.limit, stop: o.triggered ? undefined : o.stop, fromEntry: o.fromEntry, comment: o.comment });
    }
    return out;
  }

  /** Position and working orders now: market orders waiting for the next bar and resting orders with resolved prices. */
  stateNow(price = this.data.c[this.i]): StrategyState {
    const tick = this.cfg.tick > 0 ? this.cfg.tick : 1e-8;
    const dec = Math.max(0, Math.min(10, Math.ceil(-Math.log10(tick) - 1e-9)));
    const px = (x: number) => (Math.round(x / tick) * tick).toFixed(dec);
    const qty = (x: number) => String(+x.toPrecision(6));
    const orders: string[] = [];
    for (const o of this.pending) {
      if (o.kind === 'exit' || o.limit !== undefined || o.stop !== undefined) continue;
      orders.push(o.kind === 'close' ? `close "${publicOrderId(o.id)}" at market` : `${o.dir > 0 ? 'buy' : 'sell'}${o.qty > 0 ? ` ${qty(o.qty)}` : ''} at market "${publicOrderId(o.id)}"`);
    }
    for (const s of this.pendingSnapshot(price)) {
      const at = [s.limit !== undefined ? `limit ${px(s.limit)}` : '', s.stop !== undefined ? `${s.trailing ? 'trailing stop' : 'stop'} ${px(s.stop)}` : ''].filter(Boolean).join(' / ');
      orders.push(`${s.side > 0 ? 'buy' : 'sell'} ${qty(s.closeQty + s.openQty)} ${at} "${s.id}"`);
    }
    return { pos: +this.positionSize.toPrecision(10), orders: orders.sort() };
  }

  // ------------------------------------------------------------------ quantities

  resolveQty(o: StratOrder, price: number): number {
    if (o.qty > 0 && isFinite(o.qty)) return this.roundQty(o.qty);
    const d = this.cfg.defaultQty;
    const eq = this.equityNow(price);
    let q: number;
    if (d.type === 'fixed') q = d.value;
    else if (d.type === 'cash') q = d.value / price;
    else q = ((eq * d.value) / 100) / price;
    if (this.cfg.market === 'futures' && d.type === 'percent_of_equity') q *= this.cfg.leverage;
    return this.roundQty(q);
  }

  private roundQty(q: number): number {
    const s = this.cfg.step;
    return s > 0 ? floorToStep(q, s) : q;
  }

  private slipPrice(price: number, side: 1 | -1): number {
    let p = price + side * this.cfg.slippageTicks * this.cfg.tick;
    if (this.cfg.slippageBps) p *= 1 + (side * this.cfg.slippageBps) / 10000;
    return p;
  }

  private fee(qty: number, price: number, maker: boolean): number {
    return qty * price * (maker ? this.cfg.makerFee : this.cfg.takerFee) + this.cfg.flatFee + qty * this.cfg.perContractFee;
  }

  // ------------------------------------------------------------------ fills

  /** Execute a signed quantity change; maintains Pine-style trades. */
  private execute(o: StratOrder, side: 1 | -1, qty: number, price: number, bar: number, maker: boolean): void {
    if (!(qty > 0)) return;
    const t = this.data.t[bar];
    // capacity checks: spot cash / no shorting; futures margin & bracket limits
    const pos = this.positionSize;
    const increasing = pos === 0 || Math.sign(pos) === side;
    if (this.cfg.market === 'spot') {
      if (side === -1 && pos - qty < -1e-12 && !this.cfg.allowShortSpot) {
        const allowed = Math.max(0, pos);
        if (allowed < qty) {
          this.warnings.add('Spot backtest: short orders were reduced to the held quantity (enable margin shorting with a borrow-rate assumption to short spot).');
          qty = this.roundQty(allowed);
          if (!(qty > 0)) return;
        }
      }
      if (side === 1 && increasing) {
        const cash = this.ledger.wallet;
        const maxQ = this.roundQty(cash / (price * (1 + this.cfg.takerFee) + 1e-12));
        if (qty > maxQ) {
          this.warnings.add('Spot backtest: order size was reduced to the available cash.');
          qty = maxQ;
          if (!(qty > 0)) return;
        }
      }
    } else if (increasing || Math.abs(pos) < qty) {
      const newAbs = Math.abs(pos + side * qty);
      const lev = this.cfg.leverage;
      const maxLev = maxLeverageFor(this.cfg.symbol, newAbs * price);
      if (lev > maxLev) this.warnings.add(`Leverage ${lev}x exceeds Binance's bracket limit (${maxLev}x) at a position of ${(newAbs * price).toFixed(0)} USDT.`);
      const marks = { [this.cfg.symbol]: price };
      const avail = this.ledger.available(marks);
      const addQty = increasing ? qty : qty - Math.abs(pos);
      const need = (addQty * price) / lev;
      if (need > avail + 1e-9) {
        const maxAdd = this.roundQty((avail * lev) / price);
        this.warnings.add('Futures backtest: order size was reduced to the available margin.');
        qty = increasing ? maxAdd : Math.abs(pos) + maxAdd;
        if (!(qty > 0)) return;
      }
    }
    const fee = this.fee(qty, price, maker);
    this.ledger.applyFill({ symbol: this.cfg.symbol, side: side === 1 ? 'buy' : 'sell', qty, price, fee, t, leverage: this.cfg.leverage, marginMode: this.cfg.marginMode });
    this.fills.push({ bar, t, side: side === 1 ? 'buy' : 'sell', qty, price, fee, id: publicOrderId(o.id), kind: o.kind });
    // trade bookkeeping
    let rem = qty;
    let feeLeft = fee;
    const feeShare = (q: number) => (fee * q) / qty;
    // close opposite trades first
    const closeOrder = o.kind === 'exit' || o.kind === 'close';
    while (rem > 1e-12) {
      const idx = this.pickTradeToClose(side, closeOrder ? o.fromEntry : undefined);
      if (idx < 0) break;
      const tr = this.open[idx];
      const q = Math.min(rem, tr.qty);
      const share = feeShare(q);
      feeLeft -= share;
      const entryComm = tr.commission * (q / tr.qty);
      const profit = (price - tr.entryPrice) * q * tr.dir - entryComm - share;
      this.cumProfit += profit;
      this.closed.push({
        entryId: tr.entryId,
        exitId: publicOrderId(o.id),
        dir: tr.dir,
        qty: q,
        entryPrice: tr.entryPrice,
        exitPrice: price,
        entryBar: tr.entryBar,
        exitBar: bar,
        entryTime: tr.entryTime,
        exitTime: t,
        profit,
        commission: entryComm + share,
        funding: 0,
        returnPct: ((price - tr.entryPrice) / tr.entryPrice) * 100 * tr.dir,
        mae: tr.dir === 1 ? (tr.minPrice - tr.entryPrice) / tr.entryPrice : (tr.entryPrice - tr.maxPrice) / tr.entryPrice,
        mfe: tr.dir === 1 ? (tr.maxPrice - tr.entryPrice) / tr.entryPrice : (tr.entryPrice - tr.minPrice) / tr.entryPrice,
        entryComment: tr.comment,
        exitComment: o.comment,
        cumProfit: this.cumProfit,
      });
      tr.qty -= q;
      tr.commission -= entryComm;
      rem -= q;
      if (tr.qty <= 1e-12) this.open.splice(idx, 1);
    }
    if (rem > 1e-12 && !closeOrder) {
      this.open.push({ entryId: o.id, dir: side, qty: rem, entryPrice: price, entryBar: bar, entryTime: t, commission: Math.max(0, feeLeft), comment: o.comment, maxPrice: price, minPrice: price });
    }
    // exits whose entry no longer exists are cancelled
    if (!this.open.length) this.pending = this.pending.filter((p) => p.kind !== 'exit' || p.createdBar === bar);
  }

  private pickTradeToClose(side: 1 | -1, fromEntry?: string): number {
    for (let k = 0; k < this.open.length; k++) {
      const tr = this.open[k];
      if (tr.dir === side) continue;
      if (fromEntry && tr.entryId !== fromEntry) continue;
      return k;
    }
    return -1;
  }

  private fillMarket(o: StratOrder, ref: number, bar: number): void {
    const pos = this.positionSize;
    if (o.kind === 'close') {
      const trades = this.open.filter((t) => !o.fromEntry || t.entryId === o.fromEntry);
      let q = trades.reduce((s, t) => s + t.qty, 0);
      if (o.qtyPercent !== undefined) q *= o.qtyPercent / 100;
      else if (o.qty > 0) q = Math.min(q, o.qty);
      if (!(q > 0) || !trades.length) return;
      const side = (-trades[0].dir) as 1 | -1;
      this.execute(o, side, this.roundQty(q), this.slipPrice(ref, side), bar, false);
      return;
    }
    const side = o.dir;
    let qty = this.resolveQty(o, ref);
    if (o.kind === 'entry') {
      if (pos !== 0 && Math.sign(pos) === side) {
        const entries = this.open.filter((t) => t.dir === side).length;
        if (entries > this.cfg.pyramiding) return; // pyramiding limit
      }
      if (pos !== 0 && Math.sign(pos) !== side) qty += Math.abs(pos); // reverse
    }
    this.execute(o, side, qty, this.slipPrice(ref, side), bar, false);
  }

  // ------------------------------------------------------------------ bar processing

  /** Process pending orders on bar `i` before the script runs on its close. */
  processBar(i: number): void {
    this.i = i;
    const d = this.data;
    const o = d.o[i];
    for (const tr of this.open) {
      if (d.h[i] > tr.maxPrice) tr.maxPrice = d.h[i];
      if (d.l[i] < tr.minPrice) tr.minPrice = d.l[i];
    }
    this.applyFunding(i);
    this.applyBorrow(i);
    // 1) market orders from the previous bar fill at this bar's open
    const markets = this.pending.filter((p) => p.createdBar < i && p.limit === undefined && p.stop === undefined && p.kind !== 'exit');
    for (const m of markets) {
      this.removeOrder(m);
      this.fillMarket(m, o, i);
    }
    // 2) price-dependent orders along the intrabar path (or real ticks)
    const ticks = this.ticks?.(i) || null;
    if (ticks && ticks.p.length) {
      this.ticksUsedBars++;
      let prev = o;
      for (let k = 0; k < ticks.p.length; k++) {
        this.segment(prev, ticks.p[k], ticks.q[k], i, !ticks.path);
        prev = ticks.p[k];
      }
    } else {
      const path = barPath(o, d.h[i], d.l[i], d.c[i]);
      for (let k = 1; k < path.length; k++) this.segment(path[k - 1], path[k], d.v[i] / 3, i, false);
    }
    this.checkLiquidation(i);
  }

  /** After the script ran on bar i: process-on-close fills and equity. */
  endBar(i: number): void {
    const c = this.data.c[i];
    if (this.cfg.processOrdersOnClose) {
      const markets = this.pending.filter((p) => p.limit === undefined && p.stop === undefined && p.kind !== 'exit');
      for (const m of markets) {
        this.removeOrder(m);
        this.fillMarket(m, c, i);
      }
    }
    if (this.stateAt?.has(i)) this.states[i] = this.stateNow(c);
    const eq = this.equityNow(c);
    this.equity[i] = eq;
    if (eq > this.peak) this.peak = eq;
    const dd = this.peak - eq;
    if (dd > this.drawdownMax) this.drawdownMax = dd;
  }

  /** Evaluate price-dependent orders on one price segment. */
  private segment(from: number, to: number, volume: number, bar: number, tick: boolean): void {
    for (let guard = 0; guard < 20; guard++) {
      const cands: { o: StratOrder; at: number; price: number; maker: boolean; qty?: number }[] = [];
      for (const o of this.pending) {
        if (o.createdBar >= bar && !this.cfg.processOrdersOnClose && o.createdBar === bar) continue;
        const ev = this.evaluate(o, from, to, volume, tick);
        if (ev) cands.push({ o, ...ev });
      }
      if (!cands.length) return;
      cands.sort((a, b) => a.at - b.at);
      const first = cands[0];
      this.fillPriceOrder(first.o, first.price, first.maker, bar, first.qty);
      // re-evaluate remaining orders from the fill point (position changed)
      from = first.price;
    }
  }

  private exitLevels(o: StratOrder): { tp?: number; sl?: number; trail?: number } {
    const trades = this.open.filter((t) => !o.fromEntry || t.entryId === o.fromEntry);
    if (!trades.length) return {};
    const dir = trades[0].dir;
    const avg = trades.reduce((s, t) => s + t.entryPrice * t.qty, 0) / trades.reduce((s, t) => s + t.qty, 0);
    const tick = this.cfg.tick;
    let tp = o.limit;
    let sl = o.stop;
    if (tp === undefined && o.profitTicks !== undefined) tp = avg + dir * o.profitTicks * tick;
    if (sl === undefined && o.lossTicks !== undefined) sl = avg - dir * o.lossTicks * tick;
    return { tp, sl, trail: o.trailActive ? o.trailStop : undefined };
  }

  private evaluate(o: StratOrder, from: number, to: number, volume: number, tick: boolean): { at: number; price: number; maker: boolean; qty?: number } | null {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const at = (lvl: number) => (to === from ? 0 : Math.max(0, Math.min(1, (lvl - from) / (to - from))));
    const thr = this.cfg.limitFill === 'through' ? this.cfg.throughTicks * this.cfg.tick + (tick ? 1e-12 : 0) : -1e-12;
    if (o.kind === 'exit') {
      const trades = this.open.filter((t) => !o.fromEntry || t.entryId === o.fromEntry);
      if (!trades.length) return null;
      const dir = trades[0].dir;
      // trailing activation & update
      if (o.trailPoints !== undefined || o.trailPrice !== undefined) {
        const avg = this.positionAvgPrice;
        const act = o.trailPrice ?? avg + dir * (o.trailPoints || 0) * this.cfg.tick;
        const off = (o.trailOffset || 0) * this.cfg.tick;
        const best = dir === 1 ? hi : lo;
        if (!o.trailActive && (dir === 1 ? hi >= act : lo <= act)) o.trailActive = true;
        if (o.trailActive) {
          const ts = best - dir * off;
          o.trailStop = o.trailStop === undefined ? ts : dir === 1 ? Math.max(o.trailStop, ts) : Math.min(o.trailStop, ts);
        }
      }
      const { tp, sl, trail } = this.exitLevels(o);
      const out: { at: number; price: number; maker: boolean }[] = [];
      if (tp !== undefined) {
        if (dir === 1 && hi >= tp + thr) out.push({ at: from >= tp ? 0 : at(tp), price: Math.max(tp, from >= tp ? from : tp), maker: true });
        if (dir === -1 && lo <= tp - thr) out.push({ at: from <= tp ? 0 : at(tp), price: Math.min(tp, from <= tp ? from : tp), maker: true });
      }
      const stops = [sl, trail].filter((x) => x !== undefined) as number[];
      for (const s of stops) {
        if (dir === 1 && lo <= s) out.push({ at: from <= s ? 0 : at(s), price: from <= s ? from : s, maker: false });
        if (dir === -1 && hi >= s) out.push({ at: from >= s ? 0 : at(s), price: from >= s ? from : s, maker: false });
      }
      if (!out.length) return null;
      out.sort((a, b) => a.at - b.at);
      return out[0];
    }
    const side = o.kind === 'close' ? (-(this.open[0]?.dir || 1) as 1 | -1) : o.dir;
    // stop (or stop part of stop-limit)
    if (o.stop !== undefined && !o.triggered) {
      const hit = side === 1 ? hi >= o.stop : lo <= o.stop;
      if (!hit) return null;
      const gap = side === 1 ? from >= o.stop : from <= o.stop;
      if (o.limit !== undefined) {
        o.triggered = true;
        // continue as limit in the same segment
      } else return { at: gap ? 0 : at(o.stop), price: gap ? from : o.stop, maker: false };
    }
    if (o.limit !== undefined) {
      const L = o.limit;
      if (side === 1 ? lo > L - thr : hi < L + thr) return null;
      const gap = side === 1 ? from <= L - thr : from >= L + thr;
      const price = gap ? (side === 1 ? Math.min(L, from) : Math.max(L, from)) : L;
      let qty: number | undefined;
      if (this.cfg.partialFills && tick && Math.abs((side === 1 ? lo : hi) - L) < 1e-12) qty = volume * this.cfg.participation;
      return { at: gap ? 0 : at(L), price, maker: true, qty };
    }
    return null;
  }

  private fillPriceOrder(o: StratOrder, price: number, maker: boolean, bar: number, partialQty?: number): void {
    if (o.kind === 'exit') {
      const trades = this.open.filter((t) => !o.fromEntry || t.entryId === o.fromEntry);
      if (!trades.length) {
        this.removeOrder(o);
        return;
      }
      let q = trades.reduce((s, t) => s + t.qty, 0);
      if (o.qtyPercent !== undefined) q *= o.qtyPercent / 100;
      else if (o.qty > 0) q = Math.min(q, o.qty);
      const side = (-trades[0].dir) as 1 | -1;
      const px = maker ? price : this.slipPrice(price, side);
      this.execute({ ...o }, side, this.roundQty(q), px, bar, maker);
      this.removeOrder(o);
      return;
    }
    if (partialQty !== undefined) {
      const full = this.resolveQty(o, price);
      const take = Math.min(full - (o.filled || 0), this.roundQty(partialQty));
      if (take > 0) {
        this.execute(o, o.dir, take, price, bar, maker);
        o.filled = (o.filled || 0) + take;
      }
      if ((o.filled || 0) >= full - 1e-12) this.removeOrder(o);
      return;
    }
    this.removeOrder(o);
    if (o.kind === 'entry' || o.kind === 'order') {
      const pos = this.positionSize;
      let qty = this.resolveQty(o, price);
      if (o.kind === 'entry') {
        if (pos !== 0 && Math.sign(pos) === o.dir && this.open.filter((t) => t.dir === o.dir).length > this.cfg.pyramiding) return;
        if (pos !== 0 && Math.sign(pos) !== o.dir) qty += Math.abs(pos);
      }
      const px = maker ? price : this.slipPrice(price, o.dir);
      this.execute(o, o.dir, qty, px, bar, maker);
    } else if (o.kind === 'close') this.fillMarket(o, price, bar);
    // OCA cancel
    if (o.oca && o.ocaType === 'cancel') this.pending = this.pending.filter((p) => p.oca !== o.oca);
  }

  // ------------------------------------------------------------------ futures / margin specifics

  private checkLiquidation(i: number): void {
    if (this.cfg.market !== 'futures' || !this.ledger.positions.size) return;
    const pos = this.ledger.position(this.cfg.symbol)!;
    const wallet = pos.marginMode === 'isolated' ? pos.isolatedMargin : this.ledger.crossWallet();
    const lp = liquidationPrice({ symbol: this.cfg.symbol, side: pos.side, qty: pos.qty, entry: pos.entry, wallet });
    if (!(lp > 0)) return;
    const mh = this.cfg.mark ? this.cfg.mark.h[i] : this.data.h[i];
    const ml = this.cfg.mark ? this.cfg.mark.l[i] : this.data.l[i];
    const hit = pos.side === 1 ? ml <= lp : mh >= lp;
    if (!hit) return;
    const t = this.data.t[i];
    const opened = this.data.o[i];
    const px = pos.side === 1 ? Math.min(lp, opened) : Math.max(lp, opened);
    const res = this.ledger.liquidate(this.cfg.symbol, px, t, this.cfg.liquidationFeeRate);
    if (!res) return;
    this.liquidations++;
    this.warnings.add('Positions were liquidated (Binance liquidation formula with maintenance-margin tiers).');
    for (const tr of this.open.splice(0)) {
      const profit = (px - tr.entryPrice) * tr.qty * tr.dir - tr.commission;
      this.cumProfit += profit;
      this.closed.push({ entryId: tr.entryId, exitId: 'Liquidation', dir: tr.dir, qty: tr.qty, entryPrice: tr.entryPrice, exitPrice: px, entryBar: tr.entryBar, exitBar: i, entryTime: tr.entryTime, exitTime: t, profit, commission: tr.commission + res.clearanceFee, funding: 0, returnPct: ((px - tr.entryPrice) / tr.entryPrice) * 100 * tr.dir, mae: 0, mfe: 0, entryComment: tr.comment, exitComment: 'liquidation', cumProfit: this.cumProfit });
    }
    this.pending = this.pending.filter((p) => p.kind !== 'exit');
    this.fills.push({ bar: i, t, side: pos.side === 1 ? 'sell' : 'buy', qty: pos.qty, price: px, fee: res.clearanceFee, id: 'liquidation', kind: 'liquidation' });
  }

  private applyFunding(i: number): void {
    const f = this.cfg.funding;
    if (!f || this.cfg.market !== 'futures') return;
    const t0 = i > 0 ? this.data.t[i - 1] : this.data.t[i];
    const t1 = this.data.t[i];
    while (this.fundingIdx < f.t.length && f.t[this.fundingIdx] <= t1) {
      const ft = f.t[this.fundingIdx];
      if (ft > t0 || i === 0) {
        const mark = this.cfg.mark ? this.cfg.mark.c[Math.max(0, i - 1)] : this.data.o[i];
        const paid = this.ledger.applyFunding(this.cfg.symbol, f.rate[this.fundingIdx], mark);
        if (paid) {
          this.fundingPaid += paid;
          this.cumProfit -= paid;
        }
      }
      this.fundingIdx++;
    }
  }

  private applyBorrow(i: number): void {
    if (this.cfg.market !== 'spot' || !this.cfg.allowShortSpot || !(this.cfg.borrowRateAnnual > 0)) return;
    const pos = this.positionSize;
    if (pos >= 0) return;
    const hour = Math.floor(this.data.t[i] / 3600000);
    if (hour === this.lastBorrowHour) return;
    const hours = this.lastBorrowHour < 0 ? 1 : hour - this.lastBorrowHour;
    this.lastBorrowHour = hour;
    const cost = Math.abs(pos) * this.data.o[i] * (this.cfg.borrowRateAnnual / (365 * 24)) * hours;
    this.ledger.wallet -= cost;
    this.borrowPaid += cost;
    this.cumProfit -= cost;
  }
}
