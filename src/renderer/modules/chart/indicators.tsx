/**
 * Chart scripting integration: live indicator/strategy subscriptions (results + tail patches
 * from the main process), conversion into drawable outputs aligned to the chart's bars,
 * per-pane legends with values under the crosshair, the indicator picker and the settings
 * dialog (inputs, style, strategy properties).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import type { IndicatorOutput, PlotSeries, ShapeSeries, PlotType, ShapeStyle, ShapeLocation } from '../../chart/types';
import type { BarStore } from '../../chart/barStore';
import { formatVolume } from '../../chart/scale';
import type { ChartModuleConfig, IndicatorInstance } from '../../../shared/workspace';
import { newId } from '../../../shared/workspace';
import type { ScriptResult, ScriptInputDef, ScriptPlot } from '../../../engine/types';
import { applyPatch } from '../../../engine/patch';
import { bus } from '../../lib/bus';
import { Icon } from '../../components/Icon';
import { Modal, openModal, NumberField, Toggle, Select, Tabs, Spinner, Empty, Menu, usePopover, Popover, promptDialog } from '../../components/ui';
import { clsx, fmtNum, autoDecimals, fmtPct, fmtSignedUsd, orderIdLabel } from '../../lib/format';
import { useScripts, openScriptInEditor, loadScripts, type ScriptMeta } from '../scripts/client';
import { openRepaintCheck, warningKinds } from '../scripts/repaint';
import { STANDARD_TIMEFRAMES } from '../../../shared/timeframes';
import { ORDERFLOW_KINDS, ORDERFLOW_TOOLS, orderFlowKind, type OrderFlowTool } from '../../../shared/orderflow';
import { NativeLegendRow, openOrderFlowSettings } from './orderflow';

// ------------------------------------------------------------------ live state

interface Live {
  result: ScriptResult | null;
  t0: number;
  status: 'loading' | 'running' | 'error';
  error?: string;
  script?: { id: string | null; name: string; language: string };
}

/** Live states by `${moduleId}/${instanceId}` (read by the settings dialog). */
const registry = new Map<string, Live>();

function seriesSpec(cfg: ChartModuleConfig) {
  const ct = cfg.chartType === 'heikinashi' || cfg.chartType === 'renko' ? cfg.chartType : 'candles';
  return { symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: ct, renko: cfg.chartType === 'renko' ? cfg.renko || { atrLength: 14 } : undefined };
}

