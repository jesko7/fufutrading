/**
 * SeriesService — shared candle series for any (instrument, timeframe, chart type).
 *
 * A series = closed history from the local cache (built from the largest nesting native
 * interval) + the current bucket decomposed into closed native klines (1d/4h/1h/15m/1m/1s)
 * up to the feed watermark + live trades/klines through a LiveAggregator. Heikin-Ashi and
 * Renko are derived views maintained incrementally. One instance is shared by every chart,
 * indicator, bot and alert that asks for the same key.
 */
import { CandleSeries, aggregate, heikinAshi, heikinAshiBar, mergeInto, renkoBoxSize, newRenkoState, renkoStep, cloneRenkoState, type Bar, type RenkoState } from '../../shared/candles';
import { LiveAggregator, type BaseKline, type TradeTick } from '../../shared/live';
import { type SeriesSpec, type SeriesSnapshot, type SeriesUpdate, type SeriesStatus, type SeriesInfo, seriesKey } from '../../shared/marketTypes';
import { baseIntervalFor, bucketStart, bucketEnd, intervalMs, parseTimeframe, timeForBarsBack, tfDurationMs, type Timeframe, DAY, HOUR, MIN } from '../../shared/timeframes';
import { SYMBOL_SPECS, type SymbolId } from '../../shared/symbols';
import { METRICS, METRIC_STEP, fundingSamples, metricBars, type MetricKind } from '../../shared/metrics';
import type { CandleStore } from '../storage/candleStore';
import type { MarketHub } from './hub';
import type { TapeListener } from './tape';
import { MetricPoller, MetricSeries, replayMetricClock, type MetricClock, type MetricLoader } from './metricSeries';
import type { FundingCache } from './funding';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** Source of authoritative closed base klines and provisional trades (live tape or replay). */
export interface SeriesFeed {
  readonly baseInterval: string;
  readonly kind: 'live' | 'replay';
  ready(): Promise<void>;
  watermark(): number;
  recentKlinesAfter(w: number): BaseKline[];
  pendingTrades(): TradeTick[];
  listen(l: TapeListener): () => void;
  status(): SeriesStatus;
  release(): void;
}

export function liveFeed(hub: MarketHub, spec: SeriesSpec): SeriesFeed {
  const { tape, release } = hub.acquireTape(spec.market, spec.symbol);
  return {
    baseInterval: tape.baseInterval,
    kind: 'live',
    ready: () => hub.tapeReady(tape),
    watermark: () => tape.watermark,
    recentKlinesAfter: (w) => tape.recentKlines.filter((k) => k.T > w),
    pendingTrades: () => tape.snapshot().trades,
    listen: (l) => tape.addListener(l),
    status: () => (tape.status === 'live' ? 'live' : tape.status === 'degraded' ? 'degraded' : tape.status === 'reconnecting' ? 'reconnecting' : 'syncing'),
    release,
  };
}

/** What consumers of a shared series use: kline series and futures statistics alike. */
export interface SeriesHandle {
  readonly key: string;
  readonly spec: SeriesSpec;
  readonly out: CandleSeries;
  status: SeriesStatus;
  info: SeriesInfo;
  hasMore: boolean;
  refs: number;
  ready: Promise<void>;
  /** Futures statistics load older history after `ready`; this resolves when it is in. */
  complete?: Promise<void>;
  lastPrice: number;
  subscribe(cb: (u: SeriesUpdate) => void): () => void;
  snapshot(maxBars?: number): SeriesSnapshot;
  loadMore(count: number): Promise<boolean>;
  closedLength(now: number): number;
  source(): CandleSeries;
  dispose(): void;
}

const DECOMP_SPOT = ['1d', '12h', '4h', '1h', '15m', '1m', '1s'];
const DECOMP_FUT = ['1d', '12h', '4h', '1h', '15m', '1m'];

export class ManagedSeries {
  readonly key: string;
  readonly tf: Timeframe;
  readonly histInterval: string | null;
  agg: LiveAggregator | null = null;
  out: CandleSeries = new CandleSeries(16);
  status: SeriesStatus = 'loading';
  info: SeriesInfo;
  hasMore = true;
  refs = 0;
  ready: Promise<void>;
  lastPrice = NaN;
  private listeners = new Set<(u: SeriesUpdate) => void>();
  private unlisten: (() => void) | null = null;
  // renko state
  private renkoState: RenkoState | null = null;
  private renkoCommittedLen = 0;
  private renkoFed = 0; // number of source bars fed into committed state
  private disposed = false;

