/** Tracks the chart the user worked with last, so editor actions target it. */
import { useApp } from '../../state/store';

let last: string | null = null;

useApp.subscribe((s, prev) => {
  if (s.focusedModule === prev.focusedModule || !s.focusedModule) return;
  const m = s.workspace?.modules[s.focusedModule];
  if (m?.type === 'chart') last = m.id;
});

export function lastChartId(): string | null {
  const ws = useApp.getState().workspace;
  if (last && ws?.modules[last]) return last;
  return null;
}
