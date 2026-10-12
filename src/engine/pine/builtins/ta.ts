/**
 * Technical analysis built-ins (ta.*), implemented from TradingView's documented definitions.
 * Every function is stateful per call site (`st`) and sees source values once per execution,
 * matching Pine semantics for conditional calls. Window functions return na until `length`
 * values are available.
 */
import type { Runtime, Series } from '../runtime';

type St = any;
const NA = NaN;
const isNa = (x: number) => x !== x;

function src(st: St, rt: Runtime, key: string, v: number): Series {
  let s: Series = st[key];
  if (!s) s = st[key] = rt.newSeries();
  s.push(v);
  return s;
}

function len(n: number): number {
  const v = Math.floor(n);
  return v > 0 ? v : 1;
}

/** Window values (oldest..newest) of the last n values. */
function windowOf(s: Series, n: number): number[] | null {
  if (s.n < n) return null;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = s.a[s.n - n + k];
  return out;
}

// ---------------------------------------------------------------- moving averages

export function sma(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  // running sum with NaN tracking; exact recompute periodically to avoid drift
  if (st.L !== L) {
    st.L = L;
    st.sum = 0;
    st.nan = 0;
    st.cnt = 0;
    for (let k = Math.max(0, s.n - L); k < s.n; k++) {
      const v = s.a[k];
      if (isNa(v)) st.nan++;
      else st.sum += v;
    }
  } else {
    if (isNa(x)) st.nan++;
    else st.sum += x;
    if (s.n > L) {
      const out = s.a[s.n - 1 - L];
      if (isNa(out)) st.nan--;
      else st.sum -= out;
    }
    if (++st.cnt >= 2000) st.L = -1; // force exact recompute next time
  }
  if (s.n < L || st.nan > 0) return NA;
  return st.sum / L;
}

function emaCore(st: St, rt: Runtime, x: number, length: number, alpha: number): number {
  const L = len(length);
  if (st.v === undefined) {
    st.v = NaN;
    st.seed = 0;
    st.seedN = 0;
  }
  if (isNa(x)) return st.v;
  if (isNa(st.v)) {
    st.seed += x;
    st.seedN++;
    if (st.seedN >= L) {
      st.v = st.seed / L;
      return st.v;
    }
    return NA;
  }
  st.v = alpha * x + (1 - alpha) * st.v;
  return st.v;
}

export function ema(st: St, rt: Runtime, x: number, length: number): number {
  return emaCore(st, rt, x, length, 2 / (len(length) + 1));
}

export function rma(st: St, rt: Runtime, x: number, length: number): number {
  return emaCore(st, rt, x, length, 1 / len(length));
}

export function wma(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let num = 0;
  let den = 0;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (isNa(v)) return NA;
    const w = L - k;
    num += v * w;
    den += w;
  }
  return num / den;
}

export function vwma(st: St, rt: Runtime, x: number, length: number): number {
  st.a ??= {};
  st.b ??= {};
  const v = rt.d.v[rt.i];
  const n = sma(st.a, rt, x * v, length);
  const d = sma(st.b, rt, v, length);
  return d ? n / d : NA;
}

export function swma(st: St, rt: Runtime, x: number): number {
  const s = src(st, rt, 's', x);
  if (s.n < 4) return NA;
  return (s.get(3) + 2 * s.get(2) + 2 * s.get(1) + s.get(0)) / 6;
}

export function hma(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  st.a ??= {};
  st.b ??= {};
  st.c ??= {};
  const half = wma(st.a, rt, x, Math.floor(L / 2));
  const full = wma(st.b, rt, x, L);
  return wma(st.c, rt, 2 * half - full, Math.floor(Math.sqrt(L)));
}

export function alma(st: St, rt: Runtime, x: number, length: number, offset: number, sigma: number, floor = false): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  const m = floor ? Math.floor(offset * (L - 1)) : offset * (L - 1);
  const sd = L / sigma;
  let norm = 0;
  let sum = 0;
  for (let k = 0; k < L; k++) {
    const w = Math.exp(-((k - m) * (k - m)) / (2 * sd * sd));
    norm += w;
    sum += s.get(L - 1 - k) * w;
  }
  return sum / norm;
}

export function linreg(st: St, rt: Runtime, x: number, length: number, offset: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < L; k++) {
    const y = s.a[s.n - L + k];
    if (isNa(y)) return NA;
    sx += k;
    sy += y;
    sxy += k * y;
    sxx += k * k;
  }
  const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx);
  const intercept = (sy - slope * sx) / L;
  return intercept + slope * (L - 1 - offset);
}

