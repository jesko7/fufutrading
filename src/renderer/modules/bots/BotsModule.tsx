import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { Tabs, Menu, usePopover, confirmDialog, promptDialog, Empty, Spinner, Select, Segmented, NumberField, Toggle, SymbolPicker, TimeframePicker } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useNow } from '../../lib/hooks';
import { clsx, fmtNum, fmtUsd, fmtSignedUsd, fmtPct, fmtDateTime, fmtAgo } from '../../lib/format';
import { useScripts, openScriptInEditor, type AnalyzeResult } from '../scripts/client';
import { InputControl, ParamSetPicker } from '../chart/indicators';
import { openCreateAccount, useAccount } from '../trading/accounts';
import { Stat, Positions, Orders, Trades, Events } from '../trading/AccountModule';
import { openModule } from '../../app/moduleOps';
import { newId } from '../../../shared/workspace';
import type { AccountEvent, BotConfig, BotView, ClosedTrade } from '../../../shared/trading/types';
import { SYMBOL_SPECS, qtyDecimals } from '../../../shared/symbols';
import './bots.css';

type BotTab = 'activity' | 'signals' | 'orders' | 'state' | 'logs' | 'trades';

function useBots(): BotView[] | null {
  const [list, setList] = useState<BotView[] | null>(null);
  useEffect(() => api.sub<BotView[]>('bots', {}, setList), []);
  return list;
}

function useBot(id: string): BotView | null {
  const [v, setV] = useState<BotView | null>(null);
  useEffect(() => {
    setV(null);
    return api.sub<BotView | null>('bot', { id }, setV);
  }, [id]);
  return v;
}

const STATUS_LABEL: Record<string, string> = { running: 'Running', paused: 'Paused', stopped: 'Stopped', error: 'Error' };

