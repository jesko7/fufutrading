/** Application settings (persisted in userData/settings.json). */

export interface ChartStyle {
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  hollowUp: boolean;
  grid: boolean;
  gridColor?: string;
  crosshair: 'cross' | 'dot' | 'none';
  priceLine: boolean;
  volumeOpacity: number;
  font: number;
  /** Touchpad swipes and Shift+wheel move the chart the other way (dragging always follows the pointer). */
  reverseScroll?: boolean;
  /** A flicked chart keeps moving briefly after the release (default on). */
  momentum?: boolean;
}

/** Order-book recording: instruments ("futures:BTCUSDT") saved once a minute, kept for keepDays. */
export interface BookRecordingSettings {
  record: string[];
  keepDays: number;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  chart: ChartStyle;
  timezone: 'local' | 'utc';
  startup: { mode: 'ask' | 'last'; lastWorkspaceId?: string };
  background: { runBotsInBackground: boolean; startAtLogin: boolean; closeToTray: boolean };
  ai: { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; thinking: boolean; mode: 'build' | 'plan'; claudePath: string; maxTurns: number };
  python: { runtime: 'auto' | 'pyodide' | 'system'; pythonPath: string };
  trading: { confirmMarketOrders: boolean; defaultAccountId: string | null; quickQtyUsd: number };
  /** botTrades: a bot's fills; botProblems: a bot pausing (errors, risk guards) and liquidations or margin calls on bot accounts. */
  notifications: { desktop: boolean; sound: boolean; botTrades: boolean; botProblems: boolean };
  shortcuts: Record<string, string>;
  news: { sources: string[]; refreshMinutes: number };
  books: BookRecordingSettings;
  onboarded: boolean;
}

export const DEFAULT_CHART_STYLE: ChartStyle = {
  up: '#26a69a',
  down: '#ef5350',
  wickUp: '#26a69a',
  wickDown: '#ef5350',
  hollowUp: false,
  grid: true,
  crosshair: 'cross',
  priceLine: true,
  volumeOpacity: 0.35,
  font: 11,
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accent: '#3b82f6',
  chart: DEFAULT_CHART_STYLE,
  timezone: 'local',
  startup: { mode: 'ask' },
  background: { runBotsInBackground: true, startAtLogin: false, closeToTray: true },
  ai: { model: 'opus', effort: 'high', thinking: true, mode: 'build', claudePath: '', maxTurns: 40 },
  python: { runtime: 'auto', pythonPath: '' },
  trading: { confirmMarketOrders: false, defaultAccountId: null, quickQtyUsd: 1000 },
  notifications: { desktop: true, sound: true, botTrades: true, botProblems: true },
  shortcuts: {},
  news: { sources: ['coindesk', 'cointelegraph', 'decrypt', 'bitcoinmagazine', 'theblock'], refreshMinutes: 5 },
  books: { record: [], keepDays: 30 },
  onboarded: false,
};

export function mergeSettings(saved: Partial<AppSettings> | null | undefined): AppSettings {
  const s = saved || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    chart: { ...DEFAULT_CHART_STYLE, ...(s.chart || {}) },
    startup: { ...DEFAULT_SETTINGS.startup, ...(s.startup || {}) },
    background: { ...DEFAULT_SETTINGS.background, ...(s.background || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) },
    python: { ...DEFAULT_SETTINGS.python, ...(s.python || {}) },
    trading: { ...DEFAULT_SETTINGS.trading, ...(s.trading || {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(s.notifications || {}) },
    news: { ...DEFAULT_SETTINGS.news, ...(s.news || {}) },
    books: { ...DEFAULT_SETTINGS.books, ...(s.books || {}) },
    shortcuts: { ...(s.shortcuts || {}) },
  };
}
