/**
 * ChartEngine — fast canvas chart with an index-based x axis (like TradingView), so regular
 * candles, custom timeframes and Renko bricks share one coordinate system.
 *
 * Layers: `base` (grid, data, indicators, axes) is redrawn when data/viewport changes;
 * `overlay` (crosshair, drawings, trade lines, tool previews) is redrawn on pointer moves.
 */
import { serverNow } from '../lib/clock';
import { PriceScale, timeTicks, decimalsForStep, formatAxis, formatVolume } from './scale';
import type {
  ChartBars,
  ChartTheme,
  CompareSeries,
  CrosshairInfo,
  Drawing,
  DrawingType,
  Execution,
  FootprintBar,
  FootprintOptions,
  IndicatorOutput,
  MtfSeries,
  ScaleMode,
  SeriesStyle,
  TradeLine,
  LevelLine,
  LevelBand,
  VolumeProfileOptions,
} from './types';
import { drawSeries, drawVolume } from './drawSeries';
import { drawIndicatorBase, indicatorRange } from './drawPlots';
import { drawCompare, drawMtf, drawVolumeProfile, drawTradeLines, drawExecutions, hitTradeLine, drawStrategyTrades, drawLevels } from './drawExtras';
import { DrawingLayer } from './drawings';
import { drawFootprint } from './drawFootprint';
import { fmtDateTime, timeParts } from '../lib/format';

/** A sub-pane value in its indicator's format: indicator(format=format.volume) shows K/M/B. */
function paneValue(pane: { id: string; indicators: { format?: string }[] }, v: number, dec: number): string {
  const f = pane.id === 'main' ? undefined : pane.indicators[0]?.format;
  if (f === 'volume') return formatVolume(v);
  return f === 'percent' ? `${formatAxis(v, dec)}%` : formatAxis(v, dec);
}

export interface Pane {
  id: string; // 'main' or indicator id
  scale: PriceScale;
  top: number;
  height: number;
  /** relative weight for sub panes */
  weight: number;
  indicators: IndicatorOutput[];
}

export interface RenderCtx {
  ctx: CanvasRenderingContext2D;
  theme: ChartTheme;
  bars: ChartBars;
  i0: number;
  i1: number;
  x: (i: number) => number;
  barSpacing: number;
  bodyW: number;
  plotW: number;
  pane: Pane;
  priceDecimals: number;
  dpr: number;
}

/** Momentum after a flick: the release velocity is scaled down and decays with this time constant (ms). */
const GLIDE_SCALE = 0.5;
const GLIDE_MS = 140;

export interface EngineCallbacks {
  onCrosshair?(info: CrosshairInfo | null): void;
  onNeedHistory?(): void;
  onViewChange?(): void;
  onContextMenu?(info: { x: number; y: number; clientX: number; clientY: number; price: number; time: number; drawingId?: string; tradeLineId?: string }): void;
  onDrawingsChange?(drawings: Drawing[]): void;
  /** Ctrl/Cmd+Z, +Shift+Z / +Y, +C, +V while the chart has focus; true when handled. */
  onEditCommand?(cmd: 'undo' | 'redo' | 'copy' | 'paste', selectedDrawing: string | null): boolean;
  onDrawingSelect?(id: string | null): void;
  onToolDone?(): void;
  onTradeLineDrag?(id: string, price: number): void;
  onTradeLineCancel?(id: string): void;
  onBracketCreate?(positionId: string, kind: 'sl' | 'tp', price: number): void;
  onPickBar?(time: number, index: number): void;
  onDoubleClick?(info: { price: number; time: number }): void;
  /** Pane geometry changed (CSS px relative to the chart element). */
  onLayout?(panes: { id: string; top: number; height: number }[]): void;
}

const AXIS_W_MIN = 58;
const TIME_AXIS_H = 24;
const PANE_GAP = 1;

export class ChartEngine {
  readonly el: HTMLElement;
  private base: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private dpr = 1;
  width = 0;
  height = 0;
  axisW = 64;
  theme: ChartTheme;
  bars: ChartBars = { t: new Float64Array(0), o: new Float64Array(0), h: new Float64Array(0), l: new Float64Array(0), c: new Float64Array(0), v: new Float64Array(0), tbv: new Float64Array(0), length: 0 };
  style: SeriesStyle = 'candles';
  priceDecimals = 2;
  tick = 0.01;
  tfMs = 60000;
  barSpacing = 8;
  rightOffset = 6;
  showVolume = true;
  panes: Pane[] = [];
  indicators: IndicatorOutput[] = [];
  compare: CompareSeries[] = [];
  mtf: MtfSeries[] = [];
  tradeLines: TradeLine[] = [];
  executions: Execution[] = [];
  volumeProfile: VolumeProfileOptions = { mode: 'off', rows: 24, valueArea: 70 };
  footprint: { bars: Map<number, FootprintBar>; opts: FootprintOptions } | null = null;
  barCloseTime: number | null = null;
  lastPrice = NaN;
  syncedCrosshairTime: number | null = null;
  pickBarMode = false;
  replayCut: number | null = null;
  readonly drawings: DrawingLayer;
  private cb: EngineCallbacks;
  private dirtyBase = true;
  private dirtyOver = true;
  private raf = 0;
  private mouse: { x: number; y: number; inside: boolean } = { x: -1, y: -1, inside: false };
  private drag: null | {
    kind: 'pan' | 'priceAxis' | 'timeAxis' | 'paneSplit' | 'tradeLine' | 'bracket';
    x0: number;
    y0: number;
    v0: number;
    v1?: number;
    pane?: Pane;
    id?: string;
    price?: number;
    splitIndex?: number;
    weights?: number[];
    kindSub?: 'sl' | 'tp';
    /** pan: undecided until the pointer moved a few pixels; 'x' scrolls time only, 'free' moves the price too. */
    axis?: 'undecided' | 'x' | 'free';
    /** pan: recent (time, right offset, price-scale minimum) samples for momentum after release. */
    trail?: [number, number, number][];
  } = null;
  /** Momentum after a flick: bars per ms sideways, price units per ms up and down (decaying). */
  private glide: { v: number; vy: number; last: number; raf: number } | null = null;
  /** Smooth scroll to a right offset. */
  private scrollAnim = 0;
  private ro: ResizeObserver;
  private destroyed = false;
  private needHistoryFired = false;
  magnet = false;
  private hoverTradeLine: string | null = null;

