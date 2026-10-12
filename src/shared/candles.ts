/**
 * Columnar candle storage and pure transformations (aggregation, Heikin-Ashi, Renko).
 *
 * Packed layout (used on disk and for IPC): Float64Array with STRIDE values per candle:
 *   [t, o, h, l, c, v, qv, n, tbv]
 *   t   open time (ms)
 *   v   base volume, qv quote volume, n number of trades, tbv taker-buy base volume
 */

import { bucketEnd, bucketStart, type Timeframe } from './timeframes';

export const STRIDE = 9;
export const F = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5, qv: 6, n: 7, tbv: 8 } as const;

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  qv: number;
  n: number;
  tbv: number;
}

export class CandleSeries {
  length = 0;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  qv: Float64Array;
  n: Float64Array;
  tbv: Float64Array;

  constructor(capacity = 256) {
    const cap = Math.max(16, capacity);
    this.t = new Float64Array(cap);
    this.o = new Float64Array(cap);
    this.h = new Float64Array(cap);
    this.l = new Float64Array(cap);
    this.c = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.qv = new Float64Array(cap);
    this.n = new Float64Array(cap);
    this.tbv = new Float64Array(cap);
  }

  get capacity(): number {
    return this.t.length;
  }

  private grow(min: number): void {
    let cap = this.capacity;
    while (cap < min) cap *= 2;
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'qv', 'n', 'tbv'] as const) {
      const a = new Float64Array(cap);
      a.set(this[k].subarray(0, this.length));
      this[k] = a;
    }
  }

  push(t: number, o: number, h: number, l: number, c: number, v = 0, qv = 0, n = 0, tbv = 0): number {
    if (this.length >= this.capacity) this.grow(this.length + 1);
    const i = this.length++;
    this.t[i] = t;
    this.o[i] = o;
    this.h[i] = h;
    this.l[i] = l;
    this.c[i] = c;
    this.v[i] = v;
    this.qv[i] = qv;
    this.n[i] = n;
    this.tbv[i] = tbv;
    return i;
  }

  pushBar(b: Bar): number {
    return this.push(b.t, b.o, b.h, b.l, b.c, b.v, b.qv, b.n, b.tbv);
  }

  setBar(i: number, b: Bar): void {
    this.t[i] = b.t;
    this.o[i] = b.o;
    this.h[i] = b.h;
    this.l[i] = b.l;
    this.c[i] = b.c;
    this.v[i] = b.v;
    this.qv[i] = b.qv;
    this.n[i] = b.n;
    this.tbv[i] = b.tbv;
  }

  bar(i: number): Bar {
    return { t: this.t[i], o: this.o[i], h: this.h[i], l: this.l[i], c: this.c[i], v: this.v[i], qv: this.qv[i], n: this.n[i], tbv: this.tbv[i] };
  }

  last(): Bar | null {
    return this.length ? this.bar(this.length - 1) : null;
  }

  truncate(len: number): void {
    this.length = Math.max(0, Math.min(this.length, len));
  }

  /** Index of the bar whose time is exactly t, or -1. */
  indexOfTime(t: number): number {
    const i = this.lowerBound(t);
    return i < this.length && this.t[i] === t ? i : -1;
  }

  /** First index with time >= t. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.t[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Last index with time <= t, or -1. */
  floorIndex(t: number): number {
    return this.upperBound(t) - 1;
  }

  /** First index with time > t. */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.t[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  slice(from = 0, to = this.length): CandleSeries {
    from = Math.max(0, from);
    to = Math.min(this.length, to);
    const out = new CandleSeries(Math.max(16, to - from));
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'qv', 'n', 'tbv'] as const) out[k].set(this[k].subarray(from, to));
    out.length = Math.max(0, to - from);
    return out;
  }

  clone(): CandleSeries {
    return this.slice(0, this.length);
  }

  /** Merge `other` (sorted) into this series; on equal times `other` wins. Returns new series. */
  merge(other: CandleSeries): CandleSeries {
    const out = new CandleSeries(this.length + other.length);
    let i = 0;
    let j = 0;
    while (i < this.length || j < other.length) {
      if (j >= other.length || (i < this.length && this.t[i] < other.t[j])) {
        out.pushBar(this.bar(i++));
      } else if (i >= this.length || other.t[j] < this.t[i]) {
        out.pushBar(other.bar(j++));
      } else {
        out.pushBar(other.bar(j++));
        i++;
      }
    }
    return out;
  }

  pack(from = 0, to = this.length): Float64Array {
    from = Math.max(0, from);
    to = Math.min(this.length, to);
    const out = new Float64Array((to - from) * STRIDE);
    for (let i = from, p = 0; i < to; i++, p += STRIDE) {
      out[p] = this.t[i];
      out[p + 1] = this.o[i];
      out[p + 2] = this.h[i];
      out[p + 3] = this.l[i];
      out[p + 4] = this.c[i];
      out[p + 5] = this.v[i];
      out[p + 6] = this.qv[i];
      out[p + 7] = this.n[i];
      out[p + 8] = this.tbv[i];
    }
    return out;
  }

  static unpack(packed: Float64Array | ArrayLike<number>): CandleSeries {
    const len = Math.floor(packed.length / STRIDE);
    const s = new CandleSeries(len);
    for (let i = 0, p = 0; i < len; i++, p += STRIDE) {
      s.t[i] = packed[p];
      s.o[i] = packed[p + 1];
      s.h[i] = packed[p + 2];
      s.l[i] = packed[p + 3];
      s.c[i] = packed[p + 4];
      s.v[i] = packed[p + 5];
      s.qv[i] = packed[p + 6];
      s.n[i] = packed[p + 7];
      s.tbv[i] = packed[p + 8];
    }
    s.length = len;
    return s;
  }

  static fromBars(bars: Bar[]): CandleSeries {
    const s = new CandleSeries(bars.length);
    for (const b of bars) s.pushBar(b);
    return s;
  }
}

