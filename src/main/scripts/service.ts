/**
 * ScriptService — script library RPC, analysis, and live script instances for charts.
 *
 * A chart indicator subscription acquires the same ManagedSeries the chart shows, opens a
 * script instance on a worker and forwards bar deltas (coalesced, forming-bar updates
 * throttled, new bars immediately). Data the script asks for (request.security / data.htf)
 * is loaded on demand from the SeriesService and kept live as well. Results travel to the
 * renderer as full results or tail patches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dialog, BrowserWindow } from 'electron';
import type { AppCore } from '../core';
import { ScriptPool } from './pool';
import { ScriptLibrary } from './library';
import type { ManagedSeries } from '../market/series';
import type { InstanceReply, InstanceUpdate } from '../../engine/host';
import { keyParts } from '../../engine/host';
import type { RunContext, ScriptLanguage } from '../../engine/types';
import type { BrokerConfig } from '../../engine/backtest/broker';
import type { SeriesSpec, SeriesUpdate } from '../../shared/marketTypes';
import { SYMBOL_SPECS, isSymbol, type SymbolId } from '../../shared/symbols';
import { parseTimeframe } from '../../shared/timeframes';
import { uid } from '../storage/jsonStore';
import type { PyInitOptions } from '../../engine/python/host';

export interface IndicatorParams {
  scriptId?: string;
  /** Unsaved code from the editor (overrides scriptId's code). */
  code?: string;
  language?: ScriptLanguage;
  inputs?: Record<string, unknown>;
  spec: SeriesSpec;
  strategy?: Partial<BrokerConfig> | null;
  bars?: number;
}

const THROTTLE_MS = 250;

function resolvePyodideDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let p = path.dirname(require.resolve('pyodide/package.json'));
    const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (unpacked !== p && fs.existsSync(unpacked)) p = unpacked;
    return fs.existsSync(path.join(p, 'pyodide.js')) ? p : null;
  } catch {
    return null;
  }
}

export function runContext(spec: Pick<SeriesSpec, 'symbol' | 'market' | 'tf' | 'chartType'>): RunContext {
  const s = SYMBOL_SPECS[spec.symbol];
  return { symbol: spec.symbol, market: spec.market, tf: spec.tf, chartType: spec.chartType === 'heikinashi' || spec.chartType === 'renko' ? spec.chartType : 'candles', mintick: s[spec.market].tickSize, base: s.base, quote: s.quote };
}

/** One live script on one chart series. */
class LiveScript {
  readonly inst = `live_${uid()}`;
  private series!: ManagedSeries;
  private releaseSeries: (() => void) | null = null;
  private unsubSeries: (() => void) | null = null;
  private sec = new Map<string, { series: ManagedSeries; release: () => void; unsub: () => void; dirtyFrom: number; sent: boolean }>();
  private dirtyFrom = Infinity;
  private needReset = false;
  private sentLen = 0;
  private inflight = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = 0;
  private closed = false;
  private opened = false;
  private reopenTimes: number[] = [];
  private code = '';
  private language: ScriptLanguage = 'pine';
  private scriptName = '';
  private offLib: (() => void) | null = null;
  private offLost: (() => void) | null = null;

  constructor(
    private svc: ScriptService,
    private p: IndicatorParams,
    private push: (d: unknown) => void,
  ) {}

  async start(): Promise<void> {
    const core = this.svc.core;
    if (!isSymbol(this.p.spec?.symbol) || (this.p.spec.market !== 'spot' && this.p.spec.market !== 'futures')) throw new Error('Validation: invalid instrument');
    if (!parseTimeframe(this.p.spec.tf)) throw new Error('Validation: invalid timeframe');
    this.loadCode();
    const { series, release } = core.series.acquire(this.p.spec, { bars: this.p.bars });
    this.series = series;
    this.releaseSeries = release;
    this.push({ type: 'status', status: 'loading', script: this.scriptInfo() });
    await series.ready;
    if (this.closed) return;
    if (series.status === 'error') {
      this.push({ type: 'error', message: series.info.error || 'Data unavailable' });
      return;
    }
    this.unsubSeries = series.subscribe((u) => this.onBars(u));
    if (this.p.scriptId && !this.p.code) {
      const onChange = (id: string) => {
        if (id !== this.p.scriptId || this.closed) return;
        const before = this.code;
        this.loadCode();
        if (this.code !== before) void this.open();
      };
      this.svc.library.on('changed', onChange);
      this.offLib = () => this.svc.library.off('changed', onChange);
    }
    const onLost = (inst: string, reason: string) => {
      if (inst !== this.inst || this.closed) return;
      const now = Date.now();
      this.reopenTimes = this.reopenTimes.filter((t) => now - t < 60000);
      if (this.reopenTimes.length >= 3) {
        this.push({ type: 'error', message: `The script stopped its worker repeatedly (${reason}). Fix the script and re-add it.` });
        return;
      }
      this.reopenTimes.push(now);
      setTimeout(() => void this.open(), 500);
    };
    this.svc.pool.lostListeners.add(onLost);
    this.offLost = () => this.svc.pool.lostListeners.delete(onLost);
    await this.open();
  }

