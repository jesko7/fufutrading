/** Price alerts drawn on charts: drag a line to move the level, × deletes the alert. */
import { useMemo } from 'react';
import { api, errorMessage } from '../../api';
import { toast } from '../../state/store';
import type { TradeLine } from '../../chart/types';
import type { Alert, PriceAlert } from '../../../shared/alerts';
import type { Market, SymbolId } from '../../../shared/symbols';
import { useAlerts } from './AlertsModule';

const SHORT: Record<PriceAlert['condition'], string> = { crossesAbove: '↑', crossesBelow: '↓', crosses: '↕', above: '>', below: '<', enterChannel: '⇥', exitChannel: '⇤' };

export function useAlertLines(symbol: SymbolId, market: Market): { lines: TradeLine[]; onDrag: (id: string, price: number) => boolean; onCancel: (id: string) => boolean } {
  const data = useAlerts();
  const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim() || '#f5a524';
  const alerts = useMemo(() => (data?.alerts || []).filter((a): a is PriceAlert => a.kind === 'price' && a.enabled && a.symbol === symbol && a.market === market), [data, symbol, market]);
  const lines = useMemo<TradeLine[]>(() => {
    const out: TradeLine[] = [];
    for (const a of alerts) {
      out.push({ id: `alert:${a.id}:1`, kind: 'alert', price: a.level, label: `🔔 ${SHORT[a.condition]} ${a.name || ''}`.trim(), color: warn, draggable: true, cancellable: true });
      if ((a.condition === 'enterChannel' || a.condition === 'exitChannel') && a.level2) out.push({ id: `alert:${a.id}:2`, kind: 'alert', price: a.level2, label: `🔔 ${SHORT[a.condition]}`, color: warn, draggable: true, cancellable: true });
    }
    return out;
  }, [alerts, warn]);
  const find = (id: string): { a: Alert; which: string } | null => {
    if (!id.startsWith('alert:')) return null;
    const [, aid, which] = id.split(':');
    const a = data?.alerts.find((x) => x.id === aid);
    return a ? { a, which } : null;
  };
  return {
    lines,
    onDrag: (id, price) => {
      const f = find(id);
      if (!f || f.a.kind !== 'price') return !!id.startsWith('alert:');
      const patch = f.which === '2' ? { level2: price } : { level: price };
      void api.call('alerts:save', { ...f.a, ...patch }).catch((e) => toast({ title: 'Alert not moved', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' }));
      return true;
    },
    onCancel: (id) => {
      const f = find(id);
      if (!f) return !!id.startsWith('alert:');
      void api.call('alerts:delete', f.a.id).then(() => toast({ title: 'Alert deleted', kind: 'ok' }));
      return true;
    },
  };
}
