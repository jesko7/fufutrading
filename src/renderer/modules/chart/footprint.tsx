// Placeholder — replaced by the trade-data / footprint integration.
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { ChartEngine } from '../../chart/engine';
import type { BarStore } from '../../chart/barStore';

export function useFootprint(_cfg: ChartModuleConfig, _store: { current: BarStore }, _v: number, _eng: ChartEngine | null, _replay: boolean): { bars: Map<number, unknown> | null; version: number } {
  return { bars: null, version: 0 };
}
