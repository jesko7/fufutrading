import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import { toast } from '../../state/store';
import { Modal, openModal, NumberField, Toggle, Select, Segmented, SymbolPicker, TimeframePicker, Spinner } from '../../components/ui';
import { useScripts, type AnalyzeResult } from '../scripts/client';
import { InputControl } from '../chart/indicators';
import { describeAlert, newAlert, priceLevelAt, webhookUrlError, OPTIONS_LEVEL_LABEL, type Alert, type AlertKind, type BookAlert, type FuturesAlert, type FuturesMetric, type IndicatorAlert, type MoveAlert, type OptionsAlert, type OptionsLevel, type OptionsMetric, type PriceAlert, type ScriptAlert } from '../../../shared/alerts';
import { clsx, fmtNum, fmtDateTime } from '../../lib/format';
import type { Market, SymbolId } from '../../../shared/symbols';
import { SYMBOL_SPECS, roundToTick, priceDecimals } from '../../../shared/symbols';

export const KIND_LABEL: Record<AlertKind, string> = { price: 'Price level', move: 'Price move', indicator: 'Indicator', script: 'Script / strategy', book: 'Order book', futures: 'Futures data', options: 'Options' };

/** Open the alert editor for a new alert (kind + defaults) or an existing one. */
export function openAlertEditor(init: Alert | { kind: AlertKind; symbol: SymbolId; market: Market; patch?: Partial<Alert> }): void {
  const a = 'id' in init && init.id ? init : newAlert(init.kind, init.symbol, init.market, ('patch' in init && init.patch) || {});
  openModal('alert-editor', (close) => <AlertEditor initial={a as Alert} onClose={close} />);
}

/** Create a price alert at once (chart context menu), with an Edit action in the toast. */
export async function quickPriceAlert(symbol: SymbolId, market: Market, level: number, last: number): Promise<void> {
  const lv = roundToTick(level, SYMBOL_SPECS[symbol][market].tickSize);
  const a = newAlert('price', symbol, market, { level: lv, condition: isFinite(last) ? (lv >= last ? 'crossesAbove' : 'crossesBelow') : 'crosses' } as Partial<PriceAlert>);
  try {
    const saved = await api.call<Alert>('alerts:save', a);
    toast({ title: 'Alert created', body: describeAlert(saved), kind: 'ok', action: { label: 'Edit', run: () => openAlertEditor(saved) } });
  } catch (e) {
    toast({ title: 'Alert not created', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });
  }
}

