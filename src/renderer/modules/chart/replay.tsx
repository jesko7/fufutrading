// Placeholder — replaced by the market replay integration.
import type { ReactNode } from 'react';
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { ChartEngine } from '../../chart/engine';
import type { BarStore } from '../../chart/barStore';
import type { SeriesInfo, SeriesStatus } from '../../../shared/marketTypes';

export interface ChartReplay {
  active: boolean;
  sessionId: string | null;
  accountId?: string | null;
  attach(eng: ChartEngine, store: BarStore, cb: (s: SeriesStatus, info?: SeriesInfo) => void): () => void;
  onPickBar(time: number): void;
  toggle?(): void;
  overlay: ReactNode;
}

export function useReplayForChart(_moduleId: string, _cfg: ChartModuleConfig): ChartReplay {
  return { active: false, sessionId: null, attach: () => () => {}, onPickBar: () => {}, overlay: null };
}

export function ReplayButton(_p: { replay: ChartReplay }) {
  return null;
}