  constructor(
    readonly spec: SeriesSpec,
    private feed: SeriesFeed,
    private store: CandleStore,
    private log: Logger,
    initialBars: number,
    keySuffix = '',
  ) {
    this.key = seriesKey(spec) + keySuffix;
    const tf = parseTimeframe(spec.tf);
    if (!tf) throw new Error(`Invalid timeframe "${spec.tf}"`);
    this.tf = tf;
    this.histInterval = baseIntervalFor(tf, spec.market);
    this.info = { key: this.key, baseInterval: this.histInterval, construction: '' };
    this.ready = this.init(initialBars).catch((e) => {
      this.status = 'error';
      this.info.error = (e as Error).message;
      this.log('error', `series ${this.key}: ${(e as Error).message}`);
      this.emit({ key: this.key, index: 0, packed: new Float64Array(0), length: 0, reset: true, status: 'error' });
    });
  }

  private describe(): string {
    const histTf = parseTimeframe((this.histInterval || '').replace('d', 'D').replace('w', 'W'));
    const built = histTf && sameTf(histTf, this.tf) ? `Binance native ${this.histInterval} klines` : `aggregated from Binance ${this.histInterval} klines`;
    const live = `live: ${this.feed.baseInterval} klines + aggregate trades`;
    const ct = this.spec.chartType === 'heikinashi' ? ' · Heikin-Ashi' : this.spec.chartType === 'renko' ? ' · Renko' : '';
    return `${built}; ${this.feed.kind === 'replay' ? 'replay feed' : live}${ct}`;
  }

  private async init(initialBars: number): Promise<void> {
    if (!this.histInterval) {
      throw new Error(`${this.spec.tf} cannot be built from Binance klines on ${this.spec.market === 'futures' ? 'futures (no 1s klines; use ≥1m or spot)' : this.spec.market}`);
    }
    const baseMs = intervalMs(this.feed.baseInterval);
    if (tfDurationMs(this.tf) < baseMs) throw new Error(`${this.spec.tf} is finer than the live base interval (${this.feed.baseInterval})`);
    await this.feed.ready();
    const { market, symbol } = this.spec;
    const W = this.feed.watermark();
    const end = W + 1;
    const curStart = bucketStart(this.tf, W);
    const from = timeForBarsBack(this.tf, curStart, initialBars);
    // closed history
    const hist = await this.store.get('klines', market, symbol, this.histInterval, from, curStart);
    const histTf = parseTimeframe(this.histInterval.replace('d', 'D').replace('w', 'W'))!;
    const series = sameTf(histTf, this.tf) ? hist : aggregate(hist, this.tf);
    // current partial bucket from decomposed closed klines
    const partial = await this.buildPartial(curStart, end);
    if (partial) series.pushBar(partial);
    this.agg = new LiveAggregator(this.tf, series, W);
    // catch up with anything that arrived while loading
    for (const k of this.feed.recentKlinesAfter(W)) this.agg.applyBaseKline(k);
    for (const t of this.feed.pendingTrades()) this.agg.applyTrade(t);
    this.hasMore = hist.length > 0 || from > Date.UTC(2017, 0, 1);
    this.rebuildOut();
    this.status = this.feed.status();
    this.info.construction = this.describe();
    if (this.disposed) return;
    this.unlisten = this.feed.listen({
      onTrade: (t) => this.onUpdates(this.agg!.applyTrade(t)),
      onKline: (k) => this.onUpdates(this.agg!.applyBaseKline(k)),
      onStatus: (s) => {
        this.status = s === 'live' ? 'live' : s === 'degraded' ? 'degraded' : s === 'reconnecting' ? 'reconnecting' : s === 'stopped' ? 'error' : 'syncing';
        this.emit({ key: this.key, index: this.out.length, packed: new Float64Array(0), length: this.out.length, status: this.status });
      },
    });
    if (this.agg.series.length) this.lastPrice = this.agg.lastPrice();
  }