function AlertEditor({ initial, onClose }: { initial: Alert; onClose: () => void }) {
  const [a, setA] = useState<Alert>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Alert>) => setA((x) => ({ ...x, ...p }) as Alert);
  const isNew = !initial.id;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.call('alerts:save', { ...a, enabled: isNew ? true : a.enabled || a.status !== 'active' });
      toast({ title: isNew ? 'Alert created' : 'Alert saved', body: describeAlert(a), kind: 'ok' });
      onClose();
    } catch (e) {
      setErr(errorMessage(e).replace(/^Validation: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const preview = useMemo(() => {
    try {
      return describeAlert(a);
    } catch {
      return '';
    }
  }, [a]);
  return (
    <Modal
      title={isNew ? `New ${KIND_LABEL[a.kind].toLowerCase()} alert` : 'Edit alert'}
      icon="bell"
      onClose={onClose}
      width={560}
      footer={
        <>
          {err && <span className="danger-text small grow">{err}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {isNew ? 'Create alert' : 'Save'}
          </button>
        </>
      }
    >
      <div className="alert-editor">
        {isNew && (
          <Segmented
            value={a.kind}
            onChange={(k) => setA({ ...newAlert(k, a.symbol, a.market), name: a.name })}
            options={(Object.keys(KIND_LABEL) as AlertKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          />
        )}
        <div className="ae-row">
          <span className="ae-label">Market</span>
          <SymbolPicker symbol={a.symbol} market={a.market} showMarket={a.kind !== 'options'} onChange={(s, m) => set({ symbol: s, market: a.kind === 'futures' ? 'futures' : a.kind === 'options' ? 'spot' : m })} />
        </div>
        {a.kind === 'price' && <PriceFields a={a} set={set} />}
        {a.kind === 'move' && <MoveFields a={a} set={set} />}
        {(a.kind === 'indicator' || a.kind === 'script') && <ScriptFields a={a} set={set} />}
        {a.kind === 'book' && <BookFields a={a} set={set} />}
        {a.kind === 'futures' && <FuturesFields a={a} set={set} />}
        {a.kind === 'options' && <OptionsFields a={a} set={set} />}
        <div className="ae-preview">
          <span className="faint small">Notify when</span>
          <b>{preview}</b>
        </div>
        <div className="ae-sep" />
        <div className="ae-row">
          <span className="ae-label">Trigger</span>
          <Select
            value={a.frequency}
            onChange={(f) => set({ frequency: f })}
            options={[
              { value: 'once', label: 'Only once (then switch off)' },
              ...(a.kind === 'indicator' || a.kind === 'script' ? [{ value: 'perBar' as const, label: 'Once per bar' }] : []),
              { value: 'perMinute', label: 'At most once per minute' },
              { value: 'every', label: 'Every time (with a pause)' },
            ]}
          />
          {a.frequency === 'every' && (
            <NumberField value={a.cooldownSec} onChange={(v) => set({ cooldownSec: Math.max(0, Math.round(v)) })} min={0} step={30} decimals={0} suffix="s pause" style={{ width: 130 }} />
          )}
        </div>
        <div className="ae-row">
          <span className="ae-label">Name</span>
          <input className="input grow" placeholder="Optional — the condition is used otherwise" value={a.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="ae-row" style={{ alignItems: 'flex-start' }}>
          <span className="ae-label">Message</span>
          <textarea className="input grow ae-msg" placeholder="Optional. Placeholders: {{symbol}} {{price}} {{value}} {{name}} {{time}} {{message}}" value={a.message || ''} onChange={(e) => set({ message: e.target.value })} />
        </div>
        <div className="ae-row">
          <span className="ae-label">Expires</span>
          <input
            className="input"
            type="datetime-local"
            value={a.expiresAt ? toLocalInput(a.expiresAt) : ''}
            onChange={(e) => set({ expiresAt: e.target.value ? new Date(e.target.value).getTime() : null })}
          />
          {a.expiresAt ? (
            <button className="btn small ghost" onClick={() => set({ expiresAt: null })}>
              Never
            </button>
          ) : (
            <span className="faint small">never</span>
          )}
        </div>
        <div className="ae-row">
          <span className="ae-label">Notify</span>
          <label className="row" style={{ gap: 6 }}>
            <Toggle value={a.notify.desktop} onChange={(v) => set({ notify: { ...a.notify, desktop: v } })} /> Desktop notification
          </label>
          <label className="row" style={{ gap: 6 }}>
            <Toggle value={a.notify.sound} onChange={(v) => set({ notify: { ...a.notify, sound: v } })} /> Sound
          </label>
        </div>
        <WebhookRow url={a.notify.webhook || ''} message={a.message || ''} onChange={(webhook) => set({ notify: { ...a.notify, webhook: webhook || undefined } })} />
      </div>
    </Modal>
  );
}

/** TradingView-style webhook: POST the alert message to a URL (JSON when the message is JSON). */
function WebhookRow({ url, message, onChange }: { url: string; message: string; onChange: (url: string) => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const err = webhookUrlError(url);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const sample = message.trim() ? message.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => `<${k}>`) : 'FuFu test alert';
      const r = await api.call<{ ok: boolean; status?: number; error?: string; ms: number }>('alerts:testWebhook', url, sample);
      setResult(r.ok ? `Delivered (HTTP ${r.status}, ${r.ms} ms)` : `Failed: ${r.error || `HTTP ${r.status}`}`);
    } catch (e) {
      setResult(`Failed: ${errorMessage(e).replace(/^Validation: /, '')}`);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="ae-row" style={{ alignItems: 'flex-start' }}>
      <span className="ae-label">Webhook</span>
      <div className="col grow" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6 }}>
          <input className="input grow" placeholder="Optional: https://… receives the message as a POST request" value={url} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          <button className="btn small" disabled={!url.trim() || !!err || testing} onClick={() => void test()}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <span className={clsx('small', err || result?.startsWith('Failed') ? 'danger-text' : 'faint')}>
          {err || result || 'Sent as JSON when the message is valid JSON, otherwise as text. Use it to drive your own bot, Discord or a Telegram relay.'}
        </span>
      </div>
    </div>
  );
}

function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function useLastPrice(symbol: SymbolId, market: Market): number {
  const [p, setP] = useState(NaN);
  useEffect(() => {
    let alive = true;
    void api.call<number>('market:lastPrice', symbol, market).then((v) => alive && setP(v)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [symbol, market]);
  return p;
}

function PriceFields({ a, set }: { a: PriceAlert; set: (p: Partial<PriceAlert>) => void }) {
  const last = useLastPrice(a.symbol, a.market);
  useEffect(() => {
    if (!(a.level > 0) && last > 0) set({ level: +last.toFixed(2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);
  const channel = a.condition === 'enterChannel' || a.condition === 'exitChannel';
  const tick = SYMBOL_SPECS[a.symbol][a.market].tickSize;
  const pd = priceDecimals(a.symbol, a.market);
  const conditions = [
    { value: 'crosses' as const, label: 'Crosses' },
    { value: 'crossesAbove' as const, label: 'Crosses above' },
    { value: 'crossesBelow' as const, label: 'Crosses below' },
    { value: 'above' as const, label: 'Is above' },
    { value: 'below' as const, label: 'Is below' },
    ...(a.line
      ? []
      : [
          { value: 'enterChannel' as const, label: 'Enters channel' },
          { value: 'exitChannel' as const, label: 'Exits channel' },
        ]),
  ];
  const lineNow = a.line ? priceLevelAt(a, Date.now()) : null;
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Condition</span>
        <Select value={a.condition} onChange={(c) => set({ condition: c, level2: c === 'enterChannel' || c === 'exitChannel' ? a.level2 || +(a.level * 1.01).toFixed(2) : a.level2 })} options={conditions} />
      </div>
      {a.line ? (
        <div className="ae-row">
          <span className="ae-label">Trendline</span>
          <span data-tip={`From ${fmtDateTime(a.line.t1)} to ${fmtDateTime(a.line.t2)}${a.line.log ? ' · straight on a log scale' : ''}`}>
            {fmtNum(a.line.p1, pd)} → {fmtNum(a.line.p2, pd)}
            <span className="faint">
              {' '}
              · now {lineNow === null ? 'ended' : fmtNum(lineNow, pd)} · {a.line.extend === 'none' ? 'until its end' : 'extended right'}
            </span>
          </span>
          <button className="btn small ghost" onClick={() => set({ line: undefined, level: +(lineNow ?? a.level).toFixed(pd) })} data-tip="Turn this into an alert on a fixed price">
            Fixed price
          </button>
        </div>
      ) : (
      <div className="ae-row">
        <span className="ae-label">{channel ? 'From' : 'Price'}</span>
        <NumberField value={a.level || null} onChange={(v) => set({ level: v })} step={tick * 100} decimals={priceDecimals(a.symbol, a.market)} style={{ width: 160 }} />
        {channel && (
          <>
            <span className="faint">to</span>
            <NumberField value={a.level2 || null} onChange={(v) => set({ level2: v })} step={tick * 100} decimals={priceDecimals(a.symbol, a.market)} style={{ width: 160 }} />
          </>
        )}
        {last > 0 && (
          <button className="btn small ghost" onClick={() => set({ level: +last.toFixed(2) })} data-tip="Use the current price">
            now {last.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </button>
        )}
      </div>
      )}
    </>
  );
}

function MoveFields({ a, set }: { a: MoveAlert; set: (p: Partial<MoveAlert>) => void }) {
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Direction</span>
        <Segmented
          value={a.direction}
          onChange={(d) => set({ direction: d })}
          options={[
            { value: 'either', label: 'Up or down' },
            { value: 'up', label: 'Up' },
            { value: 'down', label: 'Down' },
          ]}
        />
      </div>
      <div className="ae-row">
        <span className="ae-label">Move</span>
        <NumberField value={a.pct} onChange={(v) => set({ pct: Math.max(0.01, v) })} min={0.01} step={0.5} decimals={2} suffix="%" style={{ width: 110 }} />
        <span className="faint">within</span>
        <NumberField value={a.minutes} onChange={(v) => set({ minutes: Math.max(1, Math.round(v)) })} min={1} step={5} decimals={0} suffix="min" style={{ width: 110 }} />
      </div>
    </>
  );
}

function ScriptFields({ a, set }: { a: IndicatorAlert | ScriptAlert; set: (p: Partial<IndicatorAlert> | Partial<ScriptAlert>) => void }) {
  const scripts = useScripts();
  const list = useMemo(() => (scripts || []).filter((s) => s.kind === 'indicator' || s.kind === 'strategy'), [scripts]);
  const [an, setAn] = useState<AnalyzeResult | null>(null);
  useEffect(() => {
    if (!a.scriptId && list.length) {
      const pick = a.kind === 'indicator' ? list.find((s) => /rsi|relative strength/i.test(s.name)) || list[0] : list.find((s) => s.kind === 'strategy') || list[0];
      set({ scriptId: pick.id, scriptName: pick.name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);
  useEffect(() => {
    setAn(null);
    if (!a.scriptId) return;
    let alive = true;
    void api
      .call('scripts:get', a.scriptId)
      .then((d: any) => api.call<AnalyzeResult>('scripts:analyze', d.language, d.code, { symbol: a.symbol, market: a.market, tf: a.tf, chartType: 'candles' }))
      .then((r) => alive && setAn(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [a.scriptId, a.symbol, a.market, a.tf]);
  // sensible defaults once the script is known
  useEffect(() => {
    if (!an?.ok) return;
    if (a.kind === 'indicator' && an.plots?.length && !an.plots.some((p) => p.id === a.plot || p.title === a.plot)) {
      const p = an.plots[0];
      const t = (a as IndicatorAlert).target;
      // RSI-like oscillators: start with the usual overbought level instead of 0
      const level = /rsi|stoch|mfi/i.test(an.meta?.title || '') && t.type === 'value' && t.value === 0 ? { target: { type: 'value' as const, value: 70 } } : {};
      set({ plot: p.id, plotTitle: p.title, ...level });
    }
    if (a.kind === 'script' && a.trigger.type === 'alertcondition' && !an.alertconditions?.includes(a.trigger.title)) set({ trigger: an.alertconditions?.length ? { type: 'alertcondition', title: an.alertconditions[0] } : { type: 'alert' } } as Partial<ScriptAlert>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [an]);
  const isStrategy = an?.meta?.type === 'strategy';
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Script</span>
        <Select value={a.scriptId} onChange={(id) => set({ scriptId: id, scriptName: list.find((s) => s.id === id)?.name, inputs: {}, plot: '' } as Partial<IndicatorAlert>)} options={[{ value: '', label: 'Choose…' }, ...list.map((s) => ({ value: s.id, label: `${s.name}${s.kind === 'strategy' ? ' (strategy)' : ''}${s.language === 'python' ? ' · Py' : ''}` }))]} style={{ flex: 1, minWidth: 0 }} />
      </div>
      <div className="ae-row">
        <span className="ae-label">Timeframe</span>
        <TimeframePicker tf={a.tf} onChange={(tf) => set({ tf })} />
      </div>
      {!an && a.scriptId && (
        <div className="faint small">
          <Spinner size={10} /> Reading the script…
        </div>
      )}
      {an && !an.ok && <div className="danger-text small">Script error{an.error?.line ? ` (line ${an.error.line})` : ''}: {an.error?.message}</div>}
      {an?.ok && an.inputs.length > 0 && (
        <details className="ae-inputs">
          <summary>Inputs ({an.inputs.length})</summary>
          {an.inputs.map((d) => (
            <label key={d.key} className="set-row">
              <span className="ellipsis">{d.title}</span>
              <InputControl def={d} value={a.inputs?.[d.key]} onChange={(v) => set({ inputs: { ...(a.inputs || {}), [d.key]: v } })} />
            </label>
          ))}
        </details>
      )}
      {a.kind === 'indicator' && an?.ok && <IndicatorCondition a={a} set={set} plots={an.plots || []} />}
      {a.kind === 'script' && an?.ok && (
        <div className="ae-row">
          <span className="ae-label">When</span>
          <Select
            value={a.trigger.type === 'alertcondition' ? `ac:${a.trigger.title}` : a.trigger.type}
            onChange={(v) => set({ trigger: v.startsWith('ac:') ? { type: 'alertcondition', title: v.slice(3) } : v === 'orders' ? { type: 'orders' } : { type: 'alert' } } as Partial<ScriptAlert>)}
            options={[
              ...(an.alertconditions || []).map((t) => ({ value: `ac:${t}`, label: `alertcondition: ${t}` })),
              { value: 'alert', label: 'Any alert() call' },
              ...(isStrategy ? [{ value: 'orders', label: 'Strategy order fills' }] : []),
            ]}
            style={{ flex: 1, minWidth: 0 }}
          />
        </div>
      )}
      <div className="ae-row">
        <span className="ae-label">Evaluate</span>
        <Segmented
          value={a.onBarClose ? 'close' : 'live'}
          onChange={(v) => set({ onBarClose: v === 'close' })}
          options={[
            { value: 'close', label: 'On bar close', title: 'Only confirmed bars — no signals that disappear again' },
            { value: 'live', label: 'Intrabar', title: 'On every update of the forming bar (signals may repaint)' },
          ]}
        />
      </div>
    </>
  );
}

function IndicatorCondition({ a, set, plots }: { a: IndicatorAlert; set: (p: Partial<IndicatorAlert>) => void; plots: { id: string; title: string }[] }) {
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Plot</span>
        {plots.length ? (
          <Select value={a.plot} onChange={(id) => set({ plot: id, plotTitle: plots.find((p) => p.id === id)?.title })} options={plots.map((p) => ({ value: p.id, label: p.title }))} />
        ) : (
          <input className="input" placeholder="Plot title (Python)" value={a.plot} onChange={(e) => set({ plot: e.target.value, plotTitle: e.target.value })} />
        )}
        <Select
          value={a.condition}
          onChange={(c) => set({ condition: c })}
          options={[
            { value: 'crossesAbove', label: 'crosses above' },
            { value: 'crossesBelow', label: 'crosses below' },
            { value: 'crosses', label: 'crosses' },
            { value: 'above', label: 'is above' },
            { value: 'below', label: 'is below' },
          ]}
        />
      </div>
      <div className="ae-row">
        <span className="ae-label">Than</span>
        <Select
          value={a.target.type === 'plot' ? `plot:${a.target.plot}` : a.target.type}
          onChange={(v) => set({ target: v === 'value' ? { type: 'value', value: a.target.type === 'value' ? a.target.value : 0 } : v === 'price' ? { type: 'price' } : { type: 'plot', plot: v.slice(5), title: plots.find((p) => p.id === v.slice(5))?.title } })}
          options={[{ value: 'value', label: 'a value' }, { value: 'price', label: 'the price' }, ...plots.filter((p) => p.id !== a.plot).map((p) => ({ value: `plot:${p.id}`, label: `plot: ${p.title}` }))]}
        />
        {a.target.type === 'value' && <NumberField value={a.target.value} onChange={(v) => set({ target: { type: 'value', value: v } })} step={1} decimals={4} style={{ width: 130 }} />}
      </div>
    </>
  );
}

const FUTURES_DEFAULTS: Record<FuturesMetric, Partial<FuturesAlert>> = {
  liquidations: { condition: 'either', value: 1_000_000, minutes: 5 },
  oiChange: { condition: 'either', value: 3, minutes: 60 },
  funding: { condition: 'above', value: 0.03 },
  longShortRatio: { condition: 'above', value: 2.5 },
};

function FuturesFields({ a, set }: { a: FuturesAlert; set: (p: Partial<FuturesAlert>) => void }) {
  const unit = a.metric === 'liquidations' ? 'USDT' : a.metric === 'longShortRatio' ? '' : '%';
  const conds =
    a.metric === 'oiChange'
      ? [
          { value: 'up', label: 'rises by' },
          { value: 'down', label: 'falls by' },
          { value: 'either', label: 'moves by' },
        ]
      : a.metric === 'liquidations'
        ? [
            { value: 'either', label: 'all positions' },
            { value: 'longs', label: 'longs' },
            { value: 'shorts', label: 'shorts' },
          ]
        : [
            { value: 'above', label: 'above' },
            { value: 'below', label: 'below' },
          ];
  const hint: Record<FuturesMetric, string> = {
    liquidations: 'Liquidated notional on the Binance perpetual within the window. Binance reports at most one liquidation per second (the largest), so real totals are higher.',
    oiChange: 'Change of the open interest (USDT value) over the window, from minute samples and Binance’s 5-minute history.',
    funding: 'The predicted funding rate per 8-hour period, in %. Positive: longs pay shorts.',
    longShortRatio: 'Ratio of accounts with long positions to accounts with short positions (Binance, 5-minute data).',
  };
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Measure</span>
        <Select
          value={a.metric}
          onChange={(m) => set({ metric: m, ...FUTURES_DEFAULTS[m] })}
          options={[
            { value: 'liquidations', label: 'Liquidations' },
            { value: 'oiChange', label: 'Open interest change' },
            { value: 'funding', label: 'Funding rate' },
            { value: 'longShortRatio', label: 'Long/short ratio' },
          ]}
        />
        <Select value={a.condition} onChange={(c) => set({ condition: c as FuturesAlert['condition'] })} options={conds as { value: FuturesAlert['condition']; label: string }[]} />
        <NumberField
          value={a.value}
          onChange={(v) => set({ value: v })}
          step={a.metric === 'liquidations' ? 100000 : a.metric === 'funding' ? 0.005 : a.metric === 'oiChange' ? 0.5 : 0.1}
          decimals={a.metric === 'liquidations' ? 0 : a.metric === 'funding' ? 4 : 2}
          suffix={unit}
          style={{ width: 150 }}
        />
      </div>
      {(a.metric === 'oiChange' || a.metric === 'liquidations') && (
        <div className="ae-row">
          <span className="ae-label">Within</span>
          <NumberField value={a.minutes} onChange={(v) => set({ minutes: Math.max(1, Math.min(a.metric === 'liquidations' ? 60 : 1440, Math.round(v))) })} step={5} decimals={0} suffix="min" style={{ width: 110 }} />
        </div>
      )}
      <div className="faint small">{hint[a.metric]}</div>
    </>
  );
}

const OPTIONS_DEFAULTS: Record<OptionsMetric, Partial<OptionsAlert>> = {
  iv30: { condition: 'above', value: 60 },
  skew: { condition: 'below', value: -5 },
  putCall: { condition: 'above', value: 1.5 },
  level: { condition: 'crosses', level: 'flip' },
};

function OptionsFields({ a, set }: { a: OptionsAlert; set: (p: Partial<OptionsAlert>) => void }) {
  const hint: Record<OptionsMetric, string> = {
    iv30: "At-the-money implied volatility for 30 days, interpolated between Binance's expiries like a volatility index. Spikes come with fear and big moves.",
    skew: '25-delta risk reversal at 30 days, in volatility points: call minus put volatility. Strongly negative means traders pay up for downside protection.',
    putCall: 'Open interest of all puts divided by that of all calls (contracts).',
    level: 'Levels from the options open interest, recomputed every few seconds: the gamma flip (where dealer gamma changes sign), max pain of the next expiry, and the call and put walls (the strikes with the most open interest within 45 days).',
  };
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Measure</span>
        <Select
          value={a.metric}
          onChange={(m) => set({ metric: m, ...OPTIONS_DEFAULTS[m] })}
          options={[
            { value: 'iv30', label: '30-day implied volatility' },
            { value: 'skew', label: '25Δ skew (30 days)' },
            { value: 'putCall', label: 'Put/call open interest' },
            { value: 'level', label: 'Index vs an options level' },
          ]}
        />
        {a.metric === 'level' ? (
          <>
            <Select
              value={a.condition}
              onChange={(c) => set({ condition: c as OptionsAlert['condition'] })}
              options={[
                { value: 'crosses', label: 'crosses' },
                { value: 'above', label: 'is above' },
                { value: 'below', label: 'is below' },
              ]}
            />
            <Select value={a.level || 'flip'} onChange={(l) => set({ level: l as OptionsLevel })} options={(Object.keys(OPTIONS_LEVEL_LABEL) as OptionsLevel[]).map((l) => ({ value: l, label: OPTIONS_LEVEL_LABEL[l] }))} />
          </>
        ) : (
          <>
            <Select
              value={a.condition === 'crosses' ? 'above' : a.condition}
              onChange={(c) => set({ condition: c as OptionsAlert['condition'] })}
              options={[
                { value: 'above', label: 'above' },
                { value: 'below', label: 'below' },
              ]}
            />
            <NumberField value={a.value} onChange={(v) => set({ value: v })} step={a.metric === 'putCall' ? 0.05 : 0.5} decimals={2} suffix={a.metric === 'iv30' ? '%' : a.metric === 'skew' ? 'pts' : ''} style={{ width: 130 }} />
          </>
        )}
      </div>
      <div className="faint small">{hint[a.metric]}</div>
    </>
  );
}

function BookFields({ a, set }: { a: BookAlert; set: (p: Partial<BookAlert>) => void }) {
  const unit = a.metric === 'imbalance' ? '%' : a.metric === 'spreadBps' ? 'bps' : 'USDT';
  const defaults: Record<BookAlert['metric'], number> = { imbalance: 40, bidDepth: 5_000_000, askDepth: 5_000_000, spreadBps: 2, largeOrder: 1_000_000 };
  return (
    <>
      <div className="ae-row">
        <span className="ae-label">Measure</span>
        <Select
          value={a.metric}
          onChange={(m) => set({ metric: m, value: defaults[m], condition: m === 'spreadBps' ? 'above' : a.condition })}
          options={[
            { value: 'imbalance', label: 'Bid/ask imbalance' },
            { value: 'bidDepth', label: 'Bid liquidity' },
            { value: 'askDepth', label: 'Ask liquidity' },
            { value: 'spreadBps', label: 'Spread' },
            { value: 'largeOrder', label: 'Large resting order appears' },
          ]}
        />
        {a.metric !== 'largeOrder' && (
          <Select
            value={a.condition}
            onChange={(c) => set({ condition: c })}
            options={[
              { value: 'above', label: 'above' },
              { value: 'below', label: 'below' },
            ]}
          />
        )}
        <NumberField value={a.value} onChange={(v) => set({ value: v })} step={a.metric === 'imbalance' ? 5 : a.metric === 'spreadBps' ? 0.5 : 100000} decimals={a.metric === 'spreadBps' ? 2 : 0} suffix={unit} style={{ width: 150 }} />
      </div>
      {a.metric !== 'spreadBps' && (
        <div className="ae-row">
          <span className="ae-label">Range</span>
          <NumberField value={a.rangePct} onChange={(v) => set({ rangePct: Math.max(0.01, Math.min(10, v)) })} step={0.1} decimals={2} suffix="% of mid" style={{ width: 140 }} />
          <span className="faint small">{a.metric === 'imbalance' ? '(bids − asks) / (bids + asks) in USDT within the range; +100% = only bids' : 'orders within this distance of the mid price'}</span>
        </div>
      )}
      {a.metric !== 'largeOrder' && (
        <div className="ae-row">
          <span className="ae-label">Hold for</span>
          <NumberField value={a.sustainSec} onChange={(v) => set({ sustainSec: Math.max(0, Math.round(v)) })} step={5} decimals={0} suffix="s" style={{ width: 110 }} />
          <span className="faint small">the condition must hold this long (filters out flickering orders)</span>
        </div>
      )}
    </>
  );
}