// ---------------------------------------------------------------- statistics

export function variance(st: St, rt: Runtime, x: number, length: number, biased = true): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  const w = windowOf(s, L);
  if (!w) return NA;
  let mean = 0;
  for (const v of w) {
    if (isNa(v)) return NA;
    mean += v;
  }
  mean /= L;
  let ss = 0;
  for (const v of w) ss += (v - mean) * (v - mean);
  return ss / (biased ? L : Math.max(1, L - 1));
}

export function stdev(st: St, rt: Runtime, x: number, length: number, biased = true): number {
  const v = variance(st, rt, x, length, biased);
  return v >= 0 ? Math.sqrt(v) : NA;
}

export function dev(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  const w = windowOf(s, L);
  if (!w) return NA;
  const mean = w.reduce((a, b) => a + b, 0) / L;
  return w.reduce((a, b) => a + Math.abs(b - mean), 0) / L;
}

export function median(st: St, rt: Runtime, x: number, length: number): number {
  const w = windowOf(src(st, rt, 's', x), len(length));
  if (!w || w.some(isNa)) return NA;
  w.sort((a, b) => a - b);
  const m = w.length >> 1;
  return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
}

export function mode(st: St, rt: Runtime, x: number, length: number): number {
  const w = windowOf(src(st, rt, 's', x), len(length));
  if (!w) return NA;
  const cnt = new Map<number, number>();
  let best = NA;
  let bc = 0;
  for (const v of w) {
    if (isNa(v)) continue;
    const c = (cnt.get(v) || 0) + 1;
    cnt.set(v, c);
    if (c > bc || (c === bc && v < best)) {
      bc = c;
      best = v;
    }
  }
  return best;
}

export function percentrank(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L + 1) return NA;
  let c = 0;
  for (let k = 1; k <= L; k++) if (s.get(k) <= x) c++;
  return (c / L) * 100;
}

export function percentileLinear(st: St, rt: Runtime, x: number, length: number, pct: number): number {
  const w = windowOf(src(st, rt, 's', x), len(length));
  if (!w || w.some(isNa)) return NA;
  w.sort((a, b) => a - b);
  const pos = (pct / 100) * (w.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return w[lo] + (w[hi] - w[lo]) * (pos - lo);
}

export function percentileNearest(st: St, rt: Runtime, x: number, length: number, pct: number): number {
  const w = windowOf(src(st, rt, 's', x), len(length));
  if (!w || w.some(isNa)) return NA;
  w.sort((a, b) => a - b);
  const r = Math.max(1, Math.ceil((pct / 100) * w.length));
  return w[r - 1];
}

export function correlation(st: St, rt: Runtime, a: number, b: number, length: number): number {
  const L = len(length);
  const sa = src(st, rt, 'a', a);
  const sb = src(st, rt, 'b', b);
  if (sa.n < L) return NA;
  let ma = 0;
  let mb = 0;
  for (let k = 0; k < L; k++) {
    ma += sa.get(k);
    mb += sb.get(k);
  }
  ma /= L;
  mb /= L;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let k = 0; k < L; k++) {
    const da = sa.get(k) - ma;
    const db = sb.get(k) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : NA;
}

// ---------------------------------------------------------------- highest / lowest

export function highest(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let m = -Infinity;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (v > m) m = v;
  }
  return m === -Infinity ? NA : m;
}

export function lowest(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let m = Infinity;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (v < m) m = v;
  }
  return m === Infinity ? NA : m;
}

export function highestbars(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let m = -Infinity;
  let at = 0;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (v > m) {
      m = v;
      at = k;
    }
  }
  return -at;
}

export function lowestbars(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let m = Infinity;
  let at = 0;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (v < m) {
      m = v;
      at = k;
    }
  }
  return -at;
}

export function range(st: St, rt: Runtime, x: number, length: number): number {
  st.h ??= {};
  st.l ??= {};
  return highest(st.h, rt, x, length) - lowest(st.l, rt, x, length);
}

export function max(st: St, _rt: Runtime, x: number): number {
  if (!isNa(x) && (st.m === undefined || x > st.m)) st.m = x;
  return st.m ?? NA;
}

