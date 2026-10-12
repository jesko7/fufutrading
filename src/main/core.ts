/**
 * AppCore — constructs and wires all main-process services and exposes them over IPC.
 */
import { app, shell, Notification, clipboard, nativeImage } from 'electron';
import path from 'node:path';
import { createLogger, type Logger, type LogEntry } from './logger';
import { IpcRouter } from './ipc';
import { JsonFile } from './storage/jsonStore';
import { CandleStore, binanceKlineSource } from './storage/candleStore';
import { MarketHub } from './market/hub';
import { SeriesService } from './market/series';
import { WorkspaceService, type WorkspaceOp } from './workspaces';
import { WindowManager } from './windows';
import { createShortcuts, getAutostart, setAutostart } from './desktop';
import { mergeSettings, type AppSettings } from '../shared/settings';
import type { SeriesSpec, ImbalanceMethod } from '../shared/marketTypes';
import type { Market, SymbolId } from '../shared/symbols';
import { isSymbol } from '../shared/symbols';
import type { Rect } from '../shared/workspace';

export interface CorePaths {
  userData: string;
  data: string;
  logs: string;
  resources: string;
  renderer: string;
  preload: string;
  dist: string;
}

function assertInstrument(symbol: unknown, market: unknown): asserts symbol is SymbolId {
  if (!isSymbol(symbol)) throw new Error(`Validation: unsupported symbol ${String(symbol)}`);
  if (market !== 'spot' && market !== 'futures') throw new Error(`Validation: unsupported market ${String(market)}`);
}

export class AppCore {
  readonly log: Logger;
  readonly recentLogs: LogEntry[];
  readonly router: IpcRouter;
  readonly settingsFile: JsonFile<AppSettings>;
  readonly hub: MarketHub;
  readonly store: CandleStore;
  readonly series: SeriesService;
  readonly workspaces: WorkspaceService;
  readonly windows: WindowManager;
  quitting = false;
  /** Services register extra shutdown hooks here. */
  private shutdownHooks: (() => void | Promise<void>)[] = [];

