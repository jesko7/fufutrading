/**
 * Small SVG charts for the Options module:
 *  - XYLines: lines over a numeric x axis (volatility smile, term structure, payoff), optional
 *    bid/ask bands and markers, a crosshair that snaps to the nearest x with one tooltip listing
 *    every series;
 *  - StrikeBars: bars on an even strike axis (open interest mirrored calls/puts, gamma exposure
 *    diverging around zero), each bar its own hover target.
 * Marks follow the app's chart conventions: 2px lines, ≤24px bars with a rounded data end,
 * hairline grid, text in text colors (never the series color).
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useSize } from '../../lib/hooks';
import { clsx } from '../../lib/format';

export interface LineSeries {
  id: string;
  label: string;
  /** CSS color (variables allowed). */
  color: string;
  points: [number, number][];
  /** Shaded range per x: [x, low, high] (bid/ask volatility). */
  band?: [number, number, number][];
  dots?: boolean;
}

export interface VLine {
  x: number;
  label: string;
  strong?: boolean;
}

/** About `count` round tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** y at x along points sorted by x (NaN outside them). */
function yAt(points: [number, number][], x: number): number {
  if (!points.length || x < points[0][0] || x > points[points.length - 1][0]) return NaN;
  for (let k = 1; k < points.length; k++) {
    const [x0, y0] = points[k - 1];
    const [x1, y1] = points[k];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

const M = { l: 54, r: 14, t: 12, b: 24 };

export function Legend({ items, onToggle, off }: { items: { id: string; label: string; color: string }[]; onToggle?: (id: string) => void; off?: Set<string> }) {
  return (
    <div className="ox-legend">
      {items.map((s) => (
        <button key={s.id} className={clsx('ox-key', off?.has(s.id) && 'off', !onToggle && 'static')} onClick={onToggle ? () => onToggle(s.id) : undefined} data-tip={onToggle ? (off?.has(s.id) ? 'Show' : 'Hide') : undefined}>
          <span className="ox-line" style={{ background: s.color }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function XYLines({
  series,
  height = 220,
  xFmt,
  yFmt,
  xDomain,
  yDomain,
  vlines = [],
  zero = false,
  pnlFill,
  snapXs,
  emptyText = 'No data',
  label,
}: {
  series: LineSeries[];
  height?: number;
  xFmt: (x: number) => string;
  yFmt: (y: number) => string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  vlines?: VLine[];
  /** Draw the y = 0 line. */
  zero?: boolean;
  /** Wash profit (above 0) and loss (below 0) under this series. */
  pnlFill?: string;
  /** x positions the crosshair snaps to (default: every point of every series). */
  snapXs?: number[];
  emptyText?: string;
  /** Accessible description of the chart. */
  label: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const W = Math.max(200, size.width);
  const H = height;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const all = series.flatMap((s) => s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  const bandPts = series.flatMap((s) => (s.band || []).flatMap(([x, lo, hi]) => [[x, lo] as [number, number], [x, hi] as [number, number]]).filter(([, y]) => Number.isFinite(y)));
  const [x0, x1] = xDomain || [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  let [y0, y1] = yDomain || [Math.min(...all.map((p) => p[1]), ...bandPts.map((p) => p[1])), Math.max(...all.map((p) => p[1]), ...bandPts.map((p) => p[1]))];
  if (zero) {
    y0 = Math.min(y0, 0);
    y1 = Math.max(y1, 0);
  }
  if (y1 === y0) {
    y1 += Math.abs(y1) * 0.05 || 1;
    y0 -= Math.abs(y0) * 0.05 || 1;
  }
  const pad = (y1 - y0) * 0.08;
  if (!yDomain) {
    y1 += pad;
    if (!(zero && y0 === 0)) y0 -= pad;
  }
  const sx = (x: number) => M.l + ((x - x0) / (x1 - x0 || 1)) * pw;
  const sy = (y: number) => M.t + (1 - (y - y0) / (y1 - y0 || 1)) * ph;
  const xt = niceTicks(x0, x1, Math.max(2, Math.floor(pw / 90)));
  const yt = niceTicks(y0, y1, Math.max(2, Math.floor(ph / 40)));
  const snaps = useMemo(() => [...new Set(snapXs || series.flatMap((s) => s.points.map((p) => p[0])))].filter(Number.isFinite).sort((a, b) => a - b), [series, snapXs]);
  const path = (pts: [number, number][]) => {
    let d = '';
    let pen = false;
    for (const [x, y] of pts) {
      if (!Number.isFinite(y) || x < x0 || x > x1) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
    let best = NaN;
    for (const v of snaps) if (!Number.isFinite(best) || Math.abs(v - x) < Math.abs(best - x)) best = v;
    setHover(Number.isFinite(best) ? best : null);
  };
  const empty = !all.length;
  const hx = hover !== null ? sx(hover) : 0;
  const pnl = pnlFill ? series.find((s) => s.id === pnlFill) : undefined;
  return (
    <div className="ox-chart" ref={ref} style={{ height: H }}>
      {empty ? (
        <div className="ox-empty faint">{emptyText}</div>
      ) : (
        <svg width={W} height={H} role="img" aria-label={label}>
          {yt.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} className="ox-grid" />
              <text x={M.l - 6} y={sy(v)} className="ox-tick" textAnchor="end" dominantBaseline="middle">
                {yFmt(v)}
              </text>
            </g>
          ))}
          {xt.map((v) => (
            <text key={`x${v}`} x={sx(v)} y={H - 6} className="ox-tick" textAnchor="middle">
              {xFmt(v)}
            </text>
          ))}
          <line x1={M.l} x2={W - M.r} y1={M.t + ph} y2={M.t + ph} className="ox-axis" />
          {zero && y0 < 0 && y1 > 0 && <line x1={M.l} x2={W - M.r} y1={sy(0)} y2={sy(0)} className="ox-zero" />}
          {pnl && (
            <>
              <clipPath id={`clip-up-${uid}`}>
                <rect x={M.l} y={M.t} width={pw} height={Math.max(0, sy(0) - M.t)} />
              </clipPath>
              <clipPath id={`clip-dn-${uid}`}>
                <rect x={M.l} y={sy(0)} width={pw} height={Math.max(0, M.t + ph - sy(0))} />
              </clipPath>
              {(() => {
                const d = path(pnl.points);
                const first = pnl.points.find(([x, y]) => Number.isFinite(y) && x >= x0);
                const last = [...pnl.points].reverse().find(([x, y]) => Number.isFinite(y) && x <= x1);
                if (!d || !first || !last) return null;
                const area = `${d}L${sx(last[0]).toFixed(1)},${sy(0).toFixed(1)}L${sx(first[0]).toFixed(1)},${sy(0).toFixed(1)}Z`;
                return (
                  <>
                    <path d={area} className="ox-profit" clipPath={`url(#clip-up-${uid})`} />
                    <path d={area} className="ox-loss" clipPath={`url(#clip-dn-${uid})`} />
                  </>
                );
              })()}
            </>
          )}
          {series.map((s) =>
            s.band ? (
              <path
                key={`b${s.id}`}
                d={(() => {
                  const b = s.band!.filter(([x, lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && x >= x0 && x <= x1);
                  if (b.length < 2) return '';
                  return `M${b.map(([x, , hi]) => `${sx(x).toFixed(1)},${sy(hi).toFixed(1)}`).join('L')}L${[...b]
                    .reverse()
                    .map(([x, lo]) => `${sx(x).toFixed(1)},${sy(lo).toFixed(1)}`)
                    .join('L')}Z`;
                })()}
                style={{ fill: s.color }}
                className="ox-band"
              />
            ) : null,
          )}
          {vlines
            .filter((v) => Number.isFinite(v.x) && v.x >= x0 && v.x <= x1)
            .map((v, k) => (
              <g key={`v${k}`}>
                <line x1={sx(v.x)} x2={sx(v.x)} y1={M.t} y2={M.t + ph} className={clsx('ox-vline', v.strong && 'strong')} />
                <text x={sx(v.x) + 4} y={M.t + 10 + k * 12} className="ox-vlabel">
                  {v.label}
                </text>
              </g>
            ))}
          {series.map((s) => (
            <path key={s.id} d={path(s.points)} className="ox-series" style={{ stroke: s.color }} />
          ))}
          {series
            .filter((s) => s.dots)
            .flatMap((s) =>
              s.points
                .filter(([x, y]) => Number.isFinite(y) && x >= x0 && x <= x1)
                .map(([x, y]) => <circle key={`${s.id}-${x}`} cx={sx(x)} cy={sy(y)} r={4} className="ox-dot" style={{ fill: s.color }} />),
            )}
          {hover !== null && (
            <g>
              <line x1={hx} x2={hx} y1={M.t} y2={M.t + ph} className="ox-cross" />
              {series.map((s) => {
                const y = yAt(s.points, hover);
                return Number.isFinite(y) ? <circle key={`h${s.id}`} cx={hx} cy={sy(y)} r={4} className="ox-dot" style={{ fill: s.color }} /> : null;
              })}
            </g>
          )}
          <rect x={M.l} y={M.t} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover !== null && !empty && (
        <div className={clsx('ox-tip', hx > W * 0.6 && 'left')} style={{ left: hx > W * 0.6 ? hx - 12 : hx + 12, top: M.t }}>
          <div className="ox-tip-head">{xFmt(hover)}</div>
          {series.map((s) => {
            const y = yAt(s.points, hover);
            if (!Number.isFinite(y)) return null;
            return (
              <div key={s.id} className="ox-tip-row">
                <span className="ox-line" style={{ background: s.color }} />
                <b>{yFmt(y)}</b>
                <span className="muted">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface StrikeBar {
  x: number;
  /** mirror: calls above, puts below; diverging: one signed value. */
  up?: number;
  down?: number;
  value?: number;
}

/** Bars on an even strike axis; vertical lines (index, max pain, flip) are placed between strikes. */
export function StrikeBars({
  bars,
  mode,
  height = 200,
  xFmt,
  yFmt,
  vlines = [],
  tip,
  colors,
  label,
}: {
  bars: StrikeBar[];
  mode: 'mirror' | 'diverging';
  height?: number;
  xFmt: (x: number) => string;
  yFmt: (y: number) => string;
  vlines?: VLine[];
  tip: (b: StrikeBar) => ReactNode;
  colors: { pos: string; neg: string };
  label: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(200, size.width);
  const H = height;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const n = bars.length;
  const band = n ? pw / n : pw;
  const bw = Math.max(1, Math.min(24, band * 0.72));
  const vals = bars.flatMap((b) => (mode === 'mirror' ? [b.up || 0, -(b.down || 0)] : [b.value || 0]));
  let hi = Math.max(0, ...vals);
  let lo = Math.min(0, ...vals);
  if (hi === lo) hi = 1;
  hi *= 1.08;
  lo *= 1.08;
  const sy = (y: number) => M.t + (1 - (y - lo) / (hi - lo)) * ph;
  const cx = (k: number) => M.l + band * (k + 0.5);
  /** Position of an arbitrary price between the strikes around it. */
  const px = (x: number) => {
    if (!n) return NaN;
    if (x <= bars[0].x) return cx(0);
    if (x >= bars[n - 1].x) return cx(n - 1);
    for (let k = 1; k < n; k++) if (x <= bars[k].x) return cx(k - 1) + ((x - bars[k - 1].x) / (bars[k].x - bars[k - 1].x)) * band;
    return NaN;
  };
  const yt = niceTicks(lo, hi, Math.max(2, Math.floor(ph / 40)));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 56))));
  /** A bar from the baseline with a 4px rounded data end. */
  const bar = (x: number, v: number) => {
    const y0 = sy(0);
    const y1 = sy(v);
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    const r = Math.min(4, bw / 2, h);
    const l = x - bw / 2;
    const rt = x + bw / 2;
    return v >= 0
      ? `M${l},${y0}V${y1 + r}Q${l},${y1} ${l + r},${y1}H${rt - r}Q${rt},${y1} ${rt},${y1 + r}V${y0}Z`
      : `M${l},${y0}V${y1 - r}Q${l},${y1} ${l + r},${y1}H${rt - r}Q${rt},${y1} ${rt},${y1 - r}V${y0}Z`;
  };
  const hb = hover !== null ? bars[hover] : null;
  return (
    <div className="ox-chart" ref={ref} style={{ height: H }}>
      {!n ? (
        <div className="ox-empty faint">No open interest</div>
      ) : (
        <svg width={W} height={H} role="img" aria-label={label}>
          {yt.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} className="ox-grid" />
              <text x={M.l - 6} y={sy(v)} className="ox-tick" textAnchor="end" dominantBaseline="middle">
                {yFmt(v)}
              </text>
            </g>
          ))}
          {bars.map((b, k) =>
            k % every === 0 ? (
              <text key={`x${b.x}`} x={cx(k)} y={H - 6} className="ox-tick" textAnchor="middle">
                {xFmt(b.x)}
              </text>
            ) : null,
          )}
          {bars.map((b, k) => (
            <g key={b.x} className={clsx('ox-bar', hover === k && 'hover')}>
              {mode === 'mirror' ? (
                <>
                  <path d={bar(cx(k), b.up || 0)} style={{ fill: colors.pos }} />
                  <path d={bar(cx(k), -(b.down || 0))} style={{ fill: colors.neg }} />
                </>
              ) : (
                <path d={bar(cx(k), b.value || 0)} style={{ fill: (b.value || 0) >= 0 ? colors.pos : colors.neg }} />
              )}
            </g>
          ))}
          <line x1={M.l} x2={W - M.r} y1={sy(0)} y2={sy(0)} className="ox-axis" />
          {vlines
            .filter((v) => Number.isFinite(v.x) && v.x >= bars[0].x && v.x <= bars[n - 1].x)
            .map((v, k) => (
              <g key={`v${k}`}>
                <line x1={px(v.x)} x2={px(v.x)} y1={M.t} y2={M.t + ph} className={clsx('ox-vline', v.strong && 'strong')} />
                <text x={px(v.x) + 4} y={M.t + 10 + k * 12} className="ox-vlabel">
                  {v.label}
                </text>
              </g>
            ))}
          {bars.map((b, k) => (
            <rect key={`h${b.x}`} x={M.l + band * k} y={M.t} width={band} height={ph} fill="transparent" onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover((h) => (h === k ? null : h))} />
          ))}
        </svg>
      )}
      {hb && hover !== null && (
        <div className={clsx('ox-tip', cx(hover) > W * 0.6 && 'left')} style={{ left: cx(hover) > W * 0.6 ? cx(hover) - 14 : cx(hover) + 14, top: M.t }}>
          <div className="ox-tip-head">{xFmt(hb.x)}</div>
          {tip(hb)}
        </div>
      )}
    </div>
  );
}
