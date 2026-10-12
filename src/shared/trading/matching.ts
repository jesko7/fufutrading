/**
 * Order matching against price movements. One implementation for:
 *  - live paper trading ('tick' mode): each aggregate trade is a segment prev → price with the
 *    trade's volume; triggered market-type orders are filled by the caller (order book sweep);
 *  - backtests on candles ('path' mode): each bar is split into an intrabar path
 *    (open → nearer extreme → other extreme → close, like TradingView's broker emulator) and
 *    orders fill at the first crossing, with gaps filling at the (worse or better) gap price.
 *
 * Fill assumptions are explicit and configurable (ExecutionModel):
 *  - limit 'touch': fills when the market trades at the limit (partial fills possible);
 *    'through': only when the market trades beyond it (guaranteed fill, conservative).
 *  - stop / take-profit / stop-limit trigger on the chosen price source.
 */
import type { ExecutionModel, Order } from './types';

export interface Segment {
  from: number;
  to: number;
  /** Volume traded during the segment (for partial fills). */
  volume: number;
  t: number;
}

export interface MatchDecision {
  /** Fill price (for 'market' fills the caller may replace this with an order-book sweep). */
  price: number;
  qty: number;
  liquidity: 'maker' | 'taker';
  /** True when a stop/TP triggered and should be executed at market. */
  market: boolean;
  /** Stop-limit triggered: convert to a resting limit. */
  convertToLimit?: boolean;
  /** Position along the segment (0..1) where the event happened, for ordering. */
  at: number;
}

function crossAt(seg: Segment, level: number): number {
  const d = seg.to - seg.from;
  if (d === 0) return seg.from === level ? 0 : -1;
  const f = (level - seg.from) / d;
  return f >= 0 && f <= 1 ? f : -1;
}

/**
 * Evaluate one order against a segment. `mode` controls fill prices of triggered stops:
 * 'path' fills at the stop level (or the gap price), 'tick' asks the caller for a market fill.
 */
export function evaluateOrder(o: Order, seg: Segment, exec: ExecutionModel, tick: number, mode: 'tick' | 'path'): MatchDecision | null {
  const rem = o.qty - o.filledQty;
  if (!(rem > 0)) return null;
  const hi = Math.max(seg.from, seg.to);
  const lo = Math.min(seg.from, seg.to);
  const buy = o.side === 'buy';
  const eps = Math.max(1e-12, tick * 1e-6);
  const limitFill = (L: number): MatchDecision | null => {
    // distance the market must move beyond the limit for a guaranteed ('through') fill
    const need = exec.limitFill === 'through' ? exec.throughTicks * tick + eps : -eps;
    // signed penetration of the segment's extreme beyond the limit (positive = beyond)
    const extreme = buy ? L - lo : hi - L;
    const startBeyond = buy ? L - seg.from : seg.from - L;
    if (mode === 'path' && startBeyond > need && startBeyond > eps) {
      // the bar opened beyond the resting limit (gap): fill at the better gap price
      return { price: buy ? Math.min(L, seg.from) : Math.max(L, seg.from), qty: rem, liquidity: 'maker', market: false, at: 0 };
    }
    if (exec.limitFill === 'through') {
      if (extreme <= need) return null;
    } else if (extreme < -eps) return null; // never reached the limit
    const exactTouch = Math.abs(extreme) <= eps;
    if (exactTouch && exec.limitFill === 'touch' && exec.partialFills && mode === 'tick') {
      const q = Math.min(rem, Math.max(0, seg.volume * exec.participation));
      return q > 0 ? { price: L, qty: q, liquidity: 'maker', market: false, at: 1 } : null;
    }
    const at = Math.max(0, crossAt(seg, L));
    return { price: L, qty: rem, liquidity: 'maker', market: false, at };
  };

  switch (o.type) {
    case 'limit':
      return o.price !== undefined ? limitFill(o.price) : null;
    case 'stop':
    case 'stopLimit':
    case 'takeProfit': {
      if (o.type === 'stopLimit' && o.triggered) return o.price !== undefined ? limitFill(o.price) : null;
      const S = o.stopPrice!;
      // stops: buy triggers on rise to S, sell on fall to S. Take-profit: the opposite.
      const risesTo = (o.type === 'takeProfit' ? !buy : buy) === true;
      let hit = false;
      let gap = false;
      if (risesTo) {
        if (seg.from >= S) {
          hit = true;
          gap = true;
        } else if (hi >= S) hit = true;
      } else {
        if (seg.from <= S) {
          hit = true;
          gap = true;
        } else if (lo <= S) hit = true;
      }
      if (!hit) return null;
      const at = gap ? 0 : Math.max(0, crossAt(seg, S));
      if (o.type === 'stopLimit') return { price: o.price!, qty: rem, liquidity: 'taker', market: false, convertToLimit: true, at };
      const price = mode === 'path' ? (gap ? seg.from : S) : seg.to;
      return { price, qty: rem, liquidity: 'taker', market: true, at };
    }
    default:
      return null;
  }
}

/** Intrabar path for OHLC candles (TradingView broker-emulator assumption). */
export function barPath(o: number, h: number, l: number, c: number): number[] {
  const upFirst = Math.abs(h - o) < Math.abs(o - l);
  return upFirst ? [o, h, l, c] : [o, l, h, c];
}

/** Apply adverse slippage in basis points. */
export function slip(price: number, side: 'buy' | 'sell', bps: number): number {
  if (!bps) return price;
  return side === 'buy' ? price * (1 + bps / 10000) : price * (1 - bps / 10000);
}
