/**
 * Strategy Tester: configure and run backtests in the background (progress, cancel), then
 * explore the results — KPIs vs buy & hold and cash, equity and drawdown curves, the full
 * performance summary (all/long/short), trades (click to show on the chart), monthly and
 * yearly returns, market regimes, fee sensitivity, data/fill assumptions — plus run history
 * and side-by-side comparison.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { Icon } from '../../components/Icon';
import { Menu, usePopover, Popover, SymbolPicker, TimeframePicker, NumberField, Select, Toggle, Tabs, Spinner, Empty, Segmented, promptDialog, confirmDialog } from '../../components/ui';
import { LineChart } from '../../components/LineChart';
import { clsx, fmtNum, fmtPct, fmtUsd, fmtSignedUsd, fmtDateTime, fmtDate, MONTHS, fmtDuration } from '../../lib/format';
import { bus } from '../../lib/bus';
import { useScripts, openScriptInEditor, type AnalyzeResult } from '../scripts/client';
import { InputControl } from '../chart/indicators';
import { COST_PRESETS } from '../../../shared/trading/presets';
import { SYMBOL_SPECS, type Market, type SymbolId } from '../../../shared/symbols';
import { newId, type ChartModuleConfig, type IndicatorInstance } from '../../../shared/workspace';
import type { BacktestRecord, BacktestRequest } from '../../../main/backtest/service';
import type { TradeStats } from '../../../engine/backtest/metrics';
import { lastChartId } from '../scripts/focus';
import { type TesterCfg, type RangePreset, type RunSummary, rangeOf, buildRequest, TesterSettings } from './common';
import { RandomView, GreeksView } from './benchmarkViews';
import { openCreateAccount } from '../trading/accounts';
import { openModule } from '../../app/moduleOps';
import './backtest.css';

function pf(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : '∞';
}

function signCls(v: number): string {
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

export function StrategyTesterModule({ module }: ModuleProps) {
  const cfg = module.config as TesterCfg;
  const setCfg = (patch: Partial<TesterCfg>) => useApp.getState().setModuleConfig(module.id, patch);
  const scripts = useScripts();
  const strategies = useMemo(() => (scripts || []).filter((s) => s.kind === 'strategy'), [scripts]);
  const [running, setRunning] = useState<{ phase: string; done?: number; total?: number; message?: string } | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const [rec, setRec] = useState<BacktestRecord | null>(null);
  const [loadingRec, setLoadingRec] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const settings = usePopover();
  const inputsPop = usePopover();
  const historyPop = usePopover();
  const [compare, setCompare] = useState<string[]>([]);
  const tab = cfg.tab || 'overview';
  const script = strategies.find((s) => s.id === cfg.scriptId) || null;

  // default script: the built-in MA crossover (simple, robust), else the first strategy
  useEffect(() => {
    if (!cfg.scriptId && strategies.length) setCfg({ scriptId: (strategies.find((s) => s.id === 'builtin:strat_ma_cross') || strategies[0]).id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies.length]);

  // inputs of the selected script
  useEffect(() => {
    setAnalysis(null);
    if (!cfg.scriptId) return;
    let alive = true;
    void api
      .call('scripts:get', cfg.scriptId)
      .then((d: any) => api.call<AnalyzeResult>('scripts:analyze', d.language, d.code, { symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: 'candles' }))
      .then((a) => alive && setAnalysis(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cfg.scriptId, cfg.symbol, cfg.market, cfg.tf]);

  // displayed run
  useEffect(() => {
    if (!cfg.runId) {
      setRec(null);
      return;
    }
    if (rec?.id === cfg.runId) return;
    setLoadingRec(true);
    void api
      .call<BacktestRecord>('backtests:get', cfg.runId)
      .then((r) => setRec(r))
      .catch(() => setRec(null))
      .finally(() => setLoadingRec(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.runId]);

  useEffect(() => {
    const t = rec ? `Tester · ${rec.script.name}` : 'Strategy Tester';
    if (cfg.title !== t) setCfg({ title: t });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id]);

  const run = () => {
    if (!cfg.scriptId) {
      toast({ title: 'Choose a strategy first', kind: 'warn' });
      return;
    }
    cancelRef.current?.();
    const req: BacktestRequest = buildRequest(cfg);
    setError(null);
    setRunning({ phase: 'Starting' });
    const unsub = api.sub<any>('backtest', req, (m) => {
      if (m.__error) {
        setError(m.__error);
        setRunning(null);
        unsub();
      } else if (m.type === 'progress') setRunning({ phase: m.phase, done: m.done, total: m.total, message: m.message });
      else if (m.type === 'done') {
        setRunning(null);
        setRec(m.record);
        setCfg({ runId: m.record.id });
        unsub();
        cancelRef.current = null;
      } else if (m.type === 'error') {
        setRunning(null);
        setError(m.message);
        unsub();
        cancelRef.current = null;
      }
    });
    cancelRef.current = () => {
      unsub();
      setRunning(null);
    };
  };

  // external "run now" requests (editor / legend)
  // a fresh request (module just opened for it) runs once; a stale value from a saved layout does not
  const lastAuto = useRef(cfg.autorun && Date.now() - cfg.autorun < 15000 ? 0 : cfg.autorun || 0);
  useEffect(() => {
    if (cfg.autorun && cfg.autorun !== lastAuto.current) {
      lastAuto.current = cfg.autorun;
      setTimeout(run, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.autorun, scripts]);
  useEffect(() => () => cancelRef.current?.(), []);

  const addToChart = () => {
    if (!cfg.scriptId) return;
    const ws = useApp.getState().workspace;
    const id = lastChartId() || Object.values(ws?.modules || {}).find((m) => m.type === 'chart')?.id;
    const m = id ? ws?.modules[id] : null;
    if (!m) {
      toast({ title: 'No chart open', kind: 'warn' });
      return;
    }
    const c = m.config as ChartModuleConfig;
    useApp.getState().setModuleConfig(m.id, { indicators: [...(c.indicators || []), { id: newId('i'), scriptId: cfg.scriptId, inputs: cfg.inputs || {}, visible: true } as IndicatorInstance], symbol: cfg.symbol, market: cfg.market, tf: cfg.tf });
    toast({ title: 'Strategy added to the chart', body: `${cfg.symbol} ${cfg.tf}`, kind: 'ok' });
  };

  const r = rangeOf(cfg);
  return (
    <div className="tester">
      <HeadControls>
        {running ? (
          <button className="btn small" onClick={() => cancelRef.current?.()}>
            <Icon name="stop" size={13} /> Cancel
          </button>
        ) : (
          <button className="btn small primary" onClick={run} disabled={!cfg.scriptId} data-tip="Run backtest">
            <Icon name="play" size={13} /> Run
          </button>
        )}
        <button className="icon-btn" onClick={(e) => historyPop.toggle(e.currentTarget)} data-tip="Run history & compare">
          <Icon name="history" />
        </button>
      </HeadControls>
      <div className="mod-toolbar tester-bar">
        <Select value={cfg.scriptId || ''} options={[{ value: '', label: strategies.length ? 'Choose strategy…' : 'No strategies' }, ...strategies.map((s) => ({ value: s.id, label: `${s.name}${s.language === 'python' ? ' (Py)' : ''}` }))]} onChange={(v) => setCfg({ scriptId: v || null, inputs: {} })} style={{ maxWidth: 240 }} title="Strategy" />
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, m) => setCfg({ symbol: s, market: m })} />
        <TimeframePicker tf={cfg.tf} onChange={(tf) => setCfg({ tf })} />
        <Segmented size="sm" value={(cfg.range?.preset || '1Y') as RangePreset} options={(['1M', '3M', '6M', '1Y', '2Y', '5Y', 'custom'] as RangePreset[]).map((p) => ({ value: p, label: p === 'custom' ? 'Custom' : p }))} onChange={(p) => (p === 'custom' ? settings.open(document.querySelector(`[data-tester-settings="${module.id}"]`)) : setCfg({ range: { preset: p } }))} />
        <button className="icon-btn" onClick={(e) => inputsPop.toggle(e.currentTarget)} data-tip="Strategy inputs" disabled={!analysis?.inputs.length}>
          <Icon name="sliders" />
        </button>
        <button className="icon-btn" data-tester-settings={module.id} onClick={(e) => settings.toggle(e.currentTarget)} data-tip="Backtest settings: capital, costs, fills">
          <Icon name="gear" />
        </button>
        <span className="muted small">
          {fmtDate(r.from)} → {fmtDate(r.to)}
        </span>
      </div>
      {settings.anchor && (
        <Popover anchor={settings.anchor} onClose={settings.close} width={380} align="end">
          <TesterSettings cfg={cfg} setCfg={setCfg} />
        </Popover>
      )}
      {inputsPop.anchor && analysis && (
        <Popover anchor={inputsPop.anchor} onClose={inputsPop.close} width={360}>
          <div className="pop-pad">
            <div className="set-group-title">Inputs · {analysis.meta?.title}</div>
            {analysis.inputs.map((d) => (
              <label key={d.key} className="set-row" data-tip={d.tooltip}>
                <span>{d.title}</span>
                <InputControl def={d} value={cfg.inputs?.[d.key]} onChange={(v) => setCfg({ inputs: { ...(cfg.inputs || {}), [d.key]: v } })} />
              </label>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn small ghost" onClick={() => setCfg({ inputs: {} })}>
                Defaults
              </button>
            </div>
          </div>
        </Popover>
      )}
      {historyPop.anchor && (
        <Popover anchor={historyPop.anchor} onClose={historyPop.close} width={520} align="end">
          <RunHistory
            current={cfg.runId || null}
            compare={compare}
            setCompare={setCompare}
            onOpen={(id) => {
              setCfg({ runId: id, tab: 'overview' });
              historyPop.close();
            }}
            onCompare={() => {
              setCfg({ tab: 'compare' });
              historyPop.close();
            }}
          />
        </Popover>
      )}
      <div className="tester-body">
        {running && (
          <div className="tester-progress">
            <Spinner size={16} />
            <div>
              <div className="tp-phase">{running.phase}…</div>
              {running.message && <div className="muted small">{running.message}</div>}
              {running.total ? (
                <div className="progress" style={{ width: 260 }}>
                  <div style={{ width: `${Math.round(((running.done || 0) / running.total) * 100)}%` }} />
                </div>
              ) : null}
            </div>
          </div>
        )}
        {error && !running && (
          <div className="callout danger" style={{ margin: 12 }}>
            <Icon name="alert" size={14} /> {error}
          </div>
        )}
        {!rec && !running && !error && !loadingRec && (
          <Empty icon="flask" title="Strategy Tester">
            {script ? (
              <>
                Backtest <b>{script.name}</b> on {SYMBOL_SPECS[cfg.symbol].base}
                {cfg.market === 'futures' ? ' perpetual' : ''} {cfg.tf} from {fmtDate(r.from)} to {fmtDate(r.to)}. History is downloaded once and cached; there is no bar limit.
                <div style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={run}>
                    <Icon name="play" size={14} /> Run backtest
                  </button>
                </div>
              </>
            ) : (
              <>Create a strategy in the Script Editor (Pine strategy() or Python @strategy) or pick a built-in one above.</>
            )}
          </Empty>
        )}
        {loadingRec && <Spinner />}
        {rec && tab !== 'compare' && <Results rec={rec} tab={tab} setTab={(t) => setCfg({ tab: t })} onAddToChart={addToChart} onRerun={run} />}
        {tab === 'compare' && <Compare ids={compare} onClose={() => setCfg({ tab: 'overview' })} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ results

function Kpi({ label, value, sub, cls, tip, onClick }: { label: string; value: string; sub?: string; cls?: string; tip?: string; onClick?: () => void }) {
  return (
    <div className={clsx('kpi', onClick && 'clickable')} data-tip={tip} onClick={onClick}>
      <div className="kpi-label">{label}</div>
      <div className={clsx('kpi-value', cls)}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function Results({ rec, tab, setTab, onAddToChart, onRerun }: { rec: BacktestRecord; tab: string; setTab: (t: string) => void; onAddToChart: () => void; onRerun: () => void }) {
  const m = rec.metrics;
  const menu = usePopover();
  if (!rec.ok || !m)
    return (
      <div className="pad">
        <div className="callout danger">
          <Icon name="alert" size={14} /> {rec.error || 'The backtest failed.'}
        </div>
        <button className="btn small" style={{ marginTop: 10 }} onClick={() => void openScriptInEditor(rec.script.id)}>
          <Icon name="code" size={13} /> Open script
        </button>
      </div>
    );
  return (
    <div className="results">
      <div className="results-head">
        <div className="rh-title">
          <b>{rec.label}</b>
          <span className="muted small">
            {fmtDate(m.start)} – {fmtDate(m.end)} · {m.bars.toLocaleString()} bars · ran {fmtDateTime(rec.created)} in {fmtDuration(rec.info.ms)}
          </span>
        </div>
        <div className="spacer" />
        <button className="btn small ghost" onClick={onAddToChart} data-tip="Show the strategy and its trades on the chart">
          <Icon name="chart" size={13} /> On chart
        </button>
        <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)}>
          <Icon name="more" />
        </button>
        {menu.anchor && (
          <Menu
            anchor={menu.anchor}
            onClose={menu.close}
            align="end"
            items={[
              { label: 'Run again', icon: 'refresh', onClick: onRerun },
              {
                label: 'Ask AI to assess…',
                icon: 'spark',
                onClick: () =>
                  bus.emit(
                    'ai:open',
                    {
                      prompt: `Assess my backtest “${rec.label}” (record ${rec.id}): is the edge real or luck? Look at the comparison with random twins, the Greeks and how it holds up in a robustness test, then suggest concrete improvements.`,
                      context: { chart: { symbol: rec.request.symbol, market: rec.request.market, tf: rec.request.tf }, ...(rec.script.id ? { script: { id: rec.script.id, name: rec.script.name, language: rec.script.language } } : {}) },
                      mode: 'plan',
                      send: true,
                    },
                    false,
                  ),
              },
              {
                label: 'Run as paper bot…',
                icon: 'bot',
                disabled: !rec.script.id,
                onClick: () =>
                  openCreateAccount((id) => void openModule('bots', { botId: id }), {
                    kind: 'bot',
                    market: rec.request.market,
                    name: `${rec.script.name} bot`,
                    bot: { scriptId: rec.script.id!, scriptName: rec.script.name, language: rec.script.language, params: rec.request.inputs || {}, symbol: rec.request.symbol, market: rec.request.market, tf: rec.request.tf, chartType: rec.request.chartType === 'heikinashi' ? 'heikinashi' : 'candles' },
                  }),
              },
              { label: 'Open script', icon: 'code', onClick: () => void openScriptInEditor(rec.script.id) },
              { label: 'Export trades (CSV)', icon: 'download', onClick: () => exportCsv(rec) },
              {
                label: 'Save parameters as set…',
                icon: 'save',
                disabled: !rec.script.id,
                onClick: () =>
                  void promptDialog({ title: 'Save parameter set', label: 'Name', initial: rec.label }).then((name) => {
                    if (!name) return;
                    void api
                      .call('paramsets:save', { scriptId: rec.script.id, scriptName: rec.script.name, name, inputs: rec.request.inputs || {}, source: { kind: 'backtest', id: rec.id }, context: { symbol: rec.request.symbol, market: rec.request.market, tf: rec.request.tf } })
                      .then(() => toast({ title: 'Parameter set saved', kind: 'ok' }));
                  }),
              },
              {
                label: 'Rename run…',
                icon: 'edit',
                onClick: () =>
                  void promptDialog({ title: 'Rename run', initial: rec.label }).then((l) => {
                    if (l) void api.call('backtests:rename', rec.id, l);
                  }),
              },
            ]}
          />
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'performance', label: 'Performance' },
          { value: 'trades', label: 'Trades', badge: <span className="badge">{m.all.trades}</span> },
          { value: 'monthly', label: 'Returns' },
          { value: 'analysis', label: 'Analysis' },
          { value: 'random', label: 'vs Random' },
          { value: 'greeks', label: 'Greeks' },
          { value: 'info', label: 'Assumptions' },
        ]}
      />
      <div className="results-body">
        {tab === 'overview' && <Overview rec={rec} setTab={setTab} />}
        {tab === 'performance' && <Performance rec={rec} />}
        {tab === 'trades' && <Trades rec={rec} />}
        {tab === 'monthly' && <Monthly rec={rec} />}
        {tab === 'analysis' && <Analysis rec={rec} />}
        {tab === 'random' && <RandomView rec={rec} onRerun={onRerun} />}
        {tab === 'greeks' && <GreeksView rec={rec} />}
        {tab === 'info' && <Info rec={rec} />}
      </div>
    </div>
  );
}

function Overview({ rec, setTab }: { rec: BacktestRecord; setTab: (t: string) => void }) {
  const m = rec.metrics!;
  const rnd = rec.random;
  const g = m.greeks;
  const c = rec.curves!;
  const vsBh = m.netProfitPct - m.buyHold.returnPct;
  const [mode, setMode] = useState<'equity' | 'pct'>('equity');
  const eqPct = useMemo(() => c.equity.map((v) => (v / m.initialCapital - 1) * 100), [c, m.initialCapital]);
  const bhPct = useMemo(() => c.buyHold.map((v) => (v / m.initialCapital - 1) * 100), [c, m.initialCapital]);
  return (
    <div className="overview">
      <div className="kpis">
        <Kpi label="Net profit" value={fmtSignedUsd(m.netProfit)} sub={fmtPct(m.netProfitPct)} cls={signCls(m.netProfit)} tip="Sum of closed trades (after fees, funding)" />
        <Kpi label="Max drawdown" value={fmtPct(-m.maxDrawdownPct)} sub={fmtUsd(m.maxDrawdown)} cls="down" tip="Largest peak-to-trough decline of bar-close equity" />
        <Kpi label="Profit factor" value={pf(m.all.profitFactor)} sub={`${m.all.trades} trades`} />
        <Kpi label="Win rate" value={fmtPct(m.all.winRate * 100, 1, false)} sub={`${m.all.wins} W / ${m.all.losses} L`} />
        <Kpi label="Sharpe" value={m.sharpe.toFixed(2)} sub={`Sortino ${m.sortino.toFixed(2)}`} tip="Annualised from daily equity returns" />
        <Kpi label="vs Buy & hold" value={fmtPct(vsBh)} sub={`B&H ${fmtPct(m.buyHold.returnPct)}`} cls={signCls(vsBh)} tip={`Buy & hold max drawdown ${fmtPct(-m.buyHold.maxDrawdownPct)}`} />
        <Kpi label="CAGR" value={fmtPct(m.cagr)} sub={`Calmar ${m.calmar.toFixed(2)}`} cls={signCls(m.cagr)} tip={m.days < 365 ? `Annualised from ${Math.round(m.days)} days — short tests extrapolate strongly` : 'Compound annual growth rate'} />
        <Kpi label="Exposure" value={fmtPct(m.exposure, 1, false)} sub={`Avg ${fmtNum(m.all.avgBarsInTrade, 1)} bars/trade`} />
        {rnd && (
          <Kpi
            label="vs Random"
            value={`beats ${rnd.timing.beats.returnPct.toFixed(0)}%`}
            sub={`p = ${rnd.timing.pReturn.toFixed(3)} · ${rnd.iterations.toLocaleString('en-US')} twins`}
            cls={rnd.verdict.level === 'strong' || rnd.verdict.level === 'likely' ? 'up' : rnd.verdict.level === 'worse' ? 'down' : ''}
            tip={`${rnd.verdict.title}: share of random strategies with the same trades at random times that the strategy beats`}
            onClick={() => setTab('random')}
          />
        )}
        {g && (
          <Kpi
            label="Alpha · Beta"
            value={`${fmtPct(g.alpha, 1)}/yr`}
            sub={`β ${g.beta.toFixed(2)} · ρ ${g.correlation.toFixed(2)}`}
            cls={signCls(g.alpha)}
            tip="Annualised alpha and beta against buy & hold of the same coin (see Greeks)"
            onClick={() => setTab('greeks')}
          />
        )}
      </div>
      {rec.warnings.length > 0 && (
        <div className="callout warn">
          {rec.warnings.slice(0, 4).map((w, k) => (
            <div key={k}>
              <Icon name="alert" size={13} /> {w}
            </div>
          ))}
        </div>
      )}
      <div className="chart-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="section-title">Equity vs buy & hold</div>
          <Segmented size="sm" value={mode} options={[{ value: 'equity', label: 'USDT' }, { value: 'pct', label: '%' }]} onChange={setMode} />
        </div>
        <LineChart t={c.t} height={240} format={(v) => (mode === 'pct' ? `${v.toFixed(1)}%` : fmtNum(v, 0))} series={[{ values: mode === 'pct' ? bhPct : c.buyHold, color: '#8b93a3', label: 'Buy & hold', dashed: true, width: 1.2 }, { values: mode === 'pct' ? eqPct : c.equity, color: '#3b82f6', label: 'Strategy', area: true, width: 1.8 }]} zeroLine={mode === 'pct'} onPick={(t) => bus.emit('chart:showTime', { time: t, symbol: rec.request.symbol, market: rec.request.market })} />
      </div>
      <div className="chart-card">
        <div className="section-title">Drawdown</div>
        <LineChart t={c.t} height={120} format={(v) => `${v.toFixed(1)}%`} maxY={0} series={[{ values: c.drawdownPct.map((x) => x * 100), color: '#ef4444', label: 'Drawdown', area: true, width: 1.2 }]} />
      </div>
    </div>
  );
}

const STAT_ROWS: { key: keyof TradeStats; label: string; fmt: (v: number) => string }[] = [
  { key: 'netProfit', label: 'Net profit', fmt: (v) => fmtSignedUsd(v) },
  { key: 'grossProfit', label: 'Gross profit', fmt: (v) => fmtUsd(v) },
  { key: 'grossLoss', label: 'Gross loss', fmt: (v) => fmtUsd(v) },
  { key: 'profitFactor', label: 'Profit factor', fmt: pf },
  { key: 'commission', label: 'Commission paid', fmt: (v) => fmtUsd(v) },
  { key: 'trades', label: 'Total closed trades', fmt: (v) => String(v) },
  { key: 'wins', label: 'Winning trades', fmt: (v) => String(v) },
  { key: 'losses', label: 'Losing trades', fmt: (v) => String(v) },
  { key: 'winRate', label: 'Percent profitable', fmt: (v) => fmtPct(v * 100, 2, false) },
  { key: 'avgTrade', label: 'Avg trade', fmt: (v) => fmtSignedUsd(v) },
  { key: 'avgTradePct', label: 'Avg trade %', fmt: (v) => fmtPct(v) },
  { key: 'avgWin', label: 'Avg winning trade', fmt: (v) => fmtUsd(v) },
  { key: 'avgLoss', label: 'Avg losing trade', fmt: (v) => fmtUsd(v) },
  { key: 'ratioAvgWinLoss', label: 'Ratio avg win / avg loss', fmt: pf },
  { key: 'largestWin', label: 'Largest winning trade', fmt: (v) => fmtUsd(v) },
  { key: 'largestLoss', label: 'Largest losing trade', fmt: (v) => fmtUsd(v) },
  { key: 'expectancy', label: 'Expectancy per trade', fmt: (v) => fmtSignedUsd(v) },
  { key: 'maxConsecWins', label: 'Max consecutive wins', fmt: (v) => String(v) },
  { key: 'maxConsecLosses', label: 'Max consecutive losses', fmt: (v) => String(v) },
  { key: 'avgBarsInTrade', label: 'Avg # bars in trades', fmt: (v) => fmtNum(v, 1) },
  { key: 'avgBarsWin', label: 'Avg # bars in winning trades', fmt: (v) => fmtNum(v, 1) },
  { key: 'avgBarsLoss', label: 'Avg # bars in losing trades', fmt: (v) => fmtNum(v, 1) },
];

function Performance({ rec }: { rec: BacktestRecord }) {
  const m = rec.metrics!;
  return (
    <div className="perf">
      <table className="table perf-table">
        <thead>
          <tr>
            <th />
            <th className="num">All</th>
            <th className="num">Long</th>
            <th className="num">Short</th>
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              {[m.all, m.long, m.short].map((s, k) => (
                <td key={k} className={clsx('num', (r.key === 'netProfit' || r.key === 'avgTrade' || r.key === 'expectancy') && signCls(s[r.key] as number))}>
                  {s.trades || r.key === 'trades' ? r.fmt(s[r.key] as number) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="table perf-table">
        <tbody>
          <tr>
            <td>Initial capital</td>
            <td className="num">{fmtUsd(m.initialCapital)}</td>
          </tr>
          <tr>
            <td>Final equity (incl. open P&L)</td>
            <td className="num">{fmtUsd(m.finalEquity)}</td>
          </tr>
          <tr>
            <td>Open P&L</td>
            <td className={clsx('num', signCls(m.openPnl))}>{fmtSignedUsd(m.openPnl)}</td>
          </tr>
          <tr>
            <td>Max drawdown</td>
            <td className="num down">
              {fmtUsd(m.maxDrawdown)} ({fmtPct(-m.maxDrawdownPct)})
            </td>
          </tr>
          <tr>
            <td>Longest drawdown</td>
            <td className="num">{m.maxDrawdownDuration.toLocaleString()} bars</td>
          </tr>
          <tr>
            <td>Max run-up</td>
            <td className="num up">
              {fmtUsd(m.maxRunup)} ({fmtPct(m.maxRunupPct)})
            </td>
          </tr>
          <tr>
            <td>Sharpe / Sortino / Calmar</td>
            <td className="num">
              {m.sharpe.toFixed(2)} / {m.sortino.toFixed(2)} / {m.calmar.toFixed(2)}
            </td>
          </tr>
          <tr>
            <td>Annualised volatility</td>
            <td className="num">{fmtPct(m.volatility, 1, false)}</td>
          </tr>
          <tr>
            <td>Fees / funding / borrow</td>
            <td className="num">
              {fmtUsd(m.feesPaid)} / {fmtSignedUsd(-m.fundingPaid)} / {fmtUsd(m.borrowPaid)}
            </td>
          </tr>
          <tr>
            <td>Liquidations</td>
            <td className={clsx('num', m.liquidations && 'down')}>{m.liquidations}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Trades({ rec }: { rec: BacktestRecord }) {
  const all = rec.trades;
  const [sort, setSort] = useState<'time' | 'pnl'>('time');
  const list = useMemo(() => (sort === 'pnl' ? [...all].sort((a, b) => b.profit - a.profit) : all), [all, sort]);
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const ROW = 26;
  const viewH = 600;
  const start = Math.max(0, Math.floor(scroll / ROW) - 10);
  const end = Math.min(list.length, start + Math.ceil(viewH / ROW) + 30);
  const pd = (v: number) => fmtNum(v, rec.request.market === 'futures' && rec.request.symbol === 'BTCUSDT' ? 1 : 2);
  return (
    <div className="trades">
      <div className="row" style={{ padding: '6px 10px', gap: 8 }}>
        <Segmented size="sm" value={sort} options={[{ value: 'time', label: 'By time' }, { value: 'pnl', label: 'By P&L' }]} onChange={setSort} />
        <span className="muted small">Click a trade to show it on the chart</span>
      </div>
      <div className="trades-scroll" ref={ref} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
        <table className="table trades-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Side</th>
              <th>Entry</th>
              <th className="num">Price</th>
              <th>Exit</th>
              <th className="num">Price</th>
              <th className="num">Qty</th>
              <th className="num">P&L</th>
              <th className="num">%</th>
              <th className="num">Cum. P&L</th>
            </tr>
          </thead>
          <tbody>
            {start > 0 && (
              <tr style={{ height: start * ROW }}>
                <td colSpan={10} />
              </tr>
            )}
            {list.slice(start, end).map((t, k) => (
              <tr key={start + k} style={{ height: ROW }} className="clickable" onClick={() => bus.emit('chart:showTrade', { symbol: rec.request.symbol, market: rec.request.market, from: t.entryTime, to: t.exitTime })}>
                <td className="muted">{all.indexOf(t) + 1}</td>
                <td className={t.dir === 1 ? 'up' : 'down'}>{t.dir === 1 ? 'Long' : 'Short'}</td>
                <td>
                  {fmtDateTime(t.entryTime)} <span className="muted small">{t.entryId}</span>
                </td>
                <td className="num">{pd(t.entryPrice)}</td>
                <td>
                  {fmtDateTime(t.exitTime)} <span className="muted small">{t.exitComment || t.exitId.replace(/^__\w+?_/, '')}</span>
                </td>
                <td className="num">{pd(t.exitPrice)}</td>
                <td className="num">{fmtNum(t.qty, 5, 0)}</td>
                <td className={clsx('num', signCls(t.profit))}>{fmtSignedUsd(t.profit)}</td>
                <td className={clsx('num', signCls(t.returnPct))}>{fmtPct(t.returnPct)}</td>
                <td className={clsx('num', signCls(t.cumProfit))}>{fmtSignedUsd(t.cumProfit)}</td>
              </tr>
            ))}
            {end < list.length && (
              <tr style={{ height: (list.length - end) * ROW }}>
                <td colSpan={10} />
              </tr>
            )}
          </tbody>
        </table>
        {!list.length && <Empty icon="list" title="No trades">The strategy did not close any trade in this range.</Empty>}
      </div>
    </div>
  );
}

function heat(v: number, scale: number): string {
  const a = Math.min(1, Math.abs(v) / scale) * 0.55 + 0.05;
  return v >= 0 ? `color-mix(in srgb, var(--up) ${Math.round(a * 100)}%, transparent)` : `color-mix(in srgb, var(--down) ${Math.round(a * 100)}%, transparent)`;
}

function Monthly({ rec }: { rec: BacktestRecord }) {
  const m = rec.metrics!;
  const years = [...new Set(m.monthly.map((x) => x.year))].sort();
  const scale = Math.max(1, ...m.monthly.map((x) => Math.abs(x.returnPct)));
  return (
    <div className="monthly">
      <table className="table monthly-table">
        <thead>
          <tr>
            <th>Year</th>
            {MONTHS.map((mm) => (
              <th key={mm} className="num">
                {mm}
              </th>
            ))}
            <th className="num">Year</th>
            <th className="num">B&H</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const yr = m.yearly.find((x) => x.year === y);
            return (
              <tr key={y}>
                <td>{y}</td>
                {MONTHS.map((_, k) => {
                  const cell = m.monthly.find((x) => x.year === y && x.month === k);
                  return (
                    <td key={k} className="num heat" style={cell ? { background: heat(cell.returnPct, scale) } : undefined}>
                      {cell ? fmtNum(cell.returnPct, 1) : ''}
                    </td>
                  );
                })}
                <td className={clsx('num', yr && signCls(yr.returnPct))}>
                  <b>{yr ? fmtPct(yr.returnPct, 1) : ''}</b>
                </td>
                <td className={clsx('num muted')}>{yr ? fmtPct(yr.buyHoldPct, 1) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Analysis({ rec }: { rec: BacktestRecord }) {
  const m = rec.metrics!;
  return (
    <div className="analysis">
      <div className="section-title">Benchmarks</div>
      <table className="table">
        <thead>
          <tr>
            <th />
            <th className="num">Return</th>
            <th className="num">Max drawdown</th>
            <th className="num">Sharpe</th>
            <th className="num">Final equity</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <b>Strategy</b>
            </td>
            <td className={clsx('num', signCls(m.netProfitPct))}>{fmtPct(((m.finalEquity - m.initialCapital) / m.initialCapital) * 100)}</td>
            <td className="num down">{fmtPct(-m.maxDrawdownPct)}</td>
            <td className="num">{m.sharpe.toFixed(2)}</td>
            <td className="num">{fmtUsd(m.finalEquity)}</td>
          </tr>
          <tr>
            <td>Buy & hold</td>
            <td className={clsx('num', signCls(m.buyHold.returnPct))}>{fmtPct(m.buyHold.returnPct)}</td>
            <td className="num down">{fmtPct(-m.buyHold.maxDrawdownPct)}</td>
            <td className="num">{m.buyHold.sharpe.toFixed(2)}</td>
            <td className="num">{fmtUsd(m.buyHold.finalEquity)}</td>
          </tr>
          <tr>
            <td>Cash ({fmtPct(m.cash.rateAnnual * 100, 2, false)} p.a.)</td>
            <td className="num">{fmtPct(m.cash.returnPct)}</td>
            <td className="num">0.00%</td>
            <td className="num">—</td>
            <td className="num">{fmtUsd(m.cash.finalEquity)}</td>
          </tr>
        </tbody>
      </table>
      <div className="section-title">Market regimes</div>
      <div className="muted small" style={{ marginBottom: 6 }}>
        Trend: close vs 200-bar SMA and its slope. Volatility: 50-bar realised volatility vs its median. Returns are compounded over the bars of each regime.
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Regime</th>
            <th className="num">Time</th>
            <th className="num">Strategy</th>
            <th className="num">Buy & hold</th>
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
          </tr>
        </thead>
        <tbody>
          {m.regimes.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{fmtPct(r.share * 100, 0, false)}</td>
              <td className={clsx('num', signCls(r.strategyReturnPct))}>{fmtPct(r.strategyReturnPct, 1)}</td>
              <td className={clsx('num', signCls(r.buyHoldReturnPct))}>{fmtPct(r.buyHoldReturnPct, 1)}</td>
              <td className="num">{r.trades}</td>
              <td className="num">{r.trades ? fmtPct(r.winRate * 100, 0, false) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">Fee sensitivity</div>
      {rec.feeSensitivity ? (
        <table className="table">
          <thead>
            <tr>
              <th>Fee per side</th>
              <th className="num">Net profit</th>
              <th className="num">Profit factor</th>
              <th className="num">Max drawdown</th>
              <th className="num">Trades</th>
              <th className="num">Sharpe</th>
            </tr>
          </thead>
          <tbody>
            {rec.feeSensitivity.map((r) => (
              <tr key={r.feePct}>
                <td>{fmtPct(r.feePct, 2, false)}</td>
                <td className={clsx('num', signCls(r.netProfitPct))}>{fmtPct(r.netProfitPct)}</td>
                <td className="num">{pf(r.profitFactor)}</td>
                <td className="num down">{fmtPct(-r.maxDrawdownPct)}</td>
                <td className="num">{r.trades}</td>
                <td className="num">{r.sharpe.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted small">Enable “Fee sensitivity” in the backtest settings to rerun with 0–0.2% fees per side.</div>
      )}
    </div>
  );
}

function Info({ rec }: { rec: BacktestRecord }) {
  const i = rec.info;
  const cfg = i.config as Record<string, any>;
  const rows: [string, string][] = [
    ['Data', i.source],
    ['Bars tested', `${i.bars.toLocaleString()} (+ ${i.warmup.toLocaleString()} warm-up bars that only feed indicators)`],
    ['Intrabar fills', i.fills],
    ['Market', `${rec.request.market === 'futures' ? 'USDⓈ-M perpetual' : 'Spot'}${cfg.leverage > 1 ? ` · ${cfg.leverage}x leverage` : ''}${cfg.marginMode ? ` · ${cfg.marginMode} margin` : ''}`],
    ['Fees', `maker ${fmtPct((cfg.makerFee || 0) * 100, 3, false)} · taker ${fmtPct((cfg.takerFee || 0) * 100, 3, false)}${cfg.flatFee ? ` · flat ${cfg.flatFee}` : ''}`],
    ['Slippage', `${cfg.slippageTicks || 0} ticks + ${cfg.slippageBps || 0} bps`],
    ['Limit fills', cfg.limitFill === 'touch' ? 'when price touches the limit' : 'when price trades through the limit'],
    ['Partial fills', cfg.partialFills ? `yes (max ${Math.round((cfg.participation || 0.25) * 100)}% of bar volume)` : 'no'],
    ['Funding', rec.request.market === 'futures' ? `${i.funding} historical funding events applied` : 'n/a (spot)'],
    ['Liquidations', rec.request.market === 'futures' ? (i.mark ? 'Binance formula with maintenance tiers, checked on mark-price bars' : 'Binance formula, checked on trade prices') : 'n/a (spot)'],
    ['Position sizing', cfg.defaultQty ? `${cfg.defaultQty.type} ${cfg.defaultQty.value}` : '—'],
    ['Pyramiding', String(cfg.pyramiding ?? 0)],
    ['Script', `${rec.script.name} (${rec.script.language === 'python' ? 'Python' : 'Pine Script'})`],
  ];
  return (
    <div className="info">
      <table className="table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted" style={{ width: 160 }}>
                {k}
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rec.warnings.length > 0 && (
        <>
          <div className="section-title">Warnings</div>
          {rec.warnings.map((w, k) => (
            <div key={k} className="callout warn" style={{ marginBottom: 6 }}>
              {w}
            </div>
          ))}
        </>
      )}
      {rec.logs.length > 0 && (
        <>
          <div className="section-title">Script log</div>
          <div className="console">
            {rec.logs.slice(-200).map((l, k) => (
              <div key={k} className={clsx('console-line', l.level)}>
                <span className="muted mono">{l.time ? fmtDateTime(l.time) : `bar ${l.bar}`}</span>
                <span className="mono">{l.msg}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function exportCsv(rec: BacktestRecord): void {
  const head = 'trade,side,entry_time,entry_price,exit_time,exit_price,qty,profit,return_pct,commission,entry_id,exit_id';
  const lines = rec.trades.map((t, k) => [k + 1, t.dir === 1 ? 'long' : 'short', new Date(t.entryTime).toISOString(), t.entryPrice, new Date(t.exitTime).toISOString(), t.exitPrice, t.qty, t.profit.toFixed(8), t.returnPct.toFixed(4), t.commission.toFixed(8), t.entryId, t.exitId].join(','));
  const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${rec.label.replace(/[^\w.-]+/g, '_')}_trades.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ history & compare

function useRuns(): RunSummary[] | null {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => {
    const load = () => void api.call<RunSummary[]>('backtests:list').then(setRuns).catch(() => setRuns([]));
    load();
    return api.on('backtests:changed', load);
  }, []);
  return runs;
}

function RunHistory({ current, compare, setCompare, onOpen, onCompare }: { current: string | null; compare: string[]; setCompare: (c: string[]) => void; onOpen: (id: string) => void; onCompare: () => void }) {
  const runs = useRuns();
  return (
    <div className="run-history">
      <div className="row" style={{ padding: '8px 10px', gap: 8 }}>
        <b>Run history</b>
        <div className="spacer" />
        <button className="btn small" disabled={compare.length < 2} onClick={onCompare}>
          Compare {compare.length || ''}
        </button>
      </div>
      <div className="rh-list">
        {!runs && <Spinner />}
        {runs && !runs.length && <div className="muted pad">No runs yet.</div>}
        {runs?.map((r) => (
          <div key={r.id} className={clsx('rh-row', r.id === current && 'on')} onClick={() => onOpen(r.id)}>
            <input
              type="checkbox"
              checked={compare.includes(r.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setCompare(e.target.checked ? [...compare, r.id] : compare.filter((x) => x !== r.id))}
            />
            <div className="rh-text">
              <div className="ellipsis">{r.label}</div>
              <div className="muted small">
                {fmtDateTime(r.created)} · {new Date(r.request.from).toISOString().slice(0, 10)} → {new Date(r.request.to).toISOString().slice(0, 10)}
              </div>
            </div>
            {r.summary ? (
              <div className="rh-stats">
                <span className={signCls(r.summary.netProfitPct)}>{fmtPct(r.summary.netProfitPct, 1)}</span>
                <span className="muted">DD {fmtPct(-r.summary.maxDrawdownPct, 1)}</span>
                <span className="muted">PF {pf(r.summary.profitFactor)}</span>
              </div>
            ) : (
              <span className="down small">failed</span>
            )}
            <button
              className="icon-btn small"
              onClick={(e) => {
                e.stopPropagation();
                void confirmDialog({ title: 'Delete this run?', body: r.label, confirm: 'Delete', danger: true }).then((ok) => ok && api.call('backtests:delete', r.id));
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const COMPARE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#a855f7', '#14b8a6'];

function Compare({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [recs, setRecs] = useState<BacktestRecord[] | null>(null);
  useEffect(() => {
    void Promise.all(ids.map((id) => api.call<BacktestRecord>('backtests:get', id).catch(() => null))).then((l) => setRecs(l.filter((x): x is BacktestRecord => !!x && !!x.metrics)));
  }, [ids.join(',')]);
  if (!recs) return <Spinner />;
  if (recs.length < 2) return <Empty icon="history" title="Select at least two successful runs to compare" />;
  // align on a common time grid: union of timestamps, forward-filled % returns
  const times = [...new Set(recs.flatMap((r) => r.curves!.t))].sort((a, b) => a - b);
  const series = recs.map((r, k) => {
    const out = new Array(times.length).fill(NaN);
    let j = 0;
    let last = NaN;
    for (let i = 0; i < times.length; i++) {
      while (j < r.curves!.t.length && r.curves!.t[j] <= times[i]) {
        last = (r.curves!.equity[j] / r.metrics!.initialCapital - 1) * 100;
        j++;
      }
      out[i] = times[i] >= r.curves!.t[0] ? last : NaN;
    }
    return { values: out, color: COMPARE_COLORS[k % COMPARE_COLORS.length], label: r.label };
  });
  const rows: [string, (r: BacktestRecord) => string][] = [
    ['Net profit', (r) => fmtPct(r.metrics!.netProfitPct)],
    ['Max drawdown', (r) => fmtPct(-r.metrics!.maxDrawdownPct)],
    ['Profit factor', (r) => pf(r.metrics!.all.profitFactor)],
    ['Win rate', (r) => fmtPct(r.metrics!.all.winRate * 100, 1, false)],
    ['Trades', (r) => String(r.metrics!.all.trades)],
    ['Sharpe', (r) => r.metrics!.sharpe.toFixed(2)],
    ['Sortino', (r) => r.metrics!.sortino.toFixed(2)],
    ['CAGR', (r) => fmtPct(r.metrics!.cagr)],
    ['Exposure', (r) => fmtPct(r.metrics!.exposure, 1, false)],
    ['Buy & hold', (r) => fmtPct(r.metrics!.buyHold.returnPct)],
    ['Alpha (per year)', (r) => (r.metrics!.greeks ? fmtPct(r.metrics!.greeks.alpha, 1) : '—')],
    ['Beta', (r) => (r.metrics!.greeks ? r.metrics!.greeks.beta.toFixed(2) : '—')],
    ['Beats random twins', (r) => (r.random ? `${r.random.timing.beats.returnPct.toFixed(0)}% (p ${r.random.timing.pReturn.toFixed(3)})` : '—')],
    ['Market / TF', (r) => `${r.request.symbol} ${r.request.market} ${r.request.tf}`],
    ['Inputs', (r) => JSON.stringify(r.request.inputs || {})],
  ];
  return (
    <div className="compare pad">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Comparison
        </div>
        <div className="spacer" />
        <button className="btn small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <LineChart t={times} height={260} format={(v) => `${v.toFixed(1)}%`} zeroLine series={series} />
      <table className="table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th />
            {recs.map((r, k) => (
              <th key={r.id} style={{ color: COMPARE_COLORS[k % COMPARE_COLORS.length] }}>
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <td className="muted">{label}</td>
              {recs.map((r) => (
                <td key={r.id} className="mono small">
                  {f(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
