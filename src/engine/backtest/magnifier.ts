/**
 * Bar magnifier: fill strategy orders along the path of real lower-timeframe klines inside each
 * chart bar (e.g. 60 one-minute klines in an hourly bar) instead of one assumed path per bar.
 * Each sub-kline still follows open → nearer extreme → other extreme → close, so the remaining
 * assumption shrinks to the inside of one sub-kline. Plain typed arrays, so it crosses worker
 * boundaries (and can live in shared memory for optimizer trials).
 */
import { barPath } from '../../shared/trading/matching';
import type { TickProvider } from './broker';

export interface Magnifier {
  interval: string;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** Index of the first sub-kline of each chart bar; length = chart bars + 1. */
  start: Float64Array;
}

interface SubSeries {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  length: number;
}

function lowerBound(a: Float64Array, n: number, x: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Map sub-klines to chart bars: bar i covers sub-klines with open time in [t[i], tc[i]). */
export function buildMagnifier(bars: { t: Float64Array; tc: Float64Array; length: number }, sub: SubSeries, interval: string): Magnifier {
  const n = bars.length;
  const start = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) start[i] = lowerBound(sub.t, sub.length, bars.t[i]);
  start[n] = n ? lowerBound(sub.t, sub.length, bars.tc[n - 1]) : 0;
  const m = sub.length;
  return { interval, t: sub.t.slice(0, m), o: sub.o.slice(0, m), h: sub.h.slice(0, m), l: sub.l.slice(0, m), c: sub.c.slice(0, m), v: sub.v.slice(0, m), start };
}

/** Intrabar price path of chart bar `i` from its sub-klines (null when none are available). */
export function magnifierTicks(mg: Magnifier): TickProvider {
  return (i: number) => {
    const a = mg.start[i];
    const b = mg.start[i + 1];
    const k = b - a;
    if (!(k > 0)) return null;
    const p = new Float64Array(k * 4);
    const t = new Float64Array(k * 4);
    const q = new Float64Array(k * 4);
    let n = 0;
    for (let j = a; j < b; j++) {
      const pts = barPath(mg.o[j], mg.h[j], mg.l[j], mg.c[j]);
      const vq = mg.v[j] / 3;
      for (let s = 0; s < pts.length; s++) {
        if (n > 0 && p[n - 1] === pts[s]) continue;
        p[n] = pts[s];
        t[n] = mg.t[j] + s;
        q[n] = s === 0 ? 0 : vq;
        n++;
      }
    }
    return { t: t.subarray(0, n), p: p.subarray(0, n), q: q.subarray(0, n), path: true };
  };
}

/** Fraction of chart bars with sub-klines (for the report). */
export function magnifierCoverage(mg: Magnifier, from = 0): number {
  const n = mg.start.length - 1;
  if (n <= from) return 0;
  let c = 0;
  for (let i = from; i < n; i++) if (mg.start[i + 1] > mg.start[i]) c++;
  return c / (n - from);
}
