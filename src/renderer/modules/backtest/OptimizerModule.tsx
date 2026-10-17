/**
 * Optimizer: choose parameters and ranges, a search method, an objective with constraints and
 * a validation scheme; runs in the background with live progress. Results: ranked table,
 * heatmap / 3-D surface of the parameter landscape, neighbourhood robustness, IS/OOS,
 * walk-forward and cross-validation reports, overfitting statistics and regime stability.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useApp, toast } from '../../state/store';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { Icon } from '../../components/Icon';
import { usePopover, Popover, SymbolPicker, TimeframePicker, NumberField, Select, Toggle, Tabs, Spinner, Empty, Segmented, confirmDialog, promptDialog } from '../../components/ui';
import { LineChart } from '../../components/LineChart';
import { Heatmap, Surface3D, type Grid2D } from '../../components/ParamPlots';
import { clsx, fmtNum, fmtPct, fmtDateTime, fmtDate, fmtDuration } from '../../lib/format';
import { useScripts, type AnalyzeResult } from '../scripts/client';
import { openModule } from '../../app/moduleOps';
import { newId, type ChartModuleConfig, type IndicatorInstance } from '../../../shared/workspace';
import { spaceFromInputs, gridSize, cardinality, valueAt, type ParamDef, type Point } from '../../../engine/optimize/space';
import { OBJECTIVES, type ObjectiveId, type TrialMetrics } from '../../../engine/optimize/analysis';
import type { OptimizeRequest, OptimizationRecord } from '../../../main/backtest/optimizer';
import { lastChartId } from '../scripts/focus';
import { type TesterCfg, type RangePreset, rangeOf, buildRequest, TesterSettings } from './common';
import './backtest.css';

interface OptCfg extends TesterCfg {
  space?: ParamDef[];
  method?: 'grid' | 'random' | 'bayes' | 'genetic';
  budget?: number;
  seed?: number;
  objective?: ObjectiveId;
  maxDd?: number | null;
  minTrades?: number | null;
  minPf?: number | null;
  secondary?: ('maxDrawdownPct' | 'trades' | ObjectiveId)[];
  validation?: OptimizeRequest['validation'];
  extras?: OptimizeRequest['extras'];
}

const METHODS = [
  { value: 'grid', label: 'Grid', title: 'Every combination (or an even sample if the grid is larger than the budget)' },
  { value: 'random', label: 'Random', title: 'Random unique combinations — good baseline for large spaces' },
  { value: 'bayes', label: 'Bayesian', title: 'Tree-structured Parzen estimator: learns where good results are' },
  { value: 'genetic', label: 'Genetic', title: 'Evolutionary search; uses Pareto ranking when secondary objectives are set' },
] as const;

function pf(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : '∞';
}

function fmtPoint(space: ParamDef[], p: Point | null, titles: Record<string, string>): string {
  if (!p) return '—';
  return space.map((d) => `${titles[d.key] || d.title || d.key}=${typeof p[d.key] === 'number' ? fmtNum(p[d.key] as number, Number.isInteger(p[d.key]) ? 0 : 3, 0) : String(p[d.key])}`).join(', ');
}

export function OptimizerModule({ module }: ModuleProps) {
  const cfg = module.config as OptCfg;
  const setCfg = (patch: Partial<OptCfg>) => useApp.getState().setModuleConfig(module.id, patch);
  const scripts = useScripts();
  const strategies = useMemo(() => (scripts || []).filter((s) => s.kind === 'strategy'), [scripts]);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [running, setRunning] = useState<{ phase: string; done?: number; total?: number; best?: { key: string; score: number; point: Point } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<OptimizationRecord | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const settings = usePopover();
  const historyPop = usePopover();
  const tab = cfg.tab || 'setup';

  useEffect(() => {
    if (!cfg.scriptId && strategies.length) setCfg({ scriptId: (strategies.find((s) => s.id === 'builtin:strat_ma_cross') || strategies[0]).id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies.length]);

  useEffect(() => {
    setAnalysis(null);
    if (!cfg.scriptId) return;
    let alive = true;
    void api
      .call('scripts:get', cfg.scriptId)
      .then((d: any) => api.call<AnalyzeResult>('scripts:analyze', d.language, d.code, { symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: 'candles' }))
      .then((a) => {
        if (!alive) return;
        setAnalysis(a);
        // initial space: numeric inputs with sensible ranges (first two enabled)
        if (!cfg.space || cfg.space.some((p) => !a.inputs.some((i) => i.key === p.key))) {
          const sp = spaceFromInputs(a.inputs as never).filter((p) => p.kind === 'int' || p.kind === 'float').slice(0, 2);
          setCfg({ space: sp });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.scriptId]);

  useEffect(() => {
    if (!cfg.runId) return;
    if (rec?.id === cfg.runId) return;
    void api
      .call<OptimizationRecord>('optimizations:get', cfg.runId)
      .then(setRec)
      .catch(() => setRec(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.runId]);

  useEffect(() => {
    const t = rec ? `Optimizer · ${rec.script.name}` : 'Optimizer';
    if (cfg.title !== t) setCfg({ title: t });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id]);
  useEffect(() => () => cancelRef.current?.(), []);

  const space = cfg.space || [];
  const titles = useMemo(() => Object.fromEntries((analysis?.inputs || []).map((i) => [i.key, i.title])), [analysis]);
  const budget = cfg.budget ?? 100;
  const method = cfg.method || 'bayes';
  const validation = cfg.validation || { mode: 'holdout', oosPct: 30 };

  const run = () => {
    if (!cfg.scriptId || !space.length) {
      toast({ title: 'Choose a strategy and at least one parameter', kind: 'warn' });
      return;
    }
    cancelRef.current?.();
    const base = buildRequest(cfg);
    const req: OptimizeRequest = {
      ...base,
      space,
      method,
      budget,
      seed: cfg.seed ?? 1,
      objective: cfg.objective || 'sharpe',
      constraints: { maxDrawdownPct: cfg.maxDd ?? undefined, minTrades: cfg.minTrades ?? 5, minProfitFactor: cfg.minPf ?? undefined },
      secondary: cfg.secondary?.length ? cfg.secondary : undefined,
      validation,
      extras: cfg.extras || {},
    };
    setError(null);
    setRunning({ phase: 'Starting' });
    const unsub = api.sub<any>('optimize', req, (m) => {
      if (m.__error || m.type === 'error') {
        setError(m.__error || m.message);
        setRunning(null);
        unsub();
        cancelRef.current = null;
      } else if (m.type === 'progress') setRunning({ phase: m.phase, done: m.done, total: m.total, best: m.best });
      else if (m.type === 'done') {
        setRunning(null);
        setRec(m.record);
        setCfg({ runId: m.record.id, tab: 'results' });
        unsub();
        cancelRef.current = null;
      }
    });
    cancelRef.current = () => {
      unsub();
      setRunning(null);
    };
  };

  const applyToChart = (pt: Point) => {
    const ws = useApp.getState().workspace;
    const id = lastChartId() || Object.values(ws?.modules || {}).find((m) => m.type === 'chart')?.id;
    const m = id ? ws?.modules[id] : null;
    if (!m || !cfg.scriptId) {
      toast({ title: 'No chart open', kind: 'warn' });
      return;
    }
    const c = m.config as ChartModuleConfig;
    useApp.getState().setModuleConfig(m.id, { indicators: [...(c.indicators || []), { id: newId('i'), scriptId: cfg.scriptId, inputs: { ...(cfg.inputs || {}), ...pt }, visible: true } as IndicatorInstance], symbol: cfg.symbol, market: cfg.market, tf: cfg.tf });
    toast({ title: 'Parameters applied on the chart', kind: 'ok' });
  };
  const backtest = (pt: Point) => void openModule('backtest', { ...buildTesterCfg(cfg), inputs: { ...(cfg.inputs || {}), ...pt }, autorun: Date.now() }, { reuse: true });

  const r = rangeOf(cfg);
  const size = gridSize(space);
  return (
    <div className="tester optimizer">
      <HeadControls>
        {running ? (
          <button className="btn small" onClick={() => cancelRef.current?.()}>
            <Icon name="stop" size={13} /> Cancel
          </button>
        ) : (
          <button className="btn small primary" onClick={run} disabled={!cfg.scriptId || !space.length} data-tip="Start optimization">
            <Icon name="play" size={13} /> Optimize
          </button>
        )}
        <button className="icon-btn" onClick={(e) => historyPop.toggle(e.currentTarget)} data-tip="Previous optimizations">
          <Icon name="history" />
        </button>
      </HeadControls>
      <div className="mod-toolbar tester-bar">
        <Select value={cfg.scriptId || ''} placeholder={strategies.length ? 'Choose strategy…' : 'No strategies'} options={strategies.map((s) => ({ value: s.id, label: `${s.name}${s.language === 'python' ? ' (Py)' : ''}` }))} onChange={(v) => setCfg({ scriptId: v || null, inputs: {}, space: undefined })} style={{ maxWidth: 240 }} />
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, m) => setCfg({ symbol: s, market: m })} />
        <TimeframePicker tf={cfg.tf} onChange={(tf) => setCfg({ tf })} />
        <Segmented size="sm" value={(cfg.range?.preset || '1Y') as RangePreset} options={(['3M', '6M', '1Y', '2Y', '3Y', '5Y'] as RangePreset[]).map((p) => ({ value: p, label: p }))} onChange={(p) => setCfg({ range: { preset: p } })} />
        <button className="icon-btn" onClick={(e) => settings.toggle(e.currentTarget)} data-tip="Costs, capital, fills">
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
      {historyPop.anchor && (
        <Popover anchor={historyPop.anchor} onClose={historyPop.close} width={480} align="end">
          <OptHistory
            current={cfg.runId || null}
            onOpen={(id) => {
              setCfg({ runId: id, tab: 'results' });
              historyPop.close();
            }}
          />
        </Popover>
      )}
      <Tabs
        value={tab}
        onChange={(t) => setCfg({ tab: t })}
        tabs={[
          { value: 'setup', label: 'Setup' },
          { value: 'results', label: 'Results', badge: rec ? <span className="badge">{rec.info.trials}</span> : undefined },
          { value: 'landscape', label: 'Landscape' },
          { value: 'robustness', label: 'Robustness' },
          { value: 'validation', label: 'Validation' },
          { value: 'stats', label: 'Overfitting' },
          { value: 'regimes', label: 'Regimes' },
        ]}
      />
      <div className="tester-body">
        {running && (
          <div className="tester-progress">
            <Spinner size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tp-phase">{running.phase}…</div>
              {running.total ? (
                <div className="progress" style={{ width: '100%', maxWidth: 340 }}>
                  <div style={{ width: `${Math.round(((running.done || 0) / running.total) * 100)}%` }} />
                </div>
              ) : null}
              {running.best && (
                <div className="muted small ellipsis">
                  Best so far: {fmtNum(running.best.score, 3)} · {fmtPoint(space, running.best.point, titles)}
                </div>
              )}
            </div>
          </div>
        )}
        {error && !running && (
          <div className="callout danger" style={{ margin: 12 }}>
            <Icon name="alert" size={14} /> {error}
          </div>
        )}
        {tab === 'setup' && <Setup cfg={cfg} setCfg={setCfg} analysis={analysis} size={size} />}
        {tab !== 'setup' && !rec && !running && <Empty icon="grid" title="No optimization yet">Configure the parameters in Setup and press Optimize.</Empty>}
        {tab !== 'setup' && rec && (
          <OptResults rec={rec} tab={tab} titles={titles} onApply={applyToChart} onBacktest={backtest} />
        )}
      </div>
    </div>
  );
}

function buildTesterCfg(cfg: OptCfg): Partial<TesterCfg> {
  const { scriptId, symbol, market, tf, chartType, range, costs, capital, leverage, slippageBps, limitFill, partialFills, fillOnStandardOhlc, warmupBars, allowShortSpot, borrowRateAnnual, riskFree } = cfg;
  return { scriptId, symbol, market, tf, chartType, range, costs, capital, leverage, slippageBps, limitFill, partialFills, fillOnStandardOhlc, warmupBars, allowShortSpot, borrowRateAnnual, riskFree, tab: 'overview' };
}

// ------------------------------------------------------------------ setup

function Setup({ cfg, setCfg, analysis, size }: { cfg: OptCfg; setCfg: (p: Partial<OptCfg>) => void; analysis: AnalyzeResult | null; size: number }) {
  if (!analysis) return <div className="pad">{cfg.scriptId ? <Spinner /> : 'Choose a strategy.'}</div>;
  if (!analysis.ok) return <div className="pad err-text">{analysis.error?.message}</div>;
  const all = spaceFromInputs(analysis.inputs as never);
  const space = cfg.space || [];
  const enabled = new Set(space.map((p) => p.key));
  const setParam = (key: string, patch: Partial<ParamDef> | null) => {
    if (patch === null) return setCfg({ space: space.filter((p) => p.key !== key) });
    const cur = space.find((p) => p.key === key) || all.find((p) => p.key === key)!;
    const next = { ...cur, ...patch } as ParamDef;
    setCfg({ space: enabled.has(key) ? space.map((p) => (p.key === key ? next : p)) : [...space, next] });
  };
  const v = cfg.validation || { mode: 'holdout', oosPct: 30 };
  const setV = (patch: Partial<OptimizeRequest['validation']>) => setCfg({ validation: { ...v, ...patch } });
  const ex = cfg.extras || {};
  const perWindow = v.mode === 'walkforward' || v.mode === 'cv';
  return (
    <div className="opt-setup">
      <section>
        <div className="section-title">Parameters</div>
        <table className="table opt-params">
          <thead>
            <tr>
              <th />
              <th>Input</th>
              <th>From</th>
              <th>To</th>
              <th>Step</th>
              <th className="num">Values</th>
            </tr>
          </thead>
          <tbody>
            {all.map((p) => {
              const cur = space.find((x) => x.key === p.key) || p;
              const on = enabled.has(p.key);
              return (
                <tr key={p.key} className={clsx(!on && 'muted')}>
                  <td>
                    <input type="checkbox" checked={on} onChange={(e) => setParam(p.key, e.target.checked ? {} : null)} />
                  </td>
                  <td>{cur.title || p.key}</td>
                  {cur.kind === 'int' || cur.kind === 'float' ? (
                    <>
                      <td>
                        <NumberField value={cur.min} onChange={(x) => setParam(p.key, { min: x } as never)} decimals={cur.kind === 'int' ? 0 : 4} style={{ width: 80 }} />
                      </td>
                      <td>
                        <NumberField value={cur.max} onChange={(x) => setParam(p.key, { max: x } as never)} decimals={cur.kind === 'int' ? 0 : 4} style={{ width: 80 }} />
                      </td>
                      <td>
                        <NumberField value={cur.step} onChange={(x) => setParam(p.key, { step: Math.max(cur.kind === 'int' ? 1 : 1e-6, x) } as never)} decimals={cur.kind === 'int' ? 0 : 4} style={{ width: 70 }} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className="muted small">
                      {cur.kind === 'bool' ? 'true / false' : (cur as Extract<ParamDef, { kind: 'choice' }>).values.join(', ')}
                    </td>
                  )}
                  <td className="num">{cardinality(cur)}</td>
                </tr>
              );
            })}
            {!all.length && (
              <tr>
                <td colSpan={6} className="muted">
                  This strategy has no numeric, boolean or option inputs to optimize.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="muted small">
          {space.length} parameter{space.length === 1 ? '' : 's'} · {size.toLocaleString()} combinations
        </div>
      </section>
      <section>
        <div className="section-title">Search</div>
        <div className="set-row">
          <span>Method</span>
          <Segmented value={cfg.method || 'bayes'} options={METHODS.map((m) => ({ value: m.value, label: m.label, title: m.title }))} onChange={(m) => setCfg({ method: m })} />
        </div>
        <label className="set-row">
          <span>{perWindow ? 'Trials per window / fold' : 'Trials (budget)'}</span>
          <NumberField value={cfg.budget ?? 100} onChange={(x) => setCfg({ budget: Math.max(1, Math.min(5000, Math.round(x))) })} min={1} max={5000} decimals={0} />
        </label>
        <label className="set-row">
          <span>Random seed</span>
          <NumberField value={cfg.seed ?? 1} onChange={(x) => setCfg({ seed: Math.round(x) })} decimals={0} />
        </label>
      </section>
      <section>
        <div className="section-title">Objective</div>
        <label className="set-row">
          <span>Maximize</span>
          <Select value={cfg.objective || 'sharpe'} options={OBJECTIVES.map((o) => ({ value: o.id, label: `${o.label}${o.risk ? ' · risk-adjusted' : ''}` }))} onChange={(o) => setCfg({ objective: o })} />
        </label>
        <label className="set-row">
          <span>Max drawdown ≤ (%)</span>
          <NumberField value={cfg.maxDd ?? null} placeholder="any" onChange={(x) => setCfg({ maxDd: x > 0 ? x : null })} min={0} decimals={1} />
        </label>
        <label className="set-row">
          <span>Min trades</span>
          <NumberField value={cfg.minTrades ?? 5} onChange={(x) => setCfg({ minTrades: Math.max(0, Math.round(x)) })} min={0} decimals={0} />
        </label>
        <label className="set-row">
          <span>Min profit factor</span>
          <NumberField value={cfg.minPf ?? null} placeholder="any" onChange={(x) => setCfg({ minPf: x > 0 ? x : null })} min={0} decimals={2} />
        </label>
        <div className="set-row">
          <span>Pareto with</span>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {(
              [
                ['maxDrawdownPct', 'Low drawdown'],
                ['trades', 'More trades'],
                ['profitFactor', 'Profit factor'],
                ['netProfitPct', 'Net profit'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={(cfg.secondary || []).includes(k)} onChange={(e) => setCfg({ secondary: e.target.checked ? [...(cfg.secondary || []), k] : (cfg.secondary || []).filter((x) => x !== k) })} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </section>
      <section>
        <div className="section-title">Validation (no look-ahead)</div>
        <div className="set-row">
          <span>Scheme</span>
          <Segmented
            value={v.mode}
            options={[
              { value: 'none', label: 'None', title: 'Optimize on the whole range (prone to overfitting)' },
              { value: 'holdout', label: 'Holdout', title: 'Optimize on the first part, report the untouched last part' },
              { value: 'walkforward', label: 'Walk-forward', title: 'Re-optimize on rolling in-sample windows, test on the following out-of-sample windows' },
              { value: 'cv', label: 'Purged CV', title: 'k-fold cross-validation with purging and embargo' },
            ]}
            onChange={(mode) => setV({ mode })}
          />
        </div>
        {v.mode === 'holdout' && (
          <label className="set-row">
            <span>Out-of-sample share (%)</span>
            <NumberField value={v.oosPct ?? 30} onChange={(x) => setV({ oosPct: Math.max(5, Math.min(60, x)) })} min={5} max={60} decimals={0} />
          </label>
        )}
        {v.mode === 'walkforward' && (
          <>
            <label className="set-row">
              <span>Windows</span>
              <NumberField value={v.windows ?? 5} onChange={(x) => setV({ windows: Math.max(2, Math.min(20, Math.round(x))) })} min={2} max={20} decimals={0} />
            </label>
            <label className="set-row">
              <span>In-sample : out-of-sample</span>
              <NumberField value={v.isRatio ?? 3} onChange={(x) => setV({ isRatio: Math.max(1, Math.min(10, x)) })} min={1} max={10} decimals={1} suffix=": 1" />
            </label>
            <label className="set-row">
              <span>Anchored (expanding in-sample)</span>
              <Toggle value={!!v.anchored} onChange={(x) => setV({ anchored: x })} />
            </label>
          </>
        )}
        {v.mode === 'cv' && (
          <>
            <label className="set-row">
              <span>Folds</span>
              <NumberField value={v.folds ?? 5} onChange={(x) => setV({ folds: Math.max(3, Math.min(10, Math.round(x))) })} min={3} max={10} decimals={0} />
            </label>
            <label className="set-row">
              <span>Embargo (% of bars)</span>
              <NumberField value={v.embargoPct ?? 1} onChange={(x) => setV({ embargoPct: Math.max(0, Math.min(10, x)) })} min={0} max={10} decimals={1} />
            </label>
          </>
        )}
        <div className="muted small" style={{ marginTop: 4 }}>
          Every candidate is simulated once; each scope scores it only from equity and trades inside its own bars, and Bayesian/genetic searches run separately per scope — out-of-sample data never influences which parameters are chosen.
        </div>
      </section>
      <section>
        <div className="section-title">Robustness statistics</div>
        {(
          [
            ['bootstrap', 'Bootstrap confidence intervals'],
            ['randomEntries', 'Randomized-entry test'],
            ['pbo', 'Probability of backtest overfitting'],
            ['regimes', 'Regime stability'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="set-row">
            <span>{label}</span>
            <Toggle value={(cfg.extras || {})[k] !== false} onChange={(x) => setCfg({ extras: { ...ex, [k]: x } })} />
          </label>
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ results

function OptResults({ rec, tab, titles, onApply, onBacktest }: { rec: OptimizationRecord; tab: string; titles: Record<string, string>; onApply: (p: Point) => void; onBacktest: (p: Point) => void }) {
  const space = rec.request.space;
  const byKey = useMemo(() => new Map(rec.trials.map((t) => [t.key, t])), [rec]);
  const main = rec.scopes[rec.scopes.length - 1];
  const [sel, setSel] = useState<string | null>(rec.bestKey);
  useEffect(() => setSel(rec.bestKey), [rec.id]);
  const selTrial = sel ? byKey.get(sel) : undefined;
  const header = (
    <div className="opt-head">
      <div className="rh-title">
        <b>{rec.label}</b>
        <span className="muted small">
          {rec.info.trials} trials · {rec.info.bars.toLocaleString()} bars · {fmtDate(rec.info.fromT)} – {fmtDate(rec.info.toT)} · {fmtDuration(rec.info.ms)} on {rec.info.parallel} workers · ran {fmtDateTime(rec.created)}
        </span>
      </div>
      <div className="spacer" />
      {selTrial && (
        <>
          <span className="muted small ellipsis" style={{ maxWidth: 260 }}>
            {fmtPoint(space, selTrial.point, titles)}
          </span>
          <button
            className="btn small ghost"
            data-tip="Save these parameters as a named set"
            onClick={() =>
              void promptDialog({ title: 'Save parameter set', label: 'Name', initial: `${rec.script.name} · ${rec.request.symbol} ${rec.request.tf}` }).then((name) => {
                if (!name) return;
                void api
                  .call('paramsets:save', { scriptId: rec.script.id, scriptName: rec.script.name, name, inputs: { ...(rec.request.inputs || {}), ...selTrial.point }, source: { kind: 'optimization', id: rec.id }, context: { symbol: rec.request.symbol, market: rec.request.market, tf: rec.request.tf } })
                  .then(() => toast({ title: 'Parameter set saved', body: 'Find it in Experiments and the indicator settings.', kind: 'ok' }));
              })
            }
          >
            <Icon name="save" size={13} /> Save set
          </button>
          <button className="btn small" onClick={() => onBacktest(selTrial.point)} data-tip="Full backtest with these parameters">
            <Icon name="flask" size={13} /> Backtest
          </button>
          <button className="btn small primary" onClick={() => onApply(selTrial.point)} data-tip="Add the strategy with these parameters to the chart">
            <Icon name="chart" size={13} /> Apply
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className="results">
      {header}
      {rec.warnings.length > 0 && (
        <div className="callout warn" style={{ margin: '0 12px 8px' }}>
          {rec.warnings.map((w, k) => (
            <div key={k}>
              <Icon name="alert" size={13} /> {w}
            </div>
          ))}
        </div>
      )}
      <div className="results-body">
        {tab === 'results' && <ResultsTable rec={rec} titles={titles} sel={sel} setSel={setSel} scope={main} />}
        {tab === 'landscape' && <Landscape rec={rec} titles={titles} scope={main} sel={sel} setSel={setSel} />}
        {tab === 'robustness' && <Robustness rec={rec} titles={titles} setSel={setSel} />}
        {tab === 'validation' && <Validation rec={rec} titles={titles} />}
        {tab === 'stats' && <Stats rec={rec} titles={titles} />}
        {tab === 'regimes' && <Regimes rec={rec} titles={titles} />}
      </div>
    </div>
  );
}

function ResultsTable({ rec, titles, sel, setSel, scope }: { rec: OptimizationRecord; titles: Record<string, string>; sel: string | null; setSel: (k: string) => void; scope: OptimizationRecord['scopes'][number] }) {
  const space = rec.request.space;
  const byKey = new Map(rec.trials.map((t) => [t.key, t]));
  const narrow = new Set(rec.robustness.filter((x) => x.narrowPeak).map((x) => x.key));
  const pareto = new Set(rec.pareto);
  const rows = scope.ranking.slice(0, 200);
  const objLabel = OBJECTIVES.find((o) => o.id === rec.request.objective)?.label || rec.request.objective;
  return (
    <div className="pad">
      {rec.bestCurve && (
        <div className="chart-card" style={{ marginBottom: 10 }}>
          <div className="section-title">Equity of the selected best ({scope.name.toLowerCase()} ranking)</div>
          <LineChart t={rec.bestCurve.t} height={150} format={(v) => fmtNum(v, 0)} series={[{ values: rec.bestCurve.eq, color: '#3b82f6', label: 'Equity', area: true }]} />
        </div>
      )}
      <div className="muted small" style={{ marginBottom: 6 }}>
        Ranked by {objLabel} on “{scope.name}”. ◆ Pareto-optimal · ▲ narrow peak (fragile).
      </div>
      <table className="table opt-table">
        <thead>
          <tr>
            <th>#</th>
            {space.map((p) => (
              <th key={p.key}>{titles[p.key] || p.title || p.key}</th>
            ))}
            <th className="num">Score</th>
            <th className="num">Net %</th>
            <th className="num">Max DD</th>
            <th className="num">Sharpe</th>
            <th className="num">PF</th>
            <th className="num">Trades</th>
            <th className="num">Win %</th>
            <th className="num" data-tip="Annualised alpha against buy & hold (return the market exposure doesn't explain)">
              Alpha
            </th>
            <th className="num" data-tip="Beta against buy & hold">
              Beta
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x, k) => {
            const t = byKey.get(x.key);
            const m = t?.metrics;
            return (
              <tr key={x.key} className={clsx('clickable', sel === x.key && 'sel')} onClick={() => setSel(x.key)}>
                <td className="muted">
                  {k + 1}
                  {pareto.has(x.key) && <span className="flag" data-tip="Pareto-optimal"> ◆</span>}
                  {narrow.has(x.key) && <span className="flag warn" data-tip="Narrow peak: neighbours perform much worse"> ▲</span>}
                </td>
                {space.map((p) => (
                  <td key={p.key} className="mono">
                    {t ? String(t.point[p.key]) : ''}
                  </td>
                ))}
                <td className="num mono">{Number.isFinite(x.score) ? fmtNum(x.score, 3) : <span className="muted">{t?.error ? 'error' : 'rejected'}</span>}</td>
                <td className={clsx('num', m && (m.netProfitPct >= 0 ? 'up' : 'down'))}>{m ? fmtPct(m.netProfitPct, 1) : '—'}</td>
                <td className="num down">{m ? fmtPct(-m.maxDrawdownPct, 1) : '—'}</td>
                <td className="num">{m ? m.sharpe.toFixed(2) : '—'}</td>
                <td className="num">{m ? pf(m.profitFactor) : '—'}</td>
                <td className="num">{m ? m.trades : '—'}</td>
                <td className="num">{m ? fmtPct(m.winRate * 100, 0, false) : '—'}</td>
                <td className={clsx('num', m?.alpha !== undefined && (m.alpha >= 0 ? 'up' : 'down'))}>{m?.alpha !== undefined && Number.isFinite(m.alpha) ? fmtPct(m.alpha, 1) : '—'}</td>
                <td className="num">{m?.beta !== undefined && Number.isFinite(m.beta) ? m.beta.toFixed(2) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Landscape({ rec, titles, scope, sel, setSel }: { rec: OptimizationRecord; titles: Record<string, string>; scope: OptimizationRecord['scopes'][number]; sel: string | null; setSel: (k: string) => void }) {
  const space = rec.request.space;
  const [xKey, setX] = useState(space[0]?.key);
  const [yKey, setY] = useState(space[1]?.key || space[0]?.key);
  const [metric, setMetric] = useState<'score' | keyof TrialMetrics>('score');
  const [view, setView] = useState<'heat' | '3d'>('heat');
  const scoreOf = new Map(scope.ranking.map((x) => [x.key, x.score]));
  const grid: Grid2D | null = useMemo(() => {
    const px = space.find((p) => p.key === xKey);
    const py = space.find((p) => p.key === yKey);
    if (!px || !py) return null;
    const xs = Array.from({ length: cardinality(px) }, (_, k) => valueAt(px, k));
    const ys = Array.from({ length: cardinality(py) }, (_, k) => valueAt(py, k));
    const z = ys.map(() => xs.map(() => NaN));
    for (const t of rec.trials) {
      const xi = xs.findIndex((v) => v === t.point[px.key]);
      const yi = ys.findIndex((v) => v === t.point[py.key]);
      if (xi < 0 || yi < 0) continue;
      const v = metric === 'score' ? (scoreOf.get(t.key) ?? NaN) : t.metrics ? (t.metrics[metric] as number) : NaN;
      if (!Number.isFinite(v)) continue;
      // other dimensions: keep the best value per cell
      if (!Number.isFinite(z[yi][xi]) || v > z[yi][xi]) z[yi][xi] = metric === 'maxDrawdownPct' ? (Number.isFinite(z[yi][xi]) ? Math.min(z[yi][xi], v) : v) : v;
    }
    return { xs, ys, z, xLabel: titles[px.key] || px.title || px.key, yLabel: titles[py.key] || py.title || py.key, zLabel: metric === 'score' ? 'Score' : metric };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id, xKey, yKey, metric]);
  if (!space.length) return null;
  const selPt = sel ? rec.trials.find((t) => t.key === sel)?.point : null;
  const selCell: [number, number] | null = grid && selPt ? [grid.xs.findIndex((v) => v === selPt[xKey!]), grid.ys.findIndex((v) => v === selPt[yKey!])] : null;
  return (
    <div className="pad">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="muted small">X</span>
        <Select value={xKey!} options={space.map((p) => ({ value: p.key, label: titles[p.key] || p.title || p.key }))} onChange={setX} />
        <span className="muted small">Y</span>
        <Select value={yKey!} options={space.map((p) => ({ value: p.key, label: titles[p.key] || p.title || p.key }))} onChange={setY} />
        <span className="muted small">Value</span>
        <Select
          value={metric}
          options={[
            { value: 'score', label: 'Objective score' },
            { value: 'netProfitPct', label: 'Net profit %' },
            { value: 'sharpe', label: 'Sharpe' },
            { value: 'maxDrawdownPct', label: 'Max drawdown %' },
            { value: 'profitFactor', label: 'Profit factor' },
            { value: 'trades', label: 'Trades' },
          ]}
          onChange={(m) => setMetric(m as never)}
        />
        <div className="spacer" />
        <Segmented size="sm" value={view} options={[{ value: 'heat', label: 'Heatmap' }, { value: '3d', label: '3-D' }]} onChange={setView} />
      </div>
      {space.length > 2 && <div className="muted small" style={{ marginBottom: 6 }}>Other parameters: each cell shows the best value over them.</div>}
      {grid &&
        (view === 'heat' ? (
          <Heatmap
            grid={grid}
            format={(v) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 2)}
            selected={selCell && selCell[0] >= 0 && selCell[1] >= 0 ? selCell : null}
            onPick={(xi, yi) => {
              const t = rec.trials.filter((tt) => tt.point[xKey!] === grid.xs[xi] && tt.point[yKey!] === grid.ys[yi]).sort((a, b) => (scoreOf.get(b.key) ?? -Infinity) - (scoreOf.get(a.key) ?? -Infinity))[0];
              if (t) setSel(t.key);
            }}
          />
        ) : (
          <Surface3D grid={grid} format={(v) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 2)} />
        ))}
      <div className="muted small" style={{ marginTop: 6 }}>
        Look for broad plateaus of good values rather than isolated peaks — a robust strategy keeps working when parameters move a little.
      </div>
    </div>
  );
}

function Robustness({ rec, titles, setSel }: { rec: OptimizationRecord; titles: Record<string, string>; setSel: (k: string) => void }) {
  const space = rec.request.space;
  const byKey = new Map(rec.trials.map((t) => [t.key, t]));
  const smoothed = [...rec.robustness].sort((a, b) => b.smoothed - a.smoothed);
  return (
    <div className="pad">
      <div className="muted small" style={{ marginBottom: 8 }}>
        For each top result: the average and worst score of its direct neighbours (one grid step in any parameter). Plateau ≈ 1 means the neighbourhood is as good; low values mean a fragile, narrow peak. Sorted by the smoothed score (own + neighbours).
      </div>
      <table className="table opt-table">
        <thead>
          <tr>
            <th>Parameters</th>
            <th className="num">Smoothed</th>
            <th className="num">Neighbours (avg)</th>
            <th className="num">Neighbours (worst)</th>
            <th className="num">Plateau</th>
            <th className="num">Checked</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {smoothed.map((r) => (
            <tr key={r.key} className="clickable" onClick={() => setSel(r.key)}>
              <td className="mono small">{fmtPoint(space, byKey.get(r.key)?.point || null, titles)}</td>
              <td className="num">{Number.isFinite(r.smoothed) ? fmtNum(r.smoothed, 3) : '—'}</td>
              <td className="num">{Number.isFinite(r.mean) ? fmtNum(r.mean, 3) : '—'}</td>
              <td className="num">{Number.isFinite(r.min) ? fmtNum(r.min, 3) : '—'}</td>
              <td className={clsx('num', Number.isFinite(r.plateau) && (r.plateau >= 0.8 ? 'up' : r.plateau < 0.5 ? 'down' : ''))}>{Number.isFinite(r.plateau) ? r.plateau.toFixed(2) : '—'}</td>
              <td className="num">{r.evaluated}</td>
              <td>{r.narrowPeak ? <span className="badge warn">narrow peak</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rec.request.method !== 'grid' && <div className="muted small" style={{ marginTop: 6 }}>Non-grid searches evaluate only some neighbours; “Checked” shows how many were available.</div>}
    </div>
  );
}

function MetricsRow({ label, m }: { label: string; m: TrialMetrics | null | undefined }) {
  return (
    <tr>
      <td>{label}</td>
      <td className={clsx('num', m && (m.netProfitPct >= 0 ? 'up' : 'down'))}>{m ? fmtPct(m.netProfitPct, 1) : '—'}</td>
      <td className="num down">{m ? fmtPct(-m.maxDrawdownPct, 1) : '—'}</td>
      <td className="num">{m ? m.sharpe.toFixed(2) : '—'}</td>
      <td className="num">{m ? pf(m.profitFactor) : '—'}</td>
      <td className="num">{m ? m.trades : '—'}</td>
    </tr>
  );
}

function Validation({ rec, titles }: { rec: OptimizationRecord; titles: Record<string, string> }) {
  const v = rec.validation;
  const space = rec.request.space;
  const span = rec.info.toT - rec.info.fromT;
  const head = (
    <thead>
      <tr>
        <th />
        <th className="num">Return</th>
        <th className="num">Max DD</th>
        <th className="num">Sharpe</th>
        <th className="num">PF</th>
        <th className="num">Trades</th>
      </tr>
    </thead>
  );
  if (v.mode === 'none')
    return (
      <div className="pad">
        <div className="callout warn">No validation was used: the best result was chosen and measured on the same data, so it is optimistic. Use Holdout, Walk-forward or Purged CV to see how the selection performs on unseen data.</div>
      </div>
    );
  if (v.mode === 'holdout' && v.holdout) {
    const deg = v.holdout.isMetrics.sharpe ? v.holdout.oosMetrics.sharpe / v.holdout.isMetrics.sharpe : NaN;
    return (
      <div className="pad">
        <table className="table">
          {head}
          <tbody>
            <MetricsRow label="In-sample (optimized)" m={v.holdout.isMetrics} />
            <MetricsRow label="Out-of-sample (unseen)" m={v.holdout.oosMetrics} />
          </tbody>
        </table>
        <div className="muted small" style={{ margin: '6px 0 12px' }}>
          OOS / IS Sharpe: {Number.isFinite(deg) ? deg.toFixed(2) : '—'} {Number.isFinite(deg) && deg < 0.5 ? '— strong degradation: the in-sample optimum does not carry over.' : ''}
        </div>
        <div className="section-title">Top in-sample candidates on the holdout</div>
        <table className="table">
          <thead>
            <tr>
              <th>Parameters</th>
              <th className="num">IS score</th>
              <th className="num">OOS score</th>
            </tr>
          </thead>
          <tbody>
            {v.holdout.top.map((r) => (
              <tr key={r.key}>
                <td className="mono small">{fmtPoint(space, rec.trials.find((t) => t.key === r.key)?.point || null, titles)}</td>
                <td className="num">{fmtNum(r.is, 3)}</td>
                <td className={clsx('num', r.oos >= 0 ? 'up' : 'down')}>{Number.isFinite(r.oos) ? fmtNum(r.oos, 3) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (v.mode === 'walkforward' && v.wfo) {
    const w = v.wfo;
    return (
      <div className="pad">
        <div className="section-title">Partitions</div>
        <div className="wfo-timeline">
          {w.windows.map((x, k) => {
            const tIs0 = rec.scopes[k]?.times[0]?.[0] ?? 0;
            const tIs1 = rec.scopes[k]?.times[0]?.[1] ?? 0;
            const left = ((tIs0 - rec.info.fromT) / span) * 100;
            const isW = ((tIs1 - tIs0) / span) * 100;
            const oosW = (((x.oosTo - x.oosFrom) / Math.max(1, x.isTo - x.isFrom)) * isW) || 2;
            return (
              <div key={k} className="wfo-row">
                <span className="muted small">#{k + 1}</span>
                <div className="wfo-track">
                  <div className="wfo-is" style={{ left: `${left}%`, width: `${isW}%` }} />
                  <div className="wfo-oos" style={{ left: `${left + isW}%`, width: `${oosW}%` }} />
                </div>
              </div>
            );
          })}
          <div className="row small muted" style={{ gap: 12 }}>
            <span>
              <span className="wfo-key is" /> in-sample (optimize)
            </span>
            <span>
              <span className="wfo-key oos" /> out-of-sample (test)
            </span>
          </div>
        </div>
        <div className="chart-card" style={{ margin: '10px 0' }}>
          <div className="section-title">Stitched out-of-sample equity</div>
          <LineChart t={w.stitched.t} height={170} format={(v2) => `${((v2 - 1) * 100).toFixed(1)}%`} series={[{ values: w.stitched.eq, color: '#22c55e', label: 'OOS equity', area: true }]} />
        </div>
        <table className="table">
          {head}
          <tbody>
            <MetricsRow label="All OOS windows" m={w.oosMetrics} />
          </tbody>
        </table>
        <div className="muted small" style={{ margin: '6px 0 12px' }}>
          Walk-forward efficiency (OOS CAGR / IS CAGR): <b>{Number.isFinite(w.wfe) ? w.wfe.toFixed(2) : '—'}</b> {Number.isFinite(w.wfe) ? (w.wfe >= 0.5 ? '— healthy' : '— weak: in-sample results do not carry forward') : ''}
        </div>
        <div className="section-title">Windows</div>
        <table className="table opt-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Chosen parameters</th>
              <th className="num">IS return</th>
              <th className="num">OOS return</th>
              <th className="num">OOS DD</th>
              <th className="num">OOS trades</th>
            </tr>
          </thead>
          <tbody>
            {w.windows.map((x, k) => (
              <tr key={k}>
                <td>{k + 1}</td>
                <td className="mono small">{fmtPoint(space, x.point, titles)}</td>
                <td className="num">{x.isMetrics ? fmtPct(x.isMetrics.netProfitPct, 1) : '—'}</td>
                <td className={clsx('num', x.oosMetrics && (x.oosMetrics.netProfitPct >= 0 ? 'up' : 'down'))}>{x.oosMetrics ? fmtPct(x.oosMetrics.netProfitPct, 1) : '—'}</td>
                <td className="num down">{x.oosMetrics ? fmtPct(-x.oosMetrics.maxDrawdownPct, 1) : '—'}</td>
                <td className="num">{x.oosMetrics ? x.oosMetrics.trades : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small" style={{ marginTop: 6 }}>Stable chosen parameters across windows are a good sign; jumping parameters indicate an unstable optimum.</div>
      </div>
    );
  }
  if (v.mode === 'cv' && v.cv) {
    const c = v.cv;
    return (
      <div className="pad">
        <div className="muted small" style={{ marginBottom: 8 }}>
          Purge {c.purgeBars} bars before each test fold (typical holding time) and embargo after it, so no trade straddles training and test data.
        </div>
        <table className="table opt-table">
          <thead>
            <tr>
              <th>Fold</th>
              <th>Chosen on training folds</th>
              <th className="num">Train score</th>
              <th className="num">Test return</th>
              <th className="num">Test Sharpe</th>
              <th className="num">Test trades</th>
            </tr>
          </thead>
          <tbody>
            {c.folds.map((f, k) => (
              <tr key={k}>
                <td>{k + 1}</td>
                <td className="mono small">{fmtPoint(space, f.point, titles)}</td>
                <td className="num">{Number.isFinite(f.trainScore) ? fmtNum(f.trainScore, 3) : '—'}</td>
                <td className={clsx('num', f.testMetrics && (f.testMetrics.netProfitPct >= 0 ? 'up' : 'down'))}>{f.testMetrics ? fmtPct(f.testMetrics.netProfitPct, 1) : '—'}</td>
                <td className="num">{f.testMetrics ? f.testMetrics.sharpe.toFixed(2) : '—'}</td>
                <td className="num">{f.testMetrics ? f.testMetrics.trades : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small" style={{ marginTop: 6 }}>
          Mean training score {fmtNum(c.meanTrain, 3)} vs mean test score {fmtNum(c.meanTest, 3)} — the gap estimates how much the optimum is overfitted.
        </div>
      </div>
    );
  }
  return null;
}

function Stats({ rec, titles }: { rec: OptimizationRecord; titles: Record<string, string> }) {
  const s = rec.stats;
  const space = rec.request.space;
  return (
    <div className="pad stats-grid">
      <div className="muted small">Measured on: {s.scope}</div>
      {s.dsr && (
        <div className="stat-card">
          <div className="section-title">Deflated Sharpe ratio</div>
          <div className={clsx('big', s.dsr.dsr >= 0.95 ? 'up' : s.dsr.dsr < 0.5 ? 'down' : '')}>{fmtPct(s.dsr.dsr * 100, 0, false)}</div>
          <div className="muted small">
            Probability that the true Sharpe is positive after {s.dsr.trials} trials (per-period SR {s.dsr.sr.toFixed(3)} vs the {s.dsr.sr0.toFixed(3)} expected from luck alone). Below 95% the edge is not statistically established.
          </div>
        </div>
      )}
      {s.pbo && Number.isFinite(s.pbo.pbo) && (
        <div className="stat-card">
          <div className="section-title">Probability of backtest overfitting</div>
          <div className={clsx('big', s.pbo.pbo <= 0.2 ? 'up' : s.pbo.pbo >= 0.5 ? 'down' : '')}>{fmtPct(s.pbo.pbo * 100, 0, false)}</div>
          <div className="muted small">
            Share of {s.pbo.splits} combinatorial splits where the in-sample best of the top {s.pbo.candidates} ranks below the median out-of-sample. Above 50% the optimization is selecting noise.
          </div>
        </div>
      )}
      {s.randomEntry && (
        <div className="stat-card">
          <div className="section-title">Randomized-entry test</div>
          <div className={clsx('big', s.randomEntry.pValue < 0.05 ? 'up' : 'down')}>p = {s.randomEntry.pValue.toFixed(3)}</div>
          <div className="muted small">
            Strategy {fmtPct(s.randomEntry.strategyReturnPct, 1)} vs random entries with the same trade count, holding times and direction mix: median {fmtPct(s.randomEntry.randomMedianPct, 1)}, 95th percentile {fmtPct(s.randomEntry.random95Pct, 1)}.
          </div>
        </div>
      )}
      {s.bootstrap && (
        <div className="stat-card">
          <div className="section-title">Bootstrap (2,000 resampled trade sequences)</div>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th className="num">5%</th>
                <th className="num">Median</th>
                <th className="num">95%</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Return</td>
                <td className="num">{fmtPct(s.bootstrap.returnPct.p5, 1)}</td>
                <td className="num">{fmtPct(s.bootstrap.returnPct.p50, 1)}</td>
                <td className="num">{fmtPct(s.bootstrap.returnPct.p95, 1)}</td>
              </tr>
              <tr>
                <td>Max drawdown</td>
                <td className="num">{fmtPct(-s.bootstrap.maxDrawdownPct.p5, 1)}</td>
                <td className="num">{fmtPct(-s.bootstrap.maxDrawdownPct.p50, 1)}</td>
                <td className="num">{fmtPct(-s.bootstrap.maxDrawdownPct.p95, 1)}</td>
              </tr>
              <tr>
                <td>Sharpe (per trade)</td>
                <td className="num">{s.bootstrap.sharpe.p5.toFixed(2)}</td>
                <td className="num">{s.bootstrap.sharpe.p50.toFixed(2)}</td>
                <td className="num">{s.bootstrap.sharpe.p95.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          <div className="muted small">Probability of a loss over the same number of trades: {fmtPct(s.bootstrap.probLoss * 100, 0, false)}.</div>
        </div>
      )}
      {s.pvalues && (
        <div className="stat-card">
          <div className="section-title">Multiple-testing corrected p-values (Holm)</div>
          <table className="table">
            <thead>
              <tr>
                <th>Parameters</th>
                <th className="num">p</th>
                <th className="num">Holm-adjusted</th>
              </tr>
            </thead>
            <tbody>
              {s.pvalues.map((p) => (
                <tr key={p.key}>
                  <td className="mono small">{fmtPoint(space, rec.trials.find((t) => t.key === p.key)?.point || null, titles)}</td>
                  <td className="num">{p.p.toFixed(4)}</td>
                  <td className={clsx('num', p.adjusted < 0.05 ? 'up' : 'muted')}>{p.adjusted.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">H0: mean daily return ≤ 0. Adjusted for all {rec.info.trials} tested parameter sets.</div>
        </div>
      )}
    </div>
  );
}

function Regimes({ rec, titles }: { rec: OptimizationRecord; titles: Record<string, string> }) {
  const names = ['Uptrend', 'Sideways', 'Downtrend', 'High volatility', 'Low volatility'];
  if (!rec.regimes.length) return <div className="pad muted">Regime stability was not computed.</div>;
  return (
    <div className="pad">
      <div className="muted small" style={{ marginBottom: 8 }}>
        Compounded return of the top candidates inside each market regime (trend: 200-bar SMA and slope; volatility: 50-bar realised volatility vs median). Prefer parameters that do not depend on a single regime.
      </div>
      <table className="table opt-table">
        <thead>
          <tr>
            <th>Parameters</th>
            {names.map((n) => (
              <th key={n} className="num">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rec.regimes.map((r) => (
            <tr key={r.key}>
              <td className="mono small">{fmtPoint(rec.request.space, rec.trials.find((t) => t.key === r.key)?.point || null, titles)}</td>
              {names.map((n) => (
                <td key={n} className={clsx('num', r.returns[n] !== undefined && (r.returns[n] >= 0 ? 'up' : 'down'))}>
                  {r.returns[n] !== undefined ? fmtPct(r.returns[n], 1) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OptHistory({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<any[] | null>(null);
  useEffect(() => {
    const load = () => void api.call<any[]>('optimizations:list').then(setRuns).catch(() => setRuns([]));
    load();
    return api.on('optimizations:changed', load);
  }, []);
  return (
    <div className="run-history">
      <div className="row" style={{ padding: '8px 10px' }}>
        <b>Optimizations</b>
      </div>
      <div className="rh-list">
        {!runs && <Spinner />}
        {runs && !runs.length && <div className="muted pad">No optimizations yet.</div>}
        {runs?.map((r) => (
          <div key={r.id} className={clsx('rh-row', r.id === current && 'on')} onClick={() => onOpen(r.id)}>
            <div className="rh-text">
              <div className="ellipsis">{r.label}</div>
              <div className="muted small">
                {fmtDateTime(r.created)} · {r.trials} trials · {r.mode}
              </div>
            </div>
            <button
              className="icon-btn small"
              onClick={(e) => {
                e.stopPropagation();
                void confirmDialog({ title: 'Delete this optimization?', body: r.label, confirm: 'Delete', danger: true }).then((ok) => ok && api.call('optimizations:delete', r.id));
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
