/**
 * Python host (runs inside a worker thread): Pyodide with NumPy, the `fufu` API and the
 * `fufu_js` bridge. Technical-analysis calls run the same JavaScript implementations as Pine,
 * and strategies are driven bar-by-bar from JavaScript with the same StrategyBroker, so both
 * languages produce identical numbers and identical fills.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as TA from '../pine/builtins/ta';
import { Series, type BarData, type Runtime } from '../pine/runtime';
import { mapSecurity, brokerRaw } from '../pine/index';
import { StrategyBroker, type BrokerConfig, type TickProvider } from '../backtest/broker';
import type { BarSeries, RunContext, ScriptResult, ScriptError, ScriptInputDef } from '../types';
import { emptyResult } from '../types';
import type { SymbolId } from '../../shared/symbols';

export interface PyInitOptions {
  /** Directory of the pyodide npm package (pyodide.js, *.wasm, python_stdlib.zip, lock file). */
  pyodideDir: string;
  /** Writable cache for downloaded wheels (numpy). */
  cacheDir: string;
  /** Directory with fufu.py and fufu_runner.py. */
  pythonDir: string;
  /** Optional directory with bundled wheels copied into cacheDir (offline first start). */
  bundledWheels?: string;
}

export interface DebugControl {
  /** Int32Array over a SharedArrayBuffer: [0]=paused flag, [1]=command, [2..]=breakpoint lines (0-terminated). */
  ctrl: Int32Array;
  breakpoints: number[];
  breakOnNext: boolean;
  onPause: (snapshot: unknown, reason: string) => void;
}

export const DEBUG_CMD = { continue: 1, step: 2, over: 3, out: 4, stop: 5 } as const;
const CMD_NAME: Record<number, string> = { 1: 'continue', 2: 'step', 3: 'over', 4: 'out', 5: 'stop' };

export interface PyAnalysis {
  ok: boolean;
  error?: ScriptError;
  meta?: { type: 'indicator' | 'strategy'; title: string; shortTitle: string; overlay: boolean; precision?: number; scale?: [number, number] | null; options?: Record<string, unknown> };
  inputs?: ScriptInputDef[];
}

let py: any = null;
let initPromise: Promise<any> | null = null;
let currentData: BarSeries | null = null;
let stdoutBuf: string[] = [];

export function pythonReady(): boolean {
  return !!py;
}

function toF64(x: any): Float64Array {
  if (x instanceof Float64Array) return x;
  if (x && typeof x.getBuffer === 'function') {
    const b = x.getBuffer('f64');
    try {
      return new Float64Array(b.data);
    } finally {
      b.release();
    }
  }
  if (x instanceof Uint8Array) return new Float64Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
  if (Array.isArray(x)) return Float64Array.from(x);
  if (x && typeof x.toJs === 'function') return toF64(x.toJs());
  throw new Error('Expected a numeric array');
}

const TUPLE3 = new Set(['macd', 'bb', 'kc', 'dmi']);

/** Run a stateful TA function over whole arrays (same implementation and semantics as Pine's ta.*). */
export function vecTa(name: string, inputs: Float64Array[], params: unknown[], data: BarSeries): Float64Array | Float64Array[] {
  const n = inputs.length ? inputs[0].length : data.length;
  const rt = {
    i: 0,
    d: data as unknown as BarData,
    newSeries: () => new Series(256),
    bool: (x: unknown) => (typeof x === 'number' ? x !== 0 && x === x : !!x),
  } as unknown as Runtime;
  const st: any = {};
  const src = inputs[0];
  const p = params.map((x) => (x === true ? 1 : x === false ? 0 : x)) as number[];
  const tupleN = TUPLE3.has(name) ? 3 : name === 'supertrend' ? 2 : 0;
  const outs = Array.from({ length: Math.max(1, tupleN) }, () => new Float64Array(n).fill(NaN));
  const fn = (TA as any)[name];
  if (typeof fn !== 'function') throw new Error(`ta.${name} is not available`);
  for (let i = 0; i < n; i++) {
    (rt as any).i = i;
    let v: any;
    switch (name) {
      case 'atr':
      case 'wpr':
        v = fn(st, rt, p[0]);
        break;
      case 'tr':
        v = TA.tr(rt, !!p[0]);
        break;
      case 'sar':
        v = TA.sar(st, rt, p[0], p[1], p[2]);
        break;
      case 'supertrend':
      case 'dmi':
        v = fn(st, rt, p[0], p[1]);
        break;
      case 'obv':
        v = TA.obv(st, rt);
        break;
      case 'correlation':
        v = TA.correlation(st, rt, src[i], inputs[1][i], p[0]);
        break;
      case 'stoch':
        v = TA.stoch(st, rt, src[i], inputs[1][i], inputs[2][i], p[0]);
        break;
      case 'valuewhen':
        v = TA.valuewhen(st, rt, src[i], inputs[1][i], p[0]);
        break;
      default:
        v = fn(st, rt, src[i], ...p);
    }
    if (tupleN) for (let k = 0; k < tupleN; k++) outs[k][i] = v[k];
    else outs[0][i] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as number);
  }
  return tupleN ? outs : outs[0];
}

