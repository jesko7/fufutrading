/**
 * Order-flow tools on a chart (HVN Profile, Heavy Absorption, Imbalance Levels, DOM): the data
 * subscriptions, the view handed to the chart engine, their legend rows and settings dialog.
 * They are indicator instances with script ids `of:<kind>`; the computing happens in the main
 * process on Binance trades and the live order book (see src/main/market/orderflow.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useApp } from '../../state/store';
import type { ChartEngine } from '../../chart/engine';
import type { OrderFlowView } from '../../chart/types';
import type { ChartModuleConfig, IndicatorInstance } from '../../../shared/workspace';
import { SYMBOL_SPECS } from '../../../shared/symbols';
import { ORDERFLOW_TOOLS, orderFlowKind, orderFlowInputs, niceStep, fmtFlowQty, type OrderFlowKind, type HvnLevel, type ImbalanceLevel, type AbsorptionEvent, type DomBook, type OrderFlowRequest } from '../../../shared/orderflow';
import { Icon } from '../../components/Icon';
import { Modal, openModal, Spinner, Menu, usePopover } from '../../components/ui';
import { clsx, fmtNum } from '../../lib/format';
import { InputControl } from './indicators';
import type { ScriptInputDef } from '../../../engine/types';

const HOUR = 3600000;
const PERIOD_MS: Record<string, number> = { '1h': HOUR, '4h': 4 * HOUR, '8h': 8 * HOUR, '1D': 24 * HOUR };
const QUANTILE: Record<string, number> = { Low: 0.99, Medium: 0.98, High: 0.95 };

export interface FlowStatus {
  phase: 'off' | 'loading' | 'ready' | 'error' | 'replay';
  /** Share of the history window loaded (0..1). */
  pct?: number;
  trades?: number;
  complete?: boolean;
  message?: string;
  rows?: { hvn: number | null; absorption: number | null; imbalance: number | null };
  thr?: number;
  dom?: string;
}

/** Status per chart module, for the legend rows and the settings dialog. */
const statusByModule = new Map<string, FlowStatus>();

function firstOf(list: IndicatorInstance[], kind: OrderFlowKind): IndicatorInstance | undefined {
  return list.find((i) => orderFlowKind(i.scriptId) === kind);
}

/** The engine request for a chart's order-flow tools (style inputs left out). */
function requestFor(cfg: ChartModuleConfig): OrderFlowRequest | null {
  const list = cfg.indicators || [];
  const h = firstOf(list, 'hvn');
  const a = firstOf(list, 'absorption');
  const m = firstOf(list, 'imbalance');
  if (!h && !a && !m) return null;
  const hi = h && orderFlowInputs('hvn', h.inputs);
  const ai = a && orderFlowInputs('absorption', a.inputs);
  const mi = m && orderFlowInputs('imbalance', m.inputs);
  return {
    symbol: cfg.symbol,
    market: cfg.market,
    tf: cfg.tf,
    hvn: hi ? { row: +hi.row || 0, periodMs: PERIOD_MS[hi.period] || 0, periods: +hi.periods, count: +hi.count, strength: +hi.strength, band: +hi.band, untilTouched: hi.extend !== 'Always' } : null,
    absorption: ai ? { row: +ai.row || 0, quantile: QUANTILE[ai.sensitivity] || 0.995, minVolume: +ai.minVolume || 0, gapMs: +ai.gap * 1000, holdMs: +ai.hold * 1000, tolerance: +ai.tolerance, bookOnly: !!ai.book } : null,
    imbalance: mi ? { row: +mi.row || 0, ratio: +mi.ratio, stack: +mi.stack, minVolume: +mi.minVolume || 0, maxLevels: +mi.maxLevels } : null,
  };
}

