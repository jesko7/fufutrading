/**
 * Repaint check — replays the most recent bars as if each one had just closed live and compares
 * what the script produced at that moment with what its full history shows for the same bar:
 *  - indicators: plot values and alert conditions as a chart keeps them for bar k once bar k+1
 *    has started (the bars up to k plus the first tick of k+1 as the forming bar);
 *  - strategies: their plots, and the position and working orders a bot had after bar k (it runs
 *    on the closed bars up to k) against the backtest's.
 * request.security data is cut at the same moment: a higher-timeframe bar that was still forming
 * is rebuilt from chart-timeframe bars of the same instrument (and left out when those are missing).
 * A difference means the history shows something that was not known at the time — a lookahead
 * (future data) or logic that depends on the newest bar or the clock.
 */
import type { BarSeries, ScriptLanguage, ScriptPlot, ScriptResult } from './types';
import type { StrategyState } from './backtest/broker';
import { keyParts, toBars, type RunSpec, type ScriptHost } from './host';
import { truncateBars } from './data';
import { parseTimeframe, tfDurationMs } from '../shared/timeframes';
import { BookFrames } from './book';

export interface RepaintSpec extends Omit<RunSpec, 'debug' | 'trace' | 'upTo' | 'bot' | 'realtime' | 'stateAt' | 'magnifier' | 'ticks'> {
  /** Most recent bars to replay (default 300). */
  window?: number;
  /** Stop replaying after this many milliseconds (default 10 s; at least 8 bars are replayed)… */
  budgetMs?: number;
  /** …or after this many bars (default 120). */
  maxChecks?: number;
}

export interface RepaintDiff {
  kind: 'plot' | 'alert' | 'strategy' | 'error';
  title: string;
  /** Replayed bars at which the live result differed from the history. */
  count: number;
  /** The most recent difference: bar open time and both values, described. */
  example: { time: number; live: string; history: string };
}

export interface RepaintReport {
  ok: boolean;
  error?: string;
  /** Data keys to load before checking again (request.security and chart-timeframe bars to rebuild forming bars). */
  need: string[];
  language: ScriptLanguage;
  title: string;
  isStrategy: boolean;
  /** Bars of history the check ran on. */
  bars: number;
  /** Bars replayed, out of the most recent `window`. */
  checked: number;
  window: number;
  /** Open times of the oldest and the newest replayed bar. */
  from: number;
  to: number;
  diffs: RepaintDiff[];
  /** Open times of replayed bars that differed (newest first, at most 200). */
  badTimes: number[];
  notes: string[];
  ms: number;
}

const tfMs = (tf: string): number => {
  const p = parseTimeframe(tf);
  return p ? tfDurationMs(p) : NaN;
};

/** First index whose value is ≥ x (sorted array). */
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

function copyBars(s: BarSeries, m: number): BarSeries {
  const cp = (a: Float64Array) => {
    const x = new Float64Array(m);
    x.set(a.subarray(0, Math.min(m, a.length)));
    return x;
  };
  return { t: cp(s.t), o: cp(s.o), h: cp(s.h), l: cp(s.l), c: cp(s.c), v: cp(s.v), tbv: s.tbv ? cp(s.tbv) : undefined, tc: cp(s.tc), length: m };
}

/** Bars 0…k and the first tick of bar k+1 (open = high = low = close, no volume) as the forming bar. */
export function withFormingBar(d: BarSeries, k: number): BarSeries {
  const r = copyBars(d, k + 2);
  const j = k + 1;
  const open = d.o[j];
  r.t[j] = d.t[j];
  r.o[j] = r.h[j] = r.l[j] = r.c[j] = open;
  r.v[j] = 0;
  if (r.tbv) r.tbv[j] = 0;
  r.tc[j] = d.tc[j];
  return r;
}

/** OHLCV of the base bars inside [from, to): the part of a higher-timeframe bar that had formed by `to`. */
function partialBar(base: BarSeries, from: number, to: number): { o: number; h: number; l: number; c: number; v: number; tbv: number } | null {
  const n = base.length;
  if (!n || base.t[0] > from) return null;
  const lo = lowerBound(base.t, n, from);
  const hi = lowerBound(base.t, n, to);
  if (lo >= hi) return null;
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  let tbv = 0;
  for (let i = lo; i < hi; i++) {
    if (base.h[i] > h) h = base.h[i];
    if (base.l[i] < l) l = base.l[i];
    v += base.v[i];
    tbv += base.tbv ? base.tbv[i] : 0;
  }
  return { o: base.o[lo], h, l, c: base.c[hi - 1], v, tbv };
}

/**
 * A request.security series as it was at time `cut`: bars that had closed, plus the bar still
 * forming then — rebuilt from `base` (chart-timeframe candles of the same instrument), or left
 * out without one.
 */
