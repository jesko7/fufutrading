/**
 * Pine Script engine public API: compile/analyze, run on historical data (indicators and
 * strategies), request.security contexts, and live instances that re-run only the realtime bar.
 */
import { compilePine, type CompiledPine } from './compiler';
import { PineError } from './lexer';
import { Runtime, type BarData, type PlotOut, type SymbolCtx } from './runtime';
import { B, oursToPineTf, pineTfToOurs } from './builtins/bind';
import { cssColor } from './builtins/lib';
import { StrategyBroker, type BrokerConfig, type TickProvider } from '../backtest/broker';
import type { ScriptResult, ScriptError, BarSeries, RunContext, StrategyRaw } from '../types';
import { emptyResult } from '../types';
import { SYMBOLS, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfDurationMs } from '../../shared/timeframes';

export type { CompiledPine };

const cache = new Map<string, CompiledPine>();

export function compileCached(code: string): CompiledPine {
  let c = cache.get(code);
  if (!c) {
    c = compilePine(code);
    if (cache.size > 50) cache.clear();
    cache.set(code, c);
  }
  return c;
}

export function toScriptError(e: unknown, bar?: number): ScriptError {
  if (e instanceof PineError) return { message: e.message, line: e.line || undefined, col: e.col || undefined, kind: e.kind === 'syntax' ? 'syntax' : e.kind === 'unsupported' ? 'unsupported' : e.kind === 'runtime' ? 'runtime' : 'compile', bar };
  const msg = e instanceof Error ? e.message : String(e);
  return { message: bar !== undefined ? `${msg} (on bar ${bar})` : msg, kind: 'runtime', bar };
}

export interface PineAnalysis {
  ok: boolean;
  error?: ScriptError;
  meta?: CompiledPine['meta'];
  inputs?: CompiledPine['inputs'];
  warnings?: CompiledPine['warnings'];
  functions?: CompiledPine['functions'];
  variables?: CompiledPine['variables'];
  usesStrategy?: boolean;
  version?: number;
}

export function analyzePine(code: string): PineAnalysis {
  try {
    const c = compileCached(code);
    return { ok: true, meta: c.meta, inputs: c.inputs, warnings: c.warnings, functions: c.functions, variables: c.variables, usesStrategy: c.usesStrategy, version: c.version };
  } catch (e) {
    return { ok: false, error: toScriptError(e) };
  }
}

// ---------------------------------------------------------------- security contexts

export interface SecurityRequest {
  site: number;
  key: string;
  symbol: SymbolId;
  market: 'spot' | 'futures';
  tf: string;
  chartType: 'candles' | 'heikinashi';
  lowerTf: boolean;
  lookahead: boolean;
  gaps: boolean;
}

/** Parse a TradingView-style ticker into a supported Binance instrument. */
export function resolveTicker(ticker: string, ctx: RunContext): { symbol: SymbolId; market: 'spot' | 'futures'; ha: boolean } {
  let t = String(ticker || '').trim();
  let ha = false;
  if (t.endsWith('#HA')) {
    ha = true;
    t = t.slice(0, -3);
  }
  let prefix = '';
  if (t.includes(':')) [prefix, t] = t.split(':');
  if (prefix && prefix.toUpperCase() !== 'BINANCE') throw new Error(`Symbol "${ticker}" is not available: FuFu only has Binance BTC, ETH and SOL data.`);
  let market = ctx.market;
  if (t.endsWith('.P')) {
    market = 'futures';
    t = t.slice(0, -2);
  } else if (t.endsWith('PERP')) {
    market = 'futures';
    t = t.slice(0, -4);
  } else if (prefix) market = 'spot';
  const sym = t.toUpperCase() as SymbolId;
  if (!(SYMBOLS as readonly string[]).includes(sym)) throw new Error(`Symbol "${ticker}" is not available: supported are BTCUSDT, ETHUSDT and SOLUSDT (spot, or .P for perpetuals).`);
  return { symbol: sym, market, ha };
}