  private loadCode(): void {
    if (this.p.code !== undefined) {
      this.code = String(this.p.code);
      this.language = this.p.language === 'python' ? 'python' : 'pine';
      this.scriptName = 'Editor preview';
      return;
    }
    const doc = this.p.scriptId ? this.svc.library.get(this.p.scriptId) : undefined;
    if (!doc) throw new Error(`Script ${this.p.scriptId} not found`);
    this.code = doc.code;
    this.language = doc.language;
    this.scriptName = doc.name;
  }

  private scriptInfo() {
    return { id: this.p.scriptId || null, name: this.scriptName, language: this.language };
  }

  private securityPacked(): Record<string, Float64Array> {
    const r: Record<string, Float64Array> = {};
    for (const [k, s] of this.sec) r[k] = s.series.out.pack();
    return r;
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    if (this.language === 'python' && !this.svc.pool.pythonAvailable) {
      this.push({ type: 'error', message: 'Python runtime (Pyodide) is not installed in this build.' });
      return;
    }
    this.cancelTimer();
    // a pending update would be applied to the new instance twice: drop it, the snapshot covers it
    this.dirtyFrom = Infinity;
    this.needReset = false;
    for (const s of this.sec.values()) s.dirtyFrom = Infinity;
    const out = this.series.out;
    this.sentLen = out.length;
    this.inflight = true;
    try {
      const reply = await this.svc.pool.open(this.inst, {
        lang: this.language,
        code: this.code,
        ctx: runContext(this.p.spec),
        inputs: this.p.inputs || {},
        strategy: this.brokerOverrides(),
        bars: out.pack(),
        realtime: true,
        security: this.securityPacked(),
      });
      this.opened = true;
      this.handle(reply, true);
    } catch (e) {
      if (!this.closed) this.push({ type: 'error', message: (e as Error).message });
    } finally {
      this.inflight = false;
    }
    if (this.again || this.dirtyFrom !== Infinity || this.needReset) {
      this.again = false;
      this.schedule(0);
    }
  }

  /** Chart strategies trade the chart's market with its exchange filters unless overridden. */
  private brokerOverrides(): Partial<BrokerConfig> | null {
    if (this.p.strategy === null) return null;
    const o = { ...(this.p.strategy || {}) } as Partial<BrokerConfig>;
    const market = o.market || this.p.spec.market;
    const f = SYMBOL_SPECS[this.p.spec.symbol][market];
    return { market, step: f.stepSize, ...o };
  }

  private handle(r: InstanceReply, opening = false): void {
    if (this.closed) return;
    if (r.kind === 'full') this.push({ type: 'full', result: r.result, t0: r.t0, script: this.scriptInfo() });
    else if (r.kind === 'patch') this.push({ type: 'patch', patch: r.patch });
    else if (opening) this.push({ type: 'status', status: 'running', script: this.scriptInfo() });
    if (r.need.length) void this.loadSecurity(r.need);
  }

