/**
 * Parameter spaces for optimization: integer/float ranges with steps, booleans and choices.
 * Every point is snapped to the grid so all search methods explore the same lattice, which
 * makes neighbour/robustness analysis and caching of duplicate trials possible.
 */

export type ParamDef =
  | { key: string; title?: string; kind: 'int' | 'float'; min: number; max: number; step: number }
  | { key: string; title?: string; kind: 'bool' }
  | { key: string; title?: string; kind: 'choice'; values: (string | number)[] };

export type Point = Record<string, number | string | boolean>;

/** Number of grid values of one dimension. */
export function cardinality(p: ParamDef): number {
  if (p.kind === 'bool') return 2;
  if (p.kind === 'choice') return p.values.length;
  if (!(p.step > 0) || p.max < p.min) return 1;
  return Math.floor((p.max - p.min) / p.step + 1e-9) + 1;
}

export function gridSize(space: ParamDef[]): number {
  return space.reduce((a, p) => a * cardinality(p), 1);
}

/** Value at grid index k of a dimension. */
export function valueAt(p: ParamDef, k: number): number | string | boolean {
  if (p.kind === 'bool') return k === 1;
  if (p.kind === 'choice') return p.values[Math.max(0, Math.min(p.values.length - 1, k))];
  const v = p.min + Math.max(0, Math.min(cardinality(p) - 1, k)) * p.step;
  return p.kind === 'int' ? Math.round(v) : +v.toFixed(10);
}

/** Grid index of a value (nearest). */
export function indexOf(p: ParamDef, v: unknown): number {
  if (p.kind === 'bool') return v ? 1 : 0;
  if (p.kind === 'choice') return Math.max(0, p.values.findIndex((x) => x === v));
  const k = Math.round((Number(v) - p.min) / p.step);
  return Math.max(0, Math.min(cardinality(p) - 1, k));
}

export function toIndices(space: ParamDef[], pt: Point): number[] {
  return space.map((p) => indexOf(p, pt[p.key]));
}

export function fromIndices(space: ParamDef[], idx: number[]): Point {
  const pt: Point = {};
  space.forEach((p, d) => (pt[p.key] = valueAt(p, idx[d])));
  return pt;
}

export function pointKey(space: ParamDef[], pt: Point): string {
  return toIndices(space, pt).join(',');
}

/** All grid points (lexicographic). Caller must check gridSize first. */
export function* gridPoints(space: ParamDef[]): Generator<Point> {
  const card = space.map(cardinality);
  const idx = new Array(space.length).fill(0);
  if (!space.length) {
    yield {};
    return;
  }
  for (;;) {
    yield fromIndices(space, idx);
    let d = space.length - 1;
    while (d >= 0) {
      idx[d]++;
      if (idx[d] < card[d]) break;
      idx[d] = 0;
      d--;
    }
    if (d < 0) return;
  }
}

/** Deterministic PRNG (mulberry32) so optimizations are reproducible with a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomPoint(space: ParamDef[], rand: () => number): Point {
  return fromIndices(
    space,
    space.map((p) => Math.floor(rand() * cardinality(p))),
  );
}

/** Points differing by one grid step in exactly one dimension. */
export function neighbours(space: ParamDef[], pt: Point): Point[] {
  const base = toIndices(space, pt);
  const out: Point[] = [];
  space.forEach((p, d) => {
    const c = cardinality(p);
    for (const dk of [-1, 1]) {
      const k = base[d] + dk;
      if (k < 0 || k >= c) continue;
      const idx = base.slice();
      idx[d] = k;
      out.push(fromIndices(space, idx));
    }
  });
  return out;
}

/** Build a space from script inputs (int/float with sensible default ranges, bools, options). */
export function spaceFromInputs(inputs: { key: string; type: string; title: string; defval: unknown; min?: number; max?: number; step?: number; options?: unknown[] }[]): ParamDef[] {
  const out: ParamDef[] = [];
  for (const i of inputs) {
    if (i.type === 'int' || i.type === 'float') {
      const d = Number(i.defval);
      if (i.options && i.options.length) {
        out.push({ key: i.key, title: i.title, kind: 'choice', values: i.options.map(Number) });
        continue;
      }
      const isInt = i.type === 'int';
      let lo = i.min ?? (d > 0 ? d / 2 : d - 10);
      let hi = i.max ?? (d > 0 ? d * 2 : d + 10);
      if (i.min === undefined && i.max === undefined && d === 0) {
        lo = 0;
        hi = 10;
      }
      // keep the default range modest: at most ~10 steps around the default
      const span = hi - lo;
      let step = i.step ?? (isInt ? Math.max(1, Math.round(span / 10)) : +(span / 10).toPrecision(2));
      if (!(step > 0)) step = isInt ? 1 : 0.1;
      if (isInt) {
        lo = Math.round(lo);
        hi = Math.round(hi);
      }
      out.push({ key: i.key, title: i.title, kind: isInt ? 'int' : 'float', min: lo, max: Math.max(lo, hi), step });
    } else if (i.type === 'bool') out.push({ key: i.key, title: i.title, kind: 'bool' });
    else if (i.options && i.options.length && (i.type === 'string' || i.type === 'enum')) out.push({ key: i.key, title: i.title, kind: 'choice', values: i.options as (string | number)[] });
  }
  return out;
}
