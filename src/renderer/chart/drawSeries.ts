import type { RenderCtx } from './engine';
import type { SeriesStyle } from './types';

export function drawSeries(rc: RenderCtx, style: SeriesStyle, barcolors: (string | null)[] | null): void {
  switch (style) {
    case 'line':
      return drawLine(rc, false);
    case 'area':
      return drawLine(rc, true);
    case 'bars':
      return drawBars(rc, barcolors);
    default:
      return drawCandles(rc, style === 'hollow' || rc.theme.hollowUp, barcolors);
  }
}

function drawCandles(rc: RenderCtx, hollow: boolean, barcolors: (string | null)[] | null): void {
  const { ctx, bars: b, i0, i1, theme, pane } = rc;
  const s = pane.scale;
  const lo = Math.max(0, i0);
  const hi = Math.min(b.length - 1, i1);
  if (rc.barSpacing < 1.2) {
    // aggregate per pixel column
    let col = -1;
    let cmin = Infinity;
    let cmax = -Infinity;
    let cup = true;
    const upPath = new Path2D();
    const dnPath = new Path2D();
    const flush = () => {
      if (col < 0) return;
      const y1 = s.toY(cmax);
      const y2 = s.toY(cmin);
      (cup ? upPath : dnPath).rect(col, y1, 1, Math.max(1, y2 - y1));
    };
    for (let i = lo; i <= hi; i++) {
      const x = Math.floor(rc.x(i));
      if (x !== col) {
        flush();
        col = x;
        cmin = b.l[i];
        cmax = b.h[i];
        cup = b.c[i] >= b.o[i];
      } else {
        if (b.l[i] < cmin) cmin = b.l[i];
        if (b.h[i] > cmax) cmax = b.h[i];
        cup = b.c[i] >= b.o[i];
      }
    }
    flush();
    ctx.fillStyle = theme.up;
    ctx.fill(upPath);
    ctx.fillStyle = theme.down;
    ctx.fill(dnPath);
    return;
  }
  const bw = rc.bodyW;
  const half = bw / 2;
  const wickUp = new Path2D();
  const wickDn = new Path2D();
  const bodyUp = new Path2D();
  const bodyDn = new Path2D();
  const custom: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (barcolors && barcolors[i]) {
      custom.push(i);
      continue;
    }
    const x = rc.x(i);
    const o = b.o[i];
    const c = b.c[i];
    const up = c >= o;
    const yo = s.toY(o);
    const yc = s.toY(c);
    const yh = s.toY(b.h[i]);
    const yl = s.toY(b.l[i]);
    const wx = Math.round(x) + (bw >= 3 ? 0 : 0);
    const wick = up ? wickUp : wickDn;
    wick.rect(wx - 0.5, yh, 1, Math.max(1, yl - yh));
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    const left = bw >= 3 ? Math.round(x - half) : x - half;
    const width = bw >= 3 ? Math.round(bw) : Math.max(1, bw);
    (up ? bodyUp : bodyDn).rect(left, top, width, h);
  }
  ctx.fillStyle = theme.wickUp;
  ctx.fill(wickUp);
  ctx.fillStyle = theme.wickDown;
  ctx.fill(wickDn);
  if (hollow) {
    ctx.fillStyle = theme.bg;
    ctx.fill(bodyUp);
    ctx.strokeStyle = theme.up;
    ctx.lineWidth = 1;
    ctx.stroke(bodyUp);
  } else {
    ctx.fillStyle = theme.up;
    ctx.fill(bodyUp);
  }
  ctx.fillStyle = theme.down;
  ctx.fill(bodyDn);
  for (const i of custom) {
    const x = rc.x(i);
    const col = barcolors![i]!;
    ctx.fillStyle = col;
    const yh = s.toY(b.h[i]);
    const yl = s.toY(b.l[i]);
    ctx.fillRect(Math.round(x) - 0.5, yh, 1, Math.max(1, yl - yh));
    const yo = s.toY(b.o[i]);
    const yc = s.toY(b.c[i]);
    ctx.fillRect(Math.round(x - half), Math.min(yo, yc), Math.round(bw), Math.max(1, Math.abs(yc - yo)));
  }
}

