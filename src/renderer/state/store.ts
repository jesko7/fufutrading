import { create } from 'zustand';
import { api } from '../api';
import type { Workspace, ModuleState, LayoutNode, DropPos } from '../../shared/workspace';
import type { AppSettings } from '../../shared/settings';
import { mergeSettings } from '../../shared/settings';
import { setTimezoneMode } from '../lib/format';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind?: 'info' | 'ok' | 'warn' | 'error';
  timeout?: number;
  action?: { label: string; run: () => void };
}

export interface ModalSpec {
  id: string;
  render: (close: () => void) => any;
}

interface AppState {
  windowId: string;
  settings: AppSettings;
  workspace: Workspace | null;
  rev: number;
  showStart: boolean;
  focusedModule: string | null;
  paletteOpen: boolean;
  toasts: Toast[];
  modals: ModalSpec[];
  dragModule: string | null;
  setSettings(s: AppSettings): void;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setWorkspace(ws: Workspace, rev: number): void;
  op(op: any): Promise<void>;
  setRootLocal(root: LayoutNode | null): void;
  setModuleConfig(moduleId: string, config: Record<string, any>): void;
  addModule(m: ModuleState, targetStack: string | null, pos: DropPos): Promise<void>;
  setFocused(id: string | null): void;
  setShowStart(v: boolean): void;
  setPalette(v: boolean): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  openModal(m: ModalSpec): void;
  closeModal(id: string): void;
  setDragModule(id: string | null): void;
}

let toastId = 1;

export const useApp = create<AppState>((set, get) => ({
  windowId: api.windowId,
  settings: mergeSettings(null),
  workspace: null,
  rev: 0,
  showStart: false,
  focusedModule: null,
  paletteOpen: false,
  toasts: [],
  modals: [],
  dragModule: null,
  setSettings(s) {
    setTimezoneMode(s.timezone);
    applyTheme(s);
    set({ settings: s });
  },
  async updateSettings(patch) {
    const next = await api.call<AppSettings>('settings:set', patch);
    get().setSettings(next);
  },
  setWorkspace(ws, rev) {
    if (rev < get().rev) return;
    set({ workspace: ws, rev });
  },
  async op(op) {
    await api.call('ws:op', op);
  },
  setRootLocal(root) {
    const ws = get().workspace;
    if (!ws) return;
    const windows = ws.windows.map((w) => (w.id === get().windowId ? { ...w, root } : w));
    set({ workspace: { ...ws, windows } });
    void api.call('ws:op', { kind: 'setRoot', windowId: get().windowId, root });
  },
  setModuleConfig(moduleId, config) {
    const ws = get().workspace;
    if (ws && ws.modules[moduleId]) {
      const m = ws.modules[moduleId];
      set({ workspace: { ...ws, modules: { ...ws.modules, [moduleId]: { ...m, config: { ...m.config, ...config } } } } });
    }
    void api.call('ws:op', { kind: 'setModuleConfig', moduleId, config });
  },
  async addModule(m, targetStack, pos) {
    await api.call('ws:op', { kind: 'addModule', windowId: get().windowId, module: m, targetStack, pos });
    set({ focusedModule: m.id, showStart: false });
  },
  setFocused(id) {
    if (get().focusedModule !== id) set({ focusedModule: id });
  },
  setShowStart(v) {
    set({ showStart: v });
  },
  setPalette(v) {
    set({ paletteOpen: v });
  },
  toast(t) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    const timeout = t.timeout ?? (t.kind === 'error' ? 8000 : 4500);
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
  openModal(m) {
    set({ modals: [...get().modals.filter((x) => x.id !== m.id), m] });
  },
  closeModal(id) {
    set({ modals: get().modals.filter((x) => x.id !== id) });
  },
  setDragModule(id) {
    set({ dragModule: id });
  },
}));

let mql: MediaQueryList | null = null;
export function applyTheme(s: AppSettings): void {
  const resolve = () => (s.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.theme);
  document.documentElement.dataset.theme = resolve();
  document.documentElement.style.setProperty('--accent', s.accent);
  document.documentElement.style.setProperty('--up', s.chart.up);
  document.documentElement.style.setProperty('--down', s.chart.down);
  if (s.theme === 'system' && !mql) {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => applyTheme(useApp.getState().settings));
  }
  window.dispatchEvent(new CustomEvent('fufu-theme'));
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

export function toast(t: Omit<Toast, 'id'>): void {
  useApp.getState().toast(t);
}