export function useOrderFlow(moduleId: string, cfg: ChartModuleConfig, eng: ChartEngine | null, replay: boolean): { version: number; active: boolean } {
  const [version, setVersion] = useState(0);
  const raf = useRef(0);
  const bump = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setVersion((v) => v + 1);
    });
  };
  const data = useRef<{ hvn: HvnLevel[]; imb: ImbalanceLevel[]; abs: Map<string, AbsorptionEvent>; thr: number; book: DomBook | null }>({ hvn: [], imb: [], abs: new Map(), thr: NaN, book: null });
  const list = cfg.indicators || [];
  const req = useMemo(() => requestFor(cfg), [cfg.symbol, cfg.market, cfg.tf, JSON.stringify(list.filter((i) => orderFlowKind(i.scriptId)).map((i) => [i.scriptId, i.inputs]))]);
  const reqKey = JSON.stringify(req);
  const domInd = firstOf(list, 'dom');
  const domIn = domInd ? orderFlowInputs('dom', domInd.inputs) : null;
  const any = !!req || !!domInd;
  const setStatus = (patch: Partial<FlowStatus>) => {
    statusByModule.set(moduleId, { ...(statusByModule.get(moduleId) || { phase: 'off' }), ...patch });
    bump();
  };

  // HVN Profile, Heavy Absorption, Imbalance Levels
  useEffect(() => {
    const d = data.current;
    d.hvn = [];
    d.imb = [];
    d.abs = new Map();
    d.thr = NaN;
    bump();
    if (!req) {
      setStatus({ phase: replay && domInd ? 'replay' : 'off', pct: undefined, rows: undefined, thr: undefined, message: undefined });
      return;
    }
    if (replay) {
      setStatus({ phase: 'replay' });
      return;
    }
    setStatus({ phase: 'loading', pct: 0, message: undefined });
    const unsub = api.sub<any>('orderflow', req, (m) => {
      if (m.__error) {
        setStatus({ phase: 'error', message: String(m.__error).replace(/^Validation: /, '') });
        return;
      }
      if (m.type === 'progress') {
        setStatus({ phase: statusByModule.get(moduleId)?.phase === 'ready' ? 'ready' : 'loading', pct: m.total > 0 ? Math.min(1, m.done / m.total) : 0, trades: m.trades, rows: m.rows, complete: false });
        return;
      }
      if (m.type === 'error') {
        setStatus({ phase: 'error', message: m.message, rows: m.rows });
        return;
      }
      if (m.type === 'snapshot') {
        d.hvn = m.hvn || [];
        d.imb = m.imb || [];
        d.abs = new Map((m.abs || []).map((e: AbsorptionEvent) => [e.id, e]));
        d.thr = m.thr ?? NaN;
        setStatus({ phase: 'ready', rows: m.rows, trades: m.trades, complete: m.complete, pct: m.complete ? 1 : statusByModule.get(moduleId)?.pct, thr: m.thr ?? undefined });
        return;
      }
      if (m.type === 'update') {
        if (m.hvn) d.hvn = m.hvn;
        if (m.imb) d.imb = m.imb;
        if (m.abs) for (const e of m.abs as AbsorptionEvent[]) d.abs.set(e.id, e);
        if (m.absRemoved) for (const id of m.absRemoved as string[]) d.abs.delete(id);
        if (m.thr !== undefined) {
          d.thr = m.thr ?? NaN;
          const st = statusByModule.get(moduleId);
          if (st) st.thr = m.thr ?? undefined;
        }
        bump();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, replay, moduleId]);

  // DOM: the live book, grouped to a step that follows the zoom
  const [domStep, setDomStep] = useState(0);
  useEffect(() => {
    if (!domInd || replay || !eng) {
      setDomStep(0);
      return;
    }
    const tick = SYMBOL_SPECS[cfg.symbol][cfg.market].tickSize;
    const check = () => {
      const price = eng.lastPrice;
      if (!(price > 0)) return;
      const fine = niceStep(price * 0.00001, tick);
      const want = niceStep(eng.domStepFor(fine), tick);
      setDomStep((cur) => (!cur || want > cur * 1.9 || want < cur * 0.45 ? want : cur));
    };
    check();
    const id = setInterval(check, 600);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!domInd, replay, eng, cfg.symbol, cfg.market]);
  useEffect(() => {
    data.current.book = null;
    bump();
    if (!domInd || replay || !domStep) return;
    const unsub = api.sub<any>('orderflow:dom', { symbol: cfg.symbol, market: cfg.market, step: domStep, intervalMs: domIn?.interval || 200 }, (m) => {
      if (m.__error) return;
      data.current.book = m.status === 'live' ? (m as DomBook) : null;
      const st = statusByModule.get(moduleId);
      if (st?.dom !== m.status) setStatus({ dom: m.status });
      else bump();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!domInd, replay, domStep, domIn?.interval, cfg.symbol, cfg.market, moduleId]);

  useEffect(
    () => () => {
      statusByModule.delete(moduleId);
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [moduleId],
  );

  // the view for the engine
  useEffect(() => {
    if (!eng) return;
    if (!any || replay) {
      eng.setOrderFlow(null);
      return;
    }
    const d = data.current;
    const vis = (k: OrderFlowKind) => {
      const i = firstOf(list, k);
      return i && i.visible !== false ? orderFlowInputs(k, i.inputs) : null;
    };
    const h = vis('hvn');
    const a = vis('absorption');
    const m = vis('imbalance');
    const o = vis('dom');
    const view: OrderFlowView = {
      unit: SYMBOL_SPECS[cfg.symbol].base,
      hvn: h ? { levels: d.hvn, color: h.color, labels: !!h.labels } : null,
      imb: m ? { levels: m.hideFilled ? d.imb.filter((z) => z.end === null) : d.imb, buy: m.buyColor, sell: m.sellColor } : null,
      abs: a ? { events: [...d.abs.values()].filter((e) => !a.book || (e.shown !== null && e.vol > e.shown)), thr: +a.minVolume > 0 ? +a.minVolume : d.thr, buy: a.buyColor, sell: a.sellColor, numbers: !!a.numbers } : null,
      dom: o ? { book: d.book, width: +o.width, bid: o.bidColor, ask: o.askColor, sqrt: o.scale === 'Square root' } : null,
    };
    eng.setOrderFlow(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, version, any, replay, JSON.stringify(list.filter((i) => orderFlowKind(i.scriptId)).map((i) => [i.scriptId, i.visible, i.inputs])), cfg.symbol]);

  return { version, active: any };
}

// ------------------------------------------------------------------ legend

function summary(kind: OrderFlowKind, inp: Record<string, any>, st: FlowStatus | undefined, unit: string): string {
  switch (kind) {
    case 'hvn':
      return `${inp.period} · ${inp.count}`;
    case 'absorption': {
      if (+inp.minVolume > 0) return `≥ ${fmtFlowQty(+inp.minVolume)} ${unit}`;
      return st?.thr !== undefined && Number.isFinite(st.thr) ? `${inp.sensitivity} · > ${fmtFlowQty(st.thr)} ${unit}` : `${inp.sensitivity}`;
    }
    case 'imbalance':
      return `${inp.ratio}× · ${inp.stack} rows`;
    case 'dom':
      return `${inp.width}%`;
  }
}

export function NativeLegendRow({ moduleId, ind, cfg, update }: { moduleId: string; ind: IndicatorInstance; cfg: ChartModuleConfig; update: (p: Partial<ChartModuleConfig>) => void }) {
  const kind = orderFlowKind(ind.scriptId)!;
  const tool = ORDERFLOW_TOOLS[kind];
  const menu = usePopover();
  const st = statusByModule.get(moduleId);
  const hidden = ind.visible === false;
  const inp = orderFlowInputs(kind, ind.inputs);
  const unit = SYMBOL_SPECS[cfg.symbol].base;
  const setInd = (patch: Partial<IndicatorInstance>) => update({ indicators: cfg.indicators.map((x) => (x.id === ind.id ? { ...x, ...patch } : x)) });
  const remove = () => update({ indicators: cfg.indicators.filter((x) => x.id !== ind.id) });
  const duplicate = firstOf(cfg.indicators || [], kind)?.id !== ind.id;
  let state: ReactNode = null;
  if (duplicate) state = <span className="muted">only the first {tool.name} on a chart is drawn</span>;
  else if (kind === 'dom') {
    if (st?.phase === 'replay') state = <span className="muted">live only</span>;
    else if (st?.dom && st.dom !== 'live') state = (
      <>
        <Spinner size={11} /> <span className="muted">order book {st.dom}</span>
      </>
    );
  } else if (st?.phase === 'replay') state = <span className="muted">live only, not part of the replay</span>;
  else if (st?.phase === 'loading' || (st?.phase === 'ready' && !st.complete))
    state = (
      <span className="of-load" data-tip="Binance aggregate trades: the newest come first, then older hours. Cached on disk for the next time.">
        <Spinner size={11} /> trades {Math.round((st.pct || 0) * 100)}%
      </span>
    );
  else if (st?.phase === 'error') state = <span className="ind-err">{st.message}</span>;
  return (
    <div className={clsx('ind-item', hidden && 'hidden')}>
      <span className="ind-name" onDoubleClick={() => openOrderFlowSettings(moduleId, ind.id)} data-tip={tool.description}>
        {tool.name}
      </span>
      <span className="muted">{summary(kind, inp, st, unit)}</span>
      <span className="ind-actions">
        <button className="icon-btn" onClick={() => setInd({ visible: hidden })} data-tip={hidden ? 'Show' : 'Hide'}>
          <Icon name={hidden ? 'eyeOff' : 'eye'} size={16} />
        </button>
        <button className="icon-btn" onClick={() => openOrderFlowSettings(moduleId, ind.id)} data-tip="Settings">
          <Icon name="gear" size={16} />
        </button>
        <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)} data-tip="More">
          <Icon name="more" size={16} />
        </button>
        <button className="icon-btn" onClick={remove} data-tip="Remove">
          <Icon name="x" size={16} />
        </button>
      </span>
      {state}
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          items={[
            { label: 'Reset settings to defaults', icon: 'refresh', onClick: () => setInd({ inputs: {} }) },
            { sep: true },
            { label: 'Remove', icon: 'trash', danger: true, onClick: remove },
          ]}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings

function OrderFlowSettings({ moduleId, indId, onClose }: { moduleId: string; indId: string; onClose: () => void }) {
  const ws = useApp((s) => s.workspace);
  const cfg = ws?.modules[moduleId]?.config as ChartModuleConfig | undefined;
  const ind = cfg?.indicators?.find((x) => x.id === indId);
  const original = useRef(ind ? JSON.parse(JSON.stringify(ind)) : null);
  if (!cfg || !ind) return null;
  const kind = orderFlowKind(ind.scriptId)!;
  const tool = ORDERFLOW_TOOLS[kind];
  const setInd = (patch: Partial<IndicatorInstance>) => useApp.getState().setModuleConfig(moduleId, { indicators: cfg.indicators.map((x) => (x.id === indId ? { ...x, ...patch } : x)) });
  const setInput = (key: string, v: unknown) => setInd({ inputs: { ...(ind.inputs || {}), [key]: v } });
  const cancel = () => {
    if (original.current) setInd(original.current);
    onClose();
  };
  const st = statusByModule.get(moduleId);
  const row = kind === 'dom' ? null : st?.rows?.[kind];
  const quote = SYMBOL_SPECS[cfg.symbol].quote;
  const groups = new Map<string, typeof tool.inputs>();
  for (const d of tool.inputs) {
    const g = d.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(d);
  }
  return (
    <Modal
      title={tool.name}
      icon="sliders"
      onClose={cancel}
      width={500}
      footer={
        <>
          <button className="btn" onClick={() => setInd({ inputs: {} })}>
            Defaults
          </button>
          <div className="spacer" />
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onClose}>
            OK
          </button>
        </>
      }
    >
      <div className="ind-settings">
        <div className="muted small of-desc">{tool.description}</div>
        {[...groups.entries()].map(([g, defs]) => (
          <div key={g} className="set-group">
            {g && <div className="set-group-title">{g}</div>}
            {defs.map((d) => (
              <label key={d.key} className="set-row" data-tip={d.tooltip}>
                <span>
                  {d.title}
                  {d.key === 'row' && row ? <span className="muted"> · now {fmtNum(row, row < 1 ? 2 : 0)} {quote}</span> : null}
                </span>
                <InputControl def={d as ScriptInputDef} value={ind.inputs?.[d.key]} onChange={(v) => setInput(d.key, v)} />
              </label>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function openOrderFlowSettings(moduleId: string, indId: string): void {
  openModal(`of-settings-${indId}`, (close) => <OrderFlowSettings moduleId={moduleId} indId={indId} onClose={close} />);
}