function copyBundledWheels(from: string | undefined, to: string): void {
  if (!from || !fs.existsSync(from)) return;
  for (const f of fs.readdirSync(from)) {
    if (!f.endsWith('.whl')) continue;
    const dst = path.join(to, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(from, f), dst);
  }
}

export async function initPython(opts: PyInitOptions): Promise<any> {
  if (py) return py;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    fs.mkdirSync(opts.cacheDir, { recursive: true });
    copyBundledWheels(opts.bundledWheels, opts.cacheDir);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadPyodide } = require(path.join(opts.pyodideDir, 'pyodide.js'));
    const p = await loadPyodide({
      indexURL: opts.pyodideDir + path.sep,
      packageCacheDir: opts.cacheDir,
      stdout: (s: string) => stdoutBuf.push(s),
      stderr: (s: string) => stdoutBuf.push(s),
    });
    const errs: string[] = [];
    await p.loadPackage('numpy', { messageCallback: () => {}, errorCallback: (m: string) => errs.push(m) });
    try {
      p.pyimport('numpy');
    } catch {
      throw new Error(`NumPy could not be loaded${errs.length ? `: ${errs.join('; ')}` : ''}. The first Python run needs internet access to download NumPy (cached afterwards).`);
    }
    p.FS.mkdirTree('/fufu');
    for (const f of ['fufu.py', 'fufu_runner.py']) p.FS.writeFile(`/fufu/${f}`, fs.readFileSync(path.join(opts.pythonDir, f), 'utf8'));
    p.registerJsModule('fufu_js', {
      vec_ta: (name: string, arrays: any, params: any) => {
        const ins = (arrays && typeof arrays.toJs === 'function' ? arrays.toJs({ create_proxies: false }) : arrays) as any[];
        const ps = params && typeof params.toJs === 'function' ? params.toJs({ create_proxies: false }) : params || [];
        arrays?.destroy?.();
        params?.destroy?.();
        if (!currentData) throw new Error('fufu.ta can only be used while a script runs');
        return vecTa(String(name), ins.map(toF64), ps, currentData);
      },
      map_htf: (t: any, tc: any, ht: any, htc: any, values: any, lookahead: boolean) => {
        const chartT = toF64(t);
        const chart = { t: chartT, tc: toF64(tc), length: chartT.length } as unknown as BarSeries;
        const ctxT = toF64(ht);
        const ctxB = { t: ctxT, tc: toF64(htc), length: ctxT.length } as unknown as BarSeries;
        const vals = Array.from(toF64(values));
        for (const x of [t, tc, ht, htc, values]) x?.destroy?.();
        const m = mapSecurity(chart, ctxB, vals, { lookahead: !!lookahead, gaps: false, lowerTf: false, realtime: false });
        const out = new Float64Array(m.length);
        for (let i = 0; i < m.length; i++) out[i] = typeof m[i] === 'number' ? (m[i] as number) : NaN;
        return out;
      },
    });
    p.runPython('import sys\nif "/fufu" not in sys.path: sys.path.insert(0, "/fufu")\nimport fufu, fufu_runner');
    py = p;
    return p;
  })();
  try {
    return await initPromise;
  } catch (e) {
    initPromise = null;
    throw e;
  }
}

