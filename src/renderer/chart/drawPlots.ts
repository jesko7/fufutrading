import type { RenderCtx } from './engine';
import type { IndicatorOutput, PlotSeries, ShapeSeries } from './types';
import { withAlpha } from './drawSeries';

/** Min/max of an indicator's drawable values over visible bars (for autoscale). */
export function indicatorRange(ind: IndicatorOutput, i0: number, i1: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ind.plots) {
    if (p.visible === false) continue;
    const off = p.offset || 0;
    const a = Math.max(0, i0 - off);
    const b = Math.min(p.values.length - 1, i1 - off);
    for (let i = a; i <= b; i++) {
      const v = p.values[i];
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // candles and bars: their wicks
    if (p.h && p.l) {
      for (let i = a; i <= b; i++) {
        const x = p.h[i];
        const y = p.l[i];
        if (isFinite(x) && x > hi) hi = x;
        if (isFinite(y) && y < lo) lo = y;
      }
    }
    if ((p.type === 'histogram' || p.type === 'columns') && isFinite(lo)) {
      const base = p.histbase ?? 0;
      lo = Math.min(lo, base);
      hi = Math.max(hi, base);
    }
  }
  for (const h of ind.hlines) {
    if (!ind.overlay) {
      lo = Math.min(lo, h.price);
      hi = Math.max(hi, h.price);
    }
  }
  for (const s of ind.shapes) {
    if (s.location !== 'absolute') continue;
    for (let i = Math.max(0, i0); i <= Math.min(s.values.length - 1, i1); i++) {
      const v = s.values[i];
      if (isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (ind.scaleMin !== undefined) lo = Math.min(lo, ind.scaleMin);
  if (ind.scaleMax !== undefined) hi = Math.max(hi, ind.scaleMax);
  return [lo, hi];
}

function dash(ctx: CanvasRenderingContext2D, style: string): void {
  ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 3] : []);
}

export function drawIndicatorBase(rc: RenderCtx, ind: IndicatorOutput): void {
  const { ctx } = rc;
  // fills first (behind plots)
  for (const f of ind.fills) drawFill(rc, ind, f.a, f.b, f.color, f.colors);
  for (const h of ind.hlines) {
    const y = Math.round(rc.pane.scale.toY(h.price)) + 0.5;
    ctx.strokeStyle = h.color;
    ctx.lineWidth = h.width;
    dash(ctx, h.style);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(rc.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const p of ind.plots) if (p.visible !== false) drawPlot(rc, p);
  for (const s of ind.shapes) drawShapes(rc, s);
  if (ind.polys) for (const p of ind.polys) drawPoly(rc, p);
  if (ind.boxes) for (const b of ind.boxes) drawBox(rc, b);
  if (ind.lines) for (const l of ind.lines) drawScriptLine(rc, l);
  if (ind.labels) for (const l of ind.labels) drawLabel(rc, l);
  if (ind.tables) for (const t of ind.tables) drawTable(rc, t);
}

function drawPlot(rc: RenderCtx, p: PlotSeries): void {
  const { ctx, i0, i1, pane } = rc;
  const s = pane.scale;
  const off = p.offset || 0;
  const lo = Math.max(0, i0 - off - 1);
  const hi = Math.min(p.values.length - 1, i1 - off + 1);
  if (hi < lo) return;
  ctx.lineWidth = p.width || 1;
  ctx.lineJoin = 'round';
  const colorAt = (i: number) => (p.colors ? p.colors[i] : p.color);
  switch (p.type) {
    case 'candles':
    case 'bars': {
      // plotcandle / plotbar: like the main series, in the plot's (per-bar) color
      if (!p.o || !p.h || !p.l) return;
      const bw = Math.max(1, rc.bodyW);
      const tick = Math.max(1, Math.floor(bw / 2));
      for (let i = lo; i <= hi; i++) {
        const o = p.o[i];
        const h = p.h[i];
        const l = p.l[i];
        const c = p.values[i];
        const col = colorAt(i);
        if (!col || !isFinite(o) || !isFinite(c)) continue;
        const x = Math.round(rc.x(i + off));
        const yo = s.toY(o);
        const yc = s.toY(c);
        const yh = s.toY(isFinite(h) ? h : Math.max(o, c));
        const yl = s.toY(isFinite(l) ? l : Math.min(o, c));
        ctx.fillStyle = col;
        // wick / bar: a vertical line from high to low
        ctx.fillRect(x, Math.min(yh, yl), 1, Math.max(1, Math.abs(yl - yh)));
        if (p.type === 'candles') {
          ctx.fillRect(Math.round(x - bw / 2 + 0.5), Math.min(yo, yc), Math.max(1, Math.round(bw)), Math.max(1, Math.abs(yc - yo)));
        } else {
          ctx.fillRect(x - tick, Math.round(yo), tick, 1);
          ctx.fillRect(x + 1, Math.round(yc), tick, 1);
        }
      }
      return;
    }
    case 'histogram':
    case 'columns': {
      const base = s.toY(p.histbase ?? 0);
      const w = p.type === 'columns' ? Math.max(1, rc.bodyW) : Math.max(1, Math.min(p.width || 1, rc.barSpacing));
      for (let i = lo; i <= hi; i++) {
        const v = p.values[i];
        const c = colorAt(i);
        if (!isFinite(v) || !c) continue;
        const y = s.toY(v);
        ctx.fillStyle = c;
        const x = rc.x(i + off);
        ctx.fillRect(x - w / 2, Math.min(y, base), w, Math.max(1, Math.abs(base - y)));
      }
      return;
    }
    case 'circles':
    case 'cross': {
      const r = Math.max(1.5, (p.width || 1) + 0.5);
      for (let i = lo; i <= hi; i++) {
        const v = p.values[i];
        const c = colorAt(i);
        if (!isFinite(v) || !c) continue;
        const x = rc.x(i + off);
        const y = s.toY(v);
        ctx.fillStyle = c;
        ctx.strokeStyle = c;
        if (p.type === 'circles') {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(x - r - 1, y);
          ctx.lineTo(x + r + 1, y);
          ctx.moveTo(x, y - r - 1);
          ctx.lineTo(x, y + r + 1);
          ctx.stroke();
        }
      }
      return;
    }
    case 'area':
    case 'areabr': {
      // fill to the bottom of the pane
      const yb = pane.top + pane.height;
      let started = false;
      let firstX = 0;
      let lastX = 0;
      ctx.beginPath();
      for (let i = lo; i <= hi; i++) {
        const v = p.values[i];
        if (!isFinite(v)) {
          if (p.type === 'areabr' && started) {
            ctx.lineTo(lastX, yb);
            ctx.lineTo(firstX, yb);
            ctx.closePath();
            started = false;
          }
          continue;
        }
        const x = rc.x(i + off);
        const y = s.toY(v);
        if (!started) {
          ctx.moveTo(x, y);
          firstX = x;
          started = true;
        } else ctx.lineTo(x, y);
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, yb);
        ctx.lineTo(firstX, yb);
        ctx.closePath();
      }
      ctx.fillStyle = withAlpha(p.color, 0.18);
      ctx.fill();
      // outline
      strokeSegments(rc, p, lo, hi, off, p.type === 'areabr');
      return;
    }
    default:
      strokeSegments(rc, p, lo, hi, off, p.type === 'linebr');
  }
}

/** Draw a line plot, splitting into segments when color changes (per-bar colors). */
function strokeSegments(rc: RenderCtx, p: PlotSeries, lo: number, hi: number, off: number, breakOnNa: boolean): void {
  const { ctx, pane } = rc;
  const s = pane.scale;
  const step = p.type === 'stepline';
  let curColor: string | null = null;
  let px = NaN;
  let py = NaN;
  let open = false;
  const begin = (c: string) => {
    if (open) ctx.stroke();
    ctx.strokeStyle = c;
    ctx.beginPath();
    curColor = c;
    open = true;
  };
  for (let i = lo; i <= hi; i++) {
    const v = p.values[i];
    const c = p.colors ? p.colors[i] : p.color;
    if (!isFinite(v) || !c) {
      if (breakOnNa || !c) {
        px = NaN;
        py = NaN;
      }
      continue;
    }
    const x = rc.x(i + off);
    const y = s.toY(v);
    if (c !== curColor) {
      begin(c);
      if (isFinite(px)) ctx.moveTo(px, py);
      else ctx.moveTo(x, y);
    } else if (!isFinite(px)) ctx.moveTo(x, y);
    if (isFinite(px)) {
      if (step) {
        ctx.lineTo(x, py);
        ctx.lineTo(x, y);
      } else ctx.lineTo(x, y);
    }
    px = x;
    py = y;
  }
  if (open) ctx.stroke();
}

function plotValues(ind: IndicatorOutput, id: string): Float64Array | number | null {
  const p = ind.plots.find((x) => x.id === id);
  if (p) return p.values;
  const h = ind.hlines.find((x) => x.id === id);
  if (h) return h.price;
  return null;
}

function drawFill(rc: RenderCtx, ind: IndicatorOutput, a: string, b: string, color: string, colors?: (string | null)[]): void {
  const va = plotValues(ind, a);
  const vb = plotValues(ind, b);
  if (va === null || vb === null) return;
  const { ctx, i0, i1, pane } = rc;
  const s = pane.scale;
  const n = Math.max(typeof va === 'number' ? 0 : va.length, typeof vb === 'number' ? 0 : vb.length);
  const lo = Math.max(0, i0 - 1);
  const hi = Math.min(n ? n - 1 : rc.bars.length - 1, i1 + 1);
  const get = (v: Float64Array | number, i: number) => (typeof v === 'number' ? v : v[i]);
  if (typeof va === 'number' && typeof vb === 'number' && !colors) {
    const y1 = s.toY(va);
    const y2 = s.toY(vb);
    ctx.fillStyle = color;
    ctx.fillRect(0, Math.min(y1, y2), rc.plotW, Math.abs(y2 - y1));
    return;
  }
  // draw quads between consecutive bars (handles per-bar colors and na gaps)
  for (let i = lo; i < hi; i++) {
    const c = colors ? colors[i + 1] : color;
    if (!c) continue;
    const a1 = get(va, i);
    const a2 = get(va, i + 1);
    const b1 = get(vb, i);
    const b2 = get(vb, i + 1);
    if (!isFinite(a1) || !isFinite(a2) || !isFinite(b1) || !isFinite(b2)) continue;
    const x1 = rc.x(i);
    const x2 = rc.x(i + 1);
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x1, s.toY(a1));
    ctx.lineTo(x2, s.toY(a2));
    ctx.lineTo(x2, s.toY(b2));
    ctx.lineTo(x1, s.toY(b1));
    ctx.closePath();
    ctx.fill();
  }
}

