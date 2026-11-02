/**
 * Order-book frames aligned to chart bars: each bar carries the last snapshot taken while it was
 * forming (recorded history, or the live book on the forming bar), or none. Scripts read them
 * through Pine's `book.*` functions and Python's `data.book`.
 */
import { decodeBook, type BookView } from '../shared/bookFrame';

/** Frames for n bars in one buffer (worker messages, shared memory for optimizer trials). */
export interface BookWire {
  /** Snapshot time per bar (NaN: no book for that bar). */
  t: Float64Array;
  /** Start of each bar's frame in `bytes` (n + 1 entries; empty range: no book). */
  off: Float64Array;
  bytes: Uint8Array;
}

/** Replace frames from bar `index` on and cut the series to `length` bars. */
export interface BookDelta {
  index: number;
  length: number;
  t: number[];
  frames: (Uint8Array | null)[];
}

export function packBook(t: ArrayLike<number>, frames: ArrayLike<Uint8Array | null>): BookWire {
  const n = frames.length;
  let size = 0;
  for (let i = 0; i < n; i++) size += frames[i]?.length || 0;
  const bytes = new Uint8Array(size);
  const off = new Float64Array(n + 1);
  const tt = new Float64Array(n);
  let p = 0;
  for (let i = 0; i < n; i++) {
    off[i] = p;
    const f = frames[i];
    tt[i] = f ? t[i] : NaN;
    if (f) {
      bytes.set(f, p);
      p += f.length;
    }
  }
  off[n] = p;
  return { t: tt, off, bytes };
}

/**
 * For every bar, the index of the last snapshot taken while it formed (time in [open, close)),
 * or −1. `times` must be sorted.
 */
export function alignBook(barT: ArrayLike<number>, barTc: ArrayLike<number>, n: number, times: ArrayLike<number>): number[] {
  const pick: number[] = new Array(n).fill(-1);
  let k = 0;
  for (let i = 0; i < n && k < times.length; i++) {
    while (k < times.length && times[k] < barT[i]) k++;
    while (k < times.length && times[k] < barTc[i]) pick[i] = k++;
  }
  return pick;
}

export class BookFrames {
  private t: number[] = [];
  private frames: (Uint8Array | null)[] = [];
  private cache = new Map<number, BookView>();

  static from(w: BookWire): BookFrames {
    const f = new BookFrames();
    const n = w.t.length;
    for (let i = 0; i < n; i++) {
      const a = w.off[i];
      const b = w.off[i + 1];
      f.t.push(w.t[i]);
      f.frames.push(b > a ? w.bytes.subarray(a, b) : null);
    }
    return f;
  }

  get length(): number {
    return this.frames.length;
  }

  apply(d: BookDelta): void {
    for (let k = 0; k < d.frames.length; k++) {
      const i = d.index + k;
      this.t[i] = d.t[k];
      this.frames[i] = d.frames[k];
      this.cache.delete(i);
    }
    for (let i = this.frames.length; i < d.index; i++) {
      this.t[i] = NaN;
      this.frames[i] = null;
    }
    if (d.length < this.frames.length) {
      this.t.length = this.frames.length = d.length;
      for (const i of [...this.cache.keys()]) if (i >= d.length) this.cache.delete(i);
    }
  }

  /** Bars [0, n) only (views on the same frames). */
  truncate(n: number): BookFrames {
    const f = new BookFrames();
    f.t = this.t.slice(0, n);
    f.frames = this.frames.slice(0, n);
    return f;
  }

  time(i: number): number {
    return this.frames[i] ? this.t[i] : NaN;
  }

  /** The book of bar i (null: none). */
  at(i: number): BookView | null {
    const f = this.frames[i];
    if (!f) return null;
    let v = this.cache.get(i);
    if (!v) {
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
      v = decodeBook(f, this.t[i]);
      this.cache.set(i, v);
    }
    return v;
  }

  /** Number of bars that have a book. */
  count(): number {
    let n = 0;
    for (const f of this.frames) if (f) n++;
    return n;
  }
}