function drawBars(rc: RenderCtx, barcolors: (string | null)[] | null): void {
  const { ctx, bars: b, i0, i1, theme, pane } = rc;
  const s = pane.scale;
  const tick = Math.max(1, Math.min(6, rc.barSpacing * 0.35));
  ctx.lineWidth = rc.barSpacing > 8 ? 1.5 : 1;
  for (const up of [true, false]) {
    ctx.strokeStyle = up ? theme.up : theme.down;
    ctx.beginPath();
    for (let i = Math.max(0, i0); i <= Math.min(b.length - 1, i1); i++) {
      if ((b.c[i] >= b.o[i]) !== up || (barcolors && barcolors[i])) continue;
      const x = Math.round(rc.x(i)) + 0.5;
      ctx.moveTo(x, s.toY(b.h[i]));
      ctx.lineTo(x, s.toY(b.l[i]));
      const yo = Math.round(s.toY(b.o[i])) + 0.5;
      const yc = Math.round(s.toY(b.c[i])) + 0.5;
      ctx.moveTo(x - tick, yo);
      ctx.lineTo(x, yo);
      ctx.moveTo(x, yc);
      ctx.lineTo(x + tick, yc);
    }
    ctx.stroke();
  }
  if (barcolors) {
    for (let i = Math.max(0, i0); i <= Math.min(b.length - 1, i1); i++) {
      const col = barcolors[i];
      if (!col) continue;
      ctx.strokeStyle = col;
      ctx.beginPath();
      const x = Math.round(rc.x(i)) + 0.5;
      ctx.moveTo(x, s.toY(b.h[i]));
      ctx.lineTo(x, s.toY(b.l[i]));
      ctx.moveTo(x - tick, s.toY(b.o[i]));
      ctx.lineTo(x, s.toY(b.o[i]));
      ctx.moveTo(x, s.toY(b.c[i]));
      ctx.lineTo(x + tick, s.toY(b.c[i]));
      ctx.stroke();
    }
  }
}

function drawLine(rc: RenderCtx, area: boolean): void {
  const { ctx, bars: b, i0, i1, theme, pane } = rc;
  const s = pane.scale;
  const lo = Math.max(0, i0);
  const hi = Math.min(b.length - 1, i1);
  if (hi < lo) return;
  ctx.beginPath();
  for (let i = lo; i <= hi; i++) {
    const x = rc.x(i);
    const y = s.toY(b.c[i]);
    if (i === lo) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (area) {
    const yb = pane.top + pane.height;
    ctx.lineTo(rc.x(hi), yb);
    ctx.lineTo(rc.x(lo), yb);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, pane.top, 0, yb);
    g.addColorStop(0, withAlpha(theme.accent, 0.28));
    g.addColorStop(1, withAlpha(theme.accent, 0.02));
    ctx.fillStyle = g;
    ctx.fill();
  }
}

export function drawVolume(rc: RenderCtx): void {
  const { ctx, bars: b, i0, i1, theme, pane } = rc;
  const lo = Math.max(0, i0);
  const hi = Math.min(b.length - 1, i1);
  let max = 0;
  for (let i = lo; i <= hi; i++) if (b.v[i] > max) max = b.v[i];
  if (!(max > 0)) return;
  const h = pane.height * 0.16;
  const base = pane.top + pane.height;
  const bw = Math.max(1, rc.barSpacing < 2 ? rc.barSpacing : rc.bodyW);
  const up = new Path2D();
  const dn = new Path2D();
  for (let i = lo; i <= hi; i++) {
    const vh = (b.v[i] / max) * h;
    const x = rc.x(i) - bw / 2;
    (b.c[i] >= b.o[i] ? up : dn).rect(bw >= 3 ? Math.round(x) : x, base - vh, bw >= 3 ? Math.round(bw) : bw, vh);
  }
  ctx.globalAlpha = theme.volumeOpacity;
  ctx.fillStyle = theme.up;
  ctx.fill(up);
  ctx.fillStyle = theme.down;
  ctx.fill(dn);
  ctx.globalAlpha = 1;
}

const alphaCache = new Map<string, string>();
export function withAlpha(color: string, a: number): string {
  const key = `${color}|${a}`;
  let v = alphaCache.get(key);
  if (v) return v;
  let r = 128;
  let g = 128;
  let bl = 128;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    bl = parseInt(full.slice(4, 6), 16);
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (m) [r, g, bl] = m[1].split(',').map((x) => parseFloat(x));
  }
  v = `rgba(${r},${g},${bl},${a})`;
  if (alphaCache.size > 2000) alphaCache.clear();
  alphaCache.set(key, v);
  return v;
}