export function min(st: St, _rt: Runtime, x: number): number {
  if (!isNa(x) && (st.m === undefined || x < st.m)) st.m = x;
  return st.m ?? NA;
}

// ---------------------------------------------------------------- momentum / oscillators

export function change(st: St, rt: Runtime, x: number, length = 1): number {
  const s = src(st, rt, 's', x);
  return x - s.get(len(length));
}

export function roc(st: St, rt: Runtime, x: number, length: number): number {
  const s = src(st, rt, 's', x);
  const p = s.get(len(length));
  return p ? (100 * (x - p)) / p : NA;
}

export function rsi(st: St, rt: Runtime, x: number, length: number): number {
  const prev = st.prev ?? NaN;
  st.prev = x;
  const u = isNa(prev) ? NaN : Math.max(x - prev, 0);
  const d = isNa(prev) ? NaN : Math.max(prev - x, 0);
  st.u ??= {};
  st.d ??= {};
  const ru = rma(st.u, rt, u, length);
  const rd = rma(st.d, rt, d, length);
  if (isNa(ru) || isNa(rd)) return NA;
  if (rd === 0) return ru === 0 ? 50 : 100;
  if (ru === 0) return 0;
  return 100 - 100 / (1 + ru / rd);
}

export function macd(st: St, rt: Runtime, x: number, fast: number, slow: number, sig: number): [number, number, number] {
  st.f ??= {};
  st.s ??= {};
  st.g ??= {};
  const m = ema(st.f, rt, x, fast) - ema(st.s, rt, x, slow);
  const signal = ema(st.g, rt, m, sig);
  return [m, signal, m - signal];
}

export function stoch(st: St, rt: Runtime, x: number, high: number, low: number, length: number): number {
  st.h ??= {};
  st.l ??= {};
  const hh = highest(st.h, rt, high, length);
  const ll = lowest(st.l, rt, low, length);
  return hh - ll ? (100 * (x - ll)) / (hh - ll) : NA;
}

export function cci(st: St, rt: Runtime, x: number, length: number): number {
  st.m ??= {};
  st.d ??= {};
  const ma = sma(st.m, rt, x, length);
  const md = dev(st.d, rt, x, length);
  return md ? (x - ma) / (0.015 * md) : NA;
}

export function cmo(st: St, rt: Runtime, x: number, length: number): number {
  const prev = st.prev ?? NaN;
  st.prev = x;
  const m = isNa(prev) ? NaN : x - prev;
  st.u ??= {};
  st.d ??= {};
  const su = sumN(st.u, rt, m >= 0 ? m : 0, length);
  const sd = sumN(st.d, rt, m >= 0 ? 0 : -m, length);
  return su + sd ? (100 * (su - sd)) / (su + sd) : NA;
}

export function mfi(st: St, rt: Runtime, x: number, length: number): number {
  const prev = st.prev ?? NaN;
  st.prev = x;
  const ch = isNa(prev) ? NaN : x - prev;
  const vol = rt.d.v[rt.i];
  st.u ??= {};
  st.l ??= {};
  const upper = sumN(st.u, rt, vol * (ch <= 0 ? 0 : x), length);
  const lower = sumN(st.l, rt, vol * (ch >= 0 ? 0 : x), length);
  if (isNa(upper) || isNa(lower)) return NA;
  return lower === 0 ? 100 : 100 - 100 / (1 + upper / lower);
}

export function wpr(st: St, rt: Runtime, length: number): number {
  st.h ??= {};
  st.l ??= {};
  const hh = highest(st.h, rt, rt.d.h[rt.i], length);
  const ll = lowest(st.l, rt, rt.d.l[rt.i], length);
  return hh - ll ? (100 * (rt.d.c[rt.i] - hh)) / (hh - ll) : NA;
}

export function tsi(st: St, rt: Runtime, x: number, short: number, long: number): number {
  const prev = st.prev ?? NaN;
  st.prev = x;
  const pc = isNa(prev) ? NaN : x - prev;
  st.a ??= {};
  st.b ??= {};
  st.c ??= {};
  st.d ??= {};
  const num = ema(st.b, rt, ema(st.a, rt, pc, long), short);
  const den = ema(st.d, rt, ema(st.c, rt, Math.abs(pc), long), short);
  return den ? num / den : NA;
}

export function cog(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let num = 0;
  let den = 0;
  for (let k = 0; k < L; k++) {
    const v = s.get(k);
    num += v * (k + 1);
    den += v;
  }
  return den ? -num / den : NA;
}

