/**
 * ScriptHost — executes Pine Script and Python for one worker thread:
 *  - analysis (metadata, inputs, warnings, data dependencies, outline),
 *  - live instances for charts/alerts that follow bar deltas and answer with result patches
 *    (only the changed tail of each output is shipped),
 *  - one-shot runs (backtests, optimizer trials).
 * Pure logic: no worker_threads dependency, so it is unit-tested directly.
 */
import { PineInstance, analyzePine, compileCached, securityRequests, toScriptError } from './pine';
import { runPython, analyzePython, type PyInitOptions, type DebugControl } from './python/host';
import { LiveBars, fromPacked } from './data';
import type { BarSeries, RunContext, ScriptLanguage, ScriptResult, ScriptInputDef, ScriptWarning, ScriptError } from './types';
import { emptyResult } from './types';
import type { BrokerConfig, TickProvider } from './backtest/broker';

export interface AnalyzeResult {
  ok: boolean;
  language: ScriptLanguage;
  error?: ScriptError;
  meta?: { type: 'indicator' | 'strategy'; title: string; shortTitle: string; overlay: boolean; precision?: number };
  inputs: ScriptInputDef[];
  warnings: ScriptWarning[];
  /** Pine: data keys needed by request.security (with default inputs). */
  security: string[];
  /** Outline for the editor (Pine): user functions and global variables with lines. */
  functions?: { name: string; line: number; params: string[] }[];
  variables?: { name: string; line: number; type?: string }[];
  version?: number;
}

export interface InstanceSpec {
  lang: ScriptLanguage;
  code: string;
  ctx: RunContext;
  inputs: Record<string, unknown>;
  /** Broker overrides for strategies; null runs a strategy script without orders (plots only). */
  strategy?: Partial<BrokerConfig> | null;
  /** Packed bars (shared/candles STRIDE layout). */
  bars: Float64Array;
  /** The last bar is still forming (live chart). Strategies then only process closed bars. */
  realtime: boolean;
  /** Other symbols/timeframes by key "market:SYMBOL:tf:chartType" (packed). */
  security?: Record<string, Float64Array>;
  trace?: boolean;
}

export interface BarsDelta {
  index: number;
  packed: Float64Array;
  length: number;
}

export interface InstanceUpdate {
  bars?: BarsDelta;
  /** Replace all bars (history reloaded). */
  reset?: Float64Array;
  security?: Record<string, BarsDelta>;
  securityFull?: Record<string, Float64Array>;
  inputs?: Record<string, unknown>;
  strategy?: Partial<BrokerConfig> | null;
  realtime?: boolean;
}

export interface PlotPatch {
  values: Float64Array;
  colors: (string | null)[] | null;
  o?: Float64Array;
  h?: Float64Array;
  l?: Float64Array;
}

/** Changed tail of a result: outputs from index `from` on; objects (labels, lines…) in full. */
export interface ResultPatch {
  from: number;
  n: number;
  t0: number;
  ok: boolean;
  error?: ScriptError;
  plots: PlotPatch[];
  bgcolors: (string | null)[] | null;
  barcolors: (string | null)[] | null;
  alerts: Uint8Array[];
  labels: ScriptResult['labels'];
  lines: ScriptResult['lines'];
  boxes: ScriptResult['boxes'];
  tables: ScriptResult['tables'];
  alertEvents: ScriptResult['alertEvents'];
  logs: ScriptResult['logs'];
  warnings: ScriptResult['warnings'];
  strategy?: ScriptResult['strategy'];
  stats: ScriptResult['stats'];
}

export type InstanceReply =
  | { kind: 'full'; result: ScriptResult; t0: number; need: string[] }
  | { kind: 'patch'; patch: ResultPatch; need: string[] }
  | { kind: 'none'; need: string[] };

export interface RunSpec {
  lang: ScriptLanguage;
  code: string;
  ctx: RunContext;
  inputs: Record<string, unknown>;
  strategy?: Partial<BrokerConfig> | null;
  data: BarSeries | Float64Array;
  security?: Record<string, BarSeries | Float64Array>;
  ticks?: TickProvider;
  maxMs?: number;
  trace?: boolean;
  upTo?: number;
  debug?: DebugControl;
  shouldStop?: () => boolean;
}

export function keyParts(key: string): { market: 'spot' | 'futures'; symbol: string; tf: string; chartType: string } {
  const [market, symbol, tf, chartType] = key.split(':');
  return { market: market === 'futures' ? 'futures' : 'spot', symbol, tf, chartType: chartType || 'candles' };
}