export function useChartIndicators(moduleId: string, cfg: ChartModuleConfig, storeRef: { current: BarStore }, dataVersion: number, liveTick: number, replay: { active: boolean; ref?: { session: string; epoch: number } | null }): { outputs: IndicatorOutput[]; lives: Map<string, Live> } {
  const subs = useRef(new Map<string, { hash: string; unsub: () => void }>());
  const lives = useRef(new Map<string, Live>());
  const [version, setVersion] = useState(0);
  const raf = useRef(0);
  const bump = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setVersion((v) => v + 1);
    });
  };
  const spec = useMemo(() => seriesSpec(cfg), [cfg.symbol, cfg.market, cfg.tf, cfg.chartType, JSON.stringify(cfg.renko)]);
  const indicators = cfg.indicators || [];

  useEffect(() => {
    const want = new Map<string, string>();
    // in replay, scripts run on the replay session's series (nothing beyond the replay point)
    const rref = replay.active ? replay.ref || null : null;
    if (!replay.active || rref) for (const ind of indicators) if (!orderFlowKind(ind.scriptId)) want.set(ind.id, JSON.stringify([ind.scriptId, ind.inputs, ind.strategy ?? null, spec, rref]));
    for (const [id, s] of subs.current) {
      if (want.get(id) !== s.hash) {
        s.unsub();
        subs.current.delete(id);
      }
    }
    for (const id of [...lives.current.keys()]) if (!want.has(id)) {
      lives.current.delete(id);
      registry.delete(`${moduleId}/${id}`);
    }
    for (const ind of indicators) {
      const hash = want.get(ind.id);
      if (!hash || subs.current.has(ind.id)) continue;
      const prev = lives.current.get(ind.id);
      const st: Live = { result: prev?.result ?? null, t0: prev?.t0 ?? NaN, status: 'loading', script: prev?.script };
      lives.current.set(ind.id, st);
      registry.set(`${moduleId}/${ind.id}`, st);
      const unsub = api.sub<any>('indicator', { scriptId: ind.scriptId, inputs: ind.inputs || {}, strategy: ind.strategy ?? undefined, spec, replay: rref || undefined }, (msg) => {
        if (msg.__error) {
          st.status = 'error';
          st.error = String(msg.__error).replace(/^Validation: /, '');
        } else if (msg.type === 'full') {
          st.result = msg.result;
          st.t0 = msg.t0;
          st.status = msg.result.ok ? 'running' : 'error';
          st.error = msg.result.ok ? undefined : formatError(msg.result);
          if (msg.script) st.script = msg.script;
        } else if (msg.type === 'patch') {
          if (st.result) {
            st.result = applyPatch(st.result, msg.patch);
            st.t0 = msg.patch.t0;
            st.status = msg.patch.ok ? 'running' : 'error';
            st.error = msg.patch.ok ? undefined : formatError(st.result);
          }
        } else if (msg.type === 'status') {
          st.status = msg.status === 'running' ? 'running' : 'loading';
          if (msg.script) st.script = msg.script;
        } else if (msg.type === 'error') {
          st.status = 'error';
          st.error = msg.message;
        }
        bump();
      });
      subs.current.set(ind.id, { hash, unsub });
    }
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(indicators.map((i) => [i.id, i.scriptId, i.inputs, i.strategy ?? null])), spec, replay.active, replay.ref?.session, replay.ref?.epoch, moduleId]);

  useEffect(
    () => () => {
      for (const s of subs.current.values()) s.unsub();
      subs.current.clear();
      for (const id of lives.current.keys()) registry.delete(`${moduleId}/${id}`);
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [moduleId],
  );

  const outputs = useMemo(() => {
    const store = storeRef.current;
    const out: IndicatorOutput[] = [];
    for (const ind of indicators) {
      const live = lives.current.get(ind.id);
      const o = toOutput(ind, live, store);
      if (o) out.push(o);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, dataVersion, JSON.stringify(indicators.map((i) => [i.id, i.visible, i.styles]))]);
  void liveTick;
  return { outputs, lives: lives.current };
}

function formatError(r: ScriptResult): string {
  const e = r.error;
  if (!e) return 'Script error';
  return `${e.line ? `Line ${e.line}: ` : ''}${e.message}${e.bar !== undefined && !/bar \d/.test(e.message) ? ` (bar ${e.bar})` : ''}`;
}

// ------------------------------------------------------------------ result → drawable output

const PLOT_TYPES = new Set<PlotType>(['line', 'linebr', 'stepline', 'histogram', 'columns', 'area', 'areabr', 'circles', 'cross']);
const SHAPES = new Set<ShapeStyle>(['triangleup', 'triangledown', 'circle', 'cross', 'xcross', 'arrowup', 'arrowdown', 'labelup', 'labeldown', 'square', 'diamond', 'flag', 'char']);

function plotType(style: string): PlotType {
  const s = style.replace(/^style_/, '');
  if (PLOT_TYPES.has(s as PlotType)) return s as PlotType;
  if (s.startsWith('stepline')) return 'stepline';
  if (s === 'histogram' || s === 'hist') return 'histogram';
  return 'line';
}

function shiftNum(a: Float64Array, off: number): Float64Array {
  if (off === 0) return a;
  const out = new Float64Array(a.length + off).fill(NaN);
  out.set(a, off);
  return out;
}

function shiftArr<T>(a: T[] | null | undefined, off: number): T[] | undefined {
  if (!a) return undefined;
  if (off === 0) return a;
  return (new Array(off).fill(null) as T[]).concat(a);
}

function chartIndexOf(store: BarStore, t: number): number {
  let lo = 0;
  let hi = store.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const v = store.t[m];
    if (v === t) return m;
    if (v < t) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}

function toOutput(ind: IndicatorInstance, live: Live | undefined, store: BarStore): IndicatorOutput | null {
  // order-flow tools draw through the engine's own layer; they only need a legend row
  const of = orderFlowKind(ind.scriptId);
  if (of) return { id: ind.id, title: ORDERFLOW_TOOLS[of].name, overlay: true, plots: [], shapes: [], hlines: [], fills: [], visible: ind.visible !== false };
  const r = live?.result;
  const name = r?.meta.shortTitle || live?.script?.name || 'Script';
  const base: IndicatorOutput = { id: ind.id, title: name, shortTitle: name, overlay: r ? r.meta.overlay : true, plots: [], shapes: [], hlines: [], fills: [], visible: ind.visible !== false, error: live?.error };
  if (!r || !r.ok) return base;
  const off = store.length ? chartIndexOf(store, live!.t0) : 0;
  if (off < 0) return base; // chart and script data momentarily out of sync
  const styles = ind.styles || {};
  const plots: PlotSeries[] = [];
  const shapes: ShapeSeries[] = [];
  for (const p of r.plots) {
    const st = styles[p.id] || {};
    const visible = st.visible ?? (p.display && !p.legendOnly);
    if (p.kind === 'candle' || p.kind === 'bar') {
      plots.push({ id: p.id, title: p.title, type: p.kind === 'candle' ? 'candles' : 'bars', values: shiftNum(p.values, off), o: p.o && shiftNum(p.o, off), h: p.h && shiftNum(p.h, off), l: p.l && shiftNum(p.l, off), color: st.color || p.color, colors: st.color ? undefined : shiftArr(p.colors, off), width: 1, offset: 0, visible, precision: r.meta.precision });
    } else if (p.kind === 'plot') {
      plots.push({ id: p.id, title: p.title, type: plotType(p.style), values: shiftNum(p.values, off), color: st.color || p.color, colors: st.color ? undefined : shiftArr(p.colors, off), width: st.width ?? p.width, offset: p.offset, histbase: p.histbase, visible, trackPrice: p.trackPrice, precision: r.meta.precision });
    } else if (p.kind === 'arrow') {
      const up = new Float64Array(p.values.length).fill(NaN);
      const dn = new Float64Array(p.values.length).fill(NaN);
      p.values.forEach((v, i) => {
        if (v > 0) up[i] = 1;
        else if (v < 0) dn[i] = 1;
      });
      if (!visible) continue;
      shapes.push({ id: `${p.id}u`, title: p.title, style: 'arrowup', location: 'belowbar', values: shiftNum(up, off), color: p.colorup || '#089981', size: 'small', offset: p.offset });
      shapes.push({ id: `${p.id}d`, title: p.title, style: 'arrowdown', location: 'abovebar', values: shiftNum(dn, off), color: p.colordown || '#F23645', size: 'small', offset: p.offset });
    } else {
      if (!visible) continue;
      const style = (p.kind === 'char' ? 'char' : SHAPES.has(p.style as ShapeStyle) ? p.style : 'circle') as ShapeStyle;
      const loc = (['abovebar', 'belowbar', 'top', 'bottom', 'absolute'].includes(p.location || '') ? p.location : 'abovebar') as ShapeLocation;
      const size = (['tiny', 'small', 'normal', 'large', 'huge'].includes(p.size || '') ? p.size : 'small') as ShapeSeries['size'];
      shapes.push({ id: p.id, title: p.title, style, location: loc, values: shiftNum(p.values, off), color: st.color || p.color, colors: st.color ? undefined : shiftArr(p.colors, off), text: p.text, char: p.char, textColor: p.textColor, size, offset: p.offset });
    }
  }
  const o: IndicatorOutput = {
    ...base,
    plots,
    shapes,
    hlines: r.hlines.filter((h) => h.display && (styles[h.id]?.visible ?? true)).map((h) => ({ id: h.id, price: h.price, color: styles[h.id]?.color || h.color, style: (h.style as 'solid' | 'dashed' | 'dotted') || 'dashed', width: h.width, title: h.title })),
    fills: r.fills.map((f) => ({ a: f.a, b: f.b, color: f.color, colors: shiftArr(f.colors, off) })),
    bgcolors: shiftArr(r.bgcolors, off),
    barcolors: shiftArr(r.barcolors, off),
    labels: r.labels.map((l) => ({ ...l, x: l.x + off, yloc: l.yloc as 'price' | 'abovebar' | 'belowbar' })),
    lines: r.lines.map((l) => ({ ...l, x1: l.x1 + off, x2: l.x2 + off, style: l.style as never, extend: l.extend as never })),
    boxes: r.boxes.map((b) => ({ ...b, left: b.left + off, right: b.right + off, extend: b.extend as never })),
    tables: r.tables,
    polys: r.polys,
    scaleMin: r.meta.scaleMin,
    scaleMax: r.meta.scaleMax,
    precision: r.meta.precision,
    format: r.meta.format,
    warnings: r.warnings.filter((w) => w.kind === 'lookahead' || w.kind === 'repaint' || w.kind === 'runtime'),
  };
  // the fills reference plot ids; hidden plots keep their data so fills still work
  if (r.strategy) {
    const last = store.length - 1;
    o.trades = [
      ...r.strategy.trades.map((t) => ({ entryIndex: t.entryBar + off, exitIndex: t.exitBar + off, entryPrice: t.entryPrice, exitPrice: t.exitPrice, dir: t.dir, pnl: t.profit, entryLabel: t.entryId, exitLabel: orderIdLabel(t.exitId) })),
      ...r.strategy.openTrades.map((t) => ({ entryIndex: t.entryBar + off, exitIndex: last, entryPrice: t.entryPrice, exitPrice: store.c[last], dir: t.dir, pnl: (store.c[last] - t.entryPrice) * t.dir, entryLabel: t.entryId, open: true })),
    ];
  }
  return o;
}

// ------------------------------------------------------------------ strategy summary

export function strategySummary(r: ScriptResult): { net: number; netPct: number; trades: number; winRate: number; pf: number; mdd: number; mddPct: number } | null {
  const s = r.strategy;
  if (!s) return null;
  const trades = s.trades;
  const net = trades.reduce((a, t) => a + t.profit, 0);
  const wins = trades.filter((t) => t.profit > 0);
  const gw = wins.reduce((a, t) => a + t.profit, 0);
  const gl = -trades.filter((t) => t.profit < 0).reduce((a, t) => a + t.profit, 0);
  let peak = s.initialCapital;
  let mdd = 0;
  let mddPct = 0;
  for (const e of s.equity) {
    if (!(e === e)) continue;
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > mdd) mdd = dd;
    if (peak > 0 && dd / peak > mddPct) mddPct = dd / peak;
  }
  return { net, netPct: net / s.initialCapital, trades: trades.length, winRate: trades.length ? wins.length / trades.length : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, mdd, mddPct };
}

