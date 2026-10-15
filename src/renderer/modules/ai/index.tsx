import { registerModule } from '../registry';
import { AIStudioModule } from './AIStudioModule';
import { api } from '../../api';
import { bus } from '../../lib/bus';
import { useApp, toast } from '../../state/store';
import { openModule } from '../../app/moduleOps';
import { openScriptInEditor } from '../scripts/client';
import { newId, type ChartModuleConfig, type IndicatorInstance } from '../../../shared/workspace';
import { isSymbol } from '../../../shared/symbols';
import { requestAI, type AIRequest } from './requests';
import { openCreateAccount } from '../trading/accounts';

registerModule('ai', AIStudioModule);

/** Add a library script to the focused (or first) chart, optionally switching its instrument. */
async function addToChart(d: { id: string; inputs?: Record<string, unknown>; symbol?: string; market?: string; tf?: string }): Promise<void> {
  const st = useApp.getState();
  const ws = st.workspace;
  let id: string | undefined = (window as any).__lastChartModule;
  if (!id || ws?.modules[id]?.type !== 'chart') id = Object.values(ws?.modules || {}).find((m) => m.type === 'chart')?.id;
  if (!id) id = await openModule('chart', {});
  const m = useApp.getState().workspace?.modules[id];
  if (!m) return;
  const c = m.config as ChartModuleConfig;
  const patch: Partial<ChartModuleConfig> = { indicators: [...(c.indicators || []), { id: newId('i'), scriptId: d.id, inputs: d.inputs || {}, visible: true } as IndicatorInstance] };
  if (d.symbol && isSymbol(d.symbol)) patch.symbol = d.symbol;
  if (d.market === 'spot' || d.market === 'futures') patch.market = d.market;
  if (d.tf) patch.tf = d.tf;
  st.setModuleConfig(m.id, patch);
  toast({ title: 'Added to the chart', kind: 'ok' });
}

bus.on('ai:addToChart', (d: { id: string; inputs?: Record<string, unknown>; symbol?: string; market?: string; tf?: string }) => void addToChart(d));

// actions Claude takes with the show_in_app tool (only the focused window reacts)
api.on<{ action: string; id: string; inputs?: Record<string, unknown>; symbol?: string; market?: string; tf?: string; name?: string; language?: 'pine' | 'python' }>('ai:ui', (d) => {
  if (!document.hasFocus() && api.windowId !== 'main') return;
  switch (d.action) {
    case 'open_script':
      void openScriptInEditor(d.id);
      break;
    case 'add_to_chart':
      void addToChart(d);
      break;
    case 'open_backtest':
      void openModule('backtest', { runId: d.id });
      break;
    case 'open_optimization':
      void openModule('optimizer', { runId: d.id });
      break;
    case 'create_bot': {
      const market = d.market === 'spot' ? 'spot' : 'futures';
      const symbol = d.symbol && isSymbol(d.symbol) ? d.symbol : 'BTCUSDT';
      openCreateAccount((id) => void openModule('bots', { botId: id }), {
        kind: 'bot',
        market,
        name: `${d.name || 'Strategy'} bot`,
        bot: { scriptId: d.id, scriptName: d.name, language: d.language || 'pine', params: d.inputs || {}, symbol, market, tf: d.tf || '1h', chartType: 'candles' },
      });
      break;
    }
  }
});

bus.on('ai:open', (req: AIRequest) => void askAI(req));

/** Open the AI Studio with a prepared request (from the editor, charts…). */
export async function askAI(req: AIRequest): Promise<void> {
  await openModule('ai', {});
  requestAI(req);
}
