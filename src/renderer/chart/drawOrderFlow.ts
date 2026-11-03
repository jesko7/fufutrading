/**
 * Order-flow tools on the main pane: HVN bands, imbalance levels and the DOM are drawn behind
 * the candles, absorption bubbles above them. Hit tests feed the chart's hover tooltip.
 */
import type { RenderCtx } from './engine';
import type { OrderFlowView } from './types';
import type { AbsorptionEvent } from '../../shared/orderflow';
import { fmtFlowQty } from '../../shared/orderflow';
import { withAlpha } from './drawSeries';

interface Geo {
  x: (i: number) => number;
  indexOfTime: (t: number) => number;
  lastIndex: number;
  lastPrice: number;
}

function isDark(bg: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(bg);
  if (!m) return true;
  return parseInt(m[1], 16) * 0.299 + parseInt(m[2], 16) * 0.587 + parseInt(m[3], 16) * 0.114 < 128;
}

/** Index of the bar that contains time t. */
function barAt(g: Geo, t: number): number {
  return Math.floor(g.indexOfTime(t) + 1e-9);
}

/** Right end of a level: the bar where it ended, or just past the latest bar. */
function endX(rc: RenderCtx, g: Geo, end: number | null): number {
  const half = rc.barSpacing / 2;
  if (end === null) return g.x(g.lastIndex) + half + 3;
  return g.x(Math.min(g.lastIndex, barAt(g, end))) + half;
}

function ratioText(r: number): string {
  return !Number.isFinite(r) || r >= 100 ? '99+x' : `${Math.floor(r)}x`;
}