  constructor(readonly paths: CorePaths) {
    const { log, recent } = createLogger(paths.logs);
    this.log = log;
    this.recentLogs = recent;
    this.router = new IpcRouter(log);
    this.settingsFile = new JsonFile<AppSettings>(path.join(paths.userData, 'settings.json'), mergeSettings(null));
    this.settingsFile.set(mergeSettings(this.settingsFile.get()));
    this.hub = new MarketHub(log);
    this.store = new CandleStore(paths.data, binanceKlineSource(this.hub.rest), log);
    this.series = new SeriesService(this.hub, this.store, log);
    this.workspaces = new WorkspaceService(paths.userData);
    this.windows = new WindowManager(this.workspaces, this.router, log, {
      iconPath: path.join(paths.resources, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      rendererDir: paths.renderer,
      preloadPath: paths.preload,
      shouldHideOnClose: () => this.shouldStayInBackground(),
      isQuitting: () => this.quitting,
    });
    this.workspaces.on('changed', (ws, rev) => this.router.broadcast('workspace', { workspace: ws, rev }));
  }

  get settings(): AppSettings {
    return this.settingsFile.get();
  }

  onShutdown(fn: () => void | Promise<void>): void {
    this.shutdownHooks.push(fn);
  }

  /** Background mode: keep running (tray) when windows close if bots are active. */
  shouldStayInBackground(): boolean {
    const s = this.settings.background;
    return s.closeToTray && s.runBotsInBackground && this.activeBotCount() > 0;
  }

  activeBotCount: () => number = () => 0;

  notify(title: string, body: string): void {
    if (!this.settings.notifications.desktop) return;
    try {
      if (Notification.isSupported()) new Notification({ title, body, silent: !this.settings.notifications.sound }).show();
    } catch {
      /* ignore */
    }
  }

  async start(): Promise<void> {
    this.router.install();
    this.registerCore();
    this.registerMarket();
    const dark = this.settings.theme !== 'light';
    this.windows.setTheme(dark);
    this.log('info', `FuFu Trading ${app.getVersion()} started (electron ${process.versions.electron}, ${process.platform})`);
  }

  private registerCore(): void {
    const r = this.router;
    r.handle('app:info', () => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      userData: this.paths.userData,
      data: this.paths.data,
      packaged: app.isPackaged,
    }));
    r.handle('settings:get', () => this.settings);
    r.handle('settings:set', ([patch]) => {
      const next = mergeSettings({ ...this.settings, ...patch });
      this.settingsFile.set(next);
      if (patch.theme) this.windows.setTheme(next.theme !== 'light');
      if (patch.background && typeof patch.background.startAtLogin === 'boolean') {
        try {
          setAutostart(patch.background.startAtLogin, this.paths.resources);
        } catch (e) {
          this.log('warn', `autostart: ${(e as Error).message}`);
        }
      }
      this.router.broadcast('settings', next);
      return next;
    });
    r.handle('log:recent', () => this.recentLogs.slice(-300));
    r.handle('shell:openExternal', ([url]) => {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
      throw new Error('Validation: only http(s) URLs');
    });
    r.handle('desktop:createShortcuts', () => createShortcuts(this.paths.resources));
    r.handle('clipboard:image', ([dataUrl]) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) throw new Error('Validation: PNG data URL expected');
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      return true;
    });
    r.handle('clipboard:text', ([text]) => {
      clipboard.writeText(String(text));
      return true;
    });
    r.handle('desktop:getAutostart', () => getAutostart());
    // workspaces
    r.handle('ws:get', (_a, ctx) => ({ workspace: this.workspaces.current, rev: this.workspaces.rev, windowId: ctx.windowId, sourceId: this.workspaces.sourceId, hasSession: this.workspaces.hasSession }));
    r.handle('ws:list', () => this.workspaces.list());
    r.handle('ws:load', ([id]) => this.workspaces.load(id));
    r.handle('ws:save', ([name, asPreset, asNew]) => this.workspaces.save(name, !!asPreset, !!asNew));
    r.handle('ws:delete', ([id]) => this.workspaces.delete(id));
    r.handle('ws:rename', ([id, name]) => this.workspaces.rename(id, name));
    r.handle('ws:op', ([op]) => {
      this.workspaces.apply(op as WorkspaceOp);
      return this.workspaces.rev;
    });
    r.handle('ws:detach', ([moduleId, bounds]) => this.workspaces.detach(moduleId, bounds as Rect | undefined));
    r.handle('ws:reattach', ([windowId]) => this.workspaces.reattachWindow(windowId));
    r.handle('win:focusMain', () => this.windows.showMain());
    // renderer event bus relay (crosshair sync, symbol links across windows)
    r.handle('bus:emit', ([name, data, origin], ctx) => {
      this.router.broadcast('bus', { name, data, origin }, ctx.sender);
      return true;
    });
  }

  private registerMarket(): void {
    const r = this.router;
    r.topic('series', async (params: SeriesSpec & { bars?: number }, push) => {
      assertInstrument(params.symbol, params.market);
      const { series, release } = this.series.acquire(params, { bars: params.bars });
      await series.ready;
      push({ type: 'snapshot', ...series.snapshot() });
      const unsub = series.subscribe((u) => {
        if (u.reset) push({ type: 'snapshot', ...series.snapshot() });
        else push({ type: 'update', ...u });
      });
      return () => {
        unsub();
        release();
      };
    });
    r.handle('series:loadMore', async ([key, count]) => {
      const s = this.series.get(key);
      if (!s) return false;
      return s.loadMore(Math.min(20000, Math.max(100, count || 2000)));
    });
    r.topic('ticker', (params: { symbol: SymbolId; market: Market }, push) => {
      assertInstrument(params.symbol, params.market);
      return this.hub.subscribeTicker(params.market, params.symbol, (t) => push(t));
    });
    r.topic('mark', (params: { symbol: SymbolId }, push) => {
      assertInstrument(params.symbol, 'futures');
      return this.hub.subscribeMark(params.symbol, (m) => push(m));
    });
    r.topic('book', (params: { symbol: SymbolId; market: Market; group: number; levels: number; imbalance?: { method: ImbalanceMethod; param: number }; intervalMs?: number }, push) => {
      assertInstrument(params.symbol, params.market);
      const { book, release } = this.hub.acquireBook(params.market, params.symbol);
      let dirty = true;
      const unl = book.addListener({ onBook: () => (dirty = true), onStatus: () => (dirty = true) });
      const imb = params.imbalance || { method: 'depthPct' as ImbalanceMethod, param: 0.5 };
      const timer = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        if (book.status !== 'live') {
          push({ t: Date.now(), status: book.status, bids: [], asks: [], metrics: null });
          return;
        }
        push(book.snapshot(params.group || 0, Math.min(500, params.levels || 20), imb));
      }, Math.max(50, params.intervalMs || 100));
      return () => {
        clearInterval(timer);
        unl();
        release();
      };
    });
    r.topic('heatmap', (params: { symbol: SymbolId; market: Market; since?: number }, push) => {
      assertInstrument(params.symbol, params.market);
      const { book, release } = this.hub.acquireBook(params.market, params.symbol);
      let lastT = params.since || 0;
      const send = () => {
        const cols = book.heatmap.filter((c) => c.t > lastT);
        if (!cols.length) return;
        lastT = cols[cols.length - 1].t;
        push({ columns: cols, large: book.activeLargeOrders(), events: book.largeEvents.slice(-50) });
      };
      send();
      const timer = setInterval(send, 1000);
      return () => {
        clearInterval(timer);
        release();
      };
    });
    r.handle('book:options', ([symbol, market, opts]) => {
      assertInstrument(symbol, market);
      const b = this.hub.bookFor(market, symbol);
      if (!b) return false;
      if (opts.heatmapBin > 0) {
        b.heatmapBin = opts.heatmapBin;
        b.heatmap.length = 0;
      }
      if (opts.largeThresholdUsd > 0) b.largeThresholdUsd = opts.largeThresholdUsd;
      return true;
    });
    r.topic('trades', (params: { symbol: SymbolId; market: Market }, push) => {
      assertInstrument(params.symbol, params.market);
      const { tape, release } = this.hub.acquireTape(params.market, params.symbol);
      push({ initial: true, trades: tape.recent.slice(-300) });
      let buf: unknown[] = [];
      const unl = tape.addListener({ onTrade: (t) => buf.push(t) });
      const timer = setInterval(() => {
        if (!buf.length) return;
        const b = buf;
        buf = [];
        push({ trades: b });
      }, 80);
      return () => {
        clearInterval(timer);
        unl();
        release();
      };
    });
    r.topic('largeOrders', (params: { symbol: SymbolId; market: Market }, push) => {
      assertInstrument(params.symbol, params.market);
      const { book, release } = this.hub.acquireBook(params.market, params.symbol);
      let lastT = 0;
      const timer = setInterval(() => {
        const ev = book.largeEvents.filter((e) => e.t > lastT);
        if (ev.length) lastT = ev[ev.length - 1].t;
        push({ events: ev, active: book.activeLargeOrders(), threshold: book.largeThresholdUsd });
      }, 1000);
      return () => {
        clearInterval(timer);
        release();
      };
    });
    r.topic('conn', (_p, push) => {
      push(this.hub.connectionInfo());
      const timer = setInterval(() => push(this.hub.connectionInfo()), 2000);
      return () => clearInterval(timer);
    });
    r.handle('market:lastPrice', ([symbol, market]) => {
      assertInstrument(symbol, market);
      return this.hub.lastPrice(market, symbol);
    });
    r.handle('data:stats', ([kind, market, symbol, interval]) => this.store.stats(kind, market, symbol, interval));
  }

  async shutdown(): Promise<void> {
    for (const fn of this.shutdownHooks) {
      try {
        await fn();
      } catch (e) {
        this.log('warn', `shutdown hook: ${(e as Error).message}`);
      }
    }
    this.workspaces.flush();
    this.settingsFile.flush();
    this.hub.shutdown();
  }
}
