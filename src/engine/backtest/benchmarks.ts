/**
 * Benchmarks beyond buy & hold, for the Strategy Tester, optimizer and AI tools:
 *
 *  - Greeks: alpha, beta, correlation, R², volatility, tracking error, information and Treynor
 *    ratios, Omega, up/down capture, downside/upside beta, VaR/CVaR, skew and kurtosis, from
 *    daily returns of the strategy against buy & hold of the same instrument.
 *  - Random counterparts: the strategy against many random strategies that make the same
 *    trades (count, holding times, sizes, direction mix, costs) at random times ("timing"),
 *    and against coin-flip directions at its own entry and exit times ("direction").
 *    Both are marked to market on one checkpoint grid, so return, Sharpe and drawdown are
 *    compared like for like.
 */

const DAY = 86400000;

// ------------------------------------------------------------------ Greeks

export interface Greeks {
  /** Number of aligned daily returns the figures are based on. */
  days: number;
  /** Jensen's alpha, annualised, % (return not explained by beta to the benchmark). */
  alpha: number;
  beta: number;
  /** ρ: correlation of daily returns with the benchmark. */
  correlation: number;
  rSquared: number;
  /** σ: annualised volatility of the strategy, %. */
  sigma: number;
  benchSigma: number;
  /** Annualised standard deviation of the return difference to the benchmark, %. */
  trackingError: number;
  informationRatio: number;
  /** Annualised excess return per unit of beta, %. */
  treynor: number;
  /** Ω: sum of daily gains over sum of daily losses (threshold 0). */
  omega: number;
  /** Average strategy return on the benchmark's up (down) days relative to the benchmark's, %. */
  upCapture: number;
  downCapture: number;
  upsideBeta: number;
  downsideBeta: number;
  /** Historical one-day value at risk and expected shortfall at 95%, % of equity (positive = loss). */
  var95: number;
  cvar95: number;
  skew: number;
  /** Excess kurtosis (0 for a normal distribution). */
  kurtosis: number;
  /** 95th percentile gain over the 5th percentile loss. */
  tailRatio: number;
}

/** Daily simple returns of two equity curves, sampled at the last bar of each UTC day. */
export function alignedDailyReturns(t: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>): { ra: number[]; rb: number[] } {
  const ra: number[] = [];
  const rb: number[] = [];
  const n = Math.min(t.length, a.length, b.length);
  if (n < 2) return { ra, rb };
  let prevA = a[0];
  let prevB = b[0];
  let day = Math.floor(t[0] / DAY);
  const push = (ca: number, cb: number) => {
    if (prevA > 0 && prevB > 0 && Number.isFinite(ca) && Number.isFinite(cb)) {
      ra.push(ca / prevA - 1);
      rb.push(cb / prevB - 1);
    }
    prevA = ca;
    prevB = cb;
  };
  for (let i = 1; i < n; i++) {
    const d = Math.floor(t[i] / DAY);
    if (d !== day) {
      push(a[i - 1], b[i - 1]);
      day = d;
    }
  }
  if (a[n - 1] !== prevA || b[n - 1] !== prevB) push(a[n - 1], b[n - 1]);
  return { ra, rb };
}

