import type { ChartEngine, RenderCtx } from './engine';
import { compareValueAt, roundRect, measureCtx } from './engine';
import type { CompareSeries, Execution, FootprintBar, MtfSeries, TradeLine, VolumeProfileOptions } from './types';
import type { PriceScale } from './scale';
import { withAlpha } from './drawSeries';
import { formatAxis, formatVolume } from './scale';

// ------------------------------------------------------------------------------ compare

export function drawCompare(rc: RenderCtx, list: CompareSeries[], main: PriceScale): void {
  const { ctx, bars: b, i0, i1 } = rc;
  const lo = Math.max(0, i0);
  const hi = Math.min(b.length - 1, i1);
  for (const cs of list) {
    const base = compareValueAt(cs, b.t[lo]);
    if (!(base > 0)) continue;
    ctx.strokeStyle = cs.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    let lastY = NaN;
    for (let i = lo; i <= hi; i++) {
      const v = compareValueAt(cs, b.t[i]);
      if (!(v > 0)) continue;
      const mapped = main.mode === 'percent' ? (v / base) * main.base : v;
      const y = main.toY(mapped);
      const x = rc.x(i);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lastY = y;
    }
    ctx.stroke();
    if (isFinite(lastY)) {
      const v = compareValueAt(cs, b.t[hi]);
      const pct = (v / base - 1) * 100;
      ctx.font = `600 ${rc.theme.fontSize}px ${rc.theme.font}`;
      const text = `${cs.label} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = cs.color;
      roundRect(ctx, rc.plotW - w - 4, lastY - 9, w, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, rc.plotW - w + 1, lastY);
    }
  }
}

// ------------------------------------------------------------------------------ MTF

export function drawMtf(rc: RenderCtx, m: MtfSeries, eng: ChartEngine): void {
  const { ctx, pane } = rc;
  const s = pane.scale;
  const hb = m.bars;
  const tFrom = eng.timeOfIndex(rc.i0);
  const tTo = eng.timeOfIndex(rc.i1 + 1);
  for (let k = 0; k < hb.length; k++) {
    const start = hb.t[k];
    const end = m.ends[k];
    if (end < tFrom || start > tTo) continue;
    const xa = rc.x(eng.indexOfTime(start)) - rc.barSpacing / 2;
    const xb = rc.x(eng.indexOfTime(end)) - rc.barSpacing / 2;
    const up = hb.c[k] >= hb.o[k];
    const col = up ? rc.theme.up : rc.theme.down;
    if (m.style === 'line') {
      const y = s.toY(hb.c[k]);
      ctx.strokeStyle = m.color || col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y);
      ctx.stroke();
      continue;
    }
    const yh = s.toY(hb.h[k]);
    const yl = s.toY(hb.l[k]);
    const yo = s.toY(hb.o[k]);
    const yc = s.toY(hb.c[k]);
    ctx.fillStyle = withAlpha(m.color || col, 0.07);
    ctx.fillRect(xa, yh, xb - xa, yl - yh);
    ctx.fillStyle = withAlpha(m.color || col, 0.12);
    ctx.fillRect(xa, Math.min(yo, yc), xb - xa, Math.max(1, Math.abs(yc - yo)));
    ctx.strokeStyle = withAlpha(m.color || col, 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(xa) + 0.5, Math.round(Math.min(yo, yc)) + 0.5, Math.round(xb - xa), Math.round(Math.abs(yc - yo)));
    if (xb - xa > 60) {
      ctx.fillStyle = withAlpha(m.color || col, 0.85);
      ctx.font = `${rc.theme.fontSize - 1}px ${rc.theme.font}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.tf, xa + 3, yh - 2);
    }
  }
}

// ------------------------------------------------------------------------------ volume profile

export interface ProfileResult {
  lo: number;
  step: number;
  buy: Float64Array;
  sell: Float64Array;
  poc: number;
  vah: number;
  val: number;
  exact: boolean;
}

