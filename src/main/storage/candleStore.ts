/**
 * Local historical candle cache.
 *
 * Layout: <root>/candles/<kind>/<market>/<symbol>/<interval>/<chunk>.bin
 *   chunk = YYYY-MM-DD (1s), YYYY-MM (≤ 1h), YYYY (≥ 2h)
 *   file  = packed Float64 candles (see shared/candles STRIDE), sorted, unique by open time
 *   coverage.json = sorted disjoint [from, to) ranges known to be complete (closed candles only)
 *
 * Only missing ranges are downloaded. Large gaps use data.binance.vision archives (monthly,
 * or daily for 1s data); everything else uses the REST API in parallel pages.
 * Nothing is loaded into memory beyond the requested range.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CandleSeries, STRIDE } from '../../shared/candles';
import type { Market, SymbolId } from '../../shared/symbols';
import { intervalMs, intervalToTf, bucketStart, bucketEnd } from '../../shared/timeframes';
import { ensureDir, readJson, writeFileAtomic, writeJsonAtomic } from './jsonStore';

export type CandleKind = 'klines' | 'mark';
export type Range = [number, number];

export interface KlineSource {
  rest(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, startTime: number, endTime: number, limit: number): Promise<CandleSeries>;
  archive(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, period: 'monthly' | 'daily', date: string): Promise<CandleSeries | null>;
  restLimit(market: Market): number;
}

export interface Progress {
  done: number;
  total: number;
  phase: string;
}

// ------------------------------------------------------------------ range helpers

export function addRange(ranges: Range[], r: Range): Range[] {
  if (r[1] <= r[0]) return ranges;
  const out: Range[] = [];
  let [a, b] = r;
  let placed = false;
  for (const [x, y] of ranges) {
    if (y < a) out.push([x, y]);
    else if (x > b) {
      if (!placed) {
        out.push([a, b]);
        placed = true;
      }
      out.push([x, y]);
    } else {
      a = Math.min(a, x);
      b = Math.max(b, y);
    }
  }
  if (!placed) out.push([a, b]);
  return out.sort((p, q) => p[0] - q[0]);
}

export function subtractRanges(want: Range, have: Range[]): Range[] {
  let pieces: Range[] = [want];
  for (const [x, y] of have) {
    const next: Range[] = [];
    for (const [a, b] of pieces) {
      if (y <= a || x >= b) next.push([a, b]);
      else {
        if (x > a) next.push([a, x]);
        if (y < b) next.push([y, b]);
      }
    }
    pieces = next;
    if (!pieces.length) break;
  }
  return pieces.filter(([a, b]) => b > a);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

type Span = 'day' | 'month' | 'year';

function spanFor(interval: string): Span {
  const ms = intervalMs(interval);
  if (ms < 60_000) return 'day';
  if (ms <= 3_600_000) return 'month';
  return 'year';
}

function chunkStart(span: Span, t: number): number {
  const d = new Date(t);
  if (span === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (span === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

function chunkEnd(span: Span, start: number): number {
  const d = new Date(start);
  if (span === 'day') return start + 86_400_000;
  if (span === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
}

function chunkName(span: Span, start: number): string {
  const d = new Date(start);
  if (span === 'day') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (span === 'month') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  return `${d.getUTCFullYear()}`;
}

function readPacked(file: string): Float64Array {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return new Float64Array(0);
  }
  try {
    const size = fs.fstatSync(fd).size;
    const usable = size - (size % (STRIDE * 8));
    const ab = new ArrayBuffer(usable);
    if (usable) fs.readSync(fd, new Uint8Array(ab), 0, usable, 0);
    return new Float64Array(ab);
  } finally {
    fs.closeSync(fd);
  }
}

/** Packed array lower bound by time. */
function packedLowerBound(p: Float64Array, t: number): number {
  let lo = 0;
  let hi = p.length / STRIDE;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (p[mid * STRIDE] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class CandleStore {
  private locks = new Map<string, Promise<unknown>>();
  private coverageCache = new Map<string, Range[]>();

  constructor(
    readonly root: string,
    private source: KlineSource,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
    /** Binance server time; candles still forming on Binance's clock are never cached. */
    private now: () => number = Date.now,
  ) {
    ensureDir(root);
  }

  dirOf(kind: CandleKind, market: Market, symbol: SymbolId, interval: string): string {
    return path.join(this.root, 'candles', kind, market, symbol, interval);
  }

  /** Open time of the currently forming candle; candles before it are closed. */
  static currentOpen(interval: string, now = Date.now()): number {
    return bucketStart(intervalToTf(interval), now);
  }

  coverage(kind: CandleKind, market: Market, symbol: SymbolId, interval: string): Range[] {
    const dir = this.dirOf(kind, market, symbol, interval);
    let c = this.coverageCache.get(dir);
    if (!c) {
      c = readJson<Range[]>(path.join(dir, 'coverage.json'), []);
      this.coverageCache.set(dir, c);
    }
    return c;
  }

  private setCoverage(dir: string, ranges: Range[]): void {
    this.coverageCache.set(dir, ranges);
    writeJsonAtomic(path.join(dir, 'coverage.json'), ranges);
  }

  /** Missing sub-ranges of [from, to) (clamped to closed candles). */
  missing(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, from: number, to: number): Range[] {
    const tf = intervalToTf(interval);
    const a = bucketStart(tf, from);
    // 1.5 s margin covers the uncertainty of the measured clock offset
    const b = Math.min(to, CandleStore.currentOpen(interval, this.now() - 1500));
    if (b <= a) return [];
    return subtractRanges([a, b], this.coverage(kind, market, symbol, interval));
  }

  /** Read cached candles with open time in [from, to). Does not download. */
  read(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, from: number, to: number): CandleSeries {
    const dir = this.dirOf(kind, market, symbol, interval);
    const span = spanFor(interval);
    const parts: Float64Array[] = [];
    let total = 0;
    for (let cs = chunkStart(span, from); cs < to; cs = chunkEnd(span, cs)) {
      const p = readPacked(path.join(dir, `${chunkName(span, cs)}.bin`));
      if (!p.length) continue;
      const i0 = packedLowerBound(p, from);
      const i1 = packedLowerBound(p, to);
      if (i1 > i0) {
        const sub = p.subarray(i0 * STRIDE, i1 * STRIDE);
        parts.push(sub);
        total += sub.length;
      }
    }
    const packed = new Float64Array(total);
    let off = 0;
    for (const p of parts) {
      packed.set(p, off);
      off += p.length;
    }
    return CandleSeries.unpack(packed);
  }

  /** Persist candles (merged into existing chunks). */
  write(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, s: CandleSeries): void {
    if (!s.length) return;
    const dir = this.dirOf(kind, market, symbol, interval);
    ensureDir(dir);
    const span = spanFor(interval);
    let i = 0;
    while (i < s.length) {
      const cs = chunkStart(span, s.t[i]);
      const ce = chunkEnd(span, cs);
      let j = i;
      while (j < s.length && s.t[j] < ce) j++;
      const file = path.join(dir, `${chunkName(span, cs)}.bin`);
      const existing = CandleSeries.unpack(readPacked(file));
      const merged = existing.length ? existing.merge(s.slice(i, j)) : s.slice(i, j);
      const packed = merged.pack();
      writeFileAtomic(file, new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
      i = j;
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Ensure [from, to) is cached, downloading only what is missing. */
  async ensure(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, from: number, to: number, onProgress?: (p: Progress) => void): Promise<void> {
    const dir = this.dirOf(kind, market, symbol, interval);
    await this.withLock(dir, async () => {
      const gaps = this.missing(kind, market, symbol, interval, from, to);
      if (!gaps.length) return;
      const ms = intervalMs(interval);
      const tasks: { range: Range; run: () => Promise<CandleSeries | null> }[] = [];
      for (const [a, b] of gaps) this.planDownloads(kind, market, symbol, interval, ms, a, b, tasks);
      let done = 0;
      const total = tasks.length;
      onProgress?.({ done, total, phase: 'download' });
      // run in parallel (limiters inside the source bound actual concurrency)
      const results = await Promise.all(
        tasks.map(async (task) => {
          const s = await task.run();
          done++;
          onProgress?.({ done, total, phase: 'download' });
          return { task, s };
        }),
      );
      let cov = this.coverage(kind, market, symbol, interval).slice();
      for (const { task, s } of results) {
        if (s === null) continue;
        const [a, b] = task.range;
        // keep only closed candles inside the planned range
        const i0 = s.lowerBound(a);
        const i1 = s.lowerBound(b);
        const part = s.slice(i0, i1);
        this.write(kind, market, symbol, interval, part);
        cov = addRange(cov, [a, b]);
      }
      this.setCoverage(dir, cov);
    });
  }

  /** Break [a, b) into archive and REST download tasks. */
  private planDownloads(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, ms: number, a: number, b: number, out: { range: Range; run: () => Promise<CandleSeries | null> }[]): void {
    const count = Math.ceil((b - a) / ms);
    const restLimit = this.source.restLimit(market);
    const useArchives = count > 6 * restLimit && ms <= 3_600_000;
    const nowMonth = chunkStart('month', Date.now());
    const today = chunkStart('day', Date.now());
    if (useArchives) {
      let t = a;
      while (t < b) {
        const ms0 = chunkStart('month', t);
        const me = chunkEnd('month', ms0);
        const wholeMonth = t === ms0 && me <= b && me <= nowMonth;
        if (wholeMonth && interval !== '1s') {
          const date = chunkName('month', ms0);
          const range: Range = [ms0, me];
          out.push({ range, run: () => this.archiveOrRest(kind, market, symbol, interval, 'monthly', date, range, ms, restLimit) });
          t = me;
          continue;
        }
        // day-level within this month
        const de = Math.min(me, b);
        let d = t;
        while (d < de) {
          const ds = chunkStart('day', d);
          const dend = Math.min(ds + 86_400_000, de);
          const wholeDay = d === ds && dend === ds + 86_400_000 && dend <= today;
          if (wholeDay && interval === '1s') {
            const date = chunkName('day', ds);
            const range: Range = [ds, dend];
            out.push({ range, run: () => this.archiveOrRest(kind, market, symbol, interval, 'daily', date, range, ms, restLimit) });
          } else {
            this.planRest(kind, market, symbol, interval, ms, restLimit, d, dend, out);
          }
          d = dend;
        }
        t = de;
      }
    } else {
      this.planRest(kind, market, symbol, interval, ms, restLimit, a, b, out);
    }
  }

  private planRest(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, ms: number, limit: number, a: number, b: number, out: { range: Range; run: () => Promise<CandleSeries | null> }[]): void {
    const isMonth = interval === '1M';
    const step = isMonth ? Infinity : ms * limit;
    for (let s = a; s < b; s += step) {
      const e = Math.min(b, s + step);
      out.push({ range: [s, e], run: () => this.restRange(kind, market, symbol, interval, s, e, ms, limit) });
      if (!isFinite(step)) break;
    }
  }

  private async restRange(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, a: number, b: number, ms: number, limit: number): Promise<CandleSeries> {
    let out = new CandleSeries(Math.min(limit, Math.ceil((b - a) / ms) + 1));
    let start = a;
    for (let guard = 0; guard < 10000; guard++) {
      const s = await this.source.rest(kind, market, symbol, interval, start, b - 1, limit);
      if (!s.length) break;
      out = out.length ? out.merge(s) : s;
      const last = s.t[s.length - 1];
      const next = interval === '1M' ? bucketEnd(intervalToTf('1M'), last) : last + ms;
      if (next >= b || s.length < limit) break;
      start = next;
    }
    return out;
  }

  private async archiveOrRest(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, period: 'monthly' | 'daily', date: string, range: Range, ms: number, limit: number): Promise<CandleSeries> {
    try {
      const s = await this.source.archive(kind, market, symbol, interval, period, date);
      if (s && s.length) return s;
    } catch (e) {
      this.log('warn', `Archive ${period} ${symbol} ${interval} ${date} failed: ${(e as Error).message}; falling back to REST`);
    }
    return this.restRange(kind, market, symbol, interval, range[0], range[1], ms, limit);
  }

  /** ensure + read. */
  async get(kind: CandleKind, market: Market, symbol: SymbolId, interval: string, from: number, to: number, onProgress?: (p: Progress) => void): Promise<CandleSeries> {
    await this.ensure(kind, market, symbol, interval, from, to, onProgress);
    return this.read(kind, market, symbol, interval, from, to);
  }

  /** Earliest cached time and total cached ranges (for the data manager UI). */
  stats(kind: CandleKind, market: Market, symbol: SymbolId, interval: string): { ranges: Range[]; bytes: number } {
    const dir = this.dirOf(kind, market, symbol, interval);
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.bin')) bytes += fs.statSync(path.join(dir, f)).size;
    } catch {
      /* none */
    }
    return { ranges: this.coverage(kind, market, symbol, interval), bytes };
  }

  /** Remove cached data for an instrument/interval (data manager). */
  clear(kind: CandleKind, market: Market, symbol: SymbolId, interval: string): void {
    const dir = this.dirOf(kind, market, symbol, interval);
    fs.rmSync(dir, { recursive: true, force: true });
    this.coverageCache.delete(dir);
  }
}

/** Adapter from BinanceRest to KlineSource. */
export function binanceKlineSource(rest: import('../binance/rest').BinanceRest): KlineSource {
  return {
    restLimit: (market) => (market === 'spot' ? 1000 : 1500),
    rest: (kind, market, symbol, interval, startTime, endTime, limit) =>
      kind === 'mark' ? rest.markPriceKlines(symbol, interval, { startTime, endTime, limit }) : rest.klines(market, symbol, interval, { startTime, endTime, limit }),
    archive: (kind, market, symbol, interval, period, date) => rest.archiveKlines(market, symbol, interval, period, date, kind === 'mark' ? 'markPriceKlines' : 'klines'),
  };
}