function quantileSorted(s: ArrayLike<number>, p: number): number {
  if (!s.length) return NaN;
  const x = p * (s.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * f : s[i];
}

function betaOf(ra: number[], rb: number[], idx: number[]): number {
  if (idx.length < 3) return NaN;
  let ma = 0;
  let mb = 0;
  for (const i of idx) {
    ma += ra[i];
    mb += rb[i];
  }
  ma /= idx.length;
  mb /= idx.length;
  let c = 0;
  let v = 0;
  for (const i of idx) {
    c += (ra[i] - ma) * (rb[i] - mb);
    v += (rb[i] - mb) ** 2;
  }
  return v > 0 ? c / v : NaN;
}

/**
 * Greeks of a live account: its end-of-day equity (the last sample of each UTC day) against the
 * same day's close of a benchmark, over the days that have both. Days without samples (the app
 * was closed) turn into one multi-day return on both sides.
 */
export function accountGreeks(equity: ArrayLike<ArrayLike<number>>, closes: { t: number; c: number }[], rfAnnual = 0): { greeks: Greeks | null; days: number; from: number; to: number } {
  const eod = new Map<number, number>();
  for (let i = 0; i < equity.length; i++) if (equity[i][1] > 0) eod.set(Math.floor(equity[i][0] / DAY), equity[i][1]);
  const cl = new Map<number, number>();
  for (const k of closes) if (k.c > 0) cl.set(Math.floor(k.t / DAY), k.c);
  const days = [...eod.keys()].filter((d) => cl.has(d)).sort((a, b) => a - b);
  const ra: number[] = [];
  const rb: number[] = [];
  for (let k = 1; k < days.length; k++) {
    ra.push(eod.get(days[k])! / eod.get(days[k - 1])! - 1);
    rb.push(cl.get(days[k])! / cl.get(days[k - 1])! - 1);
  }
  return { greeks: computeGreeks(ra, rb, rfAnnual), days: ra.length, from: days.length ? days[0] * DAY : NaN, to: days.length ? days[days.length - 1] * DAY : NaN };
}

/** Greeks of daily strategy returns `ra` against benchmark returns `rb` (same days). */
export function computeGreeks(ra: number[], rb: number[], rfAnnual = 0): Greeks | null {
  const n = Math.min(ra.length, rb.length);
  if (n < 5) return null;
  const rf = rfAnnual / 365;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += ra[i];
    mb += rb[i];
  }
  ma /= n;
  mb /= n;
  let vaa = 0;
  let vbb = 0;
  let cab = 0;
  let md = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    vaa += da * da;
    vbb += db * db;
    cab += da * db;
    md += ra[i] - rb[i];
  }
  vaa /= n - 1;
  vbb /= n - 1;
  cab /= n - 1;
  md /= n;
  let vd = 0;
  for (let i = 0; i < n; i++) vd += (ra[i] - rb[i] - md) ** 2;
  vd /= n - 1;
  const sq = Math.sqrt(365);
  const beta = vbb > 0 ? cab / vbb : 0;
  const corr = vaa > 0 && vbb > 0 ? cab / Math.sqrt(vaa * vbb) : 0;
  const te = Math.sqrt(vd) * sq;
  // conditional on the benchmark's direction
  const up: number[] = [];
  const down: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rb[i] > 0) up.push(i);
    else if (rb[i] < 0) down.push(i);
  }
  const capture = (idx: number[]) => {
    if (!idx.length) return NaN;
    let sa = 0;
    let sb = 0;
    for (const i of idx) {
      sa += ra[i];
      sb += rb[i];
    }
    return sb !== 0 ? (sa / sb) * 100 : NaN;
  };
  // distribution of the strategy's daily returns
  const sorted = ra.slice(0, n).sort((x, y) => x - y);
  const p5 = quantileSorted(sorted, 0.05);
  const p95 = quantileSorted(sorted, 0.95);
  let tail = 0;
  let tailN = 0;
  for (const r of sorted) {
    if (r > p5) break;
    tail += r;
    tailN++;
  }
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < n; i++) {
    const d = ra[i] - ma;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
    if (ra[i] > 0) gains += ra[i];
    else losses -= ra[i];
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return {
    days: n,
    alpha: (ma - rf - beta * (mb - rf)) * 365 * 100,
    beta,
    correlation: corr,
    rSquared: corr * corr,
    sigma: Math.sqrt(vaa) * sq * 100,
    benchSigma: Math.sqrt(vbb) * sq * 100,
    trackingError: te * 100,
    informationRatio: te > 0 ? (md * 365) / te : 0,
    treynor: Math.abs(beta) > 0.01 ? ((ma - rf) * 365 * 100) / beta : NaN,
    omega: losses > 0 ? gains / losses : gains > 0 ? Infinity : NaN,
    upCapture: capture(up),
    downCapture: capture(down),
    upsideBeta: betaOf(ra, rb, up),
    downsideBeta: betaOf(ra, rb, down),
    var95: -p5 * 100,
    cvar95: tailN ? (-tail / tailN) * 100 : -p5 * 100,
    skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) - 3 : 0,
    tailRatio: p5 < 0 ? Math.abs(p95 / p5) : NaN,
  };
}

