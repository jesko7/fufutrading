/**
 * Optimization analytics on compact trial results:
 *  - objectives, constraints and multi-metric ranking,
 *  - neighbour robustness and narrow-peak detection on the parameter grid,
 *  - walk-forward windows (rolling / anchored) and purged + embargoed k-fold partitions,
 *  - window scoring from trades fully inside a window (no information from outside it),
 *  - bootstrap confidence intervals, randomized-entry Monte Carlo test,
 *  - multiple-testing corrections: Deflated Sharpe Ratio, Holm adjustment, PBO (CSCV).
 */
import type { ParamDef, Point } from './space';
import { neighbours, pointKey, rng } from './space';

/** Trade summary used by window analytics: bars are indices into the shared bar data. */
export interface CompactTrade {
  entryBar: number;
  exitBar: number;
  /** Return of the trade on its notional, % (fees included). */
  returnPct: number;
  profit: number;
  dir: 1 | -1;
}

export interface TrialMetrics {
  netProfitPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  cagr: number;
  profitFactor: number;
  winRate: number;
  trades: number;
  expectancy: number;
  exposure: number;
}

export type ObjectiveId = 'netProfitPct' | 'sharpe' | 'sortino' | 'calmar' | 'profitFactor' | 'returnOverDd' | 'expectancy' | 'winRate' | 'cagr';

export const OBJECTIVES: { id: ObjectiveId; label: string; risk: boolean }[] = [
  { id: 'sharpe', label: 'Sharpe ratio', risk: true },
  { id: 'sortino', label: 'Sortino ratio', risk: true },
  { id: 'calmar', label: 'Calmar ratio (CAGR / max DD)', risk: true },
  { id: 'returnOverDd', label: 'Net profit / max drawdown', risk: true },
  { id: 'netProfitPct', label: 'Net profit %', risk: false },
  { id: 'profitFactor', label: 'Profit factor', risk: false },
  { id: 'expectancy', label: 'Expectancy per trade', risk: false },
  { id: 'winRate', label: 'Win rate', risk: false },
  { id: 'cagr', label: 'CAGR', risk: false },
];

export interface Constraints {
  maxDrawdownPct?: number;
  minTrades?: number;
  minProfitFactor?: number;
}

export function objectiveValue(id: ObjectiveId, m: TrialMetrics): number {
  switch (id) {
    case 'returnOverDd':
      return m.maxDrawdownPct > 0 ? m.netProfitPct / m.maxDrawdownPct : m.netProfitPct > 0 ? m.netProfitPct : 0;
    case 'profitFactor':
      return Number.isFinite(m.profitFactor) ? m.profitFactor : m.trades > 0 ? 10 : 0;
    default:
      return (m as unknown as Record<string, number>)[id] ?? NaN;
  }
}

export function violates(m: TrialMetrics, c: Constraints): string | null {
  if (c.maxDrawdownPct !== undefined && m.maxDrawdownPct > c.maxDrawdownPct) return `max drawdown ${m.maxDrawdownPct.toFixed(1)}% > ${c.maxDrawdownPct}%`;
  if (c.minTrades !== undefined && m.trades < c.minTrades) return `${m.trades} trades < ${c.minTrades}`;
  if (c.minProfitFactor !== undefined && !(m.profitFactor >= c.minProfitFactor)) return `profit factor < ${c.minProfitFactor}`;
  return null;
}

export function score(id: ObjectiveId, m: TrialMetrics | null, c: Constraints): number {
  if (!m || violates(m, c)) return -Infinity;
  const v = objectiveValue(id, m);
  return Number.isFinite(v) ? v : -Infinity;
}

/** Rank trials by several metrics (average of per-metric ranks, lower = better). */
export function multiRank(rows: TrialMetrics[], ids: ObjectiveId[]): number[] {
  const n = rows.length;
  const total = new Array(n).fill(0);
  for (const id of ids) {
    const order = rows.map((m, i) => ({ i, v: objectiveValue(id, m) })).sort((a, b) => (Number.isFinite(b.v) ? b.v : -Infinity) - (Number.isFinite(a.v) ? a.v : -Infinity));
    order.forEach((o, r) => (total[o.i] += r + 1));
  }
  return total.map((x) => x / Math.max(1, ids.length));
}

// ------------------------------------------------------------------ robustness

export interface NeighbourStat {
  key: string;
  evaluated: number;
  mean: number;
  min: number;
  /** mean(neighbours) / own score for positive scores (1 = flat plateau). */
  plateau: number;
  /** Average of own score and neighbours (smoothed objective). */
  smoothed: number;
  narrowPeak: boolean;
}

