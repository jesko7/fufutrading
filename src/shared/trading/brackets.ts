/**
 * Binance USDⓈ-M futures leverage brackets (maintenance margin tiers) and the official
 * liquidation-price formula.
 *
 * Bundled snapshot verified 2026-10-12 from Binance's public bracket endpoint
 * (https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets, the data behind
 * https://www.binance.com/en/futures/trading-rules/perpetual/leverage-margin). The app
 * refreshes this table at startup when online; the snapshot is only a fallback.
 *
 * Formula source: Binance FAQ "How to Calculate Liquidation Price of USDⓈ-M Futures Contracts"
 * (one-way mode):
 *   LP = (WB − TMM1 + UPNL1 + cumB − Side × Position × EP) / (Position × MMR − Side × Position)
 * WB = wallet balance (cross: cross wallet balance; isolated: isolated wallet balance),
 * TMM1/UPNL1 = maintenance margin / unrealized PnL of all *other* cross positions (0 for isolated),
 * cumB = maintenance amount of the tier, Side = 1 long / −1 short, Position = |size|, EP = entry.
 * Verified against Binance's published worked example (ETHUSDT LP 1153.26, BTCUSDT LP 26316.89)
 * in tests/unit/trading.test.ts.
 */
import type { SymbolId } from '../symbols';

export interface Bracket {
  floor: number;
  cap: number;
  mmr: number;
  cum: number;
  maxLeverage: number;
  minLeverage: number;
}

export const BRACKETS_VERIFIED = '2026-10-12';
export const BRACKETS_SOURCE = 'https://www.binance.com/en/futures/trading-rules/perpetual/leverage-margin';

const B = (rows: [number, number, number, number, number, number][]): Bracket[] => rows.map(([floor, cap, mmr, cum, minLeverage, maxLeverage]) => ({ floor, cap, mmr, cum, minLeverage, maxLeverage }));

export const DEFAULT_BRACKETS: Record<SymbolId, Bracket[]> = {
  BTCUSDT: B([
    [0, 300000, 0.004, 0, 101, 150],
    [300000, 800000, 0.005, 300, 76, 100],
    [800000, 3000000, 0.0065, 1500, 51, 75],
    [3000000, 12000000, 0.01, 12000, 26, 50],
    [12000000, 70000000, 0.02, 132000, 21, 25],
    [70000000, 100000000, 0.025, 482000, 11, 20],
    [100000000, 230000000, 0.05, 2982000, 6, 10],
    [230000000, 480000000, 0.1, 14482000, 5, 5],
    [480000000, 600000000, 0.125, 26482000, 4, 4],
    [600000000, 800000000, 0.15, 41482000, 3, 3],
    [800000000, 1200000000, 0.25, 121482000, 2, 2],
    [1200000000, 1800000000, 0.5, 421482000, 1, 1],
  ]),
  ETHUSDT: B([
    [0, 300000, 0.004, 0, 101, 150],
    [300000, 800000, 0.005, 300, 76, 100],
    [800000, 3000000, 0.0065, 1500, 51, 75],
    [3000000, 12000000, 0.01, 12000, 26, 50],
    [12000000, 50000000, 0.02, 132000, 21, 25],
    [50000000, 65000000, 0.025, 382000, 11, 20],
    [65000000, 150000000, 0.05, 2007000, 6, 10],
    [150000000, 320000000, 0.1, 9507000, 5, 5],
    [320000000, 400000000, 0.125, 17507000, 4, 4],
    [400000000, 530000000, 0.15, 27507000, 3, 3],
    [530000000, 800000000, 0.25, 80507000, 2, 2],
    [800000000, 1200000000, 0.5, 280507000, 1, 1],
  ]),
  SOLUSDT: B([
    [0, 50000, 0.005, 0, 76, 100],
    [50000, 400000, 0.0065, 75, 51, 75],
    [400000, 1000000, 0.01, 1475, 26, 50],
    [1000000, 4000000, 0.02, 11475, 21, 25],
    [4000000, 8000000, 0.025, 31475, 11, 20],
    [8000000, 40000000, 0.05, 231475, 6, 10],
    [40000000, 80000000, 0.1, 2231475, 5, 5],
    [80000000, 100000000, 0.125, 4231475, 3, 4],
    [100000000, 200000000, 0.25, 16731475, 2, 2],
    [200000000, 400000000, 0.5, 66731475, 1, 1],
  ]),
};