const SIZE_PX: Record<string, number> = { tiny: 5, small: 7, normal: 9, auto: 8, large: 13, huge: 18 };

function drawShapes(rc: RenderCtx, sh: ShapeSeries): void {
  const { ctx, i0, i1, bars: b, pane, theme } = rc;
  const s = pane.scale;
  const off = sh.offset || 0;
  const sz = SIZE_PX[sh.size] || 8;
  for (let i = Math.max(0, i0 - off); i <= Math.min(sh.values.length - 1, i1 - off); i++) {
    const v = sh.values[i];
    if (sh.location === 'absolute' ? !isFinite(v) : !(v && isFinite(v))) continue;
    const c = sh.colors ? sh.colors[i] : sh.color;
    if (!c) continue;
    const x = rc.x(i + off);
    let y: number;
    const bi = Math.min(b.length - 1, i);
    switch (sh.location) {
      case 'abovebar':
        y = s.toY(b.h[bi]) - sz - 4;
        break;
      case 'belowbar':
        y = s.toY(b.l[bi]) + sz + 4;
        break;
      case 'top':
        y = pane.top + sz + 2;
        break;
      case 'bottom':
        y = pane.top + pane.height - sz - 2;
        break;
      default:
        y = s.toY(v);
    }
    ctx.fillStyle = c;
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    const below = sh.location === 'belowbar';
    switch (sh.style) {
      case 'triangleup':
        tri(ctx, x, y, sz, true);
        break;
      case 'triangledown':
        tri(ctx, x, y, sz, false);
        break;
      case 'arrowup':
        arrow(ctx, x, y, sz, true);
        break;
      case 'arrowdown':
        arrow(ctx, x, y, sz, false);
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(x, y, sz / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'square':
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        break;
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(x, y - sz / 2);
        ctx.lineTo(x + sz / 2, y);
        ctx.lineTo(x, y + sz / 2);
        ctx.lineTo(x - sz / 2, y);
        ctx.closePath();
        ctx.fill();
        break;
      case 'cross':
      case 'xcross': {
        ctx.beginPath();
        const r = sz / 2;
        if (sh.style === 'cross') {
          ctx.moveTo(x - r, y);
          ctx.lineTo(x + r, y);
          ctx.moveTo(x, y - r);
          ctx.lineTo(x, y + r);
        } else {
          ctx.moveTo(x - r, y - r);
          ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r);
          ctx.lineTo(x - r, y + r);
        }
        ctx.stroke();
        break;
      }
      case 'flag':
        ctx.fillRect(x - 1, y - sz / 2, 1.5, sz);
        ctx.fillRect(x, y - sz / 2, sz * 0.7, sz * 0.45);
        break;
      case 'labelup':
      case 'labeldown':
        if (sh.text) {
          labelBubble(ctx, x, y, sh.text, c, sh.textColor || '#fff', sh.style === 'labelup', theme.font, theme.fontSize);
          continue;
        }
        tri(ctx, x, y, sz, sh.style === 'labelup');
        break;
      case 'char':
        ctx.font = `${sz + 4}px ${theme.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sh.char || '•', x, y);
        ctx.textAlign = 'left';
        break;
    }
    if (sh.text && sh.style !== 'labelup' && sh.style !== 'labeldown') {
      ctx.font = `${theme.fontSize - 1}px ${theme.font}`;
      ctx.fillStyle = sh.textColor || c;
      ctx.textAlign = 'center';
      ctx.textBaseline = below ? 'top' : 'bottom';
      ctx.fillText(sh.text, x, below ? y + sz / 2 + 2 : y - sz / 2 - 2);
      ctx.textAlign = 'left';
    }
  }
}

function tri(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, up: boolean): void {
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y - s / 2);
    ctx.lineTo(x + s / 2, y + s / 2);
    ctx.lineTo(x - s / 2, y + s / 2);
  } else {
    ctx.moveTo(x, y + s / 2);
    ctx.lineTo(x + s / 2, y - s / 2);
    ctx.lineTo(x - s / 2, y - s / 2);
  }
  ctx.closePath();
  ctx.fill();
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, up: boolean): void {
  const d = up ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, y - (d * s) / 2);
  ctx.lineTo(x + s / 2, y);
  ctx.lineTo(x + s / 5, y);
  ctx.lineTo(x + s / 5, y + (d * s) / 2);
  ctx.lineTo(x - s / 5, y + (d * s) / 2);
  ctx.lineTo(x - s / 5, y);
  ctx.lineTo(x - s / 2, y);
  ctx.closePath();
  ctx.fill();
}

export function labelBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, pointUp: boolean, font: string, fontSize: number): void {
  ctx.font = `600 ${fontSize - 1}px ${font}`;
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
  const h = lines.length * (fontSize + 2) + 6;
  const top = pointUp ? y + 5 : y - 5 - h;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, top, w, h, 3);
  ctx.fill();
  ctx.beginPath();
  if (pointUp) {
    ctx.moveTo(x - 4, top);
    ctx.lineTo(x, top - 5);
    ctx.lineTo(x + 4, top);
  } else {
    ctx.moveTo(x - 4, top + h);
    ctx.lineTo(x, top + h + 5);
    ctx.lineTo(x + 4, top + h);
  }
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((l, k) => ctx.fillText(l, x, top + 3 + k * (fontSize + 2)));
  ctx.textAlign = 'left';
}

function drawLabel(rc: RenderCtx, l: NonNullable<IndicatorOutput['labels']>[number]): void {
  const { ctx, pane, theme, bars: b } = rc;
  const x = rc.x(l.x);
  if (x < -100 || x > rc.plotW + 100) return;
  const bi = Math.max(0, Math.min(b.length - 1, Math.round(l.x)));
  let y = pane.scale.toY(l.y);
  if (l.yloc === 'abovebar') y = pane.scale.toY(b.h[bi]) - 6;
  if (l.yloc === 'belowbar') y = pane.scale.toY(b.l[bi]) + 6;
  const st = l.style || 'label_down';
  if (st === 'label_none' || st === 'none') {
    ctx.font = `${theme.fontSize}px ${theme.font}`;
    ctx.fillStyle = l.textColor || theme.textStrong;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(l.text, x, y);
    ctx.textAlign = 'left';
    return;
  }
  const up = st.includes('up') || l.yloc === 'belowbar';
  labelBubble(ctx, x, y, l.text || ' ', l.color || theme.accent, l.textColor || '#fff', up, theme.font, theme.fontSize);
}

function drawScriptLine(rc: RenderCtx, l: NonNullable<IndicatorOutput['lines']>[number]): void {
  const { ctx, pane } = rc;
  let x1 = rc.x(l.x1);
  let y1 = pane.scale.toY(l.y1);
  let x2 = rc.x(l.x2);
  let y2 = pane.scale.toY(l.y2);
  if (l.extend !== 'none' && x2 !== x1) {
    const m = (y2 - y1) / (x2 - x1);
    if (l.extend === 'right' || l.extend === 'both') {
      const nx = rc.plotW + 10;
      y2 = y1 + m * (nx - x1);
      x2 = nx;
    }
    if (l.extend === 'left' || l.extend === 'both') {
      const nx = -10;
      y1 = y1 + m * (nx - x1);
      x1 = nx;
    }
  }
  ctx.strokeStyle = l.color;
  ctx.lineWidth = l.width || 1;
  dash(ctx, l.style);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPoly(rc: RenderCtx, p: NonNullable<IndicatorOutput['polys']>[number]): void {
  const { ctx, pane } = rc;
  const pts = p.pts.map(([x, y]) => [rc.x(x), pane.scale.toY(y)] as [number, number]);
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (p.curved && pts.length > 2) {
    // smooth curve through the points (midpoint quadratic segments)
    for (let k = 1; k < pts.length - 1; k++) {
      const mx = (pts[k][0] + pts[k + 1][0]) / 2;
      const my = (pts[k][1] + pts[k + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[k][0], pts[k][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  } else for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  if (p.closed) ctx.closePath();
  if (p.fill) {
    ctx.fillStyle = p.fill;
    ctx.fill();
  }
  if (p.stroke) {
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = p.width || 1;
    dash(ctx, p.style || 'solid');
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawBox(rc: RenderCtx, bx: NonNullable<IndicatorOutput['boxes']>[number]): void {
  const { ctx, pane, theme } = rc;
  let x1 = rc.x(bx.left);
  let x2 = rc.x(bx.right);
  if (bx.extend === 'right' || bx.extend === 'both') x2 = rc.plotW;
  if (bx.extend === 'left' || bx.extend === 'both') x1 = 0;
  const y1 = pane.scale.toY(bx.top);
  const y2 = pane.scale.toY(bx.bottom);
  ctx.fillStyle = bx.bg;
  ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  if (bx.width > 0) {
    ctx.strokeStyle = bx.border;
    ctx.lineWidth = bx.width;
    dash(ctx, bx.style || 'solid');
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
  if (bx.text) {
    ctx.fillStyle = bx.textColor || theme.textStrong;
    ctx.font = `${theme.fontSize}px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bx.text, (x1 + x2) / 2, (y1 + y2) / 2);
    ctx.textAlign = 'left';
  }
}