// ------------------------------------------------------------------ random counterparts

export interface RandomStats {
  returnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  profitFactor: number;
  winRate: number;
}

export interface Quantiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
}

export interface RandomModel {
  model: 'timing' | 'direction';
  iterations: number;
  strategy: RandomStats;
  random: Record<keyof RandomStats, Quantiles>;
  /** Share of random runs the strategy beats, % (drawdown: share with a deeper drawdown). Ties count half. */
  beats: Record<keyof RandomStats, number>;
  /** One-sided p-values: probability that a random run does at least as well. */
  pReturn: number;
  pSharpe: number;
  /** Histogram of random total returns (%). */
  hist: { lo: number; step: number; counts: number[] };
}

export interface RandomBenchmark {
  trades: number;
  iterations: number;
  checkpoints: number;
  /** Original trades overlap (pyramiding): random trades are placed independently. */
  overlapping: boolean;
  timing: RandomModel;
  direction: RandomModel | null;
  /** Equity as % return at display points: the strategy, random percentile bands and sample paths. */
  curves: { t: number[]; strategy: number[]; p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[]; samples: number[][] };
  verdict: { level: 'strong' | 'likely' | 'weak' | 'none' | 'worse'; title: string; text: string };
  notes: string[];
}

export interface RandomBenchmarkTrade {
  entryBar: number;
  exitBar: number;
  dir: 1 | -1;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  profit: number;
}

export interface RandomBenchmarkInput {
  t: ArrayLike<number>;
  o: ArrayLike<number>;
  c: ArrayLike<number>;
  /** Evaluated bar range [from, to]. */
  from: number;
  to: number;
  /** Closed trades plus open trades marked to the last close (open: exitBar = to, exitPrice = close). */
  trades: RandomBenchmarkTrade[];
  /** Number of `trades` (at the end of the list) that were still open at the end. */
  openCount?: number;
  /** Strategy equity per bar of [from, to] (index 0 = bar `from`). */
  equity: ArrayLike<number>;
  initialCapital: number;
  /** Cost per side for random trades (fee + slippage, fraction of notional). */
  costPerSide: number;
  iterations?: number;
  seed?: number;
  /** Most checkpoints used for marking equity. */
  maxCheckpoints?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantiles(values: Float64Array): Quantiles {
  const s = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of s) sum += v;
  return { p5: quantileSorted(s, 0.05), p25: quantileSorted(s, 0.25), p50: quantileSorted(s, 0.5), p75: quantileSorted(s, 0.75), p95: quantileSorted(s, 0.95), mean: s.length ? sum / s.length : NaN };
}

/** Share of `values` that `x` beats (higher is better unless `lowerBetter`), ties count half, %. */
function beatShare(values: Float64Array, x: number, lowerBetter = false): number {
  let b = 0;
  for (const v of values) {
    if (v === x || (!Number.isFinite(v) && !Number.isFinite(x))) b += 0.5;
    else if (lowerBetter ? x < v : x > v) b += 1;
  }
  return values.length ? (b / values.length) * 100 : NaN;
}

function pAtLeast(values: Float64Array, x: number): number {
  let k = 0;
  for (const v of values) if (v >= x) k++;
  return (k + 1) / (values.length + 1);
}

