/**
 * AccountRuntime — one paper account: config, ledger, open orders, history and prop rules.
 * Market access is abstracted (MarketCtx) so the same runtime serves live paper trading,
 * bots and historical replay.
 */
import type { Market, SymbolId } from '../symbols';
import { SYMBOL_SPECS, floorToStep, priceDecimals, qtyDecimals, roundToTick } from '../symbols';
import { Ledger, type Marks } from './ledger';
import { evaluateOrder, slip, type MatchDecision, type Segment } from './matching';
import { maxLeverageFor } from './brackets';
import type { AccountConfig, AccountEvent, AccountSnapshot, ClosedTrade, Fill, Order, OrderSide, PlaceOrderRequest, Position } from './types';
import { PropRules, type RuleInput } from '../propfirm/engine';
import { profileById } from '../propfirm/profiles';
import type { PropState } from '../propfirm/types';

export interface MarketCtx {
  now(): number;
  last(market: Market, symbol: SymbolId): number;
  mark(symbol: SymbolId): number;
  /** Order-book sweep for market fills, optionally capped at a limit price (null when no synced book is available). */
  sweep?(market: Market, symbol: SymbolId, side: OrderSide, qty: number, limit?: number): { avgPrice: number; filled: number; worstPrice: number } | null;
  bestBidAsk?(market: Market, symbol: SymbolId): { bid: number; ask: number } | null;
}

export interface PersistedAccount {
  id: string;
  config: AccountConfig;
  ledger: unknown;
  orders: Order[];
  fills: Fill[];
  trades: ClosedTrade[];
  events: AccountEvent[];
  equity: [number, number, number][];
  prop?: PropState;
  dayKey: string;
  dayStartEquity: number;
  marginCallActive: boolean;
  pendingBrackets: Record<string, { sl?: number; tp?: number }>;
  version: 1;
}

let seq = 0;
const oid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export class OrderError extends Error {}

export class AccountRuntime {
  config: AccountConfig;
  ledger: Ledger;
  orders: Order[] = [];
  fills: Fill[] = [];
  trades: ClosedTrade[] = [];
  events: AccountEvent[] = [];
  equity: [number, number, number][] = [];
  prop: PropRules | null = null;
  dayKey = '';
  dayStartEquity: number;
  marginCallActive = false;
  /** Brackets to attach when an entry order fills (orderId -> prices). */
  pendingBrackets: Record<string, { sl?: number; tp?: number }> = {};
  /** Hook for notifications (fills, liquidations, breaches…). */
  onEvent: (e: AccountEvent) => void = () => {};
  onChange: () => void = () => {};
  private lastPrices: Partial<Record<SymbolId, number>> = {};

  constructor(config: AccountConfig, persisted?: PersistedAccount) {
    this.config = config;
    this.ledger = persisted ? Ledger.fromJSON(persisted.ledger, config.initialBalance) : new Ledger(config.market, config.initialBalance);
    this.dayStartEquity = config.initialBalance;
    if (persisted) {
      this.orders = persisted.orders || [];
      this.fills = persisted.fills || [];
      this.trades = persisted.trades || [];
      this.events = persisted.events || [];
      this.equity = persisted.equity || [];
      this.dayKey = persisted.dayKey || '';
      this.dayStartEquity = persisted.dayStartEquity ?? config.initialBalance;
      this.marginCallActive = !!persisted.marginCallActive;
      this.pendingBrackets = persisted.pendingBrackets || {};
    }
    if (config.prop) {
      const prof = profileById(config.prop.profileId);
      if (prof) this.prop = new PropRules(prof, persisted?.prop || PropRules.init(prof, config.prop.size, config.prop.options, config.createdAt));
    }
  }

  toPersisted(): PersistedAccount {
    return {
      id: this.config.id,
      config: this.config,
      ledger: this.ledger.toJSON(),
      orders: this.orders,
      fills: this.fills.slice(-5000),
      trades: this.trades.slice(-20000),
      events: this.events.slice(-2000),
      equity: this.equity,
      prop: this.prop?.state,
      dayKey: this.dayKey,
      dayStartEquity: this.dayStartEquity,
      marginCallActive: this.marginCallActive,
      pendingBrackets: this.pendingBrackets,
      version: 1,
    };
  }

  // ---------------------------------------------------------------- helpers

  event(kind: AccountEvent['kind'], message: string, data?: Record<string, unknown>, t = Date.now()): void {
    const e: AccountEvent = { t, kind, message, data };
    this.events.push(e);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    this.onEvent(e);
  }

  private spec(symbol: SymbolId) {
    return SYMBOL_SPECS[symbol][this.config.market];
  }

  leverageFor(symbol: SymbolId): number {
    if (this.config.market === 'spot') return 1;
    return this.config.futures.leverage[symbol] || this.config.futures.defaultLeverage;
  }

  /**
   * Change a symbol's leverage as Binance allows it: also with an open position, within the
   * leverage bracket for the position's size. Cross positions can go up or down (down needs
   * enough available balance for the larger initial margin); isolated positions can only go up
   * and keep their allocated margin.
   */
  setLeverage(symbol: SymbolId, L: number, ctx: MarketCtx): number {
    if (this.config.market !== 'futures') throw new OrderError('Leverage applies to futures accounts');
    const max = Math.min(this.config.risk.maxLeverage, SYMBOL_SPECS[symbol].futures.maxLeverage);
    L = Math.round(L);
    if (!(L >= 1 && L <= max)) throw new OrderError(`Leverage must be 1–${max}x`);
    const old = this.leverageFor(symbol);
    if (L === old) return L;
    const pos = this.ledger.position(symbol);
    const marks = this.marks(ctx);
    if (pos) {
      const notional = pos.qty * (marks[symbol] || pos.entry);
      const bracketMax = maxLeverageFor(symbol, notional);
      if (L > bracketMax) throw new OrderError(`A position of ${notional.toFixed(0)} USDT allows at most ${bracketMax}x (Binance leverage brackets)`);
      if (pos.marginMode === 'isolated' && L < pos.leverage) throw new OrderError('Binance doesn’t allow lowering the leverage of an open isolated position. Add margin to it instead.');
    }
    if (L < old) {
      // more initial margin for the cross position and the symbol's open orders
      const posIm = pos && pos.marginMode === 'cross' ? pos.qty * (marks[symbol] || pos.entry) : 0;
      const orders = this.reserved(ctx, symbol).quote * old;
      const extra = (posIm + orders) * (1 / L - 1 / old);
      const avail = this.ledger.available(marks, this.reserved(ctx).quote);
      if (extra > avail + 1e-9) throw new OrderError(`Insufficient margin for ${L}x: needs ${extra.toFixed(2)} USDT more, ${avail.toFixed(2)} available`);
    }
    if (pos) pos.leverage = L;
    this.config.futures.leverage = { ...this.config.futures.leverage, [symbol]: L };
    this.event('info', `${symbol} leverage set to ${L}x`, undefined, ctx.now());
    this.onChange();
    return L;
  }

