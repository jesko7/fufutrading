import { ReplayLiveNotice } from '../chart/replay';
import { serverNow } from '../../lib/clock';
import { useEffect, useRef, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useTopic, useSize } from '../../lib/hooks';
import type { HeatmapColumn, LargeOrderEvent, TradePrint } from '../../../shared/marketTypes';
import { priceDecimals, type Market, type SymbolId } from '../../../shared/symbols';
import { SymbolPicker, Segmented, Toggle, Popover, usePopover, NumberField } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtNum, fmtTime, fmtCompact, clsx } from '../../lib/format';
import { api } from '../../api';
import './market.css';

// colour ramp: deep blue -> cyan -> yellow -> white
const RAMP: [number, number, number][] = [
  [8, 12, 30],
  [20, 40, 110],
  [10, 120, 190],
  [40, 200, 200],
  [230, 220, 60],
  [255, 140, 30],
  [255, 255, 255],
];
function ramp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[Math.min(RAMP.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function HeatmapModule({ module }: ModuleProps) {
  const cfg = module.config as { symbol: SymbolId; market: Market; minutes: number; showTrades: boolean; contrast: number; zoomPct?: number };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const [ref, size] = useSize<HTMLDivElement>();
  const heatCv = useRef<HTMLCanvasElement>(null);
  const overCv = useRef<HTMLCanvasElement>(null);
  const cols = useRef<HeatmapColumn[]>([]);
  const trades = useRef<TradePrint[]>([]);
  const [events, setEvents] = useState<LargeOrderEvent[]>([]);
  const active = useRef<{ side: string; price: number; qty: number; notional: number; ageMs: number }[]>([]);
  const view = useRef<{ lo: number; hi: number }>({ lo: 0, hi: 0 });
  const hover = useRef<{ x: number; y: number } | null>(null);
  const minutes = cfg.minutes || 15;
  const zoomPct = cfg.zoomPct || 0.35;
  const contrast = cfg.contrast || 1;
  const settingsPop = usePopover();

  useEffect(() => {
    cols.current = [];
    trades.current = [];
    setEvents([]);
  }, [cfg.symbol, cfg.market]);

  useTopic<{ columns: HeatmapColumn[]; large: typeof active.current; events: LargeOrderEvent[] }>('heatmap', { symbol: cfg.symbol, market: cfg.market }, (d) => {
    cols.current.push(...d.columns);
    const cutoff = Date.now() - 125 * 60000;
    while (cols.current.length && cols.current[0].t < cutoff) cols.current.shift();
    active.current = d.large;
    setEvents(d.events.slice(-40).reverse());
    renderHeat();
  });

  useTopic<{ trades: TradePrint[] }>(cfg.showTrades === false ? null : 'trades', { symbol: cfg.symbol, market: cfg.market }, (d) => {
    trades.current.push(...d.trades);
    const cutoff = Date.now() - minutes * 60000;
    let k = 0;
    while (k < trades.current.length && trades.current[k].t < cutoff) k++;
    if (k) trades.current.splice(0, k);
  });

  // overlay animation loop (trades, lines, axes)
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      renderOverlay();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const AXIS = 66;
  const BOTTOM = 20;

  function computeView(): void {
    const last = cols.current[cols.current.length - 1];
    if (!last) return;
    const mid = (last.bestBid + last.bestAsk) / 2;
    const span = (mid * zoomPct) / 100;
    const v = view.current;
    // re-center when price approaches the edge (keeps the image stable most of the time)
    if (!v.hi || mid < v.lo + span * 0.25 || mid > v.hi - span * 0.25 || Math.abs(v.hi - v.lo - 2 * span) > span * 0.01) {
      v.lo = mid - span;
      v.hi = mid + span;
    }
  }

  function renderHeat(): void {
    const c = heatCv.current;
    if (!c || !size.width) return;
    computeView();
    const W = Math.max(1, size.width - AXIS);
    const H = Math.max(1, size.height - BOTTOM);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const data = img.data;
    const now = serverNow();
    const t0 = now - minutes * 60000;
    const all = cols.current;
    let start = 0;
    while (start < all.length && all[start].t < t0) start++;
    const vis = all.slice(start);
    if (!vis.length) {
      ctx.putImageData(img, 0, 0);
      return;
    }
    const { lo, hi } = view.current;
    // normaliser: high percentile of visible cells
    const sample: number[] = [];
    for (let k = 0; k < vis.length; k += Math.max(1, Math.floor(vis.length / 60))) {
      const col = vis[k];
      for (let i = 0; i < col.bids.length; i += 2) {
        const v = col.bids[i] + col.asks[i];
        if (v > 0) sample.push(v);
      }
    }
    sample.sort((a, b) => a - b);
    const norm = sample.length ? sample[Math.floor(sample.length * 0.985)] || 1 : 1;
    const gamma = 0.55 / contrast;
    let ci = 0;
    for (let x = 0; x < W; x++) {
      const t = t0 + (x / W) * (now - t0);
      while (ci + 1 < vis.length && vis[ci + 1].t <= t) ci++;
      const col = vis[ci];
      if (col.t > t + 2000) continue;
      for (let y = 0; y < H; y++) {
        const p = hi - (y / H) * (hi - lo);
        const bi = Math.floor((p - col.p0) / col.bin);
        if (bi < 0 || bi >= col.bids.length) continue;
        const v = col.bids[bi] + col.asks[bi];
        if (!(v > 0)) continue;
        const [r, g, b] = ramp(Math.pow(v / norm, gamma));
        const o = (y * W + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function renderOverlay(): void {
    const c = overCv.current;
    if (!c || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    const Wt = size.width;
    const Ht = size.height;
    if (c.width !== Wt * dpr) {
      c.width = Wt * dpr;
      c.height = Ht * dpr;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, Wt, Ht);
    const W = Wt - AXIS;
    const H = Ht - BOTTOM;
    const { lo, hi } = view.current;
    if (!(hi > lo)) return;
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue('--up').trim();
    const down = css.getPropertyValue('--down').trim();
    const txt = css.getPropertyValue('--chart-text').trim();
    const now = serverNow();
    const t0 = now - minutes * 60000;
    const X = (t: number) => ((t - t0) / (now - t0)) * W;
    const Y = (p: number) => ((hi - p) / (hi - lo)) * H;
    // best bid / ask lines
    const all = cols.current;
    for (const [key, color] of [
      ['bestBid', up],
      ['bestAsk', down],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const col of all) {
        if (col.t < t0) continue;
        const x = X(col.t);
        const y = Y(col[key]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // trades
    if (cfg.showTrades !== false) {
      for (const t of trades.current) {
        if (t.t < t0) continue;
        const n = t.p * t.q;
        if (n < 2000) continue;
        const r = Math.min(18, 1.5 + Math.sqrt(n / 4000));
        ctx.fillStyle = t.m ? `${down}99` : `${up}99`;
        ctx.beginPath();
        ctx.arc(X(t.t), Y(t.p), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // active large orders: markers on the right edge
    for (const a of active.current) {
      const y = Y(a.price);
      if (y < 0 || y > H) continue;
      ctx.fillStyle = a.side === 'bid' ? up : down;
      ctx.fillRect(W - 6, y - 1.5, 6, 3);
    }
    // price axis
    ctx.fillStyle = css.getPropertyValue('--chart-bg').trim();
    ctx.fillRect(W, 0, AXIS, Ht);
    ctx.fillRect(0, H, Wt, BOTTOM);
    ctx.fillStyle = txt;
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    const pd = priceDecimals(cfg.symbol, cfg.market);
    const steps = 8;
    for (let k = 0; k <= steps; k++) {
      const p = lo + ((hi - lo) * k) / steps;
      ctx.fillText(fmtNum(p, pd), W + 6, Y(p));
    }
    for (let k = 1; k < 5; k++) {
      const t = t0 + ((now - t0) * k) / 5;
      ctx.textAlign = 'center';
      ctx.fillText(fmtTime(t), X(t), H + 10);
      ctx.textAlign = 'left';
    }
    const last = all[all.length - 1];
    if (last) {
      const mid = (last.bestBid + last.bestAsk) / 2;
      ctx.fillStyle = css.getPropertyValue('--accent').trim();
      ctx.fillRect(W + 1, Y(mid) - 9, AXIS - 2, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(fmtNum(mid, pd), W + 6, Y(mid));
    }
    const h = hover.current;
    if (h && h.x < W && h.y < H) {
      const p = hi - (h.y / H) * (hi - lo);
      ctx.strokeStyle = txt;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, h.y);
      ctx.lineTo(W, h.y);
      ctx.moveTo(h.x, 0);
      ctx.lineTo(h.x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      const t = t0 + (h.x / W) * (now - t0);
      let col: HeatmapColumn | null = null;
      for (const cc of all) if (cc.t <= t) col = cc;
      let liq = 0;
      if (col) {
        const bi = Math.floor((p - col.p0) / col.bin);
        if (bi >= 0 && bi < col.bids.length) liq = col.bids[bi] + col.asks[bi];
      }
      const label = `${fmtNum(p, pd)} · ${fmtTime(t, true)} · resting ${fmtNum(liq, 3)}`;
      ctx.font = '600 11px system-ui';
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = css.getPropertyValue('--panel-3').trim();
      const lx = Math.min(W - w, h.x + 10);
      ctx.fillRect(lx, h.y - 26, w, 20);
      ctx.fillStyle = css.getPropertyValue('--text').trim();
      ctx.fillText(label, lx + 6, h.y - 16);
    }
  }

  useEffect(() => {
    renderHeat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height, minutes, zoomPct, contrast]);

  const kindLabel: Record<string, [string, string]> = {
    appeared: ['New', 'info'],
    pulled: ['Pulled', 'warn'],
    consumed: ['Filled', 'ok'],
    moved: ['Moved', 'accent'],
    'moved-from': ['Moved away', ''],
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <HeadControls>
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, m) => set({ symbol: s, market: m })} />
        <div className="spacer" />
        <Segmented size="sm" value={String(minutes)} onChange={(v) => set({ minutes: +v })} options={['5', '15', '30', '60', '120'].map((v) => ({ value: v, label: `${v}m` }))} />
        <button className="icon-btn" onClick={(e) => settingsPop.toggle(e.currentTarget)} data-tip="Heatmap settings">
          <Icon name="sliders" />
        </button>
        {settingsPop.anchor && (
          <Popover anchor={settingsPop.anchor} onClose={settingsPop.close} width={270} align="end">
            <div className="col" style={{ padding: 8 }}>
              <div className="field">
                <label>Price range (± % of mid)</label>
                <NumberField value={zoomPct} step={0.05} min={0.05} max={1.5} onChange={(v) => set({ zoomPct: v })} />
              </div>
              <div className="field">
                <label>Contrast</label>
                <input type="range" min={0.4} max={2.5} step={0.05} value={contrast} onChange={(e) => set({ contrast: +e.target.value })} />
              </div>
              <div className="row">
                <span className="grow">Show trades</span>
                <Toggle value={cfg.showTrades !== false} onChange={(v) => set({ showTrades: v })} />
              </div>
              <div className="field">
                <label>Large order threshold (USD)</label>
                <NumberField value={null} placeholder="default" step={100000} onChange={(v) => api.call('book:options', cfg.symbol, cfg.market, { largeThresholdUsd: v })} />
              </div>
              <div className="hint">Sampled once per second from the live Binance order book (heatmap starts when this module opens). Bright = more resting liquidity. Resting orders show intent, not execution — they can be pulled.</div>
            </div>
          </Popover>
        )}
      </HeadControls>
      <ReplayLiveNotice what="order books aren't recorded historically" />
      <div
        className="canvas-fill"
        ref={ref}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          hover.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        }}
        onMouseLeave={() => (hover.current = null)}
        onWheel={(e) => set({ zoomPct: Math.max(0.05, Math.min(1.5, zoomPct * Math.exp(e.deltaY / 600))) })}
      >
        <canvas ref={heatCv} style={{ position: 'absolute', left: 0, top: 0, width: Math.max(1, size.width - AXIS), height: Math.max(1, size.height - BOTTOM), imageRendering: 'pixelated' }} />
        <canvas ref={overCv} style={{ position: 'absolute', inset: 0, width: size.width, height: size.height }} />
        {!cols.current.length && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            <span className="spinner" />
            Collecting order-book snapshots…
          </div>
        )}
        {cols.current.length > 0 && Date.now() - cols.current[0].t < minutes * 60000 * 0.6 && (
          <div className="heat-history-note">
            Order-book history since {fmtTime(cols.current[0].t)}. It fills as live snapshots arrive; Binance provides no past order books.
          </div>
        )}
      </div>
      <div className="large-list">
        <div className="row" style={{ padding: '5px 10px', position: 'sticky', top: 0, background: 'var(--panel)' }}>
          <span className="section-title">Large resting orders</span>
          <div className="spacer" />
          <span className="faint">{active.current.length} active</span>
        </div>
        {events.length === 0 && <div className="faint" style={{ padding: '4px 10px 8px' }}>No large-order activity yet.</div>}
        {events.map((e, k) => (
          <div key={k} className="row" style={{ padding: '2px 10px', fontSize: 11.5 }}>
            <span className="faint num" style={{ width: 58 }}>
              {fmtTime(e.t, true)}
            </span>
            <span className={clsx('badge', kindLabel[e.kind]?.[1])} style={{ width: 70, justifyContent: 'center' }}>
              {kindLabel[e.kind]?.[0] || e.kind}
            </span>
            <span className={e.side === 'bid' ? 'up' : 'down'} style={{ width: 28 }}>
              {e.side === 'bid' ? 'Bid' : 'Ask'}
            </span>
            <span className="num">{fmtNum(e.price, priceDecimals(cfg.symbol, cfg.market))}</span>
            <span className="num faint">${fmtCompact(e.notional)}</span>
            {e.ageMs > 0 && <span className="faint">lived {Math.round(e.ageMs / 1000)}s</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