/**
 * Walks checkpoints and trade events of one run. Trades are given as parallel arrays sorted
 * by entry bar; open positions are linear in price (A·close + B), so marking costs O(open).
 */
class Marker {
  // per-checkpoint scratch
  readonly eq: Float64Array;
  constructor(
    readonly cb: Int32Array,
    readonly close: ArrayLike<number>,
    readonly init: number,
    readonly periodsPerYear: number,
  ) {
    this.eq = new Float64Array(cb.length);
  }

  /**
   * entry[k], exit[k]: bars; A[k], B[k]: unrealised = A·close + B while open; R[k]: realised P&L.
   * `order` lists trade indices by exit bar (for removal). Returns stats; equity stays in `eq`.
   */
  run(n: number, entry: Int32Array, exit: Int32Array, A: Float64Array, B: Float64Array, R: Float64Array, exitOrder: Int32Array): RandomStats {
    const cb = this.cb;
    const close = this.close;
    let realized = 0;
    let sumA = 0;
    let sumB = 0;
    let ei = 0; // next entry (trades sorted by entry)
    let xi = 0; // next exit in exit order
    let gp = 0;
    let gl = 0;
    let wins = 0;
    let peak = this.init;
    let mdd = 0;
    let prev = this.init;
    let s1 = 0;
    let s2 = 0;
    for (let j = 0; j < cb.length; j++) {
      const bar = cb[j];
      while (ei < n && entry[ei] <= bar) {
        sumA += A[ei];
        sumB += B[ei];
        ei++;
      }
      while (xi < n && exit[exitOrder[xi]] <= bar) {
        const k = exitOrder[xi];
        // an exit can only come after its entry was added (exit >= entry)
        sumA -= A[k];
        sumB -= B[k];
        const r = R[k];
        realized += r;
        if (r > 0) {
          gp += r;
          wins++;
        } else gl -= r;
        xi++;
      }
      const e = this.init + realized + sumA * close[bar] + sumB;
      this.eq[j] = e;
      if (e > peak) peak = e;
      if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak);
      if (j > 0) {
        const r = prev > 0 ? e / prev - 1 : 0;
        s1 += r;
        s2 += r * r;
      }
      prev = e;
    }
    const m = cb.length - 1;
    const mean = m > 0 ? s1 / m : 0;
    const sd = m > 1 ? Math.sqrt(Math.max(0, (s2 - m * mean * mean) / (m - 1))) : 0;
    const final = this.eq[cb.length - 1];
    return {
      returnPct: (final / this.init - 1) * 100,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(this.periodsPerYear) : 0,
      maxDrawdownPct: mdd * 100,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
      winRate: n ? (wins / n) * 100 : 0,
    };
  }
}

/**
 * The strategy against random counterparts. Random trades enter and exit at bar opens (as a
 * market-order strategy would) and pay `costPerSide` on both sides; the strategy keeps its
 * real fills. Every random run makes as many trades as the strategy, with the same holding
 * times, notional sizes and directions (timing model) or at the same times with coin-flip
 * directions (direction model).
 */