/** Build a volume profile over bars [a, b]. Uses trade-level footprint data when available. */
export function buildProfile(rc: RenderCtx, a: number, b: number, rows: number, valueAreaPct: number, fp: Map<number, FootprintBar> | null): ProfileResult | null {
  const bars = rc.bars;
  a = Math.max(0, a);
  b = Math.min(bars.length - 1, b);
  if (b < a) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = a; i <= b; i++) {
    if (bars.l[i] < lo) lo = bars.l[i];
    if (bars.h[i] > hi) hi = bars.h[i];
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / rows;
  const buy = new Float64Array(rows);
  const sell = new Float64Array(rows);
  let exactBars = 0;
  for (let i = a; i <= b; i++) {
    const f = fp?.get(bars.t[i]);
    if (f) {
      exactBars++;
      for (let k = 0; k < f.prices.length; k++) {
        const r = Math.min(rows - 1, Math.max(0, Math.floor((f.prices[k] - lo) / step)));
        buy[r] += f.buy[k];
        sell[r] += f.sell[k];
      }
      continue;
    }
    // approximate: distribute candle volume uniformly across its range
    const l = bars.l[i];
    const h = bars.h[i];
    const v = bars.v[i];
    const tb = bars.tbv[i] > 0 && v > 0 ? bars.tbv[i] / v : 0.5;
    if (!(v > 0)) continue;
    if (h - l <= 0) {
      const r = Math.min(rows - 1, Math.max(0, Math.floor((l - lo) / step)));
      buy[r] += v * tb;
      sell[r] += v * (1 - tb);
      continue;
    }
    const r0 = Math.max(0, Math.floor((l - lo) / step));
    const r1 = Math.min(rows - 1, Math.floor((h - lo) / step));
    for (let r = r0; r <= r1; r++) {
      const top = lo + (r + 1) * step;
      const bot = lo + r * step;
      const overlap = Math.max(0, Math.min(h, top) - Math.max(l, bot));
      const share = (overlap / (h - l)) * v;
      buy[r] += share * tb;
      sell[r] += share * (1 - tb);
    }
  }
  let poc = 0;
  let total = 0;
  for (let r = 0; r < rows; r++) {
    const t = buy[r] + sell[r];
    total += t;
    if (t > buy[poc] + sell[poc]) poc = r;
  }
  // value area: expand from POC towards the larger neighbour
  let up = poc;
  let dn = poc;
  let acc = buy[poc] + sell[poc];
  const target = (total * valueAreaPct) / 100;
  while (acc < target && (up < rows - 1 || dn > 0)) {
    const nu = up < rows - 1 ? buy[up + 1] + sell[up + 1] : -1;
    const nd = dn > 0 ? buy[dn - 1] + sell[dn - 1] : -1;
    if (nu >= nd) {
      up++;
      acc += nu;
    } else {
      dn--;
      acc += nd;
    }
  }
  return { lo, step, buy, sell, poc: lo + (poc + 0.5) * step, vah: lo + (up + 1) * step, val: lo + dn * step, exact: exactBars === b - a + 1 };
}