/** Convert a PyProxy result into plain JS (and free it). */
function pyToJs(x: any): any {
  if (x && typeof x.toJs === 'function') {
    try {
      return x.toJs({ dict_converter: Object.fromEntries, create_proxies: false });
    } finally {
      x.destroy?.();
    }
  }
  return x;
}

/** Strip null/undefined values (Pyodide maps JS null to JsNull, which Python code doesn't expect). */
function clean(o: Record<string, unknown> | undefined): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== null && v !== undefined) r[k] = v;
  return r;
}

function dataDict(d: BarSeries): Record<string, Float64Array> {
  return { time: d.t, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v, tbv: d.tbv || new Float64Array(d.length), tc: d.tc };
}

function errFrom(p: any): ScriptError {
  const kind = p?.kind === 'syntax' ? 'syntax' : p?.kind === 'compile' ? 'compile' : 'python';
  return { message: p?.message || 'Python error', line: p?.line ?? undefined, col: p?.col ?? undefined, kind, traceback: p?.traceback || undefined };
}

function inputsFrom(list: any[]): ScriptInputDef[] {
  return (list || []).map((i: any) => ({
    key: i.key,
    type: i.type,
    title: i.title,
    defval: i.defval,
    min: i.min ?? undefined,
    max: i.max ?? undefined,
    step: i.step ?? undefined,
    options: i.options ?? undefined,
    tooltip: i.tooltip ?? undefined,
    group: i.group ?? undefined,
  }));
}

export async function analyzePython(opts: PyInitOptions, code: string): Promise<PyAnalysis> {
  const p = await initPython(opts);
  const runner = p.globals.get('fufu_runner');
  try {
    const r = pyToJs(runner.analyze(code));
    if (!r.ok) return { ok: false, error: errFrom(r.error) };
    return { ok: true, meta: r.meta, inputs: inputsFrom(r.inputs) };
  } finally {
    runner.destroy?.();
  }
}

/** '#RRGGBB' / '#RRGGBBAA' → css color */
function hex(c: string | null | undefined): string | null {
  if (!c) return null;
  if (!c.startsWith('#') || (c.length !== 7 && c.length !== 9)) return c;
  const h = c.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

function bytesF64(b: any): Float64Array {
  return b instanceof Uint8Array ? new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : toF64(b);
}

function outputsToResult(res: ScriptResult, out: any, n: number): void {
  res.plots = (out.plots || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    kind: p.kind === 'shape' && p.style === 'char' ? 'char' : p.kind,
    style: p.style || 'line',
    color: hex(p.color) || '#2196F3',
    colors: p.colors ? (p.colors as (string | null)[]).map((c) => hex(c)) : null,
    values: bytesF64(p.values),
    width: p.width || 1,
    offset: p.offset || 0,
    histbase: p.histbase || 0,
    display: p.display !== false,
    trackPrice: false,
    location: p.location,
    text: p.text ?? undefined,
    char: p.char ?? undefined,
    size: p.size,
  }));
  res.hlines = (out.hlines || []).map((h: any) => ({ id: h.id, title: h.title, price: h.price, color: hex(h.color) || '#787B86', style: h.style || 'dashed', width: h.width || 1, display: true }));
  res.fills = (out.fills || []).map((f: any) => ({ a: f.a, b: f.b, color: hex(f.color) || 'rgba(33,150,243,0.2)', colors: f.colors ? f.colors.map((c: string | null) => hex(c)) : null }));
  res.bgcolors = out.bgcolors ? (out.bgcolors as (string | null)[]).map((c) => hex(c)) : null;
  res.barcolors = out.barcolors ? (out.barcolors as (string | null)[]).map((c) => hex(c)) : null;
  res.alerts = (out.alerts || []).map((a: any) => {
    const v = bytesF64(a.values);
    const u = new Uint8Array(n);
    for (let i = 0; i < n && i < v.length; i++) u[i] = v[i] && v[i] === v[i] ? 1 : 0;
    return { title: a.title, message: a.message, values: u };
  });
  res.logs = (out.logs || []).slice(-2000).map((l: any) => ({ bar: l.bar, time: 0, level: l.level, msg: l.msg }));
}