export function emptyBar(t: number, price: number): Bar {
  return { t, o: price, h: price, l: price, c: price, v: 0, qv: 0, n: 0, tbv: 0 };
}

/** Merge bar b (later in time) into accumulator a (in place). */
export function mergeInto(a: Bar, b: Bar): void {
  if (b.h > a.h) a.h = b.h;
  if (b.l < a.l) a.l = b.l;
  a.c = b.c;
  a.v += b.v;
  a.qv += b.qv;
  a.n += b.n;
  a.tbv += b.tbv;
}

/**
 * Aggregate finer candles into timeframe buckets. Source must be sorted by time and must
 * consist of candles that nest inside the target buckets.
 */
export function aggregate(src: CandleSeries, tf: Timeframe, from = 0, to = src.length): CandleSeries {
  const out = new CandleSeries(Math.max(16, Math.ceil((to - from) / 2)));
  let cur: Bar | null = null;
  let curEnd = -Infinity;
  for (let i = from; i < to; i++) {
    const t = src.t[i];
    if (cur && t < curEnd) {
      const h = src.h[i];
      const l = src.l[i];
      if (h > cur.h) cur.h = h;
      if (l < cur.l) cur.l = l;
      cur.c = src.c[i];
      cur.v += src.v[i];
      cur.qv += src.qv[i];
      cur.n += src.n[i];
      cur.tbv += src.tbv[i];
    } else {
      if (cur) out.pushBar(cur);
      const b = bucketStart(tf, t);
      curEnd = bucketEnd(tf, b);
      cur = { t: b, o: src.o[i], h: src.h[i], l: src.l[i], c: src.c[i], v: src.v[i], qv: src.qv[i], n: src.n[i], tbv: src.tbv[i] };
    }
  }
  if (cur) out.pushBar(cur);
  return out;
}