export function securityRequests(c: CompiledPine, inputs: Record<string, unknown>, ctx: RunContext): SecurityRequest[] {
  const sym = makeSym(ctx, c.version);
  const R = { inputs, sym } as unknown as Runtime;
  const out: SecurityRequest[] = [];
  for (const s of c.security) {
    let symStr: string;
    let tfStr: string;
    try {
      symStr = String(new Function('R', 'B', `return (${s.symJs});`)(R, B));
      tfStr = String(new Function('R', 'B', `return (${s.tfJs});`)(R, B));
    } catch (e) {
      throw new PineError(`request.security: could not resolve symbol/timeframe (${(e as Error).message})`, s.line, 0, 'compile');
    }
    let ins;
    try {
      ins = resolveTicker(symStr, ctx);
    } catch (e) {
      throw new PineError((e as Error).message, s.line, 0, 'unsupported');
    }
    let tf: string;
    try {
      tf = pineTfToOurs(tfStr, ctx.tf);
    } catch (e) {
      throw new PineError((e as Error).message, s.line, 0, 'compile');
    }
    const chartType = ins.ha ? 'heikinashi' : 'candles';
    out.push({ site: s.site, key: `${ins.market}:${ins.symbol}:${tf}:${chartType}`, symbol: ins.symbol, market: ins.market, tf, chartType, lowerTf: s.lowerTf, lookahead: s.lookahead, gaps: s.gaps });
  }
  return out;
}

/** Map values recorded on context bars to chart bars without lookahead (unless requested). */
export function mapSecurity(chart: BarSeries, ctxBars: BarSeries, rec: unknown[], opts: { lookahead: boolean; gaps: boolean; lowerTf: boolean; realtime: boolean }): unknown[] {
  const out: unknown[] = new Array(chart.length);
  let j = 0;
  const n = ctxBars.length;
  for (let i = 0; i < chart.length; i++) {
    const ti = chart.t[i];
    const ci = chart.tc[i];
    if (opts.lowerTf) {
      // all lower-timeframe values inside this chart bar
      const vals: unknown[] = [];
      while (j < n && ctxBars.t[j] < ti) j++;
      let k = j;
      while (k < n && ctxBars.t[k] < ci) {
        vals.push(rec[k]);
        k++;
      }
      out[i] = vals;
      continue;
    }
    // last context bar that has closed by the end of this chart bar
    while (j + 1 < n && ctxBars.tc[j + 1] <= ci) j++;
    const closedIdx = ctxBars.tc[j] <= ci ? j : j - 1;
    // context bar containing the chart bar open
    let cont = closedIdx + 1;
    while (cont < n && ctxBars.tc[cont] <= ti) cont++;
    const isLast = i === chart.length - 1;
    let idx: number;
    if (opts.lookahead) idx = cont < n && ctxBars.t[cont] <= ti ? cont : closedIdx;
    else if (isLast && opts.realtime) idx = cont < n && ctxBars.t[cont] <= ti ? cont : closedIdx;
    else idx = closedIdx;
    if (opts.gaps) {
      const closedHere = idx >= 0 && ctxBars.tc[idx] > ti && ctxBars.tc[idx] <= ci;
      out[i] = closedHere ? rec[idx] : NaN;
    } else out[i] = idx >= 0 ? rec[idx] : NaN;
  }
  return out;
}

function makeSym(ctx: RunContext, version: number): SymbolCtx & { chartType: string } {
  const tf = parseTimeframe(ctx.tf);
  return {
    symbol: ctx.symbol,
    market: ctx.market,
    tickerid: `BINANCE:${ctx.symbol}${ctx.market === 'futures' ? '.P' : ''}`,
    tf: ctx.tf,
    pineTf: oursToPineTf(ctx.tf, version),
    tfSeconds: tf ? tfDurationMs(tf) / 1000 : 60,
    mintick: ctx.mintick,
    base: ctx.base,
    quote: ctx.quote,
    chartType: ctx.chartType,
  };
}

// ---------------------------------------------------------------- runs

export interface PineRunOptions {
  data: BarSeries;
  ctx: RunContext;
  inputs: Record<string, unknown>;
  /** request.security data by key (see securityRequests) */
  security?: Record<string, BarSeries>;
  /** Run as strategy with these broker settings (merged over the script's strategy() declaration). */
  strategy?: Partial<BrokerConfig> | null;
  /** Last bar is still forming (live chart). */
  realtime?: boolean;
  ticks?: TickProvider;
  maxMs?: number;
  /** Record per-bar values of global numeric variables for the inspector. */
  trace?: boolean;
  /** Only execute up to this bar (inclusive) — replay / step debugging. */
  upTo?: number;
  /** Polled every 1024 bars; returning true aborts the run (user cancel). */
  shouldStop?: () => boolean;
}