  /** Aggregate closed native klines covering [start, end) into one bar (largest intervals first). */
  private async buildPartial(start: number, end: number): Promise<Bar | null> {
    if (end <= start) return null;
    const list = this.spec.market === 'spot' ? DECOMP_SPOT : DECOMP_FUT;
    let t = start;
    let bar: Bar | null = null;
    for (const iv of list) {
      const ms = intervalMs(iv);
      if (t % ms !== 0 && !(iv === '1d' && t % DAY === 0)) continue;
      const n = Math.floor((end - t) / ms);
      if (n <= 0) continue;
      const s = await this.store.get('klines', this.spec.market, this.spec.symbol, iv, t, t + n * ms);
      for (let i = 0; i < s.length; i++) {
        const b = s.bar(i);
        if (!bar) bar = { ...b, t: start };
        else mergeInto(bar, b);
      }
      t += n * ms;
      if (t >= end) break;
    }
    return bar;
  }

  private rebuildOut(): void {
    const src = this.agg!.series;
    if (this.spec.chartType === 'heikinashi') {
      this.out = heikinAshi(src);
    } else if (this.spec.chartType === 'renko') {
      const tick = SYMBOL_SPECS[this.spec.symbol][this.spec.market].tickSize;
      const closed = src.slice(0, Math.max(0, src.length - 1));
      const box = renkoBoxSize(closed.length ? closed : src, { ...this.spec.renko, tick });
      this.info.renkoBox = box;
      this.renkoState = newRenkoState(box);
      this.out = new CandleSeries(256);
      const mode = this.spec.renko?.source || 'close';
      for (let i = 0; i < src.length - 1; i++) renkoStep(this.renkoState, src, i, this.out, mode);
      this.renkoFed = Math.max(0, src.length - 1);
      this.renkoCommittedLen = this.out.length;
      this.applyRenkoProvisional();
    } else {
      this.out = src;
    }
  }

  private applyRenkoProvisional(): void {
    const src = this.agg!.series;
    this.out.truncate(this.renkoCommittedLen);
    if (src.length > this.renkoFed && this.renkoState) {
      const st = cloneRenkoState(this.renkoState);
      renkoStep(st, src, src.length - 1, this.out, this.spec.renko?.source || 'close');
    }
  }

  private onUpdates(ups: { index: number; isNew: boolean }[]): void {
    if (!ups.length || !this.agg) return;
    const src = this.agg.series;
    this.lastPrice = this.agg.lastPrice();
    let first = Math.min(...ups.map((u) => u.index));
    if (this.spec.chartType === 'heikinashi') {
      if (this.out.length > src.length || first > this.out.length) {
        this.rebuildOut();
        first = 0;
      } else {
        for (let i = first; i < src.length; i++) {
          const b = heikinAshiBar(src, i, this.out);
          if (i < this.out.length) this.out.setBar(i, b);
          else this.out.pushBar(b);
        }
      }
    } else if (this.spec.chartType === 'renko') {
      const prevLen = this.out.length;
      // feed newly closed source bars into the committed state
      while (this.renkoFed < src.length - 1 && this.renkoState) {
        this.out.truncate(this.renkoCommittedLen);
        renkoStep(this.renkoState, src, this.renkoFed, this.out, this.spec.renko?.source || 'close');
        this.renkoFed++;
        this.renkoCommittedLen = this.out.length;
      }
      const committedBefore = Math.min(prevLen, this.renkoCommittedLen);
      this.applyRenkoProvisional();
      first = Math.min(committedBefore, prevLen, this.out.length);
    }
    const len = this.out.length;
    first = Math.max(0, Math.min(first, len));
    this.emit({ key: this.key, index: first, packed: this.out.pack(first, len), length: len, status: this.status, lastPrice: this.lastPrice });
  }

  private emit(u: SeriesUpdate): void {
    for (const l of this.listeners) l(u);
  }