/** Heikin-Ashi transform (times and volumes unchanged). */
export function heikinAshi(src: CandleSeries, from = 0, prev?: { o: number; c: number }): CandleSeries {
  const out = new CandleSeries(src.length - from);
  let po = prev ? prev.o : NaN;
  let pc = prev ? prev.c : NaN;
  for (let i = from; i < src.length; i++) {
    const o = src.o[i];
    const h = src.h[i];
    const l = src.l[i];
    const c = src.c[i];
    const hc = (o + h + l + c) / 4;
    const ho = isNaN(po) ? (o + c) / 2 : (po + pc) / 2;
    const hh = Math.max(h, ho, hc);
    const hl = Math.min(l, ho, hc);
    out.push(src.t[i], ho, hh, hl, hc, src.v[i], src.qv[i], src.n[i], src.tbv[i]);
    po = ho;
    pc = hc;
  }
  return out;
}

/** Recompute only the HA bar at index i given the HA series computed up to i-1. */
export function heikinAshiBar(src: CandleSeries, i: number, ha: CandleSeries): Bar {
  const o = src.o[i];
  const h = src.h[i];
  const l = src.l[i];
  const c = src.c[i];
  const hc = (o + h + l + c) / 4;
  const ho = i > 0 && ha.length >= i ? (ha.o[i - 1] + ha.c[i - 1]) / 2 : (o + c) / 2;
  return { t: src.t[i], o: ho, h: Math.max(h, ho, hc), l: Math.min(l, ho, hc), c: hc, v: src.v[i], qv: src.qv[i], n: src.n[i], tbv: src.tbv[i] };
}

// ---------------------------------------------------------------------------------------
// Renko
// ---------------------------------------------------------------------------------------

export interface RenkoOptions {
  /** Fixed box size in price units. If 0/undefined, `atrLength` is used. */
  boxSize?: number;
  /** ATR length used to derive a box size from the source data (TradingView "ATR" method). */
  atrLength?: number;
  /** Box as percent of the last price (e.g. 0.5 = 0.5%). Used if boxSize and atrLength absent. */
  percent?: number;
  /** 'close' builds bricks from closes; 'hl' also uses highs/lows (wicks reach further). */
  source?: 'close' | 'hl';
  /** Tick size used to round derived box sizes. */
  tick?: number;
}

export interface RenkoState {
  box: number;
  dir: number; // 1 up, -1 down, 0 none
  open: number; // open of last brick
  close: number; // close of last brick
  wickHigh: number;
  wickLow: number;
  accV: number;
  accQv: number;
  accN: number;
  accTbv: number;
  started: boolean;
}

export function atr(src: CandleSeries, length: number): number {
  if (src.length < 2) return src.length ? src.h[0] - src.l[0] : 0;
  // Wilder's RMA of true range (seeded with SMA), last value
  let rma = NaN;
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const tr = i === 0 ? src.h[i] - src.l[i] : Math.max(src.h[i] - src.l[i], Math.abs(src.h[i] - src.c[i - 1]), Math.abs(src.l[i] - src.c[i - 1]));
    if (i < length) {
      sum += tr;
      if (i === length - 1) rma = sum / length;
    } else {
      rma = (rma * (length - 1) + tr) / length;
    }
  }
  return isNaN(rma) ? sum / src.length : rma;
}

export function renkoBoxSize(src: CandleSeries, opts: RenkoOptions): number {
  let box = opts.boxSize && opts.boxSize > 0 ? opts.boxSize : 0;
  if (!box && opts.atrLength) box = atr(src, opts.atrLength);
  if (!box && opts.percent && src.length) box = (src.c[src.length - 1] * opts.percent) / 100;
  if (!box && src.length) box = atr(src, 14);
  const tick = opts.tick || 0;
  if (tick > 0) box = Math.max(tick, Math.round(box / tick) * tick);
  return box > 0 ? box : 1;
}

