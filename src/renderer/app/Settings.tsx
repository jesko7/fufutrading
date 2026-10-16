import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorMessage } from '../api';
import { Modal, Segmented, Toggle, Select, NumberField } from '../components/ui';
import { Icon } from '../components/Icon';
import type { AppSettings } from '../../shared/settings';
import { DEFAULT_CHART_STYLE } from '../../shared/settings';
import { clsx } from '../lib/format';

type Section = 'appearance' | 'startup' | 'trading' | 'ai' | 'python' | 'notifications' | 'about';

const ACCENTS = ['#3b82f6', '#6366f1', '#8b5cf6', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899'];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useApp((x) => x.settings);
  const [sec, setSec] = useState<Section>('appearance');
  const upd = (patch: Partial<AppSettings>) => void useApp.getState().updateSettings(patch);
  const [info, setInfo] = useState<any>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    void api.call('app:info').then(setInfo);
    void api.call('desktop:getAutostart').then(setAutostart).catch(() => setAutostart(null));
  }, []);
  const nav: [Section, string, string][] = [
    ['appearance', 'Appearance', 'sun'],
    ['startup', 'Startup & background', 'zap'],
    ['trading', 'Trading', 'trade'],
    ['ai', 'AI (Claude)', 'spark'],
    ['python', 'Python', 'code'],
    ['notifications', 'Notifications', 'bell'],
    ['about', 'About & data', 'info'],
  ];
  return (
    <Modal title="Settings" icon="gear" onClose={onClose} width={780}>
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 18, minHeight: 420 }}>
        <div className="settings-nav">
          {nav.map(([k, label, icon]) => (
            <button key={k} className={clsx('tab', sec === k && 'on')} style={{ justifyContent: 'flex-start', display: 'flex', gap: 8, alignItems: 'center' }} onClick={() => setSec(k)}>
              <Icon name={icon} size={15} /> {label}
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 14 }}>
          {sec === 'appearance' && (
            <>
              <Row label="Theme">
                <Segmented value={s.theme} onChange={(v) => upd({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
              </Row>
              <Row label="Accent">
                <div className="row" style={{ gap: 6 }}>
                  {ACCENTS.map((c) => (
                    <button key={c} className={clsx('swatch', s.accent === c && 'on')} style={{ background: c, width: 22, height: 22, borderRadius: '50%', border: s.accent === c ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer' }} onClick={() => upd({ accent: c })} />
                  ))}
                </div>
              </Row>
              <Row label="Candle colours">
                <div className="row">
                  <ColorInput label="Up" value={s.chart.up} onChange={(v) => upd({ chart: { ...s.chart, up: v, wickUp: v } })} />
                  <ColorInput label="Down" value={s.chart.down} onChange={(v) => upd({ chart: { ...s.chart, down: v, wickDown: v } })} />
                  <button className="btn small" onClick={() => upd({ chart: { ...s.chart, up: '#22c55e', down: '#ef4444', wickUp: '#22c55e', wickDown: '#ef4444' } })}>
                    Vivid
                  </button>
                  <button className="btn small" onClick={() => upd({ chart: { ...s.chart, up: DEFAULT_CHART_STYLE.up, down: DEFAULT_CHART_STYLE.down, wickUp: DEFAULT_CHART_STYLE.wickUp, wickDown: DEFAULT_CHART_STYLE.wickDown } })}>
                    Classic
                  </button>
                  <button className="btn small" onClick={() => upd({ chart: { ...s.chart, up: '#3b82f6', down: '#f59e0b', wickUp: '#3b82f6', wickDown: '#f59e0b' } })}>
                    Colour-blind
                  </button>
                </div>
              </Row>
              <Row label="Hollow up candles">
                <Toggle value={s.chart.hollowUp} onChange={(v) => upd({ chart: { ...s.chart, hollowUp: v } })} />
              </Row>
              <Row label="Grid lines">
                <Toggle value={s.chart.grid} onChange={(v) => upd({ chart: { ...s.chart, grid: v } })} />
              </Row>
              <Row label="Volume opacity">
                <input type="range" min={0.05} max={0.8} step={0.05} value={s.chart.volumeOpacity} onChange={(e) => upd({ chart: { ...s.chart, volumeOpacity: +e.target.value } })} />
              </Row>
              <Row label="Chart font size">
                <Segmented value={String(s.chart.font)} onChange={(v) => upd({ chart: { ...s.chart, font: +v } })} options={['10', '11', '12', '13'].map((v) => ({ value: v, label: v }))} />
              </Row>
              <Row label="Time zone">
                <Segmented value={s.timezone} onChange={(v) => upd({ timezone: v })} options={[{ value: 'local', label: 'Local' }, { value: 'utc', label: 'UTC' }]} />
              </Row>
            </>
          )}
          {sec === 'startup' && (
            <>
              <Row label="On launch" hint="“Ask” shows the workspace picker (presets, empty, saved).">
                <Segmented value={s.startup.mode} onChange={(v) => upd({ startup: { ...s.startup, mode: v } })} options={[{ value: 'ask', label: 'Ask' }, { value: 'last', label: 'Restore last session' }]} />
              </Row>
              <Row label="Keep bots running in the background" hint="When bots are active, closing the window keeps the app in the tray so bots continue trading (paper).">
                <Toggle value={s.background.runBotsInBackground} onChange={(v) => upd({ background: { ...s.background, runBotsInBackground: v } })} />
              </Row>
              <Row label="Close to tray">
                <Toggle value={s.background.closeToTray} onChange={(v) => upd({ background: { ...s.background, closeToTray: v } })} />
              </Row>
              <Row label="Start at login (bots only)" hint="Launches silently in the tray at login so bot accounts resume automatically.">
                <Toggle value={autostart ?? s.background.startAtLogin} onChange={(v) => {
                  setAutostart(v);
                  upd({ background: { ...s.background, startAtLogin: v } });
                }} />
              </Row>
              <Row label="App shortcut" hint="Creates a desktop and start-menu entry (Windows .lnk / Linux .desktop).">
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      const created = await api.call<string[]>('desktop:createShortcuts');
                      useApp.getState().toast({ title: created.length ? 'Shortcut created' : 'No shortcut created', body: created.join('\n'), kind: created.length ? 'ok' : 'warn' });
                    } catch (e) {
                      useApp.getState().toast({ title: 'Failed', body: errorMessage(e), kind: 'error' });
                    }
                  }}
                >
                  <Icon name="external" size={14} /> Create app shortcut
                </button>
              </Row>
            </>
          )}
          {sec === 'trading' && (
            <>
              <Row label="Confirm market orders" hint="Shows a confirmation with account, instrument and size before quick-trade market orders.">
                <Toggle value={s.trading.confirmMarketOrders} onChange={(v) => upd({ trading: { ...s.trading, confirmMarketOrders: v } })} />
              </Row>
              <Row label="Quick-trade size (USD notional)">
                <NumberField value={s.trading.quickQtyUsd} min={1} step={100} onChange={(v) => upd({ trading: { ...s.trading, quickQtyUsd: v } })} style={{ width: 160 }} />
              </Row>
              <div className="callout">All trading in FuFu is simulated (paper trading). No real orders are ever sent to an exchange.</div>
            </>
          )}
          {sec === 'ai' && (
            <>
              <Row label="Model">
                <Select value={s.ai.model} onChange={(v) => upd({ ai: { ...s.ai, model: v } })} options={[{ value: 'opus', label: 'Opus (most capable)' }, { value: 'sonnet', label: 'Sonnet (balanced)' }, { value: 'haiku', label: 'Haiku (fast)' }, { value: 'fable', label: 'Fable' }]} />
              </Row>
              <Row label="Effort">
                <Segmented value={s.ai.effort} onChange={(v) => upd({ ai: { ...s.ai, effort: v } })} options={['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v as any, label: v }))} />
              </Row>
              <Row label="Extended thinking">
                <Toggle value={s.ai.thinking} onChange={(v) => upd({ ai: { ...s.ai, thinking: v } })} />
              </Row>
              <Row label="Default mode" hint="Build: Claude writes, compiles and backtests iteratively. Plan: Claude proposes an approach first.">
                <Segmented value={s.ai.mode} onChange={(v) => upd({ ai: { ...s.ai, mode: v } })} options={[{ value: 'build', label: 'Build' }, { value: 'plan', label: 'Plan' }]} />
              </Row>
              <Row label="Max agent turns">
                <NumberField value={s.ai.maxTurns} min={5} max={200} onChange={(v) => upd({ ai: { ...s.ai, maxTurns: Math.round(v) } })} style={{ width: 120 }} />
              </Row>
              <Row label="Claude CLI path" hint="Leave empty to use “claude” from your PATH.">
                <input className="input" value={s.ai.claudePath} onChange={(e) => upd({ ai: { ...s.ai, claudePath: e.target.value } })} placeholder="claude" style={{ width: 280 }} />
              </Row>
            </>
          )}
          {sec === 'python' && (
            <>
              <Row label="Python runtime" hint="Built-in runs Python (with NumPy) inside the app via WebAssembly — no installation needed. System uses your installed Python 3 for maximum speed.">
                <Segmented value={s.python.runtime} onChange={(v) => upd({ python: { ...s.python, runtime: v } })} options={[{ value: 'auto', label: 'Auto' }, { value: 'pyodide', label: 'Built-in' }, { value: 'system', label: 'System' }]} />
              </Row>
              <Row label="System Python path">
                <input className="input" value={s.python.pythonPath} onChange={(e) => upd({ python: { ...s.python, pythonPath: e.target.value } })} placeholder="python3 / py" style={{ width: 280 }} />
              </Row>
            </>
          )}
          {sec === 'notifications' && (
            <>
              <Row label="Desktop notifications">
                <Toggle value={s.notifications.desktop} onChange={(v) => upd({ notifications: { ...s.notifications, desktop: v } })} />
              </Row>
              <Row label="Sound">
                <Toggle value={s.notifications.sound} onChange={(v) => upd({ notifications: { ...s.notifications, sound: v } })} />
              </Row>
              <Row label="Bot trades" hint="A notification whenever a bot's order fills. Each bot can also be muted with the bell in the Bots module.">
                <Toggle value={s.notifications.botTrades !== false} onChange={(v) => upd({ notifications: { ...s.notifications, botTrades: v } })} />
              </Row>
              <Row label="Bot problems" hint="A bot pausing itself (strategy errors, risk guards) and liquidations or margin calls on bot accounts.">
                <Toggle value={s.notifications.botProblems !== false} onChange={(v) => upd({ notifications: { ...s.notifications, botProblems: v } })} />
              </Row>
            </>
          )}
          {sec === 'about' && info && (
            <>
              <div className="card col">
                <div style={{ fontWeight: 650, fontSize: 14 }}>FuFu Trading {info.version}</div>
                <div className="muted">
                  Electron {info.electron} · Chrome {info.chrome} · Node {info.node} · {info.platform}
                </div>
                <div className="hint selectable">Data: {info.data}</div>
                <div className="hint selectable">Settings: {info.userData}</div>
              </div>
              <div className="callout">Market data © Binance (public API). FuFu is a personal research and paper-trading tool; nothing here is financial advice.</div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'center' }}>
      <div>
        <div style={{ fontWeight: 550 }}>{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 28, height: 24, border: 'none', background: 'none', padding: 0 }} />
      <span className="muted">{label}</span>
    </label>
  );
}
