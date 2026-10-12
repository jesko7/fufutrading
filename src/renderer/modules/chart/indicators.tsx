// Placeholder — replaced by the scripting integration.
import type { IndicatorOutput } from '../../chart/types';
import type { ChartModuleConfig } from '../../../shared/workspace';

export function useChartIndicators(_moduleId: string, _cfg: ChartModuleConfig, _keyRef: { current: string }, _dataVersion: number, _liveTick: number, _replay: unknown): { outputs: IndicatorOutput[] } {
  return { outputs: EMPTY };
}
const EMPTY: IndicatorOutput[] = [];

export function IndicatorLegend(_p: { moduleId: string; cfg: ChartModuleConfig; outputs: IndicatorOutput[]; index: number; update: (p: Partial<ChartModuleConfig>) => void }) {
  return null;
}

export function openIndicatorPicker(_moduleId: string, _cfg: ChartModuleConfig): void {}