export interface PyRunOptions {
  code: string;
  data: BarSeries;
  ctx: RunContext;
  inputs: Record<string, unknown>;
  /** Broker settings merged over the script's @strategy options (strategies only). */
  strategy?: Partial<BrokerConfig> | null;
  ticks?: TickProvider;
  debug?: DebugControl;
  /** Other symbols / timeframes by key "market:SYMBOL:tf:candles". */
  security?: Record<string, BarSeries>;
  maxMs?: number;
  /** Live bot step: market orders created on the last bar fill at its close. */
  bot?: boolean;
}

export interface PyRunResult {
  result: ScriptResult;
  /** Data keys the script asked for that were not provided (load them and run again). */
  need: string[];
}

function brokerFromPy(opts: any): Partial<BrokerConfig> {
  if (!opts) return {};
  const c: Partial<BrokerConfig> = {};
  if (opts.initial_capital !== undefined) c.initialCapital = +opts.initial_capital;
  if (opts.pyramiding !== undefined) c.pyramiding = +opts.pyramiding;
  if (opts.default_qty_type) c.defaultQty = { type: opts.default_qty_type, value: +(opts.default_qty_value ?? 100) };
  // like Pine/TradingView: no commission unless the script declares one (the Strategy Tester's
  // cost settings override this)
  const fee = opts.commission === undefined || opts.commission === null ? 0 : +opts.commission;
  c.makerFee = fee;
  c.takerFee = fee;
  if (opts.slippage_ticks) c.slippageTicks = +opts.slippage_ticks;
  if (opts.process_orders_on_close) c.processOrdersOnClose = true;
  return c;
}