function brokerFromScript(c: CompiledPine, opts: PineRunOptions): Partial<BrokerConfig> {
  const s = (c.meta.strategy || {}) as Record<string, any>;
  const cfg: Partial<BrokerConfig> = {};
  if (s.initial_capital !== undefined) cfg.initialCapital = +s.initial_capital;
  if (s.pyramiding !== undefined) cfg.pyramiding = +s.pyramiding;
  if (s.default_qty_type) cfg.defaultQty = { type: s.default_qty_type, value: +(s.default_qty_value ?? 1) };
  else if (s.default_qty_value !== undefined) cfg.defaultQty = { type: 'fixed', value: +s.default_qty_value };
  else cfg.defaultQty = { type: 'fixed', value: 1 };
  if (s.process_orders_on_close !== undefined) cfg.processOrdersOnClose = !!s.process_orders_on_close;
  if (s.slippage !== undefined) cfg.slippageTicks = +s.slippage;
  if (s.commission_type && s.commission_value !== undefined) {
    const v = +s.commission_value;
    if (s.commission_type === 'percent') {
      cfg.makerFee = v / 100;
      cfg.takerFee = v / 100;
    } else if (s.commission_type === 'cash_per_contract') cfg.perContractFee = v;
    else cfg.flatFee = v;
  } else if (s.commission_value === undefined) {
    // TradingView default: no commission
    cfg.makerFee = 0;
    cfg.takerFee = 0;
  }
  if (s.close_entries_rule) cfg.closeEntriesRule = s.close_entries_rule;
  void opts;
  return cfg;
}

export class PineInstance {
  readonly R: Runtime;
  main: () => void;
  broker: StrategyBroker | null = null;
  readonly c: CompiledPine;
  private opts: PineRunOptions;
  private secReqs: SecurityRequest[] = [];
  error: ScriptError | null = null;

  constructor(code: string | CompiledPine, opts: PineRunOptions) {
    this.c = typeof code === 'string' ? compileCached(code) : code;
    this.opts = opts;
    const data = opts.data as unknown as BarData;
    const sym = makeSym(opts.ctx, this.c.version);
    this.R = new Runtime(data, sym, opts.inputs || {}, this.c.rootSlots.num, this.c.rootSlots.obj, this.c.rootSlots.vars);
    this.R.overlay = this.c.meta.overlay;
    if (this.c.meta.maxLabels) this.R.maxLabels = Math.min(500, this.c.meta.maxLabels);
    if (this.c.meta.maxLines) this.R.maxLines = Math.min(500, this.c.meta.maxLines);
    if (this.c.meta.maxBoxes) this.R.maxBoxes = Math.min(500, this.c.meta.maxBoxes);
    this.allocOutputs();
    this.main = this.c.factory(B, this.R);
    if (this.c.usesStrategy && opts.strategy !== null && this.c.meta.type === 'strategy') {
      const sc = { ...brokerFromScript(this.c, opts), ...(opts.strategy || {}) };
      this.broker = new StrategyBroker({ symbol: opts.ctx.symbol as SymbolId, tick: opts.ctx.mintick, ...sc }, data as any);
      if (opts.ticks) this.broker.ticks = opts.ticks;
      this.R.broker = this.broker;
    }
    if (opts.trace) {
      this.R.traceOn = true;
      this.R.traceData = this.c.traceNames.map(() => new Float64Array(Math.max(1, this.R.n)).fill(NaN));
    }
  }

