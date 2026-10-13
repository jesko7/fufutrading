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
import type { BarSeries, RunContext, ScriptLanguage, ScriptResult, ScriptInputDef, ScriptWarning, ScriptError, StrategyRaw, TradeRec } from './types';
import { emptyResult } from './types';
import { makePatch, type ResultPatch } from './patch';
import { computeMetrics, type Metrics } from './backtest/metrics';
import type { CompactTrade } from './optimize/analysis';
import type { BrokerConfig, PendingSnap, TickProvider } from './backtest/broker';

export type { ResultPatch, PlotPatch } from './patch';
export { applyPatch, makePatch } from './patch';

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
  /** Live bot step (see PineRunOptions.bot). */
  bot?: boolean;
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
      return runPython(this.pyOpts(), { code: spec.code, data, ctx: spec.ctx, inputs: spec.inputs, strategy: spec.strategy, security, ticks: spec.ticks, debug: spec.debug, maxMs: spec.maxMs, bot: spec.bot });
    }
    let c;
    try {
      c = compileCached(spec.code);
    } catch (e) {
      return { result: emptyResult('pine', toScriptError(e)), need: [] };
    }
    const need = [...new Set(securityRequests(c, spec.inputs, spec.ctx).map((r) => r.key))].filter((k) => !security[k]);
    if (need.length) return { result: emptyResult('pine', { message: `Missing data: ${need.join(', ')}`, kind: 'runtime' }), need };
    const inst = new PineInstance(c, { data, ctx: spec.ctx, inputs: spec.inputs, security, strategy: spec.strategy, ticks: spec.ticks, maxMs: spec.maxMs, trace: spec.trace, upTo: spec.upTo, shouldStop: spec.shouldStop, bot: spec.bot });
    return { result: inst.run(), need: [] };
  }
}

export interface TrialSpec extends Omit<RunSpec, 'debug' | 'shouldStop' | 'trace' | 'upTo'> {
  /** First bar that counts (warm-up before it). */
  from: number;
  riskFree?: number;
}

export interface TrialResult {
  ok: boolean;
  error?: string;
  need: string[];
  metrics: Omit<Metrics, 'curves'> | null;
  trades: CompactTrade[];
  /** End-of-day equity from `from` on (for window/CSCV analytics). */
  daily: { t: number[]; eq: number[]; bar: number[] };
}

/** Run a strategy and reduce the result to what optimizers need (metrics, trades, daily equity). */
export async function runTrial(host: ScriptHost, spec: TrialSpec): Promise<TrialResult> {
  const { result, need } = await host.run(spec);
  if (need.length) return { ok: false, error: 'missing data', need, metrics: null, trades: [], daily: { t: [], eq: [], bar: [] } };
  if (!result.ok || !result.strategy) return { ok: false, error: result.error ? `${result.error.line ? `Line ${result.error.line}: ` : ''}${result.error.message}` : 'Not a strategy', need: [], metrics: null, trades: [], daily: { t: [], eq: [], bar: [] } };
  const data = spec.data as BarSeries;
  const m = computeMetrics(result.strategy, data, { from: spec.from, riskFree: spec.riskFree });
  const { curves, ...metrics } = m;
  const daily = { t: [] as number[], eq: [] as number[], bar: [] as number[] };
  const ct = curves.t;
  for (let k = 0; k < ct.length; k++) {
    const day = Math.floor(ct[k] / 86400000);
    const next = k + 1 < ct.length ? Math.floor(ct[k + 1] / 86400000) : NaN;
    if (day !== next) {
      daily.t.push(ct[k]);
      daily.eq.push(curves.equity[k]);
      daily.bar.push(spec.from + k);
    }
  }
  const trades = result.strategy.trades.filter((t) => t.exitBar >= spec.from).map((t) => ({ entryBar: t.entryBar, exitBar: t.exitBar, returnPct: t.returnPct, profit: t.profit, dir: t.dir }));
  return { ok: true, need: [], metrics, trades, daily };
}

export interface BotStepSpec extends Omit<RunSpec, 'debug' | 'trace' | 'upTo' | 'bot'> {
  /** Report trades, fills, logs and alerts from this time on (ms). */
  since: number;
}