export async function runPython(init: PyInitOptions, o: PyRunOptions): Promise<PyRunResult> {
  const t0 = performance.now();
  const p = await initPython(init);
  const runner = p.globals.get('fufu_runner');
  const n = o.data.length;
  currentData = o.data;
  stdoutBuf = [];
  const htf: Record<string, Record<string, Float64Array>> = {};
  for (const [k, b] of Object.entries(o.security || {})) htf[k] = { t: b.t, tc: b.tc, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
  const meta = p.toPy({ symbol: o.ctx.symbol, market: o.ctx.market, tf: o.ctx.tf, mintick: o.ctx.mintick, htf });
  const cols = p.toPy(dataDict(o.data));
  const inputs = p.toPy(clean(o.inputs));
  const res = emptyResult('python');
  let need: string[] = [];
  let dbg: any = null;
  let stepFn: any = null;
  let run: any = null;
  try {
    const an = pyToJs(runner.analyze(o.code));
    if (!an.ok) {
      res.ok = false;
      res.error = errFrom(an.error);
      return { result: res, need };
    }
    res.meta = { type: an.meta.type, title: an.meta.title, shortTitle: an.meta.shortTitle || an.meta.title, overlay: !!an.meta.overlay, precision: an.meta.precision ?? undefined, scaleMin: an.meta.scale?.[0], scaleMax: an.meta.scale?.[1] };
    res.inputs = inputsFrom(an.inputs);
    if (o.debug) {
      const ctl = o.debug;
      const pause = (snap: any, reason: string) => {
        const s = pyToJs(snap);
        Atomics.store(ctl.ctrl, 1, 0);
        Atomics.store(ctl.ctrl, 0, 1);
        ctl.onPause(s, String(reason));
        while (Atomics.load(ctl.ctrl, 1) === 0) Atomics.wait(ctl.ctrl, 1, 0, 1000);
        const cmd = Atomics.load(ctl.ctrl, 1);
        Atomics.store(ctl.ctrl, 0, 0);
        const bps: number[] = [];
        for (let k = 2; k < ctl.ctrl.length && ctl.ctrl[k] > 0; k++) bps.push(ctl.ctrl[k]);
        dbg?.set_breakpoints(bps);
        return CMD_NAME[cmd] || 'continue';
      };
      dbg = runner.Debugger(pause, ctl.breakpoints, ctl.breakOnNext);
      dbg.install();
    }
    if (an.meta.type === 'indicator') {
      const r = pyToJs(runner.run_indicator(o.code, cols, meta, inputs));
      outputsToResult(res, r.outputs || {}, n);
      need = r.need || [];
      if (!r.ok) {
        res.ok = false;
        res.error = errFrom(r.error);
      }
    } else {
      const scriptOpts = pyToJs(runner.strategy_options(o.code)) || {};
      const cfg: Partial<BrokerConfig> = { ...brokerFromPy(scriptOpts), ...(o.strategy || {}) };
      const broker = new StrategyBroker({ symbol: o.ctx.symbol as SymbolId, tick: o.ctx.mintick, ...cfg }, o.data as any);
      if (o.ticks) broker.ticks = o.ticks;
      const num = (v: any) => (v === null || v === undefined || Number.isNaN(+v) ? undefined : +v);
      const bridge = {
        submit: (ord: any) => {
          const x = pyToJs(ord);
          broker.submit({
            id: String(x.id),
            kind: x.kind,
            dir: x.dir === -1 ? -1 : 1,
            qty: num(x.qty) ?? NaN,
            qtyPercent: num(x.qtyPercent),
            limit: num(x.limit),
            stop: num(x.stop),
            fromEntry: x.fromEntry ?? undefined,
            profitTicks: num(x.profitTicks),
            lossTicks: num(x.lossTicks),
            trailPoints: num(x.trailPoints),
            trailOffset: num(x.trailOffset),
            comment: x.comment ?? undefined,
            immediately: !!x.immediately,
          });
        },
        cancel: (id: string) => broker.cancel(String(id)),
        cancel_all: () => broker.cancelAll(),
        state: () => ({ position_size: broker.positionSize, position_avg_price: broker.positionAvgPrice, equity: broker.equityNow(), open_profit: broker.openProfit(), net_profit: broker.netProfit(), closed_trades: broker.closed.length }),
      };
      const start = runner.start_strategy(o.code, cols, meta, inputs, bridge);
      try {
        const ok = !!start.get('ok');
        need = pyToJs(start.get('need')) || [];
        if (!ok) {
          res.ok = false;
          res.error = errFrom(pyToJs(start.get('error')));
        } else {
          run = start.get('run');
        }
      } finally {
        start.destroy?.();
      }
      if (run) {
        stepFn = runner.step_strategy;
        const maxMs = o.maxMs ?? 300000;
        for (let i = 0; i < n; i++) {
          broker.processBar(i);
          const err = stepFn(run, i);
          if (err !== undefined && err !== null) {
            res.ok = false;
            res.error = { ...errFrom(pyToJs(err)), bar: i };
            break;
          }
          broker.endBar(i);
          if ((i & 255) === 0 && performance.now() - t0 > maxMs) {
            res.ok = false;
            res.error = { message: `Strategy took longer than ${Math.round(maxMs / 1000)}s`, kind: 'timeout', bar: i };
            break;
          }
        }
        const fin = run.finish;
        const out = pyToJs(fin());
        fin.destroy?.();
        outputsToResult(res, out || {}, n);
        need = Array.from(new Set([...need, ...((out && out.need) || [])]));
        if (o.bot && res.ok) broker.flushMarket();
        res.strategy = brokerRaw(broker);
        for (const w of broker.warnings) res.warnings.push({ message: w, kind: 'runtime' });
      }
    }
  } catch (e) {
    res.ok = false;
    res.error = { message: (e as Error).message, kind: 'python' };
  } finally {
    if (dbg) {
      try {
        dbg.uninstall();
      } catch {
        /* ignore */
      }
      dbg.destroy?.();
    }
    stepFn?.destroy?.();
    run?.destroy?.();
    for (const x of [meta, cols, inputs]) x?.destroy?.();
    runner.destroy?.();
    currentData = null;
  }
  if (stdoutBuf.length) {
    const last = Math.max(0, n - 1);
    res.logs.push(...stdoutBuf.slice(-500).map((m) => ({ bar: last, time: 0, level: 'info' as const, msg: m })));
  }
  for (const l of res.logs) if (!l.time && l.bar >= 0 && l.bar < n) l.time = o.data.t[l.bar];
  res.stats = { bars: n, ms: performance.now() - t0 };
  return { result: res, need };
}