export function cutSeries(s: BarSeries, cut: number, base: BarSeries | null | undefined, heikinAshi = false): BarSeries {
  const m = lowerBound(s.t, s.length, cut);
  if (m === 0) return truncateBars(s, 0);
  if (s.tc[m - 1] <= cut) return truncateBars(s, m);
  const p = base ? partialBar(base, s.t[m - 1], cut) : null;
  if (!p) return truncateBars(s, m - 1);
  const r = copyBars(s, m);
  const j = m - 1;
  let { o, h, l, c } = p;
  if (heikinAshi) {
    const ho = j > 0 ? (s.o[j - 1] + s.c[j - 1]) / 2 : o;
    const hc = (o + h + l + c) / 4;
    o = ho;
    h = Math.max(h, ho, hc);
    l = Math.min(l, ho, hc);
    c = hc;
  }
  r.o[j] = o;
  r.h[j] = h;
  r.l[j] = l;
  r.c[j] = c;
  r.v[j] = p.v;
  if (r.tbv) r.tbv[j] = p.tbv;
  return r;
}

const num = (v: number): string => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: 8 }) : 'no value');
const same = (a: number, b: number): boolean => a === b || (a !== a && b !== b) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const isShape = (p: ScriptPlot) => p.kind === 'shape' || p.kind === 'char';
const shown = (v: number) => Number.isFinite(v) && v !== 0;

/** Value drawn at bar x (plot offsets move values to other bars). */
function drawn(p: ScriptPlot, x: number, arr: Float64Array | undefined = p.values): number {
  const j = x - (p.offset || 0);
  return arr && j >= 0 && j < arr.length ? arr[j] : NaN;
}

function describeState(s: StrategyState): string {
  const q = String(+Math.abs(s.pos).toPrecision(6));
  const pos = s.pos > 0 ? `long ${q}` : s.pos < 0 ? `short ${q}` : 'flat';
  return s.orders.length ? `${pos}; ${s.orders.join('; ')}` : pos;
}

function sameState(a: StrategyState, b: StrategyState): boolean {
  if (Math.abs(a.pos - b.pos) > 1e-9 + 1e-6 * Math.max(Math.abs(a.pos), Math.abs(b.pos))) return false;
  return a.orders.length === b.orders.length && a.orders.every((o, k) => o === b.orders[k]);
}

const errText = (r: ScriptResult) => (r.error ? `${r.error.line ? `Line ${r.error.line}: ` : ''}${r.error.message}` : 'Script error');