  /** Isolated margin that can be removed: the position keeps its initial margin (and covers losses). */
  maxRemovableMargin(p: Position, mark: number): number {
    if (p.marginMode !== 'isolated') return 0;
    return Math.max(0, p.isolatedMargin + Math.min(0, this.ledger.uPnl(p, mark)) - (p.qty * mark) / Math.max(1, p.leverage));
  }

  /** Add (+) or remove (−) margin of an open isolated position, within Binance's limits. */
  adjustMargin(symbol: SymbolId, delta: number, ctx: MarketCtx): void {
    const pos = this.ledger.position(symbol);
    if (!pos || pos.marginMode !== 'isolated') throw new OrderError('Margin can only be adjusted on an open isolated position');
    if (!(Math.abs(delta) > 0) || !isFinite(delta)) throw new OrderError('Enter an amount');
    const marks = this.marks(ctx);
    const mark = marks[symbol] || pos.entry;
    if (delta > 0) {
      const avail = this.ledger.available(marks, this.reserved(ctx).quote);
      if (delta > avail + 1e-9) throw new OrderError(`Only ${avail.toFixed(2)} USDT available to add`);
    } else {
      const max = this.maxRemovableMargin(pos, mark);
      if (-delta > max + 1e-9) throw new OrderError(`At most ${max.toFixed(2)} USDT can be removed (the position keeps its initial margin)`);
    }
    if (!this.ledger.adjustIsolatedMargin(symbol, delta)) throw new OrderError('Margin adjustment not possible');
    this.event('info', `${symbol} isolated margin ${delta > 0 ? 'added' : 'removed'}: ${Math.abs(delta).toFixed(2)} USDT`, undefined, ctx.now());
    this.onChange();
  }

  marginModeFor(symbol: SymbolId) {
    return this.config.futures.marginModes[symbol] || this.config.futures.marginMode;
  }

  marks(ctx: MarketCtx): Marks {
    const m: Marks = {};
    const syms = new Set<SymbolId>([...this.ledger.positions.keys(), ...this.orders.map((o) => o.symbol)]);
    for (const s of syms) {
      const v = this.config.market === 'futures' ? ctx.mark(s) || ctx.last('futures', s) : ctx.last('spot', s);
      if (v > 0) m[s] = v;
      else if (this.lastPrices[s]) m[s] = this.lastPrices[s];
    }
    return m;
  }

  /** Margin (futures) or cash/base (spot) reserved by open orders (optionally of one symbol). */
  reserved(ctx: MarketCtx, only?: SymbolId): { quote: number; base: Partial<Record<SymbolId, number>> } {
    let quote = 0;
    const base: Partial<Record<SymbolId, number>> = {};
    for (const o of this.orders) {
      if (o.reduceOnly || o.closePosition || (only && o.symbol !== only)) continue;
      const rem = o.qty - o.filledQty;
      const px = o.price || o.stopPrice || ctx.last(this.config.market, o.symbol) || 0;
      if (this.config.market === 'spot') {
        if (o.side === 'buy') quote += rem * px * (1 + this.config.costs.takerFee) + this.config.costs.flatFee;
        else base[o.symbol] = (base[o.symbol] || 0) + rem;
      } else {
        // only the part that would increase exposure needs margin
        const pos = this.ledger.signedQty(o.symbol);
        const dir = o.side === 'buy' ? 1 : -1;
        const increasing = Math.sign(pos) === dir || pos === 0 ? rem : Math.max(0, rem - Math.abs(pos));
        quote += (increasing * px) / this.leverageFor(o.symbol);
      }
    }
    return { quote, base };
  }

  fee(liquidity: 'maker' | 'taker', notional: number): number {
    const c = this.config.costs;
    return (liquidity === 'maker' ? c.makerFee : c.takerFee) * notional + c.flatFee;
  }

  // ---------------------------------------------------------------- order entry