/** What a live bot needs from one strategy run over the closed bars. */
export interface BotStepResult {
  ok: boolean;
  error?: string;
  errorLine?: number;
  need: string[];
  title: string;
  isStrategy: boolean;
  bars: number;
  ms: number;
  lastBarTime: number;
  lastClose: number;
  /** Simulated position after market orders of the last bar filled at its close. */
  position: number;
  avgPrice: number;
  equity: number;
  initialCapital: number;
  netProfit: number;
  openProfit: number;
  feesPaid: number;
  openTrades: StrategyRaw['openTrades'];
  pending: PendingSnap[];
  trades: TradeRec[];
  tradesTotal: number;
  fills: StrategyRaw['fills'];
  logs: ScriptResult['logs'];
  alerts: ScriptResult['alertEvents'];
  warnings: string[];
  /** Plot values on the last closed bar (the strategy's indicators). */
  values: { title: string; value: number; prev: number; color: string }[];
}

/** Run a strategy over closed bars for a live bot and reduce the result to its current state. */
export async function botStep(host: ScriptHost, spec: BotStepSpec): Promise<BotStepResult> {
  const data = (spec.data instanceof Float64Array ? fromPacked(spec.data, spec.ctx.tf, spec.ctx.chartType) : spec.data) as BarSeries;
  const n = data.length;
  const base: BotStepResult = { ok: false, need: [], title: '', isStrategy: false, bars: n, ms: 0, lastBarTime: n ? data.t[n - 1] : 0, lastClose: n ? data.c[n - 1] : NaN, position: 0, avgPrice: NaN, equity: NaN, initialCapital: 0, netProfit: 0, openProfit: 0, feesPaid: 0, openTrades: [], pending: [], trades: [], tradesTotal: 0, fills: [], logs: [], alerts: [], warnings: [], values: [] };
  const { result, need } = await host.run({ ...spec, data, bot: true });
  base.need = need;
  base.title = result.meta?.title || '';
  base.ms = result.stats?.ms || 0;
  const timeOf = (bar: number) => (bar >= 0 && bar < n ? data.t[bar] : 0);
  base.logs = result.logs.map((l) => ({ ...l, time: l.time || timeOf(l.bar) })).filter((l) => l.time >= spec.since).slice(-200);
  base.alerts = result.alertEvents.filter((a) => (a.time || timeOf(a.bar)) >= spec.since).slice(-100);
  base.warnings = result.warnings.map((w) => w.message).slice(0, 20);
  if (need.length) {
    base.error = 'missing data';
    return base;
  }
  if (!result.ok) {
    base.error = result.error?.message || 'Script error';
    base.errorLine = result.error?.line;
    return base;
  }
  const st = result.strategy;
  base.isStrategy = !!st;
  if (!st) {
    base.error = `"${base.title}" is an indicator — bots need a strategy (strategy() in Pine, @strategy in Python).`;
    return base;
  }
  base.ok = true;
  base.position = st.position ?? 0;
  base.avgPrice = st.avgPrice ?? NaN;
  base.initialCapital = st.initialCapital;
  base.feesPaid = st.feesPaid;
  base.openTrades = st.openTrades;
  base.pending = st.pending || [];
  const eq = st.equity;
  let last = NaN;
  for (let i = Math.min(eq.length, n) - 1; i >= 0; i--) {
    if (eq[i] === eq[i]) {
      last = eq[i];
      break;
    }
  }
  base.equity = last;
  base.netProfit = st.trades.reduce((s, t) => s + t.profit, 0);
  const lc = base.lastClose;
  base.openProfit = st.openTrades.reduce((s, t) => s + (lc - t.entryPrice) * t.qty * t.dir, 0);
  base.tradesTotal = st.trades.length;
  base.trades = st.trades.filter((t) => t.exitTime >= spec.since).slice(-300);
  base.fills = st.fills.filter((f) => f.t >= spec.since).slice(-300);
  for (const p of result.plots) {
    if (p.kind !== 'plot' || !p.display) continue;
    const v = p.values;
    base.values.push({ title: p.title || p.id, value: n ? v[n - 1] : NaN, prev: n > 1 ? v[n - 2] : NaN, color: (p.colors && p.colors[n - 1]) || p.color });
    if (base.values.length >= 24) break;
  }
  return base;
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
