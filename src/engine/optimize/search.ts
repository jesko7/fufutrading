/**
 * Search strategies with an ask/tell interface so trials run in parallel batches:
 *  - grid (exhaustive, or an even subsample when the grid exceeds the budget),
 *  - random (unique points),
 *  - Bayesian via TPE (tree-structured Parzen estimator on the discrete grid),
 *  - genetic (tournament selection, uniform crossover, step mutation, elitism; NSGA-II
 *    ranking when several objectives are given).
 * Scores are "higher is better"; failed or constraint-violating trials score -Infinity.
 */
import { type ParamDef, type Point, cardinality, fromIndices, toIndices, pointKey, gridPoints, gridSize, rng, randomPoint } from './space';

export interface Trial {
  point: Point;
  key: string;
  score: number;
  /** For multi-objective runs (each higher-is-better). */
  objectives?: number[];
}

export interface Searcher {
  ask(n: number): Point[];
  tell(trials: Trial[]): void;
  done(): boolean;
}

export type Method = 'grid' | 'random' | 'bayes' | 'genetic';

abstract class Base implements Searcher {
  protected seen = new Set<string>();
  protected trials: Trial[] = [];
  protected asked = 0;
  protected rand: () => number;
  constructor(
    protected space: ParamDef[],
    protected budget: number,
    seed: number,
  ) {
    this.rand = rng(seed);
  }
  abstract ask(n: number): Point[];
  tell(trials: Trial[]): void {
    this.trials.push(...trials);
  }
  done(): boolean {
    return this.asked >= this.budget || this.seen.size >= gridSize(this.space);
  }
  protected take(pt: Point): boolean {
    const k = pointKey(this.space, pt);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    this.asked++;
    return true;
  }
  protected randomUnique(): Point | null {
    for (let i = 0; i < 200; i++) {
      const p = randomPoint(this.space, this.rand);
      if (!this.seen.has(pointKey(this.space, p))) return p;
    }
    // dense: scan for the first unseen point
    for (const p of gridPoints(this.space)) if (!this.seen.has(pointKey(this.space, p))) return p;
    return null;
  }
}

export class GridSearch extends Base {
  private points: Point[];
  private i = 0;
  constructor(space: ParamDef[], budget: number, seed = 1) {
    super(space, budget, seed);
    const size = gridSize(space);
    const all: Point[] = [];
    if (size <= budget) for (const p of gridPoints(space)) all.push(p);
    else {
      // even subsample of the grid (deterministic stride with a random offset)
      const stride = size / budget;
      const off = this.rand() * stride;
      const card = space.map(cardinality);
      for (let k = 0; k < budget; k++) {
        let lin = Math.floor(off + k * stride);
        const idx = new Array(space.length).fill(0);
        for (let d = space.length - 1; d >= 0; d--) {
          idx[d] = lin % card[d];
          lin = Math.floor(lin / card[d]);
        }
        all.push(fromIndices(space, idx));
      }
    }
    this.points = all;
    this.budget = Math.min(budget, all.length);
  }
  ask(n: number): Point[] {
    const out: Point[] = [];
    while (out.length < n && this.i < this.points.length) {
      const p = this.points[this.i++];
      if (this.take(p)) out.push(p);
    }
    return out;
  }
  override done(): boolean {
    return this.i >= this.points.length;
  }
}

export class RandomSearch extends Base {
  ask(n: number): Point[] {
    const out: Point[] = [];
    while (out.length < n && !this.done()) {
      const p = this.randomUnique();
      if (!p || !this.take(p)) break;
      out.push(p);
    }
    return out;
  }
}

/** TPE over grid indices with a discrete Parzen kernel (triangular, width ~ 1/8 of the range). */
export class BayesSearch extends Base {
  private startup: number;
  constructor(space: ParamDef[], budget: number, seed = 1) {
    super(space, budget, seed);
    this.startup = Math.max(8, Math.min(30, Math.round(budget * 0.2)));
  }
  private density(trials: Trial[], d: number): Float64Array {
    const c = cardinality(this.space[d]);
    const w = new Float64Array(c).fill(1 / c); // prior
    const bw = Math.max(1, Math.round(c / 8));
    for (const t of trials) {
      const k = toIndices(this.space, t.point)[d];
      for (let j = Math.max(0, k - bw); j <= Math.min(c - 1, k + bw); j++) w[j] += 1 - Math.abs(j - k) / (bw + 1);
    }
    const s = w.reduce((a, b) => a + b, 0);
    for (let j = 0; j < c; j++) w[j] /= s;
    return w;
  }
  private sample(p: Float64Array): number {
    let r = this.rand();
    for (let j = 0; j < p.length; j++) {
      r -= p[j];
      if (r <= 0) return j;
    }
    return p.length - 1;
  }
  ask(n: number): Point[] {
    const out: Point[] = [];
    const valid = this.trials.filter((t) => Number.isFinite(t.score));
    while (out.length < n && !this.done()) {
      let p: Point | null = null;
      if (this.trials.length + out.length < this.startup || valid.length < 4) p = this.randomUnique();
      else {
        const sorted = [...valid].sort((a, b) => b.score - a.score);
        const nGood = Math.max(2, Math.ceil(sorted.length * 0.25));
        const good = sorted.slice(0, nGood);
        const bad = sorted.slice(nGood);
        const lg = this.space.map((_, d) => this.density(good, d));
        const lb = this.space.map((_, d) => this.density(bad, d));
        let best: number[] | null = null;
        let bestScore = -Infinity;
        for (let c = 0; c < 32; c++) {
          const idx = this.space.map((_, d) => this.sample(lg[d]));
          const key = idx.join(',');
          if (this.seen.has(key)) continue;
          let s = 0;
          for (let d = 0; d < idx.length; d++) s += Math.log(lg[d][idx[d]]) - Math.log(lb[d][idx[d]]);
          if (s > bestScore) {
            bestScore = s;
            best = idx;
          }
        }
        p = best ? fromIndices(this.space, best) : this.randomUnique();
      }
      if (!p || !this.take(p)) {
        const q = this.randomUnique();
        if (!q || !this.take(q)) break;
        out.push(q);
        continue;
      }
      out.push(p);
    }
    return out;
  }
}

