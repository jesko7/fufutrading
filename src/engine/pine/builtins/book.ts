/**
 * Pine `book.*`: the chart symbol's order book on the current bar (the last snapshot taken while
 * the bar formed; the live book on the forming bar). Every function returns na on bars without a
 * book, and inside request.security expressions.
 */
import type { Runtime } from '../runtime';
import { bestAsk, bestBid, bookDepth, bookDepthImbalance, bookFillPrice, bookImbalance, bookMid, bookQtyAt, bookWall, type BookView } from '../../../shared/bookFrame';

const cur = (R: Runtime): BookView | null => (R.book && !R.secMode ? R.book.at(R.i) : null);
const num = (x: unknown) => (x === null || x === undefined ? NaN : Number(x));
const NA2: [number, number] = [NaN, NaN];

export const book = {
  available: (R: Runtime) => !!cur(R),
  time: (R: Runtime) => (R.book && !R.secMode ? R.book.time(R.i) : NaN),
  bid_levels: (R: Runtime) => cur(R)?.bidCount ?? NaN,
  ask_levels: (R: Runtime) => cur(R)?.askCount ?? NaN,
  bid_price: (R: Runtime, level: unknown) => cur(R)?.price('bid', num(level ?? 0)) ?? NaN,
  bid_qty: (R: Runtime, level: unknown) => cur(R)?.qty('bid', num(level ?? 0)) ?? NaN,
  ask_price: (R: Runtime, level: unknown) => cur(R)?.price('ask', num(level ?? 0)) ?? NaN,
  ask_qty: (R: Runtime, level: unknown) => cur(R)?.qty('ask', num(level ?? 0)) ?? NaN,
  best_bid: (R: Runtime) => {
    const b = cur(R);
    return b ? bestBid(b) : NaN;
  },
  best_ask: (R: Runtime) => {
    const b = cur(R);
    return b ? bestAsk(b) : NaN;
  },
  mid: (R: Runtime) => {
    const b = cur(R);
    return b ? bookMid(b) : NaN;
  },
  spread: (R: Runtime) => {
    const b = cur(R);
    return b ? bestAsk(b) - bestBid(b) : NaN;
  },
  bid_depth: (R: Runtime, percent: unknown) => {
    const b = cur(R);
    return b ? bookDepth(b, 'bid', num(percent)) : NaN;
  },
  ask_depth: (R: Runtime, percent: unknown) => {
    const b = cur(R);
    return b ? bookDepth(b, 'ask', num(percent)) : NaN;
  },
  bid_notional: (R: Runtime, percent: unknown) => {
    const b = cur(R);
    return b ? bookDepth(b, 'bid', num(percent), true) : NaN;
  },
  ask_notional: (R: Runtime, percent: unknown) => {
    const b = cur(R);
    return b ? bookDepth(b, 'ask', num(percent), true) : NaN;
  },
  imbalance: (R: Runtime, levels: unknown) => {
    const b = cur(R);
    return b ? bookImbalance(b, num(levels ?? 10)) : NaN;
  },
  depth_imbalance: (R: Runtime, percent: unknown) => {
    const b = cur(R);
    return b ? bookDepthImbalance(b, num(percent ?? 1)) : NaN;
  },
  bid_wall: (R: Runtime, percent: unknown): [number, number] => {
    const b = cur(R);
    return b ? bookWall(b, 'bid', num(percent)) : NA2;
  },
  ask_wall: (R: Runtime, percent: unknown): [number, number] => {
    const b = cur(R);
    return b ? bookWall(b, 'ask', num(percent)) : NA2;
  },
  qty_at: (R: Runtime, price: unknown) => {
    const b = cur(R);
    return b ? bookQtyAt(b, num(price)) : NaN;
  },
  fill_price: (R: Runtime, qty: unknown) => {
    const b = cur(R);
    return b ? bookFillPrice(b, num(qty)) : NaN;
  },
  /** The full level lists, best first (empty arrays without a book). */
  bid_prices: (R: Runtime) => Array.from(cur(R)?.bp ?? []),
  bid_qtys: (R: Runtime) => Array.from(cur(R)?.bq ?? []),
  ask_prices: (R: Runtime) => Array.from(cur(R)?.ap ?? []),
  ask_qtys: (R: Runtime) => Array.from(cur(R)?.aq ?? []),
};