const fail = (what: string) => (e: unknown) => toast({ title: what, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

function pnlSince(b: BotView): number {
  return b.account.equity - (b.account.startEquity ?? b.account.initial);
}

export function BotsModule({ module }: ModuleProps) {
  const cfg = module.config as { botId?: string | null; tab?: BotTab };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const bots = useBots();
  const newBot = () => openCreateAccount((id) => set({ botId: id }), { kind: 'bot' });
  if (!bots)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  const sel = bots.find((b) => b.accountId === cfg.botId) || bots[0] || null;
  const running = bots.filter((b) => b.config?.status === 'running').length;
  return (
    <div className="bots">
      <HeadControls>
        <button className="btn small primary" onClick={newBot} data-tip="Create a bot with its own paper account">
          <Icon name="plus" size={13} /> New bot
        </button>
        {running > 0 && (
          <button className="btn small ghost" onClick={() => void api.call('bots:pauseAll').catch(fail('Pause failed'))} data-tip="Pause every running bot (orders and positions stay)">
            <Icon name="pause" size={13} /> Pause all
          </button>
        )}
      </HeadControls>
      {!bots.length ? (
        <Empty icon="bot" title="No bots yet">
          <div className="col" style={{ alignItems: 'center', gap: 12 }}>
            <span>A bot runs one of your strategies on its own paper account. Whenever a bar closes it evaluates the strategy and mirrors its decisions — entries, take-profits and stop-losses — on the account, with every action explained.</span>
            <button className="btn primary" onClick={newBot}>
              <Icon name="plus" size={14} /> Create a bot
            </button>
          </div>
        </Empty>
      ) : (
        <div className="bots-body">
          <div className="bots-side">
            {bots.map((b) => (
              <BotItem key={b.accountId} b={b} on={sel?.accountId === b.accountId} onClick={() => set({ botId: b.accountId })} />
            ))}
          </div>
          <div className="bots-main">{sel && <BotDetail key={sel.accountId} id={sel.accountId} tab={cfg.tab || 'activity'} setTab={(t) => set({ tab: t })} />}</div>
        </div>
      )}
    </div>
  );
}

function BotItem({ b, on, onClick }: { b: BotView; on: boolean; onClick: () => void }) {
  const status = b.config?.status || 'stopped';
  const pnl = pnlSince(b);
  const c = b.config;
  return (
    <div className={clsx('bot-item', on && 'on')} onClick={onClick}>
      <div className="row" style={{ gap: 8 }}>
        <span className={clsx('bot-dot', status, b.phase === 'evaluating' && 'busy')} data-tip={STATUS_LABEL[status]} />
        <b className="ellipsis" style={{ minWidth: 0 }}>
          {b.name}
        </b>
        <span className="spacer" />
        <span className={clsx('num small', pnl > 0.005 ? 'up' : pnl < -0.005 ? 'down' : 'faint')}>{fmtSignedUsd(pnl)}</span>
      </div>
      <div className="faint small ellipsis">{c?.scriptId ? `${c.scriptName || 'Strategy'} · ${SYMBOL_SPECS[c.symbol].base}${b.market === 'futures' ? '.P' : ''} ${c.tf}` : 'Not configured yet'}</div>
    </div>
  );
}

function Countdown({ at }: { at: number | null }) {
  const now = useNow(1000);
  if (!at) return <>—</>;
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s >= 3600) return <>{`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`}</>;
  return <>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</>;
}

function BotDetail({ id, tab, setTab }: { id: string; tab: BotTab; setTab: (t: BotTab) => void }) {
  const v = useBot(id);
  const [evVersion, setEvVersion] = useState(0);
  const a = useAccount(id, () => setEvVersion((x) => x + 1));
  const stopMenu = usePopover();
  const more = usePopover();
  const [busy, setBusy] = useState(false);
  if (!v || !a)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  const c = v.config;
  const status = c?.status || 'stopped';
  const configured = !!c?.scriptId;
  const act = async (fn: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      fail(what)(e);
    } finally {
      setBusy(false);
    }
  };
  const base = c ? SYMBOL_SPECS[c.symbol].base : '';
  const openChart = () => {
    if (!c) return;
    void openModule('chart', { symbol: c.symbol, market: v.market, tf: c.tf, chartType: c.chartType, accountId: id, indicators: [{ id: newId('i'), scriptId: c.scriptId, inputs: c.params || {}, visible: true }] }, { reuse: false });
  };
  const backtest = () => {
    if (!c?.scriptId) return;
    void openModule('backtest', { scriptId: c.scriptId, inputs: c.params || {}, symbol: c.symbol, market: v.market, tf: c.tf, chartType: c.chartType, runId: null, autorun: Date.now() });
  };
  const moreItems = [
    ...(status === 'running' ? [{ label: 'Evaluate now', icon: 'refresh', hint: 'Re-run on the closed bars', onClick: () => void act(() => api.call('bots:stepNow', id), 'Evaluation failed') }] : []),
    { label: 'Open chart with the strategy', icon: 'chart', disabled: !configured, onClick: openChart },
    { label: 'Backtest this setup', icon: 'flask', disabled: !configured, onClick: backtest },
    { label: 'Open the strategy script', icon: 'code', disabled: !configured, onClick: () => c && void openScriptInEditor(c.scriptId) },
    { label: 'Open account', icon: 'wallet', onClick: () => void openModule('account', { accountId: id }) },
    { sep: true },
    {
      label: 'Rename…',
      icon: 'edit',
      onClick: async () => {
        const n = await promptDialog({ title: 'Rename bot', initial: v.name });
        if (n) await api.call('trading:update', id, { name: n }).catch(fail('Rename failed'));
      },
    },
    {
      label: 'Reset account…',
      icon: 'refresh',
      onClick: async () => {
        if (await confirmDialog({ title: 'Reset this bot’s account?', body: 'The bot stops, all positions, orders and history are cleared and the balance returns to its initial value.', confirm: 'Reset', danger: true })) await api.call('trading:reset', id).catch(fail('Reset failed'));
      },
    },
    {
      label: 'Delete bot…',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: 'Delete bot?', body: `“${v.name}”, its paper account and its history will be deleted permanently.`, confirm: 'Delete', danger: true })) await api.call('trading:delete', id).catch(fail('Delete failed'));
      },
    },
  ];
  const pnl = pnlSince(v);
  const startEq = v.account.startEquity ?? v.account.initial;
  const plan = v.lastPlan;
  const target = plan?.target ?? 0;
  const pos = v.account.position;
  const qd = c ? qtyDecimals(c.symbol, v.market) : 4;
  const inSync = !plan || Math.abs(pos - target) <= Math.max(1e-9, Math.abs(target) * 0.003);
  return (
    <div className="bot-detail">
      <div className="bot-head">
        <span className="bot-swatch" style={{ background: v.color }} />
        <div className="col" style={{ gap: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="bot-title ellipsis">{v.name}</b>
            <span className={clsx('status-pill', `bot-${status}`)}>{STATUS_LABEL[status]}</span>
          </div>
          <div className="faint small ellipsis">
            {status === 'running' && v.phase === 'evaluating' ? (
              <>
                <Spinner size={10} /> Evaluating the strategy…
              </>
            ) : status === 'running' && v.phase === 'waiting' ? (
              <>
                Waiting for the {c?.tf} bar to close · next evaluation in <Countdown at={v.nextStepAt} />
              </>
            ) : (
              v.phaseText
            )}
          </div>
        </div>
        <span className="spacer" />
        {status === 'running' && (
          <button className="btn" disabled={busy} onClick={() => void act(() => api.call('bots:pause', id), 'Could not pause')} data-tip="Stop evaluating; orders and positions stay as they are">
            <Icon name="pause" size={14} /> Pause
          </button>
        )}
        {(status === 'paused' || status === 'error') && (
          <button className="btn primary" disabled={busy} onClick={() => void act(() => api.call('bots:start', id), 'Could not resume')} data-tip="Resume: the bot re-syncs with the strategy at once">
            <Icon name="play" size={14} /> Resume
          </button>
        )}
        {status !== 'stopped' && c && (
          <button className="btn" disabled={busy} onClick={(e) => stopMenu.toggle(e.currentTarget)}>
            <Icon name="stop" size={14} /> Stop <Icon name="chevDown" size={12} />
          </button>
        )}
        <button className="icon-btn" onClick={(e) => more.toggle(e.currentTarget)} data-tip="More">
          <Icon name="more" />
        </button>
        {stopMenu.anchor && (
          <Menu
            anchor={stopMenu.anchor}
            onClose={stopMenu.close}
            align="end"
            width={260}
            items={[
              { label: 'Stop, keep the position', icon: 'stop', hint: 'cancels bot orders', onClick: () => void act(() => api.call('bots:stop', id, { close: false }), 'Could not stop') },
              { label: 'Stop and close the position', icon: 'x', danger: true, onClick: () => void act(() => api.call('bots:stop', id, { close: true }), 'Could not stop') },
            ]}
          />
        )}
        {more.anchor && <Menu anchor={more.anchor} onClose={more.close} align="end" width={270} items={moreItems} />}
      </div>
      {status === 'error' && c?.lastError && (
        <div className="bot-error">
          <Icon name="alert" size={15} />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b>The bot paused itself</b>
            <span className="selectable">{c.lastError}</span>
          </div>
          <span className="spacer" />
          {/^Line \d+/.test(c.lastError) && (
            <button className="btn small" onClick={() => void openScriptInEditor(c.scriptId, { line: +(c.lastError!.match(/^Line (\d+)/)![1]) })}>
              <Icon name="code" size={13} /> Show in editor
            </button>
          )}
        </div>
      )}
      {(status === 'stopped' || !configured) && <BotSetup v={v} leverage={c ? a.config.futures.leverage[c.symbol] || a.config.futures.defaultLeverage : a.config.futures.defaultLeverage} />}
      {configured && status !== 'stopped' && <SetupSummary c={c!} market={v.market} />}
      <div className="acct-stats bot-stats">
        <Stat k="Equity" v={fmtUsd(v.account.equity)} sub={<span className="faint">start {fmtUsd(startEq)}</span>} />
        <Stat k={v.account.startEquity !== null ? 'P&L since start' : 'P&L'} v={<span className={pnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(pnl)}</span>} sub={<span className={pnl >= 0 ? 'up' : 'down'}>{fmtPct((pnl / startEq) * 100)}</span>} />
        <Stat
          k="Position"
          v={pos ? <span className={pos > 0 ? 'up' : 'down'}>{`${pos > 0 ? 'Long' : 'Short'} ${fmtNum(Math.abs(pos), qd)} ${base}`}</span> : <span className="faint">Flat</span>}
          sub={pos && v.account.entry ? <span className="faint">@ {fmtNum(v.account.entry, 2)} · {fmtSignedUsd(v.account.unrealized)}</span> : undefined}
        />
        {plan && (
          <Stat
            k="Strategy"
            v={plan.simPosition ? <span>{`${plan.simPosition > 0 ? 'Long' : 'Short'} ${fmtNum(Math.abs(plan.simPosition), qd)}`}</span> : <span className="faint">Flat</span>}
            sub={plan.holding ? <span className="warn-text" data-tip="The position was closed outside the strategy; the bot waits for the next signal instead of re-entering">holding</span> : inSync ? <span className="up">in sync</span> : <span className="warn-text">adjusting</span>}
          />
        )}
        <Stat k="Orders" v={v.account.openOrders} />
        <Stat k="Trades" v={v.account.trades} />
        {v.lastStepAt && <Stat k="Last evaluation" v={fmtAgo(v.lastStepAt)} sub={<span className="faint">{`${v.stepMs} ms · ${fmtNum(v.bars, 0)} bars`}</span>} />}
        {v.market === 'futures' && v.account.liqPrice ? <Stat k="Liq. price" v={<span style={{ color: 'var(--warn)' }}>{fmtNum(v.account.liqPrice, 2)}</span>} /> : null}
      </div>
      <div className="row" style={{ padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'activity', label: 'Activity' },
            { value: 'signals', label: 'Signals', badge: v.sim?.pending.length || undefined },
            { value: 'orders', label: 'Orders', badge: a.orders.length || undefined },
            { value: 'state', label: 'State' },
            { value: 'logs', label: 'Logs', badge: v.sim?.logs.length || undefined },
            { value: 'trades', label: 'Trades' },
          ]}
        />
      </div>
      <div className="mod-scroll">
        {tab === 'activity' && <Activity id={id} version={evVersion} />}
        {tab === 'signals' && <Signals v={v} />}
        {tab === 'orders' && (
          <>
            <div className="bot-sub">Position</div>
            <Positions a={a} readOnly={status === 'running'} />
            <div className="bot-sub">Open orders</div>
            <Orders a={a} readOnly={status === 'running'} />
            {status === 'running' && <div className="faint small" style={{ padding: '6px 12px' }}>The bot manages these orders. Pause it to change them by hand.</div>}
          </>
        )}
        {tab === 'state' && <StateView v={v} />}
        {tab === 'logs' && <Logs v={v} />}
        {tab === 'trades' && <BotTrades id={id} since={c?.startedAt} />}
      </div>
    </div>
  );
}