function toBars(x: BarSeries | Float64Array, tf: string, chartType: string): BarSeries {
  return x instanceof Float64Array ? fromPacked(x, tf, chartType) : x;
}

class Instance {
  bars: LiveBars;
  sec = new Map<string, LiveBars>();
  pine: PineInstance | null = null;
  last: ScriptResult | null = null;
  lastT0 = NaN;
  lastN = 0;
  strategyMode = false;
  /** closed-bar count the last strategy run used */
  closedRun = -1;

  constructor(public spec: InstanceSpec) {
    this.bars = new LiveBars(spec.bars, spec.ctx.tf, spec.ctx.chartType);
    for (const [k, p] of Object.entries(spec.security || {})) {
      const kp = keyParts(k);
      this.sec.set(k, new LiveBars(p, kp.tf, kp.chartType));
    }
    spec.bars = new Float64Array(0);
    spec.security = undefined;
  }

  securityBars(): Record<string, BarSeries> {
    const r: Record<string, BarSeries> = {};
    for (const [k, b] of this.sec) r[k] = b.bars();
    return r;
  }

  data(): BarSeries {
    return this.strategyMode && this.spec.realtime ? this.bars.closedBars() : this.bars.bars();
  }
}

function sameStructure(a: ScriptResult, b: ScriptResult): boolean {
  if (a.ok !== b.ok || a.plots.length !== b.plots.length || a.alerts.length !== b.alerts.length) return false;
  if (a.meta.title !== b.meta.title || a.meta.overlay !== b.meta.overlay || a.meta.type !== b.meta.type) return false;
  if ((a.bgcolors === null) !== (b.bgcolors === null) || (a.barcolors === null) !== (b.barcolors === null)) return false;
  if (a.inputs.length !== b.inputs.length || a.hlines.length !== b.hlines.length || a.fills.length !== b.fills.length) return false;
  for (let k = 0; k < a.plots.length; k++) {
    const p = a.plots[k];
    const q = b.plots[k];
    if (p.id !== q.id || p.kind !== q.kind || p.style !== q.style || p.color !== q.color || (p.colors === null) !== (q.colors === null)) return false;
  }
  for (let k = 0; k < a.hlines.length; k++) if (a.hlines[k].price !== b.hlines[k].price || a.hlines[k].color !== b.hlines[k].color) return false;
  return true;
}

const eqNum = (x: number, y: number) => x === y || (x !== x && y !== y);

/** First index where outputs differ (scan). */
function firstDiff(a: ScriptResult, b: ScriptResult, upTo: number): number {
  let from = upTo;
  for (let k = 0; k < a.plots.length; k++) {
    const p = a.plots[k].values;
    const q = b.plots[k].values;
    const m = Math.min(from, p.length, q.length);
    for (let i = 0; i < m; i++)
      if (!eqNum(p[i], q[i])) {
        from = i;
        break;
      }
    const pc = a.plots[k].colors;
    const qc = b.plots[k].colors;
    if (pc && qc) {
      const mc = Math.min(from, pc.length, qc.length);
      for (let i = 0; i < mc; i++)
        if (pc[i] !== qc[i]) {
          from = i;
          break;
        }
    }
  }
  for (const [x, y] of [
    [a.bgcolors, b.bgcolors],
    [a.barcolors, b.barcolors],
  ] as const) {
    if (!x || !y) continue;
    const m = Math.min(from, x.length, y.length);
    for (let i = 0; i < m; i++)
      if (x[i] !== y[i]) {
        from = i;
        break;
      }
  }
  for (let k = 0; k < a.alerts.length; k++) {
    const x = a.alerts[k].values;
    const y = b.alerts[k].values;
    const m = Math.min(from, x.length, y.length);
    for (let i = 0; i < m; i++)
      if (x[i] !== y[i]) {
        from = i;
        break;
      }
  }
  return from;
}

export function makePatch(r: ScriptResult, from: number, t0: number): ResultPatch {
  const n = r.stats.bars;
  const f = Math.max(0, Math.min(from, n));
  return {
    from: f,
    n,
    t0,
    ok: r.ok,
    error: r.error,
    plots: r.plots.map((p) => ({ values: p.values.slice(f), colors: p.colors ? p.colors.slice(f) : null, o: p.o?.slice(f), h: p.h?.slice(f), l: p.l?.slice(f) })),
    bgcolors: r.bgcolors ? r.bgcolors.slice(f) : null,
    barcolors: r.barcolors ? r.barcolors.slice(f) : null,
    alerts: r.alerts.map((a) => a.values.slice(f)),
    labels: r.labels,
    lines: r.lines,
    boxes: r.boxes,
    tables: r.tables,
    alertEvents: r.alertEvents,
    logs: r.logs.slice(-300),
    warnings: r.warnings,
    strategy: r.strategy,
    stats: r.stats,
  };
}