// ------------------------------------------------------------------ legends

function inputSummary(r: ScriptResult | null, ind: IndicatorInstance): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const d of r.inputs) {
    if (parts.length >= 4) break;
    const v = ind.inputs?.[d.key] ?? d.defval;
    if (d.type === 'bool' || d.type === 'color' || d.type === 'text_area' || d.type === 'session' || d.type === 'time') continue;
    if (v === '' || v === null || v === undefined) continue;
    parts.push(typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2, 0) : String(v).replace(/^BINANCE:/, ''));
  }
  return parts.join(' ');
}

function valueAt(p: ScriptPlot, off: number, index: number): number {
  // strategies only run on closed bars: past the end, show the last computed value
  const k = Math.min(index - off, p.values.length - 1) - (p.offset || 0);
  return k >= 0 && k < p.values.length ? p.values[k] : NaN;
}

function LegendRow({ moduleId, ind, live, output, index, store, cfg, update }: { moduleId: string; ind: IndicatorInstance; live: Live | undefined; output: IndicatorOutput | undefined; index: number; store: BarStore; cfg: ChartModuleConfig; update: (p: Partial<ChartModuleConfig>) => void }) {
  const r = live?.result || null;
  const menu = usePopover();
  const name = r?.meta.shortTitle || live?.script?.name || 'Loading…';
  const off = r && store.length ? Math.max(0, chartIndexOf(store, live!.t0)) : 0;
  const hidden = ind.visible === false;
  const setInd = (patch: Partial<IndicatorInstance>) => update({ indicators: cfg.indicators.map((x) => (x.id === ind.id ? { ...x, ...patch } : x)) });
  const remove = () => update({ indicators: cfg.indicators.filter((x) => x.id !== ind.id) });
  const sum = r?.strategy ? strategySummary(r) : null;
  const warn = output?.warnings || [];
  const wk = warningKinds(warn);
  const checkRepaint = () =>
    openRepaintCheck({
      scriptId: ind.scriptId,
      name: live?.script?.name || name,
      inputs: ind.inputs || {},
      spec: seriesSpec(cfg),
      strategy: ind.strategy ? (ind.strategy as never) : undefined,
      warnings: r?.ok ? warn : undefined,
    });
  const values: ReactNode[] = [];
  if (r && r.ok && !hidden) {
    const fmt = (v: number) => (!Number.isFinite(v) ? '∅' : r.meta.format === 'volume' ? formatVolume(v) : `${fmtNum(v, r.meta.precision ?? autoDecimals(v))}${r.meta.format === 'percent' ? '%' : ''}`);
    for (const p of r.plots) {
      if (values.length >= 8) break;
      const st = ind.styles?.[p.id];
      if (!(st?.visible ?? p.display) || (p.kind !== 'plot' && p.kind !== 'candle' && p.kind !== 'bar')) continue;
      const k = index - off;
      const col = (p.colors && k >= 0 ? p.colors[k] : null) || st?.color || p.color;
      if (p.kind !== 'plot') {
        // plotcandle / plotbar: O H L C like the main series legend
        const at = (a: Float64Array | undefined) => (a ? valueAt({ ...p, values: a }, off, index) : NaN);
        const c = valueAt(p, off, index);
        if (!Number.isFinite(c)) continue;
        values.push(
          <span key={p.id} className="ind-val" style={{ color: col || undefined }} data-tip={p.title}>
            O {fmt(at(p.o))} H {fmt(at(p.h))} L {fmt(at(p.l))} C {fmt(c)}
          </span>,
        );
        continue;
      }
      const v = valueAt(p, off, index);
      values.push(
        <span key={p.id} className="ind-val" style={{ color: col || undefined }} data-tip={p.title}>
          {fmt(v)}
        </span>,
      );
    }
  }
  return (
    <div className={clsx('ind-item', hidden && 'hidden')}>
      <span className="ind-name" onDoubleClick={() => openIndicatorSettings(moduleId, ind.id)} data-tip={live?.script?.language === 'python' ? 'Python script' : 'Pine Script'}>
        {name}
      </span>
      {r && <span className="muted">{inputSummary(r, ind)}</span>}
      <span className="ind-actions">
        <button className="icon-btn" onClick={() => setInd({ visible: hidden })} data-tip={hidden ? 'Show' : 'Hide'}>
          <Icon name={hidden ? 'eyeOff' : 'eye'} size={16} />
        </button>
        <button className="icon-btn" onClick={() => openIndicatorSettings(moduleId, ind.id)} data-tip="Settings">
          <Icon name="gear" size={16} />
        </button>
        <button className="icon-btn" onClick={() => void openScriptInEditor(ind.scriptId)} data-tip="Source code">
          <Icon name="code" size={16} />
        </button>
        <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)} data-tip="More">
          <Icon name="more" size={16} />
        </button>
        <button className="icon-btn" onClick={remove} data-tip="Remove">
          <Icon name="x" size={16} />
        </button>
      </span>
      {live?.status === 'loading' && <Spinner size={11} />}
      {values}
      {sum && (
        <span className={clsx('ind-val', sum.net >= 0 ? 'pos' : 'neg')} data-tip={`${sum.trades} trades · win rate ${fmtPct(sum.winRate * 100, 0, false)} · profit factor ${Number.isFinite(sum.pf) ? sum.pf.toFixed(2) : '∞'} · max drawdown ${fmtPct(sum.mddPct * 100, 1, false)}`}>
          {fmtSignedUsd(sum.net)} ({fmtPct(sum.netPct * 100, 1)}) · {sum.trades} trades
        </span>
      )}
      {warn.length > 0 && (
        <button
          className={clsx('ind-warn', wk.lookahead ? 'lookahead' : wk.repaint ? 'repaint' : 'note')}
          onClick={checkRepaint}
          data-tip={`${wk.lookahead ? `Lookahead: uses data that did not exist yet at the bar${wk.repaint ? ' · may repaint live' : ''}` : wk.repaint ? 'May repaint: live values can differ from the history' : warn.map((w) => w.message).join('\n')}${wk.lookahead || wk.repaint ? '\nClick for details and a live replay check' : ''}`}
        >
          <Icon name="alert" size={12} />
        </button>
      )}
      {live?.status === 'error' && (
        <button className="ind-err link-btn" onClick={() => void openScriptInEditor(ind.scriptId, { line: r?.error?.line })} data-tip="Open in the script editor">
          {live.error}
        </button>
      )}
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          items={[
            { label: 'Duplicate', icon: 'copy', onClick: () => update({ indicators: [...cfg.indicators, { ...JSON.parse(JSON.stringify(ind)), id: newId('i') }] }) },
            { label: 'Reset inputs to defaults', icon: 'refresh', onClick: () => setInd({ inputs: {} }) },
            { label: 'Check for repainting…', icon: 'replay', onClick: checkRepaint },
            ...(r?.strategy ? [{ label: 'Open in Strategy Tester', icon: 'flask', onClick: () => void openStrategyTester(cfg, ind) }] : []),
            {
              label: 'Add alert…',
              icon: 'bell',
              onClick: () => {
                const tf = cfg.tf;
                const common = { scriptId: ind.scriptId, scriptName: live?.script?.name, inputs: ind.inputs || {}, tf, chartType: cfg.chartType === 'heikinashi' ? 'heikinashi' : 'candles', onBarClose: true };
                if (r?.strategy) bus.emit('alerts:new', { kind: 'script', symbol: cfg.symbol, market: cfg.market, patch: { ...common, trigger: { type: 'orders' } } }, false);
                else if (r?.alerts.length) bus.emit('alerts:new', { kind: 'script', symbol: cfg.symbol, market: cfg.market, patch: { ...common, trigger: { type: 'alertcondition', title: r.alerts[0].title } } }, false);
                else {
                  const p = r?.plots.find((x) => x.kind === 'plot');
                  bus.emit('alerts:new', { kind: 'indicator', symbol: cfg.symbol, market: cfg.market, patch: { ...common, plot: p?.id || '', plotTitle: p?.title } }, false);
                }
              },
            },
            { sep: true },
            { label: 'Remove', icon: 'trash', danger: true, onClick: remove },
          ]}
        />
      )}
    </div>
  );
}