export function neighbourStats(space: ParamDef[], results: { point: Point; score: number }[]): Map<string, NeighbourStat> {
  const byKey = new Map<string, number>();
  for (const r of results) byKey.set(pointKey(space, r.point), r.score);
  const finite = results.map((r) => r.score).filter(Number.isFinite).sort((a, b) => b - a);
  const top = finite.length ? finite[Math.floor(finite.length * 0.1)] : Infinity;
  const out = new Map<string, NeighbourStat>();
  for (const r of results) {
    const key = pointKey(space, r.point);
    const ns = neighbours(space, r.point)
      .map((p) => byKey.get(pointKey(space, p)))
      .filter((v): v is number => v !== undefined);
    const vals = ns.map((v) => (Number.isFinite(v) ? v : NaN)).filter((v) => !Number.isNaN(v));
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    const min = vals.length ? Math.min(...vals) : NaN;
    const own = r.score;
    const plateau = own > 0 && Number.isFinite(mean) ? mean / own : NaN;
    const smoothed = Number.isFinite(own) ? (vals.length ? (own + vals.reduce((a, b) => a + b, 0)) / (vals.length + 1) : own) : -Infinity;
    // a "narrow peak": among the best results but the neighbourhood is much worse or failing
    const failingNeighbours = ns.length - vals.length;
    const narrowPeak = Number.isFinite(own) && own >= top && own > 0 && ns.length > 0 && ((Number.isFinite(plateau) && plateau < 0.5) || failingNeighbours >= Math.ceil(ns.length / 2));
    out.set(key, { key, evaluated: ns.length, mean, min, plateau, smoothed, narrowPeak });
  }
  return out;
}

// ------------------------------------------------------------------ partitions

export interface Window {
  /** In-sample [isFrom, isTo) and out-of-sample [oosFrom, oosTo) as bar indices. */
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
}

/** Walk-forward windows over bars [from, to): OOS segments of `oosBars` after `isBars` of history. */
export function walkForwardWindows(from: number, to: number, opts: { isBars: number; oosBars: number; anchored: boolean; gapBars?: number }): Window[] {
  const out: Window[] = [];
  const gap = Math.max(0, opts.gapBars || 0);
  for (let oosFrom = from + opts.isBars + gap; oosFrom < to; oosFrom += opts.oosBars) {
    const oosTo = Math.min(to, oosFrom + opts.oosBars);
    if (oosTo - oosFrom < Math.max(2, opts.oosBars * 0.25)) break;
    const isTo = oosFrom - gap;
    const isFrom = opts.anchored ? from : Math.max(from, isTo - opts.isBars);
    out.push({ isFrom, isTo, oosFrom, oosTo });
  }
  return out;
}

/**
 * Purged k-fold with embargo (López de Prado): each fold is a test block; training uses the
 * other blocks minus `purgeBars` before the test block (trades that could overlap it) and
 * `embargoBars` after it (serial correlation). Returns training segments per fold.
 */
export function purgedKFold(from: number, to: number, k: number, purgeBars: number, embargoBars: number): { test: [number, number]; train: [number, number][] }[] {
  const n = to - from;
  const size = Math.floor(n / k);
  const folds: { test: [number, number]; train: [number, number][] }[] = [];
  for (let f = 0; f < k; f++) {
    const a = from + f * size;
    const b = f === k - 1 ? to : a + size;
    const train: [number, number][] = [];
    const leftEnd = Math.max(from, a - purgeBars);
    if (leftEnd > from) train.push([from, leftEnd]);
    const rightStart = Math.min(to, b + embargoBars);
    if (rightStart < to) train.push([rightStart, to]);
    folds.push({ test: [a, b], train });
  }
  return folds;
}

/** Performance of trades fully inside the segments (compounded trade returns). */
export function segmentScore(trades: CompactTrade[], segs: [number, number][]): { returnPct: number; trades: number; winRate: number; profitFactor: number; maxDrawdownPct: number; sharpeTrade: number } {
  const inside = trades.filter((t) => segs.some(([a, b]) => t.entryBar >= a && t.exitBar < b));
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  let gp = 0;
  let gl = 0;
  let wins = 0;
  const rs: number[] = [];
  for (const t of inside) {
    const r = t.returnPct / 100;
    rs.push(r);
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    mdd = Math.max(mdd, (peak - eq) / peak);
    if (r > 0) {
      wins++;
      gp += r;
    } else gl -= r;
  }
  const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) : 0;
  return { returnPct: (eq - 1) * 100, trades: inside.length, winRate: inside.length ? wins / inside.length : 0, profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, maxDrawdownPct: mdd * 100, sharpeTrade: sd > 0 ? (mean / sd) * Math.sqrt(rs.length) : 0 };
}

