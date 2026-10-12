import { useEffect, useRef, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useTopic, useSize } from '../../lib/hooks';
import type { BookSnapshot } from '../../../shared/marketTypes';
import { priceDecimals, SYMBOL_SPECS, type Market, type SymbolId } from '../../../shared/symbols';
import { SymbolPicker, Segmented } from '../../components/ui';
import { fmtNum, fmtCompact } from '../../lib/format';
import './market.css';

export function DepthModule({ module }: ModuleProps) {
  const cfg = module.config as { symbol: SymbolId; market: Market; rangePct: number; unit?: 'base' | 'quote' };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<BookSnapshot | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const [, setTick] = useState(0);
  const range = cfg.rangePct || 1;
  const unit = cfg.unit || 'quote';

  useTopic<BookSnapshot>('book', { symbol: cfg.symbol, market: cfg.market, group: 0, levels: 500, intervalMs: 250 }, (s) => {
    snapRef.current = s;
    draw();
  });

  const draw = () => {
    const c = canvas.current;
    const s = snapRef.current;
    if (!c || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.width;
    const H = size.height;
    if (c.width !== W * dpr) {
      c.width = W * dpr;
      c.height = H * dpr;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!s || !s.metrics) return;
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue('--up').trim();
    const down = css.getPropertyValue('--down').trim();
    const text = css.getPropertyValue('--text-3').trim();
    const mid = s.metrics.mid;
    const lo = mid * (1 - range / 100);
    const hi = mid * (1 + range / 100);
    const val = (p: number, q: number) => (unit === 'quote' ? p * q : q);
    const bids: [number, number][] = [];
    let cum = 0;
    for (const [p, q] of s.bids) {
      if (p < lo) break;
      cum += val(p, q);
      bids.push([p, cum]);
    }
    const asks: [number, number][] = [];
    cum = 0;
    for (const [p, q] of s.asks) {
      if (p > hi) break;
      cum += val(p, q);
      asks.push([p, cum]);
    }
    const maxY = Math.max(bids[bids.length - 1]?.[1] || 0, asks[asks.length - 1]?.[1] || 0) * 1.08 || 1;
    const padB = 20;
    const x = (p: number) => ((p - lo) / (hi - lo)) * W;
    const y = (v: number) => H - padB - (v / maxY) * (H - padB - 10);
    const area = (pts: [number, number][], color: string, toLeft: boolean) => {
      if (!pts.length) return;
      ctx.beginPath();
      ctx.moveTo(x(pts[0][0]), H - padB);
      for (let i = 0; i < pts.length; i++) {
        ctx.lineTo(x(pts[i][0]), y(pts[i][1]));
        if (i + 1 < pts.length) ctx.lineTo(x(pts[i + 1][0]), y(pts[i][1]));
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(toLeft ? 0 : W, y(last[1]));
      ctx.lineTo(toLeft ? 0 : W, H - padB);
      ctx.closePath();
      ctx.fillStyle = color + '33';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    area(bids, up, true);
    area(asks, down, false);
    // mid line + labels
    ctx.strokeStyle = text;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(mid), 0);
    ctx.lineTo(x(mid), H - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = text;
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    const pd = priceDecimals(cfg.symbol, cfg.market);
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const p = mid * (1 + (f * range) / 100);
      const tx = x(p);
      ctx.textAlign = f === -1 ? 'left' : f === 1 ? 'right' : 'center';
      ctx.fillText(`${fmtNum(p, f === 0 ? pd : 0)}`, tx, H - 9);
    }
    ctx.textAlign = 'left';
    const h = hover.current;
    if (h) {
      const p = lo + (h.x / W) * (hi - lo);
      const side = p < mid ? bids : asks;
      let v = 0;
      for (const [pp, cc] of side) if ((p < mid && pp >= p) || (p >= mid && pp <= p)) v = cc;
      ctx.strokeStyle = text;
      ctx.beginPath();
      ctx.moveTo(h.x, 0);
      ctx.lineTo(h.x, H - padB);
      ctx.stroke();
      const label = `${fmtNum(p, pd)} · ${unit === 'quote' ? '$' : ''}${fmtCompact(v)}${unit === 'base' ? ` ${SYMBOL_SPECS[cfg.symbol].base}` : ''} · ${(((p - mid) / mid) * 100).toFixed(2)}%`;
      ctx.font = '600 11px system-ui';
      const w = ctx.measureText(label).width + 12;
      const lx = Math.min(W - w - 4, Math.max(4, h.x - w / 2));
      ctx.fillStyle = css.getPropertyValue('--panel-3').trim();
      ctx.fillRect(lx, 8, w, 20);
      ctx.fillStyle = css.getPropertyValue('--text').trim();
      ctx.fillText(label, lx + 6, 18);
    }
  };

  useEffect(() => {
    draw();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height, range, unit]);

  return (
    <>
      <HeadControls>
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, m) => set({ symbol: s, market: m })} />
        <div className="spacer" />
        <Segmented size="sm" value={unit} onChange={(v) => set({ unit: v })} options={[{ value: 'quote', label: 'USDT' }, { value: 'base', label: SYMBOL_SPECS[cfg.symbol].base }]} />
        <Segmented size="sm" value={String(range)} onChange={(v) => set({ rangePct: +v })} options={['0.25', '0.5', '1', '2', '5'].map((v) => ({ value: v, label: `±${v}%` }))} />
      </HeadControls>
      <div
        className="canvas-fill"
        ref={ref}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          hover.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          draw();
        }}
        onMouseLeave={() => {
          hover.current = null;
          draw();
        }}
      >
        <canvas ref={canvas} style={{ width: size.width, height: size.height }} />
      </div>
    </>
  );
}
