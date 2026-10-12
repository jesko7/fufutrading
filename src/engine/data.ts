/**
 * Bar data plumbing shared by the script host, backtester and services: conversion from
 * CandleSeries / packed IPC arrays into the engine's BarSeries (with bar close times) and a
 * mutable live copy that applies SeriesUpdate deltas.
 */
import { CandleSeries, STRIDE } from '../shared/candles';
import { parseTimeframe, bucketEnd, isFixedDuration, tfDurationMs } from '../shared/timeframes';
import type { BarSeries } from './types';

/**
 * Bar close times (exclusive end). Time-based bars close at their bucket end; Renko bricks
 * "close" when the next brick opens (the last brick is still open: +Infinity).
 */
export function closeTimes(t: Float64Array, n: number, tf: string, chartType: string, out?: Float64Array): Float64Array {
  const tc = out && out.length >= n ? out : new Float64Array(Math.max(n, 1));
  if (chartType === 'renko') {
    for (let i = 0; i < n - 1; i++) tc[i] = t[i + 1];
    if (n) tc[n - 1] = Infinity;
    return tc;
  }
  const p = parseTimeframe(tf);
  if (!p) throw new Error(`Invalid timeframe ${tf}`);
  if (isFixedDuration(p)) {
    const d = tfDurationMs(p);
    for (let i = 0; i < n; i++) tc[i] = t[i] + d;
  } else for (let i = 0; i < n; i++) tc[i] = bucketEnd(p, t[i]);
  return tc;
}

export function fromCandles(cs: CandleSeries, tf: string, chartType = 'candles'): BarSeries {
  const n = cs.length;
  return {
    t: cs.t.subarray(0, n),
    o: cs.o.subarray(0, n),
    h: cs.h.subarray(0, n),
    l: cs.l.subarray(0, n),
    c: cs.c.subarray(0, n),
    v: cs.v.subarray(0, n),
    tbv: cs.tbv.subarray(0, n),
    tc: closeTimes(cs.t, n, tf, chartType).subarray(0, n),
    length: n,
  };
}

export function fromPacked(packed: Float64Array, tf: string, chartType = 'candles'): BarSeries {
  return fromCandles(CandleSeries.unpack(packed), tf, chartType);
}

/** A series copy that follows SeriesUpdate deltas ({index, packed, length}). */
export class LiveBars {
  readonly cs: CandleSeries;
  private tc: Float64Array = new Float64Array(16);
  private view: BarSeries | null = null;

  constructor(
    packed: Float64Array,
    readonly tf: string,
    readonly chartType: string,
  ) {
    this.cs = CandleSeries.unpack(packed);
  }

  get length(): number {
    return this.cs.length;
  }

  /** Apply a delta. Returns the first changed index. */
  apply(index: number, packed: Float64Array, length: number): number {
    const cs = this.cs;
    const m = Math.floor(packed.length / STRIDE);
    for (let k = 0; k < m; k++) {
      const p = k * STRIDE;
      const i = index + k;
      if (i < cs.length) cs.setBar(i, { t: packed[p], o: packed[p + 1], h: packed[p + 2], l: packed[p + 3], c: packed[p + 4], v: packed[p + 5], qv: packed[p + 6], n: packed[p + 7], tbv: packed[p + 8] });
      else cs.push(packed[p], packed[p + 1], packed[p + 2], packed[p + 3], packed[p + 4], packed[p + 5], packed[p + 6], packed[p + 7], packed[p + 8]);
    }
    if (length < cs.length) cs.truncate(length);
    this.view = null;
    return Math.min(index, cs.length);
  }

  bars(): BarSeries {
    if (this.view) return this.view;
    const cs = this.cs;
    const n = cs.length;
    if (this.tc.length < n) this.tc = new Float64Array(Math.max(n * 2, 16));
    closeTimes(cs.t, n, this.tf, this.chartType, this.tc);
    this.view = { t: cs.t.subarray(0, n), o: cs.o.subarray(0, n), h: cs.h.subarray(0, n), l: cs.l.subarray(0, n), c: cs.c.subarray(0, n), v: cs.v.subarray(0, n), tbv: cs.tbv.subarray(0, n), tc: this.tc.subarray(0, n), length: n };
    return this.view;
  }

  /** Closed bars only (drops the forming last bar). */
  closedBars(): BarSeries {
    const b = this.bars();
    const n = Math.max(0, b.length - 1);
    return { t: b.t.subarray(0, n), o: b.o.subarray(0, n), h: b.h.subarray(0, n), l: b.l.subarray(0, n), c: b.c.subarray(0, n), v: b.v.subarray(0, n), tbv: b.tbv?.subarray(0, n), tc: b.tc.subarray(0, n), length: n };
  }
}