/** Apply a patch to a full result (used by consumers that keep a full copy). */
export function applyPatch(r: ScriptResult, p: ResultPatch): ScriptResult {
  const f = p.from;
  const join = (a: Float64Array | undefined, tail: Float64Array | undefined): Float64Array | undefined => {
    if (!tail) return a;
    const out = new Float64Array(f + tail.length);
    if (a) out.set(a.subarray(0, Math.min(f, a.length)));
    if (a && a.length < f) out.fill(NaN, a.length, f);
    out.set(tail, f);
    return out;
  };
  const joinArr = <T>(a: T[] | null, tail: T[] | null): T[] | null => (tail ? (a || []).slice(0, f).concat(tail) : a);
  return {
    ...r,
    ok: p.ok,
    error: p.error,
    plots: r.plots.map((pl, k) => {
      const t = p.plots[k];
      if (!t) return pl;
      return { ...pl, values: join(pl.values, t.values)!, colors: joinArr(pl.colors, t.colors), o: join(pl.o, t.o), h: join(pl.h, t.h), l: join(pl.l, t.l) };
    }),
    bgcolors: joinArr(r.bgcolors, p.bgcolors),
    barcolors: joinArr(r.barcolors, p.barcolors),
    alerts: r.alerts.map((a, k) => {
      const t = p.alerts[k];
      if (!t) return a;
      const out = new Uint8Array(f + t.length);
      out.set(a.values.subarray(0, Math.min(f, a.values.length)));
      out.set(t, f);
      return { ...a, values: out };
    }),
    labels: p.labels,
    lines: p.lines,
    boxes: p.boxes,
    tables: p.tables,
    alertEvents: p.alertEvents,
    logs: p.logs,
    warnings: p.warnings,
    strategy: p.strategy ?? r.strategy,
    stats: p.stats,
  };
}

export class ScriptHost {
  private instances = new Map<string, Instance>();

  constructor(private py: PyInitOptions | null) {}

  get size(): number {
    return this.instances.size;
  }

  private pyOpts(): PyInitOptions {
    if (!this.py) throw new Error('Python is not available in this build');
    return this.py;
  }

  async analyze(lang: ScriptLanguage, code: string, ctx?: RunContext): Promise<AnalyzeResult> {
    if (lang === 'python') {
      const a = await analyzePython(this.pyOpts(), code);
      if (!a.ok) return { ok: false, language: lang, error: a.error, inputs: [], warnings: [], security: [] };
      return { ok: true, language: lang, meta: { type: a.meta!.type, title: a.meta!.title, shortTitle: a.meta!.shortTitle || a.meta!.title, overlay: !!a.meta!.overlay, precision: a.meta!.precision ?? undefined }, inputs: a.inputs || [], warnings: pythonWarnings(code), security: [] };
    }
    const a = analyzePine(code);
    if (!a.ok) return { ok: false, language: lang, error: a.error, inputs: [], warnings: [], security: [] };
    let security: string[] = [];
    if (ctx) {
      try {
        security = [...new Set(securityRequests(compileCached(code), {}, ctx).map((r) => r.key))];
      } catch (e) {
        return { ok: false, language: lang, error: toScriptError(e), inputs: [], warnings: [], security: [] };
      }
    }
    const m = a.meta!;
    return {
      ok: true,
      language: lang,
      meta: { type: m.type === 'strategy' ? 'strategy' : 'indicator', title: m.title, shortTitle: m.shortTitle, overlay: m.overlay, precision: m.precision },
      inputs: (a.inputs || []).map((i) => ({ key: i.key, type: i.type, title: i.title, defval: i.defval, min: i.min, max: i.max, step: i.step, options: i.options, tooltip: i.tooltip, group: i.group, inline: i.inline })) as ScriptInputDef[],
      warnings: (a.warnings || []).map((w) => ({ line: w.line, message: w.message, kind: w.kind })),
      security,
      functions: a.functions as AnalyzeResult['functions'],
      variables: a.variables as AnalyzeResult['variables'],
      version: a.version,
    };
  }

  // ------------------------------------------------------------------ live instances