export function drawVolumeProfile(rc: RenderCtx, opts: VolumeProfileOptions, fp: Map<number, FootprintBar> | null): void {
  const { ctx, theme, bars } = rc;
  const draw = (prof: ProfileResult, xRight: number, maxW: number, xLeftBound: number) => {
    const s = rc.pane.scale;
    let max = 0;
    for (let r = 0; r < prof.buy.length; r++) max = Math.max(max, prof.buy[r] + prof.sell[r]);
    if (!(max > 0)) return;
    for (let r = 0; r < prof.buy.length; r++) {
      const p0 = prof.lo + r * prof.step;
      const p1 = p0 + prof.step;
      const y0 = s.toY(p1);
      const y1 = s.toY(p0);
      const h = Math.max(1, y1 - y0 - 1);
      const inVa = p0 >= prof.val - 1e-9 && p1 <= prof.vah + 1e-9;
      const wb = (prof.buy[r] / max) * maxW;
      const ws = (prof.sell[r] / max) * maxW;
      const a = inVa ? 0.42 : 0.2;
      ctx.fillStyle = withAlpha(theme.up, a);
      ctx.fillRect(Math.max(xLeftBound, xRight - wb - ws), y0, wb, h);
      ctx.fillStyle = withAlpha(theme.down, a);
      ctx.fillRect(Math.max(xLeftBound, xRight - ws), y0, ws, h);
    }
    const line = (p: number, color: string, dashed: boolean, label: string) => {
      const y = Math.round(s.toY(p)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(xLeftBound, y);
      ctx.lineTo(xRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `${theme.fontSize - 1}px ${theme.font}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, xLeftBound + 3, y - 1);
    };
    line(prof.poc, '#f5c542', false, `POC ${formatAxis(prof.poc, rc.priceDecimals)}`);
    line(prof.vah, withAlpha(theme.textStrong, 0.6), true, 'VAH');
    line(prof.val, withAlpha(theme.textStrong, 0.6), true, 'VAL');
    if (!prof.exact) {
      ctx.fillStyle = withAlpha(theme.text, 0.7);
      ctx.font = `${theme.fontSize - 2}px ${theme.font}`;
      ctx.textBaseline = 'top';
      ctx.fillText('≈ candle-distributed', Math.max(xLeftBound, xRight - maxW) + 2, s.toY(prof.lo + prof.step * prof.buy.length) + 2);
    }
  };
  if (opts.mode === 'session') {
    // one profile per UTC day in view
    let start = Math.max(0, rc.i0);
    const end = Math.min(bars.length - 1, rc.i1);
    while (start <= end) {
      const day = Math.floor(bars.t[start] / 86400000);
      let stop = start;
      while (stop + 1 <= bars.length - 1 && Math.floor(bars.t[stop + 1] / 86400000) === day) stop++;
      const prof = buildProfile(rc, start, stop, Math.max(8, Math.round(opts.rows * 0.7)), opts.valueArea, fp);
      if (prof) {
        const xl = rc.x(start) - rc.barSpacing / 2;
        const xr = rc.x(stop) + rc.barSpacing / 2;
        draw(prof, xl + (xr - xl) * 0.6, (xr - xl) * 0.6, xl);
      }
      start = stop + 1;
    }
    return;
  }
  let a = rc.i0;
  let b = rc.i1;
  if (opts.mode === 'fixed' && opts.from && opts.to) {
    a = lowerIdx(bars.t, opts.from, bars.length);
    b = lowerIdx(bars.t, opts.to, bars.length) - 1;
  }
  const prof = buildProfile(rc, a, b, opts.rows, opts.valueArea, fp);
  if (!prof) return;
  const width = (opts.width || 0.25) * rc.plotW;
  if (opts.mode === 'fixed') {
    const xl = rc.x(a) - rc.barSpacing / 2;
    const xr = rc.x(b) + rc.barSpacing / 2;
    ctx.fillStyle = withAlpha(rc.theme.accent, 0.05);
    ctx.fillRect(xl, rc.pane.top, xr - xl, rc.pane.height);
    draw(prof, xr, Math.min(width, (xr - xl) * 0.9), xl);
  } else draw(prof, rc.plotW, width, 0);
}

function lowerIdx(t: Float64Array, v: number, n: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// ------------------------------------------------------------------------------ trade lines

interface LineBoxes {
  line: TradeLine;
  y: number;
  label: { x: number; w: number };
  cancel?: { x: number; w: number };
  sl?: { x: number; w: number };
  tp?: { x: number; w: number };
}

function layoutLine(eng: ChartEngine, ctx: CanvasRenderingContext2D, line: TradeLine, priceOverride?: number): LineBoxes {
  const y = Math.round(eng.mainScale.toY(priceOverride ?? line.price)) + 0.5;
  ctx.font = `600 ${eng.theme.fontSize}px ${eng.theme.font}`;
  const text = line.label;
  const w = ctx.measureText(text).width + 14;
  let x = 8;
  const res: LineBoxes = { line, y, label: { x, w } };
  x += w;
  if (line.bracket) {
    res.tp = { x: x + 2, w: 26 };
    res.sl = { x: x + 30, w: 26 };
    x += 58;
  }
  if (line.cancellable) res.cancel = { x: x + 2, w: 18 };
  return res;
}

export function drawTradeLines(rc: RenderCtx, lines: TradeLine[], hoverId: string | null, drag: { id: string; price: number; kind?: 'sl' | 'tp' } | null, eng: ChartEngine): void {
  const { ctx, theme } = rc;
  const pane = eng.panes[0];
  for (const line of lines) {
    const dragging = drag && drag.id === line.id && !drag.kind;
    const price = dragging ? drag!.price : line.price;
    const lb = layoutLine(eng, ctx, line, price);
    if (lb.y < pane.top || lb.y > pane.top + pane.height) continue;
    const hover = hoverId === line.id || dragging;
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = hover ? 1 : 0.85;
    ctx.lineWidth = hover ? 1.5 : 1;
    ctx.setLineDash(line.kind === 'position' ? [] : line.kind === 'liq' ? [2, 2] : line.kind === 'alert' ? [2, 4] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(lb.label.x + lb.label.w, lb.y);
    ctx.lineTo(eng.plotW, lb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // label box
    ctx.fillStyle = line.color;
    roundRect(ctx, lb.label.x, lb.y - 10, lb.label.w, 20, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${theme.fontSize}px ${theme.font}`;
    ctx.fillText(line.label, lb.label.x + 7, lb.y + 0.5);
    const pill = (box: { x: number; w: number } | undefined, text: string, color: string) => {
      if (!box) return;
      ctx.fillStyle = theme.bg;
      roundRect(ctx, box.x, lb.y - 10, box.w, 20, 4);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      roundRect(ctx, box.x + 0.5, lb.y - 9.5, box.w - 1, 19, 4);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(text, box.x + box.w / 2, lb.y + 0.5);
      ctx.textAlign = 'left';
    };
    pill(lb.tp, 'TP', theme.up);
    pill(lb.sl, 'SL', theme.down);
    pill(lb.cancel, '×', line.color);
    // axis label
    eng.axisLabel(ctx, lb.y, formatAxis(price, eng.priceDecimals), line.color, pane);
  }
  // bracket being dragged out of a position line
  if (drag && drag.kind) {
    const y = Math.round(eng.mainScale.toY(drag.price)) + 0.5;
    const col = drag.kind === 'tp' ? theme.up : theme.down;
    ctx.strokeStyle = col;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(eng.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    eng.axisLabel(ctx, y, formatAxis(drag.price, eng.priceDecimals), col, pane);
    ctx.fillStyle = col;
    ctx.font = `600 ${theme.fontSize}px ${theme.font}`;
    ctx.fillText(drag.kind === 'tp' ? 'Take profit' : 'Stop loss', 10, y - 8);
  }
}

export function hitTradeLine(eng: ChartEngine, lines: TradeLine[], x: number, y: number): { line: TradeLine; part: 'line' | 'cancel' | 'sl' | 'tp' } | null {
  const ctx = measureCtx();
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    const lb = layoutLine(eng, ctx, line);
    if (Math.abs(y - lb.y) > 10) continue;
    const inBox = (b?: { x: number; w: number }) => !!b && x >= b.x && x <= b.x + b.w;
    if (inBox(lb.cancel)) return { line, part: 'cancel' };
    if (inBox(lb.sl)) return { line, part: 'sl' };
    if (inBox(lb.tp)) return { line, part: 'tp' };
    if (Math.abs(y - lb.y) <= 5 || inBox(lb.label)) return { line, part: 'line' };
  }
  return null;
}

// ------------------------------------------------------------------------------ executions & strategy trades

export function drawExecutions(rc: RenderCtx, ex: Execution[], eng: ChartEngine): void {
  const { ctx, theme, pane } = rc;
  for (const e of ex) {
    const idx = Math.round(eng.indexOfTime(e.t));
    if (idx < rc.i0 - 1 || idx > rc.i1 + 1) continue;
    const x = rc.x(idx);
    const y = pane.scale.toY(e.price);
    const buy = e.side === 'buy';
    ctx.fillStyle = buy ? theme.up : theme.down;
    ctx.beginPath();
    if (buy) {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y + 8);
      ctx.lineTo(x + 5, y + 8);
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y - 8);
      ctx.lineTo(x + 5, y - 8);
    }
    ctx.closePath();
    ctx.fill();
  }
}

export function drawStrategyTrades(rc: RenderCtx, trades: NonNullable<import('./types').IndicatorOutput['trades']>): void {
  const { ctx, theme, pane } = rc;
  const s = pane.scale;
  for (const t of trades) {
    if (t.exitIndex < rc.i0 - 1 || t.entryIndex > rc.i1 + 1) continue;
    const x1 = rc.x(t.entryIndex);
    const x2 = rc.x(t.exitIndex);
    const y1 = s.toY(t.entryPrice);
    const y2 = s.toY(t.exitPrice);
    const col = t.pnl >= 0 ? theme.up : theme.down;
    ctx.strokeStyle = withAlpha(col, t.open ? 0.5 : 0.8);
    ctx.setLineDash(t.open ? [2, 3] : [4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const mark = (x: number, y: number, up: boolean, label?: string) => {
      ctx.fillStyle = up ? theme.up : theme.down;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(x, y + 2);
        ctx.lineTo(x - 5, y + 10);
        ctx.lineTo(x + 5, y + 10);
      } else {
        ctx.moveTo(x, y - 2);
        ctx.lineTo(x - 5, y - 10);
        ctx.lineTo(x + 5, y - 10);
      }
      ctx.closePath();
      ctx.fill();
      if (label && rc.barSpacing > 4) {
        ctx.font = `${theme.fontSize - 2}px ${theme.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = up ? 'top' : 'bottom';
        ctx.fillText(label, x, up ? y + 12 : y - 12);
        ctx.textAlign = 'left';
      }
    };
    mark(x1, y1, t.dir === 1, t.entryLabel);
    if (t.exitIndex >= 0 && !t.open) mark(x2, y2, t.dir !== 1, t.exitLabel);
  }
}

export { formatVolume };