  private allocOutputs(): void {
    const R = this.R;
    const n = Math.max(R.n, 1);
    R.plots = this.c.plots.map((p): PlotOut => {
      const vals = new Float64Array(n).fill(NaN);
      const o: PlotOut = {
        id: p.id,
        title: p.title,
        kind: p.kind,
        type: p.style,
        color: p.color || '#2196F3ff',
        colors: p.colorDynamic ? new Array(n).fill(null) : null,
        values: vals,
        width: p.width,
        offset: p.offset,
        histbase: p.histbase,
        display: p.display,
        trackPrice: p.trackPrice,
        style: p.style,
        location: p.location,
        text: p.text,
        char: p.char,
        textColor: p.textColor,
        size: p.size,
        precision: p.precision,
        format: p.format,
      };
      if (p.kind === 'candle' || p.kind === 'bar') {
        o.o = new Float64Array(n).fill(NaN);
        o.h = new Float64Array(n).fill(NaN);
        o.l = new Float64Array(n).fill(NaN);
      }
      (o as any).colorup = p.colorup;
      (o as any).colordown = p.colordown;
      return o;
    });
    R.hlines = this.c.hlines.map((h) => ({ id: h.id, title: h.title, price: h.price ?? NaN, color: h.color, style: h.style as any, width: h.width, display: h.display }));
    R.fills = this.c.fills.map((f) => ({ a: f.a, b: f.b, color: f.color || '#2196F333', colors: f.colorDynamic ? new Array(n).fill(null) : null }));
    R.alerts = this.c.alertconds.map((a) => ({ title: a.title, message: a.message, values: new Uint8Array(n) }));
  }

  /** Prepare request.security values (runs sub-instances on the context data). */
  prepareSecurity(security: Record<string, BarSeries> | undefined): void {
    if (!this.c.security.length) return;
    this.secReqs = securityRequests(this.c, this.opts.inputs || {}, this.opts.ctx);
    const byKey = new Map<string, SecurityRequest[]>();
    for (const r of this.secReqs) {
      this.R.secKeyOf[r.site] = r.key;
      const l = byKey.get(r.key) || [];
      l.push(r);
      byKey.set(r.key, l);
    }
    for (const [key, reqs] of byKey) {
      const data = security?.[key];
      if (!data) throw new PineError(`request.security: data for ${key} was not provided`, 0, 0, 'runtime');
      // sub-instance runs the whole script on the context data, recording the expression values
      const subCtx: RunContext = { ...this.opts.ctx, symbol: reqs[0].symbol, market: reqs[0].market, tf: reqs[0].tf, chartType: reqs[0].chartType };
      const sub = new Runtime(data as unknown as BarData, makeSym(subCtx, this.c.version), this.opts.inputs || {}, this.c.rootSlots.num, this.c.rootSlots.obj, this.c.rootSlots.vars);
      sub.secMode = { key, record: {} };
      sub.secKeyOf = this.R.secKeyOf;
      sub.plots = this.R.plots.map((p) => ({ ...p, values: new Float64Array(Math.max(1, data.length)).fill(NaN), colors: p.colors ? [] : null, o: p.o ? new Float64Array(data.length) : undefined, h: p.h ? new Float64Array(data.length) : undefined, l: p.l ? new Float64Array(data.length) : undefined }));
      sub.hlines = this.R.hlines.map((h) => ({ ...h }));
      sub.fills = this.R.fills.map((f) => ({ ...f, colors: f.colors ? [] : null }));
      sub.alerts = this.R.alerts.map((a) => ({ ...a, values: new Uint8Array(Math.max(1, data.length)) }));
      const subMain = this.c.factory(B, sub);
      for (let i = 0; i < data.length; i++) {
        sub.i = i;
        sub.loopCount = 0;
        subMain();
      }
      for (const r of reqs) {
        const rec = sub.secMode.record[r.site] || [];
        this.R.sec[r.site] = mapSecurity(this.opts.data, data, rec, { lookahead: r.lookahead, gaps: r.gaps, lowerTf: r.lowerTf, realtime: !!this.opts.realtime });
      }
    }
  }

  private step(i: number): void {
    const R = this.R;
    R.i = i;
    R.loopCount = 0;
    if (this.broker) this.broker.processBar(i);
    this.main();
    if (this.broker) this.broker.endBar(i);
  }

  /** Full run over all bars. */
  run(): ScriptResult {
    const t0 = performance.now();
    const R = this.R;
    const n = R.n;
    const upTo = this.opts.upTo !== undefined ? Math.min(n - 1, this.opts.upTo) : n - 1;
    let bar = 0;
    try {
      this.prepareSecurity(this.opts.security);
      const realtime = !!this.opts.realtime;
      R.isRealtime = realtime;
      R.lastHistBar = realtime ? n - 2 : n - 1;
      const maxMs = this.opts.maxMs ?? 60000;
      for (bar = 0; bar <= upTo; bar++) {
        if (realtime && bar === n - 1) R.commit();
        this.step(bar);
        if ((bar & 1023) === 0) {
          if (performance.now() - t0 > maxMs) throw new PineError(`Script took longer than ${Math.round(maxMs / 1000)}s`, 0, 0, 'runtime');
          if (this.opts.shouldStop?.()) throw new PineError('Cancelled', 0, 0, 'runtime');
        }
      }
    } catch (e) {
      this.error = toScriptError(e, bar);
    }
    return this.result(performance.now() - t0);
  }

