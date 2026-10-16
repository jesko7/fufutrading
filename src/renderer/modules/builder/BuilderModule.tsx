import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { bus } from '../../lib/bus';
import { Icon } from '../../components/Icon';
import { Menu, usePopover, Popover, Segmented, Select, NumberField, Toggle, TimeframePicker } from '../../components/ui';
import { clsx } from '../../lib/format';
import { useSize } from '../../lib/hooks';
import { openModule } from '../../app/moduleOps';
import { openScriptInEditor, loadScripts, type AnalyzeResult } from '../scripts/client';
import { TEMPLATES, IND_LABEL, defaultInd, emptyGroup, generate, operandLabel, validate, type BuilderModel, type Cmp, type Cond, type Group, type IndKind, type Operand, type PriceField } from '../../../shared/builder';
import './builder.css';

const CMP_LABEL: Record<Cmp, string> = { crossAbove: 'crosses above', crossBelow: 'crosses below', above: 'is above', below: 'is below' };

const fail = (title: string) => (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export function BuilderModule({ module }: ModuleProps) {
  const cfg = module.config as { model?: BuilderModel | null };
  const model: BuilderModel = cfg.model || clone(TEMPLATES[0].model);
  const setModel = (m: BuilderModel) => useApp.getState().setModuleConfig(module.id, { model: m });
  const patch = (p: Partial<BuilderModel>) => setModel({ ...model, ...p });
  const code = useMemo(() => generate(model), [model]);
  const problems = useMemo(() => validate(model), [model]);
  const [check, setCheck] = useState<AnalyzeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const tpl = usePopover();
  const [ref, size] = useSize<HTMLDivElement>();
  const narrow = size.width > 0 && size.width < 760;
  const [showCode, setShowCode] = useState(true);

  // compile the generated code (debounced) so problems show right away
  useEffect(() => {
    setCheck(null);
    if (problems.length) return;
    const t = setTimeout(() => {
      void api
        .call<AnalyzeResult>('scripts:analyze', model.language, code, { symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' })
        .then(setCheck)
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [code, model.language, problems.length]);

  const save = async (): Promise<string | null> => {
    if (problems.length) {
      toast({ title: 'Fix the flow first', body: problems[0], kind: 'warn' });
      return null;
    }
    setBusy(true);
    try {
      const meta = await api.call<{ id: string; name: string }>('scripts:save', { name: model.name, code, language: model.language });
      await loadScripts(true);
      toast({ title: 'Saved to the script library', body: meta.name, kind: 'ok', action: { label: 'Open', run: () => void openScriptInEditor(meta.id) } });
      return meta.id;
    } catch (e) {
      fail('Not saved')(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={clsx('builder', narrow && 'narrow')} ref={ref}>
      <div className="mod-toolbar builder-bar">
        <button className="btn small ghost" onClick={(e) => tpl.toggle(e.currentTarget)}>
          <Icon name="layers" size={13} /> Templates
        </button>
        {tpl.anchor && (
          <Menu
            anchor={tpl.anchor}
            onClose={tpl.close}
            width={230}
            items={[{ title: 'Start from a template' }, ...TEMPLATES.map((t) => ({ label: t.label, icon: 'flow', onClick: () => setModel({ ...clone(t.model), language: model.language }) }))]}
          />
        )}
        <Segmented
          size="sm"
          value={model.language}
          onChange={(l) => patch({ language: l })}
          options={[
            { value: 'pine', label: 'Pine Script' },
            { value: 'python', label: 'Python' },
          ]}
        />
        <span className="spacer" />
        {narrow && (
          <button className={clsx('btn small ghost', showCode && 'on')} onClick={() => setShowCode(!showCode)}>
            <Icon name="code" size={13} /> Code
          </button>
        )}
        <button className="btn small ghost" onClick={() => bus.emit('ai:open', { prompt: 'Review this strategy from the flowchart builder: explain what it does, backtest it on BTC and ETH over the last year and suggest concrete improvements.', mode: 'plan', send: true, context: { selection: code } }, false)} data-tip="Ask Claude to review and test it">
          <Icon name="spark" size={13} />
        </button>
        <button className="btn small ghost" disabled={!!problems.length} onClick={() => void openScriptInEditor(null, { draft: { language: model.language, code, name: model.name } })} data-tip="Open the generated code in the Script Editor">
          <Icon name="code" size={13} /> Edit code
        </button>
        <button className="btn small" disabled={busy || !!problems.length} onClick={() => void save()}>
          <Icon name="save" size={13} /> Save
        </button>
        <button
          className="btn small primary"
          disabled={busy || !!problems.length || (check !== null && !check.ok)}
          onClick={async () => {
            const id = await save();
            if (id) void openModule('backtest', { scriptId: id, inputs: {}, runId: null, autorun: Date.now() });
          }}
        >
          <Icon name="flask" size={13} /> Backtest
        </button>
      </div>
      <div className="builder-body">
        <div className="builder-flow">
          <div className="flow-name">
            <input className="input" value={model.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Strategy name" />
          </div>
          <Node icon="zap" title="On every bar close" tone="start">
            <div className="faint small">The strategy evaluates its rules when a bar closes; orders fill from the next bar’s open.</div>
          </Node>
          <Arrow />
          <Node icon="trend" title="Trend filter" tone="filter" right={<Toggle value={model.filter.enabled} onChange={(v) => patch({ filter: { ...model.filter, enabled: v } })} />}>
            {model.filter.enabled ? (
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="faint small">Longs only above, shorts only below the</span>
                <NumberField value={model.filter.len} onChange={(v) => patch({ filter: { ...model.filter, len: Math.max(1, Math.round(v)) } })} min={1} decimals={0} style={{ width: 70 }} />
                <span className="faint small">EMA on</span>
                <TimeframePicker tf={model.filter.tf} onChange={(tf) => patch({ filter: { ...model.filter, tf } })} quick={['1h', '4h', '1D']} />
                <span className="faint small">(confirmed bars only)</span>
              </div>
            ) : (
              <div className="faint small">Off — entries ignore the higher-timeframe trend.</div>
            )}
          </Node>
          <Arrow />
          <div className="flow-split">
            <div className="flow-col">
              <Node icon="arrowUp" title="Long entry" tone="long" right={<Toggle value={model.long.enabled} onChange={(v) => patch({ long: { ...model.long, enabled: v } })} />}>
                {model.long.enabled ? <GroupEditor g={model.long.when} onChange={(g) => patch({ long: { ...model.long, when: g } })} /> : <div className="faint small">No long trades.</div>}
              </Node>
              {model.long.enabled && (
                <>
                  <Arrow label="buy" />
                  <Node icon="arrowDown" title="Long exit" tone="exit">
                    <GroupEditor g={model.exitLong} onChange={(g) => patch({ exitLong: g })} empty="Only the risk rules (or a short entry) close longs." />
                  </Node>
                </>
              )}
            </div>
            <div className="flow-col">
              <Node icon="arrowDown" title="Short entry" tone="short" right={<Toggle value={model.short.enabled} onChange={(v) => patch({ short: { ...model.short, enabled: v } })} />}>
                {model.short.enabled ? <GroupEditor g={model.short.when} onChange={(g) => patch({ short: { ...model.short, when: g } })} /> : <div className="faint small">No short trades (spot accounts can’t short).</div>}
              </Node>
              {model.short.enabled && (
                <>
                  <Arrow label="sell" />
                  <Node icon="arrowUp" title="Short exit" tone="exit">
                    <GroupEditor g={model.exitShort} onChange={(g) => patch({ exitShort: g })} empty="Only the risk rules (or a long entry) close shorts." />
                  </Node>
                </>
              )}
            </div>
          </div>
          <Arrow />
          <Node icon="shield" title="Risk & size" tone="risk">
            <div className="flow-risk">
              <RiskField label="Stop loss" value={model.risk.stopPct} onChange={(v) => patch({ risk: { ...model.risk, stopPct: v } })} />
              <RiskField label="Take profit" value={model.risk.takePct} onChange={(v) => patch({ risk: { ...model.risk, takePct: v } })} />
              <RiskField label="Trailing stop" value={model.risk.trailPct} onChange={(v) => patch({ risk: { ...model.risk, trailPct: v } })} />
              <label className="row" style={{ gap: 6 }}>
                <span className="faint small">Size</span>
                <NumberField value={model.risk.sizePct} onChange={(v) => patch({ risk: { ...model.risk, sizePct: Math.max(1, Math.min(100, v)) } })} min={1} max={100} decimals={0} suffix="% equity" style={{ width: 120 }} />
              </label>
            </div>
          </Node>
          {(problems.length > 0 || (check && !check.ok)) && (
            <div className="flow-problems">
              {problems.map((p) => (
                <div key={p}>
                  <Icon name="alert" size={12} /> {p}
                </div>
              ))}
              {check && !check.ok && (
                <div>
                  <Icon name="alert" size={12} /> Generated code: {check.error?.message}
                </div>
              )}
            </div>
          )}
        </div>
        {(!narrow || showCode) && (
          <div className="builder-code">
            <div className="row code-head">
              <Icon name="code" size={13} />
              <b>{model.language === 'python' ? 'Python' : 'Pine Script'}</b>
              <span className={clsx('small', check ? (check.ok ? 'up' : 'danger-text') : 'faint')}>{problems.length ? '' : check ? (check.ok ? `compiles · ${check.inputs.length} inputs` : 'error') : 'checking…'}</span>
              <span className="spacer" />
              <button className="btn tiny ghost" onClick={() => void navigator.clipboard.writeText(code).then(() => toast({ title: 'Code copied', kind: 'ok' }))}>
                Copy
              </button>
            </div>
            <pre className="code-pre">{code}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Node({ icon, title, tone, right, children }: { icon: string; title: string; tone: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('flow-node', `t-${tone}`)}>
      <div className="flow-node-head">
        <span className="flow-ic">
          <Icon name={icon} size={12} />
        </span>
        <b>{title}</b>
        <span className="spacer" />
        {right}
      </div>
      <div className="flow-node-body">{children}</div>
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flow-arrow">
      <span />
      {label && <em>{label}</em>}
    </div>
  );
}

function RiskField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="row" style={{ gap: 6 }}>
      <Toggle value={value !== null} onChange={(on) => onChange(on ? (label === 'Take profit' ? 4 : 2) : null)} />
      <span className="faint small">{label}</span>
      {value !== null && <NumberField value={value} onChange={(v) => onChange(Math.max(0.1, v))} min={0.1} step={0.5} decimals={2} suffix="%" style={{ width: 86 }} />}
    </label>
  );
}

function GroupEditor({ g, onChange, empty }: { g: Group; onChange: (g: Group) => void; empty?: string }) {
  const setCond = (k: number, c: Cond) => onChange({ ...g, conds: g.conds.map((x, i) => (i === k ? c : x)) });
  return (
    <div className="flow-group">
      {g.conds.length > 1 && (
        <Segmented
          size="sm"
          value={g.op}
          onChange={(op) => onChange({ ...g, op })}
          options={[
            { value: 'and', label: 'All of' },
            { value: 'or', label: 'Any of' },
          ]}
        />
      )}
      {!g.conds.length && empty && <div className="faint small">{empty}</div>}
      {g.conds.map((c, k) => (
        <div key={k} className="flow-cond">
          <OperandButton o={c.left} onChange={(o) => setCond(k, { ...c, left: o })} />
          <Select value={c.cmp} onChange={(cmp) => setCond(k, { ...c, cmp })} options={(Object.keys(CMP_LABEL) as Cmp[]).map((x) => ({ value: x, label: CMP_LABEL[x] }))} />
          <OperandButton o={c.right} onChange={(o) => setCond(k, { ...c, right: o })} />
          <button className="icon-btn small" onClick={() => onChange({ ...g, conds: g.conds.filter((_, i) => i !== k) })} data-tip="Remove">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      <button className="btn tiny ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange({ ...g, conds: [...g.conds, { left: { kind: 'price', field: 'close' }, cmp: 'crossAbove', right: defaultInd('ema') }] })}>
        <Icon name="plus" size={11} /> Condition
      </button>
    </div>
  );
}

const IND_GROUPS: { label: string; kinds: IndKind[] }[] = [
  { label: 'Trend', kinds: ['sma', 'ema', 'vwap', 'supertrend', 'highest', 'lowest'] },
  { label: 'Momentum', kinds: ['rsi', 'macd', 'macdSignal', 'macdHist', 'stochK', 'stochD'] },
  { label: 'Volatility', kinds: ['bbUpper', 'bbBasis', 'bbLower', 'atr'] },
  { label: 'Volume', kinds: ['volume', 'volumeSma'] },
  { label: 'Futures positioning', kinds: ['oi', 'oiSma', 'oiChange', 'lsr', 'topPos'] },
];

function OperandButton({ o, onChange }: { o: Operand; onChange: (o: Operand) => void }) {
  const pop = usePopover();
  return (
    <>
      <button className={clsx('operand', o.kind)} onClick={(e) => pop.toggle(e.currentTarget)}>
        {operandLabel(o)}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={300}>
          <div className="pop-pad">
            <Segmented
              size="sm"
              value={o.kind}
              onChange={(k) => onChange(k === 'price' ? { kind: 'price', field: 'close' } : k === 'value' ? { kind: 'value', v: 50 } : defaultInd('ema'))}
              options={[
                { value: 'ind', label: 'Indicator' },
                { value: 'price', label: 'Price' },
                { value: 'value', label: 'Value' },
              ]}
            />
            {o.kind === 'price' && (
              <label className="set-row">
                <span>Price</span>
                <Select value={o.field} onChange={(f: PriceField) => onChange({ kind: 'price', field: f })} options={(['close', 'open', 'high', 'low'] as PriceField[]).map((f) => ({ value: f, label: f[0].toUpperCase() + f.slice(1) }))} />
              </label>
            )}
            {o.kind === 'value' && (
              <label className="set-row">
                <span>Value</span>
                <NumberField value={o.v} onChange={(v) => onChange({ kind: 'value', v })} decimals={4} style={{ width: 120 }} />
              </label>
            )}
            {o.kind === 'ind' && (
              <>
                <label className="set-row">
                  <span>Indicator</span>
                  <Select value={o.ind} onChange={(k: IndKind) => onChange(defaultInd(k))} options={IND_GROUPS.flatMap((g) => g.kinds.map((k) => ({ value: k, label: `${g.label} · ${IND_LABEL[k]}` })))} />
                </label>
                {o.len !== undefined && <ParamRow label={o.ind.startsWith('macd') ? 'Fast length' : o.ind === 'supertrend' ? 'ATR length' : 'Length'} value={o.len} onChange={(v) => onChange({ ...o, len: v })} />}
                {o.len2 !== undefined && <ParamRow label={o.ind.startsWith('macd') ? 'Slow length' : '%K smoothing'} value={o.len2} onChange={(v) => onChange({ ...o, len2: v })} />}
                {o.len3 !== undefined && <ParamRow label={o.ind.startsWith('macd') ? 'Signal length' : '%D smoothing'} value={o.len3} onChange={(v) => onChange({ ...o, len3: v })} />}
                {o.mult !== undefined && (
                  <label className="set-row">
                    <span>{o.ind === 'supertrend' ? 'Factor' : 'Width (σ)'}</span>
                    <NumberField value={o.mult} onChange={(v) => onChange({ ...o, mult: Math.max(0.1, v) })} step={0.1} decimals={2} style={{ width: 90 }} />
                  </label>
                )}
                {o.src !== undefined && (
                  <label className="set-row">
                    <span>Source</span>
                    <Select value={o.src} onChange={(s: PriceField) => onChange({ ...o, src: s })} options={(['close', 'open', 'high', 'low'] as PriceField[]).map((f) => ({ value: f, label: f }))} />
                  </label>
                )}
                {(o.ind === 'highest' || o.ind === 'lowest') && (
                  <label className="set-row" data-tip="Exclude the current bar so a breakout above the previous high can trigger">
                    <span>Exclude current bar</span>
                    <Toggle value={!!o.offset} onChange={(v) => onChange({ ...o, offset: v ? 1 : 0 })} />
                  </label>
                )}
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

function ParamRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="set-row">
      <span>{label}</span>
      <NumberField value={value} onChange={(v) => onChange(Math.max(1, Math.round(v)))} min={1} decimals={0} style={{ width: 90 }} />
    </label>
  );
}

export { emptyGroup };