  constructor(el: HTMLElement, theme: ChartTheme, cb: EngineCallbacks = {}) {
    this.el = el;
    this.theme = theme;
    this.cb = cb;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    this.base = document.createElement('canvas');
    this.over = document.createElement('canvas');
    for (const c of [this.base, this.over]) {
      c.style.position = 'absolute';
      c.style.left = '0';
      c.style.top = '0';
      el.appendChild(c);
    }
    this.over.style.cursor = 'crosshair';
    this.over.tabIndex = 0;
    this.over.style.outline = 'none';
    this.bctx = this.base.getContext('2d', { alpha: false })!;
    this.octx = this.over.getContext('2d')!;
    this.drawings = new DrawingLayer(this);
    this.panes = [{ id: 'main', scale: new PriceScale(), top: 0, height: 1, weight: 1, indicators: [] }];
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.bindEvents();
    this.resize();
  }

  // ------------------------------------------------------------------ public API

  setCallbacks(cb: EngineCallbacks): void {
    this.cb = cb;
  }

  setTheme(theme: ChartTheme): void {
    this.theme = theme;
    this.invalidate();
  }

  setData(bars: ChartBars, opts: { keepView?: boolean; prepended?: number } = {}): void {
    const prevLen = this.bars.length;
    this.bars = bars;
    if (opts.prepended && opts.prepended > 0) {
      // keep the same bars on screen: indexes shifted by `prepended`, rightOffset is relative to last
    } else if (!opts.keepView || prevLen === 0) {
      this.rightOffset = Math.min(this.rightOffset, 10);
    }
    this.needHistoryFired = false;
    this.lastPrice = bars.length ? bars.c[bars.length - 1] : NaN;
    this.invalidate();
  }

  /** Called after bars were appended/updated in place (arrays may be reallocated). */
  dataUpdated(bars: ChartBars, newBars: number): void {
    const atRight = this.isLastBarVisible();
    this.bars = bars;
    if (newBars > 0 && !atRight) this.rightOffset -= newBars;
    this.lastPrice = bars.length ? bars.c[bars.length - 1] : NaN;
    this.invalidate();
  }

  setStyle(style: SeriesStyle): void {
    this.style = style;
    this.invalidate();
  }

  setScaleMode(mode: ScaleMode): void {
    const s = this.panes[0].scale;
    s.mode = mode;
    s.auto = true;
    this.invalidate();
  }

  setInstrument(opts: { priceDecimals: number; tick: number; tfMs: number }): void {
    this.priceDecimals = opts.priceDecimals;
    this.tick = opts.tick;
    this.tfMs = opts.tfMs;
    this.invalidate();
  }

  setIndicators(list: IndicatorOutput[]): void {
    this.indicators = list;
    const main = this.panes[0];
    main.indicators = list.filter((i) => i.overlay);
    const sub = list.filter((i) => !i.overlay);
    const old = new Map(this.panes.slice(1).map((p) => [p.id, p]));
    this.panes = [main, ...sub.map((ind) => old.get(ind.id) || { id: ind.id, scale: new PriceScale(), top: 0, height: 0, weight: 0.28, indicators: [] })];
    for (let k = 1; k < this.panes.length; k++) {
      const ind = sub[k - 1];
      const p = this.panes[k];
      p.indicators = [ind];
      p.scale.fixedMin = ind.scaleMin;
      p.scale.fixedMax = ind.scaleMax;
      p.scale.marginTop = 0.12;
      p.scale.marginBottom = 0.12;
    }
    this.layout();
    this.invalidate();
  }

  setCompare(list: CompareSeries[]): void {
    this.compare = list;
    this.invalidate();
  }

  setMtf(list: MtfSeries[]): void {
    this.mtf = list;
    this.invalidate();
  }

  levels: LevelLine[] = [];
  levelBands: LevelBand[] = [];

  setLevels(lines: LevelLine[], bands: LevelBand[]): void {
    this.levels = lines;
    this.levelBands = bands;
    this.invalidate();
  }

  setTradeLines(lines: TradeLine[]): void {
    this.tradeLines = lines;
    this.invalidateOverlay();
  }

  setExecutions(ex: Execution[]): void {
    this.executions = ex;
    this.invalidate();
  }

  setVolumeProfile(opts: VolumeProfileOptions): void {
    this.volumeProfile = opts;
    this.invalidate();
  }

  setFootprint(fp: { bars: Map<number, FootprintBar>; opts: FootprintOptions } | null): void {
    this.footprint = fp;
    this.invalidate();
  }

  setShowVolume(v: boolean): void {
    this.showVolume = v;
    this.invalidate();
  }

  setBarCloseTime(t: number | null): void {
    this.barCloseTime = t;
  }

  setSyncedCrosshair(t: number | null): void {
    if (this.syncedCrosshairTime === t) return;
    this.syncedCrosshairTime = t;
    this.invalidateOverlay();
  }

  setPickBarMode(on: boolean): void {
    this.pickBarMode = on;
    this.over.style.cursor = on ? 'col-resize' : 'crosshair';
    this.invalidateOverlay();
  }

  setDrawingTool(tool: DrawingType | null): void {
    this.drawings.setTool(tool);
    this.over.style.cursor = tool ? 'crosshair' : 'crosshair';
    this.invalidateOverlay();
  }

  setDrawings(d: Drawing[]): void {
    this.drawings.setDrawings(d);
    this.invalidateOverlay();
  }

  setMagnet(on: boolean): void {
    this.magnet = on;
  }

