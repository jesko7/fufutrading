/**
 * Window manager: the main workspace window plus any number of detached module windows.
 * All windows load the same renderer bundle and identify themselves via ?w=<windowId>.
 */
import { BrowserWindow, screen, shell, nativeTheme, app } from 'electron';
import path from 'node:path';
import type { Rect } from '../shared/workspace';
import type { WorkspaceService } from './workspaces';
import type { IpcRouter } from './ipc';
import type { Logger } from './logger';

export interface WindowManagerOptions {
  iconPath: string;
  rendererDir: string;
  preloadPath: string;
  shouldHideOnClose: () => boolean;
  isQuitting: () => boolean;
}

export class WindowManager {
  readonly windows = new Map<string, BrowserWindow>();
  private boundsTimers = new Map<string, NodeJS.Timeout>();
  private themeColors = { bg: '#0b0d12', symbol: '#a1a1aa' };

  constructor(
    private workspaces: WorkspaceService,
    private router: IpcRouter,
    private log: Logger,
    private opts: WindowManagerOptions,
  ) {
    workspaces.on('openWindow', (id: string) => this.open(id));
    workspaces.on('closeWindow', (id: string) => {
      const w = this.windows.get(id);
      if (w && !w.isDestroyed()) {
        (w as any).__programmaticClose = true;
        w.close();
      }
    });
    workspaces.on('reload', () => this.syncWithWorkspace());
  }

  setTheme(dark: boolean): void {
    this.themeColors = dark ? { bg: '#0b0d12', symbol: '#a1a1aa' } : { bg: '#f7f7f8', symbol: '#52525b' };
    nativeTheme.themeSource = dark ? 'dark' : 'light';
    for (const w of this.windows.values()) {
      if (w.isDestroyed()) continue;
      try {
        w.setBackgroundColor(this.themeColors.bg);
        if (process.platform !== 'darwin') w.setTitleBarOverlay({ color: '#00000000', symbolColor: this.themeColors.symbol, height: 38 });
      } catch {
        /* overlay not supported on this platform */
      }
    }
  }

  private visibleBounds(b?: Rect): Rect | undefined {
    if (!b) return undefined;
    const displays = screen.getAllDisplays();
    const ok = displays.some((d) => {
      const a = d.workArea;
      return b.x + 80 < a.x + a.width && b.x + b.width - 80 > a.x && b.y + 40 < a.y + a.height && b.y + 20 > a.y - 20;
    });
    return ok ? b : undefined;
  }

  open(windowId: string): BrowserWindow {
    const existing = this.windows.get(windowId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }
    const wsWin = this.workspaces.current.windows.find((w) => w.id === windowId);
    const isMain = windowId === 'main' || !!wsWin?.main;
    const b = this.visibleBounds(wsWin?.bounds);
    const primary = screen.getPrimaryDisplay().workArea;
    const width = b?.width ?? (isMain ? Math.min(1600, Math.round(primary.width * 0.9)) : 720);
    const height = b?.height ?? (isMain ? Math.min(1000, Math.round(primary.height * 0.9)) : 520);
    const win = new BrowserWindow({
      x: b?.x,
      y: b?.y,
      width,
      height,
      minWidth: 420,
      minHeight: 300,
      show: false,
      backgroundColor: this.themeColors.bg,
      title: 'FuFu Trading',
      icon: this.opts.iconPath,
      titleBarStyle: 'hidden',
      ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#00000000', symbolColor: this.themeColors.symbol, height: 38 } } : { trafficLightPosition: { x: 12, y: 12 } }),
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.windows.set(windowId, win);
    this.router.setWindowId(win.webContents, windowId);
    if (wsWin?.maximized) win.maximize();
    win.once('ready-to-show', () => {
      win.show();
      if (process.env.FUFU_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file:')) {
        e.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log('error', `renderer ${windowId} gone: ${details.reason}`);
      if (details.reason !== 'clean-exit' && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.reload(), 1000);
    });
    win.webContents.on('console-message', (e: any) => {
      const level = e.level ?? 0;
      if (level === 'error' || level === 3) this.log('warn', `[renderer ${windowId}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    const saveBounds = () => {
      const t = this.boundsTimers.get(windowId);
      if (t) clearTimeout(t);
      this.boundsTimers.set(
        windowId,
        setTimeout(() => {
          if (win.isDestroyed()) return;
          const nb = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
          this.workspaces.setBounds(windowId, nb, win.isMaximized());
        }, 500),
      );
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.on('close', (e) => {
      if (isMain && !this.opts.isQuitting() && this.opts.shouldHideOnClose()) {
        e.preventDefault();
        // hide all windows; bots keep running in the background
        for (const w of this.windows.values()) if (!w.isDestroyed()) w.hide();
        return;
      }
      if (isMain && !this.opts.isQuitting()) {
        // closing the main window closes the app (detached windows close with it)
        for (const [id, w] of this.windows) if (id !== windowId && !w.isDestroyed()) {
          (w as any).__programmaticClose = true;
          w.destroy();
        }
      }
    });
    win.on('closed', () => {
      this.windows.delete(windowId);
      if (!isMain && !(win as any).__programmaticClose && !this.opts.isQuitting()) this.workspaces.windowClosed(windowId);
    });
    const file = path.join(this.opts.rendererDir, 'index.html');
    void win.loadFile(file, { query: { w: windowId } });
    return win;
  }

  openMain(): BrowserWindow {
    const w = this.open('main');
    // also reopen detached windows of the workspace
    for (const ww of this.workspaces.current.windows) if (!ww.main && !this.windows.has(ww.id)) this.open(ww.id);
    return w;
  }

  showMain(): void {
    const w = this.windows.get('main');
    if (!w || w.isDestroyed()) {
      this.openMain();
      return;
    }
    for (const x of this.windows.values()) if (!x.isDestroyed()) x.show();
    if (w.isMinimized()) w.restore();
    w.focus();
  }

  /** Open/close windows so they match the current workspace (after loading another one). */
  syncWithWorkspace(): void {
    const ids = new Set(this.workspaces.current.windows.map((w) => w.id));
    for (const [id, w] of this.windows) {
      if (id === 'main') continue;
      if (!ids.has(id) && !w.isDestroyed()) {
        (w as any).__programmaticClose = true;
        w.close();
      }
    }
    if (this.windows.has('main')) for (const w of this.workspaces.current.windows) if (!w.main && !this.windows.has(w.id)) this.open(w.id);
  }

  anyVisible(): boolean {
    return [...this.windows.values()].some((w) => !w.isDestroyed() && w.isVisible());
  }

  get(windowId: string): BrowserWindow | undefined {
    return this.windows.get(windowId);
  }

  closeAll(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    app.focus();
  }
}
