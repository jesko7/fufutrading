/** Futures market data shown in the Derivatives module (see main/market/derivatives). */
import type { SymbolId } from './symbols';

export interface LiquidationEvent {
  t: number;
  symbol: SymbolId;
  /** The position that was liquidated. */
  side: 'long' | 'short';
  price: number;
  qty: number;
  notional: number;
}

export interface DerivativesSnapshot {
  symbol: SymbolId;
  t: number;
  /** Open interest in contracts (base asset) and USDT, with changes and the 5-minute history of the value. */
  openInterest: { qty: number; value: number; change1hPct: number; change24hPct: number; history: [number, number][] } | null;
  /** Predicted funding rate for the next funding time, from the mark price stream. */
  funding: { rate: number; next: number; mark: number } | null;
  fundingHistory: { t: number; rate: number }[];
  /** Average funding of the last 7 days, annualised (3 fundings a day), %. */
  funding7dAnnualPct: number;
  /** All accounts: share long/short and ratio; top traders' positions: share long and ratio; ratio history. */
  longShort: { long: number; short: number; ratio: number; topLong: number; topRatio: number; history: [number, number][] } | null;
  /** Taker buy/sell volume ratio (5 minutes), the last hour's volumes and the ratio history. */
  taker: { ratio: number; buy1h: number; sell1h: number; history: [number, number][] } | null;
  /** Liquidations since the module started watching (Binance streams at most one per second, the largest). */
  liquidations: { since: number; long1h: number; short1h: number; long24h: number; short24h: number; recent: LiquidationEvent[] };
  /** Liquidated notional per minute over the last hour: [minute start, longs, shorts]. */
  liqMinutes: [number, number, number][];
  /** Open interest value sampled every minute while watched: [time, USDT]. */
  oiMinutes: [number, number][];
}

/** Open interest value at `t` from the minute samples, else the 5-minute history (null when unknown). */
export function oiValueAt(s: DerivativesSnapshot, t: number): number | null {
  let best: number | null = null;
  for (const [ts, v] of s.oiMinutes) if (ts <= t) best = v;
  if (best !== null && s.oiMinutes.length && s.oiMinutes[0][0] <= t) return best;
  best = null;
  for (const [ts, v] of s.openInterest?.history || []) if (ts <= t) best = v;
  return best;
}