  private async loadSecurity(keys: string[]): Promise<void> {
    const fresh: string[] = [];
    for (const key of keys) {
      if (this.sec.has(key)) continue;
      const kp = keyParts(key);
      if (!isSymbol(kp.symbol)) {
        this.push({ type: 'error', message: `Unsupported symbol in ${key}` });
        return;
      }
      const spec: SeriesSpec = { symbol: kp.symbol as SymbolId, market: kp.market, tf: kp.tf, chartType: kp.chartType === 'heikinashi' ? 'heikinashi' : 'candles' };
      const { series, release } = this.svc.core.series.acquire(spec, { bars: Math.min(20000, Math.max(500, this.p.bars || 2000)) });
      const entry = { series, release, unsub: () => {}, dirtyFrom: Infinity, sent: false };
      this.sec.set(key, entry);
      try {
        await series.ready;
      } catch {
        /* status checked below */
      }
      if (this.closed) return;
      if (series.status === 'error') {
        this.push({ type: 'error', message: `${key}: ${series.info.error || 'data unavailable'}` });
        continue;
      }
      entry.unsub = series.subscribe((u) => {
        if (u.reset) {
          entry.sent = false;
          this.schedule(0);
          return;
        }
        entry.dirtyFrom = Math.min(entry.dirtyFrom, u.index);
        this.schedule(THROTTLE_MS);
      });
      fresh.push(key);
    }
    if (fresh.length) this.schedule(0);
  }

  private onBars(u: SeriesUpdate): void {
    if (this.closed) return;
    if (u.reset) {
      this.needReset = true;
      this.schedule(0);
      return;
    }
    this.dirtyFrom = Math.min(this.dirtyFrom, u.index);
    // a new bar (or a correction of a closed bar) is processed immediately, forming-bar ticks are throttled
    const immediate = u.length !== this.sentLen || u.index < this.sentLen - 1;
    this.schedule(immediate ? 0 : THROTTLE_MS);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    const at = Date.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    this.cancelTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.closed || !this.opened) return;
    if (this.inflight) {
      this.again = true;
      return;
    }
    const out = this.series.out;
    const u: InstanceUpdate = {};
    if (this.needReset) {
      u.reset = out.pack();
      this.needReset = false;
      this.dirtyFrom = Infinity;
    } else if (this.dirtyFrom !== Infinity) {
      const from = Math.max(0, Math.min(this.dirtyFrom, this.sentLen, out.length));
      u.bars = { index: from, packed: out.pack(from, out.length), length: out.length };
      this.dirtyFrom = Infinity;
    }
    for (const [k, s] of this.sec) {
      if (s.series.status === 'error') continue;
      if (!s.sent) {
        (u.securityFull ||= {})[k] = s.series.out.pack();
        s.sent = true;
        s.dirtyFrom = Infinity;
      } else if (s.dirtyFrom !== Infinity) {
        const so = s.series.out;
        const from = Math.max(0, Math.min(s.dirtyFrom, so.length));
        (u.security ||= {})[k] = { index: from, packed: so.pack(from, so.length), length: so.length };
        s.dirtyFrom = Infinity;
      }
    }
    if (!u.bars && !u.reset && !u.security && !u.securityFull) return;
    this.sentLen = out.length;
    this.inflight = true;
    try {
      const reply = await this.svc.pool.update(this.inst, u);
      this.handle(reply);
    } catch (e) {
      const msg = (e as Error).message;
      if (!this.closed && !/lost|worker/i.test(msg)) this.push({ type: 'error', message: msg });
    } finally {
      this.inflight = false;
    }
    if (this.again) {
      this.again = false;
      this.schedule(0);
    }
  }

  stop(): void {
    this.closed = true;
    this.cancelTimer();
    this.unsubSeries?.();
    this.offLib?.();
    this.offLost?.();
    this.svc.pool.close(this.inst);
    for (const s of this.sec.values()) {
      s.unsub();
      s.release();
    }
    this.sec.clear();
    this.releaseSeries?.();
  }
}

export class ScriptService {
  readonly pool: ScriptPool;
  readonly library: ScriptLibrary;
  readonly pyOpts: PyInitOptions | null;

  constructor(readonly core: AppCore) {
    const dist = core.paths.dist;
    const pyodideDir = resolvePyodideDir();
    this.pyOpts = pyodideDir
      ? { pyodideDir, cacheDir: path.join(core.paths.userData, 'pyodide-packages'), pythonDir: path.join(dist, 'python'), bundledWheels: path.join(dist, 'wheels') }
      : null;
    if (!pyodideDir) core.log('warn', 'scripts: Pyodide not found — Python scripting disabled');
    this.pool = new ScriptPool(path.join(dist, 'workers', 'scriptWorker.js'), this.pyOpts, core.log);
    this.library = new ScriptLibrary(core.paths.userData, path.join(dist, 'library'));
    this.library.on('changed', (id: string) => core.router.broadcast('scripts:changed', { id }));
    core.onShutdown(async () => {
      this.library.flush();
      await this.pool.shutdown();
    });
    this.register();
  }

