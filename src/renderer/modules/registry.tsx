import type { ComponentType } from 'react';
import type { ModuleState, ModuleType } from '../../shared/workspace';
import { MODULE_INFO } from '../../shared/workspace';
import { SYMBOL_SPECS, isSymbol } from '../../shared/symbols';
import type { ModuleProps } from '../app/WorkspaceView';
import { ChartModule } from './chart/ChartModule';
import { WatchlistModule } from './market/WatchlistModule';
import { OrderBookModule } from './market/OrderBookModule';
import { DepthModule } from './market/DepthModule';
import { HeatmapModule } from './market/HeatmapModule';
import { TradesModule } from './market/TradesModule';
import { Empty } from '../components/ui';

function Pending({ module }: ModuleProps) {
  return <Empty icon={MODULE_INFO[module.type].icon} title={MODULE_INFO[module.type].title}>Loading module…</Empty>;
}

export const MODULES: Record<ModuleType, { component: ComponentType<ModuleProps> }> = {
  chart: { component: ChartModule },
  orderbook: { component: OrderBookModule },
  depth: { component: DepthModule },
  heatmap: { component: HeatmapModule },
  trades: { component: TradesModule },
  watchlist: { component: WatchlistModule },
  account: { component: Pending },
  orderEntry: { component: Pending },
  scripts: { component: Pending },
  backtest: { component: Pending },
  optimizer: { component: Pending },
  experiments: { component: Pending },
  alerts: { component: Pending },
  news: { component: Pending },
  derivatives: { component: Pending },
  options: { component: Pending },
  ai: { component: Pending },
  bots: { component: Pending },
  data: { component: Pending },
  propRules: { component: Pending },
  builder: { component: Pending },
};

/** Register (or replace) a module component — used by feature packages. */
export function registerModule(type: ModuleType, component: ComponentType<ModuleProps>): void {
  MODULES[type] = { component };
}

export function moduleTitle(m: ModuleState): string {
  const base = MODULE_INFO[m.type]?.title || m.type;
  const sym = isSymbol(m.config.symbol) ? SYMBOL_SPECS[m.config.symbol].base + (m.config.market === 'futures' ? '.P' : '') : '';
  switch (m.type) {
    case 'chart':
      return `${sym} ${m.config.tf || ''}`.trim();
    case 'orderbook':
      return `Book ${sym}`;
    case 'depth':
      return `Depth ${sym}`;
    case 'heatmap':
      return `Heatmap ${sym}`;
    case 'trades':
      return `Tape ${sym}`;
    case 'orderEntry':
      return `Trade ${sym}`;
    case 'options':
      return `Options ${sym}`;
    default:
      return m.config.title || base;
  }
}