  canTrade(t: number): { ok: boolean; reason?: string } {
    if (this.config.archived) return { ok: false, reason: 'Account is archived' };
    if (this.prop) {
      const r = this.prop.canTrade(t);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  placeOrder(req: PlaceOrderRequest, ctx: MarketCtx): Order {
    const t = ctx.now();
    const market = this.config.market;
    const spec = this.spec(req.symbol);
    const source = req.source || 'manual';
    const reduce = !!(req.reduceOnly || req.closePosition);
    if (!reduce) {
      const ok = this.canTrade(t);
      if (!ok.ok) throw new OrderError(ok.reason);
    } else if (this.prop && this.prop.state.status === 'breached' && source !== 'rule' && source !== 'liquidation') {
      // closing is always allowed
    }
    const last = ctx.last(market, req.symbol);
    if (!(last > 0)) throw new OrderError('No market price available yet — wait for the live feed');
    let qty = floorToStep(req.qty, spec.stepSize);
    const pos = this.ledger.position(req.symbol);
    if (req.closePosition) qty = pos ? pos.qty : 0;
    if (!(qty >= spec.minQty) && !req.closePosition) throw new OrderError(`Quantity below minimum (${spec.minQty})`);
    const price = req.price !== undefined ? roundToTick(req.price, spec.tickSize) : undefined;
    const stopPrice = req.stopPrice !== undefined ? roundToTick(req.stopPrice, spec.tickSize) : undefined;
    if ((req.type === 'limit' || req.type === 'stopLimit') && !(price! > 0)) throw new OrderError('Limit price required');
    if ((req.type === 'stop' || req.type === 'stopLimit' || req.type === 'takeProfit') && !(stopPrice! > 0)) throw new OrderError('Trigger price required');
    let callbackRate: number | undefined;
    let activationPrice: number | undefined;
    if (req.type === 'trailingStop') {
      // Binance: futures callback rate 0.1–10%; spot trailing delta 10–2000 BIPS (0.1–20%)
      const maxCb = market === 'spot' ? 0.2 : 0.1;
      callbackRate = Number(req.callbackRate);
      if (!(callbackRate >= 0.001 - 1e-12 && callbackRate <= maxCb + 1e-12)) throw new OrderError(`Callback rate must be between 0.1% and ${maxCb * 100}%`);
      if (req.activationPrice !== undefined && req.activationPrice !== null) {
        activationPrice = roundToTick(req.activationPrice, spec.tickSize);
        if (!(activationPrice > 0)) throw new OrderError('Invalid activation price');
      }
    }
    if (market === 'futures') {
      // Binance futures order limits (PERCENT_PRICE, MARKET_LOT_SIZE, MAX_NUM_ORDERS)
      const fs = SYMBOL_SPECS[req.symbol].futures;
      const mark = ctx.mark(req.symbol) || last;
      if (price !== undefined && (req.type === 'limit' || req.type === 'stopLimit')) {
        const hi = roundToTick(mark * fs.priceBandUp, spec.tickSize);
        const lo = roundToTick(mark * fs.priceBandDown, spec.tickSize);
        if (price > hi) throw new OrderError(`Limit price can't be higher than ${hi} (${Math.round((fs.priceBandUp - 1) * 100)}% above the mark price)`);
        if (price < lo) throw new OrderError(`Limit price can't be lower than ${lo} (${Math.round((1 - fs.priceBandDown) * 100)}% below the mark price)`);
      }
      if (req.type === 'market' && !req.closePosition && qty > fs.maxMarketQty) throw new OrderError(`A market order can be at most ${fs.maxMarketQty} ${SYMBOL_SPECS[req.symbol].base}; split it or use a limit order`);
      if (req.type !== 'market' && this.orders.filter((x) => x.symbol === req.symbol).length >= fs.maxOrders) throw new OrderError(`At most ${fs.maxOrders} open orders per symbol`);
    }
    const refPrice = price || stopPrice || activationPrice || last;
    const notional = qty * refPrice;
    if (!reduce && notional < spec.minNotional) throw new OrderError(`Order value below minimum (${spec.minNotional} USDT)`);
    // trigger direction sanity
    if (req.type === 'stop' || req.type === 'stopLimit') {
      if (req.side === 'buy' && stopPrice! <= last) throw new OrderError('Buy stop must be above the current price');
      if (req.side === 'sell' && stopPrice! >= last) throw new OrderError('Sell stop must be below the current price');
    }
    if (req.type === 'takeProfit') {
      if (req.side === 'sell' && stopPrice! <= last) throw new OrderError('Take-profit (sell) must be above the current price');
      if (req.side === 'buy' && stopPrice! >= last) throw new OrderError('Take-profit (buy) must be below the current price');
    }
    // reduce-only sanity
    const dir = req.side === 'buy' ? 1 : -1;
    const signed = this.ledger.signedQty(req.symbol);
    if (reduce) {
      if (signed === 0 && !req.bracket) throw new OrderError('No position to reduce');
      if (signed !== 0 && Math.sign(signed) === dir) throw new OrderError('Reduce-only order would increase the position');
    }
    if (market === 'spot') {
      if (req.side === 'sell') {
        const held = pos ? pos.qty : 0;
        const reservedBase = this.reserved(ctx).base[req.symbol] || 0;
        if (qty > held - reservedBase + 1e-12) throw new OrderError(`Insufficient ${SYMBOL_SPECS[req.symbol].base} (spot accounts cannot short)`);
      } else if (!reduce) {
        const cost = qty * refPrice * (1 + this.config.costs.takerFee) + this.config.costs.flatFee;
        const avail = this.ledger.available({}, this.reserved(ctx).quote);
        if (cost > avail + 1e-9) throw new OrderError(`Insufficient USDT: need ${cost.toFixed(2)}, available ${avail.toFixed(2)}`);
      }
    } else if (!reduce) {
      this.checkFuturesRisk(req.symbol, dir, qty, refPrice, ctx);
    }
    this.checkRiskLimits(req.symbol, dir, qty, refPrice, ctx, reduce);
    const o: Order = {
      id: oid('o'),
      accountId: this.config.id,
      symbol: req.symbol,
      market,
      side: req.side,
      type: req.type,
      qty,
      price,
      stopPrice,
      reduceOnly: reduce,
      closePosition: req.closePosition,
      postOnly: req.postOnly,
      tif: req.tif || (req.type === 'market' ? 'IOC' : 'GTC'),
      trigger: req.trigger || (market === 'futures' ? this.config.execution.stopTrigger : 'last'),
      status: 'new',
      filledQty: 0,
      avgFillPrice: 0,
      createdAt: t,
      updatedAt: t,
      source,
      bracket: req.bracket,
      reason: req.reason,
      tag: req.tag,
      callbackRate,
      activationPrice,
    };
    if (o.type === 'trailingStop' && (activationPrice === undefined || (o.side === 'sell' ? last >= activationPrice : last <= activationPrice))) {
      // no activation price (or already reached): trail from the current price
      o.trailExtreme = last;
      o.stopPrice = roundToTick(o.side === 'sell' ? last * (1 - callbackRate!) : last * (1 + callbackRate!), spec.tickSize);
    }
    if (req.sl || req.tp) this.pendingBrackets[o.id] = { sl: req.sl, tp: req.tp };
    // immediate execution
    if (o.type === 'market') {
      this.executeMarket(o, ctx, req.reason);
      return o;
    }
    if (o.type === 'limit') {
      const bba = ctx.bestBidAsk?.(market, o.symbol);
      const ask = bba ? bba.ask : last;
      const bid = bba ? bba.bid : last;
      const marketable = o.side === 'buy' ? price! >= ask : price! <= bid;
      if (marketable) {
        if (o.postOnly) {
          o.status = 'rejected';
          o.rejectReason = 'Post-only order would take liquidity';
          this.event('reject', `${o.side.toUpperCase()} ${o.symbol} post-only rejected`, { orderId: o.id }, t);
          return o;
        }
        if (!this.takeLiquidity(o, ctx, req.reason)) return o;
      } else if (o.tif === 'IOC' || o.tif === 'FOK') {
        o.status = 'expired';
        o.rejectReason = `${o.tif}: nothing to fill at the limit price`;
        this.event('cancel', `${describeOrder(o)} expired (${o.tif}, nothing to fill)`, { orderId: o.id }, t);
        return o;
      }
    }
    this.orders.push(o);
    this.event('order', `${describeOrder(o)} placed`, { orderId: o.id }, t);
    this.onChange();
    return o;
  }

  /**
   * A marketable limit order takes liquidity up to its limit price (walking the live book when
   * there is one). The rest rests (GTC) or is canceled (IOC); fill-or-kill orders that can't fill
   * completely are canceled without a fill. Returns true when a remainder should rest.
   */
  private takeLiquidity(o: Order, ctx: MarketCtx, reason?: string): boolean {
    const t = ctx.now();
    const rem = o.qty - o.filledQty;
    const sw = ctx.sweep?.(o.market, o.symbol, o.side, rem, o.price) ?? null;
    let qty = rem;
    let px: number;
    if (sw && sw.filled > 0) {
      qty = Math.min(rem, floorToStep(sw.filled + 1e-12, this.spec(o.symbol).stepSize));
      px = sw.avgPrice;
    } else {
      const bba = ctx.bestBidAsk?.(o.market, o.symbol);
      const last = ctx.last(o.market, o.symbol);
      px = o.side === 'buy' ? Math.min(o.price!, bba ? bba.ask : last) : Math.max(o.price!, bba ? bba.bid : last);
    }
    if (o.tif === 'FOK' && qty < rem - 1e-12) {
      this.finish(o, 'expired', t, 'Fill-or-kill: not enough liquidity at the limit price');
      this.event('cancel', `${describeOrder(o)} expired (fill-or-kill: not enough liquidity at the limit price)`, { orderId: o.id }, t);
      return false;
    }
    if (qty > 0) this.fill(o, qty, px, 'taker', t, reason);
    if (o.status === 'filled') return false;
    if (o.tif === 'IOC') {
      this.finish(o, 'expired', t, 'IOC: unfilled rest canceled');
      this.event('cancel', `${describeOrder(o)}: unfilled rest canceled (IOC)`, { orderId: o.id }, t);
      return false;
    }
    return true;
  }

  private checkFuturesRisk(symbol: SymbolId, dir: 1 | -1, qty: number, price: number, ctx: MarketCtx): void {
    const lev = this.leverageFor(symbol);
    if (lev > this.config.risk.maxLeverage) throw new OrderError(`Leverage ${lev}x exceeds the account limit of ${this.config.risk.maxLeverage}x`);
    const signed = this.ledger.signedQty(symbol);
    const after = Math.abs(signed + dir * qty);
    const increase = Math.max(0, after - Math.abs(signed));
    if (increase <= 0) return;
    const notionalAfter = after * price;
    const maxLev = maxLeverageFor(symbol, notionalAfter);
    if (lev > maxLev) throw new OrderError(`Position of ${notionalAfter.toFixed(0)} USDT exceeds the Binance bracket for ${lev}x (max ${maxLev}x at this size)`);
    const pos = this.ledger.position(symbol);
    if (pos && pos.marginMode !== this.marginModeFor(symbol)) throw new OrderError('Margin mode differs from the open position');
    const marks = this.marks(ctx);
    // Binance order cost = initial margin + open loss (an order priced worse than the mark price)
    const mark = marks[symbol] || price;
    const openLoss = increase * Math.max(0, dir * (price - mark));
    const required = (increase * price) / lev + openLoss;
    const avail = this.ledger.available(marks, this.reserved(ctx).quote);
    if (required > avail + 1e-9) throw new OrderError(`Insufficient margin: need ${required.toFixed(2)} USDT${openLoss > 0.005 ? ` (incl. open loss ${openLoss.toFixed(2)})` : ''}, available ${avail.toFixed(2)}`);
  }

  private checkRiskLimits(symbol: SymbolId, dir: 1 | -1, qty: number, price: number, ctx: MarketCtx, reduce: boolean): void {
    if (reduce) return;
    const r = this.config.risk;
    const signed = this.ledger.signedQty(symbol);
    const after = Math.abs(signed + dir * qty);
    if (r.maxPositionNotional > 0 && after * price > r.maxPositionNotional) throw new OrderError(`Position limit: ${(after * price).toFixed(0)} > ${r.maxPositionNotional} USDT`);
    const open = new Set(this.ledger.positions.keys());
    if (!open.has(symbol) && r.maxOpenPositions > 0 && open.size >= r.maxOpenPositions) throw new OrderError(`Max ${r.maxOpenPositions} open positions`);
    if (r.maxDailyLossPct > 0) {
      const eq = this.ledger.equity(this.marks(ctx));
      if (eq <= this.dayStartEquity * (1 - r.maxDailyLossPct / 100)) throw new OrderError(`Daily loss limit of ${r.maxDailyLossPct}% reached — only reducing orders allowed today`);
    }
    if (this.prop) {
      const maxQ = this.prop.maxQty(symbol);
      if (maxQ !== null && after > maxQ + 1e-9) throw new OrderError(`Prop size limit: ${after} > ${maxQ} ${SYMBOL_SPECS[symbol].base} (${this.prop.maxMicros()} micro contracts)`);
    }
  }

  private executeMarket(o: Order, ctx: MarketCtx, reason?: string): void {
    const t = ctx.now();
    let qty = o.qty - o.filledQty;
    if (o.reduceOnly) {
      const r = this.reducibleQty(o);
      qty = o.closePosition ? r : Math.min(qty, r);
      if (!(qty > 0)) {
        this.finish(o, 'canceled', t, 'Nothing to reduce');
        return;
      }
    }
    const px = this.marketFillPrice(o.symbol, o.side, qty, ctx);
    this.fill(o, qty, px.price, 'taker', t, reason, px.estimated);
  }

  /** How much a reduce-only order may still close: 0 when flat or when it would add to the position. */
  private reducibleQty(o: Order): number {
    const signed = this.ledger.signedQty(o.symbol);
    const dir = o.side === 'buy' ? 1 : -1;
    return signed === 0 || Math.sign(signed) === dir ? 0 : Math.abs(signed);
  }

  /** Market fill price: order-book sweep when available, otherwise last price ± slippage. */
  marketFillPrice(symbol: SymbolId, side: OrderSide, qty: number, ctx: MarketCtx): { price: number; estimated: boolean } {
    const c = this.config.costs;
    const last = ctx.last(this.config.market, symbol);
    if (c.slippage.model === 'book' && ctx.sweep) {
      const sw = ctx.sweep(this.config.market, symbol, side, qty);
      if (sw && sw.filled > 0) {
        let px = sw.avgPrice;
        if (sw.filled < qty) {
          // beyond visible depth: remainder at worst price plus extra slippage
          const rest = qty - sw.filled;
          const worst = slip(sw.worstPrice, side, 10);
          px = (sw.avgPrice * sw.filled + worst * rest) / qty;
        }
        return { price: px, estimated: false };
      }
    }
    const bps = c.slippage.model === 'none' ? 0 : c.slippage.bps;
    const bba = ctx.bestBidAsk?.(this.config.market, symbol);
    const ref = bba ? (side === 'buy' ? bba.ask : bba.bid) : last;
    return { price: slip(ref, side, bps), estimated: !bba };
  }

  /** Apply a fill to the ledger and order. */
  fill(o: Order, qty: number, price: number, liquidity: 'maker' | 'taker', t: number, reason?: string, estimated = false): Fill | null {
    if (!(qty > 0)) return null;
    const notional = qty * price;
    const fee = this.fee(liquidity, notional);
    const before = this.ledger.signedQty(o.symbol);
    const res = this.ledger.applyFill({ symbol: o.symbol, side: o.side, qty, price, fee, t, leverage: this.leverageFor(o.symbol), marginMode: this.marginModeFor(o.symbol), reason: reason || o.reason });
    const f: Fill = { id: oid('f'), orderId: o.id, symbol: o.symbol, market: this.config.market, side: o.side, qty, price, fee, liquidity, t, realizedPnl: res.realized, source: o.source, reason: reason || o.reason };
    this.fills.push(f);
    o.avgFillPrice = (o.avgFillPrice * o.filledQty + price * qty) / (o.filledQty + qty);
    o.filledQty += qty;
    o.updatedAt = t;
    if (o.filledQty >= o.qty - 1e-12) this.finish(o, 'filled', t);
    else o.status = 'partiallyFilled';
    if (res.closedTrade) this.trades.push(res.closedTrade);
    const after = this.ledger.signedQty(o.symbol);
    if (this.prop) {
      // a trading day counts when a position is opened, increased or reversed, not when it is closed
      if (after !== 0 && (Math.abs(after) > Math.abs(before) || Math.sign(after) !== Math.sign(before))) this.prop.onPositionOpened(t);
      if (res.realized !== 0 || fee) this.prop.onRealized(t, res.realized - fee);
    }
    this.event('fill', `${o.side === 'buy' ? 'Bought' : 'Sold'} ${fmtQ(qty, o.symbol, o.market)} ${SYMBOL_SPECS[o.symbol].base} @ ${fmtP(price, o.symbol, o.market)}${res.realized ? ` · P&L ${fmtSignedAmount(res.realized)}` : ''}${estimated ? ' (est. price)' : ''}`, { orderId: o.id, fillId: f.id, source: o.source }, t);
    // brackets: like Binance, reduce-only orders of a position that closed or reversed are canceled
    // (otherwise an old stop loss would add to the new position)
    if (before !== 0 && Math.sign(after) !== Math.sign(before)) this.cancelReduceOnly(o.symbol, t, after === 0 ? 'position closed' : 'position reversed');
    if (after !== 0) {
      const pb = this.pendingBrackets[o.id];
      if (pb && o.status === 'filled') {
        delete this.pendingBrackets[o.id];
        try {
          this.setBrackets(o.symbol, pb, null);
        } catch (e) {
          this.event('error', `Could not attach SL/TP: ${(e as Error).message}`, undefined, t);
        }
      }
    }
    this.onChange();
    return f;
  }

  private finish(o: Order, status: Order['status'], t: number, reason?: string): void {
    o.status = status;
    o.updatedAt = t;
    if (reason) o.rejectReason = reason;
    this.orders = this.orders.filter((x) => x !== o);
  }

  cancelOrder(id: string, t = Date.now(), reason = 'Canceled'): boolean {
    const o = this.orders.find((x) => x.id === id);
    if (!o) return false;
    this.finish(o, 'canceled', t, reason);
    delete this.pendingBrackets[o.id];
    this.event('cancel', `${describeOrder(o)} canceled${reason !== 'Canceled' ? ` (${reason})` : ''}`, { orderId: o.id }, t);
    this.onChange();
    return true;
  }

  cancelAll(symbol?: SymbolId, t = Date.now(), reason = 'Canceled'): number {
    const list = this.orders.filter((o) => !symbol || o.symbol === symbol);
    for (const o of list) this.cancelOrder(o.id, t, reason);
    return list.length;
  }

  private cancelReduceOnly(symbol: SymbolId, t: number, reason: string): void {
    for (const o of this.orders.filter((x) => x.symbol === symbol && (x.reduceOnly || x.closePosition || x.bracket))) this.cancelOrder(o.id, t, reason);
  }

  modifyOrder(id: string, patch: { price?: number; stopPrice?: number; qty?: number; callbackRate?: number }, ctx: MarketCtx): Order {
    const o = this.orders.find((x) => x.id === id);
    if (!o) throw new OrderError('Order not found');
    const spec = this.spec(o.symbol);
    const last = ctx.last(this.config.market, o.symbol);
    if (patch.price !== undefined) o.price = roundToTick(patch.price, spec.tickSize);
    if (patch.stopPrice !== undefined) {
      const sp = roundToTick(patch.stopPrice, spec.tickSize);
      const isStop = o.type === 'stop' || o.type === 'stopLimit';
      const upTrigger = (isStop && o.side === 'buy') || (o.type === 'takeProfit' && o.side === 'sell');
      if (upTrigger && sp <= last) throw new OrderError('Trigger must stay above the current price');
      if (!upTrigger && sp >= last) throw new OrderError('Trigger must stay below the current price');
      o.stopPrice = sp;
    }
    if (patch.qty !== undefined) o.qty = Math.max(o.filledQty + spec.minQty, floorToStep(patch.qty, spec.stepSize));
    if (patch.callbackRate !== undefined && o.type === 'trailingStop') {
      const maxCb = this.config.market === 'spot' ? 0.2 : 0.1;
      if (!(patch.callbackRate >= 0.001 - 1e-12 && patch.callbackRate <= maxCb + 1e-12)) throw new OrderError(`Callback rate must be between 0.1% and ${maxCb * 100}%`);
      o.callbackRate = patch.callbackRate;
      if (o.trailExtreme !== undefined) o.stopPrice = roundToTick(o.side === 'sell' ? o.trailExtreme * (1 - o.callbackRate) : o.trailExtreme * (1 + o.callbackRate), spec.tickSize);
    }
    o.updatedAt = ctx.now();
    // a modified limit that became marketable fills now
    if (o.type === 'limit' && o.price) {
      const bba = ctx.bestBidAsk?.(this.config.market, o.symbol);
      const ask = bba ? bba.ask : last;
      const bid = bba ? bba.bid : last;
      if ((o.side === 'buy' && o.price >= ask) || (o.side === 'sell' && o.price <= bid)) {
        if (o.postOnly) throw new OrderError('Post-only order would take liquidity');
        this.takeLiquidity(o, ctx, o.reason);
      }
    }
    this.event('order', `${describeOrder(o)} modified`, { orderId: o.id }, ctx.now());
    this.onChange();
    return o;
  }

  /** Set / replace / remove (null) the SL and TP of the position on `symbol`. */
  setBrackets(symbol: SymbolId, b: { sl?: number | null; tp?: number | null }, ctx: MarketCtx | null): void {
    const pos = this.ledger.position(symbol);
    const t = ctx ? ctx.now() : Date.now();
    if (!pos) throw new OrderError('No open position');
    const exitSide: OrderSide = pos.side === 1 ? 'sell' : 'buy';
    const existing = (k: 'sl' | 'tp') => this.orders.find((o) => o.symbol === symbol && o.bracket === k);
    for (const k of ['sl', 'tp'] as const) {
      const v = b[k];
      if (v === undefined) continue;
      const cur = existing(k);
      if (v === null) {
        if (cur) this.cancelOrder(cur.id, t, 'removed');
        continue;
      }
      const spec = this.spec(symbol);
      const price = roundToTick(v, spec.tickSize);
      const last = ctx ? ctx.last(this.config.market, symbol) : pos.entry;
      if (k === 'sl' && (pos.side === 1 ? price >= last : price <= last)) throw new OrderError(`Stop loss must be ${pos.side === 1 ? 'below' : 'above'} the current price`);
      if (k === 'tp' && (pos.side === 1 ? price <= last : price >= last)) throw new OrderError(`Take profit must be ${pos.side === 1 ? 'above' : 'below'} the current price`);
      if (cur) {
        cur.stopPrice = price;
        cur.updatedAt = t;
        this.event('order', `${k.toUpperCase()} moved to ${price}`, { orderId: cur.id }, t);
        continue;
      }
      const o: Order = {
        id: oid('o'),
        accountId: this.config.id,
        symbol,
        market: this.config.market,
        side: exitSide,
        type: k === 'sl' ? 'stop' : 'takeProfit',
        qty: pos.qty,
        stopPrice: price,
        reduceOnly: true,
        closePosition: true,
        tif: 'GTC',
        trigger: this.config.market === 'futures' ? this.config.execution.stopTrigger : 'last',
        status: 'new',
        filledQty: 0,
        avgFillPrice: 0,
        createdAt: t,
        updatedAt: t,
        source: 'bracket',
        bracket: k,
      };
      this.orders.push(o);
      this.event('order', `${k === 'sl' ? 'Stop loss' : 'Take profit'} set at ${price}`, { orderId: o.id }, t);
    }
    this.onChange();
  }

  /** Close (part of) a position at market. */
  closePosition(symbol: SymbolId, ctx: MarketCtx, qty?: number, source: Order['source'] = 'manual', reason?: string): Order | null {
    const pos = this.ledger.position(symbol);
    if (!pos) return null;
    return this.placeOrder({ symbol, side: pos.side === 1 ? 'sell' : 'buy', type: 'market', qty: qty ?? pos.qty, reduceOnly: true, closePosition: qty === undefined, source, reason }, ctx);
  }

  flattenAll(ctx: MarketCtx, source: Order['source'], reason: string): void {
    this.cancelAll(undefined, ctx.now(), reason);
    for (const s of [...this.ledger.positions.keys()]) {
      try {
        this.closePosition(s, ctx, undefined, source, reason);
      } catch (e) {
        this.event('error', `Could not close ${s}: ${(e as Error).message}`, undefined, ctx.now());
      }
    }
  }

  // ---------------------------------------------------------------- market events

  /** A price move on (market, symbol): live trade tick or replay/backtest segment. */
  onPrice(symbol: SymbolId, seg: Segment, ctx: MarketCtx, mode: 'tick' | 'path' = 'tick'): void {
    this.lastPrices[symbol] = seg.to;
    this.ledger.observePrice(symbol, seg.to);
    const tick = this.spec(symbol).tickSize;
    const markSeg = (o: Order): Segment => {
      if (o.trigger === 'mark' && this.config.market === 'futures') {
        const m = ctx.mark(symbol);
        return m > 0 ? { from: m, to: m, volume: 0, t: seg.t } : seg;
      }
      return seg;
    };
    const cands = this.orders
      .filter((o) => o.symbol === symbol)
      .map((o) => ({ o, d: o.type === 'trailingStop' ? this.trail(o, markSeg(o), tick, mode) : evaluateOrder(o, markSeg(o), this.config.execution, tick, mode) }))
      .filter((x) => x.d)
      .sort((a, b) => a.d!.at - b.d!.at);
    for (const { o, d } of cands) {
      if (!this.orders.includes(o)) continue; // canceled by an earlier fill (OCO)
      if (d!.convertToLimit) {
        o.triggered = true;
        o.updatedAt = seg.t;
        this.event('order', `${describeOrder(o)} triggered → limit ${o.price}`, { orderId: o.id }, seg.t);
        continue;
      }
      if (d!.market) {
        if (mode === 'tick') {
          this.event('order', `${describeOrder(o)} triggered`, { orderId: o.id }, seg.t);
          this.executeMarket(o, ctx, o.bracket === 'sl' ? 'stop loss' : o.bracket === 'tp' ? 'take profit' : o.reason);
        } else {
          let qty = o.qty - o.filledQty;
          if (o.reduceOnly) qty = o.closePosition ? this.reducibleQty(o) : Math.min(qty, this.reducibleQty(o));
          if (qty > 0) this.fill(o, qty, slip(d!.price, o.side, this.config.costs.slippage.model === 'none' ? 0 : this.config.costs.slippage.bps), 'taker', seg.t, o.bracket === 'sl' ? 'stop loss' : o.bracket === 'tp' ? 'take profit' : o.reason);
          else this.finish(o, 'canceled', seg.t, 'Nothing to reduce');
        }
        continue;
      }
      // limit fill
      let qty = d!.qty;
      if (o.reduceOnly) qty = Math.min(qty, this.reducibleQty(o));
      if (qty > 0) this.fill(o, qty, d!.price, d!.liquidity, seg.t, o.reason);
      else this.finish(o, 'canceled', seg.t, 'Nothing to reduce');
    }
  }

  /**
   * Trailing stop on one monotonic price segment: activates when the price reaches the
   * activation price, follows the best price since then and triggers when the price comes back
   * by the callback rate (sell: from the high, buy: from the low).
   */
  private trail(o: Order, seg: Segment, tick: number, mode: 'tick' | 'path'): MatchDecision | null {
    const cb = o.callbackRate || 0.01;
    const sell = o.side === 'sell';
    let from = seg.from;
    if (o.trailExtreme === undefined) {
      const act = o.activationPrice;
      const hit = act === undefined || (sell ? Math.max(seg.from, seg.to) >= act : Math.min(seg.from, seg.to) <= act);
      if (!hit) return null;
      o.trailExtreme = act ?? seg.from;
      // the rest of this leg starts at the activation price
      if (act !== undefined) from = act;
    }
    const up = seg.to >= from;
    const before = o.trailExtreme;
    const level = (ext: number) => (sell ? ext * (1 - cb) : ext * (1 + cb));
    const hits = (ext: number, p: number) => (sell ? p <= level(ext) : p >= level(ext));
    let decision: MatchDecision | null = null;
    if (hits(before, from)) decision = { price: mode === 'path' ? from : seg.to, qty: o.qty - o.filledQty, liquidity: 'taker', market: true, at: 0 };
    else if ((sell && !up) || (!sell && up)) {
      // moving against the order: the extreme stays, check the trigger along the leg
      if (hits(before, seg.to)) {
        const L = level(before);
        const d = seg.to - seg.from;
        decision = { price: mode === 'path' ? L : seg.to, qty: o.qty - o.filledQty, liquidity: 'taker', market: true, at: d ? Math.max(0, Math.min(1, (L - seg.from) / d)) : 0 };
      }
    }
    // a favourable leg moves the extreme (a leg can't retrace within itself: segments are monotonic)
    if (!decision) o.trailExtreme = sell ? Math.max(before, seg.to, from) : Math.min(before, seg.to, from);
    o.stopPrice = roundToTick(level(o.trailExtreme), tick);
    return decision;
  }

  /** Futures risk checks on a mark-price update: liquidation and margin call. */
  onMark(ctx: MarketCtx, liquidationFeeRate: (s: SymbolId) => number): void {
    if (this.config.market !== 'futures' || !this.ledger.positions.size) return;
    const t = ctx.now();
    for (let guard = 0; guard < 4; guard++) {
      const marks = this.marks(ctx);
      const cands = this.ledger.liquidationCandidates(marks);
      if (!cands.length) break;
      const sym = cands[0];
      const pos = this.ledger.position(sym)!;
      const mode = pos.marginMode;
      // cancel orders: all (cross) or same symbol (isolated)
      if (mode === 'cross') {
        for (const o of [...this.orders]) {
          const p = this.ledger.position(o.symbol);
          if (!p || p.marginMode === 'cross') this.cancelOrder(o.id, t, 'liquidation');
        }
      } else this.cancelAll(sym, t, 'liquidation');
      const price = marks[sym]!;
      const res = this.ledger.liquidate(sym, price, t, liquidationFeeRate(sym));
      if (res) {
        this.trades.push(res.closedTrade);
        this.fills.push({ id: oid('f'), orderId: 'liquidation', symbol: sym, market: 'futures', side: res.side === 1 ? 'sell' : 'buy', qty: res.qty, price, fee: res.clearanceFee, liquidity: 'taker', t, realizedPnl: res.realized, source: 'liquidation', reason: 'liquidation' });
        this.prop?.onRealized(t, res.realized - res.clearanceFee);
        this.event('liquidation', `LIQUIDATED ${res.side === 1 ? 'long' : 'short'} ${fmtQ(res.qty, sym, 'futures')} ${SYMBOL_SPECS[sym].base} @ ${fmtP(price, sym, 'futures')} (${mode}) · P&L ${fmtSignedAmount(res.realized)} · clearance fee ${res.clearanceFee.toFixed(2)}${res.bankrupt ? ' · bankrupt (insurance fund covers the rest)' : ''}`, { symbol: sym, bankrupt: res.bankrupt }, t);
      }
    }
    const ratio = this.ledger.marginRatio(this.marks(ctx));
    const thr = this.config.futures.marginCallRatio;
    if (ratio >= thr && !this.marginCallActive && isFinite(ratio)) {
      this.marginCallActive = true;
      this.event('marginCall', `Margin call: margin ratio ${(ratio * 100).toFixed(1)}% (liquidation at 100%). Add margin or reduce positions.`, { ratio }, t);
    } else if (ratio < thr * 0.85 && this.marginCallActive) this.marginCallActive = false;
  }

  /** Funding settlement for one symbol. */
  onFunding(symbol: SymbolId, rate: number, mark: number, t: number): void {
    if (!this.config.costs.funding) return;
    const pos = this.ledger.position(symbol);
    if (!pos) return;
    const paid = this.ledger.applyFunding(symbol, rate, mark);
    this.prop?.onRealized(t, -paid);
    this.event('funding', `Funding ${symbol}: rate ${(rate * 100).toFixed(4)}% → ${paid >= 0 ? 'paid' : 'received'} ${Math.abs(paid).toFixed(4)} USDT`, { rate, paid }, t);
  }

  /** Periodic housekeeping: prop rules, day rollover, equity sampling. Returns true if positions must be flattened. */
  housekeeping(ctx: MarketCtx, sampleEquity: boolean): boolean {
    const t = ctx.now();
    const marks = this.marks(ctx);
    const eq = this.ledger.equity(marks);
    const day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dayStartEquity = eq;
    }
    if (sampleEquity) {
      this.equity.push([t, +eq.toFixed(4), +this.ledger.wallet.toFixed(4)]);
      if (this.equity.length > 20000) this.equity = this.equity.filter((_, i) => i % 2 === 0 || i > this.equity.length - 2000);
    }
    let flatten = false;
    if (this.prop) {
      const balance = this.config.market === 'spot' ? this.ledger.wallet + this.ledger.exposure(marks) : this.ledger.wallet;
      const inp: RuleInput = { t, balance: this.config.market === 'spot' ? eq : balance, equity: eq, openPositions: this.ledger.positions.size };
      const fx = this.prop.update(inp);
      for (const e of fx.events) this.event('rule', e.message, { kind: e.kind }, t);
      if (fx.flatten && (this.ledger.positions.size || this.orders.length)) flatten = true;
    }
    return flatten;
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(ctx: MarketCtx): AccountSnapshot {
    const marks = this.marks(ctx);
    const l = this.ledger;
    const res = this.reserved(ctx);
    const eq = l.equity(marks);
    const crossRatio = l.marginRatio(marks);
    const positions = [...l.positions.values()].map((p: Position) => {
      const mark = marks[p.symbol] || p.entry;
      const u = l.uPnl(p, mark);
      const im = l.initialMargin(p, mark);
      const sl = this.orders.find((o) => o.symbol === p.symbol && o.bracket === 'sl')?.stopPrice;
      const tp = this.orders.find((o) => o.symbol === p.symbol && o.bracket === 'tp')?.stopPrice;
      const maxRemoveMargin = p.marginMode === 'isolated' ? this.maxRemovableMargin(p, mark) : undefined;
      const mm = l.maintMargin(p, mark);
      const breakEven = p.qty > 0 ? p.entry - (p.realizedPnl - p.fees) / (p.side * p.qty) : p.entry;
      const isoBalance = p.isolatedMargin + u;
      const marginRatio = this.config.market !== 'futures' ? 0 : p.marginMode === 'isolated' ? (mm === 0 ? 0 : isoBalance > 0 ? mm / isoBalance : Infinity) : crossRatio;
      return { ...p, mark, uPnl: u, uPnlPct: im > 0 ? (u / (p.marginMode === 'isolated' ? p.isolatedMargin || im : im)) * 100 : 0, notional: p.qty * mark, liqPrice: l.liqPrice(p, marks), maintMargin: mm, breakEven, marginRatio, sl, tp, maxRemoveMargin };
    });
    const holdings =
      this.config.market === 'spot'
        ? positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avgCost: p.entry, value: p.qty * p.mark, uPnl: p.uPnl }))
        : [];
    let status: AccountSnapshot['status'] = 'active';
    let statusReason: string | undefined;
    if (this.prop) {
      status = this.prop.state.status;
      statusReason = this.prop.state.reason;
    }
    const balance = this.config.market === 'spot' ? eq : l.wallet;
    return {
      config: this.config,
      wallet: l.wallet,
      equity: eq,
      available: l.available(marks, res.quote),
      unrealizedPnl: l.unrealized(marks),
      realizedPnl: l.realizedPnl,
      feesPaid: l.feesPaid,
      fundingPaid: l.fundingPaid,
      marginUsed: l.marginUsed(marks),
      maintenanceMargin: positions.reduce((a, p) => a + p.maintMargin, 0),
      marginRatio: crossRatio,
      exposure: l.exposure(marks),
      positions,
      orders: this.orders.slice(),
      holdings,
      dayStartEquity: this.dayStartEquity,
      dayPnl: eq - this.dayStartEquity,
      status,
      statusReason,
      rules: this.prop ? this.prop.status({ t: ctx.now(), balance, equity: eq, openPositions: l.positions.size }) : undefined,
      t: ctx.now(),
    };
  }
}