async function openStrategyTester(cfg: ChartModuleConfig, ind: IndicatorInstance): Promise<void> {
  const { openModule } = await import('../../app/moduleOps');
  await openModule('backtest', { scriptId: ind.scriptId, inputs: ind.inputs || {}, symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, autorun: Date.now() });
}

export interface PaneGeo {
  id: string;
  top: number;
  height: number;
}

/** Legend rows for overlay indicators (rendered inside the main chart legend). */
/**
 * Legend rows for overlay indicators. They stay inside the main pane: rows that don't fit move
 * into a "+N more" list, and the whole list can be collapsed to one line.
 */
export function IndicatorLegend({ moduleId, cfg, outputs, lives, index, store, update, maxRows = 99 }: { moduleId: string; cfg: ChartModuleConfig; outputs: IndicatorOutput[]; lives: Map<string, Live>; index: number; store: BarStore; update: (p: Partial<ChartModuleConfig>) => void; maxRows?: number }) {
  const more = usePopover();
  const byId = new Map(outputs.map((o) => [o.id, o]));
  const rows = (cfg.indicators || []).filter((ind) => byId.get(ind.id)?.overlay !== false);
  if (!rows.length) return null;
  const collapsed = !!cfg.legendCollapsed;
  const fit = rows.length > maxRows ? Math.max(0, maxRows - 1) : rows.length;
  const row = (ind: IndicatorInstance) =>
    orderFlowKind(ind.scriptId) ? <NativeLegendRow key={ind.id} moduleId={moduleId} ind={ind} cfg={cfg} update={update} /> : <LegendRow key={ind.id} moduleId={moduleId} ind={ind} live={lives.get(ind.id)} output={byId.get(ind.id)} index={index} store={store} cfg={cfg} update={update} />;
  const warned = rows.some((ind) => (byId.get(ind.id)?.warnings || []).some((w) => w.kind === 'lookahead'));
  return (
    <div className="ind-legend">
      {(collapsed || rows.length > 1) && (
        <button className={clsx('ind-collapse', warned && collapsed && 'warned')} onClick={() => update({ legendCollapsed: !collapsed })} data-tip={collapsed ? 'Show the indicator legend' : 'Collapse the indicator legend'}>
          <Icon name={collapsed ? 'chevRight' : 'chevDown'} size={12} />
          {collapsed && `${rows.length} indicator${rows.length > 1 ? 's' : ''}`}
        </button>
      )}
      {!collapsed && rows.slice(0, fit).map(row)}
      {!collapsed && fit < rows.length && (
        <button className="ind-more" onClick={(e) => more.toggle(e.currentTarget)}>
          +{rows.length - fit} more
        </button>
      )}
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} width={420}>
          <div className="ind-more-list">{rows.slice(fit).map(row)}</div>
        </Popover>
      )}
    </div>
  );
}

