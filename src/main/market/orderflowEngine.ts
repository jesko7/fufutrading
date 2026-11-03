/**
 * Order-flow analysis over a stream of Binance aggregate trades, trade by trade, in time order.
 * History and live trades go through the same code, so a bar's result does not depend on
 * whether the app saw it live — except for the order book's resting size on absorption
 * bubbles, which only exists live.
 *
 *  - HvnEngine: one volume profile per period (UTC-aligned); its high-volume nodes become bands
 *    that end at the first bar trading back into them once the period is over.
 *  - ImbalanceEngine: per bar footprint rows; stacked diagonal imbalances become zones that end
 *    at the first later bar trading back into them.
 *  - AbsorptionEngine: aggressive volume hitting one row from one side ("hit clusters"); a cluster
 *    whose volume crosses the threshold while price does not trade through the row is absorption.
 *    The bubble stays: confirmed when the row holds for the hold time, marked broken if price
 *    trades through it before that.
 */
import type { AbsorptionEvent, AbsorptionParams, HvnLevel, HvnParams, ImbalanceLevel, ImbalanceParams } from '../../shared/orderflow';

const rowOf = (p: number, row: number): number => Math.floor(p / row + 1e-9);

/** Resting size on one side of the live book within [lo, hi); NaN when the book is not live. */
export type BookProbe = (side: 'bid' | 'ask', lo: number, hi: number) => number;

type Cells = Map<number, [number, number]>;

function addCell(rows: Cells, r: number, q: number): void {
  let e = rows.get(r);
  if (!e) {
    e = [0, 0];
    rows.set(r, e);
  }
  if (q >= 0) e[0] += q;
  else e[1] -= q;
}

// ------------------------------------------------------------------ HVN

/** High-volume nodes of a profile: band sums that are local maxima, strongest first, bands apart. */
export function findNodes(rows: Cells, band: number, count: number, strength: number): { row: number; vol: number; buy: number }[] {
  if (!rows.size) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows.keys()) {
    if (r < min) min = r;
    if (r > max) max = r;
  }
  const n = max - min + 1;
  if (n > 500000) return [];
  const k = Math.max(0, Math.floor(band / 2));
  const PV = new Float64Array(n + 1);
  const PB = new Float64Array(n + 1);
  const V = new Float64Array(n);
  for (const [r, [b, s]] of rows) {
    V[r - min] = b + s;
    PB[r - min + 1] = b;
  }
  for (let i = 0; i < n; i++) {
    PV[i + 1] = PV[i] + V[i];
    PB[i + 1] += PB[i];
  }
  const S = (i: number) => PV[Math.min(n, i + k + 1)] - PV[Math.max(0, i - k)];
  const avgBand = (PV[n] / n) * (2 * k + 1);
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (V[i] <= 0) continue;
    const s = S(i);
    if (s < strength * avgBand) continue;
    let peak = true;
    for (let d = 1; d <= k + 1 && peak; d++) if ((i - d >= 0 && S(i - d) > s) || (i + d < n && S(i + d) > s)) peak = false;
    if (peak) cand.push(i);
  }
  cand.sort((a, b) => S(b) - S(a) || a - b);
  const picked: number[] = [];
  for (const i of cand) {
    if (picked.some((j) => Math.abs(j - i) <= 2 * k)) continue;
    picked.push(i);
    if (picked.length >= count) break;
  }
  return picked.map((i) => ({ row: i + min, vol: S(i), buy: PB[Math.min(n, i + k + 1)] - PB[Math.max(0, i - k)] }));
}

export class HvnEngine {
  private cur: { start: number; rows: Cells } | null = null;
  private done: { start: number; levels: HvnLevel[] }[] = [];
  private open: HvnLevel[] = [];
  private dev: HvnLevel[] | null = null;
  /** Bumped on every change (the forming profile changes with every trade). */
  version = 0;

  constructor(
    readonly p: HvnParams,
    private bucket: (t: number) => number,
  ) {}

  add(t: number, price: number, q: number): void {
    const ps = Math.floor(t / this.p.periodMs) * this.p.periodMs;
    if (!this.cur || ps !== this.cur.start) {
      if (this.cur) this.finish(this.cur);
      this.cur = { start: ps, rows: new Map() };
    }
    addCell(this.cur.rows, rowOf(price, this.p.row), q);
    this.dev = null;
    this.version++;
    if (this.p.untilTouched && this.open.length) {
      for (let i = this.open.length - 1; i >= 0; i--) {
        const L = this.open[i];
        if (price >= L.lo && price < L.hi) {
          L.to = this.bucket(t);
          this.open.splice(i, 1);
        }
      }
    }
  }