/** A quantity with the instrument's step decimals, as Binance shows it. */
function fmtQ(q: number, symbol: SymbolId, market: Market): string {
  const s = q.toFixed(qtyDecimals(symbol, market));
  // quantities sit on the step; one that doesn't keeps its digits
  return Math.abs(+s - q) > 1e-12 ? String(+q.toPrecision(8)) : s;
}

function fmtP(p: number, symbol: SymbolId, market: Market): string {
  return p.toFixed(priceDecimals(symbol, market));
}

/** An amount with its sign; none when it rounds to zero. */
function fmtSignedAmount(x: number): string {
  const s = Math.abs(x).toFixed(2);
  return /[1-9]/.test(s) ? `${x > 0 ? '+' : '−'}${s}` : s;
}

export function describeOrder(o: Order): string {
  const t =
    o.type === 'market'
      ? 'Market'
      : o.type === 'limit'
        ? `Limit ${o.price}${o.tif !== 'GTC' ? ` ${o.tif}` : ''}`
        : o.type === 'stop'
          ? `Stop ${o.stopPrice}`
          : o.type === 'stopLimit'
            ? `Stop ${o.stopPrice} → limit ${o.price}`
            : o.type === 'trailingStop'
              ? `Trailing ${+((o.callbackRate || 0) * 100).toFixed(2)}%${o.trailExtreme === undefined && o.activationPrice ? ` from ${o.activationPrice}` : o.stopPrice ? ` (stop ${o.stopPrice})` : ''}`
              : `Take-profit ${o.stopPrice}`;
  const what = o.bracket ? (o.bracket === 'sl' ? 'Stop loss' : 'Take profit') : `${o.side === 'buy' ? 'Buy' : 'Sell'} ${fmtQ(o.qty, o.symbol, o.market)} ${SYMBOL_SPECS[o.symbol].base}`;
  return o.bracket ? `${what} @ ${o.stopPrice}` : `${what} · ${t}`;
}