export function newRenkoState(box: number): RenkoState {
  return { box, dir: 0, open: NaN, close: NaN, wickHigh: -Infinity, wickLow: Infinity, accV: 0, accQv: 0, accN: 0, accTbv: 0, started: false };
}

export function cloneRenkoState(s: RenkoState): RenkoState {
  return { ...s };
}

/**
 * Feed one source candle into the Renko state; appends completed bricks to `out`.
 * Classic Renko: continuation needs one box beyond the last close, a reversal needs one box
 * beyond the last brick's open (i.e. two boxes from its close).
 */
export function renkoStep(state: RenkoState, src: CandleSeries, i: number, out: CandleSeries, mode: 'close' | 'hl' = 'close'): void {
  const box = state.box;
  const t = src.t[i];
  if (!state.started) {
    const base = Math.round(src.o[i] / box) * box;
    state.open = base;
    state.close = base;
    state.started = true;
  }
  state.accV += src.v[i];
  state.accQv += src.qv[i];
  state.accN += src.n[i];
  state.accTbv += src.tbv[i];
  if (src.h[i] > state.wickHigh) state.wickHigh = src.h[i];
  if (src.l[i] < state.wickLow) state.wickLow = src.l[i];

  const prices: number[] =
    mode === 'hl' ? (src.c[i] >= src.o[i] ? [src.l[i], src.h[i], src.c[i]] : [src.h[i], src.l[i], src.c[i]]) : [src.c[i]];

  const before = out.length;
  for (const p of prices) {
    for (;;) {
      if (state.dir >= 0 && p >= state.close + box) {
        addBrick(state, out, t, state.close, state.close + box, 1);
      } else if (state.dir <= 0 && p <= state.close - box) {
        addBrick(state, out, t, state.close, state.close - box, -1);
      } else if (state.dir === 1 && p <= state.open - box) {
        addBrick(state, out, t, state.open, state.open - box, -1);
      } else if (state.dir === -1 && p >= state.open + box) {
        addBrick(state, out, t, state.open, state.open + box, 1);
      } else break;
    }
  }
  const made = out.length - before;
  if (made > 0) {
    // distribute accumulated volume over the bricks formed by this candle
    const share = 1 / made;
    for (let k = before; k < out.length; k++) {
      out.v[k] = state.accV * share;
      out.qv[k] = state.accQv * share;
      out.n[k] = state.accN * share;
      out.tbv[k] = state.accTbv * share;
    }
    state.accV = state.accQv = state.accN = state.accTbv = 0;
    state.wickHigh = -Infinity;
    state.wickLow = Infinity;
  }
}

function addBrick(state: RenkoState, out: CandleSeries, t: number, o: number, c: number, dir: number): void {
  const hi = Math.max(o, c);
  const lo = Math.min(o, c);
  // Bricks share the source time; nudge by index so times stay strictly increasing for lookup.
  let tt = t;
  if (out.length && out.t[out.length - 1] >= tt) tt = out.t[out.length - 1] + 1;
  out.push(tt, o, hi, lo, c, 0, 0, 0, 0);
  state.open = o;
  state.close = c;
  state.dir = dir;
}

export function renko(src: CandleSeries, opts: RenkoOptions): { series: CandleSeries; box: number; state: RenkoState } {
  const box = renkoBoxSize(src, opts);
  const state = newRenkoState(box);
  const out = new CandleSeries(256);
  for (let i = 0; i < src.length; i++) renkoStep(state, src, i, out, opts.source || 'close');
  return { series: out, box, state };
}

/** Simple helpers used across modules. */
export function typicalPrice(s: CandleSeries, i: number): number {
  return (s.h[i] + s.l[i] + s.c[i]) / 3;
}

export function seriesMinMax(s: CandleSeries, from: number, to: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, from); i < Math.min(s.length, to); i++) {
    if (s.l[i] < lo) lo = s.l[i];
    if (s.h[i] > hi) hi = s.h[i];
  }
  return [lo, hi];
}