export function segmentObjective(id: ObjectiveId, s: ReturnType<typeof segmentScore>): number {
  switch (id) {
    case 'netProfitPct':
    case 'cagr':
      return s.returnPct;
    case 'profitFactor':
      return Number.isFinite(s.profitFactor) ? s.profitFactor : s.trades ? 10 : 0;
    case 'winRate':
      return s.winRate;
    case 'returnOverDd':
    case 'calmar':
      return s.maxDrawdownPct > 0 ? s.returnPct / s.maxDrawdownPct : s.returnPct;
    case 'expectancy':
      return s.trades ? s.returnPct / s.trades : 0;
    default:
      return s.sharpeTrade;
  }
}

// ------------------------------------------------------------------ statistics

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse standard normal CDF (Acklam). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function moments(x: number[]): { mean: number; sd: number; skew: number; kurt: number } {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / Math.max(1, n);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= Math.max(1, n);
  m3 /= Math.max(1, n);
  m4 /= Math.max(1, n);
  const sd = Math.sqrt(m2);
  return { mean, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3 };
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014): probability that the best strategy's
 * true Sharpe is above zero after accounting for `trials` attempts with Sharpe variance
 * `srVariance` (per-period Sharpe units), and the returns' skew/kurtosis.
 */
export function deflatedSharpe(returns: number[], trials: number, srVariance: number): { sr: number; sr0: number; dsr: number } {
  const T = returns.length;
  const { mean, sd, skew, kurt } = moments(returns);
  const sr = sd > 0 ? mean / sd : 0;
  const g = 0.5772156649;
  const N = Math.max(1, trials);
  const sr0 = N > 1 ? Math.sqrt(Math.max(0, srVariance)) * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E))) : 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const dsr = T > 1 ? normCdf(((sr - sr0) * Math.sqrt(T - 1)) / denom) : 0;
  return { sr, sr0, dsr };
}

/** Holm–Bonferroni adjusted p-values (same order as input). */
export function holm(p: number[]): number[] {
  const m = p.length;
  const order = p.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const adj = new Array(m).fill(1);
  let prev = 0;
  order.forEach((o, k) => {
    const v = Math.min(1, Math.max(prev, (m - k) * o.v));
    adj[o.i] = v;
    prev = v;
  });
  return adj;
}

/** One-sided p-value that the mean return is > 0 (t-test on per-period returns). */
export function sharpePValue(returns: number[]): number {
  const { mean, sd } = moments(returns);
  const n = returns.length;
  if (n < 3 || sd === 0) return 1;
  const t = (mean / (sd * Math.sqrt(n / (n - 1)))) * Math.sqrt(n);
  return 1 - normCdf(t);
}

export interface BootstrapCI {
  p5: number;
  p50: number;
  p95: number;
}

/** Bootstrap the trade sequence: compounded return, max drawdown and per-trade Sharpe. */
export function bootstrapTrades(returnsPct: number[], iterations = 2000, seed = 7): { returnPct: BootstrapCI; maxDrawdownPct: BootstrapCI; sharpe: BootstrapCI; probLoss: number } {
  const rand = rng(seed);
  const n = returnsPct.length;
  const ret: number[] = [];
  const dd: number[] = [];
  const sh: number[] = [];
  if (!n) {
    const z = { p5: 0, p50: 0, p95: 0 };
    return { returnPct: z, maxDrawdownPct: z, sharpe: z, probLoss: 0 };
  }
  for (let it = 0; it < iterations; it++) {
    let eq = 1;
    let peak = 1;
    let mdd = 0;
    let s = 0;
    let s2 = 0;
    for (let k = 0; k < n; k++) {
      const r = returnsPct[Math.floor(rand() * n)] / 100;
      eq *= 1 + r;
      if (eq > peak) peak = eq;
      mdd = Math.max(mdd, (peak - eq) / peak);
      s += r;
      s2 += r * r;
    }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    ret.push((eq - 1) * 100);
    dd.push(mdd * 100);
    sh.push(sd > 0 ? (mean / sd) * Math.sqrt(n) : 0);
  }
  const q = (a: number[]): BootstrapCI => {
    const s = a.sort((x, y) => x - y);
    const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
    return { p5: at(0.05), p50: at(0.5), p95: at(0.95) };
  };
  return { returnPct: q(ret), maxDrawdownPct: q(dd), sharpe: q(sh), probLoss: ret.filter((x) => x < 0).length / ret.length };
}