export function randomBenchmark(inp: RandomBenchmarkInput): RandomBenchmark | null {
  const { o, c, t, from, to } = inp;
  const trades = inp.trades.filter((x) => x.entryBar >= from && x.entryBar <= to && x.qty > 0 && x.entryPrice > 0);
  const K = trades.length;
  const span = to - from;
  if (K < 1 || span < 2) return null;
  const init = inp.initialCapital;
  const cost = Math.max(0, inp.costPerSide);
  // checkpoints: evenly spaced bars of [from, to], always including both ends
  const J = Math.max(2, Math.min(inp.maxCheckpoints ?? 1500, span + 1));
  const cb = new Int32Array(J);
  for (let j = 0; j < J; j++) cb[j] = Math.round(from + (j * span) / (J - 1));
  const periodMs = (t[to] - t[from]) / (J - 1);
  const periodsPerYear = periodMs > 0 ? (365 * DAY) / periodMs : 365;
  // iterations: keep the work bounded for very long tests
  const iterations = Math.max(200, Math.min(inp.iterations ?? 1000, Math.floor(6e6 / (K + J))));
  const rand = mulberry32(inp.seed ?? 7);
  const marker = new Marker(cb, c, init, periodsPerYear);

  // ---- the strategy itself, on the same checkpoints
  const eqAt = (bar: number) => {
    const k = bar - from;
    for (let i = k; i >= 0; i--) if (Number.isFinite(inp.equity[i])) return inp.equity[i];
    return init;
  };
  let peak = init;
  let mdd = 0;
  let s1 = 0;
  let s2 = 0;
  let prev = init;
  const stratEq = new Float64Array(J);
  for (let j = 0; j < J; j++) {
    const e = eqAt(cb[j]);
    stratEq[j] = e;
    if (e > peak) peak = e;
    if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak);
    if (j > 0) {
      const r = prev > 0 ? e / prev - 1 : 0;
      s1 += r;
      s2 += r * r;
    }
    prev = e;
  }
  const closed = trades.slice(0, K - (inp.openCount ?? 0));
  let sgp = 0;
  let sgl = 0;
  let swins = 0;
  for (const x of closed) {
    if (x.profit > 0) {
      sgp += x.profit;
      swins++;
    } else sgl -= x.profit;
  }
  const sm = J - 1;
  const smean = s1 / sm;
  const ssd = sm > 1 ? Math.sqrt(Math.max(0, (s2 - sm * smean * smean) / (sm - 1))) : 0;
  const strategy: RandomStats = {
    returnPct: (stratEq[J - 1] / init - 1) * 100,
    sharpe: ssd > 0 ? (smean / ssd) * Math.sqrt(periodsPerYear) : 0,
    maxDrawdownPct: mdd * 100,
    profitFactor: sgl > 0 ? sgp / sgl : sgp > 0 ? Infinity : 0,
    winRate: closed.length ? (swins / closed.length) * 100 : 0,
  };

  // ---- trade shapes
  const hold = new Int32Array(K);
  const dirs = new Int8Array(K);
  const notional = new Float64Array(K);
  let longs = 0;
  for (let k = 0; k < K; k++) {
    const x = trades[k];
    hold[k] = Math.max(0, Math.min(span, x.exitBar - x.entryBar));
    dirs[k] = x.dir;
    notional[k] = x.qty * x.entryPrice;
    if (x.dir === 1) longs++;
  }
  // do the strategy's trades overlap (pyramiding / several positions)?
  const byEntry = trades.map((x, i) => i).sort((a, b) => trades[a].entryBar - trades[b].entryBar);
  let overlapping = false;
  for (let i = 1; i < byEntry.length; i++) if (trades[byEntry[i]].entryBar < trades[byEntry[i - 1]].exitBar) overlapping = true;
  let totalHold = 0;
  for (let k = 0; k < K; k++) totalHold += hold[k];
  if (!overlapping && totalHold > span) overlapping = true;

  // per-iteration scratch
  const entry = new Int32Array(K);
  const exit = new Int32Array(K);
  const A = new Float64Array(K);
  const B = new Float64Array(K);
  const R = new Float64Array(K);
  const exitOrder = new Int32Array(K);
  const perm = new Int32Array(K);
  const D = Math.min(J, 300);
  const dIdx = new Int32Array(D);
  for (let d = 0; d < D; d++) dIdx[d] = Math.round((d * (J - 1)) / (D - 1));
  const SAMPLES = 24;
  const ex = new Float64Array(K + 1);
  const tmpE = new Int32Array(K);
  const ord: number[] = Array.from({ length: K }, (_, s) => s);

  const fillTrade = (slot: number, k: number, e: number, dir: number, entryPx?: number, exitPx?: number) => {
    const x = Math.min(to, e + hold[k]);
    const P = entryPx ?? o[e];
    // exits at the open of the exit bar; same-bar trades and trades reaching the end use the close
    const X = exitPx ?? (x > e && x < to ? o[x] : c[x]);
    const N = notional[k];
    entry[slot] = e;
    exit[slot] = x;
    A[slot] = (N * dir) / P;
    B[slot] = -N * dir - N * cost;
    R[slot] = N * dir * (X / P - 1) - N * cost - N * (X / P) * cost;
  };

  const runModel = (model: 'timing' | 'direction', collectCurves: boolean) => {
    const ret = new Float64Array(iterations);
    const sh = new Float64Array(iterations);
    const dd = new Float64Array(iterations);
    const pf = new Float64Array(iterations);
    const wr = new Float64Array(iterations);
    const curveVals = collectCurves ? new Float32Array(iterations * D) : null;
    const samples: number[][] = [];
    // the direction model keeps the strategy's own bars and prices
    const dirOrder = byEntry;
    for (let it = 0; it < iterations; it++) {
      if (model === 'timing') {
        for (let k = 0; k < K; k++) perm[k] = k;
        for (let k = K - 1; k > 0; k--) {
          const r = Math.floor(rand() * (k + 1));
          const tmp = perm[k];
          perm[k] = perm[r];
          perm[r] = tmp;
        }
        if (!overlapping) {
          // uniform random non-overlapping arrangement: sorted uniform gap cuts via exponential spacings
          const free = span - totalHold;
          let total = 0;
          for (let k = 0; k <= K; k++) {
            ex[k] = -Math.log(1 - rand());
            total += ex[k];
          }
          let acc = 0;
          let pos = from;
          let prevCut = 0;
          for (let s = 0; s < K; s++) {
            acc += ex[s];
            const cut = Math.min(free, Math.floor((acc / total) * (free + 1)));
            pos += cut - prevCut;
            prevCut = cut;
            const k = perm[s];
            fillTrade(s, k, pos, dirs[k]);
            pos += hold[k];
          }
        } else {
          // independent placement; sort slots by entry afterwards
          for (let s = 0; s < K; s++) tmpE[s] = from + Math.floor(rand() * (span - Math.min(span - 1, hold[perm[s]]) + 1));
          for (let s = 0; s < K; s++) ord[s] = s;
          ord.sort((a, b) => tmpE[a] - tmpE[b]);
          for (let s = 0; s < K; s++) {
            const k = perm[ord[s]];
            fillTrade(s, k, tmpE[ord[s]], dirs[k]);
          }
        }
      } else {
        for (let s = 0; s < K; s++) {
          const k = dirOrder[s];
          const x = trades[k];
          const dir = rand() < 0.5 ? 1 : -1;
          fillTrade(s, k, x.entryBar, dir, x.entryPrice, x.exitPrice);
          exit[s] = Math.min(to, Math.max(x.entryBar, x.exitBar));
        }
      }
      // exits in time order
      for (let s = 0; s < K; s++) exitOrder[s] = s;
      if (model === 'timing' && !overlapping) {
        // already sorted by entry and non-overlapping, so exits are sorted too
      } else exitOrder.sort((a, b) => exit[a] - exit[b]);
      const st = marker.run(K, entry, exit, A, B, R, exitOrder);
      ret[it] = st.returnPct;
      sh[it] = st.sharpe;
      dd[it] = st.maxDrawdownPct;
      pf[it] = st.profitFactor;
      wr[it] = st.winRate;
      if (curveVals) {
        for (let d = 0; d < D; d++) curveVals[it * D + d] = (marker.eq[dIdx[d]] / init - 1) * 100;
        if (samples.length < SAMPLES) samples.push(Array.from(dIdx, (j) => +((marker.eq[j] / init - 1) * 100).toFixed(2)));
      }
    }
    // histogram of returns
    const sortedRet = Float64Array.from(ret).sort();
    let lo = Math.min(quantileSorted(sortedRet, 0.005), strategy.returnPct);
    let hi = Math.max(quantileSorted(sortedRet, 0.995), strategy.returnPct);
    if (!(hi > lo)) {
      hi = lo + 1;
      lo -= 1;
    }
    const bins = 40;
    const step = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of ret) counts[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / step)))]++;
    const res: RandomModel = {
      model,
      iterations,
      strategy,
      random: { returnPct: quantiles(ret), sharpe: quantiles(sh), maxDrawdownPct: quantiles(dd), profitFactor: quantiles(pf.map((v) => (Number.isFinite(v) ? v : 99))), winRate: quantiles(wr) },
      beats: {
        returnPct: beatShare(ret, strategy.returnPct),
        sharpe: beatShare(sh, strategy.sharpe),
        maxDrawdownPct: beatShare(dd, strategy.maxDrawdownPct, true),
        profitFactor: beatShare(pf, strategy.profitFactor),
        winRate: beatShare(wr, strategy.winRate),
      },
      pReturn: pAtLeast(ret, strategy.returnPct),
      pSharpe: pAtLeast(sh, strategy.sharpe),
      hist: { lo, step, counts },
    };
    return { res, curveVals, samples };
  };

  const timing = runModel('timing', true);
  const bothSides = longs >= Math.max(1, K * 0.1) && K - longs >= Math.max(1, K * 0.1);
  const direction = bothSides ? runModel('direction', false).res : null;

  // percentile bands per display point
  const band = { p5: [] as number[], p25: [] as number[], p50: [] as number[], p75: [] as number[], p95: [] as number[] };
  const col = new Float64Array(iterations);
  for (let d = 0; d < D; d++) {
    for (let it = 0; it < iterations; it++) col[it] = timing.curveVals![it * D + d];
    col.sort();
    band.p5.push(+quantileSorted(col, 0.05).toFixed(2));
    band.p25.push(+quantileSorted(col, 0.25).toFixed(2));
    band.p50.push(+quantileSorted(col, 0.5).toFixed(2));
    band.p75.push(+quantileSorted(col, 0.75).toFixed(2));
    band.p95.push(+quantileSorted(col, 0.95).toFixed(2));
  }
  const curves = {
    t: Array.from(dIdx, (j) => t[cb[j]]),
    strategy: Array.from(dIdx, (j) => +((stratEq[j] / init - 1) * 100).toFixed(2)),
    ...band,
    samples: timing.samples,
  };

  // verdict (timing model)
  const tm = timing.res;
  const pct = (v: number) => `${v.toFixed(v >= 99.5 || v <= 0.5 ? 1 : 0)}%`;
  let level: RandomBenchmark['verdict']['level'];
  let title: string;
  if (tm.pReturn < 0.01 && tm.pSharpe < 0.05) {
    level = 'strong';
    title = 'Clearly better than random';
  } else if (tm.pReturn < 0.05) {
    level = 'likely';
    title = 'Probably better than random';
  } else if (tm.beats.returnPct < 50) {
    level = 'worse';
    title = 'Worse than a typical random twin';
  } else if (tm.pReturn < 0.2) {
    level = 'weak';
    title = 'Weak evidence of an edge';
  } else {
    level = 'none';
    title = 'Not distinguishable from random';
  }
  const text =
    `The strategy beats ${pct(tm.beats.returnPct)} of ${tm.iterations.toLocaleString('en-US')} random twins on return and ${pct(tm.beats.sharpe)} on Sharpe ` +
    `(p = ${tm.pReturn.toFixed(3)} and ${tm.pSharpe.toFixed(3)}). Each twin makes ${K} trades with the same holding times, sizes, direction mix and costs at random times.` +
    (direction ? ` With coin-flip directions at the strategy's own entry and exit times it beats ${pct(direction.beats.returnPct)} (p = ${direction.pReturn.toFixed(3)}).` : '');
  const notes: string[] = [];
  if (K < 30) notes.push(`Only ${K} trades: the comparison is noisy; a longer test gives a clearer answer.`);
  if (!direction) notes.push(longs === K ? 'The direction test needs long and short trades; this strategy only goes long.' : longs === 0 ? 'The direction test needs long and short trades; this strategy only goes short.' : 'The direction test is skipped: one direction has fewer than 10% of the trades.');
  if (overlapping) notes.push('The strategy holds several positions at once, so random trades are placed independently (they may overlap too).');
  notes.push(`Random twins enter and exit at bar opens and pay ${(cost * 100).toFixed(3)}% per side; the strategy keeps its real fills (limit and stop prices).`);
  if (inp.openCount) notes.push(`${inp.openCount} open trade${inp.openCount > 1 ? 's are' : ' is'} marked to the last close.`);
  return { trades: K, iterations, checkpoints: J, overlapping, timing: tm, direction, curves, verdict: { level, title, text }, notes };
}