  async open(id: string, spec: InstanceSpec): Promise<InstanceReply> {
    this.close(id);
    const inst = new Instance(spec);
    this.instances.set(id, inst);
    return this.execute(inst, { rebuild: true, from: 0 });
  }

  async update(id: string, u: InstanceUpdate): Promise<InstanceReply> {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Unknown script instance ${id}`);
    let rebuild = false;
    let from = Infinity;
    let secChanged = false;
    if (u.reset) {
      inst.bars = new LiveBars(u.reset, inst.spec.ctx.tf, inst.spec.ctx.chartType);
      rebuild = true;
      from = 0;
    }
    if (u.bars) from = Math.min(from, inst.bars.apply(u.bars.index, u.bars.packed, u.bars.length));
    for (const [k, p] of Object.entries(u.securityFull || {})) {
      const kp = keyParts(k);
      inst.sec.set(k, new LiveBars(p, kp.tf, kp.chartType));
      secChanged = true;
      rebuild = true;
    }
    for (const [k, d] of Object.entries(u.security || {})) {
      const b = inst.sec.get(k);
      if (!b) continue;
      b.apply(d.index, d.packed, d.length);
      secChanged = true;
    }
    if (u.inputs) {
      inst.spec.inputs = u.inputs;
      rebuild = true;
    }
    if (u.strategy !== undefined) {
      inst.spec.strategy = u.strategy;
      rebuild = true;
    }
    if (u.realtime !== undefined && u.realtime !== inst.spec.realtime) {
      inst.spec.realtime = u.realtime;
      rebuild = true;
    }
    if (!rebuild && from === Infinity && !secChanged) return { kind: 'none', need: [] };
    return this.execute(inst, { rebuild, from: from === Infinity ? inst.lastN : from, secChanged });
  }

  close(id: string): void {
    this.instances.delete(id);
  }

  private pyTypes = new Map<string, 'indicator' | 'strategy' | 'error'>();

  private async pyType(code: string): Promise<'indicator' | 'strategy' | 'error'> {
    let t = this.pyTypes.get(code);
    if (!t) {
      const a = await analyzePython(this.pyOpts(), code);
      t = a.ok ? a.meta!.type : 'error';
      if (this.pyTypes.size > 50) this.pyTypes.clear();
      this.pyTypes.set(code, t);
    }
    return t;
  }

  closeAll(): void {
    this.instances.clear();
  }

  private async execute(inst: Instance, o: { rebuild: boolean; from: number; secChanged?: boolean }): Promise<InstanceReply> {
    const spec = inst.spec;
    const t0bars = inst.bars.length ? inst.bars.cs.t[0] : NaN;
    let res: ScriptResult;
    let need: string[] = [];
    let hint = -1; // known first changed index (Pine incremental)
    if (spec.lang === 'pine') {
      let c;
      try {
        c = compileCached(spec.code);
      } catch (e) {
        res = emptyResult('pine', toScriptError(e));
        return this.reply(inst, res, t0bars, [], -1);
      }
      inst.strategyMode = c.meta.type === 'strategy' && spec.strategy !== null;
      try {
        need = [...new Set(securityRequests(c, spec.inputs, spec.ctx).map((r) => r.key))].filter((k) => !inst.sec.has(k));
      } catch (e) {
        return this.reply(inst, emptyResult('pine', toScriptError(e)), t0bars, [], -1);
      }
      if (need.length) {
        const r = emptyResult('pine');
        r.meta = { type: c.meta.type === 'strategy' ? 'strategy' : 'indicator', title: c.meta.title, shortTitle: c.meta.shortTitle, overlay: c.meta.overlay, precision: c.meta.precision };
        r.warnings.push({ message: `Loading ${need.join(', ')}…`, kind: 'info' });
        inst.pine = null;
        inst.last = null;
        return { kind: 'full', result: r, t0: t0bars, need };
      }
      const data = inst.data();
      if (inst.strategyMode) {
        // strategies run on closed bars only and fully re-run when a bar closes
        if (!o.rebuild && !o.secChanged && inst.closedRun === data.length && inst.last) return { kind: 'none', need: [] };
        inst.closedRun = data.length;
        inst.pine = new PineInstance(c, { data, ctx: spec.ctx, inputs: spec.inputs, security: inst.securityBars(), strategy: spec.strategy, realtime: false, trace: spec.trace });
        res = inst.pine.run();
      } else if (o.rebuild || !inst.pine || inst.pine.error || o.from < inst.lastN - 1) {
        inst.pine = new PineInstance(c, { data, ctx: spec.ctx, inputs: spec.inputs, security: inst.securityBars(), strategy: null, realtime: spec.realtime, trace: spec.trace });
        res = inst.pine.run();
      } else {
        const oldN = inst.lastN;
        res = inst.pine.update(data, o.secChanged ? inst.securityBars() : undefined);
        hint = Math.max(0, Math.min(o.from, oldN - 1));
      }
    } else {
      const type = await this.pyType(spec.code);
      inst.strategyMode = type === 'strategy' && spec.strategy !== null;
      const data = inst.data();
      if (inst.strategyMode) {
        // strategies run on closed bars only and fully re-run when a bar closes
        if (!o.rebuild && !o.secChanged && inst.closedRun === data.length && inst.last) return { kind: 'none', need: [] };
        inst.closedRun = data.length;
      }
      const r = await runPython(this.pyOpts(), { code: spec.code, data, ctx: spec.ctx, inputs: spec.inputs, strategy: spec.strategy, security: inst.securityBars() });
      res = r.result;
      need = r.need.filter((k) => !inst.sec.has(k));
    }
    return this.reply(inst, res, t0bars, need, hint);
  }

  private reply(inst: Instance, res: ScriptResult, t0: number, need: string[], hint: number): InstanceReply {
    const prev = inst.last;
    const n = res.stats.bars;
    const full = !prev || !sameStructure(prev, res) || !eqNum(inst.lastT0, t0) || n < inst.lastN - 1;
    inst.last = res;
    const prevN = inst.lastN;
    inst.lastN = n;
    inst.lastT0 = t0;
    if (full) return { kind: 'full', result: res, t0, need };
    const from = hint >= 0 ? hint : firstDiff(prev!, res, Math.min(prevN, n));
    return { kind: 'patch', patch: makePatch(res, from, t0), need };
  }

  // ------------------------------------------------------------------ one-shot runs

  async run(spec: RunSpec): Promise<{ result: ScriptResult; need: string[] }> {
    const data = toBars(spec.data, spec.ctx.tf, spec.ctx.chartType);
    const security: Record<string, BarSeries> = {};
    for (const [k, v] of Object.entries(spec.security || {})) {
      const kp = keyParts(k);
      security[k] = toBars(v, kp.tf, kp.chartType);
    }
    if (spec.lang === 'python') {
      return runPython(this.pyOpts(), { code: spec.code, data, ctx: spec.ctx, inputs: spec.inputs, strategy: spec.strategy, security, ticks: spec.ticks, debug: spec.debug, maxMs: spec.maxMs });
    }
    let c;
    try {
      c = compileCached(spec.code);
    } catch (e) {
      return { result: emptyResult('pine', toScriptError(e)), need: [] };
    }
    const need = [...new Set(securityRequests(c, spec.inputs, spec.ctx).map((r) => r.key))].filter((k) => !security[k]);
    if (need.length) return { result: emptyResult('pine', { message: `Missing data: ${need.join(', ')}`, kind: 'runtime' }), need };
    const inst = new PineInstance(c, { data, ctx: spec.ctx, inputs: spec.inputs, security, strategy: spec.strategy, ticks: spec.ticks, maxMs: spec.maxMs, trace: spec.trace, upTo: spec.upTo, shouldStop: spec.shouldStop });
    return { result: inst.run(), need: [] };
  }
}

/** Static checks for common Python lookahead/repaint pitfalls (heuristic, line-based). */
export function pythonWarnings(code: string): ScriptWarning[] {
  const out: ScriptWarning[] = [];
  const lines = code.split(/\r?\n/);
  lines.forEach((ln, k) => {
    const s = ln.replace(/#.*$/, '');
    if (/lookahead\s*=\s*True/.test(s)) out.push({ line: k + 1, kind: 'lookahead', message: 'lookahead=True reads higher-timeframe values before that bar closed — backtest results will be unrealistically good.' });
    if (/\.shift\(\s*-\d/.test(s) || /np\.roll\([^)]*,\s*-\d/.test(s)) out.push({ line: k + 1, kind: 'lookahead', message: 'Negative shift/roll moves future values onto earlier bars (lookahead).' });
    if (/\[\s*[^\]]*\+\s*1\s*\]/.test(s) && /self\.bar|_ctx\.i/.test(s)) out.push({ line: k + 1, kind: 'lookahead', message: 'Indexing at bar + 1 reads the next (future) bar.' });
    if (/_cols\[/.test(s)) out.push({ line: k + 1, kind: 'lookahead', message: 'data._cols holds full arrays including future bars; use data.close etc. inside next().' });
  });
  return out;
}