function drawTable(rc: RenderCtx, t: NonNullable<IndicatorOutput['tables']>[number]): void {
  const { ctx, pane, theme } = rc;
  if (!t.cells.length) return;
  ctx.font = `${theme.fontSize}px ${theme.font}`;
  const rows = Math.max(...t.cells.map((c) => c.row)) + 1;
  const cols = Math.max(...t.cells.map((c) => c.col)) + 1;
  const colW = new Array(cols).fill(0);
  for (const c of t.cells) colW[c.col] = Math.max(colW[c.col], ctx.measureText(c.text).width + 12);
  const rowH = theme.fontSize + 9;
  const W = colW.reduce((a, b) => a + b, 0);
  const H = rows * rowH;
  const pos = t.position || 'top_right';
  const x0 = pos.includes('left') ? 8 : pos.includes('center') ? (rc.plotW - W) / 2 : rc.plotW - W - 8;
  const y0 = pos.startsWith('top') ? pane.top + 8 : pos.startsWith('middle') ? pane.top + (pane.height - H) / 2 : pane.top + pane.height - H - 8;
  ctx.fillStyle = t.bg || withAlpha(theme.bg, 0.85);
  ctx.fillRect(x0, y0, W, H);
  for (const c of t.cells) {
    const x = x0 + colW.slice(0, c.col).reduce((a, b) => a + b, 0);
    const y = y0 + c.row * rowH;
    if (c.bg) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(x, y, colW[c.col], rowH);
    }
    ctx.fillStyle = c.color || theme.textStrong;
    ctx.textBaseline = 'middle';
    ctx.fillText(c.text, x + 6, y + rowH / 2);
  }
  if (t.border) {
    ctx.strokeStyle = t.border;
    ctx.strokeRect(x0, y0, W, H);
  }
}
