import { encodeBook } from '../../src/shared/bookFrame';
import { packBook, type BookWire } from '../../src/engine/book';
import type { BarSeries } from '../../src/engine/types';

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A book around `mid`: `n` levels a side, one cent apart, with a bid wall at level 7 (scaled by `skew`). */
export function makeBook(mid: number, n = 40, skew = 1) {
  const bb = r2(Math.floor(mid * 100) / 100 - 0.01);
  const ba = r2(bb + 0.02);
  const bp: number[] = [];
  const bq: number[] = [];
  const ap: number[] = [];
  const aq: number[] = [];
  for (let k = 0; k < n; k++) {
    bp.push(r2(bb - k * 0.01));
    bq.push(Math.round((k === 7 ? 25 : 0.5 + (k % 5) * 0.25) * skew * 1e5) / 1e5);
    ap.push(r2(ba + k * 0.01));
    aq.push(Math.round((0.75 + (k % 3) * 0.5) * 1e5) / 1e5);
  }
  return { bp, bq, ap, aq };
}

/** Frames for every `every`-th bar (taken a second before the bar closes), none for the others. */
export function syntheticBook(data: BarSeries, every = 1): BookWire {
  const t: number[] = [];
  const frames: (Uint8Array | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i % every) {
      t.push(NaN);
      frames.push(null);
      continue;
    }
    const b = makeBook(data.c[i], 40, 1 + (i % 4) * 0.5);
    t.push(data.tc[i] - 1000);
    frames.push(encodeBook(b.bp, b.bq, b.ap, b.aq, 0.01, 0.00001));
  }
  return packBook(t, frames);
}