/** rolling sum (math.sum) */
export function sumN(st: St, rt: Runtime, x: number, length: number): number {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n < L) return NA;
  let sum = 0;
  for (let k = 0; k < L; k++) {
    const v = s.a[s.n - 1 - k];
    if (isNa(v)) return NA;
    sum += v;
  }
  return sum;
}

// ---------------------------------------------------------------- volatility & bands

export function tr(rt: Runtime, handleNa = false): number {
  const i = rt.i;
  const h = rt.d.h[i];
  const l = rt.d.l[i];
  if (i === 0) return handleNa ? h - l : NA;
  const pc = rt.d.c[i - 1];
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

export function atr(st: St, rt: Runtime, length: number): number {
  return rma(st, rt, tr(rt, true), length);
}

export function bb(st: St, rt: Runtime, x: number, length: number, mult: number): [number, number, number] {
  st.m ??= {};
  st.s ??= {};
  const basis = sma(st.m, rt, x, length);
  const dv = mult * stdev(st.s, rt, x, length);
  return [basis, basis + dv, basis - dv];
}

export function bbw(st: St, rt: Runtime, x: number, length: number, mult: number): number {
  const [b, u, l] = bb(st, rt, x, length, mult);
  return b ? ((u - l) / b) * 100 : NA;
}

export function kc(st: St, rt: Runtime, x: number, length: number, mult: number, useTr = true): [number, number, number] {
  st.m ??= {};
  st.r ??= {};
  const basis = ema(st.m, rt, x, length);
  const rng = useTr ? tr(rt, true) : rt.d.h[rt.i] - rt.d.l[rt.i];
  const rangeMa = ema(st.r, rt, rng, length);
  return [basis, basis + rangeMa * mult, basis - rangeMa * mult];
}

export function kcw(st: St, rt: Runtime, x: number, length: number, mult: number, useTr = true): number {
  const [b, u, l] = kc(st, rt, x, length, mult, useTr);
  return b ? (u - l) / b : NA;
}

export function supertrend(st: St, rt: Runtime, factor: number, atrPeriod: number): [number, number] {
  const i = rt.i;
  const hl2 = (rt.d.h[i] + rt.d.l[i]) / 2;
  st.a ??= {};
  const prevAtr = st.lastAtr ?? NaN;
  const a = atr(st.a, rt, atrPeriod);
  st.lastAtr = a;
  let upper = hl2 + factor * a;
  let lower = hl2 - factor * a;
  const pl = isNa(st.pl ?? NaN) ? 0 : st.pl;
  const pu = isNa(st.pu ?? NaN) ? 0 : st.pu;
  const pc = i > 0 ? rt.d.c[i - 1] : NaN;
  lower = lower > pl || pc < pl ? lower : pl;
  upper = upper < pu || pc > pu ? upper : pu;
  let dir: number;
  const prevSt = st.st ?? NaN;
  if (isNa(prevAtr)) dir = 1;
  else if (prevSt === st.pu) dir = rt.d.c[i] > upper ? -1 : 1;
  else dir = rt.d.c[i] < lower ? 1 : -1;
  const value = dir === -1 ? lower : upper;
  st.pl = lower;
  st.pu = upper;
  st.st = value;
  return [value, dir];
}

export function dmi(st: St, rt: Runtime, diLength: number, adxSmoothing: number): [number, number, number] {
  const i = rt.i;
  const up = i > 0 ? rt.d.h[i] - rt.d.h[i - 1] : NaN;
  const down = i > 0 ? -(rt.d.l[i] - rt.d.l[i - 1]) : NaN;
  const plusDM = isNa(up) ? NaN : up > down && up > 0 ? up : 0;
  const minusDM = isNa(down) ? NaN : down > up && down > 0 ? down : 0;
  st.t ??= {};
  st.p ??= {};
  st.m ??= {};
  st.x ??= {};
  const trur = rma(st.t, rt, tr(rt, false), diLength);
  let plus = (100 * rma(st.p, rt, plusDM, diLength)) / trur;
  let minus = (100 * rma(st.m, rt, minusDM, diLength)) / trur;
  if (isNa(plus)) plus = st.lp ?? NaN;
  else st.lp = plus;
  if (isNa(minus)) minus = st.lm ?? NaN;
  else st.lm = minus;
  const sum = plus + minus;
  const adx = 100 * rma(st.x, rt, Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxSmoothing);
  return [plus, minus, adx];
}

export function sar(st: St, rt: Runtime, start: number, inc: number, maximum: number): number {
  const i = rt.i;
  const h = rt.d.h[i];
  const l = rt.d.l[i];
  if (st.init === undefined) {
    st.init = 1;
    st.bar = 0;
  }
  st.bar++;
  if (st.bar === 1) {
    st.prevH = h;
    st.prevL = l;
    st.prevC = rt.d.c[i];
    return NA;
  }
  if (st.bar === 2) {
    st.long = rt.d.c[i] > st.prevC;
    st.af = start;
    st.ep = st.long ? Math.max(h, st.prevH) : Math.min(l, st.prevL);
    st.sar = st.long ? Math.min(l, st.prevL) : Math.max(h, st.prevH);
    st.prevH2 = st.prevH;
    st.prevL2 = st.prevL;
    st.prevH = h;
    st.prevL = l;
    return st.sar;
  }
  let sarv = st.sar + st.af * (st.ep - st.sar);
  if (st.long) {
    sarv = Math.min(sarv, st.prevL, st.prevL2);
    if (l < sarv) {
      st.long = false;
      sarv = st.ep;
      st.ep = l;
      st.af = start;
    } else if (h > st.ep) {
      st.ep = h;
      st.af = Math.min(maximum, st.af + inc);
    }
  } else {
    sarv = Math.max(sarv, st.prevH, st.prevH2);
    if (h > sarv) {
      st.long = true;
      sarv = st.ep;
      st.ep = h;
      st.af = start;
    } else if (l < st.ep) {
      st.ep = l;
      st.af = Math.min(maximum, st.af + inc);
    }
  }
  st.sar = sarv;
  st.prevH2 = st.prevH;
  st.prevL2 = st.prevL;
  st.prevH = h;
  st.prevL = l;
  return sarv;
}

// ---------------------------------------------------------------- conditions & events

export function crossover(st: St, _rt: Runtime, a: number, b: number): boolean {
  const pa = st.pa ?? NaN;
  const pb = st.pb ?? NaN;
  st.pa = a;
  st.pb = b;
  return a > b && pa <= pb;
}

export function crossunder(st: St, _rt: Runtime, a: number, b: number): boolean {
  const pa = st.pa ?? NaN;
  const pb = st.pb ?? NaN;
  st.pa = a;
  st.pb = b;
  return a < b && pa >= pb;
}

export function cross(st: St, _rt: Runtime, a: number, b: number): boolean {
  const pa = st.pa ?? NaN;
  const pb = st.pb ?? NaN;
  st.pa = a;
  st.pb = b;
  return (a > b && pa <= pb) || (a < b && pa >= pb);
}

export function rising(st: St, rt: Runtime, x: number, length: number): boolean {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n <= L) return false;
  for (let k = 1; k <= L; k++) if (!(x > s.get(k))) return false;
  return true;
}