  /**
   * Live update: `data` has the same arrays updated (last bar changed) or extended by new bars.
   * Re-executes only what is needed using commit/rollback.
   */
  update(data: BarSeries, security?: Record<string, BarSeries>): ScriptResult {
    const t0 = performance.now();
    const R = this.R;
    const oldN = R.n;
    const newN = data.length;
    if (this.error) return this.result(0);
    try {
      R.d = data as unknown as BarData;
      this.opts.data = data;
      if (this.broker) (this.broker as any).data = data;
      if (security && this.c.security.length) this.prepareSecurity(security);
      if (newN < oldN || newN - oldN > 5 || R.committedBar < 0) {
        // too much changed: full rerun
        return this.rebuild(data, security);
      }
      R.ensureCapacity(newN);
      if (this.broker && this.broker.equity.length < newN) {
        const eq = new Float64Array(newN * 2).fill(NaN);
        eq.set(this.broker.equity);
        this.broker.equity = eq;
      }
      // re-run the previously realtime bar with its final data, then new bars
      R.rollback();
      R.isRealtime = true;
      for (let i = oldN - 1; i < newN; i++) {
        if (i === newN - 1) {
          R.lastHistBar = newN - 2;
          R.commit();
        }
        this.step(i);
      }
    } catch (e) {
      this.error = toScriptError(e, R.i);
    }
    return this.result(performance.now() - t0);
  }

  private rebuild(data: BarSeries, security?: Record<string, BarSeries>): ScriptResult {
    const fresh = new PineInstance(this.c, { ...this.opts, data, security: security || this.opts.security, realtime: true });
    Object.assign(this, { R: fresh.R, main: fresh.main, broker: fresh.broker, error: null });
    return fresh.run();
  }

