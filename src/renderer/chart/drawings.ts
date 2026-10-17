import type { ChartEngine, RenderCtx } from './engine';
import { roundRect, measureCtx } from './engine';
import { DRAWING_POINTS, FIB_EXT_LEVELS, FIB_LEVELS, FIB_TIME, type Drawing, type DrawingPoint, type DrawingType } from './types';
import { withAlpha } from './drawSeries';
import { formatAxis } from './scale';
import { fmtDateTime, fmtDuration } from '../lib/format';

const HIT = 6;
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff', '#9c27b0', '#e91e63'];

let idSeq = 0;
export function newDrawingId(): string {
  return `d${Date.now().toString(36)}${(idSeq++).toString(36)}`;
}

export function defaultDrawing(type: DrawingType, points: DrawingPoint[], color = '#2962ff'): Drawing {
  return {
    id: newDrawingId(),
    type,
    points,
    color: type === 'fib' || type === 'fibext' || type === 'fibtime' ? '#787b86' : color,
    width: type === 'text' ? 1 : 1.5,
    dash: 'solid',
    fill: type === 'rect' || type === 'channel' ? withAlpha(color, 0.12) : undefined,
    levels: type === 'fib' ? FIB_LEVELS.slice() : type === 'fibext' ? FIB_EXT_LEVELS.slice() : type === 'fibtime' ? FIB_TIME.slice() : undefined,
    text: type === 'text' ? 'Text' : undefined,
    showLabels: true,
  };
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Extend segment to the plot bounds in given directions. */
function extendSeg(x1: number, y1: number, x2: number, y2: number, left: boolean, right: boolean, W: number): [number, number, number, number] {
  if (x2 === x1) return [x1, y1, x2, y2];
  const m = (y2 - y1) / (x2 - x1);
  let ax = x1;
  let ay = y1;
  let bx = x2;
  let by = y2;
  if (right) {
    const tx = x2 >= x1 ? W + 50 : -50;
    by = y1 + m * (tx - x1);
    bx = tx;
  }
  if (left) {
    const tx = x2 >= x1 ? -50 : W + 50;
    ay = y1 + m * (tx - x1);
    ax = tx;
  }
  return [ax, ay, bx, by];
}

export class DrawingLayer {
  drawings: Drawing[] = [];
  tool: DrawingType | null = null;
  selected: string | null = null;
  private hover: string | null = null;
  private pending: { type: DrawingType; points: DrawingPoint[]; downAt?: { x: number; y: number } } | null = null;
  private drag: { id: string; mode: 'handle' | 'body'; handle: number; x0: number; y0: number; orig: DrawingPoint[]; moved: boolean } | null = null;
  keepTool = false;

  constructor(private eng: ChartEngine) {}

  setDrawings(d: Drawing[]): void {
    this.drawings = d;
    if (this.selected && !d.some((x) => x.id === this.selected)) this.selected = null;
  }

  setTool(t: DrawingType | null): void {
    this.tool = t;
    this.pending = null;
    if (t) this.selected = null;
  }

  isDragging(): boolean {
    return !!this.drag || !!(this.pending && this.pending.downAt);
  }

  private pt(p: DrawingPoint): { x: number; y: number } {
    return { x: this.eng.x(this.eng.indexOfTime(p.t)), y: this.eng.mainScale.toY(p.p) };
  }

  private commit(list: Drawing[]): void {
    this.drawings = list;
    this.eng.emitDrawingsChange(list);
  }

  // ------------------------------------------------------------------ hit testing

  hitId(x: number, y: number): string | null {
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k];
      if (d.hidden) continue;
      if (this.hitDrawing(d, x, y)) return d.id;
    }
    return null;
  }

  private handleAt(d: Drawing, x: number, y: number): number {
    for (let i = 0; i < d.points.length; i++) {
      const p = this.pt(d.points[i]);
      if (Math.hypot(p.x - x, p.y - y) <= HIT + 1) return i;
    }
    return -1;
  }

  private hitDrawing(d: Drawing, x: number, y: number): boolean {
    const W = this.eng.plotW;
    const P = d.points.map((p) => this.pt(p));
    switch (d.type) {
      case 'hline':
        return Math.abs(y - P[0].y) <= HIT;
      case 'hray':
        return Math.abs(y - P[0].y) <= HIT && x >= P[0].x - HIT;
      case 'vline':
        return Math.abs(x - P[0].x) <= HIT;
      case 'trend':
      case 'ray':
      case 'extended': {
        const [ax, ay, bx, by] = extendSeg(P[0].x, P[0].y, P[1].x, P[1].y, d.type === 'extended' || !!d.extendLeft, d.type !== 'trend' || !!d.extendRight, W);
        return distToSeg(x, y, ax, ay, bx, by) <= HIT;
      }
      case 'channel': {
        if (P.length < 3) return distToSeg(x, y, P[0].x, P[0].y, P[1].x, P[1].y) <= HIT;
        const off = this.channelOffset(d);
        const p3a = { x: P[0].x, y: this.eng.mainScale.toY(d.points[0].p + off) };
        const p3b = { x: P[1].x, y: this.eng.mainScale.toY(d.points[1].p + off) };
        return distToSeg(x, y, P[0].x, P[0].y, P[1].x, P[1].y) <= HIT || distToSeg(x, y, p3a.x, p3a.y, p3b.x, p3b.y) <= HIT;
      }
      case 'rect':
      case 'measure': {
        const x1 = Math.min(P[0].x, P[1].x);
        const x2 = Math.max(P[0].x, P[1].x);
        const y1 = Math.min(P[0].y, P[1].y);
        const y2 = Math.max(P[0].y, P[1].y);
        return x >= x1 - HIT && x <= x2 + HIT && y >= y1 - HIT && y <= y2 + HIT;
      }
      case 'fib': {
        const x1 = Math.min(P[0].x, P[1].x);
        const x2 = d.extendRight ? W : Math.max(P[0].x, P[1].x);
        if (x < x1 - HIT || x > x2 + HIT) return false;
        for (const lv of d.levels || FIB_LEVELS) {
          const price = d.points[1].p + (d.points[0].p - d.points[1].p) * lv;
          if (Math.abs(this.eng.mainScale.toY(price) - y) <= HIT) return true;
        }
        return distToSeg(x, y, P[0].x, P[0].y, P[1].x, P[1].y) <= HIT;
      }
      case 'fibext': {
        if (P.length < 3) return distToSeg(x, y, P[0].x, P[0].y, P[1].x, P[1].y) <= HIT;
        for (const lv of d.levels || FIB_EXT_LEVELS) {
          const price = d.points[2].p + (d.points[1].p - d.points[0].p) * lv;
          if (Math.abs(this.eng.mainScale.toY(price) - y) <= HIT && x >= P[2].x - HIT) return true;
        }
        return distToSeg(x, y, P[0].x, P[0].y, P[1].x, P[1].y) <= HIT || distToSeg(x, y, P[1].x, P[1].y, P[2].x, P[2].y) <= HIT;
      }
      case 'fibtime': {
        const i0 = this.eng.indexOfTime(d.points[0].t);
        const unit = this.eng.indexOfTime(d.points[1].t) - i0;
        for (const n of d.levels || FIB_TIME) if (Math.abs(this.eng.x(i0 + unit * n) - x) <= HIT) return true;
        return false;
      }
      case 'text': {
        const ctx = measureCtx();
        ctx.font = `13px ${this.eng.theme.font}`;
        const w = ctx.measureText(d.text || '').width + 12;
        return x >= P[0].x - 2 && x <= P[0].x + w && y >= P[0].y - 20 && y <= P[0].y + 4;
      }
    }
    return false;
  }

  private channelOffset(d: Drawing): number {
    // price offset of point 3 relative to the base line at point 3's time
    const [a, b, c] = d.points;
    const ia = this.eng.indexOfTime(a.t);
    const ib = this.eng.indexOfTime(b.t);
    const ic = this.eng.indexOfTime(c.t);
    const base = ib === ia ? a.p : a.p + ((b.p - a.p) * (ic - ia)) / (ib - ia);
    return c.p - base;
  }

  cursorAt(x: number, y: number): string | null {
    if (this.tool) return 'crosshair';
    const sel = this.drawings.find((d) => d.id === this.selected);
    if (sel && !sel.locked && this.handleAt(sel, x, y) >= 0) return 'move';
    const id = this.hitId(x, y);
    if (id) {
      const d = this.drawings.find((q) => q.id === id)!;
      return d.locked ? 'pointer' : 'grab';
    }
    return null;
  }

  onHover(x: number, y: number): void {
    this.hover = this.tool ? null : this.hitId(x, y);
  }

  // ------------------------------------------------------------------ interaction

  /** Returns true if the event was consumed. */
  onDown(x: number, y: number, e: MouseEvent): boolean {
    if (this.tool) {
      const p = this.eng.snapPoint(x, y);
      if (!this.pending) {
        this.pending = { type: this.tool, points: [p], downAt: { x, y } };
        if (DRAWING_POINTS[this.tool] === 1) this.finishPending(e.shiftKey);
      } else {
        this.pending.points.push(p);
        this.pending.downAt = { x, y };
        if (this.pending.points.length >= DRAWING_POINTS[this.pending.type]) this.finishPending(e.shiftKey);
      }
      return true;
    }
    const sel = this.drawings.find((d) => d.id === this.selected);
    if (sel && !sel.locked) {
      const h = this.handleAt(sel, x, y);
      if (h >= 0) {
        this.drag = { id: sel.id, mode: 'handle', handle: h, x0: x, y0: y, orig: sel.points.map((p) => ({ ...p })), moved: false };
        return true;
      }
    }
    const id = this.hitId(x, y);
    if (id) {
      this.selected = id;
      this.eng.emitDrawingSelect(id);
      const d = this.drawings.find((q) => q.id === id)!;
      if (!d.locked) this.drag = { id, mode: 'body', handle: -1, x0: x, y0: y, orig: d.points.map((p) => ({ ...p })), moved: false };
      return true;
    }
    if (this.selected) {
      this.selected = null;
      this.eng.emitDrawingSelect(null);
    }
    return false;
  }

  onDrag(x: number, y: number, _e: MouseEvent): void {
    if (this.pending && this.pending.downAt) {
      // dragging during creation: live preview handled in render via mouse position
      return;
    }
    const dr = this.drag;
    if (!dr) return;
    if (Math.hypot(x - dr.x0, y - dr.y0) > 2) dr.moved = true;
    const d = this.drawings.find((q) => q.id === dr.id);
    if (!d) return;
    const eng = this.eng;
    if (dr.mode === 'handle') {
      const p = eng.snapPoint(x, y);
      d.points = dr.orig.map((o, i) => (i === dr.handle ? p : o));
      if (d.type === 'hline' || d.type === 'hray') d.points = [{ t: d.points[0].t, p: p.p }];
    } else {
      const di = eng.indexAtX(x) - eng.indexAtX(dr.x0);
      const dp = eng.mainScale.fromY(y) - eng.mainScale.fromY(dr.y0);
      const logMode = eng.mainScale.mode === 'log';
      d.points = dr.orig.map((o) => {
        const ni = eng.indexOfTime(o.t) + di;
        const np = logMode ? eng.mainScale.fromY(eng.mainScale.toY(o.p) + (y - dr.y0)) : o.p + dp;
        return { t: eng.timeOfIndex(ni), p: np };
      });
    }
  }

  onUp(x: number, y: number): void {
    if (this.pending && this.pending.downAt) {
      const moved = Math.hypot(x - this.pending.downAt.x, y - this.pending.downAt.y) > 5;
      this.pending.downAt = undefined;
      if (moved && this.pending.points.length < DRAWING_POINTS[this.pending.type]) {
        this.pending.points.push(this.eng.snapPoint(x, y));
        if (this.pending.points.length >= DRAWING_POINTS[this.pending.type]) this.finishPending(false);
      }
      return;
    }
    const dr = this.drag;
    this.drag = null;
    if (dr && dr.moved) this.commit(this.drawings.slice());
  }

  onDblClick(x: number, y: number): boolean {
    const id = this.hitId(x, y);
    if (!id) return false;
    this.selected = id;
    this.eng.emitDrawingSelect(id);
    return true;
  }

  private finishPending(keep: boolean): void {
    const p = this.pending!;
    this.pending = null;
    const d = defaultDrawing(p.type, p.points.slice(0, DRAWING_POINTS[p.type]));
    this.selected = d.id;
    this.commit([...this.drawings, d]);
    this.eng.emitDrawingSelect(d.id);
    if (!keep && !this.keepTool) {
      this.tool = null;
      this.eng.emitToolDone();
    }
  }

  cancelInProgress(): boolean {
    if (this.pending) {
      this.pending = null;
      return true;
    }
    return false;
  }

  /** Cancel what Escape cancels (a drawing in progress, the tool, the selection); false when there was nothing. */
  escape(): boolean {
    if (this.pending) this.pending = null;
    else if (this.tool) {
      this.tool = null;
      this.eng.emitToolDone();
    } else if (this.selected) {
      this.selected = null;
      this.eng.emitDrawingSelect(null);
    } else return false;
    return true;
  }

  deleteSelected(): boolean {
    const d = this.drawings.find((q) => q.id === this.selected);
    if (!d || d.locked) return false;
    this.selected = null;
    this.commit(this.drawings.filter((q) => q.id !== d.id));
    this.eng.emitDrawingSelect(null);
    return true;
  }

  // ------------------------------------------------------------------ rendering

  render(rc: RenderCtx): void {
    for (const d of this.drawings) if (!d.hidden) this.renderOne(rc, d, d.id === this.selected, d.id === this.hover);
    if (this.pending) {
      const m = this.eng.mousePos;
      const pts = [...this.pending.points];
      if (m.inside && pts.length < DRAWING_POINTS[this.pending.type]) pts.push(this.eng.snapPoint(m.x, m.y));
      const preview = defaultDrawing(this.pending.type, pts);
      if (pts.length >= 1) this.renderOne(rc, preview, true, false, true);
    }
  }

  private renderOne(rc: RenderCtx, d: Drawing, selected: boolean, hover: boolean, preview = false): void {
    const { ctx, theme } = rc;
    const eng = this.eng;
    const W = eng.plotW;
    const P = d.points.map((p) => this.pt(p));
    const need = DRAWING_POINTS[d.type];
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.width + (hover ? 0.5 : 0);
    ctx.setLineDash(d.dash === 'dashed' ? [6, 4] : d.dash === 'dotted' ? [2, 3] : []);
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const font = `${theme.fontSize}px ${theme.font}`;
    switch (d.type) {
      case 'hline': {
        const y = Math.round(P[0].y) + 0.5;
        line(0, y, W, y);
        ctx.setLineDash([]);
        if (!preview) eng.axisLabel(ctx, y, formatAxis(d.points[0].p, eng.priceDecimals), d.color, eng.panes[0]);
        break;
      }
      case 'hray': {
        const y = Math.round(P[0].y) + 0.5;
        line(P[0].x, y, W, y);
        break;
      }
      case 'vline': {
        const x = Math.round(P[0].x) + 0.5;
        line(x, 0, x, eng.plotH);
        break;
      }
      case 'trend':
      case 'ray':
      case 'extended': {
        if (P.length < 2) break;
        const [ax, ay, bx, by] = extendSeg(P[0].x, P[0].y, P[1].x, P[1].y, d.type === 'extended' || !!d.extendLeft, d.type !== 'trend' || !!d.extendRight, W);
        line(ax, ay, bx, by);
        break;
      }
      case 'channel': {
        if (P.length < 2) break;
        line(P[0].x, P[0].y, P[1].x, P[1].y);
        if (P.length >= 3) {
          const off = this.channelOffset(d);
          const ya = eng.mainScale.toY(d.points[0].p + off);
          const yb = eng.mainScale.toY(d.points[1].p + off);
          line(P[0].x, ya, P[1].x, yb);
          ctx.setLineDash([3, 3]);
          const yma = eng.mainScale.toY(d.points[0].p + off / 2);
          const ymb = eng.mainScale.toY(d.points[1].p + off / 2);
          ctx.globalAlpha = 0.6;
          line(P[0].x, yma, P[1].x, ymb);
          ctx.globalAlpha = 1;
          ctx.setLineDash([]);
          ctx.fillStyle = d.fill || withAlpha(d.color, 0.1);
          ctx.beginPath();
          ctx.moveTo(P[0].x, P[0].y);
          ctx.lineTo(P[1].x, P[1].y);
          ctx.lineTo(P[1].x, yb);
          ctx.lineTo(P[0].x, ya);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'rect': {
        if (P.length < 2) break;
        const x = Math.min(P[0].x, P[1].x);
        const y = Math.min(P[0].y, P[1].y);
        const w = Math.abs(P[1].x - P[0].x);
        const h = Math.abs(P[1].y - P[0].y);
        ctx.fillStyle = d.fill || withAlpha(d.color, 0.12);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        break;
      }
      case 'fib': {
        if (P.length < 2) break;
        const levels = d.levels || FIB_LEVELS;
        const x1 = Math.min(P[0].x, P[1].x);
        const x2 = d.extendRight ? W : Math.max(P[0].x, P[1].x);
        ctx.setLineDash([]);
        ctx.font = font;
        ctx.textBaseline = 'bottom';
        let prevY = NaN;
        levels.forEach((lv, k) => {
          const price = d.points[1].p + (d.points[0].p - d.points[1].p) * lv;
          const y = Math.round(eng.mainScale.toY(price)) + 0.5;
          const col = FIB_COLORS[k % FIB_COLORS.length];
          if (isFinite(prevY)) {
            ctx.fillStyle = withAlpha(col, 0.08);
            ctx.fillRect(x1, Math.min(y, prevY), x2 - x1, Math.abs(y - prevY));
          }
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          line(x1, y, x2, y);
          if (d.showLabels !== false) {
            ctx.fillStyle = col;
            ctx.fillText(`${lv} (${formatAxis(price, eng.priceDecimals)})`, x1 + 3, y - 1);
          }
          prevY = y;
        });
        ctx.strokeStyle = withAlpha(d.color, 0.7);
        ctx.setLineDash([4, 4]);
        line(P[0].x, P[0].y, P[1].x, P[1].y);
        break;
      }
      case 'fibext': {
        if (P.length < 2) break;
        line(P[0].x, P[0].y, P[1].x, P[1].y);
        if (P.length < 3) break;
        line(P[1].x, P[1].y, P[2].x, P[2].y);
        const levels = d.levels || FIB_EXT_LEVELS;
        const x1 = P[2].x;
        const x2 = Math.max(x1 + 120, Math.max(P[0].x, P[1].x, P[2].x) + 60);
        ctx.setLineDash([]);
        ctx.font = font;
        ctx.textBaseline = 'bottom';
        levels.forEach((lv, k) => {
          const price = d.points[2].p + (d.points[1].p - d.points[0].p) * lv;
          const y = Math.round(eng.mainScale.toY(price)) + 0.5;
          const col = FIB_COLORS[k % FIB_COLORS.length];
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          line(x1, y, d.extendRight ? W : x2, y);
          ctx.fillStyle = col;
          ctx.fillText(`${lv} (${formatAxis(price, eng.priceDecimals)})`, x1 + 3, y - 1);
        });
        break;
      }
      case 'fibtime': {
        if (P.length < 2) break;
        const i0 = eng.indexOfTime(d.points[0].t);
        const unit = eng.indexOfTime(d.points[1].t) - i0;
        ctx.setLineDash([]);
        ctx.font = font;
        ctx.textBaseline = 'top';
        (d.levels || FIB_TIME).forEach((n, k) => {
          const x = Math.round(eng.x(i0 + unit * n)) + 0.5;
          if (x < -10 || x > W + 10) return;
          const col = FIB_COLORS[k % FIB_COLORS.length];
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          line(x, 0, x, eng.plotH);
          ctx.fillStyle = col;
          ctx.fillText(String(n), x + 3, 4);
        });
        break;
      }
      case 'text': {
        ctx.setLineDash([]);
        ctx.font = `13px ${theme.font}`;
        const t = d.text || 'Text';
        const w = ctx.measureText(t).width + 12;
        ctx.fillStyle = withAlpha(d.color, 0.16);
        roundRect(ctx, P[0].x - 2, P[0].y - 20, w, 22, 4);
        ctx.fill();
        ctx.fillStyle = d.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(t, P[0].x + 4, P[0].y - 9);
        break;
      }
      case 'measure': {
        if (P.length < 2) break;
        const dp = d.points[1].p - d.points[0].p;
        const up = dp >= 0;
        const col = up ? theme.up : theme.down;
        const x = Math.min(P[0].x, P[1].x);
        const y = Math.min(P[0].y, P[1].y);
        const w = Math.abs(P[1].x - P[0].x);
        const h = Math.abs(P[1].y - P[0].y);
        ctx.setLineDash([]);
        ctx.fillStyle = withAlpha(col, 0.14);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        line(P[0].x, P[0].y, P[1].x, P[1].y);
        const bars = Math.round(eng.indexOfTime(d.points[1].t) - eng.indexOfTime(d.points[0].t));
        const pct = (dp / d.points[0].p) * 100;
        const txt = [`${up ? '+' : ''}${formatAxis(dp, eng.priceDecimals)} (${up ? '+' : ''}${pct.toFixed(2)}%)`, `${bars} bars, ${fmtDuration(Math.abs(d.points[1].t - d.points[0].t))}`];
        ctx.font = `600 ${theme.fontSize}px ${theme.font}`;
        const tw = Math.max(...txt.map((s) => ctx.measureText(s).width)) + 14;
        const bx = x + w / 2 - tw / 2;
        const by = up ? y - 40 : y + h + 4;
        ctx.fillStyle = col;
        roundRect(ctx, bx, by, tw, 36, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'top';
        ctx.fillText(txt[0], bx + 7, by + 4);
        ctx.font = `${theme.fontSize}px ${theme.font}`;
        ctx.fillText(txt[1], bx + 7, by + 19);
        break;
      }
    }
    ctx.setLineDash([]);
    if (selected || preview) {
      for (let i = 0; i < Math.min(P.length, need); i++) {
        ctx.fillStyle = theme.bg;
        ctx.strokeStyle = d.locked ? theme.text : theme.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(P[i].x, P[i].y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (selected && d.type === 'vline' && !preview) {
        const label = fmtDateTime(d.points[0].t);
        ctx.font = `600 ${theme.fontSize}px ${theme.font}`;
        const w = ctx.measureText(label).width + 12;
        ctx.fillStyle = d.color;
        roundRect(ctx, P[0].x - w / 2, eng.plotH + 2, w, 19, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, P[0].x - w / 2 + 6, eng.plotH + 12);
      }
    }
  }
}