/** Pareto ranks (0 = non-dominated front) and crowding distances (NSGA-II). */
export function paretoRanks(objs: number[][]): { rank: number[]; crowd: number[] } {
  const n = objs.length;
  const dominates = (a: number[], b: number[]) => a.every((x, k) => x >= b[k]) && a.some((x, k) => x > b[k]);
  const rank = new Array(n).fill(-1);
  const S: number[][] = Array.from({ length: n }, () => []);
  const cnt = new Array(n).fill(0);
  let front: number[] = [];
  for (let p = 0; p < n; p++) {
    for (let q = 0; q < n; q++) {
      if (p === q) continue;
      if (dominates(objs[p], objs[q])) S[p].push(q);
      else if (dominates(objs[q], objs[p])) cnt[p]++;
    }
    if (cnt[p] === 0) {
      rank[p] = 0;
      front.push(p);
    }
  }
  let r = 0;
  while (front.length) {
    const next: number[] = [];
    for (const p of front)
      for (const q of S[p]) {
        cnt[q]--;
        if (cnt[q] === 0) {
          rank[q] = r + 1;
          next.push(q);
        }
      }
    r++;
    front = next;
  }
  const crowd = new Array(n).fill(0);
  const m = objs[0]?.length || 0;
  for (let rr = 0; rr < r; rr++) {
    const f = rank.map((x, i) => (x === rr ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < m; k++) {
      f.sort((a, b) => objs[a][k] - objs[b][k]);
      const lo = objs[f[0]][k];
      const hi = objs[f[f.length - 1]][k];
      crowd[f[0]] = crowd[f[f.length - 1]] = Infinity;
      for (let j = 1; j < f.length - 1; j++) crowd[f[j]] += hi > lo ? (objs[f[j + 1]][k] - objs[f[j - 1]][k]) / (hi - lo) : 0;
    }
  }
  return { rank, crowd };
}

export class GeneticSearch extends Base {
  private popSize: number;
  constructor(space: ParamDef[], budget: number, seed = 1) {
    super(space, budget, seed);
    this.popSize = Math.max(8, Math.min(40, Math.round(Math.sqrt(budget) * 2)));
  }
  /** Fitness ordering: scalar score, or Pareto rank + crowding when objectives exist. */
  private ranked(): Trial[] {
    const valid = this.trials.filter((t) => Number.isFinite(t.score));
    if (valid.length && valid[0].objectives && valid[0].objectives.length > 1) {
      const { rank, crowd } = paretoRanks(valid.map((t) => t.objectives!));
      return valid.map((t, i) => ({ t, r: rank[i], c: crowd[i] })).sort((a, b) => a.r - b.r || b.c - a.c).map((x) => x.t);
    }
    return [...valid].sort((a, b) => b.score - a.score);
  }
  private tournament(pop: Trial[]): Trial {
    let best = pop[Math.floor(this.rand() * pop.length)];
    for (let k = 0; k < 2; k++) {
      const c = pop[Math.floor(this.rand() * pop.length)];
      if (pop.indexOf(c) < pop.indexOf(best)) best = c;
    }
    return best;
  }
  ask(n: number): Point[] {
    const out: Point[] = [];
    const pop = this.ranked().slice(0, this.popSize);
    while (out.length < n && !this.done()) {
      let p: Point | null;
      if (this.trials.length + out.length < this.popSize || pop.length < 4) p = this.randomUnique();
      else {
        const a = toIndices(this.space, this.tournament(pop).point);
        const b = toIndices(this.space, this.tournament(pop).point);
        const child = a.map((x, d) => (this.rand() < 0.5 ? x : b[d]));
        const pm = 1 / Math.max(1, this.space.length);
        for (let d = 0; d < child.length; d++) {
          if (this.rand() < pm + 0.1) {
            const c = cardinality(this.space[d]);
            if (this.rand() < 0.2) child[d] = Math.floor(this.rand() * c);
            else child[d] = Math.max(0, Math.min(c - 1, child[d] + (this.rand() < 0.5 ? -1 : 1) * (1 + Math.floor(this.rand() * 2))));
          }
        }
        p = fromIndices(this.space, child);
        if (this.seen.has(pointKey(this.space, p))) p = this.randomUnique();
      }
      if (!p || !this.take(p)) break;
      out.push(p);
    }
    return out;
  }
}

export function makeSearcher(method: Method, space: ParamDef[], budget: number, seed = 1): Searcher {
  switch (method) {
    case 'grid':
      return new GridSearch(space, budget, seed);
    case 'random':
      return new RandomSearch(space, budget, seed);
    case 'bayes':
      return new BayesSearch(space, budget, seed);
    default:
      return new GeneticSearch(space, budget, seed);
  }
}