  /** Scroll so the latest bar is visible (animated); `fit` also turns auto-scaling back on. */
  scrollToLatest(fit = false): void {
    this.stopGlide();
    if (fit) for (const p of this.panes) p.scale.auto = true;
    cancelAnimationFrame(this.scrollAnim);
    const from = this.rightOffset;
    const to = 6;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 280);
      const e = 1 - Math.pow(1 - k, 3);
      this.rightOffset = from + (to - from) * e;
      this.invalidate();
      this.cb.onViewChange?.();
      if (k < 1 && !this.destroyed) this.scrollAnim = requestAnimationFrame(step);
    };
    if (Math.abs(to - from) < 0.5) {
      this.rightOffset = to;
      this.invalidate();
      this.cb.onViewChange?.();
    } else step();
  }

  /** True when the latest bar is scrolled out of view to the right. */
  latestHidden(): boolean {
    return this.rightOffset < -1;
  }

  resetView(): void {
    this.stopGlide();
    this.barSpacing = 8;
    this.rightOffset = 6;
    for (const p of this.panes) p.scale.auto = true;
    this.invalidate();
    this.cb.onViewChange?.();
  }

  private stopGlide(): void {
    if (!this.glide) return;
    cancelAnimationFrame(this.glide.raf);
    this.glide = null;
  }

  /** Keep moving briefly after a flick, slowing down quickly (a short, light glide). */
  private startGlide(v: number, vy: number): void {
    this.stopGlide();
    const g = { v, vy, last: performance.now(), raf: 0 };
    this.glide = g;
    const step = () => {
      if (this.glide !== g || this.destroyed) return;
      const now = performance.now();
      const dt = Math.min(48, now - g.last);
      g.last = now;
      const before = this.rightOffset;
      if (g.v) {
        this.rightOffset += g.v * dt;
        this.clampOffset();
        if (this.rightOffset === before) g.v = 0;
      }
      const main = this.mainScale;
      if (g.vy && !main.auto) {
        main.min += g.vy * dt;
        main.max += g.vy * dt;
      }
      const decay = Math.exp(-dt / GLIDE_MS);
      g.v *= decay;
      g.vy *= decay;
      this.invalidate();
      this.cb.onViewChange?.();
      // stop when slow (under 0.02 px per ms both ways) or at the ends
      const pxY = main.max > main.min ? (Math.abs(g.vy) / (main.max - main.min)) * main.height : 0;
      if (Math.abs(g.v * this.barSpacing) < 0.02 && pxY < 0.02) {
        this.glide = null;
        return;
      }
      g.raf = requestAnimationFrame(step);
    };
    g.raf = requestAnimationFrame(step);
  }

  /** Show a time range (used by replay/backtest navigation). */
  showTimeRange(from: number, to: number): void {
    const i0 = this.indexOfTime(from);
    const i1 = this.indexOfTime(to);
    const n = Math.max(10, i1 - i0);
    this.barSpacing = Math.max(1, Math.min(40, this.plotW / (n * 1.1)));
    const last = this.bars.length - 1;
    this.rightOffset = i1 + n * 0.05 - last;
    this.invalidate();
  }

  zoomBy(factor: number): void {
    this.setBarSpacing(this.barSpacing * factor, this.plotW);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.base.remove();
    this.over.remove();
  }

  focus(): void {
    this.over.focus();
  }

  invalidate(): void {
    this.dirtyBase = true;
    this.dirtyOver = true;
    this.schedule();
  }

  invalidateOverlay(): void {
    this.dirtyOver = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dirtyBase) this.renderBase();
      if (this.dirtyOver) this.renderOverlay();
      this.dirtyBase = this.dirtyOver = false;
    });
  }

  // ------------------------------------------------------------------ geometry

  get plotW(): number {
    return Math.max(10, this.width - this.axisW);
  }

  get plotH(): number {
    return Math.max(10, this.height - TIME_AXIS_H);
  }

  get lastIndex(): number {
    return this.bars.length - 1;
  }

  get rightEdge(): number {
    return this.lastIndex + this.rightOffset;
  }

  x(i: number): number {
    return this.plotW - (this.rightEdge - i + 0.5) * this.barSpacing;
  }

  indexAtX(x: number): number {
    return this.rightEdge - (this.plotW - x) / this.barSpacing - 0.5;
  }

  visibleRange(): [number, number] {
    const n = this.plotW / this.barSpacing;
    const i1 = Math.min(this.lastIndex, Math.ceil(this.rightEdge));
    const i0 = Math.max(0, Math.floor(this.rightEdge - n) - 1);
    return [i0, i1];
  }

  isLastBarVisible(): boolean {
    const x = this.x(this.lastIndex);
    return x <= this.plotW + this.barSpacing && x >= 0;
  }

  /** Fractional index for a time (extrapolates beyond data). */
  indexOfTime(t: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return 0;
    if (t >= b.t[n - 1]) return n - 1 + (t - b.t[n - 1]) / this.tfMs;
    if (t <= b.t[0]) return (t - b.t[0]) / this.tfMs;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b.t[m] <= t) lo = m;
      else hi = m;
    }
    const span = b.t[hi] - b.t[lo];
    return lo + (span > 0 ? (t - b.t[lo]) / span : 0);
  }

  timeOfIndex(i: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return Date.now();
    if (i >= n - 1) return b.t[n - 1] + (i - (n - 1)) * this.tfMs;
    if (i <= 0) return b.t[0] + i * this.tfMs;
    const lo = Math.floor(i);
    return b.t[lo] + (i - lo) * (b.t[lo + 1] - b.t[lo]);
  }

  paneAt(y: number): Pane | null {
    for (const p of this.panes) if (y >= p.top && y < p.top + p.height) return p;
    return null;
  }

  get mainScale(): PriceScale {
    return this.panes[0].scale;
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(50, Math.floor(r.width));
    const h = Math.max(50, Math.floor(r.height));
    const dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    for (const c of [this.base, this.over]) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.layout();
    this.invalidate();
  }

  private layout(): void {
    const H = this.plotH;
    const subs = this.panes.slice(1);
    const subTotal = subs.reduce((a, p) => a + p.weight, 0);
    const mainWeight = Math.max(0.35, 1 - Math.min(0.65, subTotal));
    const total = mainWeight + subTotal;
    let y = 0;
    this.panes.forEach((p, i) => {
      const w = i === 0 ? mainWeight : p.weight;
      const h = i === this.panes.length - 1 ? H - y : Math.round((H * w) / total);
      p.top = y + (i ? PANE_GAP : 0);
      p.height = Math.max(20, h - (i ? PANE_GAP : 0));
      p.scale.top = p.top + 4;
      p.scale.height = Math.max(10, p.height - 8);
      y += h;
    });
    const sig = this.panes.map((p) => `${p.id}:${p.top}:${p.height}`).join('|');
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      const geo = this.panes.map((p) => ({ id: p.id, top: p.top, height: p.height }));
      queueMicrotask(() => this.cb.onLayout?.(geo));
    }
  }

  private layoutSig = '';

  /** Current pane geometry (CSS px). */
  paneLayout(): { id: string; top: number; height: number }[] {
    return this.panes.map((p) => ({ id: p.id, top: p.top, height: p.height }));
  }

  private setBarSpacing(bs: number, anchorX: number): void {
    const nb = Math.max(0.3, Math.min(80, bs));
    const idx = this.indexAtX(anchorX);
    this.barSpacing = nb;
    // keep the bar under the anchor fixed
    const newIdx = this.indexAtX(anchorX);
    this.rightOffset += idx - newIdx;
    this.clampOffset();
    this.invalidate();
    this.cb.onViewChange?.();
  }

  private clampOffset(): void {
    const n = this.plotW / this.barSpacing;
    const maxRight = n * 0.85;
    const minRight = -(this.bars.length - 3);
    this.rightOffset = Math.max(minRight, Math.min(maxRight, this.rightOffset));
  }

  // ------------------------------------------------------------------ rendering

  ctxFor(ctx: CanvasRenderingContext2D, pane: Pane): RenderCtx {
    const [i0, i1] = this.visibleRange();
    return {
      ctx,
      theme: this.theme,
      bars: this.bars,
      i0,
      i1,
      x: (i) => this.x(i),
      barSpacing: this.barSpacing,
      bodyW: Math.max(1, Math.min(this.barSpacing * 0.72, this.barSpacing - 1)),
      plotW: this.plotW,
      pane,
      priceDecimals: this.priceDecimals,
      dpr: this.dpr,
    };
  }

  private autoscale(): void {
    const [i0, i1] = this.visibleRange();
    const b = this.bars;
    const main = this.panes[0];
    const s = main.scale;
    if (s.mode === 'percent') {
      const bi = Math.max(0, Math.min(b.length - 1, i0));
      s.base = b.length ? b.c[bi] || 1 : 1;
    }
    if (s.auto) {
      let lo = Infinity;
      let hi = -Infinity;
      const lineLike = this.style === 'line' || this.style === 'area';
      for (let i = Math.max(0, i0); i <= Math.min(b.length - 1, i1); i++) {
        const l = lineLike ? b.c[i] : b.l[i];
        const h = lineLike ? b.c[i] : b.h[i];
        if (l < lo) lo = l;
        if (h > hi) hi = h;
      }
      for (const ind of main.indicators) {
        if (!ind.visible) continue;
        const [a, z] = indicatorRange(ind, i0, i1);
        if (a < lo) lo = a;
        if (z > hi) hi = z;
      }
      if (s.mode === 'percent' && this.compare.length && b.length) {
        // compare series expressed in percent of their value at the first visible bar, mapped to main space
        for (const cs of this.compare) {
          const base = compareValueAt(cs, b.t[Math.max(0, i0)]);
          if (!(base > 0)) continue;
          for (let i = Math.max(0, i0); i <= Math.min(b.length - 1, i1); i++) {
            const v = compareValueAt(cs, b.t[i]);
            if (!(v > 0)) continue;
            const mapped = (v / base) * s.base;
            if (mapped < lo) lo = mapped;
            if (mapped > hi) hi = mapped;
          }
        }
      }
      if (lo === Infinity) {
        lo = 0;
        hi = 1;
      }
      s.marginBottom = this.showVolume && this.style !== 'footprint' ? 0.2 : 0.08;
      s.marginTop = 0.08;
      s.fit(lo, hi);
    }
    for (const p of this.panes.slice(1)) {
      if (!p.scale.auto) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const ind of p.indicators) {
        const [a, z] = indicatorRange(ind, i0, i1);
        lo = Math.min(lo, a);
        hi = Math.max(hi, z);
      }
      if (lo === Infinity) {
        lo = 0;
        hi = 1;
      }
      p.scale.fit(lo, hi);
    }
  }

  private renderBase(): void {
    const ctx = this.bctx;
    const th = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.bars.length) {
      ctx.fillStyle = th.text;
      ctx.font = `${th.fontSize + 1}px ${th.font}`;
      ctx.textAlign = 'center';
      ctx.fillText('Loading…', this.plotW / 2, this.plotH / 2);
      ctx.textAlign = 'left';
      return;
    }
    // axis width from label sizes
    ctx.font = `${th.fontSize}px ${th.font}`;
    const sample = formatAxis(this.mainScale.mode === 'percent' ? 999.99 : Math.max(...[this.bars.h[this.bars.length - 1] || 0]), this.mainScale.mode === 'percent' ? 2 : this.priceDecimals);
    this.axisW = Math.max(AXIS_W_MIN, Math.ceil(ctx.measureText(sample).width) + 22);
    this.autoscale();
    const [i0, i1] = this.visibleRange();
    // trigger history loading when the first bar comes into view
    if (i0 <= 5 && !this.needHistoryFired && this.cb.onNeedHistory) {
      this.needHistoryFired = true;
      this.cb.onNeedHistory();
    }
    const ticks = timeTicks(this.bars.t, i0, i1, this.barSpacing);
    // grid + panes
    for (const pane of this.panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, pane.top, this.plotW, pane.height);
      ctx.clip();
      if (th.showGrid) this.drawGrid(ctx, pane, ticks);
      const rc = this.ctxFor(ctx, pane);
      if (pane.id === 'main') {
        for (const ind of pane.indicators) if (ind.visible && ind.bgcolors) drawBg(rc, ind.bgcolors);
        if (this.volumeProfile.mode !== 'off') drawVolumeProfile(rc, this.volumeProfile, this.footprint?.bars || null);
        for (const m of this.mtf) drawMtf(rc, m, this);
        if (this.showVolume && this.style !== 'footprint') drawVolume(rc);
        const barcolors = pane.indicators.find((i) => i.visible && i.barcolors)?.barcolors || null;
        if (this.style === 'footprint' && this.footprint) drawFootprint(rc, this.footprint.bars, this.footprint.opts, this.tick);
        else drawSeries(rc, this.style, barcolors);
        for (const ind of pane.indicators) if (ind.visible) drawIndicatorBase(rc, ind);
        for (const ind of pane.indicators) if (ind.visible && ind.trades) drawStrategyTrades(rc, ind.trades);
        if (this.compare.length) drawCompare(rc, this.compare, this.mainScale);
        if (this.levels.length || this.levelBands.length) drawLevels(rc, this.levels, this.levelBands, this, pane);
        if (this.executions.length) drawExecutions(rc, this.executions, this);
        this.drawLastPriceLine(ctx, pane);
      } else {
        for (const ind of pane.indicators) {
          if (!ind.visible) continue;
          if (ind.bgcolors) drawBg(rc, ind.bgcolors);
          drawIndicatorBase(rc, ind);
        }
      }
      ctx.restore();
      // pane separator
      if (pane.id !== 'main') {
        ctx.fillStyle = th.border;
        ctx.fillRect(0, pane.top - PANE_GAP, this.width, PANE_GAP);
      }
      this.drawPriceAxis(ctx, pane);
    }
    this.drawTimeAxis(ctx, ticks);
    // axis separators
    ctx.fillStyle = th.border;
    ctx.fillRect(this.plotW, 0, 1, this.height);
    ctx.fillRect(0, this.plotH, this.width, 1);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, pane: Pane, ticks: { index: number; major: boolean }[]): void {
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of ticks) {
      const x = Math.round(this.x(t.index)) + 0.5;
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.top + pane.height);
    }
    const n = Math.max(2, Math.floor(pane.height / 48));
    for (const v of pane.scale.ticks(n)) {
      const y = Math.round(pane.scale.toY(v)) + 0.5;
      if (y < pane.top || y > pane.top + pane.height) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
    }
    ctx.stroke();
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D, pane: Pane): void {
    const th = this.theme;
    const s = pane.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotW, pane.top, this.axisW, pane.height);
    ctx.clip();
    ctx.fillStyle = th.bg;
    ctx.fillRect(this.plotW, pane.top, this.axisW, pane.height);
    ctx.font = `${th.fontSize}px ${th.font}`;
    ctx.fillStyle = th.text;
    ctx.textBaseline = 'middle';
    const n = Math.max(2, Math.floor(pane.height / 48));
    const ticks = s.ticks(n);
    let dec: number;
    if (pane.id === 'main') dec = s.mode === 'percent' ? 2 : this.priceDecimals;
    else {
      const step = s.tickStep(n);
      dec = pane.indicators[0]?.precision ?? decimalsForStep(step);
    }
    if (pane.id === 'main' && s.mode !== 'percent') {
      const step = Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0));
      if (step > 0) dec = Math.min(this.priceDecimals, decimalsForStep(step));
    }
    for (const v of ticks) {
      const y = s.toY(v);
      if (y < pane.top + 6 || y > pane.top + pane.height - 6) continue;
      const label = s.mode === 'percent' && pane.id === 'main' ? `${formatAxis((v / s.base - 1) * 100, 2)}%` : paneValue(pane, v, dec);
      ctx.fillText(label, this.plotW + 8, y);
    }
    // last values of indicators in sub panes
    if (pane.id !== 'main') {
      for (const ind of pane.indicators) {
        if (!ind.visible) continue;
        for (const pl of ind.plots) {
          if (pl.visible === false) continue;
          const v = lastFinite(pl.values, this.bars.length - 1);
          if (!isFinite(v)) continue;
          this.axisLabel(ctx, s.toY(v), paneValue(pane, v, ind.precision ?? dec), pl.color, pane);
        }
      }
    } else {
      // overlay indicator last values (tracked plots)
      for (const ind of pane.indicators) {
        if (!ind.visible) continue;
        for (const pl of ind.plots) {
          if (pl.visible === false || pl.trackPrice === false) continue;
          const v = lastFinite(pl.values, this.bars.length - 1);
          if (isFinite(v) && pl.type !== 'histogram' && pl.type !== 'columns') this.axisLabel(ctx, s.toY(v), formatAxis(v, this.priceDecimals), pl.color, pane, 0.85);
        }
      }
      if (isFinite(this.lastPrice)) {
        const b = this.bars;
        const n = b.length - 1;
        const up = b.c[n] >= b.o[n];
        const col = up ? th.up : th.down;
        const y = s.toY(this.lastPrice);
        let txt = s.mode === 'percent' ? `${formatAxis((this.lastPrice / s.base - 1) * 100, 2)}%` : formatAxis(this.lastPrice, this.priceDecimals);
        this.axisLabel(ctx, y, txt, col, pane, 1, this.countdown());
        txt = '';
      }
    }
    ctx.restore();
  }

  private countdown(): string | undefined {
    if (!this.barCloseTime) return undefined;
    const ms = this.barCloseTime - serverNow();
    if (ms <= 0 || ms > 86400e3 * 31) return undefined;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  axisLabel(ctx: CanvasRenderingContext2D, y: number, text: string, bg: string, pane: Pane, alpha = 1, sub?: string): void {
    if (y < pane.top - 2 || y > pane.top + pane.height + 2) return;
    const h = sub ? 30 : 18;
    const top = Math.max(pane.top, Math.min(pane.top + pane.height - h, y - 9));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bg;
    roundRect(ctx, this.plotW + 1, top, this.axisW - 2, h, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${this.theme.fontSize}px ${this.theme.font}`;
    ctx.fillText(text, this.plotW + 7, top + 9);
    if (sub) {
      ctx.font = `${this.theme.fontSize - 1}px ${this.theme.font}`;
      ctx.globalAlpha = 0.85;
      ctx.fillText(sub, this.plotW + 7, top + 22);
      ctx.globalAlpha = 1;
    }
    ctx.font = `${this.theme.fontSize}px ${this.theme.font}`;
  }

  private drawLastPriceLine(ctx: CanvasRenderingContext2D, pane: Pane): void {
    if (!isFinite(this.lastPrice)) return;
    const b = this.bars;
    const n = b.length - 1;
    const up = b.c[n] >= b.o[n];
    const y = Math.round(pane.scale.toY(this.lastPrice)) + 0.5;
    ctx.strokeStyle = up ? this.theme.up : this.theme.down;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, ticks: { index: number; label: string; major: boolean }[]): void {
    const th = this.theme;
    const y0 = this.plotH;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, y0, this.width, TIME_AXIS_H);
    ctx.font = `${th.fontSize}px ${th.font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const t of ticks) {
      const x = this.x(t.index);
      if (x < 20 || x > this.plotW - 20) continue;
      ctx.fillStyle = t.major ? th.textStrong : th.text;
      ctx.font = `${t.major ? '600 ' : ''}${th.fontSize}px ${th.font}`;
      ctx.fillText(t.label, x, y0 + TIME_AXIS_H / 2);
    }
    ctx.textAlign = 'left';
  }

  private renderOverlay(): void {
    const ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.bars.length) return;
    const main = this.panes[0];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, main.top, this.plotW, main.height);
    ctx.clip();
    const rc = this.ctxFor(ctx, main);
    this.drawings.render(rc);
    ctx.restore();
    // trade lines (span plot + axis label)
    drawTradeLines(rc, this.tradeLines, this.hoverTradeLine, this.drag && (this.drag.kind === 'tradeLine' || this.drag.kind === 'bracket') ? { id: this.drag.id!, price: this.drag.price!, kind: this.drag.kindSub } : null, this);
    // synced crosshair from other charts
    if (this.syncedCrosshairTime !== null && !this.mouse.inside) {
      const x = Math.round(this.x(this.indexOfTime(this.syncedCrosshairTime))) + 0.5;
      if (x >= 0 && x <= this.plotW) {
        ctx.strokeStyle = this.theme.cross;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.mouse.inside && this.mouse.x < this.plotW && this.mouse.y < this.plotH) this.drawCrosshair(ctx);
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D): void {
    const th = this.theme;
    const { x: mx, y: my } = this.mouse;
    const idx = Math.round(this.indexAtX(mx));
    const pane = this.paneAt(my);
    const cx = Math.round(this.x(idx)) + 0.5;
    let cy = Math.round(my) + 0.5;
    if (this.magnet && pane && pane.id === 'main' && idx >= 0 && idx < this.bars.length) {
      const b = this.bars;
      const candidates = [b.o[idx], b.h[idx], b.l[idx], b.c[idx]];
      let best = candidates[0];
      for (const c of candidates) if (Math.abs(pane.scale.toY(c) - my) < Math.abs(pane.scale.toY(best) - my)) best = c;
      cy = Math.round(pane.scale.toY(best)) + 0.5;
    }
    ctx.strokeStyle = this.pickBarMode ? th.accent : th.cross;
    ctx.lineWidth = 1;
    ctx.setLineDash(this.pickBarMode ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, this.plotH);
    if (!this.pickBarMode) {
      ctx.moveTo(0, cy);
      ctx.lineTo(this.plotW, cy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (this.pickBarMode) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(cx, 0, this.plotW - cx, this.plotH);
    }
    // price label
    if (pane && !this.pickBarMode) {
      const v = pane.scale.fromY(cy);
      let txt: string;
      if (pane.id === 'main' && pane.scale.mode === 'percent') txt = `${formatAxis((v / pane.scale.base - 1) * 100, 2)}%`;
      else if (pane.id === 'main') txt = formatAxis(v, this.priceDecimals);
      else txt = paneValue(pane, v, pane.indicators[0]?.precision ?? decimalsForStep(pane.scale.tickStep(4)));
      this.axisLabel(ctx, cy, txt, th.labelBg, pane);
    }
    // time label
    const t = idx >= 0 && idx < this.bars.length ? this.bars.t[idx] : this.timeOfIndex(idx);
    const label = this.tfMs < 60000 ? fmtDateTime(t, true) : this.tfMs >= 86400000 ? fmtDateTime(t).replace(/ \d\d:\d\d$/, '') : fmtDateTime(t);
    ctx.font = `600 ${th.fontSize}px ${th.font}`;
    const w = ctx.measureText(label).width + 14;
    const lx = Math.max(0, Math.min(this.plotW - w, cx - w / 2));
    ctx.fillStyle = th.labelBg;
    roundRect(ctx, lx, this.plotH + 2, w, 19, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 7, this.plotH + 12);
    ctx.font = `${th.fontSize}px ${th.font}`;
    void timeParts;
  }

  // ------------------------------------------------------------------ events

  private bindEvents(): void {
    const o = this.over;
    o.addEventListener('mousemove', (e) => this.onMove(e));
    o.addEventListener('mouseleave', () => {
      this.mouse.inside = false;
      this.hoverTradeLine = null;
      this.invalidateOverlay();
      this.cb.onCrosshair?.(null);
    });
    o.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onDragMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    o.addEventListener('dblclick', (e) => this.onDblClick(e));
    o.addEventListener('contextmenu', (e) => this.onContext(e));
    o.addEventListener('keydown', (e) => this.onKey(e));
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  priceAt(y: number): number {
    const p = this.paneAt(y) || this.panes[0];
    return p.scale.fromY(y);
  }

  /** Snap (time, price) to OHLC when magnet is on. */
  snapPoint(x: number, y: number): { t: number; p: number } {
    const idx = Math.round(this.indexAtX(x));
    let p = this.mainScale.fromY(y);
    if (this.magnet && idx >= 0 && idx < this.bars.length) {
      const b = this.bars;
      const c = [b.o[idx], b.h[idx], b.l[idx], b.c[idx]];
      p = c.reduce((best, v) => (Math.abs(this.mainScale.toY(v) - y) < Math.abs(this.mainScale.toY(best) - y) ? v : best), c[0]);
    }
    return { t: this.timeOfIndex(idx >= 0 && idx < this.bars.length ? idx : this.indexAtX(x)), p };
  }

  private onMove(e: MouseEvent): void {
    if (this.drag) return;
    const { x, y } = this.local(e);
    this.mouse = { x, y, inside: true };
    // cursor feedback
    let cursor = this.pickBarMode ? 'col-resize' : 'crosshair';
    if (x > this.plotW) cursor = 'ns-resize';
    else if (y > this.plotH) cursor = 'ew-resize';
    else {
      const split = this.splitAt(y);
      if (split >= 0) cursor = 'row-resize';
      const tl = hitTradeLine(this, this.tradeLines, x, y);
      this.hoverTradeLine = tl ? tl.line.id : null;
      if (tl && tl.line.draggable) cursor = 'ns-resize';
      if (tl && tl.part === 'cancel') cursor = 'pointer';
      if (tl && (tl.part === 'sl' || tl.part === 'tp')) cursor = 'grab';
      const dc = this.drawings.cursorAt(x, y);
      if (dc) cursor = dc;
    }
    this.over.style.cursor = cursor;
    this.drawings.onHover(x, y);
    this.invalidateOverlay();
    if (this.cb.onCrosshair) {
      const idx = Math.round(this.indexAtX(x));
      const pane = this.paneAt(y);
      this.cb.onCrosshair({ index: idx, time: this.timeOfIndex(idx), price: pane ? pane.scale.fromY(y) : NaN, pane: pane ? this.panes.indexOf(pane) : 0, x, y });
    }
  }

  private splitAt(y: number): number {
    for (let i = 1; i < this.panes.length; i++) if (Math.abs(y - this.panes[i].top) <= 3) return i;
    return -1;
  }

  private onDown(e: MouseEvent): void {
    this.over.focus();
    this.stopGlide();
    cancelAnimationFrame(this.scrollAnim);
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    if (this.pickBarMode && x < this.plotW && y < this.plotH) {
      const idx = Math.max(0, Math.min(this.bars.length - 1, Math.round(this.indexAtX(x))));
      this.cb.onPickBar?.(this.bars.t[idx], idx);
      return;
    }
    if (x > this.plotW) {
      const pane = this.paneAt(y) || this.panes[0];
      this.drag = { kind: 'priceAxis', x0: x, y0: y, v0: pane.scale.min, v1: pane.scale.max, pane };
      pane.scale.auto = false;
      return;
    }
    if (y > this.plotH) {
      this.drag = { kind: 'timeAxis', x0: x, y0: y, v0: this.barSpacing };
      return;
    }
    const split = this.splitAt(y);
    if (split > 0) {
      this.drag = { kind: 'paneSplit', x0: x, y0: y, v0: 0, splitIndex: split, weights: this.panes.map((p) => p.weight) };
      return;
    }
    const tl = hitTradeLine(this, this.tradeLines, x, y);
    if (tl) {
      if (tl.part === 'cancel' && tl.line.cancellable) {
        this.cb.onTradeLineCancel?.(tl.line.id);
        return;
      }
      if (tl.part === 'sl' || tl.part === 'tp') {
        this.drag = { kind: 'bracket', x0: x, y0: y, v0: 0, id: tl.line.id, price: tl.line.price, kindSub: tl.part };
        return;
      }
      if (tl.line.draggable) {
        this.drag = { kind: 'tradeLine', x0: x, y0: y, v0: tl.line.price, id: tl.line.id, price: tl.line.price };
        return;
      }
    }
    if (this.drawings.onDown(x, y, e)) {
      this.invalidateOverlay();
      return;
    }
    this.drag = { kind: 'pan', x0: x, y0: y, v0: this.rightOffset, v1: this.mainScale.min, axis: 'undecided', trail: [[performance.now(), this.rightOffset, NaN]] };
    this.over.style.cursor = 'grabbing';
  }

  private onDragMove(e: MouseEvent): void {
    if (this.drawings.isDragging()) {
      const { x, y } = this.local(e);
      this.mouse = { x, y, inside: true };
      this.drawings.onDrag(x, y, e);
      this.invalidateOverlay();
      return;
    }
    const d = this.drag;
    if (!d) return;
    const { x, y } = this.local(e);
    this.mouse = { x, y, inside: true };
    switch (d.kind) {
      case 'pan': {
        const main = this.mainScale;
        // decide the direction once the pointer has moved: a mostly vertical drag moves the
        // price too (auto-scaling switches off); a horizontal one only scrolls time
        if (d.axis === 'undecided' && Math.hypot(x - d.x0, y - d.y0) > 6) d.axis = Math.abs(y - d.y0) > Math.abs(x - d.x0) || !main.auto ? 'free' : 'x';
        // a horizontal drag that turns clearly vertical later becomes free as well
        if (d.axis === 'x' && Math.abs(y - d.y0) > 48 && Math.abs(y - d.y0) > Math.abs(x - d.x0) * 0.6) d.axis = 'free';
        // grab and move: dragging right pulls older bars into view (fewer bars beyond the right edge)
        this.rightOffset = d.v0 - (x - d.x0) / this.barSpacing;
        this.clampOffset();
        if (d.axis === 'free') {
          if (main.auto) {
            // start moving the price from where it is now
            main.auto = false;
            d.y0 = y;
            d.v1 = main.min;
          }
          const span = main.max - main.min;
          const delta = ((y - d.y0) / main.height) * span;
          main.min = d.v1! + delta;
          main.max = main.min + span;
        }
        const trail = d.trail!;
        trail.push([performance.now(), this.rightOffset, d.axis === 'free' ? main.min : NaN]);
        if (trail.length > 8) trail.shift();
        this.invalidate();
        this.cb.onViewChange?.();
        break;
      }
      case 'priceAxis': {
        const s = d.pane!.scale;
        const factor = Math.exp((y - d.y0) / 120);
        const c = (d.v0 + d.v1!) / 2;
        s.min = c - ((d.v1! - d.v0) / 2) * factor;
        s.max = c + ((d.v1! - d.v0) / 2) * factor;
        this.invalidate();
        break;
      }
      case 'timeAxis': {
        const factor = Math.exp((x - d.x0) / 150);
        this.setBarSpacing(d.v0 * factor, this.plotW);
        break;
      }
      case 'paneSplit': {
        const i = d.splitIndex!;
        const H = this.plotH;
        const dyw = (y - d.y0) / H;
        const w = d.weights!.slice();
        if (i - 1 === 0) {
          w[i] = Math.max(0.08, Math.min(0.7, w[i] - dyw));
        } else {
          const sum = w[i - 1] + w[i];
          w[i - 1] = Math.max(0.06, Math.min(sum - 0.06, w[i - 1] + dyw));
          w[i] = sum - w[i - 1];
        }
        this.panes.forEach((p, k) => (p.weight = w[k]));
        this.layout();
        this.invalidate();
        break;
      }
      case 'tradeLine':
      case 'bracket': {
        d.price = this.mainScale.fromY(y);
        this.invalidateOverlay();
        break;
      }
    }
  }

  private onUp(e: MouseEvent): void {
    if (this.drawings.isDragging()) {
      const { x, y } = this.local(e);
      this.drawings.onUp(x, y);
      this.invalidateOverlay();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'pan') {
      this.over.style.cursor = 'crosshair';
      // a flick keeps moving briefly (both ways when the price moved too): velocity over the last ~80 ms
      const trail = d.trail || [];
      const now = performance.now();
      const recent = trail.filter(([t]) => now - t < 80);
      if (this.theme.momentum !== false && recent.length >= 2) {
        const [t0, o0, m0] = recent[0];
        const [t1, o1, m1] = recent[recent.length - 1];
        const dt = Math.max(1, t1 - t0);
        const main = this.mainScale;
        let v = ((o1 - o0) / dt) * GLIDE_SCALE;
        let vy = Number.isFinite(m0) && Number.isFinite(m1) && !main.auto ? ((m1 - m0) / dt) * GLIDE_SCALE : 0;
        // only a real flick glides (over 0.6 px per ms at release)
        const pxY = main.max > main.min ? (Math.abs(vy) / (main.max - main.min)) * main.height : 0;
        if (Math.abs(v * this.barSpacing) < 0.6 * GLIDE_SCALE) v = 0;
        if (pxY < 0.6 * GLIDE_SCALE) vy = 0;
        if (now - t1 < 40 && (v || vy)) this.startGlide(v, vy);
      }
    }
    if (d.kind === 'tradeLine' && d.id && d.price !== undefined && Math.abs(d.price - d.v0) > 1e-9) this.cb.onTradeLineDrag?.(d.id, roundTo(d.price, this.tick));
    if (d.kind === 'bracket' && d.id && d.price !== undefined) {
      const { y } = this.local(e);
      if (Math.abs(y - d.y0) > 6) this.cb.onBracketCreate?.(d.id, d.kindSub!, roundTo(d.price, this.tick));
    }
    this.invalidateOverlay();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.stopGlide();
    cancelAnimationFrame(this.scrollAnim);
    const { x, y } = this.local(e);
    if (x > this.plotW) {
      const pane = this.paneAt(y) || this.panes[0];
      pane.scale.zoom(Math.exp(e.deltaY / 500));
      this.invalidate();
      return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) * (this.theme.reverseScroll ? -1 : 1);
      this.rightOffset += d / this.barSpacing / 2;
      this.clampOffset();
      this.invalidate();
      this.cb.onViewChange?.();
      return;
    }
    // touchpad pinch arrives as ctrl+wheel with small deltas: zoom faster per unit
    const factor = Math.exp(-e.deltaY / (e.ctrlKey ? 120 : 400));
    this.setBarSpacing(this.barSpacing * factor, Math.min(x, this.plotW));
    this.cb.onViewChange?.();
  }

  private onDblClick(e: MouseEvent): void {
    const { x, y } = this.local(e);
    if (x > this.plotW) {
      const pane = this.paneAt(y) || this.panes[0];
      pane.scale.auto = true;
      this.invalidate();
      return;
    }
    if (y > this.plotH) {
      this.resetView();
      return;
    }
    if (this.drawings.onDblClick(x, y)) return;
    this.cb.onDoubleClick?.({ price: this.priceAt(y), time: this.timeOfIndex(Math.round(this.indexAtX(x))) });
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    if (this.drawings.cancelInProgress()) {
      this.invalidateOverlay();
      return;
    }
    const dId = this.drawings.hitId(x, y);
    const tl = hitTradeLine(this, this.tradeLines, x, y);
    this.cb.onContextMenu?.({ x, y, clientX: e.clientX, clientY: e.clientY, price: this.priceAt(y), time: this.timeOfIndex(Math.round(this.indexAtX(x))), drawingId: dId || undefined, tradeLineId: tl?.line.id });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const cmd = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' ? 'redo' : k === 'c' && !e.shiftKey ? 'copy' : k === 'v' && !e.shiftKey ? 'paste' : null;
      if (cmd && this.cb.onEditCommand?.(cmd, this.drawings.selected)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'Escape') {
      let used = false;
      if (this.pickBarMode) {
        this.setPickBarMode(false);
        this.cb.onPickBar?.(NaN, -1);
        used = true;
      }
      if (this.drawings.escape()) used = true;
      // consumed here: a maximized panel stays maximized
      if (used) e.preventDefault();
      this.invalidateOverlay();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.drawings.deleteSelected()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.rightOffset += (e.key === 'ArrowLeft' ? -1 : 1) * Math.max(1, Math.round(10 / Math.max(this.barSpacing, 1)) * (e.shiftKey ? 10 : 1));
      this.clampOffset();
      this.invalidate();
      e.preventDefault();
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      this.setBarSpacing(this.barSpacing * (e.key === 'ArrowUp' ? 1.15 : 1 / 1.15), this.plotW);
      e.preventDefault();
    }
    if (e.key === 'Home' || e.key === 'End') {
      this.scrollToLatest();
      e.preventDefault();
    }
  }

  emitDrawingsChange(d: Drawing[]): void {
    this.cb.onDrawingsChange?.(d);
  }

  emitDrawingSelect(id: string | null): void {
    this.cb.onDrawingSelect?.(id);
  }

  emitToolDone(): void {
    this.cb.onToolDone?.();
  }

  get mousePos(): { x: number; y: number; inside: boolean } {
    return this.mouse;
  }

  /** Export the chart (both layers) as a PNG data URL. */
  snapshot(): string {
    const c = document.createElement('canvas');
    c.width = this.base.width;
    c.height = this.base.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.over, 0, 0);
    return c.toDataURL('image/png');
  }
}

