/**
 * Options math and chain analytics. Binance prices its USDT-margined European options with
 * Black-Scholes on the index price and a published risk-free rate (no dividend), so the same
 * model gives values and Greeks consistent with the exchange's:
 *  - prices and Greeks (theta per calendar day, vega and rho per volatility / rate point),
 *  - implied volatility from a price,
 *  - per-expiry analytics: ATM volatility at the forward, 25-delta risk reversal and butterfly,
 *    max pain, open interest and dealer gamma exposure by strike, the gamma flip,
 *  - 30-day volatility interpolated in total variance (like volatility indices),
 *  - multi-leg positions: payoff and Greeks at any date, price and volatility shift.
 */
import type { SymbolId } from './symbols';

export type OptionSide = 'C' | 'P';

const DAY = 86400000;
const YEAR = 365 * DAY;

/** One listed option with its market data (prices in USDT, IVs as fractions). */
export interface OptionRow {
  symbol: string;
  expiry: number;
  strike: number;
  side: OptionSide;
  mark: number;
  bid: number;
  ask: number;
  bidIV: number;
  askIV: number;
  markIV: number;
  /** Binance's Greeks per contract (1 unit of the underlying): theta per day, vega per volatility point. */
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Open interest and 24-hour volume in contracts. */
  oi: number;
  volume: number;
  last: number;
  changePct: number;
}

export interface OptionsSnapshot {
  underlying: SymbolId;
  base: string;
  /** Index price the options settle against. */
  index: number;
  /** Risk-free rate in Binance's pricing. */
  rf: number;
  /** Time of the data (ms). */
  t: number;
  expiries: number[];
  rows: OptionRow[];
  error?: string;
}

/** "BTC-261225-85000-C": base, expiry (08:00 UTC), strike and side. */
export function parseOptionSymbol(s: string): { base: string; expiry: number; strike: number; side: OptionSide } | null {
  const m = /^([A-Z0-9]+)-(\d{2})(\d{2})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(s);
  if (!m) return null;
  return { base: m[1], expiry: Date.UTC(2000 + +m[2], +m[3] - 1, +m[4], 8), strike: +m[5], side: m[6] as OptionSide };
}

/** Binance's expiry code of a date: YYMMDD (UTC). */
export function expiryCode(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const yearsTo = (expiry: number, now: number): number => Math.max(0, (expiry - now) / YEAR);

// ------------------------------------------------------------------ normal distribution

/** Standard normal CDF, accurate to double precision (Hart / West). */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / 2.5066282746310002;

// ------------------------------------------------------------------ Black-Scholes

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per volatility point (0.01). */
  vega: number;
  /** Per rate point (0.01). */
  rho: number;
}

