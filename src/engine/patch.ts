/**
 * Result patches: the changed tail of a ScriptResult (per-bar outputs from index `from` on;
 * object outputs such as labels and lines in full). Dependency-free so the renderer can use it.
 */
import type { ScriptResult, ScriptError } from './types';

export interface PlotPatch {
  values: Float64Array;
  colors: (string | null)[] | null;
  o?: Float64Array;
  h?: Float64Array;
  l?: Float64Array;
}

/** Changed tail of a result: outputs from index `from` on; objects (labels, lines…) in full. */
export interface ResultPatch {
  from: number;
  n: number;
  t0: number;
  ok: boolean;
  error?: ScriptError;
  plots: PlotPatch[];
  bgcolors: (string | null)[] | null;
  barcolors: (string | null)[] | null;
  alerts: Uint8Array[];
  labels: ScriptResult['labels'];
  lines: ScriptResult['lines'];
  boxes: ScriptResult['boxes'];
  tables: ScriptResult['tables'];
  alertEvents: ScriptResult['alertEvents'];
  logs: ScriptResult['logs'];
  warnings: ScriptResult['warnings'];
  strategy?: ScriptResult['strategy'];
  stats: ScriptResult['stats'];
}

export function makePatch(r: ScriptResult, from: number, t0: number): ResultPatch {
  const n = r.stats.bars;
  const f = Math.max(0, Math.min(from, n));
  return {
    from: f,
    n,
    t0,
    ok: r.ok,
    error: r.error,
    plots: r.plots.map((p) => ({ values: p.values.slice(f), colors: p.colors ? p.colors.slice(f) : null, o: p.o?.slice(f), h: p.h?.slice(f), l: p.l?.slice(f) })),
    bgcolors: r.bgcolors ? r.bgcolors.slice(f) : null,
    barcolors: r.barcolors ? r.barcolors.slice(f) : null,
    alerts: r.alerts.map((a) => a.values.slice(f)),
    labels: r.labels,
    lines: r.lines,
    boxes: r.boxes,
    tables: r.tables,
    alertEvents: r.alertEvents,
    logs: r.logs.slice(-300),
    warnings: r.warnings,
    strategy: r.strategy,
    stats: r.stats,
  };
}

/** Apply a patch to a full result (used by consumers that keep a full copy). */
export function applyPatch(r: ScriptResult, p: ResultPatch): ScriptResult {
  const f = p.from;
  const join = (a: Float64Array | undefined, tail: Float64Array | undefined): Float64Array | undefined => {
    if (!tail) return a;
    const out = new Float64Array(f + tail.length);
    if (a) out.set(a.subarray(0, Math.min(f, a.length)));
    if (a && a.length < f) out.fill(NaN, a.length, f);
    out.set(tail, f);
    return out;
  };
  const joinArr = <T>(a: T[] | null, tail: T[] | null): T[] | null => (tail ? (a || []).slice(0, f).concat(tail) : a);
  return {
    ...r,
    ok: p.ok,
    error: p.error,
    plots: r.plots.map((pl, k) => {
      const t = p.plots[k];
      if (!t) return pl;
      return { ...pl, values: join(pl.values, t.values)!, colors: joinArr(pl.colors, t.colors), o: join(pl.o, t.o), h: join(pl.h, t.h), l: join(pl.l, t.l) };
    }),
    bgcolors: joinArr(r.bgcolors, p.bgcolors),
    barcolors: joinArr(r.barcolors, p.barcolors),
    alerts: r.alerts.map((a, k) => {
      const t = p.alerts[k];
      if (!t) return a;
      const out = new Uint8Array(f + t.length);
      out.set(a.values.subarray(0, Math.min(f, a.values.length)));
      out.set(t, f);
      return { ...a, values: out };
    }),
    labels: p.labels,
    lines: p.lines,
    boxes: p.boxes,
    tables: p.tables,
    alertEvents: p.alertEvents,
    logs: p.logs,
    warnings: p.warnings,
    strategy: p.strategy ?? r.strategy,
    stats: p.stats,
  };
}