function drawBg(rc: RenderCtx, colors: (string | null)[]): void {
  const { ctx, i0, i1, barSpacing, pane } = rc;
  for (let i = Math.max(0, i0); i <= Math.min(colors.length - 1, i1); i++) {
    const c = colors[i];
    if (!c) continue;
    ctx.fillStyle = c;
    ctx.fillRect(rc.x(i) - barSpacing / 2, pane.top, barSpacing + 0.5, pane.height);
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function lastFinite(a: Float64Array, upTo: number): number {
  for (let i = Math.min(upTo, a.length - 1); i >= Math.max(0, upTo - 500); i--) if (isFinite(a[i])) return a[i];
  return NaN;
}

export function compareValueAt(cs: CompareSeries, t: number): number {
  let lo = 0;
  let hi = cs.length - 1;
  if (hi < 0 || t < cs.t[0]) return NaN;
  if (t >= cs.t[hi]) return cs.c[hi];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cs.t[m] <= t) lo = m;
    else hi = m;
  }
  return cs.c[lo];
}

function roundTo(v: number, tick: number): number {
  if (!(tick > 0)) return v;
  const d = Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9));
  return +(Math.round(v / tick) * tick).toFixed(d);
}

export { formatVolume };

let _measure: CanvasRenderingContext2D | null = null;
/** Shared offscreen context for text measurement / hit testing. */
export function measureCtx(): CanvasRenderingContext2D {
  if (!_measure) _measure = document.createElement('canvas').getContext('2d')!;
  return _measure;
}