  subscribe(cb: (u: SeriesUpdate) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  snapshot(maxBars = 0): SeriesSnapshot {
    const len = this.out.length;
    const from = maxBars > 0 ? Math.max(0, len - maxBars) : 0;
    return { key: this.key, packed: this.out.pack(from, len), status: this.status, info: this.info, hasMore: this.hasMore || from > 0 };
  }

  /** Load `count` older bars. Emits a reset so clients refetch. Returns false when no more data. */
  async loadMore(count: number): Promise<boolean> {
    await this.ready;
    if (!this.agg || !this.histInterval) return false;
    const src = this.agg.series;
    if (!src.length) return false;
    const firstT = src.t[0];
    const from = timeForBarsBack(this.tf, firstT, count);
    const hist = await this.store.get('klines', this.spec.market, this.spec.symbol, this.histInterval, from, firstT);
    if (!hist.length) {
      this.hasMore = false;
      return false;
    }
    const histTf = parseTimeframe(this.histInterval.replace('d', 'D').replace('w', 'W'))!;
    const older = sameTf(histTf, this.tf) ? hist : aggregate(hist, this.tf);
    const lb = older.lowerBound(firstT);
    this.agg.series = older.slice(0, lb).merge(src);
    this.rebuildOut();
    this.emit({ key: this.key, index: 0, packed: new Float64Array(0), length: this.out.length, reset: true, status: this.status });
    return true;
  }

  /** Number of closed bars at server time `now`; the rest is the forming bar (or provisional Renko bricks). */
  closedLength(now: number): number {
    if (this.spec.chartType === 'renko') return Math.min(this.renkoCommittedLen, this.out.length);
    let n = this.out.length;
    while (n > 0 && bucketEnd(this.tf, this.out.t[n - 1]) > now) n--;
    return n;
  }

  /** Full underlying OHLC (not transformed) series — used by scripts. */
  source(): CandleSeries {
    return this.agg ? this.agg.series : new CandleSeries(1);
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.feed.release();
    this.listeners.clear();
  }
}

function sameTf(a: Timeframe, b: Timeframe): boolean {
  return a.n === b.n && a.unit === b.unit;
}

export class SeriesService {
  private map = new Map<string, ManagedSeries | MetricSeries>();
  private disposeTimers = new Map<string, NodeJS.Timeout>();
  private pollers = new Map<string, MetricPoller>();

  constructor(
    private hub: MarketHub,
    private store: CandleStore,
    private log: Logger,
    private funding: FundingCache,
  ) {}

  defaultBars(spec: SeriesSpec): number {
    const tf = parseTimeframe(spec.tf);
    if (!tf) return 1000;
    const ms = tfDurationMs(tf);
    if (ms < MIN) return 900;
    if (ms < HOUR) return 2000;
    return 2000;
  }

  /** Raw samples of a futures statistic: the 5-minute statistics cache or the funding history. */
  private metricLoader(symbol: SymbolId, metric: MetricKind, onProgress?: (p: { done: number; total: number; phase: string }) => void): MetricLoader {
    if (METRICS[metric].source === 'funding')
      return async (from, to) => {
        const f = await this.funding.get(symbol, from, to - 1);
        return fundingSamples(f.t, f.rate);
      };
    return (from, to) => this.store.get('metrics', 'futures', symbol, '5m', from, to, onProgress);
  }

  /**
   * The live clock of futures statistics or funding rates: one poller per symbol and source while
   * series use it. Statistics are polled every 30 s and become usable at 5-minute marks; funding
   * settles on the hour, so it is polled just after every hour (and every 5 minutes).
   */
  private metricClock(symbol: SymbolId, metric: MetricKind): MetricClock {
    const source = METRICS[metric].source;
    const key = `${symbol}:${source}`;
    let p = this.pollers.get(key);
    if (!p) {
      const rest = this.hub.rest;
      const now = () => this.hub.clock.now();
      p =
        source === 'funding'
          ? new MetricPoller({
              name: `${symbol} funding rates`,
              fetch: async (t) => {
                const rows = await rest.fundingRates(symbol, t - 2 * 86_400_000, t + 60_000, 100);
                return fundingSamples(
                  rows.map((r) => r.t),
                  rows.map((r) => r.rate),
                );
              },
              now,
              log: this.log,
              pollMs: 5 * 60_000,
              markMs: 3_600_000,
              markOffsetMs: 5_000,
              pollAtMark: true,
            })
          : new MetricPoller({ name: `${symbol} futures statistics`, fetch: (t) => rest.futuresStats(symbol, t - 45 * 60_000, t + 60_000), now, log: this.log, pollMs: 30_000, markMs: METRIC_STEP, markOffsetMs: 250, pollAtMark: false });
      this.pollers.set(key, p);
    }
    const poller = p;
    poller.refs++;
    let released = false;
    return {
      kind: 'live',
      now: () => this.hub.clock.now(),
      ready: () => poller.first,
      recent: () => poller.samples,
      listen: (cb) => poller.listen(cb),
      status: () => (poller.ok ? 'live' : 'degraded'),
      release: () => {
        if (released) return;
        released = true;
        if (--poller.refs > 0) return;
        poller.stop();
        if (this.pollers.get(key) === poller) this.pollers.delete(key);
      },
    };
  }