  private nodes(start: number, rows: Cells, developing: boolean): HvnLevel[] {
    const { row, band, count, strength } = this.p;
    const k = Math.floor(band / 2);
    return findNodes(rows, band, count, strength).map((nd) => ({
      id: `${developing ? 'd' : 'h'}${start}:${nd.row}`,
      lo: (nd.row - k) * row,
      hi: (nd.row + k + 1) * row,
      vol: nd.vol,
      buy: nd.buy,
      from: start,
      to: null,
      developing,
    }));
  }

  private finish(c: { start: number; rows: Cells }): void {
    if (this.p.periods <= 0) return;
    const levels = this.nodes(c.start, c.rows, false);
    this.done.push({ start: c.start, levels });
    while (this.done.length > this.p.periods) this.done.shift();
    const keep = new Set(this.done.flatMap((d) => d.levels));
    this.open = this.open.filter((L) => keep.has(L));
    this.open.push(...levels);
  }

  levels(): HvnLevel[] {
    if (!this.dev) this.dev = this.cur ? this.nodes(this.cur.start, this.cur.rows, true) : [];
    return [...this.done.flatMap((d) => d.levels), ...this.dev];
  }
}

// ------------------------------------------------------------------ imbalances

/** Stacked diagonal imbalances of one bar's footprint rows. */
export function stackedImbalances(rows: Cells, row: number, ratio: number, stack: number, minVol: number, t: number, live: boolean): ImbalanceLevel[] {
  if (rows.size < stack) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows.keys()) {
    if (r < min) min = r;
    if (r > max) max = r;
  }
  const n = max - min + 1;
  if (n > 100000) return [];
  const B = new Float64Array(n);
  const S = new Float64Array(n);
  for (const [r, [b, s]] of rows) {
    B[r - min] = b;
    S[r - min] = s;
  }
  const out: ImbalanceLevel[] = [];
  for (const side of [1, -1] as const) {
    let a = -1;
    let dom = 0;
    let opp = 0;
    const flush = (end: number) => {
      const cnt = end - a + 1;
      // a near-empty opposite side counts as a noise floor (the minimum row volume / ratio), so a
      // few satoshis against a whole row don't read as a 2000× imbalance; every zone stays ≥ ratio
      const floor = Math.max(opp, (minVol * cnt) / ratio);
      if (a >= 0 && cnt >= stack) out.push({ id: `${t}:${side}:${min + a}`, side, lo: (min + a) * row, hi: (min + end + 1) * row, t, rows: cnt, ratio: floor > 0 ? dom / floor : Infinity, vol: dom, opp, end: null, live });
      a = -1;
      dom = opp = 0;
    };
    for (let i = 0; i < n; i++) {
      // buying at a row against selling one row lower; selling against buying one row higher
      const d = side === 1 ? B[i] : S[i];
      const j = side === 1 ? i - 1 : i + 1;
      const ok = j >= 0 && j < n && d >= minVol && d > 0 && d >= ratio * (side === 1 ? S[j] : B[j]);
      if (ok) {
        if (a < 0) a = i;
        dom += d;
        opp += side === 1 ? S[j] : B[j];
      } else if (a >= 0) flush(i - 1);
    }
    if (a >= 0) flush(n - 1);
  }
  return out;
}

export class ImbalanceEngine {
  private cur: { t: number; rows: Cells; lo: number; hi: number } | null = null;
  private zones: ImbalanceLevel[] = [];
  private open: ImbalanceLevel[] = [];
  private cellSum = 0;
  private cellN = 0;
  private liveCache: ImbalanceLevel[] | null = null;
  version = 0;

  constructor(
    readonly p: ImbalanceParams,
    private bucket: (t: number) => number,
  ) {}

  private minVol(): number {
    return this.p.minVolume > 0 ? this.p.minVolume : this.cellN ? this.cellSum / this.cellN : 0;
  }

  add(t: number, price: number, q: number): void {
    const b = this.bucket(t);
    if (!this.cur || b !== this.cur.t) {
      if (this.cur) this.close(this.cur);
      this.cur = { t: b, rows: new Map(), lo: Infinity, hi: -Infinity };
    }
    const c = this.cur;
    if (price < c.lo || price > c.hi) {
      if (price < c.lo) c.lo = price;
      if (price > c.hi) c.hi = price;
      for (let i = this.open.length - 1; i >= 0; i--) {
        const z = this.open[i];
        if (c.hi >= z.lo && c.lo < z.hi) {
          z.end = c.t;
          this.open.splice(i, 1);
          this.version++;
        }
      }
    }
    addCell(c.rows, rowOf(price, this.p.row), q);
    this.liveCache = null;
    this.version++;
  }