  private register(): void {
    const r = this.core.router;
    r.handle('scripts:list', () => this.library.list());
    r.handle('scripts:get', ([id]) => {
      const d = this.library.get(String(id));
      if (!d) throw new Error('Script not found');
      return d;
    });
    r.handle('scripts:save', ([doc]) => this.library.save(doc));
    r.handle('scripts:rename', ([id, name]) => this.library.rename(String(id), String(name)));
    r.handle('scripts:duplicate', ([id]) => this.library.duplicate(String(id)));
    r.handle('scripts:delete', ([id]) => {
      this.library.delete(String(id));
      return true;
    });
    r.handle('scripts:setFlag', ([id, flag, on]) => {
      if (flag !== 'favorite' && flag !== 'pinned') throw new Error('Validation: flag');
      this.library.setFlag(String(id), flag, !!on);
      return true;
    });
    r.handle('scripts:import', async (_a, ctx) => {
      const win = BrowserWindow.fromWebContents(ctx.sender) || undefined;
      const res = await (win ? dialog.showOpenDialog(win, this.importOpts()) : dialog.showOpenDialog(this.importOpts()));
      if (res.canceled) return [];
      const out = [];
      for (const f of res.filePaths) {
        try {
          out.push(this.library.importFile(f));
        } catch (e) {
          this.core.log('warn', `import ${f}: ${(e as Error).message}`);
          throw e;
        }
      }
      return out;
    });
    r.handle('scripts:importText', ([name, code, language]) => this.library.save({ name: String(name || ''), code: String(code), language: language === 'python' ? 'python' : 'pine' }));
    r.handle('scripts:export', async ([id], ctx) => {
      const d = this.library.get(String(id));
      if (!d) throw new Error('Script not found');
      const win = BrowserWindow.fromWebContents(ctx.sender) || undefined;
      const ext = d.language === 'python' ? 'py' : 'pine';
      const opts = { defaultPath: `${d.name.replace(/[<>:"/\\|?*]+/g, '_')}.${ext}`, filters: [{ name: d.language === 'python' ? 'Python' : 'Pine Script', extensions: [ext] }, { name: 'All files', extensions: ['*'] }] };
      const res = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
      if (res.canceled || !res.filePath) return null;
      this.library.exportFile(d.id, res.filePath);
      return res.filePath;
    });
    r.handle('scripts:analyze', async ([language, code, spec]) => {
      const lang: ScriptLanguage = language === 'python' ? 'python' : 'pine';
      if (lang === 'python' && !this.pool.pythonAvailable) return { ok: false, language: lang, error: { message: 'Python runtime (Pyodide) is not available', kind: 'python' }, inputs: [], warnings: [], security: [] };
      const ctx = spec && isSymbol(spec.symbol) ? runContext(spec) : runContext({ symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' });
      return this.pool.analyze(lang, String(code ?? ''), ctx);
    });
    r.handle('scripts:python', async ([action]) => {
      if (action === 'warm') {
        try {
          await this.pool.warmPython();
          return { available: !!this.pyOpts, ready: true };
        } catch (e) {
          return { available: !!this.pyOpts, ready: false, error: (e as Error).message };
        }
      }
      return { available: !!this.pyOpts };
    });
    r.handle('scripts:workers', () => this.pool.stats());
    r.topic('indicator', async (params: IndicatorParams, push) => {
      const live = new LiveScript(this, params, push);
      try {
        await live.start();
      } catch (e) {
        live.stop();
        throw e;
      }
      return () => live.stop();
    });
  }

  private importOpts(): Electron.OpenDialogOptions {
    return { title: 'Import scripts', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Scripts', extensions: ['pine', 'py', 'txt', 'pinescript'] }, { name: 'All files', extensions: ['*'] }] };
  }
}

export function registerScripts(core: AppCore): ScriptService {
  return new ScriptService(core);
}
