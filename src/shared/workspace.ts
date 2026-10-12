/**
 * Workspace model: windows → layout tree (splits and tab stacks) → modules.
 * Pure functions here are used by both the main process (persistence, detaching windows) and
 * the renderer (drag & drop rearranging, resizing).
 */
import type { Market, SymbolId } from './symbols';
import type { ChartType } from './marketTypes';

export type ModuleType =
  | 'chart'
  | 'orderbook'
  | 'depth'
  | 'heatmap'
  | 'trades'
  | 'watchlist'
  | 'account'
  | 'orderEntry'
  | 'scripts'
  | 'backtest'
  | 'optimizer'
  | 'experiments'
  | 'alerts'
  | 'news'
  | 'ai'
  | 'bots'
  | 'data'
  | 'propRules';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutNode =
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] }
  | { type: 'stack'; id: string; modules: string[]; active: number };

export interface ModuleState {
  id: string;
  type: ModuleType;
  config: Record<string, any>;
  /** Symbol link group: modules in the same group follow each other's instrument. */
  link?: string | null;
}

export interface WorkspaceWindow {
  id: string;
  main: boolean;
  bounds?: Rect;
  maximized?: boolean;
  root: LayoutNode | null;
}

export interface Workspace {
  id: string;
  name: string;
  version: 1;
  windows: WorkspaceWindow[];
  modules: Record<string, ModuleState>;
  createdAt: number;
  updatedAt: number;
  /** Optional description for presets. */
  description?: string;
  preset?: boolean;
}

export interface IndicatorInstance {
  id: string;
  scriptId: string;
  inputs: Record<string, unknown>;
  visible: boolean;
  /** Style overrides per plot id. */
  styles?: Record<string, { color?: string; width?: number; visible?: boolean }>;
}

export interface ChartModuleConfig {
  symbol: SymbolId;
  market: Market;
  tf: string;
  chartType: ChartType;
  renko?: { boxSize?: number; atrLength?: number; percent?: number; source?: 'close' | 'hl' };
  scale: 'linear' | 'log' | 'percent';
  indicators: IndicatorInstance[];
  drawings: any[];
  compare: { symbol: SymbolId; market: Market; color?: string }[];
  mtf: { tf: string; style: 'boxes' | 'line'; color?: string }[];
  showVolume: boolean;
  showExecutions: boolean;
  volumeProfile?: { mode: 'off' | 'visible' | 'fixed' | 'session'; rows: number; valueArea: number; from?: number; to?: number };
  footprint?: { group: number; mode: 'bidask' | 'delta' | 'volume'; imbalanceRatio: number };
  accountId?: string | null;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultChartConfig(over: Partial<ChartModuleConfig> = {}): ChartModuleConfig {
  return {
    symbol: 'BTCUSDT',
    market: 'spot',
    tf: '15m',
    chartType: 'candles',
    scale: 'linear',
    indicators: [],
    drawings: [],
    compare: [],
    mtf: [],
    showVolume: true,
    showExecutions: true,
    ...over,
  };
}

export function defaultModuleConfig(type: ModuleType, symbol: SymbolId = 'BTCUSDT', market: Market = 'spot'): Record<string, any> {
  switch (type) {
    case 'chart':
      return defaultChartConfig({ symbol, market }) as unknown as Record<string, any>;
    case 'orderbook':
      return { symbol, market, group: 0, levels: 18, imbalance: { method: 'depthPct', param: 0.5 }, showDepth: true };
    case 'depth':
      return { symbol, market, rangePct: 1 };
    case 'heatmap':
      return { symbol, market, minutes: 15, showTrades: true, contrast: 1 };
    case 'trades':
      return { symbol, market, minNotional: 0 };
    case 'watchlist':
      return { market };
    case 'account':
      return { accountId: null, tab: 'positions' };
    case 'orderEntry':
      return { accountId: null, symbol, market };
    case 'scripts':
      return { scriptId: null };
    case 'backtest':
      return { runId: null };
    case 'optimizer':
      return { runId: null };
    default:
      return {};
  }
}

export const MODULE_INFO: Record<ModuleType, { title: string; description: string; icon: string }> = {
  chart: { title: 'Chart', description: 'Candles, Heikin-Ashi, Renko, footprint, indicators, drawings', icon: 'chart' },
  orderbook: { title: 'Order Book', description: 'Live bids/asks, grouping, imbalance', icon: 'book' },
  depth: { title: 'Depth', description: 'Cumulative market depth chart', icon: 'depth' },
  heatmap: { title: 'Liquidity Heatmap', description: 'Resting liquidity over time, large orders, trades', icon: 'heat' },
  trades: { title: 'Time & Sales', description: 'Live aggregate trades', icon: 'list' },
  watchlist: { title: 'Watchlist', description: 'BTC, ETH, SOL prices and 24h change', icon: 'star' },
  account: { title: 'Account', description: 'Positions, orders, history and risk', icon: 'wallet' },
  orderEntry: { title: 'Trade', description: 'Place paper orders', icon: 'trade' },
  scripts: { title: 'Script Editor', description: 'Pine Script & Python indicators and strategies', icon: 'code' },
  backtest: { title: 'Strategy Tester', description: 'Backtests, analytics and benchmarks', icon: 'flask' },
  optimizer: { title: 'Optimizer', description: 'Parameter search, walk-forward, robustness', icon: 'grid' },
  experiments: { title: 'Experiments', description: 'Track research runs and notes', icon: 'notebook' },
  alerts: { title: 'Alerts', description: 'Price, indicator, strategy and order book alerts', icon: 'bell' },
  news: { title: 'News', description: 'Crypto headlines for BTC, ETH and SOL', icon: 'news' },
  ai: { title: 'AI Studio', description: 'Claude builds, tests and explains strategies', icon: 'spark' },
  bots: { title: 'Bots', description: 'Automated paper-trading bots', icon: 'bot' },
  data: { title: 'Data Manager', description: 'Local historical data and tick downloads', icon: 'database' },
  propRules: { title: 'Prop Rules', description: 'Prop-firm account rules and compliance', icon: 'shield' },
};

// ---------------------------------------------------------------------------------- tree ops

export function stack(modules: string[], active = 0): LayoutNode {
  return { type: 'stack', id: newId('s'), modules, active };
}

export function split(dir: 'row' | 'col', children: LayoutNode[], sizes?: number[]): LayoutNode {
  const n = children.length;
  return { type: 'split', id: newId('p'), dir, children, sizes: sizes && sizes.length === n ? sizes : children.map(() => 1 / n) };
}

export function collectModules(node: LayoutNode | null, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === 'stack') out.push(...node.modules);
  else for (const c of node.children) collectModules(c, out);
  return out;
}