  private close(c: { t: number; rows: Cells }): void {
    const zones = stackedImbalances(c.rows, this.p.row, this.p.ratio, this.p.stack, this.minVol(), c.t, false);
    for (const [b, s] of c.rows.values()) {
      if (b > 0) {
        this.cellSum += b;
        this.cellN++;
      }
      if (s > 0) {
        this.cellSum += s;
        this.cellN++;
      }
    }
    if (!zones.length) return;
    this.zones.push(...zones);
    this.open.push(...zones);
    const cap = Math.max(400, this.p.maxLevels * 4);
    if (this.zones.length > cap) {
      const drop = new Set(this.zones.splice(0, this.zones.length - cap));
      this.open = this.open.filter((z) => !drop.has(z));
    }
  }

  levels(): ImbalanceLevel[] {
    if (!this.liveCache) this.liveCache = this.cur ? stackedImbalances(this.cur.rows, this.p.row, this.p.ratio, this.p.stack, this.minVol(), this.cur.t, true) : [];
    return [...this.zones.slice(-this.p.maxLevels), ...this.liveCache];
  }
}

// ------------------------------------------------------------------ absorption

interface Cluster {
  key: number;
  row: number;
  side: 1 | -1;
  t0: number;
  t1: number;
  vol: number;
  pv: number;
  n: number;
  closed: boolean;
  /** Resting size at the row when the first hit printed (NaN without a live book). */
  shown: number;
  ev: AbsorptionEvent | null;
}

const MAX_CLUSTER_MS = 60000;
const VOL_SAMPLES = 4000;
const WARMUP = 200;

export class AbsorptionEngine {
  /** Open clusters, and closed clusters with a bubble within the hold time. */
  private active: Cluster[] = [];
  private byKey = new Map<number, Cluster>();
  private vols: number[] = [];
  private volPos = 0;
  private sinceThr = 0;
  private autoThr = Infinity;
  readonly events = new Map<string, AbsorptionEvent>();
  /** Bubbles added or changed / removed since the last drain. */
  readonly changed = new Set<string>();
  readonly removed = new Set<string>();

  constructor(
    readonly p: AbsorptionParams,
    public book: BookProbe | null = null,
  ) {}

  threshold(): number {
    if (this.p.minVolume > 0) return this.p.minVolume;
    return this.vols.length >= WARMUP ? this.autoThr : Infinity;
  }

  private record(v: number): void {
    if (this.vols.length < VOL_SAMPLES) this.vols.push(v);
    else {
      this.vols[this.volPos] = v;
      this.volPos = (this.volPos + 1) % VOL_SAMPLES;
    }
    if (++this.sinceThr >= 100 || (this.autoThr === Infinity && this.vols.length >= WARMUP)) {
      this.sinceThr = 0;
      const s = [...this.vols].sort((a, b) => a - b);
      this.autoThr = s[Math.min(s.length - 1, Math.floor(this.p.quantile * s.length))];
    }
  }

  private closeCluster(c: Cluster, i: number): void {
    c.closed = true;
    if (this.byKey.get(c.key) === c) this.byKey.delete(c.key);
    this.record(c.vol);
    if (!c.ev) this.active.splice(i, 1);
  }

