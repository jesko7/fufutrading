/**
 * Bot reconciliation planner — "the strategy proposes, the account executes".
 *
 * After every closed bar the bot re-runs its strategy (from the moment the bot started) and gets
 * the simulated position plus the strategy's resting orders. This pure function turns that into
 * actions on the bot's paper account:
 *  - a market order that moves the real position to the target (simulated position × scale),
 *  - resting orders mirroring the strategy's limit/stop entries and its exit brackets (take
 *    profit as a reduce-only limit, stop loss / trailing stop as a reduce-only stop), so they fill
 *    intrabar on live trades instead of waiting for the next bar close,
 *  - cancellation of bot orders the strategy no longer wants.
 * Quantities are scaled per position: the sizing mode fixes the scale factor when the simulated
 * position opens (or flips) and keeps it for adds and partial exits.
 * If the real position was reduced outside the strategy (an exit order filled on live ticks while
 * the bar-based simulation did not exit, a manual close, a prop-rule flatten) the bot does not
 * re-enter: it holds at most the real size until the strategy's position changes again.
 */
import type { PendingSnap } from '../../engine/backtest/broker';
import { floorToStep, roundToTick, type Market, type MarketFilters, type SymbolId } from '../symbols';
import type { BotConfig, OrderSide, OrderType, PlaceOrderRequest } from './types';

export interface BotScale {
  /** Real quantity per simulated quantity. */
  k: number;
  /** Direction of the position the scale belongs to. */
  dir: 1 | -1;
}

export interface BotHold {
  /** Simulated position when the hold started; the hold ends when it changes. */
  simPos: number;
}

export interface BotOrderView {
  id: string;
  tag?: string;
  type: OrderType;
  side: OrderSide;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly: boolean;
  closePosition?: boolean;
}

export interface BotPlanInput {
  market: Market;
  symbol: SymbolId;
  filters: MarketFilters;
  /** Current market price. */
  price: number;
  /** Futures: limit prices must stay within these multiples of the mark price (Binance PERCENT_PRICE). */
  priceBand?: { up: number; down: number };
  /** Real account equity and the leverage used for the symbol (1 on spot). */
  equity: number;
  leverage: number;
  sizing: BotConfig['sizing'];
  scale: BotScale | null;
  hold: BotHold | null;
  /** Simulated position and resting orders after the step. */
  sim: { position: number; pending: PendingSnap[] };
  /** Simulated position at the previous step (to tell strategy changes from outside changes). */
  prevSimPos: number | null;
  /** Target of the previous step (what the real position should have been since). */
  prevTarget: number | null;
  /** Real signed position on the symbol. */
  actual: number;
  /** Open orders placed by the bot (source "bot"). */
  orders: BotOrderView[];
}

export interface PlannedOrder extends PlaceOrderRequest {
  key: string;
  why: string;
  /** Keep an identical open order but don't place a new one (limit outside the exchange's price band). */
  keepOnly?: boolean;
}

export interface BotPlan {
  scale: BotScale | null;
  hold: BotHold | null;
  target: number;
  cancel: { id: string; why: string }[];
  market: (PlaceOrderRequest & { why: string }) | null;
  place: PlannedOrder[];
  notes: string[];
}

export const BOT_TAG = 'bot:';

/** Real quantity per simulated quantity for a new position of `simQty` at `price`. */
export function scaleFor(sizing: BotConfig['sizing'], simQty: number, price: number, equity: number, leverage: number, market: Market): number {
  const q = Math.abs(simQty);
  if (!(q > 0) || !(price > 0)) return 0;
  const v = +sizing.value;
  switch (sizing.mode) {
    case 'percentEquity': {
      const notional = (Math.max(0, equity) * Math.max(0, v)) / 100 * (market === 'futures' ? Math.max(1, leverage) : 1);
      return notional / price / q;
    }
    case 'fixedUsd':
      return Math.max(0, v) / price / q;
    case 'fixedQty':
      return Math.max(0, v) / q;
    default:
      return v > 0 ? v : 1;
  }
}

function sameNum(a: number | undefined, b: number | undefined, tol: number): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) <= tol;
}