/** Black-Scholes value and Greeks per unit of the underlying (T in years; sigma and r as fractions). */
export function blackScholes(side: OptionSide, S: number, K: number, T: number, sigma: number, r: number): Greeks {
  if (!(T > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) {
    const call = side === 'C';
    return { price: Math.max(0, call ? S - K : K - S), delta: call ? (S > K ? 1 : 0) : S < K ? -1 : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const df = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sigma * sq);
  const vega = (S * pdf * sq) / 100;
  const decay = (-S * pdf * sigma) / (2 * sq);
  if (side === 'C') {
    const n1 = normCdf(d1);
    const n2 = normCdf(d2);
    return { price: S * n1 - K * df * n2, delta: n1, gamma, theta: (decay - r * K * df * n2) / 365, vega, rho: (K * T * df * n2) / 100 };
  }
  const n1 = normCdf(-d1);
  const n2 = normCdf(-d2);
  return { price: K * df * n2 - S * n1, delta: -n1, gamma, theta: (decay + r * K * df * n2) / 365, vega, rho: (-K * T * df * n2) / 100 };
}

/** Volatility at which Black-Scholes gives `price` (NaN when the price is outside the no-arbitrage bounds). */
export function impliedVol(side: OptionSide, price: number, S: number, K: number, T: number, r: number): number {
  if (!(price > 0) || !(T > 0) || !(S > 0) || !(K > 0)) return NaN;
  const df = Math.exp(-r * T);
  const lower = side === 'C' ? Math.max(0, S - K * df) : Math.max(0, K * df - S);
  const upper = side === 'C' ? S : K * df;
  if (price <= lower + 1e-12 || price >= upper) return NaN;
  let lo = 1e-4;
  let hi = 10;
  let sigma = 0.6;
  for (let k = 0; k < 100; k++) {
    const g = blackScholes(side, S, K, T, sigma, r);
    const diff = g.price - price;
    if (Math.abs(diff) < 1e-10 * Math.max(1, price)) return sigma;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    const v = g.vega * 100;
    let next = v > 1e-12 ? sigma - diff / v : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (hi - lo < 1e-12) return sigma;
    sigma = next;
  }
  return sigma;
}

// ------------------------------------------------------------------ chain analytics

/** Rows of one expiry by strike. */
export function byStrike(rows: OptionRow[]): { strike: number; C?: OptionRow; P?: OptionRow }[] {
  const m = new Map<number, { strike: number; C?: OptionRow; P?: OptionRow }>();
  for (const r of rows) {
    const e = m.get(r.strike) || { strike: r.strike };
    e[r.side] = r;
    m.set(r.strike, e);
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

const iv = (r: OptionRow | undefined) => (r && r.markIV > 0 ? r.markIV : NaN);

/** Mark volatility of a strike: the out-of-the-money side (the liquid one), else the other. */
function strikeIV(e: { strike: number; C?: OptionRow; P?: OptionRow }, F: number): number {
  const otm = e.strike >= F ? iv(e.C) : iv(e.P);
  return Number.isFinite(otm) ? otm : e.strike >= F ? iv(e.P) : iv(e.C);
}

/** Linear interpolation of y at x over points sorted by x (clamped at the ends). */
function interp(pts: [number, number][], x: number): number {
  const p = pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!p.length) return NaN;
  if (x <= p[0][0]) return p[0][1];
  if (x >= p[p.length - 1][0]) return p[p.length - 1][1];
  for (let k = 1; k < p.length; k++) {
    if (x <= p[k][0]) {
      const [x0, y0] = p[k - 1];
      const [x1, y1] = p[k];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return NaN;
}

export const forwardOf = (S: number, r: number, T: number): number => S * Math.exp(r * T);

/** At-the-money volatility of one expiry: the smile interpolated at the forward price. */
export function atmVol(rows: OptionRow[], S: number, r: number, now: number): number {
  if (!rows.length) return NaN;
  const T = yearsTo(rows[0].expiry, now);
  const F = forwardOf(S, r, T);
  return interp(byStrike(rows).map((e) => [e.strike, strikeIV(e, F)] as [number, number]), F);
}

/** Smile of one expiry: mark volatility by strike (out-of-the-money side), with bid/ask volatilities. */
export function smile(rows: OptionRow[], S: number, r: number, now: number): { strike: number; iv: number; bid: number; ask: number }[] {
  if (!rows.length) return [];
  const F = forwardOf(S, r, yearsTo(rows[0].expiry, now));
  return byStrike(rows)
    .map((e) => {
      const o = e.strike >= F ? e.C || e.P : e.P || e.C;
      return { strike: e.strike, iv: strikeIV(e, F), bid: o && o.bidIV > 0 ? o.bidIV : NaN, ask: o && o.askIV > 0 ? o.askIV : NaN };
    })
    .filter((x) => Number.isFinite(x.iv));
}

/** Volatility at a delta (calls 0.25, puts -0.25), interpolated along the smile. */
export function volAtDelta(rows: OptionRow[], side: OptionSide, delta: number): number {
  const pts = rows
    .filter((r) => r.side === side && r.markIV > 0 && Number.isFinite(r.delta) && Math.abs(r.delta) > 0.01 && Math.abs(r.delta) < 0.99)
    .map((r) => [r.delta, r.markIV] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2 || delta < pts[0][0] || delta > pts[pts.length - 1][0]) return NaN;
  return interp(pts, delta);
}

/** 25-delta risk reversal (call minus put volatility) and butterfly (their average over ATM). */
export function skew25(rows: OptionRow[], S: number, r: number, now: number): { rr: number; bf: number; call: number; put: number } {
  const call = volAtDelta(rows, 'C', 0.25);
  const put = volAtDelta(rows, 'P', -0.25);
  const atm = atmVol(rows, S, r, now);
  return { rr: call - put, bf: (call + put) / 2 - atm, call, put };
}

/** Settlement price at which option holders receive the least (max pain), with the payout curve. */
export function maxPain(rows: OptionRow[]): { strike: number; payout: [number, number][] } {
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  const oi = (r: OptionRow) => (r.oi > 0 ? r.oi : 0);
  const payout: [number, number][] = strikes.map((X) => [X, rows.reduce((s, r) => s + oi(r) * Math.max(0, r.side === 'C' ? X - r.strike : r.strike - X), 0)]);
  let best = NaN;
  let min = Infinity;
  // without open interest there is no pain to minimise
  if (rows.some((r) => oi(r) > 0))
    for (const [X, p] of payout)
      if (p < min) {
        min = p;
        best = X;
      }
  return { strike: best, payout };
}

export interface StrikeExposure {
  strike: number;
  callOI: number;
  putOI: number;
  /** Dealer gamma exposure in USDT per 1% move (calls +, puts −). */
  gex: number;
}

/**
 * Open interest and gamma exposure by strike. Gamma exposure follows the common convention that
 * dealers are long the calls and short the puts investors trade: positive values damp moves
 * (dealers sell rallies and buy dips), negative values amplify them.
 */
export function exposureByStrike(rows: OptionRow[], S: number): StrikeExposure[] {
  const m = new Map<number, StrikeExposure>();
  for (const r of rows) {
    const e = m.get(r.strike) || { strike: r.strike, callOI: 0, putOI: 0, gex: 0 };
    const oi = r.oi > 0 ? r.oi : 0;
    if (r.side === 'C') e.callOI += oi;
    else e.putOI += oi;
    if (Number.isFinite(r.gamma)) e.gex += (r.side === 'C' ? 1 : -1) * r.gamma * oi * S * S * 0.01;
    m.set(r.strike, e);
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

/** Total gamma exposure if the index were at `S` (Greeks recomputed with each option's mark volatility). */
export function totalGex(rows: OptionRow[], S: number, r: number, now: number): number {
  let g = 0;
  for (const o of rows) {
    if (!(o.oi > 0) || !(o.markIV > 0)) continue;
    const T = yearsTo(o.expiry, now);
    if (!(T > 0)) continue;
    g += (o.side === 'C' ? 1 : -1) * blackScholes(o.side, S, o.strike, T, o.markIV, r).gamma * o.oi * S * S * 0.01;
  }
  return g;
}

/** Index level where total gamma exposure changes sign, searched within ±range of the index (NaN if none). */
export function gammaFlip(rows: OptionRow[], S: number, r: number, now: number, range = 0.25): number {
  const n = 80;
  let prevX = NaN;
  let prevG = NaN;
  let best = NaN;
  for (let k = 0; k <= n; k++) {
    const x = S * (1 - range + (2 * range * k) / n);
    const g = totalGex(rows, x, r, now);
    if (Number.isFinite(prevG) && Math.sign(g) !== Math.sign(prevG) && g !== 0) {
      const root = prevX + ((x - prevX) * -prevG) / (g - prevG);
      if (!Number.isFinite(best) || Math.abs(root - S) < Math.abs(best - S)) best = root;
    }
    prevX = x;
    prevG = g;
  }
  return best;
}

/** Volatility for `days` interpolated in total variance between the bracketing expiries (like volatility indices). */
export function constantMaturityVol(term: { t: number; iv: number }[], days: number): number {
  const T = days / 365;
  const pts = term.filter((p) => p.t > 1 / 365 && p.iv > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return NaN;
  if (T <= pts[0].t) return pts[0].iv;
  if (T >= pts[pts.length - 1].t) return pts[pts.length - 1].iv;
  for (let k = 1; k < pts.length; k++) {
    if (T <= pts[k].t) {
      const a = pts[k - 1];
      const b = pts[k];
      const wa = a.iv * a.iv * a.t;
      const wb = b.iv * b.iv * b.t;
      const w = wa + ((wb - wa) * (T - a.t)) / (b.t - a.t);
      return Math.sqrt(Math.max(0, w) / T);
    }
  }
  return NaN;
}

export interface ExpirySummary {
  expiry: number;
  /** Years to expiry. */
  t: number;
  atm: number;
  rr25: number;
  bf25: number;
  maxPain: number;
  callOI: number;
  putOI: number;
  volume: number;
}

export function expirySummaries(s: OptionsSnapshot): ExpirySummary[] {
  return s.expiries.map((e) => {
    const rows = s.rows.filter((r) => r.expiry === e);
    const sk = skew25(rows, s.index, s.rf, s.t);
    let callOI = 0;
    let putOI = 0;
    let volume = 0;
    for (const r of rows) {
      const oi = r.oi > 0 ? r.oi : 0;
      if (r.side === 'C') callOI += oi;
      else putOI += oi;
      volume += r.volume || 0;
    }
    return { expiry: e, t: yearsTo(e, s.t), atm: atmVol(rows, s.index, s.rf, s.t), rr25: sk.rr, bf25: sk.bf, maxPain: maxPain(rows).strike, callOI, putOI, volume };
  });
}

// ------------------------------------------------------------------ positions

export interface OptionLeg {
  id: string;
  /** An option (by symbol) or the underlying itself (a perpetual or spot position). */
  kind: 'option' | 'underlying';
  symbol?: string;
  side?: OptionSide;
  strike?: number;
  expiry?: number;
  /** Signed quantity in units of the underlying: + bought, − sold. */
  qty: number;
  /** Entry price per unit (premium for options). */
  price: number;
  /** Volatility the leg is valued with (its mark volatility). */
  iv?: number;
}

/** Value and Greeks of one leg per unit at index `S` and time `at` (volatility shifted by `dIv`). */
export function legGreeks(leg: OptionLeg, S: number, at: number, r: number, dIv = 0): Greeks {
  if (leg.kind === 'underlying') return { price: S, delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 };
  return blackScholes(leg.side!, S, leg.strike!, yearsTo(leg.expiry!, at), Math.max(0.01, (leg.iv || 0) + dIv), r);
}

/** Profit and loss of a position at index `S` and time `at` (USDT). */
export function positionPnl(legs: OptionLeg[], S: number, at: number, r: number, dIv = 0): number {
  let p = 0;
  for (const l of legs) p += l.qty * (legGreeks(l, S, at, r, dIv).price - l.price);
  return p;
}

/** Greeks of a position (sums of quantity × per-unit Greeks). */
export function positionGreeks(legs: OptionLeg[], S: number, at: number, r: number, dIv = 0): Greeks {
  const g: Greeks = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of legs) {
    const x = legGreeks(l, S, at, r, dIv);
    g.price += l.qty * x.price;
    g.delta += l.qty * x.delta;
    g.gamma += l.qty * x.gamma;
    g.theta += l.qty * x.theta;
    g.vega += l.qty * x.vega;
    g.rho += l.qty * x.rho;
  }
  return g;
}

/** Index levels where a P&L curve crosses zero (linear interpolation between samples). */
export function breakEvens(curve: [number, number][]): number[] {
  const out: number[] = [];
  for (let k = 1; k < curve.length; k++) {
    const [x0, y0] = curve[k - 1];
    const [x1, y1] = curve[k];
    if (y0 === 0 && k === 1) out.push(x0);
    if ((y0 < 0 && y1 >= 0) || (y0 > 0 && y1 <= 0)) out.push(y1 === 0 ? x1 : x0 + ((x1 - x0) * -y0) / (y1 - y0));
  }
  return out;
}