  result(ms: number): ScriptResult {
    const R = this.R;
    const c = this.c;
    const res = emptyResult('pine', this.error || undefined);
    res.meta = { type: c.meta.type === 'strategy' ? 'strategy' : 'indicator', title: c.meta.title, shortTitle: c.meta.shortTitle, overlay: c.meta.overlay, precision: c.meta.precision };
    res.inputs = c.inputs.map((i) => ({ key: i.key, type: i.type, title: i.title, defval: i.defval, min: i.min, max: i.max, step: i.step, options: i.options, tooltip: i.tooltip, group: i.group, inline: i.inline }));
    const n = R.n;
    res.plots = R.plots.map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      style: String(p.style || p.type).replace('style_', ''),
      color: cssColor(p.color) || '#2196F3',
      colors: p.colors ? p.colors.slice(0, n).map((x) => cssColor(x)) : null,
      values: p.values.length === n ? p.values : p.values.slice(0, n),
      width: p.width,
      offset: p.offset,
      histbase: p.histbase,
      display: p.display,
      trackPrice: p.trackPrice,
      location: p.location,
      text: p.text,
      char: p.char,
      textColor: cssColor(p.textColor ?? null) || undefined,
      size: p.size,
      o: p.o?.slice(0, n),
      h: p.h?.slice(0, n),
      l: p.l?.slice(0, n),
      colorup: cssColor((p as any).colorup) || undefined,
      colordown: cssColor((p as any).colordown) || undefined,
    }));
    res.hlines = R.hlines.filter((h) => isFinite(h.price)).map((h) => ({ id: h.id, title: h.title, price: h.price, color: cssColor(h.color) || '#787B86', style: h.style, width: h.width, display: h.display }));
    res.fills = R.fills.map((f) => ({ a: f.a, b: f.b, color: cssColor(f.color) || 'rgba(33,150,243,0.2)', colors: f.colors ? f.colors.slice(0, n).map((x) => cssColor(x)) : null }));
    res.bgcolors = R.bgcolors ? R.bgcolors.slice(0, n).map((x) => cssColor(x)) : null;
    res.barcolors = R.barcolors ? R.barcolors.slice(0, n).map((x) => cssColor(x)) : null;
    const xToBar = (x: number, xloc: string) => (xloc === 'bar_time' ? timeToBar(R.d.t, n, x) : x);
    res.labels = R.labels.filter((l) => !l.deleted).map((l) => ({ x: xToBar(l.x, l.xloc), y: l.y, yloc: l.yloc, text: l.text, color: cssColor(l.color) || 'rgba(0,0,0,0)', textColor: cssColor(l.textcolor) || '#fff', style: l.style, size: l.size, tooltip: l.tooltip }));
    res.lines = R.lines.filter((l) => !l.deleted).map((l) => ({ x1: xToBar(l.x1, l.xloc), y1: l.y1, x2: xToBar(l.x2, l.xloc), y2: l.y2, color: cssColor(l.color) || '#2196F3', width: l.width, style: l.style.replace('style_', ''), extend: l.extend }));
    res.boxes = R.boxes.filter((b) => !b.deleted).map((b) => ({ left: xToBar(b.left, b.xloc), top: b.top, right: xToBar(b.right, b.xloc), bottom: b.bottom, border: cssColor(b.border) || 'rgba(0,0,0,0)', bg: cssColor(b.bg) || 'rgba(0,0,0,0)', width: b.borderWidth, text: b.text, textColor: cssColor(b.textColor) || undefined, extend: b.extend }));
    res.tables = R.tables.filter((t) => !t.deleted).map((t) => ({ position: t.position, bg: cssColor(t.bg) || undefined, border: cssColor(t.border) || undefined, cells: [...t.cells.entries()].map(([k, v]) => ({ col: +k.split(',')[0], row: +k.split(',')[1], text: v.text, bg: cssColor(v.bg) || undefined, color: cssColor(v.color) || undefined })) }));
    res.alerts = R.alerts.map((a) => ({ title: a.title, message: a.message, values: a.values.slice(0, n) }));
    res.alertEvents = R.alertEvents.slice(-500);
    res.logs = R.logs.slice(-2000);
    res.warnings = [...c.warnings.map((w) => ({ line: w.line, message: w.message, kind: w.kind })), ...[...R.warnings].map((m) => ({ message: m, kind: 'runtime' as const }))];
    if (this.broker) res.strategy = brokerRaw(this.broker);
    if (this.R.traceOn) {
      res.trace = {};
      this.c.traceNames.forEach((v, k) => (res.trace![v.name] = this.R.traceData[k].slice(0, n)));
    }
    res.stats = { bars: n, ms };
    return res;
  }
}

function timeToBar(t: Float64Array, n: number, x: number): number {
  let lo = 0;
  let hi = n - 1;
  if (x <= t[0]) return 0;
  if (x >= t[hi]) return hi + (x - t[hi]) / Math.max(1, t[hi] - t[hi - 1] || 60000);
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= x) lo = m;
    else hi = m;
  }
  return lo;
}

export function brokerRaw(br: StrategyBroker): StrategyRaw {
  return {
    trades: br.closed.slice(),
    openTrades: br.open.map((t) => ({ entryId: t.entryId, dir: t.dir, qty: t.qty, entryPrice: t.entryPrice, entryBar: t.entryBar, entryTime: t.entryTime })),
    equity: br.equity,
    fills: br.fills.slice(),
    initialCapital: br.cfg.initialCapital,
    feesPaid: br.ledger.feesPaid,
    fundingPaid: br.fundingPaid,
    borrowPaid: br.borrowPaid,
    liquidations: br.liquidations,
    warnings: [...br.warnings],
    ticksUsedBars: br.ticksUsedBars,
    config: { ...br.cfg, funding: br.cfg.funding ? `${br.cfg.funding.t.length} events` : undefined, mark: br.cfg.mark ? 'mark-price klines' : undefined },
  };
}

/** One-shot convenience. */
export function runPine(code: string, opts: PineRunOptions): ScriptResult {
  let inst: PineInstance;
  try {
    inst = new PineInstance(code, opts);
  } catch (e) {
    return emptyResult('pine', toScriptError(e));
  }
  return inst.run();
}

export { pineTfToOurs, oursToPineTf, PineError };