export function planBot(inp: BotPlanInput): BotPlan {
  const f = inp.filters;
  const step = f.stepSize;
  const tick = f.tickSize;
  const notes: string[] = [];
  const simPos = inp.market === 'spot' ? Math.max(0, inp.sim.position) : inp.sim.position;
  const dir = Math.sign(simPos) as -1 | 0 | 1;
  const price = inp.price;

  // ---- scale of the simulated position
  let scale = inp.scale;
  if (dir === 0) scale = null;
  else if (!scale || scale.dir !== dir || !(scale.k > 0)) {
    const k = scaleFor(inp.sizing, simPos, price, inp.equity, inp.leverage, inp.market);
    scale = k > 0 ? { k, dir } : null;
  }
  const k = scale?.k ?? 0;
  let target = dir === 0 ? 0 : dir * floorToStep(Math.abs(simPos) * k, step);

  // ---- outside reductions: do not re-enter what was closed outside the strategy
  let hold = inp.hold;
  if (hold && Math.abs(hold.simPos - simPos) > 1e-12) hold = null;
  const tol = Math.max(step, Math.abs(inp.prevTarget ?? 0) * 0.002);
  if (!hold && inp.prevSimPos !== null && inp.prevTarget !== null && Math.abs(inp.prevSimPos - simPos) <= 1e-12) {
    const reducedOutside = Math.abs(inp.actual) < Math.abs(inp.prevTarget) - tol && (inp.actual === 0 || Math.sign(inp.actual) === Math.sign(inp.prevTarget));
    if (reducedOutside && simPos !== 0) {
      hold = { simPos };
      notes.push(`The position was reduced outside the strategy (${fmt(inp.prevTarget)} → ${fmt(inp.actual)}); holding until the strategy's next signal instead of re-entering.`);
    }
  }
  if (hold) {
    if (inp.actual === 0 || Math.sign(inp.actual) !== Math.sign(target)) target = 0;
    else if (Math.abs(inp.actual) < Math.abs(target)) target = inp.actual;
  }

  // ---- desired resting orders
  const desired: PlannedOrder[] = [];
  const kCur = k;
  const realClose = (closeQty: number) => {
    if (!(closeQty > 0) || target === 0) return 0;
    if (closeQty >= Math.abs(simPos) - 1e-12) return Math.abs(target);
    return Math.min(Math.abs(target), floorToStep(closeQty * kCur, step));
  };
  for (const p of inp.sim.pending) {
    const side: OrderSide = p.side === 1 ? 'buy' : 'sell';
    const label = p.comment ? `${p.id} (${p.comment})` : p.id;
    if (p.kind === 'exit') {
      if (target === 0 || Math.sign(target) === p.side) continue;
      const closeAll = p.closeAll || realClose(p.closeQty) >= Math.abs(target);
      const qty = closeAll ? Math.abs(target) : realClose(p.closeQty);
      if (!(qty > 0)) continue;
      if (p.limit !== undefined) desired.push({ key: `${p.id}|tp`, symbol: inp.symbol, side, type: 'limit', qty, price: roundToTick(p.limit, tick), reduceOnly: true, closePosition: closeAll || undefined, source: 'bot', reason: `take profit of ${label}`, why: `Take profit of ${label}` });
      if (p.stop !== undefined) desired.push({ key: `${p.id}|sl`, symbol: inp.symbol, side, type: 'stop', qty, stopPrice: roundToTick(p.stop, tick), reduceOnly: true, closePosition: closeAll || undefined, source: 'bot', reason: `${p.trailing ? 'trailing stop' : 'stop loss'} of ${label}`, why: `${p.trailing ? 'Trailing stop' : 'Stop loss'} of ${label}` });
      continue;
    }
    if (hold) continue;
    const ref = p.limit ?? p.stop ?? price;
    const closePart = Math.sign(target) === -p.side ? realClose(p.closeQty) : 0;
    let kNew = kCur;
    if (!(scale && scale.dir === p.side)) kNew = scaleFor(inp.sizing, p.openQty || p.closeQty, ref, inp.equity, inp.leverage, inp.market);
    const openPart = p.openQty > 0 ? floorToStep(p.openQty * kNew, step) : 0;
    if (inp.market === 'spot' && p.side === -1 && openPart > 0 && closePart === 0) continue;
    const qty = floorToStep(closePart + (inp.market === 'spot' && p.side === -1 ? 0 : openPart), step);
    if (!(qty > 0)) continue;
    const type: OrderType = p.limit !== undefined && p.stop !== undefined ? 'stopLimit' : p.limit !== undefined ? 'limit' : 'stop';
    desired.push({
      key: `${p.id}|e`,
      symbol: inp.symbol,
      side,
      type,
      qty,
      price: p.limit !== undefined ? roundToTick(p.limit, tick) : undefined,
      stopPrice: p.stop !== undefined ? roundToTick(p.stop, tick) : undefined,
      reduceOnly: openPart === 0 || undefined,
      source: 'bot',
      reason: `${p.kind === 'entry' ? 'entry' : 'order'} ${label}`,
      why: `${type === 'limit' ? 'Limit' : type === 'stop' ? 'Stop' : 'Stop-limit'} ${p.kind === 'entry' ? 'entry' : 'order'} ${label}`,
    });
  }

  // ---- market adjustment
  let market: BotPlan['market'] = null;
  const delta = target - inp.actual;
  const adjTol = target === 0 ? step / 2 : Math.max(step / 2, Math.abs(target) * 0.002);
  if (Math.abs(delta) > adjTol) {
    const side: OrderSide = delta > 0 ? 'buy' : 'sell';
    const reduce = Math.abs(target) < Math.abs(inp.actual) && (target === 0 || Math.sign(target) === Math.sign(inp.actual));
    const qty = floorToStep(Math.abs(delta), step);
    if (target === 0 && inp.actual !== 0) market = { symbol: inp.symbol, side, type: 'market', qty: Math.abs(inp.actual), reduceOnly: true, closePosition: true, source: 'bot', why: 'close' };
    else if (qty < f.minQty) notes.push(`Adjustment of ${fmt(delta)} is below the minimum quantity (${f.minQty}) — skipped.`);
    else if (!reduce && qty * price < f.minNotional) notes.push(`Order value ${(qty * price).toFixed(2)} USDT is below the minimum (${f.minNotional} USDT) — skipped. Increase the bot's size.`);
    else market = { symbol: inp.symbol, side, type: 'market', qty, reduceOnly: reduce || undefined, source: 'bot', why: reduce ? 'reduce' : Math.sign(target) !== Math.sign(inp.actual) && inp.actual !== 0 ? 'reverse' : 'open' };
  }

  // ---- triggers already crossed at the current price fill now (the simulation fills them at the next open)
  const place: PlannedOrder[] = [];
  const afterPos = market ? target : inp.actual;
  for (const d of desired) {
    if (d.type === 'stop' || d.type === 'stopLimit') {
      const crossed = d.side === 'buy' ? price >= d.stopPrice! : price <= d.stopPrice!;
      if (crossed) {
        if (d.type === 'stopLimit') {
          place.push({ ...d, type: 'limit', stopPrice: undefined, why: `${d.why} (trigger already crossed)` });
          continue;
        }
        if (d.reduceOnly && afterPos === 0) continue;
        place.push({ ...d, type: 'market', stopPrice: undefined, price: undefined, why: `${d.why} (trigger already crossed — executed at market)` });
        continue;
      }
    }
    // Binance rejects futures limit prices too far from the mark price: wait until the price comes closer
    const band = inp.priceBand;
    if (band && d.price !== undefined && (d.type === 'limit' || d.type === 'stopLimit') && (d.price > price * band.up || d.price < price * band.down)) {
      notes.push(`${d.why}: limit ${d.price} is more than ${Math.round((band.up - 1) * 100)}% from the price; placed once the price comes within Binance's band.`);
      place.push({ ...d, keepOnly: true });
      continue;
    }
    place.push(d);
  }

  // ---- diff against the bot's open orders
  const cancel: BotPlan['cancel'] = [];
  const keep = new Set<string>();
  const byKey = new Map(place.filter((d) => d.type !== 'market').map((d) => [BOT_TAG + d.key, d]));
  for (const o of inp.orders) {
    const d = o.tag ? byKey.get(o.tag) : undefined;
    const same =
      d &&
      !keep.has(o.tag!) &&
      d.type === o.type &&
      d.side === o.side &&
      sameNum(d.price, o.price, tick / 2) &&
      sameNum(d.stopPrice, o.stopPrice, tick / 2) &&
      !!d.closePosition === !!o.closePosition &&
      Math.abs(d.qty - o.qty) <= step / 2 &&
      !market;
    if (same) keep.add(o.tag!);
    else cancel.push({ id: o.id, why: d ? 'updated' : 'no longer wanted by the strategy' });
  }
  const toPlace = place.filter((d) => d.type === 'market' || (!keep.has(BOT_TAG + d.key) && !d.keepOnly)).map(({ keepOnly: _k, ...d }) => ({ ...d, tag: BOT_TAG + d.key }));
  return { scale, hold, target, cancel, market, place: toPlace, notes };
}

function fmt(x: number): string {
  return `${x >= 0 ? '' : '−'}${+Math.abs(x).toFixed(6)}`;
}