/**
 * Randomized-entry test: random strategies with the same number of trades, holding times and
 * long/short mix on the same prices (and the same per-side fee). The p-value is the share of
 * random strategies that did at least as well — high values mean the edge may be luck.
 */
export function randomEntryTest(close: Float64Array, from: number, to: number, trades: CompactTrade[], feePerSide: number, iterations = 1000, seed = 11): { pValue: number; strategyReturnPct: number; randomMedianPct: number; random95Pct: number } {
  const rand = rng(seed);
  const inside = trades.filter((t) => t.entryBar >= from && t.exitBar < to && t.exitBar > t.entryBar);
  let strat = 1;
  for (const t of inside) strat *= 1 + t.returnPct / 100;
  const stratPct = (strat - 1) * 100;
  if (!inside.length) return { pValue: 1, strategyReturnPct: 0, randomMedianPct: 0, random95Pct: 0 };
  const holds = inside.map((t) => t.exitBar - t.entryBar);
  const dirs = inside.map((t) => t.dir);
  const totalHold = holds.reduce((a, b) => a + b, 0);
  const span = to - from;
  if (totalHold >= span) return { pValue: 1, strategyReturnPct: stratPct, randomMedianPct: stratPct, random95Pct: stratPct };
  const res: number[] = [];
  for (let it = 0; it < iterations; it++) {
    // random non-overlapping placement: shuffle trades, distribute free bars randomly between them
    const order = holds.map((_, i) => i).sort(() => rand() - 0.5);
    const free = span - totalHold;
    const cuts = Array.from({ length: order.length }, () => Math.floor(rand() * (free + 1))).sort((a, b) => a - b);
    let eq = 1;
    let pos = from;
    let prevCut = 0;
    for (let k = 0; k < order.length; k++) {
      pos += cuts[k] - prevCut;
      prevCut = cuts[k];
      const h = holds[order[k]];
      const a = close[pos];
      const b = close[Math.min(to - 1, pos + h)];
      const r = a > 0 ? ((b - a) / a) * dirs[order[k]] - 2 * feePerSide : 0;
      eq *= 1 + r;
      pos += h;
    }
    res.push((eq - 1) * 100);
  }
  res.sort((a, b) => a - b);
  const better = res.filter((x) => x >= stratPct).length;
  return { pValue: (better + 1) / (iterations + 1), strategyReturnPct: stratPct, randomMedianPct: res[Math.floor(res.length / 2)], random95Pct: res[Math.floor(res.length * 0.95)] };
}

/**
 * Probability of Backtest Overfitting via combinatorially symmetric cross-validation (Bailey et
 * al.). `perf[trial][block]` = return of each trial in each time block. For every split of the
 * blocks into halves, the IS-best trial's OOS rank is recorded; PBO = share of splits where it
 * ranks below the OOS median.
 */
export function pbo(perf: number[][], maxSplits = 400, seed = 3): { pbo: number; splits: number; logits: number[] } {
  const N = perf.length;
  const S = perf[0]?.length || 0;
  if (N < 2 || S < 4 || S % 2) return { pbo: NaN, splits: 0, logits: [] };
  const combos: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === S / 2) {
      combos.push(cur.slice());
      return;
    }
    for (let i = start; i < S; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  const rand = rng(seed);
  const pick = combos.length > maxSplits ? combos.sort(() => rand() - 0.5).slice(0, maxSplits) : combos;
  const logits: number[] = [];
  let below = 0;
  for (const is of pick) {
    const isSet = new Set(is);
    const isScore = perf.map((row) => row.reduce((a, v, b) => a + (isSet.has(b) ? v : 0), 0));
    const oosScore = perf.map((row) => row.reduce((a, v, b) => a + (isSet.has(b) ? 0 : v), 0));
    let best = 0;
    for (let i = 1; i < N; i++) if (isScore[i] > isScore[best]) best = i;
    const rank = oosScore.filter((v) => v < oosScore[best]).length + 0.5 * (oosScore.filter((v) => v === oosScore[best]).length - 1) + 1;
    const w = rank / (N + 1);
    logits.push(Math.log(w / (1 - w)));
    if (w < 0.5) below++;
  }
  return { pbo: below / pick.length, splits: pick.length, logits };
}

// ------------------------------------------------------------------ window metrics from daily equity