export function findStackOf(node: LayoutNode | null, moduleId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'stack') return node.modules.includes(moduleId) ? node : null;
  for (const c of node.children) {
    const r = findStackOf(c, moduleId);
    if (r) return r;
  }
  return null;
}

/** Remove a module; collapses empty stacks and single-child splits. */
export function removeModule(node: LayoutNode | null, moduleId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'stack') {
    const i = node.modules.indexOf(moduleId);
    if (i < 0) return node;
    const modules = node.modules.filter((m) => m !== moduleId);
    if (!modules.length) return null;
    return { ...node, modules, active: Math.min(node.active >= i && node.active > 0 ? node.active - 1 : node.active, modules.length - 1) };
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeModule(c, moduleId);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / sum) };
}

export type DropPos = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** Insert module relative to target stack. */
export function insertModule(node: LayoutNode | null, moduleId: string, targetStackId: string | null, pos: DropPos): LayoutNode {
  if (!node) return stack([moduleId]);
  if (!targetStackId) {
    // append to the right of the root
    return node.type === 'split' && node.dir === 'row' ? { ...node, children: [...node.children, stack([moduleId])], sizes: rebalance([...node.sizes, 1 / (node.children.length + 1)]) } : split('row', [node, stack([moduleId])], [0.7, 0.3]);
  }
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.type === 'stack') {
      if (n.id !== targetStackId) return n;
      if (pos === 'center') return { ...n, modules: [...n.modules, moduleId], active: n.modules.length };
      const ns = stack([moduleId]);
      const dir = pos === 'left' || pos === 'right' ? 'row' : 'col';
      const first = pos === 'left' || pos === 'top';
      return split(dir, first ? [ns, n] : [n, ns], [0.5, 0.5]);
    }
    // if a child stack is the target and directions match, insert into this split directly
    const idx = n.children.findIndex((c) => c.type === 'stack' && c.id === targetStackId);
    const dir = pos === 'left' || pos === 'right' ? 'row' : pos === 'center' ? null : 'col';
    if (idx >= 0 && dir === n.dir) {
      const children = n.children.slice();
      const sizes = n.sizes.slice();
      const half = sizes[idx] / 2;
      sizes[idx] = half;
      const at = pos === 'left' || pos === 'top' ? idx : idx + 1;
      children.splice(at, 0, stack([moduleId]));
      sizes.splice(at, 0, half);
      return { ...n, children, sizes };
    }
    return { ...n, children: n.children.map(rec) };
  };
  return rec(node);
}

function rebalance(sizes: number[]): number[] {
  const s = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map((x) => x / s);
}

export function setActiveInStack(node: LayoutNode | null, stackId: string, active: number): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'stack') return node.id === stackId ? { ...node, active } : node;
  return { ...node, children: node.children.map((c) => setActiveInStack(c, stackId, active)!) };
}

export function setSizes(node: LayoutNode | null, splitId: string, sizes: number[]): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'stack') return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)!) };
}

