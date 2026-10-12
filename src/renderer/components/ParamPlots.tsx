/**
 * Parameter-landscape visualisations for the optimizer: a 2-D heatmap (with hover and click)
 * and a rotatable 3-D surface (drag to rotate), both on canvas.
 */
import { useEffect, useRef, useState } from 'react';

export interface Grid2D {
  xs: (number | string | boolean)[];
  ys: (number | string | boolean)[];
  /** z[yi][xi]; NaN = not evaluated / invalid */
  z: number[][];
  xLabel: string;
  yLabel: string;
  zLabel: string;
}

function cssVar(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

/** Diverging color scale: red (low) → neutral → green (high). */
export function scaleColor(v: number, lo: number, hi: number): string {
  if (!Number.isFinite(v)) return 'rgba(128,128,128,0.12)';
  const t = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
  // red 239,83,80 → amber 245,165,36 → green 38,166,154
  const stops = [
    [239, 83, 80],
    [245, 165, 36],
    [38, 166, 154],
  ];
  const k = t < 0.5 ? 0 : 1;
  const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[k];
  const b = stops[k + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function range(z: number[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of z)
    for (const v of row)
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const fmtV = (v: number | string | boolean) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')) : String(v));

export function Heatmap({ grid, height = 320, format = (v) => v.toFixed(2), selected, onPick }: { grid: Grid2D; height?: number; format?: (v: number) => string; selected?: [number, number] | null; onPick?: (xi: number, yi: number) => void }) {
  const [wrap, w] = useWidth();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const padL = 56;
  const padB = 34;
  const padT = 6;
  const padR = 8;
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const cw = Math.max(1, (w - padL - padR) / Math.max(1, nx));
  const ch = Math.max(1, (height - padT - padB) / Math.max(1, ny));
  const [lo, hi] = range(grid.z);
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
    const text = cssVar('--chart-text', '#888');
    ctx.font = `11px ${cssVar('--font', 'sans-serif')}`;
    for (let yi = 0; yi < ny; yi++)
      for (let xi = 0; xi < nx; xi++) {
        const x = padL + xi * cw;
        const y = padT + (ny - 1 - yi) * ch;
        ctx.fillStyle = scaleColor(grid.z[yi][xi], lo, hi);
        ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
        if (cw > 38 && ch > 16 && Number.isFinite(grid.z[yi][xi])) {
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(format(grid.z[yi][xi]), x + cw / 2, y + ch / 2);
        }
      }
    const mark = (cell: [number, number] | null | undefined, color: string, lw: number) => {
      if (!cell) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(padL + cell[0] * cw + 1, padT + (ny - 1 - cell[1]) * ch + 1, cw - 2, ch - 2);
    };
    mark(selected, cssVar('--text', '#fff'), 2);
    mark(hover, cssVar('--accent', '#3b82f6'), 1.5);
    // axes labels
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const stepX = Math.max(1, Math.ceil(nx / Math.max(1, Math.floor((w - padL) / 44))));
    for (let xi = 0; xi < nx; xi += stepX) ctx.fillText(fmtV(grid.xs[xi]), padL + xi * cw + cw / 2, padT + ny * ch + 4);
    ctx.fillText(grid.xLabel, padL + (nx * cw) / 2, padT + ny * ch + 19);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const stepY = Math.max(1, Math.ceil(ny / Math.max(1, Math.floor((height - padB) / 18))));
    for (let yi = 0; yi < ny; yi += stepY) ctx.fillText(fmtV(grid.ys[yi]), padL - 6, padT + (ny - 1 - yi) * ch + ch / 2);
    ctx.save();
    ctx.translate(12, padT + (ny * ch) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(grid.yLabel, 0, 0);
    ctx.restore();
  });
  const cellAt = (e: React.MouseEvent): [number, number] | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xi = Math.floor((e.clientX - r.left - padL) / cw);
    const yi = ny - 1 - Math.floor((e.clientY - r.top - padT) / ch);
    return xi >= 0 && xi < nx && yi >= 0 && yi < ny ? [xi, yi] : null;
  };
  const hv = hover ? grid.z[hover[1]][hover[0]] : NaN;
  return (
    <div ref={wrap} style={{ position: 'relative', height }} onMouseMove={(e) => setHover(cellAt(e))} onMouseLeave={() => setHover(null)} onClick={(e) => {
      const c = cellAt(e);
      if (c) onPick?.(c[0], c[1]);
    }}>
      <canvas ref={canvas} style={{ display: 'block', cursor: 'pointer' }} />
      {hover && (
        <div className="lc-tip" style={{ left: Math.min(w - 180, padL + hover[0] * cw + cw + 6), top: Math.max(4, padT + (ny - 1 - hover[1]) * ch - 10) }}>
          <div>
            {grid.xLabel} = <b>{fmtV(grid.xs[hover[0]])}</b>
          </div>
          <div>
            {grid.yLabel} = <b>{fmtV(grid.ys[hover[1]])}</b>
          </div>
          <div>
            {grid.zLabel}: <b>{Number.isFinite(hv) ? format(hv) : 'not evaluated / invalid'}</b>
          </div>
        </div>
      )}
      <div className="heat-legend">
        <span>{format(lo)}</span>
        <span className="heat-bar" />
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}

/** Isometric 3-D surface of z over (x, y); drag horizontally to rotate, vertically to tilt. */
export function Surface3D({ grid, height = 360, format = (v) => v.toFixed(2) }: { grid: Grid2D; height?: number; format?: (v: number) => string }) {
  const [wrap, w] = useWidth();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rot, setRot] = useState({ a: -0.75, e: 0.6 });
  const drag = useRef<{ x: number; y: number; a: number; e: number } | null>(null);
  const [lo, hi] = range(grid.z);
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
    const nx = grid.xs.length;
    const ny = grid.ys.length;
    const S = Math.min(w, height) * 0.36;
    const cosA = Math.cos(rot.a);
    const sinA = Math.sin(rot.a);
    const cosE = Math.cos(rot.e);
    const sinE = Math.sin(rot.e);
    const proj = (xi: number, yi: number, z: number) => {
      const x = (nx > 1 ? xi / (nx - 1) : 0.5) * 2 - 1;
      const y = (ny > 1 ? yi / (ny - 1) : 0.5) * 2 - 1;
      const zz = hi > lo ? ((z - lo) / (hi - lo)) * 1.2 - 0.6 : 0;
      const rx = x * cosA - y * sinA;
      const ry = x * sinA + y * cosA;
      return { px: w / 2 + rx * S, py: height / 2 + ry * S * sinE - zz * S * cosE, depth: ry };
    };
    // painter's algorithm: draw quads back to front
    const quads: { d: number; pts: { px: number; py: number }[]; v: number }[] = [];
    for (let yi = 0; yi < ny - 1; yi++)
      for (let xi = 0; xi < nx - 1; xi++) {
        const zs = [grid.z[yi][xi], grid.z[yi][xi + 1], grid.z[yi + 1][xi + 1], grid.z[yi + 1][xi]];
        const valid = zs.filter(Number.isFinite);
        if (!valid.length) continue;
        const fill = valid.reduce((a, b) => a + b, 0) / valid.length;
        const corners = [proj(xi, yi, Number.isFinite(zs[0]) ? zs[0] : lo), proj(xi + 1, yi, Number.isFinite(zs[1]) ? zs[1] : lo), proj(xi + 1, yi + 1, Number.isFinite(zs[2]) ? zs[2] : lo), proj(xi, yi + 1, Number.isFinite(zs[3]) ? zs[3] : lo)];
        quads.push({ d: corners.reduce((a, p) => a + p.depth, 0) / 4, pts: corners, v: fill });
      }
    quads.sort((a, b) => a.d - b.d);
    const grid_ = cssVar('--chart-grid', 'rgba(128,128,128,0.2)');
    for (const q of quads) {
      ctx.beginPath();
      ctx.moveTo(q.pts[0].px, q.pts[0].py);
      for (let k = 1; k < 4; k++) ctx.lineTo(q.pts[k].px, q.pts[k].py);
      ctx.closePath();
      ctx.fillStyle = scaleColor(q.v, lo, hi);
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grid_;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    // axis labels at the base corners
    const text = cssVar('--chart-text', '#888');
    ctx.fillStyle = text;
    ctx.font = `11px ${cssVar('--font', 'sans-serif')}`;
    const xA = proj(nx - 1, 0, lo);
    const yA = proj(0, ny - 1, lo);
    ctx.fillText(`${grid.xLabel} →`, xA.px + 6, xA.py + 14);
    ctx.fillText(`${grid.yLabel} →`, yA.px - 40, yA.py + 14);
    ctx.fillText(`${grid.zLabel}: ${format(lo)} … ${format(hi)}`, 10, 16);
  });
  return (
    <div
      ref={wrap}
      style={{ height, cursor: 'grab' }}
      onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, a: rot.a, e: rot.e })}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setRot({ a: d.a + (e.clientX - d.x) / 160, e: Math.max(0.15, Math.min(1.45, d.e + (e.clientY - d.y) / 200)) });
      }}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
    >
      <canvas ref={canvas} style={{ display: 'block' }} />
    </div>
  );
}