export interface DailyEquity {
  t: number[];
  eq: number[];
  /** bar index of each end-of-day sample */
  bar: number[];
}

/** Daily returns whose end-of-day sample lies in one of the segments (bar ranges). */
export function sliceReturns(d: DailyEquity, segs: [number, number][]): number[] {
  const out: number[] = [];
  for (let k = 1; k < d.eq.length; k++) {
    const b = d.bar[k];
    if (!segs.some(([a, z]) => b >= a && b < z)) continue;
    const prev = d.eq[k - 1];
    if (prev > 0) out.push(d.eq[k] / prev - 1);
  }
  return out;
}

/**
 * Metrics restricted to bar segments: returns/drawdown/Sharpe from daily equity inside the
 * segments (equity at a time only depends on data up to that time), trade statistics from
 * trades fully inside them.
 */
export function sliceMetrics(d: DailyEquity, trades: CompactTrade[], segs: [number, number][]): TrialMetrics {
  const rets = sliceReturns(d, segs);
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of rets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const n = rets.length;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const down = n ? Math.sqrt(rets.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / n) : 0;
  const inside = trades.filter((t) => segs.some(([a, z]) => t.entryBar >= a && t.exitBar < z));
  let gp = 0;
  let gl = 0;
  let wins = 0;
  for (const t of inside) {
    if (t.returnPct > 0) {
      wins++;
      gp += t.returnPct;
    } else gl -= t.returnPct;
  }
  const ret = (eq - 1) * 100;
  const years = n / 365;
  const cagr = years > 0 && eq > 0 ? (Math.pow(eq, 1 / years) - 1) * 100 : 0;
  return {
    netProfitPct: ret,
    maxDrawdownPct: mdd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    sortino: down > 0 ? (mean / down) * Math.sqrt(365) : 0,
    calmar: mdd > 0 ? cagr / (mdd * 100) : 0,
    cagr,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    winRate: inside.length ? wins / inside.length : 0,
    trades: inside.length,
    expectancy: inside.length ? inside.reduce((a, t) => a + t.returnPct, 0) / inside.length : 0,
    exposure: NaN,
  };
}

/** Per-bar regime labels (trend: close vs SMA and slope; volatility: rolling realised vol vs median). */
export function regimeLabels(close: Float64Array, from: number, to: number, maLen = 200, volLen = 50): { trend: (string | null)[]; vol: (string | null)[] } {
  const n = close.length;
  const ma = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += close[i];
    if (i >= maLen) sum -= close[i - maLen];
    if (i >= maLen - 1) ma[i] = sum / maLen;
  }
  const vol = new Float64Array(n).fill(NaN);
  let s1 = 0;
  let s2 = 0;
  const lr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    lr[i] = close[i - 1] > 0 ? Math.log(close[i] / close[i - 1]) : 0;
    s1 += lr[i];
    s2 += lr[i] * lr[i];
    if (i > volLen) {
      s1 -= lr[i - volLen];
      s2 -= lr[i - volLen] * lr[i - volLen];
    }
    if (i >= volLen) vol[i] = Math.sqrt(Math.max(0, s2 / volLen - (s1 / volLen) ** 2));
  }
  const vals = [...vol.subarray(from, to)].filter(Number.isFinite).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : NaN;
  const trend: (string | null)[] = new Array(n).fill(null);
  const vl: (string | null)[] = new Array(n).fill(null);
  for (let i = from; i < to; i++) {
    if (Number.isFinite(ma[i]) && i >= 10 && Number.isFinite(ma[i - 10])) {
      const sl = (ma[i] - ma[i - 10]) / ma[i - 10];
      trend[i] = close[i] > ma[i] && sl > 0.002 ? 'Uptrend' : close[i] < ma[i] && sl < -0.002 ? 'Downtrend' : 'Sideways';
    }
    if (Number.isFinite(vol[i]) && Number.isFinite(med)) vl[i] = vol[i] >= med ? 'High volatility' : 'Low volatility';
  }
  return { trend, vol: vl };
}

/** Compounded return per regime from daily equity samples (regime of each day's last bar). */
export function regimeReturns(d: DailyEquity, labels: (string | null)[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (let k = 1; k < d.eq.length; k++) {
    const lab = labels[d.bar[k]];
    if (!lab || !(d.eq[k - 1] > 0)) continue;
    acc[lab] = (acc[lab] ?? 0) + Math.log(d.eq[k] / d.eq[k - 1]);
  }
  for (const k of Object.keys(acc)) acc[k] = (Math.exp(acc[k]) - 1) * 100;
  return acc;
}
