/**
 * Local cache of Binance aggregate trades — the data behind footprints (and the finest
 * resolution available for analysis). Trades are stored per market / symbol / UTC day as packed
 * Float64 quadruples [id, time, price, signedQty]; a negative quantity marks a seller-initiated
 * trade (the buyer was the maker), exactly as Binance reports it — nothing is inferred.
 * Coverage ranges record which stretches are complete so only missing parts are downloaded
 * (REST, paged by trade id). Old days are pruned to bound disk use.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BinanceRest } from '../binance/rest';
import type { TradeTick } from '../../shared/live';
import type { Market, SymbolId } from '../../shared/symbols';

type Range = [number, number];
const DAY = 86400000;
const STRIDE = 4;

export interface TradeArrays {
  id: Float64Array;
  t: Float64Array;
  p: Float64Array;
  /** Quantity; negative = seller-initiated (aggressive sell). */
  q: Float64Array;
  length: number;
}

export type TradeProgress = (p: { done: number; total: number; trades: number }) => void;

function dayKey(t: number): string {
  return new Date(t - (t % DAY)).toISOString().slice(0, 10);
}

function mergeRanges(r: Range[]): Range[] {
  const s = r.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

function missing(cov: Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  let t = from;
  for (const [a, b] of cov) {
    if (b <= t) continue;
    if (a >= to) break;
    if (a > t) out.push([t, Math.min(a, to)]);
    t = Math.max(t, b);
    if (t >= to) break;
  }
  if (t < to) out.push([t, to]);
  return out;
}

export class TradeStore {
  private locks = new Map<string, Promise<void>>();

  constructor(
    readonly root: string,
    private rest: BinanceRest,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
    private maxDays = 6,
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  private dirOf(market: Market, symbol: SymbolId): string {
    return path.join(this.root, market, symbol);
  }

  coverage(market: Market, symbol: SymbolId): Range[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirOf(market, symbol), 'coverage.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  private setCoverage(market: Market, symbol: SymbolId, r: Range[]): void {
    const dir = this.dirOf(market, symbol);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify(mergeRanges(r)));
  }

  private readDay(market: Market, symbol: SymbolId, key: string): Float64Array {
    const f = path.join(this.dirOf(market, symbol), `${key}.bin`);
    if (!fs.existsSync(f)) return new Float64Array(0);
    const b = fs.readFileSync(f);
    return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 8)));
  }

  /** Merge trades into day files (dedupe by trade id, keep id order). */
  private writeTrades(market: Market, symbol: SymbolId, trades: TradeTick[]): void {
    if (!trades.length) return;
    const dir = this.dirOf(market, symbol);
    fs.mkdirSync(dir, { recursive: true });
    const byDay = new Map<string, TradeTick[]>();
    for (const tr of trades) {
      const k = dayKey(tr.t);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(tr);
    }
    for (const [k, list] of byDay) {
      list.sort((a, b) => a.id - b.id);
      const cur = this.readDay(market, symbol, k);
      const n0 = cur.length / STRIDE;
      // two-pointer merge of id-sorted rows, skipping ids already stored
      const out = new Float64Array((n0 + list.length) * STRIDE);
      let i = 0;
      let j = 0;
      let o = 0;
      let lastId = -1;
      const put = (id: number, t: number, p: number, q: number) => {
        if (id === lastId) return;
        lastId = id;
        out[o++] = id;
        out[o++] = t;
        out[o++] = p;
        out[o++] = q;
      };
      while (i < n0 || j < list.length) {
        const ci = i < n0 ? cur[i * STRIDE] : Infinity;
        const lj = j < list.length ? list[j].id : Infinity;
        if (ci <= lj) {
          put(ci, cur[i * STRIDE + 1], cur[i * STRIDE + 2], cur[i * STRIDE + 3]);
          i++;
          if (ci === lj) j++;
        } else {
          const x = list[j++];
          put(x.id, x.t, x.p, x.m ? -x.q : x.q);
        }
      }
      if (o === n0 * STRIDE) continue; // nothing new
      const f = path.join(dir, `${k}.bin`);
      fs.writeFileSync(`${f}.tmp`, Buffer.from(out.buffer, 0, o * 8));
      fs.renameSync(`${f}.tmp`, f);
    }
  }

  /** Download [from, to) from the REST API (paged by trade id). */
  private async download(market: Market, symbol: SymbolId, from: number, to: number, onProgress?: TradeProgress, signal?: { cancelled: boolean }): Promise<void> {
    const HOUR = 3600000;
    let t = from;
    let fromId: number | null = null;
    let batch: TradeTick[] = [];
    let total = 0;
    let coveredTo = from;
    const flush = () => {
      this.writeTrades(market, symbol, batch);
      batch = [];
      this.setCoverage(market, symbol, [...this.coverage(market, symbol), [from, coveredTo]]);
    };
    while (t < to) {
      if (signal?.cancelled) break;
      const page: TradeTick[] = fromId !== null ? await this.rest.aggTrades(market, symbol, { fromId, limit: 1000 }) : await this.rest.aggTrades(market, symbol, { startTime: t, endTime: Math.min(t + HOUR, to) - 1, limit: 1000 });
      if (!page.length) {
        if (fromId !== null) break;
        t = Math.min(t + HOUR, to);
        coveredTo = t;
        continue;
      }
      let done = false;
      for (const tr of page) {
        if (tr.t >= to) {
          done = true;
          break;
        }
        batch.push(tr);
      }
      total += page.length;
      const last = page[page.length - 1];
      onProgress?.({ done: Math.min(to, last.t) - from, total: to - from, trades: total });
      if (done) {
        coveredTo = to;
        break;
      }
      if (fromId === null && page.length < 1000) {
        // the whole time window is in this page
        t = Math.min(t + HOUR, to);
        coveredTo = t;
      } else {
        fromId = last.id + 1;
        t = last.t;
        coveredTo = last.t;
        if (page.length < 1000) {
          // reached the newest trades
          coveredTo = Math.min(to, last.t + 1);
          break;
        }
      }
      if (batch.length >= 200000) flush();
    }
    if (!signal?.cancelled && t >= to) coveredTo = to;
    flush();
  }

  /** Trades in [from, to), downloading what the cache lacks. */
  async get(market: Market, symbol: SymbolId, from: number, to: number, onProgress?: TradeProgress, signal?: { cancelled: boolean }): Promise<TradeArrays> {
    const key = `${market}:${symbol}`;
    // one download per instrument at a time
    while (this.locks.has(key)) await this.locks.get(key);
    let release!: () => void;
    this.locks.set(key, new Promise<void>((r) => (release = r)));
    try {
      for (const [a, b] of missing(this.coverage(market, symbol), from, to)) {
        try {
          await this.download(market, symbol, a, b, onProgress, signal);
        } catch (e) {
          this.log('warn', `trades ${key}: ${(e as Error).message}`);
          throw e;
        }
      }
      this.prune(market, symbol);
    } finally {
      this.locks.delete(key);
      release();
    }
    return this.read(market, symbol, from, to);
  }

  /** Cached trades in [from, to) without downloading. */
  read(market: Market, symbol: SymbolId, from: number, to: number): TradeArrays {
    const chunks: Float64Array[] = [];
    let n = 0;
    for (let d = from - (from % DAY); d < to; d += DAY) {
      const a = this.readDay(market, symbol, dayKey(d));
      if (a.length) {
        chunks.push(a);
        n += a.length / STRIDE;
      }
    }
    const id = new Float64Array(n);
    const t = new Float64Array(n);
    const p = new Float64Array(n);
    const q = new Float64Array(n);
    let k = 0;
    for (const a of chunks) {
      for (let i = 0; i < a.length; i += STRIDE) {
        const tt = a[i + 1];
        if (tt < from || tt >= to) continue;
        id[k] = a[i];
        t[k] = tt;
        p[k] = a[i + 2];
        q[k] = a[i + 3];
        k++;
      }
    }
    return { id: id.subarray(0, k), t: t.subarray(0, k), p: p.subarray(0, k), q: q.subarray(0, k), length: k };
  }

  /** Keep only the newest `maxDays` day files per instrument. */
  prune(market: Market, symbol: SymbolId): void {
    const dir = this.dirOf(market, symbol);
    if (!fs.existsSync(dir)) return;
    const days = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.bin$/.test(f))
      .sort();
    const drop = days.slice(0, Math.max(0, days.length - this.maxDays));
    if (!drop.length) return;
    for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });
    const keepFrom = Date.parse(`${days[drop.length]?.slice(0, 10) || '9999-12-31'}T00:00:00Z`);
    this.setCoverage(
      market,
      symbol,
      this.coverage(market, symbol)
        .map(([a, b]) => [Math.max(a, keepFrom), b] as Range)
        .filter(([a, b]) => b > a),
    );
  }

  /** Disk usage per instrument (data manager). */
  stats(): { market: Market; symbol: SymbolId; bytes: number; days: number; coverage: Range[] }[] {
    const out: { market: Market; symbol: SymbolId; bytes: number; days: number; coverage: Range[] }[] = [];
    for (const market of ['spot', 'futures'] as Market[]) {
      const md = path.join(this.root, market);
      if (!fs.existsSync(md)) continue;
      for (const symbol of fs.readdirSync(md) as SymbolId[]) {
        const dir = path.join(md, symbol);
        let bytes = 0;
        let days = 0;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.bin')) continue;
          bytes += fs.statSync(path.join(dir, f)).size;
          days++;
        }
        out.push({ market, symbol, bytes, days, coverage: this.coverage(market, symbol) });
      }
    }
    return out;
  }

  clear(market?: Market, symbol?: SymbolId): void {
    const target = market && symbol ? this.dirOf(market, symbol) : market ? path.join(this.root, market) : this.root;
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
  }
}
