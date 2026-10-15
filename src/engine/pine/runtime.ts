/**
 * Pine runtime: series storage with Pine's history semantics, per-call-site contexts,
 * output collection (plots, shapes, drawings, alerts, logs) and live-bar rollback.
 *
 * History semantics: every series advances once per *execution* of its declaring scope.
 * Global scope executes once per bar, so `x[1]` is the previous bar; inside functions and
 * local blocks `x[1]` is the previous execution — exactly Pine's behaviour.
 *
 * Live updates: before a new bar the runtime commits all state; re-executing the realtime
 * bar first rolls back to that commit (varip state is excluded from rollback).
 */
import { PineError } from './lexer';

export class Series {
  a: Float64Array;
  n = 0;
  cn = 0;
  constructor(cap = 64) {
    this.a = new Float64Array(cap);
  }
  push(v: number): void {
    if (this.n >= this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  set(v: number): void {
    if (this.n === 0) this.push(v);
    else this.a[this.n - 1] = v;
  }
  get(k: number): number {
    const j = this.n - 1 - k;
    return j >= 0 && j < this.n && k >= 0 ? this.a[j] : NaN;
  }
  commit(): void {
    this.cn = this.n;
  }
  rollback(): void {
    this.n = this.cn;
  }
}

export class ObjSeries {
  a: unknown[] = [];
  n = 0;
  cn = 0;
  push(v: unknown): void {
    this.a[this.n++] = v;
  }
  set(v: unknown): void {
    if (this.n === 0) this.push(v);
    else this.a[this.n - 1] = v;
  }
  get(k: number): unknown {
    const j = this.n - 1 - k;
    return j >= 0 && j < this.n && k >= 0 ? this.a[j] : null;
  }
  commit(): void {
    this.cn = this.n;
  }
  rollback(): void {
    this.n = this.cn;
    this.a.length = this.n;
  }
}

/** State of one scope instance (global script, or one user-function call site). */
export class Ctx {
  s: (Series | ObjSeries)[];
  v: unknown[] = [];
  vi: Uint8Array;
  /** varip slots: persist across realtime re-executions (never rolled back) */
  vp: unknown[] = [];
  vpi: Uint8Array = new Uint8Array(16);
  st: Record<number, any> = {};
  c: Record<number, Ctx> = {};
  /** snapshot for rollback */
  snapV: unknown[] | null = null;
  snapVi: Uint8Array | null = null;
  constructor(rt: Runtime, nNum: number, nObj: number, nVar: number) {
    this.s = [];
    for (let k = 0; k < nNum; k++) this.s.push(rt.newSeries());
    for (let k = 0; k < nObj; k++) this.s.push(rt.newObjSeries());
    this.vi = new Uint8Array(Math.max(1, nVar));
    rt.contexts.push(this);
  }
}

export interface PlotOut {
  id: string;
  title: string;
  kind: 'plot' | 'shape' | 'char' | 'arrow' | 'candle' | 'bar';
  type: string;
  color: string;
  colors: (string | null)[] | null;
  values: Float64Array;
  width: number;
  offset: number;
  histbase: number;
  display: boolean;
  trackPrice: boolean;
  /** plotshape/plotchar specifics */
  style?: string;
  location?: string;
  text?: string;
  char?: string;
  textColor?: string;
  size?: string;
  /** plotcandle/plotbar extra series */
  o?: Float64Array;
  h?: Float64Array;
  l?: Float64Array;
  precision?: number;
  format?: string;
}

export interface HLineOut {
  id: string;
  title: string;
  price: number;
  color: string;
  style: 'solid' | 'dashed' | 'dotted';
  width: number;
  display: boolean;
}

export interface FillOut {
  a: string;
  b: string;
  color: string;
  colors: (string | null)[] | null;
}

export interface LabelObj {
  id: number;
  x: number;
  y: number;
  xloc: string;
  yloc: string;
  text: string;
  color: string | null;
  textcolor: string | null;
  style: string;
  size: string;
  tooltip: string;
  deleted: boolean;
  bar: number;
}

export interface LineObj {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xloc: string;
  extend: string;
  color: string | null;
  style: string;
  width: number;
  deleted: boolean;
  bar: number;
}

export interface BoxObj {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  xloc: string;
  border: string | null;
  bg: string | null;
  borderWidth: number;
  borderStyle: string;
  extend: string;
  text: string;
  textColor: string | null;
  deleted: boolean;
  bar: number;
}

/** chart.point: a time/bar index and a price. */
export interface PointObj {
  time: number;
  index: number;
  price: number;
}

/** linefill: the area between two lines. */
export interface LinefillObj {
  id: number;
  l1: LineObj | null;
  l2: LineObj | null;
  color: string | null;
  deleted: boolean;
}

/** polyline: a path through chart points. */
export interface PolylineObj {
  id: number;
  points: PointObj[];
  curved: boolean;
  closed: boolean;
  xloc: string;
  lineColor: string | null;
  fillColor: string | null;
  lineStyle: string;
  lineWidth: number;
  deleted: boolean;
}

export interface TableObj {
  id: number;
  position: string;
  cols: number;
  rows: number;
  bg: string | null;
  frame: string | null;
  border: string | null;
  cells: Map<string, { text: string; bg: string | null; color: string | null }>;
  deleted: boolean;
}

export interface AlertCond {
  title: string;
  message: string;
  values: Uint8Array;
}

export interface LogEntry {
  bar: number;
  time: number;
  level: 'info' | 'warning' | 'error';
  msg: string;
}

export interface BarData {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  tbv?: Float64Array;
  /** bar close times (exclusive end) */
  tc: Float64Array;
  length: number;
}

export interface SymbolCtx {
  symbol: string;
  market: 'spot' | 'futures';
  tickerid: string;
  tf: string; // our format, e.g. 15m
  pineTf: string; // Pine format, e.g. 15
  tfSeconds: number;
  mintick: number;
  base: string;
  quote: string;
}

export class Runtime {
  i = 0;
  n = 0;
  d: BarData;
  sym: SymbolCtx;
  inputs: Record<string, unknown>;
  root: Ctx;
  contexts: Ctx[] = [];
  series: (Series | ObjSeries)[] = [];
  states: any[] = [];
  noRollback = new Set<any>();
  plots: PlotOut[] = [];
  hlines: HLineOut[] = [];
  fills: FillOut[] = [];
  bgcolors: (string | null)[] | null = null;
  barcolors: (string | null)[] | null = null;
  labels: LabelObj[] = [];
  lines: LineObj[] = [];
  boxes: BoxObj[] = [];
  tables: TableObj[] = [];
  linefills: LinefillObj[] = [];
  polylines: PolylineObj[] = [];
  objSeq = 1;
  maxPolylines = 50;
  maxLabels = 50;
  maxLines = 50;
  maxBoxes = 50;
  alerts: AlertCond[] = [];
  alertEvents: { bar: number; time: number; message: string }[] = [];
  logs: LogEntry[] = [];
  warnings = new Set<string>();
  /** request.security: per call site, values mapped to chart bars */
  sec: Record<number, unknown[]> = {};
  /** security sub-instance: records expression values per bar for its own context key */
  secMode: { key: string; record: Record<number, unknown[]> } | null = null;
  secKeyOf: Record<number, string> = {};
  /** strategy broker (when running a strategy) */
  broker: any = null;
  /** bar inspector: per-bar values of top-level variables */
  traceOn = false;
  traceData: Float64Array[] = [];
  traceRec(i: number, vals: unknown[]): void {
    for (let k = 0; k < vals.length && k < this.traceData.length; k++) {
      const v = vals[k];
      const a = this.traceData[k];
      if (i < a.length) a[i] = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
    }
  }
  /** realtime flags */
  isRealtime = false;
  lastHistBar = -1;
  committedBar = -1;
  loopCount = 0;
  maxLoop = 5_000_000;
  /** per bar debug values for the inspector (opt-in) */
  trace: Map<string, Float64Array> | null = null;
  overlay = true;
  timeNow = Date.now();

  constructor(data: BarData, sym: SymbolCtx, inputs: Record<string, unknown>, nNum: number, nObj: number, nVar: number) {
    this.d = data;
    this.n = data.length;
    this.sym = sym;
    this.inputs = inputs;
    this.root = new Ctx(this, nNum, nObj, nVar);
  }

  newSeries(): Series {
    const s = new Series(256);
    this.series.push(s);
    return s;
  }

  newObjSeries(): ObjSeries {
    const s = new ObjSeries();
    this.series.push(s);
    return s;
  }

  child(ctx: Ctx, slot: number, nNum: number, nObj: number, nVar: number): Ctx {
    let c = ctx.c[slot];
    if (!c) {
      c = new Ctx(this, nNum, nObj, nVar);
      ctx.c[slot] = c;
    }
    return c;
  }

  /** Per-call-site state object for builtins. */
  state(ctx: Ctx, slot: number): any {
    let s = ctx.st[slot];
    if (!s) {
      s = {};
      ctx.st[slot] = s;
      this.states.push(s);
    }
    return s;
  }

  // ------------------------------------------------------------------ helpers used by generated code

  at(arr: Float64Array, k: number): number {
    const j = this.i - k;
    return j >= 0 && j < this.n ? arr[j] : NaN;
  }

  bool(x: unknown): boolean {
    if (x === null || x === undefined) return false;
    if (typeof x === 'number') return x !== 0 && x === x;
    return !!x;
  }

  isNa(x: unknown): boolean {
    return x === null || x === undefined || (typeof x === 'number' && x !== x);
  }

  add(a: unknown, b: unknown): unknown {
    if (typeof a === 'string' || typeof b === 'string') {
      if (this.isNa(a) || this.isNa(b)) return null;
      return String(a) + String(b);
    }
    return (a as number) + (b as number);
  }

  div(a: number, b: number): number {
    return b === 0 ? NaN : a / b;
  }

  mod(a: number, b: number): number {
    return b === 0 ? NaN : a % b;
  }

  eq(a: unknown, b: unknown): boolean {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (this.isNa(a) || this.isNa(b)) return false;
    return a === b;
  }

  /** Pine ≤ v5 evaluates both operands of and/or (arguments are already evaluated here). */
  and(a: boolean, b: boolean): boolean {
    return a && b;
  }

  or(a: boolean, b: boolean): boolean {
    return a || b;
  }

  /** History of an arbitrary expression: record this execution's value, return k executions back. */
  histN(s: Series | ObjSeries, v: any, k: number): any {
    s.push(v);
    return s.get(k);
  }

  private cache = new Map<string, { n: number; last: number; a: Float64Array }>();

  /** Cumulative built-in series (ta.obv, ta.accdist, …) computed from the bar data. */
  cached(name: string): Float64Array {
    const d = this.d;
    const n = d.length;
    let e = this.cache.get(name);
    if (e && e.n === n && e.last === d.c[n - 1] + d.v[n - 1] * 1e-9) return e.a;
    const a = new Float64Array(Math.max(n, 1));
    let acc = name === 'nvi' || name === 'pvi' ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const c = d.c[k];
      const pc = k > 0 ? d.c[k - 1] : NaN;
      const v = d.v[k];
      switch (name) {
        case 'obv':
          if (k > 0) acc += c > pc ? v : c < pc ? -v : 0;
          break;
        case 'accdist': {
          const hl = d.h[k] - d.l[k];
          acc += hl === 0 ? 0 : (((c - d.l[k]) - (d.h[k] - c)) / hl) * v;
          break;
        }
        case 'pvt':
          if (k > 0) acc += ((c - pc) / pc) * v;
          break;
        case 'nvi':
          if (k > 0 && v < d.v[k - 1]) acc += ((c - pc) / pc) * acc;
          break;
        case 'pvi':
          if (k > 0 && v > d.v[k - 1]) acc += ((c - pc) / pc) * acc;
          break;
        case 'wad':
          if (k > 0) acc += c > pc ? c - Math.min(pc, d.l[k]) : c < pc ? c - Math.max(pc, d.h[k]) : 0;
          break;
      }
      a[k] = acc;
    }
    e = { n, last: d.c[n - 1] + d.v[n - 1] * 1e-9, a };
    this.cache.set(name, e);
    return a;
  }

  loop(): void {
    if (++this.loopCount > this.maxLoop) throw new PineError(`Loop took too long (more than ${this.maxLoop.toLocaleString()} iterations on one bar)`, 0, 0, 'runtime');
  }

  error(msg: string): never {
    throw new PineError(msg, 0, 0, 'runtime');
  }

  warn(msg: string): void {
    this.warnings.add(msg);
  }

  // ------------------------------------------------------------------ live bar handling

  commit(): void {
    for (const s of this.series) s.commit();
    for (const st of this.states) {
      if (this.noRollback.has(st)) continue;
      st.__snap = shallowSnapshot(st);
    }
    for (const c of this.contexts) {
      c.snapV = c.v.map((x) => (Array.isArray(x) ? (x as unknown[]).slice() : x instanceof Map ? new Map(x) : x));
      c.snapVi = c.vi.slice();
    }
    this.committedBar = this.i;
  }

  rollback(): void {
    for (const s of this.series) s.rollback();
    for (const st of this.states) {
      if (st.__snap) restoreSnapshot(st, st.__snap);
    }
    for (const c of this.contexts) {
      if (c.snapV) {
        // varip slots are marked with a negative index in noRollbackVars
        c.v = c.snapV.map((x) => (Array.isArray(x) ? (x as unknown[]).slice() : x instanceof Map ? new Map(x) : x));
        if (c.snapVi) c.vi = c.snapVi.slice();
      }
    }
    // drawings created during the rolled-back execution
    const bar = this.i;
    this.labels = this.labels.filter((l) => l.bar < bar);
    this.lines = this.lines.filter((l) => l.bar < bar);
    this.boxes = this.boxes.filter((b) => b.bar < bar);
    this.alertEvents = this.alertEvents.filter((a) => a.bar < bar);
    this.logs = this.logs.filter((l) => l.bar < bar);
  }

  /** Grow per-bar output arrays when live bars are appended. */
  ensureCapacity(n: number): void {
    if (n <= this.n) return;
    const grow = (a: Float64Array) => {
      if (a.length >= n) return a;
      const b = new Float64Array(Math.max(n, a.length * 2));
      b.fill(NaN);
      b.set(a);
      return b;
    };
    for (const p of this.plots) {
      p.values = grow(p.values);
      if (p.o) p.o = grow(p.o);
      if (p.h) p.h = grow(p.h);
      if (p.l) p.l = grow(p.l);
    }
    for (const al of this.alerts) {
      if (al.values.length < n) {
        const b = new Uint8Array(Math.max(n, al.values.length * 2));
        b.set(al.values);
        al.values = b;
      }
    }
    this.n = n;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** Snapshot of a builtin state: scalars and arrays copied, nested plain states recursed, series skipped (they roll back themselves). */
function shallowSnapshot(st: any): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(st)) {
    if (k === '__snap') continue;
    const v = st[k];
    if (v instanceof Series || v instanceof ObjSeries) continue;
    o[k] = Array.isArray(v) ? v.slice() : isPlain(v) ? { __nested: shallowSnapshot(v) } : v;
  }
  return o;
}

function restoreSnapshot(st: any, snap: Record<string, unknown>): void {
  for (const k of Object.keys(st)) {
    if (k === '__snap') continue;
    const v = st[k];
    if (v instanceof Series || v instanceof ObjSeries) continue;
    if (!(k in snap)) delete st[k]; // created during the rolled-back execution
  }
  for (const k of Object.keys(snap)) {
    const v = snap[k] as any;
    if (isPlain(v) && v.__nested) {
      if (!isPlain(st[k])) st[k] = {};
      restoreSnapshot(st[k], v.__nested as Record<string, unknown>);
    } else st[k] = Array.isArray(v) ? v.slice() : v;
  }
}