export function windowOfModule(ws: Workspace, moduleId: string): WorkspaceWindow | undefined {
  return ws.windows.find((w) => collectModules(w.root).includes(moduleId));
}

/** Remove modules that no window references (garbage collection). */
export function pruneModules(ws: Workspace): Workspace {
  const used = new Set<string>();
  for (const w of ws.windows) collectModules(w.root, []).forEach((m) => used.add(m));
  const modules: Record<string, ModuleState> = {};
  for (const [id, m] of Object.entries(ws.modules)) if (used.has(id)) modules[id] = m;
  return { ...ws, modules };
}

export function cloneWorkspace(ws: Workspace, name?: string): Workspace {
  const copy: Workspace = JSON.parse(JSON.stringify(ws));
  copy.id = newId('ws');
  copy.name = name || `${ws.name} copy`;
  copy.preset = false;
  copy.createdAt = copy.updatedAt = Date.now();
  return copy;
}

// ---------------------------------------------------------------------------------- presets

function mod(type: ModuleType, config?: Record<string, any>, symbol: SymbolId = 'BTCUSDT', market: Market = 'spot'): ModuleState {
  return { id: newId('m'), type, config: { ...defaultModuleConfig(type, symbol, market), ...(config || {}) }, link: null };
}

function makeWs(name: string, description: string, build: (add: (m: ModuleState) => string) => LayoutNode | null): Workspace {
  const modules: Record<string, ModuleState> = {};
  const add = (m: ModuleState) => {
    modules[m.id] = m;
    return m.id;
  };
  const root = build(add);
  return { id: newId('ws'), name, description, version: 1, windows: [{ id: 'main', main: true, root }], modules, createdAt: Date.now(), updatedAt: Date.now() };
}

export function presetWorkspaces(): Workspace[] {
  return [
    makeWs('Trader', 'One large chart with order book, trade panel and positions.', (add) => {
      const chart = add(mod('chart', defaultChartConfig({ tf: '15m' })));
      const book = add(mod('orderbook'));
      const trades = add(mod('trades'));
      const entry = add(mod('orderEntry'));
      const acct = add(mod('account'));
      const watch = add(mod('watchlist'));
      return split('row', [split('col', [stack([chart]), stack([acct])], [0.74, 0.26]), split('col', [stack([watch]), stack([book, trades]), stack([entry])], [0.2, 0.5, 0.3])], [0.76, 0.24]);
    }),
    makeWs('Multi-chart', 'BTC, ETH and SOL side by side with synchronized crosshairs.', (add) => {
      const a = add(mod('chart', defaultChartConfig({ symbol: 'BTCUSDT', tf: '1h' })));
      const b = add(mod('chart', defaultChartConfig({ symbol: 'ETHUSDT', tf: '1h' })));
      const c = add(mod('chart', defaultChartConfig({ symbol: 'SOLUSDT', tf: '1h' })));
      const d = add(mod('chart', defaultChartConfig({ symbol: 'BTCUSDT', tf: '5m', chartType: 'heikinashi' })));
      const w = add(mod('watchlist'));
      return split('row', [split('col', [split('row', [stack([a]), stack([b])]), split('row', [stack([c]), stack([d])])]), stack([w])], [0.82, 0.18]);
    }),
    makeWs('Order Flow', 'Heatmap, footprint, book, depth and tape for short-term reading.', (add) => {
      const fp = add(mod('chart', defaultChartConfig({ tf: '1m', chartType: 'footprint' })));
      const heat = add(mod('heatmap'));
      const book = add(mod('orderbook', { levels: 24 }));
      const depth = add(mod('depth'));
      const tape = add(mod('trades'));
      return split('row', [split('col', [stack([heat]), stack([fp])], [0.5, 0.5]), split('col', [stack([book]), stack([depth, tape])], [0.6, 0.4])], [0.74, 0.26]);
    }),
    makeWs('Strategy Lab', 'Chart, script editor, strategy tester and AI Studio.', (add) => {
      const chart = add(mod('chart', defaultChartConfig({ tf: '1h' })));
      const ed = add(mod('scripts'));
      const bt = add(mod('backtest'));
      const opt = add(mod('optimizer'));
      const ai = add(mod('ai'));
      return split('row', [split('col', [stack([chart]), stack([bt, opt])], [0.55, 0.45]), stack([ai, ed])], [0.6, 0.4]);
    }),
    makeWs('Minimal', 'Just one chart.', (add) => stack([add(mod('chart', defaultChartConfig({ tf: '1h' })))])),
  ].map((w) => ({ ...w, preset: true }));
}

export function emptyWorkspace(name = 'Empty'): Workspace {
  return { id: newId('ws'), name, version: 1, windows: [{ id: 'main', main: true, root: null }], modules: {}, createdAt: Date.now(), updatedAt: Date.now() };
}
