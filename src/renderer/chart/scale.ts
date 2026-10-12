/** Price scale math: linear / log / percent transforms, auto-fit, tick generation. */
import type { ScaleMode } from './types';
import { MONTHS, timeParts } from '../lib/format';

export class PriceScale {
  mode: ScaleMode = 'linear';
  auto = true;
  /** Visible range in transformed space. */
  min = 0;
  max = 1;
  top = 0;
  height = 1;
  /** Base value for percent mode (first visible close). */
  base = 1;
  marginTop = 0.1;
  marginBottom = 0.1;
  fixedMin?: number;
  fixedMax?: number;

  tf(v: number): number {
    if (this.mode === 'log') return v > 0 ? Math.log(v) : NaN;
    if (this.mode === 'percent') return (v / this.base - 1) * 100;
    return v;
  }

  inv(x: number): number {
    if (this.mode === 'log') return Math.exp(x);
    if (this.mode === 'percent') return (x / 100 + 1) * this.base;
    return x;
  }

  toY(v: number): number {
    const x = this.tf(v);
    return this.top + (1 - (x - this.min) / (this.max - this.min || 1)) * this.height;
  }

  /** Map a transformed-space value directly. */
  toYRaw(x: number): number {
    return this.top + (1 - (x - this.min) / (this.max - this.min || 1)) * this.height;
  }

  fromY(y: number): number {
    const x = this.min + (1 - (y - this.top) / this.height) * (this.max - this.min);
    return this.inv(x);
  }

  /** Fit to [lo, hi] raw values (if auto). */
  fit(lo: number, hi: number): void {
    if (!this.auto) return;
    if (this.fixedMin !== undefined && this.fixedMax !== undefined) {
      lo = this.fixedMin;
      hi = this.fixedMax;
    }
    let a = this.tf(lo);
    let b = this.tf(hi);
    if (!isFinite(a) || !isFinite(b)) {
      a = 0;
      b = 1;
    }
    if (b - a < 1e-12) {
      const pad = Math.abs(a) * 0.01 || 1;
      a -= pad;
      b += pad;
    }
    const span = b - a;
    const mt = this.fixedMax !== undefined ? 0.04 : this.marginTop;
    const mb = this.fixedMin !== undefined ? 0.04 : this.marginBottom;
    this.min = a - span * mb;
    this.max = b + span * mt;
  }

  /** Zoom around the center (factor > 1 expands range). */
  zoom(factor: number, anchorY?: number): void {
    this.auto = false;
    const c = anchorY !== undefined ? this.min + (1 - (anchorY - this.top) / this.height) * (this.max - this.min) : (this.min + this.max) / 2;
    this.min = c - (c - this.min) * factor;
    this.max = c + (this.max - c) * factor;
  }

  pan(dy: number): void {
    this.auto = false;
    const d = (dy / this.height) * (this.max - this.min);
    this.min += d;
    this.max += d;
  }

  /** Nice tick values in raw (untransformed) space. */
  ticks(maxTicks: number): number[] {
    if (this.mode === 'log') {
      // pick ticks evenly spaced in log space then round to nice raw numbers
      const out: number[] = [];
      const n = Math.max(2, maxTicks);
      for (let i = 0; i <= n; i++) {
        const raw = Math.exp(this.min + ((this.max - this.min) * i) / n);
        out.push(niceRound(raw));
      }
      return [...new Set(out)].filter((v) => v > 0);
    }
    const lo = this.min;
    const hi = this.max;
    const step = niceStep((hi - lo) / Math.max(1, maxTicks));
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      const x = +v.toFixed(12);
      out.push(this.mode === 'percent' ? this.inv(x) : x);
    }
    return out;
  }

  /** Step (in raw units) of ticks for formatting decisions. */
  tickStep(maxTicks: number): number {
    return niceStep((this.max - this.min) / Math.max(1, maxTicks));
  }
}

export function niceStep(raw: number): number {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}

function niceRound(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
}

export function decimalsForStep(step: number): number {
  if (step >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(step) - 1e-9));
}

export function formatAxis(v: number, decimals: number): string {
  if (!isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6 && decimals === 0) return `${(v / 1e6).toFixed(2)}M`;
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(3);
}

// ------------------------------------------------------------------------------- time axis

const STEPS_MS = [1e3, 5e3, 15e3, 30e3, 60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 21600e3, 43200e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 14 * 86400e3];

export interface TimeTick {
  index: number;
  label: string;
  major: boolean;
}

/**
 * Choose time labels for bars [i0, i1]. Labels mark bars where the time crosses a boundary of
 * the chosen step; day/month/year boundaries are emphasised.
 */
export function timeTicks(times: Float64Array, i0: number, i1: number, barSpacing: number, minGapPx = 90): TimeTick[] {
  const n = i1 - i0 + 1;
  if (n <= 1) return [];
  const t0 = times[Math.max(0, i0)];
  const t1 = times[Math.min(times.length - 1, i1)];
  const msPerPx = (t1 - t0) / Math.max(1, n * barSpacing);
  const want = msPerPx * minGapPx;
  let step = STEPS_MS.find((s) => s >= want);
  const monthly = !step;
  const ticks: TimeTick[] = [];
  let prevKey = '';
  let lastIdx = -1e9;
  const minBars = Math.max(1, Math.floor(minGapPx / Math.max(barSpacing, 1e-6)) * 0.6);
  for (let i = Math.max(0, i0); i <= Math.min(times.length - 1, i1); i++) {
    const p = timeParts(times[i]);
    let key: string;
    if (monthly) {
      const monthsSpan = Math.max(1, Math.round(want / (30 * 86400e3)));
      const ms = monthsSpan >= 12 ? 12 : monthsSpan >= 6 ? 6 : monthsSpan >= 3 ? 3 : 1;
      key = `${p.y}-${Math.floor(p.mo / ms)}`;
    } else if (step! >= 86400e3) {
      const dayIdx = Math.floor((Date.UTC(p.y, p.mo, p.d) / 86400e3) / (step! / 86400e3));
      key = step! >= 7 * 86400e3 ? `${p.y}-${p.mo}-${Math.floor(p.d / 7.5)}` : `${dayIdx}`;
    } else {
      const sec = p.h * 3600 + p.mi * 60 + p.s;
      key = `${p.y}-${p.mo}-${p.d}-${Math.floor(sec / (step! / 1000))}`;
    }
    if (key !== prevKey) {
      if (prevKey && i - lastIdx >= minBars) {
        const prev = i > 0 ? timeParts(times[i - 1]) : null;
        let label: string;
        let major = false;
        if (prev && prev.y !== p.y) {
          label = String(p.y);
          major = true;
        } else if (prev && prev.mo !== p.mo) {
          label = MONTHS[p.mo];
          major = true;
        } else if (prev && prev.d !== p.d) {
          label = String(p.d);
          major = true;
        } else {
          label = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}${step && step < 60e3 ? `:${String(p.s).padStart(2, '0')}` : ''}`;
        }
        ticks.push({ index: i, label, major });
        lastIdx = i;
      }
      prevKey = key;
    }
  }
  return ticks;
}