export async function repaintCheck(host: ScriptHost, spec: RepaintSpec): Promise<RepaintReport> {
  const t0 = performance.now();
  const ctx = spec.ctx;
  const data = toBars(spec.data, ctx.tf, ctx.chartType);
  const n = data.length;
  const security: Record<string, BarSeries> = {};
  for (const [k, v] of Object.entries(spec.security || {})) {
    const kp = keyParts(k);
    security[k] = toBars(v, kp.tf, kp.chartType);
  }
  const rep: RepaintReport = { ok: false, need: [], language: spec.lang, title: '', isStrategy: false, bars: n, checked: 0, window: 0, from: NaN, to: NaN, diffs: [], badTimes: [], notes: [], ms: 0 };
  const done = (r: Partial<RepaintReport> = {}): RepaintReport => ({ ...rep, ...r, ms: Math.round(performance.now() - t0) });
  if (ctx.chartType === 'renko') return done({ error: 'The repaint check needs time-based bars: Renko bricks have no fixed close times.' });
  if (n < 60) return done({ error: `Too few bars for a repaint check (${n}).` });
  const window = Math.max(1, Math.min(Math.floor(spec.window ?? 300), n - 50));
  rep.window = window;
  // replay order: a golden-ratio sequence spreads any prefix evenly over the window (a time budget
  // still covers all of it) without aliasing with periodic structure such as higher-timeframe bars
  const order: number[] = [];
  const seen = new Set<number>();
  for (let j = 0; order.length < window && j < window * 8; j++) {
    const off = 1 + Math.floor(((j * 0.6180339887498949) % 1) * window);
    if (!seen.has(off)) {
      seen.add(off);
      order.push(n - 1 - off);
    }
  }
  for (let off = 1; off <= window; off++) if (!seen.has(off)) order.push(n - 1 - off);
  // recorded order-book frames are the same for the history and the replayed bars (a forming bar's book is not recorded)
  const book = spec.book ? (spec.book instanceof BookFrames ? spec.book : BookFrames.from(spec.book)) : undefined;
  const base = { lang: spec.lang, code: spec.code, ctx, inputs: spec.inputs, strategy: spec.strategy, maxMs: spec.maxMs, shouldStop: spec.shouldStop, book };

  // 1) the history: one run over all bars (strategies record their state after every candidate bar)
  const full = await host.run({ ...base, data, security, stateAt: order });
  if (full.need.length) return done({ need: full.need });
  const F = full.result;
  rep.title = F.meta?.title || '';
  if (!F.ok) return done({ error: errText(F) });
  const isStrategy = !!F.strategy;
  rep.isStrategy = isStrategy;

  // 2) chart-timeframe candles to rebuild higher-timeframe bars that were still forming
  const chartKey = `${ctx.market}:${ctx.symbol}:${ctx.tf}:${ctx.chartType}`;
  const chartMs = tfMs(ctx.tf);
  const bases: Record<string, BarSeries | null> = {};
  const need: string[] = [];
  for (const key of Object.keys(security)) {
    const kp = keyParts(key);
    if (!(tfMs(kp.tf) > chartMs)) continue; // same or lower timeframe: nothing forms across a chart bar
    // futures statistics have no forming value: a sample counts once its period is over
    if (kp.metric) {
      bases[key] = null;
      continue;
    }
    const bk = `${kp.market}:${kp.symbol}:${ctx.tf}:candles`;
    if (bk === chartKey) bases[key] = data;
    else if (security[bk]) bases[key] = security[bk];
    else need.push(bk);
  }
  if (need.length) return done({ need: [...new Set(need)] });

  // 3) replay
  const diffs = new Map<string, RepaintDiff>();
  const diff = (id: string, kind: RepaintDiff['kind'], title: string, time: number, live: string, history: string) => {
    const d = diffs.get(id);
    if (!d) diffs.set(id, { kind, title, count: 1, example: { time, live, history } });
    else {
      d.count++;
      if (time > d.example.time) d.example = { time, live, history };
    }
  };
  const bad: number[] = [];
  const deadline = t0 + (spec.budgetMs ?? 10000);
  const maxChecks = spec.maxChecks ?? 120;
  let from = Infinity;
  let to = -Infinity;
  for (const k of order) {
    if (rep.checked >= maxChecks || (rep.checked >= 8 && performance.now() > deadline)) break;
    if (spec.shouldStop?.()) throw new Error('Cancelled');
    const cut = data.tc[k];
    const sec: Record<string, BarSeries> = {};
    for (const [key, s] of Object.entries(security)) sec[key] = cutSeries(s, cut, bases[key], keyParts(key).chartType === 'heikinashi');
    const r = await host.run({ ...base, data: isStrategy ? truncateBars(data, k + 1) : withFormingBar(data, k), security: sec, realtime: !isStrategy, stateAt: isStrategy ? [k] : undefined });
    if (r.need.length) return done({ need: r.need });
    const T = r.result;
    const time = data.t[k];
    rep.checked++;
    from = Math.min(from, time);
    to = Math.max(to, time);
    let differs = false;
    if (!T.ok) {
      diff('error', 'error', 'Script error', time, errText(T), 'ran without error');
      bad.push(time);
      continue;
    }
    F.plots.forEach((pf, idx) => {
      if (!pf.display) return;
      const pt = T.plots[idx]?.id === pf.id ? T.plots[idx] : T.plots.find((x) => x.id === pf.id);
      if (!pt) return;
      const a = drawn(pt, k);
      const b = drawn(pf, k);
      const title = pf.title || pf.id;
      if (isShape(pf)) {
        if (shown(a) !== shown(b)) {
          diff(`p:${pf.id}`, 'plot', title, time, shown(a) ? 'shown' : 'not shown', shown(b) ? 'shown' : 'not shown');
          differs = true;
        }
        return;
      }
      const ohlc = pf.kind === 'candle' || pf.kind === 'bar';
      if (!same(a, b) || (ohlc && (!same(drawn(pt, k, pt.o), drawn(pf, k, pf.o)) || !same(drawn(pt, k, pt.h), drawn(pf, k, pf.h)) || !same(drawn(pt, k, pt.l), drawn(pf, k, pf.l))))) {
        const desc = (p: ScriptPlot, v: number) => (ohlc ? `O ${num(drawn(p, k, p.o))} H ${num(drawn(p, k, p.h))} L ${num(drawn(p, k, p.l))} C ${num(v)}` : num(v));
        diff(`p:${pf.id}`, 'plot', title, time, desc(pt, a), desc(pf, b));
        differs = true;
      }
    });
    F.alerts.forEach((af, idx) => {
      const at = T.alerts[idx];
      if (!at) return;
      const a = !!at.values[k];
      const b = !!af.values[k];
      if (a !== b) {
        diff(`a:${idx}`, 'alert', af.title, time, a ? 'fires' : 'does not fire', b ? 'fires' : 'does not fire');
        differs = true;
      }
    });
    const sf = F.strategy?.states?.[k];
    const st = T.strategy?.states?.[k];
    if (sf && st && !sameState(st, sf)) {
      diff('s', 'strategy', 'Position and orders', time, describeState(st), describeState(sf));
      differs = true;
    }
    if (differs) bad.push(time);
  }
  rep.from = Number.isFinite(from) ? from : NaN;
  rep.to = Number.isFinite(to) ? to : NaN;
  const order2: Record<RepaintDiff['kind'], number> = { strategy: 0, error: 1, alert: 2, plot: 3 };
  rep.diffs = [...diffs.values()].sort((a, b) => order2[a.kind] - order2[b.kind] || b.count - a.count);
  rep.badTimes = bad.sort((a, b) => b - a).slice(0, 200);
  rep.ok = true;
  return done();
}
