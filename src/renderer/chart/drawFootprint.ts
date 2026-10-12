import type { RenderCtx } from './engine';
import type { FootprintBar, FootprintOptions } from './types';
import { withAlpha } from './drawSeries';
import { formatVolume } from './scale';

/** Regroup a footprint bar to a coarser price step. */
export function regroup(f: FootprintBar, step: number): FootprintBar {
  if (step <= f.step * 1.0001) return f;
  const map = new Map<number, [number, number]>();
  for (let k = 0; k < f.prices.length; k++) {
    const p = Math.floor(f.prices[k] / step + 1e-9) * step;
    const e = map.get(p) || [0, 0];
    e[0] += f.buy[k];
    e[1] += f.sell[k];
    map.set(p, e);
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  return { t: f.t, step, prices: Float64Array.from(keys), buy: Float64Array.from(keys.map((k) => map.get(k)![0])), sell: Float64Array.from(keys.map((k) => map.get(k)![1])) };
}

export function drawFootprint(rc: RenderCtx, bars: Map<number, FootprintBar>, opts: FootprintOptions, tick: number): void {
  const { ctx, bars: b, i0, i1, pane, theme } = rc;
  const s = pane.scale;
  const lo = Math.max(0, i0);
  const hi = Math.min(b.length - 1, i1);
  const width = Math.max(2, rc.barSpacing * 0.86);
  // choose a row step so rows are readable
  const pxPerPrice = Math.abs(s.toY(1000) - s.toY(1001));
  const minRowPx = rc.barSpacing >= 70 ? 13 : 3;
  let step = Math.max(opts.group || tick, tick);
  while (step * pxPerPrice < minRowPx && step < 1e9) step *= 2;
  const numeric = rc.barSpacing >= 70 && step * pxPerPrice >= 12;
  ctx.textBaseline = 'middle';
  for (let i = lo; i <= hi; i++) {
    const raw = bars.get(b.t[i]);
    const x = rc.x(i);
    if (!raw) {
      // no trade data: plain candle, dimmed
      ctx.globalAlpha = 0.45;
      const up = b.c[i] >= b.o[i];
      ctx.fillStyle = up ? theme.up : theme.down;
      ctx.fillRect(Math.round(x) - 0.5, s.toY(b.h[i]), 1, Math.max(1, s.toY(b.l[i]) - s.toY(b.h[i])));
      ctx.fillRect(x - rc.bodyW / 2, Math.min(s.toY(b.o[i]), s.toY(b.c[i])), rc.bodyW, Math.max(1, Math.abs(s.toY(b.o[i]) - s.toY(b.c[i]))));
      ctx.globalAlpha = 1;
      continue;
    }
    const f = regroup(raw, step);
    const n = f.prices.length;
    let max = 0;
    let poc = 0;
    let delta = 0;
    for (let k = 0; k < n; k++) {
      const v = f.buy[k] + f.sell[k];
      delta += f.buy[k] - f.sell[k];
      if (v > max) {
        max = v;
        poc = k;
      }
    }
    const left = x - width / 2;
    // thin candle on the left edge for context
    const up = b.c[i] >= b.o[i];
    ctx.fillStyle = up ? theme.up : theme.down;
    ctx.fillRect(left, Math.min(s.toY(b.o[i]), s.toY(b.c[i])), 2, Math.max(1, Math.abs(s.toY(b.o[i]) - s.toY(b.c[i]))));
    let stackBuy = 0;
    let stackSell = 0;
    for (let k = 0; k < n; k++) {
      const p0 = f.prices[k];
      const y0 = s.toY(p0 + step);
      const y1 = s.toY(p0);
      const h = Math.max(1, y1 - y0 - (numeric ? 1 : 0));
      const bv = f.buy[k];
      const sv = f.sell[k];
      const tot = bv + sv;
      // diagonal imbalance: buy at level k vs sell at level k-1; sell at k vs buy at k+1
      const buyImb = k > 0 && f.sell[k - 1] > 0 ? bv / f.sell[k - 1] >= opts.imbalanceRatio : bv > 0 && k > 0 && f.sell[k - 1] === 0 && bv > max * 0.05;
      const sellImb = k < n - 1 && f.buy[k + 1] > 0 ? sv / f.buy[k + 1] >= opts.imbalanceRatio : sv > 0 && k < n - 1 && f.buy[k + 1] === 0 && sv > max * 0.05;
      stackBuy = buyImb ? stackBuy + 1 : 0;
      stackSell = sellImb ? stackSell + 1 : 0;
      if (stackBuy >= 3) {
        ctx.fillStyle = theme.up;
        ctx.fillRect(left + width + 1, y0, 3, h);
      }
      if (stackSell >= 3) {
        ctx.fillStyle = theme.down;
        ctx.fillRect(left - 4, y0, 3, h);
      }
      if (opts.mode === 'delta' || !numeric) {
        const d = bv - sv;
        const a = Math.min(0.85, 0.12 + (tot / (max || 1)) * 0.7);
        ctx.fillStyle = withAlpha(d >= 0 ? theme.up : theme.down, a);
        ctx.fillRect(left + 3, y0, width - 3, h);
      } else {
        const a = 0.08 + (tot / (max || 1)) * 0.35;
        ctx.fillStyle = withAlpha(theme.down, a * (sv / (tot || 1)) + 0.04);
        ctx.fillRect(left + 3, y0, (width - 3) / 2, h);
        ctx.fillStyle = withAlpha(theme.up, a * (bv / (tot || 1)) + 0.04);
        ctx.fillRect(left + 3 + (width - 3) / 2, y0, (width - 3) / 2, h);
      }
      if (k === poc) {
        ctx.strokeStyle = '#f5c542';
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 3.5, y0 + 0.5, width - 4, h - 1);
      }
      if (numeric) {
        ctx.font = `${Math.min(11, Math.max(8, h - 3))}px ${theme.font}`;
        const cy = y0 + h / 2;
        if (opts.mode === 'volume') {
          ctx.fillStyle = theme.textStrong;
          ctx.textAlign = 'center';
          ctx.fillText(formatVolume(tot), left + width / 2, cy);
        } else if (opts.mode === 'delta') {
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(formatVolume(bv - sv), left + width / 2, cy);
        } else {
          ctx.textAlign = 'right';
          ctx.fillStyle = sellImb ? theme.down : theme.textStrong;
          ctx.font = `${sellImb ? '700 ' : ''}${Math.min(11, Math.max(8, h - 3))}px ${theme.font}`;
          ctx.fillText(formatVolume(sv), left + width / 2 - 3, cy);
          ctx.textAlign = 'left';
          ctx.fillStyle = buyImb ? theme.up : theme.textStrong;
          ctx.font = `${buyImb ? '700 ' : ''}${Math.min(11, Math.max(8, h - 3))}px ${theme.font}`;
          ctx.fillText(formatVolume(bv), left + width / 2 + 3, cy);
        }
        ctx.textAlign = 'left';
      }
    }
    // delta under the bar
    if (rc.barSpacing >= 34) {
      ctx.font = `600 ${theme.fontSize - 1}px ${theme.font}`;
      ctx.fillStyle = delta >= 0 ? theme.up : theme.down;
      ctx.textAlign = 'center';
      ctx.fillText(`${delta >= 0 ? '+' : ''}${formatVolume(delta)}`, x, s.toY(b.l[i]) + 12);
      ctx.textAlign = 'left';
    }
  }
}