/** Legends placed at the top of each indicator pane. */
export function PaneLegends({ moduleId, cfg, outputs, lives, index, store, update, panes }: { moduleId: string; cfg: ChartModuleConfig; outputs: IndicatorOutput[]; lives: Map<string, Live>; index: number; store: BarStore; update: (p: Partial<ChartModuleConfig>) => void; panes: PaneGeo[] }) {
  const byId = new Map(outputs.map((o) => [o.id, o]));
  return (
    <>
      {panes.slice(1).map((p) => {
        const ind = (cfg.indicators || []).find((x) => x.id === p.id);
        if (!ind) return null;
        return (
          <div key={p.id} className="pane-legend" style={{ top: p.top + 4, maxHeight: Math.max(16, p.height - 6) }}>
            <LegendRow moduleId={moduleId} ind={ind} live={lives.get(ind.id)} output={byId.get(ind.id)} index={index} store={store} cfg={cfg} update={update} />
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ picker

const CATEGORY_ORDER = ['Favorites', 'My scripts', 'Order flow', 'Trend', 'Oscillators', 'Volatility', 'Volume', 'Patterns', 'Futures', 'Order book', 'Statistics', 'Structure', 'Multi-timeframe', 'Strategies', 'Python'];

export function addIndicator(moduleId: string, scriptId: string): void {
  const st = useApp.getState();
  const m = st.workspace?.modules[moduleId];
  if (!m) return;
  const cur = (m.config.indicators || []) as IndicatorInstance[];
  // one of each order-flow tool per chart
  if (orderFlowKind(scriptId) && cur.some((x) => x.scriptId === scriptId)) return;
  st.setModuleConfig(moduleId, { indicators: [...cur, { id: newId('i'), scriptId, inputs: {}, visible: true }] });
}

/** Open the AI Studio to build an indicator for this chart (sent right away when there is a description). */
function askAIToBuild(moduleId: string, what: string, close: () => void): void {
  const m = useApp.getState().workspace?.modules[moduleId];
  const c = m?.config as ChartModuleConfig | undefined;
  const chart = c ? { symbol: c.symbol, market: c.market, tf: c.tf } : undefined;
  close();
  bus.emit(
    'ai:open',
    what
      ? { prompt: `Build an indicator: ${what}. Check it on real data and add it to my chart.`, context: chart ? { chart } : undefined, mode: 'build', send: true }
      : { prompt: 'Build an indicator that ', context: chart ? { chart } : undefined, mode: 'build', send: false },
    false,
  );
}

function IndicatorPicker({ moduleId, onClose }: { moduleId: string; onClose: () => void }) {
  const scripts = useScripts();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('All');
  const [added, setAdded] = useState<Record<string, number>>({});
  const [sel, setSel] = useState(0);
  const list = useMemo(() => {
    const all = scripts || [];
    const needle = q.trim().toLowerCase();
    return all
      .filter((s) => s.kind === 'indicator' || s.kind === 'strategy' || s.kind === 'unknown')
      .filter((s) => (cat === 'All' ? true : cat === 'Favorites' ? s.favorite : cat === 'My scripts' ? !s.builtin : s.category === cat))
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.description || '').toLowerCase().includes(needle) || (s.category || '').toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.favorite) - Number(a.favorite) || Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  }, [scripts, q, cat]);
  const flows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (cat !== 'All' && cat !== 'Order flow') return [];
    return ORDERFLOW_KINDS.map((k) => ORDERFLOW_TOOLS[k]).filter((t) => !needle || `${t.name} ${t.description} order flow orderflow`.toLowerCase().includes(needle));
  }, [q, cat]);
  const onChart = new Set(((useApp.getState().workspace?.modules[moduleId]?.config.indicators || []) as IndicatorInstance[]).map((x) => x.scriptId));
  const addFlow = (t: OrderFlowTool) => {
    addIndicator(moduleId, t.id);
    setAdded((a) => ({ ...a, [t.id]: 1 }));
  };
  const cats = useMemo(() => {
    const present = new Set((scripts || []).map((s) => (s.builtin ? s.category || 'Other' : 'My scripts')));
    present.add('Order flow');
    return ['All', 'Favorites', ...CATEGORY_ORDER.filter((c) => c !== 'Favorites' && present.has(c)), ...[...present].filter((c) => !CATEGORY_ORDER.includes(c))];
  }, [scripts]);
  const add = (s: ScriptMeta) => {
    addIndicator(moduleId, s.id);
    setAdded((a) => ({ ...a, [s.id]: (a[s.id] || 0) + 1 }));
  };
  const star = (s: ScriptMeta) => void api.call('scripts:setFlag', s.id, 'favorite', !s.favorite).then(() => loadScripts(true));
  useEffect(() => setSel(0), [q, cat]);
  return (
    <Modal title="Indicators & strategies" icon="flow" onClose={onClose} width={760}>
      <div className="picker">
        <div className="picker-cats">
          {cats.map((c) => (
            <button key={c} className={clsx('picker-cat', c === cat && 'on')} onClick={() => setCat(c)}>
              {c === 'Favorites' ? <Icon name="star" size={13} /> : null}
              {c}
            </button>
          ))}
        </div>
        <div className="picker-main">
          <input
            className="input"
            autoFocus
            placeholder="Search scripts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((x) => Math.min(flows.length + list.length - 1, x + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((x) => Math.max(0, x - 1));
              } else if (e.key === 'Enter' && sel < flows.length) addFlow(flows[sel]);
              else if (e.key === 'Enter' && list[sel - flows.length]) add(list[sel - flows.length]);
            }}
          />
          <div className="picker-list">
            {!scripts && <Spinner />}
            {flows.map((t, k) => (
              <div key={t.id} className={clsx('picker-row', k === sel && 'sel')} onClick={() => addFlow(t)} onMouseEnter={() => setSel(k)}>
                <span className="lang-badge flow" data-tip="Native order-flow tool: Binance trades and the live order book">
                  Flow
                </span>
                <div className="picker-text">
                  <div className="picker-name">
                    {t.name}
                    {added[t.id] || onChart.has(t.id) ? <span className="tag ok">on chart</span> : null}
                  </div>
                  <div className="picker-desc">{t.description}</div>
                </div>
              </div>
            ))}
            {scripts && !list.length && !flows.length && (
              <Empty icon="search" title="No scripts found">
                {q.trim() ? (
                  <>
                    <div>Nothing matches “{q.trim()}”. Claude can build it, check it on real data and add it to this chart.</div>
                    <button className="btn small primary" style={{ marginTop: 10 }} onClick={() => askAIToBuild(moduleId, q.trim(), onClose)}>
                      <Icon name="spark" size={13} /> Build “{q.trim().slice(0, 40)}” with AI
                    </button>
                  </>
                ) : (
                  'Try another search or create a new script.'
                )}
              </Empty>
            )}
            {list.map((s, k) => (
              <div key={s.id} className={clsx('picker-row', k + flows.length === sel && 'sel')} onClick={() => add(s)} onMouseEnter={() => setSel(k + flows.length)}>
                <span className={clsx('lang-badge', s.language)}>{s.language === 'python' ? 'Py' : 'Pine'}</span>
                <div className="picker-text">
                  <div className="picker-name">
                    {s.name}
                    {s.kind === 'strategy' && <span className="tag">strategy</span>}
                    {added[s.id] ? <span className="tag ok">added{added[s.id] > 1 ? ` ×${added[s.id]}` : ''}</span> : null}
                  </div>
                  {s.description && <div className="picker-desc">{s.description}</div>}
                </div>
                <button
                  className={clsx('icon-btn', s.favorite && 'on')}
                  onClick={(e) => {
                    e.stopPropagation();
                    star(s);
                  }}
                  data-tip={s.favorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Icon name="star" size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                    void openScriptInEditor(s.id);
                  }}
                  data-tip="Open source"
                >
                  <Icon name="code" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="picker-foot">
            <button
              className="btn small"
              onClick={() => {
                onClose();
                void openScriptInEditor(null);
              }}
            >
              <Icon name="plus" size={14} /> New script
            </button>
            <button
              className="btn small"
              onClick={() =>
                void api
                  .call<ScriptMeta[]>('scripts:import')
                  .then((l) => {
                    if (l.length) toast({ title: `Imported ${l.length} script${l.length > 1 ? 's' : ''}`, kind: 'ok' });
                    return loadScripts(true);
                  })
                  .catch((e) => toast({ title: 'Import failed', body: errorMessage(e), kind: 'error' }))
              }
            >
              <Icon name="upload" size={14} /> Import .pine / .py
            </button>
            <button className="btn small" onClick={() => askAIToBuild(moduleId, '', onClose)} data-tip="Describe an indicator or strategy; Claude writes, checks and adds it">
              <Icon name="spark" size={14} /> Create with AI
            </button>
            <div className="spacer" />
            <span className="muted small">Enter adds the highlighted script · click adds · ★ favorites</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function openIndicatorPicker(moduleId: string, _cfg?: ChartModuleConfig): void {
  void loadScripts(true);
  openModal(`ind-picker-${moduleId}`, (close) => <IndicatorPicker moduleId={moduleId} onClose={close} />);
}

// ------------------------------------------------------------------ settings dialog

const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
const SYMBOL_OPTIONS = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P', 'BINANCE:SOLUSDT.P'];

function cssToHex(c: string): string {
  if (/^#[0-9a-f]{6}/i.test(c)) return c.slice(0, 7);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return '#2196f3';
  return `#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}`;
}

export function InputControl({ def, value, onChange }: { def: ScriptInputDef; value: unknown; onChange: (v: unknown) => void }) {
  const v = value ?? def.defval;
  if (def.options && def.options.length && def.type !== 'bool') {
    return <Select value={String(v)} options={def.options.map((o) => ({ value: String(o), label: String(o).replace(/^[A-Za-z_]+\./, '') }))} onChange={(x) => onChange(def.type === 'int' || def.type === 'float' ? Number(x) : x)} />;
  }
  switch (def.type) {
    case 'int':
    case 'float':
    case 'price':
      return <NumberField value={Number(v)} onChange={(x) => onChange(def.type === 'int' ? Math.round(x) : x)} step={def.step ?? (def.type === 'int' ? 1 : 0.1)} min={def.min} max={def.max} decimals={def.type === 'int' ? 0 : 6} />;
    case 'bool':
      return <Toggle value={!!v} onChange={onChange} />;
    case 'source':
      return <Select value={String(v)} options={SOURCES.map((s) => ({ value: s, label: s }))} onChange={onChange} />;
    case 'color':
      return <input type="color" className="color-input" value={cssToHex(String(v))} onChange={(e) => onChange(e.target.value)} />;
    case 'timeframe':
      return <Select value={String(v)} options={[{ value: '', label: 'Chart' }, ...STANDARD_TIMEFRAMES.map((t) => ({ value: t, label: t }))].concat(v && !STANDARD_TIMEFRAMES.includes(String(v)) ? [{ value: String(v), label: String(v) }] : [])} onChange={onChange} />;
    case 'symbol':
      return <Select value={String(v)} options={[...new Set([...SYMBOL_OPTIONS, String(v)])].map((s) => ({ value: s, label: s.replace('BINANCE:', '') }))} onChange={onChange} />;
    case 'text_area':
      return <textarea className="input" rows={3} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input className="input" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
  }
}

function IndicatorSettings({ moduleId, indId, onClose }: { moduleId: string; indId: string; onClose: () => void }) {
  const ws = useApp((s) => s.workspace);
  const cfg = ws?.modules[moduleId]?.config as ChartModuleConfig | undefined;
  const ind = cfg?.indicators?.find((x) => x.id === indId);
  const original = useRef(ind ? JSON.parse(JSON.stringify(ind)) : null);
  const [tab, setTab] = useState<'inputs' | 'style' | 'properties'>('inputs');
  const live = registry.get(`${moduleId}/${indId}`);
  const r = live?.result || null;
  if (!cfg || !ind) return null;
  const setInd = (patch: Partial<IndicatorInstance>) => useApp.getState().setModuleConfig(moduleId, { indicators: cfg.indicators.map((x) => (x.id === indId ? { ...x, ...patch } : x)) });
  const setInput = (key: string, v: unknown) => setInd({ inputs: { ...(ind.inputs || {}), [key]: v } });
  const setStyle = (id: string, patch: { color?: string; width?: number; visible?: boolean }) => setInd({ styles: { ...(ind.styles || {}), [id]: { ...(ind.styles?.[id] || {}), ...patch } } });
  const cancel = () => {
    if (original.current) setInd(original.current);
    onClose();
  };
  const groups = new Map<string, ScriptInputDef[]>();
  for (const d of r?.inputs || []) {
    const g = d.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(d);
  }
  const isStrategy = r?.meta.type === 'strategy';
  const strat = ind.strategy || {};
  const setStrat = (patch: Record<string, unknown>) => setInd({ strategy: { ...strat, ...patch } });
  return (
    <Modal
      title={r?.meta.title || live?.script?.name || 'Indicator'}
      icon="sliders"
      onClose={cancel}
      width={520}
      footer={
        <>
          <button className="btn" onClick={() => setInd({ inputs: {}, styles: {}, strategy: undefined })}>
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
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'inputs', label: 'Inputs' },
          { value: 'style', label: 'Style' },
          ...(isStrategy ? [{ value: 'properties' as const, label: 'Properties' }] : []),
        ]}
      />
      <div className="ind-settings">
        {!r && (
          <div className="muted">
            <Spinner /> Waiting for the script to run…
          </div>
        )}
        {tab === 'inputs' && r && (
          <>
            <ParamSetPicker scriptId={ind.scriptId} onPick={(inputs) => setInd({ inputs: { ...inputs } })} current={ind.inputs || {}} scriptName={r.meta.title} />
            {!r.inputs.length && <div className="muted">This script has no inputs.</div>}
            {[...groups.entries()].map(([g, defs]) => (
              <div key={g} className="set-group">
                {g && <div className="set-group-title">{g}</div>}
                {defs.map((d) => (
                  <label key={d.key} className="set-row" data-tip={d.tooltip}>
                    <span>{d.title}</span>
                    <InputControl def={d} value={ind.inputs?.[d.key]} onChange={(v) => setInput(d.key, v)} />
                  </label>
                ))}
              </div>
            ))}
          </>
        )}
        {tab === 'style' && r && (
          <div className="set-group">
            {r.plots.map((p) => {
              const st = ind.styles?.[p.id] || {};
              return (
                <div key={p.id} className="set-row">
                  <Toggle value={st.visible ?? (p.display && !p.legendOnly)} onChange={(v) => setStyle(p.id, { visible: v })} />
                  <span>{p.title}</span>
                  <input type="color" className="color-input" value={cssToHex(st.color || p.color)} onChange={(e) => setStyle(p.id, { color: e.target.value })} />
                  {p.kind === 'plot' && <NumberField value={st.width ?? p.width} onChange={(w) => setStyle(p.id, { width: Math.max(1, Math.min(6, Math.round(w))) })} min={1} max={6} decimals={0} style={{ width: 70 }} />}
                </div>
              );
            })}
            {r.hlines.map((h) => {
              const st = ind.styles?.[h.id] || {};
              return (
                <div key={h.id} className="set-row">
                  <Toggle value={st.visible ?? true} onChange={(v) => setStyle(h.id, { visible: v })} />
                  <span>
                    {h.title} <span className="muted">({fmtNum(h.price, autoDecimals(h.price))})</span>
                  </span>
                  <input type="color" className="color-input" value={cssToHex(st.color || h.color)} onChange={(e) => setStyle(h.id, { color: e.target.value })} />
                </div>
              );
            })}
          </div>
        )}
        {tab === 'properties' && r && (
          <div className="set-group">
            <div className="muted small" style={{ marginBottom: 6 }}>
              Overrides for this chart only. Leave empty to use the values declared in the script.
            </div>
            <label className="set-row">
              <span>Initial capital</span>
              <NumberField value={(strat.initialCapital as number) ?? r.strategy?.initialCapital ?? 10000} onChange={(v) => setStrat({ initialCapital: Math.max(1, v) })} min={1} step={1000} decimals={2} />
            </label>
            <label className="set-row">
              <span>Commission per side (%)</span>
              <NumberField value={strat.takerFee !== undefined ? (strat.takerFee as number) * 100 : ((r.strategy?.config.takerFee as number) ?? 0) * 100} onChange={(v) => setStrat({ takerFee: Math.max(0, v) / 100, makerFee: Math.max(0, v) / 100 })} min={0} step={0.01} decimals={4} />
            </label>
            <label className="set-row">
              <span>Slippage (ticks)</span>
              <NumberField value={(strat.slippageTicks as number) ?? ((r.strategy?.config.slippageTicks as number) || 0)} onChange={(v) => setStrat({ slippageTicks: Math.max(0, Math.round(v)) })} min={0} decimals={0} />
            </label>
            <label className="set-row">
              <span>Market</span>
              <Select value={(strat.market as string) || 'auto'} options={[{ value: 'auto', label: `Chart (${cfg.market})` }, { value: 'spot', label: 'Spot (no leverage, no shorts)' }, { value: 'futures', label: 'Futures (margin, funding, liquidation)' }]} onChange={(m) => setStrat({ market: m === 'auto' ? undefined : m })} />
            </label>
            <label className="set-row">
              <span>Leverage (futures)</span>
              <NumberField value={(strat.leverage as number) ?? 1} onChange={(v) => setStrat({ leverage: Math.max(1, Math.min(125, Math.round(v))) })} min={1} max={125} decimals={0} />
            </label>
            <label className="set-row">
              <span>Allow shorts on spot (margin)</span>
              <Toggle value={!!strat.allowShortSpot} onChange={(v) => setStrat({ allowShortSpot: v })} />
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ParamSetPicker({ scriptId, onPick, current, scriptName }: { scriptId: string; onPick: (inputs: Record<string, unknown>) => void; current: Record<string, unknown>; scriptName: string }) {
  const [sets, setSets] = useState<{ id: string; name: string; inputs: Record<string, unknown>; context?: { symbol?: string; tf?: string } }[] | null>(null);
  useEffect(() => {
    const load = () => void api.call<any[]>('paramsets:list', scriptId).then(setSets).catch(() => setSets([]));
    load();
    return api.on('paramsets:changed', load);
  }, [scriptId]);
  const menu = usePopover();
  return (
    <div className="row" style={{ gap: 6, marginBottom: 4 }}>
      <button className="btn small ghost" onClick={(e) => menu.toggle(e.currentTarget)} disabled={!sets}>
        <Icon name="sliders" size={13} /> Parameter sets{sets?.length ? ` (${sets.length})` : ''}
      </button>
      <button
        className="btn small ghost"
        onClick={async () => {
          const name = await promptDialog({ title: 'Save current inputs as a set', label: 'Name', initial: scriptName });
          if (name) await api.call('paramsets:save', { scriptId, scriptName, name, inputs: current, source: { kind: 'manual' } });
        }}
      >
        <Icon name="save" size={13} /> Save
      </button>
      {menu.anchor && sets && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          width={300}
          items={sets.length ? sets.map((s) => ({ label: s.name, hint: s.context?.symbol ? `${s.context.symbol} ${s.context.tf}` : undefined, onClick: () => onPick(s.inputs) })) : [{ label: 'No saved sets for this script', disabled: true }]}
        />
      )}
    </div>
  );
}

export function openIndicatorSettings(moduleId: string, indId: string): void {
  const ind = ((useApp.getState().workspace?.modules[moduleId]?.config.indicators || []) as IndicatorInstance[]).find((x) => x.id === indId);
  if (ind && orderFlowKind(ind.scriptId)) return openOrderFlowSettings(moduleId, indId);
  openModal(`ind-settings-${indId}`, (close) => <IndicatorSettings moduleId={moduleId} indId={indId} onClose={close} />);
}

export type { Live };