  /** Acquire a shared series (ref counted). Call `release` when done. */
  acquire(spec: SeriesSpec, opts: { feed?: SeriesFeed; keySuffix?: string; bars?: number } = {}): { series: SeriesHandle; release: () => void } {
    const key = seriesKey(spec) + (opts.keySuffix || '');
    let s = this.map.get(key);
    if (s && s.status === 'error') {
      s.dispose();
      this.map.delete(key);
      s = undefined;
    }
    if (!s) {
      const bars = opts.bars || this.defaultBars(spec);
      if (spec.metric) {
        const clock = opts.feed ? replayMetricClock(opts.feed) : this.metricClock(spec.symbol, spec.metric);
        s = new MetricSeries(spec, clock, this.metricLoader(spec.symbol, spec.metric), this.log, bars, opts.keySuffix || '');
      } else {
        const feed = opts.feed || liveFeed(this.hub, spec);
        s = new ManagedSeries(spec, feed, this.store, this.log, bars, opts.keySuffix || '');
      }
      this.map.set(key, s);
    } else if (opts.feed) {
      opts.feed.release();
    }
    const t = this.disposeTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.disposeTimers.delete(key);
    }
    s.refs++;
    const series = s;
    let released = false;
    return {
      series,
      release: () => {
        if (released) return;
        released = true;
        series.refs--;
        if (series.refs <= 0) {
          const linger = (opts.keySuffix || '').includes('replay') ? 1000 : 60000;
          this.disposeTimers.set(
            key,
            setTimeout(() => {
              if (series.refs <= 0) {
                series.dispose();
                this.map.delete(key);
              }
              this.disposeTimers.delete(key);
            }, linger),
          );
        }
      },
    };
  }

  get(key: string): SeriesHandle | undefined {
    return this.map.get(key);
  }

  /** Drop all series bound to a key suffix (e.g. a replay session). */
  disposeSuffix(suffix: string): void {
    for (const [k, s] of this.map) {
      if (k.endsWith(suffix)) {
        s.dispose();
        this.map.delete(k);
      }
    }
  }

  /** Historical candles for analysis (backtests): closed bars only, from the cache. */
  async history(spec: Pick<SeriesSpec, 'symbol' | 'market' | 'tf'>, from: number, to: number, onProgress?: (p: { done: number; total: number; phase: string }) => void): Promise<CandleSeries> {
    const tf = parseTimeframe(spec.tf);
    if (!tf) throw new Error(`Invalid timeframe ${spec.tf}`);
    const iv = baseIntervalFor(tf, spec.market);
    if (!iv) throw new Error(`${spec.tf} cannot be built from Binance klines on ${spec.market}`);
    const a = bucketStart(tf, from);
    const b = Math.min(to, this.hub.clock.now());
    const raw = await this.store.get('klines', spec.market, spec.symbol, iv, a, b, onProgress);
    const histTf = parseTimeframe(iv.replace('d', 'D').replace('w', 'W'))!;
    let s = sameTf(histTf, tf) ? raw : aggregate(raw, tf);
    // drop a trailing incomplete bucket
    if (s.length && bucketEnd(tf, s.t[s.length - 1]) > b) s = s.slice(0, s.length - 1);
    return s;
  }

  /** Futures statistics / funding bars for analysis (backtests): closed bars of the samples usable by `to`. */
  async metricHistory(spec: { symbol: SymbolId; tf: string; metric: MetricKind }, from: number, to: number, onProgress?: (p: { done: number; total: number; phase: string }) => void): Promise<CandleSeries> {
    const tf = parseTimeframe(spec.tf);
    if (!tf) throw new Error(`Invalid timeframe ${spec.tf}`);
    const m = METRICS[spec.metric];
    const b = Math.min(to, this.hub.clock.now());
    const raw = await this.metricLoader(spec.symbol, spec.metric, onProgress)(Math.max(m.epoch, bucketStart(tf, from) - m.stepMs), b);
    let s = metricBars(raw, spec.metric, tf, b);
    if (s.length && bucketEnd(tf, s.t[s.length - 1]) > b) s = s.slice(0, s.length - 1);
    return s;
  }
}