let active: Record<string, Bracket[]> = { ...DEFAULT_BRACKETS };
let activeVerifiedAt = BRACKETS_VERIFIED;

/** Replace the active table (from a live refresh). */
export function setBrackets(table: Partial<Record<SymbolId, Bracket[]>>, verifiedAt: string): void {
  active = { ...active, ...table };
  activeVerifiedAt = verifiedAt;
}

export function bracketsInfo(): { verifiedAt: string; source: string } {
  return { verifiedAt: activeVerifiedAt, source: BRACKETS_SOURCE };
}

export function bracketsFor(symbol: SymbolId): Bracket[] {
  return active[symbol] || DEFAULT_BRACKETS[symbol];
}

/** Parse the response of the public bracket endpoint. */
export function parseBracketResponse(json: any): Partial<Record<SymbolId, Bracket[]>> {
  const out: Partial<Record<SymbolId, Bracket[]>> = {};
  const list = json?.data?.brackets || [];
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as SymbolId[]) {
    const x = list.find((b: any) => b.symbol === sym);
    if (!x) continue;
    out[sym] = x.riskBrackets.map((r: any) => ({ floor: +r.bracketNotionalFloor, cap: +r.bracketNotionalCap, mmr: +r.bracketMaintenanceMarginRate, cum: +r.cumFastMaintenanceAmount, minLeverage: +r.minOpenPosLeverage, maxLeverage: +r.maxOpenPosLeverage }));
  }
  return out;
}

export function tierFor(symbol: SymbolId, notional: number): Bracket {
  const bs = bracketsFor(symbol);
  for (const b of bs) if (notional >= b.floor && notional < b.cap) return b;
  return bs[bs.length - 1];
}

/** Highest leverage allowed for a given position notional. */
export function maxLeverageFor(symbol: SymbolId, notional: number): number {
  return tierFor(symbol, notional).maxLeverage;
}

/** Largest notional allowed at a given leverage. */
export function maxNotionalFor(symbol: SymbolId, leverage: number): number {
  const bs = bracketsFor(symbol);
  let cap = 0;
  for (const b of bs) if (leverage <= b.maxLeverage) cap = b.cap;
  return cap;
}

export function maintenanceMargin(symbol: SymbolId, notional: number): number {
  const t = tierFor(symbol, Math.abs(notional));
  return Math.max(0, Math.abs(notional) * t.mmr - t.cum);
}

export interface LiqInput {
  symbol: SymbolId;
  side: 1 | -1;
  qty: number;
  entry: number;
  /** cross: cross wallet balance; isolated: isolated wallet balance (position margin) */
  wallet: number;
  /** cross only: maintenance margin and unrealized PnL of all other cross positions */
  otherMM?: number;
  otherUPnL?: number;
}

/**
 * Binance one-way liquidation price. The tier depends on the notional at the liquidation price,
 * so the computation is repeated with the tier implied by the result (as Binance instructs).
 * Returns NaN if no liquidation price exists (e.g. fully collateralised long), 0 if it is
 * below zero for longs.
 */
export function liquidationPrice(inp: LiqInput, markForTier?: number): number {
  const { symbol, side, qty, entry, wallet } = inp;
  if (!(qty > 0)) return NaN;
  const tmm = inp.otherMM || 0;
  const upnl = inp.otherUPnL || 0;
  let tier = tierFor(symbol, qty * (markForTier ?? entry));
  let lp = NaN;
  for (let iter = 0; iter < 4; iter++) {
    const num = wallet - tmm + upnl + tier.cum - side * qty * entry;
    const den = qty * tier.mmr - side * qty;
    lp = den !== 0 ? num / den : NaN;
    if (!isFinite(lp)) return NaN;
    if (lp <= 0) return side === 1 ? 0 : NaN;
    const t2 = tierFor(symbol, qty * lp);
    if (t2 === tier) break;
    tier = t2;
  }
  return lp;
}

/** Bankruptcy price: where the position's margin is exactly exhausted (no maintenance margin). */
export function bankruptcyPrice(side: 1 | -1, qty: number, entry: number, wallet: number): number {
  return entry - (side * wallet) / qty;
}
