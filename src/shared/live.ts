/**
 * LiveAggregator — builds candles of any timeframe from two live inputs:
 *
 *  1. Closed base klines (authoritative OHLCV from Binance, delivered contiguously and in order
 *     by the market-data tape; 1s on spot, 1m on futures).
 *  2. Aggregate trades (real-time, used for sub-second updates between base klines).
 *
 * Invariant: every bucket's candle = aggregate(closed base klines in bucket)
 *                                   ⊕ trades in bucket with time > watermark,
 * where `watermark` is the inclusive close time of the latest closed base kline. Trades at or
 * before the watermark are already contained in the authoritative klines and are discarded,
 * which makes the result independent of trade duplicates, delays or reordering. Trade-id gaps
 * are flagged and healed automatically when the next base kline closes.
 */

import { CandleSeries, mergeInto, type Bar } from './candles';
import { bucketStart, type Timeframe } from './timeframes';

export interface TradeTick {
  /** Aggregate trade id (strictly increasing per symbol/market on Binance). */
  id: number;
  /** Trade time (ms). */
  t: number;
  p: number;
  q: number;
  /** Buyer is maker => seller-initiated (aggressive sell). */
  m: boolean;
}

export interface BaseKline extends Bar {
  /** Inclusive close time (ms) as reported by Binance (openTime + interval - 1). */
  T: number;
}

export interface BarUpdate {
  index: number;
  bar: Bar;
  isNew: boolean;
}

export class LiveAggregator {
  readonly tf: Timeframe;
  series: CandleSeries;
  watermark: number;
  lastTradeId = -1;
  /** Time of the first trade received after an id gap; data before the next base kline may be incomplete. */
  gapSince: number | null = null;
  private auth = new Map<number, Bar>();
  private pending: TradeTick[] = [];
  private lastTradeTimeOfTail = -Infinity;
  private maxAuth: number;

  /**
   * @param series   history built exclusively from closed base klines (may be empty)
   * @param watermark inclusive close time of the last closed base kline contained in `series`
   */
  constructor(tf: Timeframe, series: CandleSeries, watermark: number, maxAuthBuckets = 6) {
    this.tf = tf;
    this.series = series;
    this.watermark = watermark;
    this.maxAuth = maxAuthBuckets;
    if (series.length) {
      // The newest history bucket may be partial: it is authoritative up to the watermark.
      const lb = series.bar(series.length - 1);
      this.auth.set(lb.t, { ...lb });
    }
  }

  get degraded(): boolean {
    return this.gapSince !== null;
  }

  /** Apply one trade. Returns changed bars (usually one). */
  applyTrade(tr: TradeTick): BarUpdate[] {
    if (tr.id <= this.lastTradeId) return []; // duplicate or replayed
    if (this.lastTradeId >= 0 && tr.id > this.lastTradeId + 1 && this.gapSince === null) this.gapSince = tr.t;
    this.lastTradeId = tr.id;
    if (tr.t <= this.watermark) return []; // already contained in authoritative klines

    const bucket = bucketStart(this.tf, tr.t);
    const s = this.series;
    const lastIdx = s.length - 1;

    // insert into pending keeping (t, id) order
    const pend = this.pending;
    if (!pend.length || pend[pend.length - 1].t <= tr.t) pend.push(tr);
    else {
      let i = pend.length - 1;
      while (i >= 0 && pend[i].t > tr.t) i--;
      pend.splice(i + 1, 0, tr);
    }

    // fast path: in-order trade in the newest bucket
    if (lastIdx >= 0 && s.t[lastIdx] === bucket && tr.t >= this.lastTradeTimeOfTail) {
      if (tr.p > s.h[lastIdx]) s.h[lastIdx] = tr.p;
      if (tr.p < s.l[lastIdx]) s.l[lastIdx] = tr.p;
      s.c[lastIdx] = tr.p;
      s.v[lastIdx] += tr.q;
      s.qv[lastIdx] += tr.p * tr.q;
      s.n[lastIdx] += 1;
      if (!tr.m) s.tbv[lastIdx] += tr.q;
      this.lastTradeTimeOfTail = tr.t;
      return [{ index: lastIdx, bar: s.bar(lastIdx), isNew: false }];
    }
    return this.recompute(bucket);
  }

  /** Apply one closed base kline (must be contiguous and in order; older ones are ignored). */
  applyBaseKline(k: BaseKline): BarUpdate[] {
    if (k.T <= this.watermark) return [];
    const bucket = bucketStart(this.tf, k.t);
    const kb: Bar = { t: bucket, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, qv: k.qv, n: k.n, tbv: k.tbv };
    const a = this.auth.get(bucket);
    if (a) mergeInto(a, kb);
    else this.auth.set(bucket, kb);
    this.watermark = k.T;
    if (this.gapSince !== null && this.watermark >= this.gapSince) this.gapSince = null;

    // drop trades now covered by authoritative data
    const pend = this.pending;
    let drop = 0;
    while (drop < pend.length && pend[drop].t <= k.T) drop++;
    if (drop) pend.splice(0, drop);

    // prune old authoritative buckets
    if (this.auth.size > this.maxAuth) {
      const keys = [...this.auth.keys()].sort((x, y) => x - y);
      for (let i = 0; i < keys.length - this.maxAuth; i++) this.auth.delete(keys[i]);
    }
    return this.recompute(bucket);
  }

  /** Rebuild a bucket from authoritative data + pending trades and upsert it. */
  private recompute(bucket: number): BarUpdate[] {
    let bar: Bar | null = null;
    const a = this.auth.get(bucket);
    if (a) bar = { ...a };
    let lastT = -Infinity;
    for (const tr of this.pending) {
      const b = bucketStart(this.tf, tr.t);
      if (b !== bucket) continue;
      if (!bar) bar = { t: bucket, o: tr.p, h: tr.p, l: tr.p, c: tr.p, v: 0, qv: 0, n: 0, tbv: 0 };
      if (tr.p > bar.h) bar.h = tr.p;
      if (tr.p < bar.l) bar.l = tr.p;
      bar.c = tr.p;
      bar.v += tr.q;
      bar.qv += tr.p * tr.q;
      bar.n += 1;
      if (!tr.m) bar.tbv += tr.q;
      lastT = tr.t;
    }
    if (!bar) return [];
    const res = this.upsert(bar);
    if (res.index === this.series.length - 1) this.lastTradeTimeOfTail = lastT;
    return [res];
  }

  private upsert(bar: Bar): BarUpdate {
    const s = this.series;
    const n = s.length;
    if (n === 0 || bar.t > s.t[n - 1]) {
      const index = s.push(bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.qv, bar.n, bar.tbv);
      this.lastTradeTimeOfTail = -Infinity;
      return { index, bar, isNew: true };
    }
    if (bar.t === s.t[n - 1]) {
      s.setBar(n - 1, bar);
      return { index: n - 1, bar, isNew: false };
    }
    const i = s.lowerBound(bar.t);
    if (i < n && s.t[i] === bar.t) {
      s.setBar(i, bar);
      return { index: i, bar, isNew: false };
    }
    // Rare: a bucket inside history that did not exist yet. Rebuild with the bar inserted.
    const ins = new CandleSeries(1);
    ins.pushBar(bar);
    this.series = s.merge(ins);
    return { index: i, bar, isNew: true };
  }

  /** Latest price known to the aggregator. */
  lastPrice(): number {
    const s = this.series;
    return s.length ? s.c[s.length - 1] : NaN;
  }
}
