import { STRIDE } from '../../shared/candles';
import type { ChartBars } from './types';

/** Growable columnar bar storage fed by series snapshots and incremental updates. */
export class BarStore {
  t = new Float64Array(1024);
  o = new Float64Array(1024);
  h = new Float64Array(1024);
  l = new Float64Array(1024);
  c = new Float64Array(1024);
  v = new Float64Array(1024);
  tbv = new Float64Array(1024);
  length = 0;

  private ensure(n: number): void {
    if (n <= this.t.length) return;
    let cap = this.t.length;
    while (cap < n) cap *= 2;
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'tbv'] as const) {
      const a = new Float64Array(cap);
      a.set(this[k].subarray(0, this.length));
      this[k] = a;
    }
  }

  reset(): void {
    this.length = 0;
  }

  setPacked(p: Float64Array): void {
    const n = Math.floor(p.length / STRIDE);
    this.ensure(n);
    this.length = 0;
    this.write(0, p);
    this.length = n;
  }

  private write(index: number, p: Float64Array): void {
    const n = Math.floor(p.length / STRIDE);
    for (let k = 0, q = 0; k < n; k++, q += STRIDE) {
      const i = index + k;
      this.t[i] = p[q];
      this.o[i] = p[q + 1];
      this.h[i] = p[q + 2];
      this.l[i] = p[q + 3];
      this.c[i] = p[q + 4];
      this.v[i] = p[q + 5];
      this.tbv[i] = p[q + 8];
    }
  }

  /** Apply an update; returns number of newly appended bars. */
  apply(index: number, p: Float64Array, length: number): number {
    const before = this.length;
    this.ensure(Math.max(length, index + p.length / STRIDE));
    this.write(index, p);
    this.length = length;
    return Math.max(0, length - before);
  }

  bars(): ChartBars {
    return { t: this.t, o: this.o, h: this.h, l: this.l, c: this.c, v: this.v, tbv: this.tbv, length: this.length };
  }
}