const SIZING_LABEL: Record<BotConfig['sizing']['mode'], string> = { percentEquity: '% of equity', fixedUsd: 'USDT per position', fixedQty: 'Fixed quantity', strategy: "Strategy's own size" };

function sizingText(s: BotConfig['sizing'], base: string, futures: boolean, lev: number): string {
  switch (s.mode) {
    case 'percentEquity':
      return `Each new position uses ${s.value}% of the account equity${futures ? ` × ${lev}x leverage (${s.value * lev}% notional)` : ''}. Adds and partial exits follow the strategy proportionally.`;
    case 'fixedUsd':
      return `Each new position is worth ${s.value} USDT${futures ? ' notional' : ''}. Adds and partial exits follow the strategy proportionally.`;
    case 'fixedQty':
      return `Each new position is ${s.value} ${base}. Adds and partial exits follow the strategy proportionally.`;
    default:
      return `Uses the quantities the strategy computes itself (its default_qty settings) with this account's equity as capital${s.value !== 1 ? `, multiplied by ${s.value}` : ''}.`;
  }
}

function SetupSummary({ c, market }: { c: BotConfig; market: string }) {
  const params = Object.entries(c.params || {});
  return (
    <div className="bot-summary">
      <span>
        <Icon name="code" size={12} /> {c.scriptName || 'Strategy'}
      </span>
      <span>
        {SYMBOL_SPECS[c.symbol].base}
        {market === 'futures' ? '.P' : ''} · {c.tf}
        {c.chartType !== 'candles' ? ` · ${c.chartType === 'heikinashi' ? 'Heikin-Ashi' : 'Renko'}` : ''}
      </span>
      <span>{c.sizing.mode === 'percentEquity' ? `${c.sizing.value}% of equity` : c.sizing.mode === 'fixedUsd' ? `${c.sizing.value} USDT` : c.sizing.mode === 'fixedQty' ? `${c.sizing.value} ${SYMBOL_SPECS[c.symbol].base}` : `strategy size × ${c.sizing.value}`}</span>
      {params.length > 0 && <span className="faint ellipsis" style={{ minWidth: 0 }}>{params.map(([k, v]) => `${c.paramTitles?.[k] || k} ${typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)}`).join(' · ')}</span>}
      <span className="spacer" />
      {(c.guards?.maxDrawdownPct || c.guards?.maxDailyLossPct || c.guards?.maxConsecutiveLosses) && (
        <span className="faint" data-tip="Risk guards: the bot closes its position and pauses when one trips">
          <Icon name="shield" size={11} /> {[c.guards.maxDrawdownPct && `DD ${c.guards.maxDrawdownPct}%`, c.guards.maxDailyLossPct && `day ${c.guards.maxDailyLossPct}%`, c.guards.maxConsecutiveLosses && `${c.guards.maxConsecutiveLosses} losses`].filter(Boolean).join(' · ')}
        </span>
      )}
      <span className="faint">{c.autostart ? 'resumes on app start' : 'manual resume after restart'}</span>
    </div>
  );
}

