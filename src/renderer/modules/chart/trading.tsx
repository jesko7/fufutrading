// Placeholder — replaced by the paper-trading integration.
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { MenuItemSpec } from '../../components/ui';

const NONE: never[] = [];
export function useChartTrading(_cfg: ChartModuleConfig, _replay: unknown) {
  return {
    lines: NONE,
    executions: NONE,
    onDrag: (_id: string, _price: number) => {},
    onCancel: (_id: string) => {},
    onBracket: (_posId: string, _kind: 'sl' | 'tp', _price: number) => {},
    contextItems: (_price: number): MenuItemSpec[] => [],
  };
}
