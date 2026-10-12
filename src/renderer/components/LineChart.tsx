/**
 * Lightweight canvas line/area chart for analytics (equity curves, drawdowns, comparisons):
 * HiDPI, responsive, hover crosshair with a value tooltip, time axis, optional zero line.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtDateShort, fmtDateTime } from '../lib/format';

export interface LineSeries {
  values: ArrayLike<number>;
  color: string;
  label: string;
  area?: boolean;
  dashed?: boolean;
  width?: number;
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

export function LineChart({ t, series, height = 220, format = (v) => v.toFixed(2), zeroLine, minY, maxY, onPick }: { t: ArrayLike<number>; series: LineSeries[]; height?: number; format?: (v: number) => string; zeroLine?: boolean; minY?: number; maxY?: number; onPick?: (time: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = t.length;
  const padL = 8;
  const padR = 64;
  const padT = 8;
  const padB = 20;
  // y range
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (zeroLine) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (minY !== undefined) lo = Math.min(lo, minY);
  if (maxY !== undefined) hi = Math.max(hi, maxY);
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) {
    hi += Math.abs(hi) * 0.01 || 1;
    lo -= Math.abs(lo) * 0.01 || 1;
  }
  const span = hi - lo;
  lo -= span * 0.06;
  hi += span * 0.06;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = Math.max(10, height - padT - padB);
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(w * dpr);
    c.height = Math.floor(height * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${height}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const grid = css('--chart-grid', 'rgba(128,128,128,0.15)');
    const text = css('--chart-text', '#888');
    const font = `11px ${css('--font', 'sans-serif')}`;
    ctx.font = font;
    // horizontal grid + labels
    const step = niceStep(hi - lo, Math.max(2, Math.floor(plotH / 40)));
    ctx.fillStyle = text;
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + plotW, yy);
      ctx.stroke();
      ctx.fillText(format(v), padL + plotW + 6, yy);
    }
    if (zeroLine) {
      const yy = Math.round(y(0)) + 0.5;
      ctx.strokeStyle = text;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + plotW, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // time labels
    if (n > 1) {
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      const labels = Math.max(2, Math.floor(plotW / 110));
      for (let k = 0; k <= labels; k++) {
        const i = Math.round((k / labels) * (n - 1));
        ctx.fillText(fmtDateShort(t[i]), Math.min(padL + plotW - 30, Math.max(padL + 30, x(i))), padT + plotH + 5);
      }
      ctx.textAlign = 'left';
    }
    // series
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.6;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      let firstX = 0;
      let lastX = 0;
      const stride = Math.max(1, Math.floor(n / (plotW * 2)));
      for (let i = 0; i < n; i += stride) {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        const px = x(i);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          firstX = px;
          started = true;
        } else ctx.lineTo(px, py);
        lastX = px;
      }
      if (n && Number.isFinite(s.values[n - 1])) {
        ctx.lineTo(x(n - 1), y(s.values[n - 1]));
        lastX = x(n - 1);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.area && started) {
        const base = y(Math.max(lo, Math.min(hi, zeroLine ? 0 : lo)));
        ctx.lineTo(lastX, base);
        ctx.lineTo(firstX, base);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        g.addColorStop(0, s.color.startsWith('#') ? `${s.color}40` : s.color);
        g.addColorStop(1, s.color.startsWith('#') ? `${s.color}05` : s.color);
        ctx.fillStyle = g;
        ctx.globalAlpha = s.color.startsWith('#') ? 1 : 0.15;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // hover
    if (hover !== null && hover >= 0 && hover < n) {
      const px = Math.round(x(hover)) + 0.5;
      ctx.strokeStyle = css('--chart-cross', 'rgba(128,128,128,0.6)');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of series) {
        const v = s.values[hover];
        if (!Number.isFinite(v)) continue;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(px, y(v), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  const onMove = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    if (n < 1) return;
    const i = Math.round(((px - padL) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const tipLeft = hover !== null ? x(hover) : 0;
  return (
    <div ref={wrap} className="line-chart" style={{ height, position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={() => hover !== null && onPick?.(t[hover])}>
      <canvas ref={canvas} />
      {hover !== null && n > 0 && (
        <div className="lc-tip" style={{ left: Math.min(Math.max(0, tipLeft + 12), Math.max(0, w - 190)), top: 8 }}>
          <div className="muted">{fmtDateTime(t[hover])}</div>
          {series.map((s) => (
            <div key={s.label} className="lc-row">
              <span className="lc-dot" style={{ background: s.color }} />
              {s.label}
              <b>{Number.isFinite(s.values[hover]) ? format(s.values[hover]) : '—'}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