function BotSetup({ v, leverage }: { v: BotView; leverage: number }) {
  const c = v.config;
  const scripts = useScripts();
  const strategies = useMemo(() => (scripts || []).filter((s) => s.kind === 'strategy'), [scripts]);
  const [d, setD] = useState<BotConfig>(() => ({ scriptId: '', language: 'pine', params: {}, symbol: 'BTCUSDT', market: v.market, tf: '15m', chartType: 'candles', status: 'stopped', sizing: { mode: 'percentEquity', value: 10 }, autostart: true, startMode: 'next', warmupBars: 1000, ...(c || {}) }));
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const patch = (p: Partial<BotConfig>) => {
    setD((x) => ({ ...x, ...p }));
    setDirty(true);
  };
  useEffect(() => {
    if (!d.scriptId && strategies.length) patch({ scriptId: (strategies.find((s) => s.id === 'builtin:strat_ma_cross') || strategies[0]).id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies.length]);
  useEffect(() => {
    setAnalysis(null);
    if (!d.scriptId) return;
    let alive = true;
    void api
      .call('scripts:get', d.scriptId)
      .then((doc: any) => api.call<AnalyzeResult>('scripts:analyze', doc.language, doc.code, { symbol: d.symbol, market: v.market, tf: d.tf, chartType: d.chartType }))
      .then((r) => alive && setAnalysis(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [d.scriptId, d.symbol, d.tf, d.chartType, v.market]);
  const base = SYMBOL_SPECS[d.symbol].base;
  const futures = v.market === 'futures';
  const save = async () => {
    setSaving(true);
    try {
      const paramTitles = Object.fromEntries((analysis?.inputs || []).map((i) => [i.key, i.title]));
      await api.call('bots:configure', v.accountId, { scriptId: d.scriptId, params: d.params, paramTitles, symbol: d.symbol, tf: d.tf, chartType: d.chartType, sizing: d.sizing, startMode: d.startMode, warmupBars: d.warmupBars, autostart: d.autostart, guards: d.guards || {} });
      setDirty(false);
      return true;
    } catch (e) {
      fail('Settings not saved')(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const start = async () => {
    if (!(await save())) return;
    try {
      await api.call('bots:start', v.accountId, { mode: d.startMode || 'next' });
      toast({ title: 'Bot started', body: `${v.name} · ${base} ${d.tf}`, kind: 'ok' });
    } catch (e) {
      fail('Could not start the bot')(e);
    }
  };
  const script = strategies.find((s) => s.id === d.scriptId);
  const notStrategy = analysis && analysis.ok && analysis.meta?.type !== 'strategy';
  return (
    <div className="bot-setup">
      <div className="bot-setup-grid">
        <div className="bs-section">
          <div className="bs-title">Strategy</div>
          <div className="row" style={{ gap: 6 }}>
            <Select value={d.scriptId || ''} options={[{ value: '', label: strategies.length ? 'Choose a strategy…' : 'No strategies in the library' }, ...strategies.map((s) => ({ value: s.id, label: `${s.name}${s.language === 'python' ? ' (Python)' : ''}` }))]} onChange={(id) => patch({ scriptId: id, params: {} })} style={{ flex: 1, minWidth: 0 }} />
            <button className="icon-btn" disabled={!d.scriptId} onClick={() => void openScriptInEditor(d.scriptId)} data-tip="Open in the editor">
              <Icon name="code" />
            </button>
          </div>
          {script?.description && <div className="faint small">{script.description}</div>}
          {notStrategy && <div className="bot-warn small">This script is an indicator. Bots need a strategy (strategy() in Pine, @strategy in Python).</div>}
          {analysis && !analysis.ok && <div className="bot-warn small">Script error{analysis.error?.line ? ` (line ${analysis.error.line})` : ''}: {analysis.error?.message}</div>}
          {analysis?.ok && analysis.inputs.length > 0 && (
            <>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="bs-sub">Parameters</span>
                <span className="spacer" />
                <button className="btn small ghost" onClick={() => patch({ params: {} })} data-tip="Back to the script's defaults">
                  Defaults
                </button>
              </div>
              <ParamSetPicker scriptId={d.scriptId} onPick={(inputs) => patch({ params: { ...inputs } })} current={d.params || {}} scriptName={analysis.meta?.title || script?.name || 'Strategy'} />
              <div className="bs-inputs">
                {analysis.inputs.map((def) => (
                  <label key={def.key} className="set-row" data-tip={def.tooltip}>
                    <span className="ellipsis">{def.title}</span>
                    <InputControl def={def} value={d.params?.[def.key]} onChange={(val) => patch({ params: { ...(d.params || {}), [def.key]: val } })} />
                  </label>
                ))}
              </div>
            </>
          )}
          {!analysis && d.scriptId && (
            <div className="faint small">
              <Spinner size={10} /> Reading the script’s parameters…
            </div>
          )}
        </div>
        <div className="bs-section">
          <div className="bs-title">Market</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <SymbolPicker symbol={d.symbol} market={v.market} showMarket={false} onChange={(s) => patch({ symbol: s })} />
            <TimeframePicker tf={d.tf} onChange={(tf) => patch({ tf })} />
            <Select value={d.chartType} options={[{ value: 'candles', label: 'Candles' }, { value: 'heikinashi', label: 'Heikin-Ashi' }, { value: 'renko', label: 'Renko' }]} onChange={(t) => patch({ chartType: t })} />
          </div>
          <div className="faint small">
            {futures ? `USDⓈ-M perpetual · ${leverage}x leverage (set on the account)` : 'Spot · long only'}
            {d.chartType === 'heikinashi' && ' · signals on Heikin-Ashi, simulated fills on real prices'}
            {d.chartType === 'renko' && ' · Renko bricks have synthetic prices; the account trades at real prices'}
          </div>
          <div className="bs-title" style={{ marginTop: 10 }}>
            Position size
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Select value={d.sizing.mode} options={(Object.keys(SIZING_LABEL) as BotConfig['sizing']['mode'][]).map((m) => ({ value: m, label: SIZING_LABEL[m] }))} onChange={(m) => patch({ sizing: { mode: m, value: m === 'percentEquity' ? 10 : m === 'fixedUsd' ? 1000 : m === 'fixedQty' ? +(SYMBOL_SPECS[d.symbol][v.market].minQty * 10).toFixed(6) : 1 } })} />
            <NumberField value={d.sizing.value} onChange={(val) => patch({ sizing: { ...d.sizing, value: Math.max(0, val) } })} min={0} step={d.sizing.mode === 'fixedQty' ? SYMBOL_SPECS[d.symbol][v.market].stepSize * 10 : d.sizing.mode === 'fixedUsd' ? 100 : d.sizing.mode === 'strategy' ? 0.1 : 1} decimals={d.sizing.mode === 'fixedQty' ? 6 : 2} suffix={d.sizing.mode === 'percentEquity' ? '%' : d.sizing.mode === 'fixedUsd' ? 'USDT' : d.sizing.mode === 'fixedQty' ? base : '×'} style={{ width: 150 }} />
          </div>
          <div className="faint small">{sizingText(d.sizing, base, futures, leverage)}</div>
          <div className="bs-title" style={{ marginTop: 10 }}>
            Start
          </div>
          <Segmented
            value={d.startMode || 'next'}
            onChange={(m) => patch({ startMode: m })}
            options={[
              { value: 'next', label: 'Next signal', title: 'Start flat and act on the first signal after the start' },
              { value: 'join', label: 'Join current position', title: "Take the strategy's current position right away" },
            ]}
          />
          <div className="faint small">{d.startMode === 'join' ? 'Runs the strategy over the loaded history and immediately takes its current position, if it has one.' : 'Starts flat and acts on the first signal after the start.'}</div>
          <label className="set-row" style={{ marginTop: 8 }}>
            <span>Resume automatically when the app starts</span>
            <Toggle value={d.autostart} onChange={(val) => patch({ autostart: val })} />
          </label>
          <label className="set-row">
            <span data-tip="Bars before the start that warm up the strategy's indicators">Warm-up bars</span>
            <NumberField value={d.warmupBars ?? 1000} onChange={(val) => patch({ warmupBars: Math.max(0, Math.min(20000, Math.round(val))) })} min={0} step={100} decimals={0} style={{ width: 110 }} />
          </label>
          <div className="bs-title" style={{ marginTop: 10 }} data-tip="When a guard trips, the bot cancels its orders, closes its position and pauses. Empty = off.">
            Risk guards
          </div>
          <label className="set-row">
            <span>Pause at a drawdown from the peak of</span>
            <NumberField value={d.guards?.maxDrawdownPct ?? null} onChange={(val) => patch({ guards: { ...d.guards, maxDrawdownPct: val > 0 ? val : undefined } })} min={0} step={1} suffix="%" placeholder="off" style={{ width: 110 }} />
          </label>
          <label className="set-row">
            <span>Pause at a daily loss of</span>
            <NumberField value={d.guards?.maxDailyLossPct ?? null} onChange={(val) => patch({ guards: { ...d.guards, maxDailyLossPct: val > 0 ? val : undefined } })} min={0} step={0.5} suffix="%" placeholder="off" style={{ width: 110 }} />
          </label>
          <label className="set-row">
            <span>Pause after losing trades in a row</span>
            <NumberField value={d.guards?.maxConsecutiveLosses ?? null} onChange={(val) => patch({ guards: { ...d.guards, maxConsecutiveLosses: val > 0 ? Math.round(val) : undefined } })} min={0} step={1} decimals={0} placeholder="off" style={{ width: 110 }} />
          </label>
        </div>
      </div>
      <div className="row bot-setup-foot">
        <span className="faint small">The bot evaluates the strategy when each bar closes and mirrors its orders on this account. Manual trading is locked while it runs.</span>
        <span className="spacer" />
        <button
          className="btn ghost"
          disabled={!d.scriptId}
          onClick={() => void openModule('backtest', { scriptId: d.scriptId, inputs: d.params || {}, symbol: d.symbol, market: v.market, tf: d.tf, chartType: d.chartType, runId: null, autorun: Date.now() })}
          data-tip="Run this setup in the Strategy Tester first"
        >
          <Icon name="flask" size={14} /> Backtest
        </button>
        <button className="btn" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
        <button className="btn primary" disabled={!d.scriptId || saving || !!notStrategy || (analysis !== null && !analysis.ok)} onClick={() => void start()}>
          <Icon name="play" size={14} /> Start bot
        </button>
      </div>
    </div>
  );
}

function Activity({ id, version }: { id: string; version: number }) {
  const [events, setEvents] = useState<AccountEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .call<{ events: AccountEvent[] }>('trading:history', id)
        .then((h) => alive && setEvents(h.events))
        .catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, version]);
  if (!events) return <div className="empty"><Spinner /></div>;
  return <Events events={events} />;
}

function BotTrades({ id, since }: { id: string; since?: number }) {
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .call<{ trades: ClosedTrade[] }>('trading:history', id)
        .then((h) => alive && setTrades(h.trades))
        .catch(() => {});
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  if (!trades) return <div className="empty"><Spinner /></div>;
  return (
    <>
      {since ? <div className="faint small" style={{ padding: '6px 12px 0' }}>All trades of this account; the current run started {fmtDateTime(since)}.</div> : null}
      <Trades trades={trades} />
    </>
  );
}

function Signals({ v }: { v: BotView }) {
  const s = v.sim;
  const c = v.config;
  if (!s || !c) return <Empty icon="zap" title="No evaluation yet">The strategy’s signals appear after the first evaluation.</Empty>;
  const base = SYMBOL_SPECS[c.symbol].base;
  const fills = s.fills.slice().reverse();
  const trades = s.trades.slice().reverse();
  return (
    <div className="bot-signals">
      <div className="bot-sub">Resting strategy orders</div>
      {s.pending.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Kind</th>
              <th className="r">Size (strategy)</th>
              <th className="r">Limit / TP</th>
              <th className="r">Stop / SL</th>
            </tr>
          </thead>
          <tbody>
            {s.pending.map((p) => (
              <tr key={p.id + p.kind}>
                <td>
                  <b>{p.id}</b> {p.comment && <span className="faint">{p.comment}</span>}
                </td>
                <td>
                  <span className={p.side === 1 ? 'up' : 'down'}>{p.side === 1 ? 'buy' : 'sell'}</span> {p.kind}
                  {p.trailing ? ' · trailing' : ''}
                </td>
                <td className="r">{p.closeAll ? 'whole position' : fmtNum(p.closeQty + p.openQty, 6)}</td>
                <td className="r">{p.limit !== undefined ? fmtNum(p.limit, 2) : '—'}</td>
                <td className="r">{p.stop !== undefined ? fmtNum(p.stop, 2) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint small" style={{ padding: '2px 12px 8px' }}>
          None — the strategy has no limit, stop or exit orders resting.
        </div>
      )}
      <div className="bot-sub">Strategy fills since the start</div>
      {fills.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Signal</th>
              <th className="r">Size (strategy)</th>
              <th className="r">Price</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f, k) => (
              <tr key={k}>
                <td className="faint">{fmtDateTime(f.t)}</td>
                <td>
                  <span className={f.side === 'buy' ? 'up' : 'down'}>{f.side}</span> · {f.kind} <b>{f.id}</b>
                </td>
                <td className="r">
                  {fmtNum(f.qty, 6)} {base}
                </td>
                <td className="r">{fmtNum(f.price, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint small" style={{ padding: '2px 12px 8px' }}>
          No signals since the start yet.
        </div>
      )}
      {trades.length > 0 && (
        <>
          <div className="bot-sub">Strategy trades since the start (simulated)</div>
          <table className="table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Trade</th>
                <th className="r">Entry → Exit</th>
                <th className="r">Return</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, k) => (
                <tr key={k}>
                  <td className="faint">{fmtDateTime(t.exitTime)}</td>
                  <td>
                    <span className={t.dir === 1 ? 'up' : 'down'}>{t.dir === 1 ? 'Long' : 'Short'}</span> {t.entryId} → {t.exitId}
                  </td>
                  <td className="r">
                    {fmtNum(t.entryPrice, 2)} → {fmtNum(t.exitPrice, 2)}
                  </td>
                  <td className={clsx('r', t.returnPct >= 0 ? 'up' : 'down')}>{fmtPct(t.returnPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="faint">{k}</span>
      <span className="num">{children}</span>
    </div>
  );
}

function StateView({ v }: { v: BotView }) {
  const s = v.sim;
  const p = v.lastPlan;
  if (!s) return <Empty icon="target" title="No evaluation yet">The strategy’s state appears after the first evaluation.</Empty>;
  return (
    <div className="bot-state">
      <div className="bot-card">
        <div className="bs-title">Indicators on the last closed bar</div>
        {s.values.length ? (
          s.values.map((x) => {
            const ch = x.value - x.prev;
            return (
              <div key={x.title} className="kv">
                <span className="row" style={{ gap: 6 }}>
                  <span className="dot" style={{ background: x.color }} />
                  {x.title}
                </span>
                <span className="num">
                  {isFinite(x.value) ? fmtNum(x.value, Math.abs(x.value) >= 100 ? 2 : 4) : 'n/a'}
                  {isFinite(ch) && ch !== 0 && <span className={ch > 0 ? 'up' : 'down'}> {ch > 0 ? '▲' : '▼'}</span>}
                </span>
              </div>
            );
          })
        ) : (
          <div className="faint small">The strategy plots no values.</div>
        )}
        <div className="faint small" style={{ marginTop: 6 }}>
          Bar of {fmtDateTime(s.lastBarTime)} · close {fmtNum(s.lastClose, 2)}
        </div>
      </div>
      <div className="bot-card">
        <div className="bs-title">Strategy simulation since the start</div>
        <KV k="Position">{s.position ? `${s.position > 0 ? 'Long' : 'Short'} ${fmtNum(Math.abs(s.position), 6)} @ ${fmtNum(s.avgPrice, 2)}` : 'Flat'}</KV>
        <KV k="Equity">{fmtUsd(s.equity)}</KV>
        <KV k="Net profit (closed)">
          <span className={s.netProfit >= 0 ? 'up' : 'down'}>{fmtSignedUsd(s.netProfit)}</span>
        </KV>
        <KV k="Open profit">
          <span className={s.openProfit >= 0 ? 'up' : 'down'}>{fmtSignedUsd(s.openProfit)}</span>
        </KV>
        <KV k="Fees">{fmtUsd(s.feesPaid)}</KV>
        <KV k="Capital">{fmtUsd(s.initialCapital)}</KV>
      </div>
      {p && (
        <div className="bot-card">
          <div className="bs-title">Last decision · {fmtDateTime(p.t, true)}</div>
          <KV k="Account position before">{fmtNum(p.actual, 6)}</KV>
          <KV k="Target">{fmtNum(p.target, 6)}</KV>
          <KV k="Scale (account / strategy)">{p.scale !== null ? `${fmtNum(p.scale, 4)}×` : '—'}</KV>
          {p.holding && <div className="bot-warn small">Holding: the position was reduced outside the strategy. The bot will not re-enter until the strategy’s position changes.</div>}
          <div className="bot-actions">
            {p.actions.length ? p.actions.map((x, k) => <div key={k}>• {x}</div>) : <div className="faint">No change needed.</div>}
            {p.notes.map((x, k) => (
              <div key={`n${k}`} className="warn-text">
                • {x}
              </div>
            ))}
          </div>
        </div>
      )}
      {s.warnings.length > 0 && (
        <div className="bot-card">
          <div className="bs-title">Warnings</div>
          {s.warnings.map((w, k) => (
            <div key={k} className="small warn-text">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Logs({ v }: { v: BotView }) {
  const s = v.sim;
  if (!s || (!s.logs.length && !s.alerts.length)) return <Empty icon="log" title="No log output">Messages from log.info() (Pine) or print() / log() (Python) since the start appear here.</Empty>;
  const rows = [...s.logs.map((l) => ({ t: l.time, level: l.level, msg: l.msg })), ...s.alerts.map((a) => ({ t: a.time, level: 'alert', msg: a.message }))].sort((a, b) => b.t - a.t);
  return (
    <div style={{ padding: '4px 10px' }}>
      {rows.map((r, k) => (
        <div key={k} className="row selectable" style={{ alignItems: 'flex-start', padding: '3px 0', fontSize: 12 }}>
          <span className="faint num" style={{ width: 130, flex: 'none' }}>
            {r.t ? fmtDateTime(r.t, true) : ''}
          </span>
          <span className={clsx('log-level', r.level)}>{r.level}</span>
          <span style={{ lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{r.msg}</span>
        </div>
      ))}
    </div>
  );
}