// ------------------------------------------------------------------ trade-order Monte Carlo

export interface TradeMonteCarlo {
  trades: number;
  iterations: number;
  /** The same trades in random order: the result is fixed, the path (drawdown) changes. */
  shuffled: { maxDrawdownPct: Quantiles };
  /** As many trades drawn with replacement from the strategy's trades: return and drawdown ranges. */
  resampled: { returnPct: Quantiles; maxDrawdownPct: Quantiles; probLossPct: number };
  /** Share of resampled runs whose drawdown exceeds 10 / 20 / 30 / 50 %. */
  ddOver: { level: number; pct: number }[];
  /** The backtest's own closed-trade drawdown, for comparison. */
  actualMaxDrawdownPct: number;
}

/**
 * Monte Carlo of the trade sequence. Each trade's P&L is taken relative to the equity before it,
 * so position sizing carries over; runs compound these returns.
 */
export function tradeMonteCarlo(returns: number[], iterations = 2000, seed = 11): TradeMonteCarlo | null {
  const n = returns.length;
  if (n < 5) return null;
  const rand = mulberry32(seed);
  const path = (seq: ArrayLike<number>) => {
    let eq = 1;
    let peak = 1;
    let mdd = 0;
    for (let k = 0; k < seq.length; k++) {
      eq *= 1 + seq[k];
      if (eq > peak) peak = eq;
      if (peak > 0) mdd = Math.max(mdd, (peak - eq) / peak);
    }
    return { ret: (eq - 1) * 100, dd: mdd * 100 };
  };
  const actual = path(returns);
  const shufDd = new Float64Array(iterations);
  const resRet = new Float64Array(iterations);
  const resDd = new Float64Array(iterations);
  const seq = Float64Array.from(returns);
  const draw = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let k = n - 1; k > 0; k--) {
      const r = Math.floor(rand() * (k + 1));
      const t = seq[k];
      seq[k] = seq[r];
      seq[r] = t;
    }
    shufDd[it] = path(seq).dd;
    for (let k = 0; k < n; k++) draw[k] = returns[Math.floor(rand() * n)];
    const p = path(draw);
    resRet[it] = p.ret;
    resDd[it] = p.dd;
  }
  let losses = 0;
  for (const v of resRet) if (v < 0) losses++;
  return {
    trades: n,
    iterations,
    shuffled: { maxDrawdownPct: quantiles(shufDd) },
    resampled: { returnPct: quantiles(resRet), maxDrawdownPct: quantiles(resDd), probLossPct: (losses / iterations) * 100 },
    ddOver: [10, 20, 30, 50].map((level) => ({ level, pct: (resDd.filter((d) => d > level).length / iterations) * 100 })),
    actualMaxDrawdownPct: actual.dd,
  };
}
