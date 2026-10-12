/**
 * Experiments: a research notebook. Each experiment has a status, tags, notes and links to
 * backtests, optimizations, scripts and saved parameter sets; recent runs appear in an
 * activity feed and can be linked with one click.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { Icon } from '../../components/Icon';
import { Segmented, Spinner, Empty, confirmDialog } from '../../components/ui';
import { clsx, fmtAgo, fmtPct, fmtDateTime } from '../../lib/format';
import { openModule } from '../../app/moduleOps';
import { newId, type ChartModuleConfig, type IndicatorInstance } from '../../../shared/workspace';
import type { Experiment, ExperimentLink, ExperimentStatus, ParamSet } from '../../../main/backtest/experiments';
import { lastChartId } from '../scripts/focus';
import './backtest.css';

const STATUS: { value: ExperimentStatus; label: string }[] = [
  { value: 'idea', label: 'Idea' },
  { value: 'testing', label: 'Testing' },
  { value: 'promising', label: 'Promising' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'live', label: 'Live' },
];

interface Activity {
  kind: 'backtest' | 'optimization';
  id: string;
  label: string;
  created: number;
  summary?: string;
}

function useList<T>(method: string, event: string, ...args: unknown[]): T[] | null {
  const [list, setList] = useState<T[] | null>(null);
  useEffect(() => {
    const load = () => void api.call<T[]>(method, ...args).then(setList).catch(() => setList([]));
    load();
    return api.on(event, load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, event, JSON.stringify(args)]);
  return list;
}

export function applySetToChart(set: ParamSet): void {
  const ws = useApp.getState().workspace;
  const id = lastChartId() || Object.values(ws?.modules || {}).find((m) => m.type === 'chart')?.id;
  const m = id ? ws?.modules[id] : null;
  if (!m) {
    toast({ title: 'No chart open', kind: 'warn' });
    return;
  }
  const c = m.config as ChartModuleConfig;
  const patch: Record<string, unknown> = { indicators: [...(c.indicators || []), { id: newId('i'), scriptId: set.scriptId, inputs: set.inputs, visible: true } as IndicatorInstance] };
  if (set.context?.symbol) Object.assign(patch, { symbol: set.context.symbol, market: set.context.market, tf: set.context.tf });
  useApp.getState().setModuleConfig(m.id, patch);
  toast({ title: `Applied “${set.name}”`, kind: 'ok' });
}

export function ExperimentsModule({ module }: ModuleProps) {
  const cfg = module.config as { selected?: string | null; filter?: ExperimentStatus | 'all' };
  const setCfg = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const exps = useList<Experiment>('experiments:list', 'experiments:changed');
  const bts = useList<any>('backtests:list', 'backtests:changed');
  const opts = useList<any>('optimizations:list', 'optimizations:changed');
  const sets = useList<ParamSet>('paramsets:list', 'paramsets:changed');
  const [q, setQ] = useState('');
  const filter = cfg.filter || 'all';
  const selected = exps?.find((e) => e.id === cfg.selected) || null;
  const activity: Activity[] = useMemo(
    () =>
      [
        ...(bts || []).map((b) => ({ kind: 'backtest' as const, id: b.id, label: b.label, created: b.created, summary: b.summary ? `${fmtPct(b.summary.netProfitPct, 1)} · DD ${fmtPct(-b.summary.maxDrawdownPct, 1)} · PF ${Number.isFinite(b.summary.profitFactor) ? b.summary.profitFactor.toFixed(2) : '∞'}` : 'failed' })),
        ...(opts || []).map((o) => ({ kind: 'optimization' as const, id: o.id, label: o.label, created: o.created, summary: `${o.trials} trials · ${o.mode}` })),
      ].sort((a, b) => b.created - a.created),
    [bts, opts],
  );
  const list = (exps || []).filter((e) => (filter === 'all' || e.status === filter) && (!q || e.title.toLowerCase().includes(q.toLowerCase()) || e.tags.some((t) => t.toLowerCase().includes(q.toLowerCase()))));
  const create = async () => {
    const e = await api.call<Experiment>('experiments:save', { title: 'New experiment', status: 'idea' });
    setCfg({ selected: e.id });
  };
  return (
    <div className="experiments">
      <HeadControls>
        <button className="btn small primary" onClick={() => void create()}>
          <Icon name="plus" size={13} /> New experiment
        </button>
      </HeadControls>
      <div className="exp-body">
        <div className="exp-side">
          <input className="input" placeholder="Search experiments or #tags…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented size="sm" value={filter} options={[{ value: 'all', label: 'All' }, ...STATUS.map((s) => ({ value: s.value, label: s.label }))]} onChange={(f) => setCfg({ filter: f })} />
          <div className="exp-list">
            {!exps && <Spinner />}
            {exps && !list.length && <div className="muted small pad">No experiments{filter !== 'all' ? ' with this status' : ''}.</div>}
            {list.map((e) => (
              <div key={e.id} className={clsx('exp-item', e.id === cfg.selected && 'on')} onClick={() => setCfg({ selected: e.id })}>
                <div className="row" style={{ gap: 6 }}>
                  <span className={clsx('status-pill', e.status)}>{STATUS.find((s) => s.value === e.status)?.label}</span>
                  <span className="ellipsis" style={{ fontWeight: 600 }}>
                    {e.title}
                  </span>
                </div>
                <div className="muted small ellipsis">
                  {fmtAgo(e.updated)} · {e.links.length} link{e.links.length === 1 ? '' : 's'}
                  {e.tags.length ? ` · ${e.tags.map((t) => `#${t}`).join(' ')}` : ''}
                </div>
              </div>
            ))}
          </div>
          <div className="section-title">Recent runs</div>
          <div className="exp-activity">
            {activity.slice(0, 30).map((a) => (
              <div key={`${a.kind}${a.id}`} className="act-row">
                <Icon name={a.kind === 'backtest' ? 'flask' : 'grid'} size={13} />
                <div className="rh-text" onClick={() => void openRun(a)} style={{ cursor: 'pointer' }}>
                  <div className="ellipsis small">{a.label}</div>
                  <div className="muted small">
                    {fmtAgo(a.created)} · {a.summary}
                  </div>
                </div>
                {selected && (
                  <button className="icon-btn small" data-tip="Link to the selected experiment" onClick={() => void api.call('experiments:link', selected.id, { kind: a.kind, id: a.id, label: a.label })}>
                    <Icon name="link" size={13} />
                  </button>
                )}
              </div>
            ))}
            {!activity.length && <div className="muted small">Backtests and optimizations appear here.</div>}
          </div>
        </div>
        <div className="exp-main">
          {selected ? <ExperimentEditor key={selected.id} exp={selected} sets={sets || []} activity={activity} onDeleted={() => setCfg({ selected: null })} /> : <Empty icon="notebook" title="Research notebook">Track ideas, link backtests and optimizations, keep notes and save parameter sets. Select or create an experiment.</Empty>}
        </div>
      </div>
    </div>
  );
}

async function openRun(a: { kind: string; id: string }): Promise<void> {
  if (a.kind === 'backtest') await openModule('backtest', { runId: a.id, tab: 'overview' });
  else if (a.kind === 'optimization') await openModule('optimizer', { runId: a.id, tab: 'results' });
}

function ExperimentEditor({ exp, sets, activity, onDeleted }: { exp: Experiment; sets: ParamSet[]; activity: Activity[]; onDeleted: () => void }) {
  const [title, setTitle] = useState(exp.title);
  const [notes, setNotes] = useState(exp.notes);
  const [tags, setTags] = useState(exp.tags.join(', '));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (patch: Partial<Experiment>) => void api.call('experiments:save', { id: exp.id, ...patch }).catch((e) => toast({ title: 'Save failed', body: errorMessage(e), kind: 'error' }));
  const debounced = (patch: Partial<Experiment>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(patch), 600);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const linkedScripts = new Set(exp.links.filter((l) => l.kind === 'script').map((l) => l.id));
  const relevantSets = sets.filter((s) => linkedScripts.size === 0 || linkedScripts.has(s.scriptId) || exp.links.some((l) => l.kind === 'paramset' && l.id === s.id));
  const summaryOf = (l: ExperimentLink) => activity.find((a) => a.kind === l.kind && a.id === l.id)?.summary;
  return (
    <div className="exp-editor">
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input exp-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            debounced({ title: e.target.value, notes, tags: tags.split(',').map((t) => t.trim()) });
          }}
        />
        <button
          className="icon-btn"
          data-tip="Delete experiment"
          onClick={() =>
            void confirmDialog({ title: `Delete “${exp.title}”?`, body: 'Linked runs are kept.', confirm: 'Delete', danger: true }).then(async (ok) => {
              if (!ok) return;
              await api.call('experiments:delete', exp.id);
              onDeleted();
            })
          }
        >
          <Icon name="trash" />
        </button>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Segmented size="sm" value={exp.status} options={STATUS} onChange={(s) => save({ status: s })} />
        <input
          className="input"
          style={{ flex: 1, minWidth: 160 }}
          placeholder="Tags, comma separated"
          value={tags}
          onChange={(e) => {
            setTags(e.target.value);
            debounced({ tags: e.target.value.split(',').map((t) => t.trim()), title, notes });
          }}
        />
      </div>
      <textarea
        className="input exp-notes"
        placeholder="Hypothesis, observations, next steps…"
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          debounced({ notes: e.target.value, title, tags: tags.split(',').map((t) => t.trim()) });
        }}
      />
      <div className="section-title">Linked</div>
      {!exp.links.length && <div className="muted small">Link runs from “Recent runs” on the left, or save parameter sets from the optimizer.</div>}
      {exp.links.map((l) => (
        <div key={`${l.kind}${l.id}`} className="act-row">
          <Icon name={l.kind === 'backtest' ? 'flask' : l.kind === 'optimization' ? 'grid' : l.kind === 'script' ? 'code' : 'sliders'} size={13} />
          <div className="rh-text" style={{ cursor: l.kind === 'backtest' || l.kind === 'optimization' ? 'pointer' : 'default' }} onClick={() => void openRun(l)}>
            <div className="ellipsis small">{l.label}</div>
            <div className="muted small">
              {l.kind} · linked {fmtAgo(l.added)}
              {summaryOf(l) ? ` · ${summaryOf(l)}` : ''}
            </div>
          </div>
          <button className="icon-btn small" onClick={() => void api.call('experiments:unlink', exp.id, l.kind, l.id)} data-tip="Remove link">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <div className="section-title">Parameter sets</div>
      {!relevantSets.length && <div className="muted small">No saved parameter sets yet — use “Save set” in the Optimizer or Strategy Tester.</div>}
      {relevantSets.map((s) => (
        <div key={s.id} className="act-row">
          <Icon name="sliders" size={13} />
          <div className="rh-text">
            <div className="ellipsis small">
              <b>{s.name}</b> · {s.scriptName}
            </div>
            <div className="muted small mono ellipsis">
              {Object.entries(s.inputs)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}
              {s.context?.symbol ? ` · ${s.context.symbol} ${s.context.tf}` : ''} · {fmtDateTime(s.created)}
            </div>
          </div>
          <button className="icon-btn small" data-tip="Apply to chart" onClick={() => applySetToChart(s)}>
            <Icon name="chart" size={13} />
          </button>
          <button className="icon-btn small" data-tip="Backtest" onClick={() => void openModule('backtest', { scriptId: s.scriptId, inputs: s.inputs, ...(s.context?.symbol ? { symbol: s.context.symbol, market: s.context.market, tf: s.context.tf } : {}), autorun: Date.now() })}>
            <Icon name="flask" size={13} />
          </button>
          <button className="icon-btn small" data-tip="Link to this experiment" onClick={() => void api.call('experiments:link', exp.id, { kind: 'paramset', id: s.id, label: `${s.name} (${s.scriptName})` })}>
            <Icon name="link" size={13} />
          </button>
          <button className="icon-btn small" data-tip="Delete set" onClick={() => void confirmDialog({ title: `Delete “${s.name}”?`, body: s.scriptName, confirm: 'Delete', danger: true }).then((ok) => ok && api.call('paramsets:delete', s.id))}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