export function falling(st: St, rt: Runtime, x: number, length: number): boolean {
  const L = len(length);
  const s = src(st, rt, 's', x);
  if (s.n <= L) return false;
  for (let k = 1; k <= L; k++) if (!(x < s.get(k))) return false;
  return true;
}

export function valuewhen(st: St, rt: Runtime, cond: unknown, x: unknown, occurrence: number): unknown {
  st.vals ??= [];
  if (rt.bool(cond)) st.vals.push(x);
  const k = Math.floor(occurrence);
  const v = st.vals[st.vals.length - 1 - k];
  return v === undefined ? (typeof x === 'number' ? NaN : null) : v;
}

export function barssince(st: St, rt: Runtime, cond: unknown): number {
  st.count ??= 0;
  st.count++;
  if (rt.bool(cond)) st.last = st.count;
  return st.last === undefined ? NA : st.count - st.last;
}

export function cum(st: St, _rt: Runtime, x: number): number {
  st.sum ??= 0;
  if (!isNa(x)) st.sum += x;
  return st.sum;
}

export function vwap(st: St, rt: Runtime, x: number, anchor?: unknown, stdevMult?: number): number | [number, number, number] {
  const i = rt.i;
  const day = Math.floor(rt.d.t[i] / 86400000);
  const reset = anchor === undefined ? st.day !== day : rt.bool(anchor);
  if (reset || st.pv === undefined) {
    st.pv = 0;
    st.v = 0;
    st.pv2 = 0;
  }
  st.day = day;
  const vol = rt.d.v[i];
  st.pv += x * vol;
  st.v += vol;
  st.pv2 += x * x * vol;
  const vw = st.v ? st.pv / st.v : NA;
  if (stdevMult === undefined) return vw;
  const variance = st.v ? st.pv2 / st.v - vw * vw : NA;
  const sd = Math.sqrt(Math.max(0, variance));
  return [vw, vw + sd * stdevMult, vw - sd * stdevMult];
}