/** "volume | rest" label right-aligned at x, the rest in its own colour. */
function pairLabel(rc: RenderCtx, x: number, y: number, a: string, b: string, bColor: string, dark: boolean): void {
  const { ctx, theme } = rc;
  ctx.font = `600 ${theme.fontSize}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const sep = ' | ';
  const wa = ctx.measureText(a).width;
  const ws = ctx.measureText(sep).width;
  const wb = ctx.measureText(b).width;
  let x0 = x - wa - ws - wb;
  ctx.fillStyle = dark ? '#f2f2f2' : theme.textStrong;
  ctx.fillText(a, x0, y);
  x0 += wa;
  ctx.fillStyle = withAlpha(dark ? '#ffffff' : '#000000', 0.4);
  ctx.fillText(sep, x0, y);
  x0 += ws;
  ctx.fillStyle = bColor;
  ctx.fillText(b, x0, y);
}

export function drawOrderFlowBack(rc: RenderCtx, of: OrderFlowView, g: Geo): void {
  const { ctx, theme, pane, plotW } = rc;
  const s = pane.scale;
  const dark = isDark(theme.bg);
  const top = pane.top;
  const bottom = pane.top + pane.height;
  if (of.dom?.book) drawDom(rc, of, g);
  if (of.hvn) {
    const col = of.hvn.color;
    for (const L of of.hvn.levels) {
      const yHi = s.toY(L.hi);
      const yLo = s.toY(L.lo);
      if (!(yLo >= top - 2 && yHi <= bottom + 2)) continue;
      const x0 = Math.max(0, g.x(Math.max(0, barAt(g, L.from))) - rc.barSpacing / 2);
      const x1 = Math.min(plotW, endX(rc, g, L.developing ? null : L.to));
      if (x1 <= 0 || x0 >= plotW || x1 - x0 < 1) continue;
      const active = g.lastPrice >= L.lo && g.lastPrice < L.hi && (L.to === null || L.developing);
      const h = Math.max(2, yLo - yHi);
      const y = (yLo + yHi) / 2 - h / 2;
      ctx.fillStyle = withAlpha(col, active ? (dark ? 0.52 : 0.45) : dark ? 0.27 : 0.22);
      ctx.fillRect(x0, y, x1 - x0, h);
    }
  }
  if (of.imb) {
    for (const z of of.imb.levels) {
      const yHi = s.toY(z.hi);
      const yLo = s.toY(z.lo);
      if (!(yLo >= top - 2 && yHi <= bottom + 2)) continue;
      const col = z.side > 0 ? of.imb.buy : of.imb.sell;
      const bi = barAt(g, z.t);
      const xb = g.x(bi);
      const half = rc.barSpacing / 2;
      if (xb + half < 0) {
        if (z.end !== null) continue;
      }
      const h = Math.max(2, yLo - yHi);
      const y = (yLo + yHi) / 2 - h / 2;
      // the imbalanced rows on their own bar
      ctx.fillStyle = withAlpha(col, z.live ? 0.35 : 0.6);
      ctx.fillRect(xb - Math.max(1, half * 0.86), y, Math.max(2, rc.barSpacing * 0.86), h);
      // and the level until price comes back
      const x0 = Math.max(0, xb + half);
      const x1 = Math.min(plotW, z.live ? xb + half : endX(rc, g, z.end));
      if (x1 - x0 >= 1) {
        ctx.fillStyle = withAlpha(col, dark ? 0.24 : 0.2);
        ctx.fillRect(x0, y, x1 - x0, h);
      }
    }
  }
}

/** The labels of HVN bands and imbalance levels, in front of the candles. */
function drawLabels(rc: RenderCtx, of: OrderFlowView, g: Geo): void {
  const { theme, pane, plotW } = rc;
  const s = pane.scale;
  const dark = isDark(theme.bg);
  const top = pane.top;
  const bottom = pane.top + pane.height;
  if (of.hvn?.labels) {
    for (const L of of.hvn.levels) {
      const yHi = s.toY(L.hi);
      const yLo = s.toY(L.lo);
      if (!(yLo >= top - 2 && yHi <= bottom + 2)) continue;
      const x0 = Math.max(0, g.x(Math.max(0, barAt(g, L.from))) - rc.barSpacing / 2);
      const x1 = Math.min(plotW, endX(rc, g, L.developing ? null : L.to));
      if (x1 - x0 <= 60 || x1 <= 0) continue;
      const pct = L.vol > 0 ? Math.round((L.buy / L.vol) * 100) : 50;
      pairLabel(rc, x1 - 6, (yLo + yHi) / 2 + 0.5, fmtFlowQty(L.vol), `${pct}%`, pct >= 50 ? theme.up : theme.down, dark);
    }
  }
  if (of.imb) {
    for (const z of of.imb.levels) {
      if (z.live) continue;
      const yHi = s.toY(z.hi);
      const yLo = s.toY(z.lo);
      if (!(yLo >= top - 2 && yHi <= bottom + 2)) continue;
      const xb = g.x(barAt(g, z.t));
      const half = rc.barSpacing / 2;
      const x1 = Math.min(plotW, endX(rc, g, z.end));
      if (x1 <= 30 || (xb + half < 0 && z.end !== null)) continue;
      pairLabel(rc, Math.max(x1, xb + half + 70) - 4, (yLo + yHi) / 2 + 0.5, ratioText(z.ratio), fmtFlowQty(z.vol), dark ? '#f2f2f2' : theme.textStrong, dark);
    }
  }
}

/** Bubble size grows with the absorbed volume against the threshold: 14 px at it, 34 px at 10×. */
export function bubbleRadius(e: AbsorptionEvent, thr: number): number {
  const base = Number.isFinite(thr) && thr > 0 ? thr : e.vol;
  return Math.max(14, Math.min(34, 14 + 6 * Math.log2(Math.max(1, e.vol / base))));
}

export function drawOrderFlowFront(rc: RenderCtx, of: OrderFlowView, g: Geo): void {
  drawLabels(rc, of, g);
  if (!of.abs || !of.abs.events.length) return;
  const { ctx, theme, pane, plotW } = rc;
  const s = pane.scale;
  const dark = isDark(theme.bg);
  const thr = of.abs.thr;
  // older first, so the newest bubble is on top
  const list = [...of.abs.events].sort((a, b) => a.t - b.t);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const e of list) {
    const r = bubbleRadius(e, thr);
    const x = g.x(barAt(g, e.t));
    const y = s.toY(e.price);
    if (x < -r || x > plotW + r || y < pane.top - r || y > pane.top + pane.height + r) continue;
    const col = e.side > 0 ? of.abs.buy : of.abs.sell;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(col, dark ? 0.36 : 0.3);
    ctx.fill();
    ctx.lineWidth = e.state === 'live' ? 2 : 1.25;
    ctx.strokeStyle = withAlpha(col, e.state === 'live' ? 1 : 0.75);
    ctx.stroke();
    // more traded at the level than the book showed: refilled / hidden orders
    if (e.shown !== null && e.vol > e.shown) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = withAlpha(col, 0.8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (of.abs.numbers) {
      ctx.font = `600 ${Math.max(11, Math.min(14, Math.round(r * 0.5)))}px ${theme.font}`;
      ctx.fillStyle = dark ? '#ffffff' : theme.textStrong;
      ctx.fillText(fmtFlowQty(e.vol), x, y + 0.5);
    }
  }
  ctx.textAlign = 'left';
}

/** Rows of the DOM regrouped to `g` (bids floor, asks ceil), as [price key, qty]. */
function regroup(p: Float64Array, q: Float64Array, step: number, g: number, side: 'bid' | 'ask'): [number, number][] {
  if (g <= step * 1.0001) return Array.from(p, (x, i) => [x, q[i]] as [number, number]);
  const out: [number, number][] = [];
  let key = NaN;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    const k = side === 'bid' ? Math.floor(p[i] / g + 1e-9) : Math.ceil(p[i] / g - 1e-9);
    if (k !== key) {
      if (key === key) out.push([key * g, acc]);
      key = k;
      acc = 0;
    }
    acc += q[i];
  }
  if (key === key) out.push([key * g, acc]);
  return out;
}

/** The DOM row step for the current zoom: rows at least 2 px tall. */
export function domRowStep(pxPerPrice: number, step: number): number {
  if (!(pxPerPrice > 0) || !(step > 0)) return step;
  return step * Math.max(1, Math.ceil(2 / (pxPerPrice * step) - 1e-9));
}

function drawDom(rc: RenderCtx, of: OrderFlowView, g0: Geo): void {
  void g0;
  const d = of.dom!;
  const b = d.book!;
  if (!b.bp.length && !b.ap.length) return;
  const { ctx, pane, plotW } = rc;
  const s = pane.scale;
  const ppp = Math.abs(s.toY(1000) - s.toY(1001));
  const g = domRowStep(ppp, b.step);
  const bids = regroup(b.bp, b.bq, b.step, g, 'bid');
  const asks = regroup(b.ap, b.aq, b.step, g, 'ask');
  const top = pane.top;
  const bottom = pane.top + pane.height;
  const W = Math.max(20, (plotW * d.width) / 100);
  // bids cover [key, key + g), asks (key - g, key]
  const vis = (lo: number, hi: number) => s.toY(lo) >= top && s.toY(hi) <= bottom;
  let ref = 0;
  for (const [p, q] of bids) if (vis(p, p + g) && q > ref) ref = q;
  for (const [p, q] of asks) if (vis(p - g, p) && q > ref) ref = q;
  if (!(ref > 0)) return;
  const len = (q: number) => W * (d.sqrt ? Math.sqrt(q / ref) : q / ref);
  const rowPx = g * ppp;
  const gap = rowPx >= 4 ? 1 : 0;
  // the row that holds both the best bid and the best ask is split between them
  const split = bids.length && asks.length && asks[0][0] - g < bids[0][0] + g - 1e-9 ? s.toY(bids[0][0] + g / 2) : NaN;
  const row = (lo: number, hi: number, q: number, color: string, part: 'lo' | 'hi' | null) => {
    let y0 = s.toY(hi);
    let y1 = s.toY(lo);
    if (y1 < top || y0 > bottom) return;
    if (part === 'lo') y0 = split;
    else if (part === 'hi') y1 = split;
    const h = Math.max(1, y1 - y0 - gap);
    const w = Math.max(1, len(q));
    ctx.fillStyle = color;
    ctx.fillRect(plotW - w, y0, w, h);
  };
  for (let i = 0; i < asks.length; i++) {
    const [p, q] = asks[i];
    if (s.toY(p - g) < top) break;
    row(p - g, p, q, d.ask, i === 0 && split === split ? 'hi' : null);
  }
  for (let i = 0; i < bids.length; i++) {
    const [p, q] = bids[i];
    if (s.toY(p + g) > bottom) break;
    row(p, p + g, q, d.bid, i === 0 && split === split ? 'lo' : null);
  }
}

// ------------------------------------------------------------------ hover

export interface FlowHit {
  kind: 'absorption' | 'hvn' | 'imbalance' | 'dom';
  title: string;
  lines: string[];
  color: string;
}

export function hitOrderFlow(rc: RenderCtx, of: OrderFlowView, g: Geo, mx: number, my: number, fmtPrice: (p: number) => string, fmtTime: (t: number) => string): FlowHit | null {
  const { pane, plotW, theme } = rc;
  const s = pane.scale;
  const unit = of.unit;
  const q = (v: number) => `${fmtFlowQty(v)} ${unit}`;
  if (of.abs) {
    let best: AbsorptionEvent | null = null;
    let bd = Infinity;
    for (const e of of.abs.events) {
      const r = bubbleRadius(e, of.abs.thr);
      const dx = g.x(barAt(g, e.t)) - mx;
      const dy = s.toY(e.price) - my;
      const dd = Math.hypot(dx, dy);
      if (dd <= r + 2 && dd < bd) {
        bd = dd;
        best = e;
      }
    }
    if (best) {
      const e = best;
      const secs = Math.max(0, Math.round((e.t1 - e.t0) / 1000));
      const lines = [`${q(e.vol)} in ${e.trades} trade${e.trades === 1 ? '' : 's'} at ${fmtPrice(e.lo)} – ${fmtPrice(e.hi)}`, `${fmtTime(e.t0)}${secs ? `, over ${secs} s` : ''}${e.state === 'live' ? ' · live: the level is holding so far' : ' · the level held'}`];
      if (e.shown !== null) {
        const ratio = e.shown > 0 ? e.vol / e.shown : Infinity;
        lines.push(`Order book showed ${q(e.shown)} at the first hit${e.maxShown !== null && e.maxShown > e.shown ? `, up to ${q(e.maxShown)}` : ''}${ratio > 1 ? ` · ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'all of it'} refilled or hidden` : ''}`);
      } else lines.push('Order book: not seen live (from trade history)');
      return { kind: 'absorption', title: e.side > 0 ? 'Buying absorbed by resting sell orders' : 'Selling absorbed by resting buy orders', lines, color: e.side > 0 ? of.abs.buy : of.abs.sell };
    }
  }
  if (of.dom?.book && mx >= plotW - (plotW * of.dom.width) / 100) {
    const b = of.dom.book;
    const ppp = Math.abs(s.toY(1000) - s.toY(1001));
    const gs = domRowStep(ppp, b.step);
    const price = s.fromY(my);
    const sideBid = price < (b.bestBid + b.bestAsk) / 2;
    const rows = sideBid ? regroup(b.bp, b.bq, b.step, gs, 'bid') : regroup(b.ap, b.aq, b.step, gs, 'ask');
    const hit = rows.find(([p]) => (sideBid ? price >= p && price < p + gs : price > p - gs && price <= p));
    if (hit) {
      const lo = sideBid ? hit[0] : hit[0] - gs;
      return { kind: 'dom', title: sideBid ? 'Bids' : 'Asks', lines: [`${q(hit[1])} resting at ${fmtPrice(lo)} – ${fmtPrice(lo + gs)}`, `Best bid ${fmtPrice(b.bestBid)} · best ask ${fmtPrice(b.bestAsk)}`], color: sideBid ? of.dom.bid : of.dom.ask };
    }
  }
  const price = s.fromY(my);
  if (of.imb) {
    for (const z of [...of.imb.levels].reverse()) {
      if (price < z.lo || price >= z.hi) continue;
      const xb = g.x(barAt(g, z.t)) - rc.barSpacing / 2;
      const x1 = z.live ? xb + rc.barSpacing : endX(rc, g, z.end);
      if (mx < xb || mx > Math.max(x1, xb + 70)) continue;
      return {
        kind: 'imbalance',
        title: z.side > 0 ? 'Buy imbalance (stacked)' : 'Sell imbalance (stacked)',
        lines: [`${z.rows} rows ${fmtPrice(z.lo)} – ${fmtPrice(z.hi)} in the bar of ${fmtTime(z.t)}`, `${q(z.vol)} ${z.side > 0 ? 'bought' : 'sold'} aggressively against ${q(z.opp)} ${z.side > 0 ? 'sold one row lower' : 'bought one row higher'} · ${ratioText(z.ratio)}`, z.live ? 'Bar still forming' : z.end !== null ? `Price came back at ${fmtTime(z.end)}` : 'Price has not come back yet'],
        color: z.side > 0 ? of.imb.buy : of.imb.sell,
      };
    }
  }
  if (of.hvn) {
    for (const L of of.hvn.levels) {
      if (price < L.lo || price >= L.hi) continue;
      const x0 = g.x(Math.max(0, barAt(g, L.from))) - rc.barSpacing / 2;
      const x1 = endX(rc, g, L.developing ? null : L.to);
      if (mx < x0 || mx > x1) continue;
      const pct = L.vol > 0 ? Math.round((L.buy / L.vol) * 100) : 50;
      return {
        kind: 'hvn',
        title: L.developing ? 'High-volume node (forming period)' : 'High-volume node',
        lines: [`${q(L.vol)} traded at ${fmtPrice(L.lo)} – ${fmtPrice(L.hi)} · ${pct}% aggressive buying`, `Profile from ${fmtTime(L.from)}${L.to !== null && !L.developing ? ` · price came back at ${fmtTime(L.to)}` : ''}`],
        color: of.hvn.color,
      };
    }
  }
  void theme;
  return null;
}
