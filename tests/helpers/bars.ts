import type { BarSeries, RunContext } from '../../src/engine/types';

export const MIN = 60000;

/** Deterministic synthetic bars (smooth trend + oscillation, varied wicks and volume). */
export function bars(n: number, f = (i: number) => 100 + Math.sin(i / 7) * 10 + i * 0.05, start = Date.UTC(2026, 0, 1), step = MIN): BarSeries {
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const tc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = start + i * step;
    tc[i] = t[i] + step;
    o[i] = f(i);
    c[i] = f(i + 1);
    h[i] = Math.max(o[i], c[i]) + 0.5 + (i % 3) * 0.1;
    l[i] = Math.min(o[i], c[i]) - 0.5 - (i % 5) * 0.1;
    v[i] = 10 + (i % 7);
  }
  return { t, o, h, l, c, v, tc, length: n };
}

/** Aggregate 1m synthetic bars into k-minute bars. */
export function aggregateBars(b: BarSeries, k: number): BarSeries {
  const m = Math.floor(b.length / k);
  const out = { t: new Float64Array(m), o: new Float64Array(m), h: new Float64Array(m), l: new Float64Array(m), c: new Float64Array(m), v: new Float64Array(m), tc: new Float64Array(m), length: m };
  for (let j = 0; j < m; j++) {
    const a = j * k;
    out.t[j] = b.t[a];
    out.tc[j] = b.tc[a + k - 1];
    out.o[j] = b.o[a];
    out.c[j] = b.c[a + k - 1];
    let hi = -Infinity;
    let lo = Infinity;
    let v = 0;
    for (let i = a; i < a + k; i++) {
      hi = Math.max(hi, b.h[i]);
      lo = Math.min(lo, b.l[i]);
      v += b.v[i];
    }
    out.h[j] = hi;
    out.l[j] = lo;
    out.v[j] = v;
  }
  return out;
}

export const ctx: RunContext = { symbol: 'BTCUSDT', market: 'spot', tf: '1m', chartType: 'candles', mintick: 0.01, base: 'BTC', quote: 'USDT' };