export function pivothigh(st: St, rt: Runtime, x: number, left: number, right: number): number {
  const L = len(left);
  const R = len(right);
  const s = src(st, rt, 's', x);
  if (s.n < L + R + 1) return NA;
  const c = s.get(R);
  if (isNa(c)) return NA;
  for (let k = 0; k < R; k++) if (!(s.get(k) < c)) return NA;
  for (let k = R + 1; k <= R + L; k++) if (!(s.get(k) <= c)) return NA;
  return c;
}

export function pivotlow(st: St, rt: Runtime, x: number, left: number, right: number): number {
  const L = len(left);
  const R = len(right);
  const s = src(st, rt, 's', x);
  if (s.n < L + R + 1) return NA;
  const c = s.get(R);
  if (isNa(c)) return NA;
  for (let k = 0; k < R; k++) if (!(s.get(k) > c)) return NA;
  for (let k = R + 1; k <= R + L; k++) if (!(s.get(k) >= c)) return NA;
  return c;
}

// ---------------------------------------------------------------- cumulative volume indicators (built-in series)

export function obv(st: St, rt: Runtime): number {
  const i = rt.i;
  st.v ??= 0;
  if (i > 0) {
    const ch = rt.d.c[i] - rt.d.c[i - 1];
    st.v += ch > 0 ? rt.d.v[i] : ch < 0 ? -rt.d.v[i] : 0;
  }
  return st.v;
}

export function accdist(st: St, rt: Runtime): number {
  const i = rt.i;
  const h = rt.d.h[i];
  const l = rt.d.l[i];
  const c = rt.d.c[i];
  st.v ??= 0;
  st.v += h === l ? 0 : (((c - l) - (h - c)) / (h - l)) * rt.d.v[i];
  return st.v;
}

export function pvt(st: St, rt: Runtime): number {
  const i = rt.i;
  st.v ??= 0;
  if (i > 0) st.v += ((rt.d.c[i] - rt.d.c[i - 1]) / rt.d.c[i - 1]) * rt.d.v[i];
  return st.v;
}

export function nvi(st: St, rt: Runtime): number {
  const i = rt.i;
  st.v ??= 1;
  if (i > 0 && rt.d.v[i] < rt.d.v[i - 1]) st.v += ((rt.d.c[i] - rt.d.c[i - 1]) / rt.d.c[i - 1]) * st.v;
  return st.v;
}

export function pvi(st: St, rt: Runtime): number {
  const i = rt.i;
  st.v ??= 1;
  if (i > 0 && rt.d.v[i] > rt.d.v[i - 1]) st.v += ((rt.d.c[i] - rt.d.c[i - 1]) / rt.d.c[i - 1]) * st.v;
  return st.v;
}

export function iii(rt: Runtime): number {
  const i = rt.i;
  const h = rt.d.h[i];
  const l = rt.d.l[i];
  const d = (h - l) * rt.d.v[i];
  return d ? (2 * rt.d.c[i] - h - l) / d : NA;
}

export function wad(st: St, rt: Runtime): number {
  const i = rt.i;
  st.v ??= 0;
  if (i > 0) {
    const pc = rt.d.c[i - 1];
    const c = rt.d.c[i];
    const trh = Math.max(pc, rt.d.h[i]);
    const trl = Math.min(pc, rt.d.l[i]);
    st.v += c > pc ? c - trl : c < pc ? c - trh : 0;
  }
  return st.v;
}

export function wvad(rt: Runtime): number {
  const i = rt.i;
  const r = rt.d.h[i] - rt.d.l[i];
  return r ? ((rt.d.c[i] - rt.d.o[i]) / r) * rt.d.v[i] : 0;
}

export function fixnan(st: St, _rt: Runtime, x: unknown): unknown {
  if (x === null || x === undefined || (typeof x === 'number' && isNa(x))) return st.last ?? (typeof x === 'number' ? NaN : null);
  st.last = x;
  return x;
}