  /** Advance time: close clusters without hits, confirm bubbles whose level held. */
  tick(t: number): void {
    const { gapMs, holdMs } = this.p;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (!c.closed) this.emitIfReady(c, Math.min(t, c.t1 + gapMs));
      if (!c.closed && (t - c.t1 > gapMs || t - c.t0 > MAX_CLUSTER_MS)) {
        this.closeCluster(c, i);
        if (!c.ev) continue;
      }
      if (c.closed && c.ev && t - c.t1 > gapMs + holdMs) {
        c.ev.state = 'held';
        this.changed.add(c.ev.id);
        this.active.splice(i, 1);
      }
    }
  }

  add(t: number, price: number, q: number): void {
    const side: 1 | -1 = q >= 0 ? 1 : -1;
    const v = Math.abs(q);
    const r = rowOf(price, this.p.row);
    const tol = this.p.tolerance;
    // a print beyond a level the hits came into breaks it: before the threshold the cluster is
    // dropped; a bubble stays, marked broken (it did absorb that volume, then gave way)
    for (let i = this.active.length - 1; i >= 0; i--) {
      const c = this.active[i];
      if (c.side < 0 ? r < c.row - tol : r > c.row + tol) {
        this.active.splice(i, 1);
        if (this.byKey.get(c.key) === c) this.byKey.delete(c.key);
        if (!c.closed) this.record(c.vol);
        if (c.ev) {
          c.ev.state = 'broken';
          c.ev.broke = t;
          this.changed.add(c.ev.id);
        }
      }
    }
    this.tick(t);
    const key = r * 2 + (side > 0 ? 1 : 0);
    let c = this.byKey.get(key);
    if (!c) {
      const shown = this.book ? this.book(side > 0 ? 'ask' : 'bid', r * this.p.row, (r + 1) * this.p.row) : NaN;
      c = { key, row: r, side, t0: t, t1: t, vol: 0, pv: 0, n: 0, closed: false, shown, ev: null };
      this.byKey.set(key, c);
      this.active.push(c);
    }
    c.vol += v;
    c.pv += price * v;
    c.n++;
    c.t1 = t;
    this.emitIfReady(c, t);
    if (c.ev) this.sync(c);
  }

  /**
   * A cluster becomes a bubble once its volume crosses the threshold and its level has held for
   * the minimum time since the first hit (a fixed minimum counts from that volume on; the
   * automatic threshold must be exceeded).
   */
  private emitIfReady(c: Cluster, t: number): void {
    if (c.ev || t - c.t0 < this.p.minAgeMs) return;
    if (!(this.p.minVolume > 0 ? c.vol >= this.p.minVolume : c.vol > this.threshold())) return;
    const shown = Number.isFinite(c.shown) ? c.shown : null;
    // the id follows the cluster (row, side, first hit), so a rebuild from the same trades keeps it
    c.ev = { id: `${c.side > 0 ? 'b' : 's'}${c.row}@${c.t0}`, side: c.side, price: 0, lo: c.row * this.p.row, hi: (c.row + 1) * this.p.row, t, t0: c.t0, t1: c.t1, vol: 0, trades: 0, shown, maxShown: shown, state: 'live', broke: null };
    this.events.set(c.ev.id, c.ev);
    this.sync(c);
    if (this.events.size > 1500) {
      const old = [...this.events.keys()].slice(0, this.events.size - 1200);
      for (const id of old) {
        this.events.delete(id);
        this.changed.delete(id);
        this.removed.add(id);
      }
    }
  }

  private sync(c: Cluster): void {
    const e = c.ev!;
    e.vol = c.vol;
    e.price = c.pv / c.vol;
    e.t1 = c.t1;
    e.trades = c.n;
    this.changed.add(e.id);
  }

  /** Live: track the largest resting size at levels that are being hit. */
  probeLive(): void {
    if (!this.book) return;
    for (const c of this.active) {
      if (!c.ev || c.closed) continue;
      const s = this.book(c.side > 0 ? 'ask' : 'bid', c.ev.lo, c.ev.hi);
      if (!Number.isFinite(s)) continue;
      if (c.ev.shown === null) c.ev.shown = s;
      if (c.ev.maxShown === null || s > c.ev.maxShown) {
        c.ev.maxShown = s;
        this.changed.add(c.ev.id);
      }
    }
  }

  list(): AbsorptionEvent[] {
    return [...this.events.values()];
  }

  drain(): { changed: AbsorptionEvent[]; removed: string[] } {
    const changed = [...this.changed].map((id) => this.events.get(id)).filter((e): e is AbsorptionEvent => !!e);
    const removed = [...this.removed];
    this.changed.clear();
    this.removed.clear();
    return { changed, removed };
  }
}

// ------------------------------------------------------------------ combined

export class OrderFlowEngine {
  readonly hvn: HvnEngine | null;
  readonly imb: ImbalanceEngine | null;
  readonly abs: AbsorptionEngine | null;
  trades = 0;
  lastT = 0;

  constructor(opts: { bucket: (t: number) => number; hvn?: HvnParams | null; imbalance?: ImbalanceParams | null; absorption?: AbsorptionParams | null; book?: BookProbe | null }) {
    this.hvn = opts.hvn ? new HvnEngine(opts.hvn, opts.bucket) : null;
    this.imb = opts.imbalance ? new ImbalanceEngine(opts.imbalance, opts.bucket) : null;
    this.abs = opts.absorption ? new AbsorptionEngine(opts.absorption, opts.book || null) : null;
  }

  /** One aggregate trade; q < 0: seller-initiated. */
  add(t: number, p: number, q: number): void {
    this.trades++;
    this.lastT = t;
    this.hvn?.add(t, p, q);
    this.imb?.add(t, p, q);
    this.abs?.add(t, p, q);
  }

  tick(t: number): void {
    this.abs?.tick(t);
  }
}
