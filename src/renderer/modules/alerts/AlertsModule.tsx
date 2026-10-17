import { useEffect, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { Tabs, Menu, usePopover, confirmDialog, Empty, Spinner, Toggle, Segmented } from '../../components/ui';
import { Icon, CoinIcon } from '../../components/Icon';
import { useNow } from '../../lib/hooks';
import { clsx, fmtAgo, fmtDateTime } from '../../lib/format';
import { openModule } from '../../app/moduleOps';
import { alertTitle, describeAlert, newAlert, type Alert, type AlertEvent, type AlertKind } from '../../../shared/alerts';
import { isSymbol, type Market, type SymbolId } from '../../../shared/symbols';
import { openAlertEditor, KIND_LABEL } from './editor';
import './alerts.css';

type Tab = 'alerts' | 'log';
type Filter = 'all' | 'active' | 'off';

export function useAlerts(): { alerts: Alert[]; log: AlertEvent[] } | null {
  const [v, setV] = useState<{ alerts: Alert[]; log: AlertEvent[] } | null>(null);
  useEffect(() => api.sub('alerts', {}, setV), []);
  return v;
}

const fail = (title: string) => (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

const KIND_ICON: Record<AlertKind, string> = { price: 'hline', move: 'trend', indicator: 'flow', script: 'code', book: 'book', futures: 'zap', options: 'greek' };

const FREQ: Record<Alert['frequency'], string> = { once: 'once', perBar: 'once per bar', perMinute: 'max. once a minute', every: 'every time' };

/** Symbol/market of the focused chart (defaults for new alerts). */
function focusedInstrument(): { symbol: SymbolId; market: Market } {
  const st = useApp.getState();
  const id = (window as any).__lastChartModule || st.focusedModule;
  const m = id ? st.workspace?.modules[id] : null;
  if (m && isSymbol(m.config.symbol)) return { symbol: m.config.symbol, market: m.config.market === 'futures' ? 'futures' : 'spot' };
  return { symbol: 'BTCUSDT', market: 'spot' };
}

export function newAlertMenuItems() {
  return (Object.keys(KIND_LABEL) as AlertKind[]).map((k) => ({ label: KIND_LABEL[k], icon: KIND_ICON[k], onClick: () => openAlertEditor({ kind: k, ...focusedInstrument() }) }));
}

export function AlertsModule({ module }: ModuleProps) {
  const cfg = module.config as { tab?: Tab; filter?: Filter };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const data = useAlerts();
  const add = usePopover();
  const tab: Tab = cfg.tab || 'alerts';
  const filter: Filter = cfg.filter || 'all';
  useNow(15000);
  if (!data)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  const shown = data.alerts.filter((a) => (filter === 'all' ? true : filter === 'active' ? a.enabled : !a.enabled));
  const active = data.alerts.filter((a) => a.enabled).length;
  return (
    <div className="alerts">
      <HeadControls>
        <button className="btn small primary" onClick={(e) => add.toggle(e.currentTarget)}>
          <Icon name="plus" size={13} /> New alert
        </button>
        {add.anchor && <Menu anchor={add.anchor} onClose={add.close} width={220} items={newAlertMenuItems()} />}
      </HeadControls>
      <div className="row" style={{ padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
        <Tabs
          value={tab}
          onChange={(t) => set({ tab: t })}
          tabs={[
            { value: 'alerts', label: 'Alerts', badge: active || undefined },
            { value: 'log', label: 'Log', badge: data.log.length || undefined },
          ]}
        />
        <span className="spacer" />
        {tab === 'alerts' && data.alerts.length > 0 && (
          <Segmented
            size="sm"
            value={filter}
            onChange={(f) => set({ filter: f })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'off', label: 'Off' },
            ]}
          />
        )}
        {tab === 'log' && data.log.length > 0 && (
          <button className="btn small ghost" onClick={() => void api.call('alerts:clearLog').catch(fail('Log not cleared'))}>
            Clear log
          </button>
        )}
      </div>
      <div className="mod-scroll">
        {tab === 'alerts' &&
          (data.alerts.length === 0 ? (
            <Empty icon="bell" title="No alerts yet">
              <div className="col" style={{ alignItems: 'center', gap: 10 }}>
                <span>Get notified when a price level is crossed, the market moves fast, an indicator or strategy signals, the order book becomes one-sided, or futures positioning shifts (open interest, funding, liquidations). Right-click a chart to set a price alert in one click.</span>
                <button className="btn primary" onClick={(e) => add.toggle(e.currentTarget)}>
                  <Icon name="plus" size={14} /> New alert
                </button>
              </div>
            </Empty>
          ) : shown.length === 0 ? (
            <Empty icon="bell" title={filter === 'active' ? 'No active alerts' : 'No switched-off alerts'} />
          ) : (
            <div className="alert-list">
              {shown.map((a) => (
                <AlertRow key={a.id} a={a} />
              ))}
            </div>
          ))}
        {tab === 'log' && <AlertLog log={data.log} alerts={data.alerts} />}
      </div>
    </div>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const menu = usePopover();
  const status = a.status === 'error' ? 'error' : a.enabled ? 'active' : a.status === 'triggered' ? 'triggered' : a.status === 'expired' ? 'expired' : 'off';
  const label = { active: 'Active', triggered: 'Triggered', expired: 'Expired', off: 'Off', error: 'Error' }[status];
  return (
    <div className={clsx('alert-row', !a.enabled && 'off')} onDoubleClick={() => openAlertEditor(a)}>
      <span className={clsx('alert-ic', status)}>
        <Icon name={KIND_ICON[a.kind]} size={14} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          <CoinIcon symbol={a.symbol} size={13} />
          <b className="ellipsis">{alertTitle(a)}</b>
        </div>
        <div className="faint small ellipsis">
          {a.name ? `${describeAlert(a)} · ` : ''}
          {KIND_LABEL[a.kind]} · triggers {FREQ[a.frequency]}
          {a.expiresAt ? ` · until ${fmtDateTime(a.expiresAt)}` : ''}
        </div>
        {a.status === 'error' && a.error && <div className="danger-text small ellipsis">{a.error}</div>}
      </div>
      <div className="col alert-meta">
        <span className={clsx('status-pill', `al-${status}`)}>{label}</span>
        <span className="faint small">{a.lastTriggered ? `${fmtAgo(a.lastTriggered)} · ${a.triggerCount}×` : 'never fired'}</span>
      </div>
      <Toggle value={a.enabled} onChange={(on) => void api.call('alerts:enable', a.id, on).catch(fail('Alert not changed'))} title={a.enabled ? 'Switch off' : 'Switch on'} />
      <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)}>
        <Icon name="more" />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          align="end"
          width={210}
          items={[
            { label: 'Edit…', icon: 'edit', onClick: () => openAlertEditor(a) },
            { label: 'Duplicate', icon: 'copy', onClick: () => void api.call('alerts:save', { ...a, id: undefined, name: a.name ? `${a.name} (copy)` : '', enabled: false, triggerCount: 0, lastTriggered: undefined }).catch(fail('Not duplicated')) },
            { label: 'Open chart', icon: 'chart', onClick: () => void openModule('chart', { symbol: a.symbol, market: a.market, ...('tf' in a ? { tf: a.tf } : {}) }) },
            { sep: true },
            {
              label: 'Delete',
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (await confirmDialog({ title: 'Delete alert?', body: alertTitle(a), confirm: 'Delete', danger: true })) await api.call('alerts:delete', a.id).catch(fail('Not deleted'));
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function AlertLog({ log, alerts }: { log: AlertEvent[]; alerts: Alert[] }) {
  if (!log.length) return <Empty icon="history" title="Nothing triggered yet">Triggered alerts are listed here with their message.</Empty>;
  return (
    <div className="alert-log">
      {log
        .slice()
        .reverse()
        .map((e) => {
          const a = alerts.find((x) => x.id === e.alertId);
          return (
            <div key={e.id} className="row alert-log-row selectable">
              <span className="faint num" style={{ width: 132, flex: 'none' }}>
                {fmtDateTime(e.t, true)}
              </span>
              <span className="alert-ic tiny active">
                <Icon name={KIND_ICON[e.kind]} size={11} />
              </span>
              <div className="col grow" style={{ minWidth: 0, gap: 1 }}>
                <span>{e.message}</span>
                {a && a.name && <span className="faint small">{a.name}</span>}
                {e.webhook && (
                  <span className={clsx('small', e.webhook.ok ? 'faint' : 'danger-text')}>
                    Webhook {e.webhook.ok ? `delivered (HTTP ${e.webhook.status}, ${e.webhook.ms} ms)` : `failed: ${e.webhook.error || `HTTP ${e.webhook.status}`}`}
                  </span>
                )}
              </div>
              {a && (
                <button className="icon-btn small" onClick={() => openAlertEditor(a)} data-tip="Edit alert">
                  <Icon name="edit" size={12} />
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
}

export { newAlert };
