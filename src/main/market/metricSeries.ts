/**
 * Futures statistics (open interest, long/short ratios) as a shared bar series for scripts and
 * bots: cached 5-minute samples (CandleStore kind "metrics") plus the newest samples polled from
 * REST, folded into bars of the requested timeframe as they become usable (see shared/metrics).
 * In a replay the samples are revealed with the replay clock instead.
 */
import { CandleSeries } from '../../shared/candles';
import { METRICS, METRICS_EPOCH, METRIC_STEP, revealMetric, type MetricKind } from '../../shared/metrics';
import { seriesKey, type SeriesInfo, type SeriesSnapshot, type SeriesSpec, type SeriesStatus, type SeriesUpdate } from '../../shared/marketTypes';
import { bucketEnd, bucketStart, parseTimeframe, timeForBarsBack, type Timeframe } from '../../shared/timeframes';
import type { SymbolId } from '../../shared/symbols';
import type { BinanceRest } from '../binance/rest';
import type { CandleStore } from '../storage/candleStore';
import type { SeriesFeed } from './series';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const DAY = 86_400_000;
/** Days loaded before a series is ready; older history follows in the background. */
const QUICK_DAYS = 60;

/** Where a statistics series gets its time and its newest samples. */
export interface MetricClock {
  readonly kind: 'live' | 'replay';
  now(): number;
  ready(): Promise<void>;
  /** Samples newer than the cache (live). */
  recent(): CandleSeries | null;
  /** Called when time advances or new samples arrive. */
  listen(cb: () => void): () => void;
  status(): SeriesStatus;
  release(): void;
}

/** Polls the newest statistics of one symbol (every 30 s) and ticks at every 5-minute mark. */
export class MetricPoller {
  refs = 0;
  samples = new CandleSeries(16);
  ok = true;
  readonly first: Promise<void>;
  private listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private rest: Pick<BinanceRest, 'futuresStats'>,
    private now: () => number,
    readonly symbol: SymbolId,
    private log: Logger,
  ) {
    this.first = this.poll();
    this.timer = setInterval(() => void this.poll(), 30_000);
    this.scheduleTick();
  }

  private scheduleTick(): void {
    const now = this.now();
    // a sample becomes usable at a 5-minute mark: tick just after it
    const next = Math.floor(now / METRIC_STEP) * METRIC_STEP + METRIC_STEP + 250;
    this.tick = setTimeout(() => {
      this.notify();
      this.scheduleTick();
    }, next - now);
  }

  private async poll(): Promise<void> {
    try {
      const now = this.now();
      const s = await this.rest.futuresStats(this.symbol, now - 45 * 60_000, now + 60_000);
      const merged = this.samples.length ? this.samples.merge(s) : s;
      const cut = merged.lowerBound(now - 2 * DAY);
      this.samples = cut > 0 ? merged.slice(cut) : merged;
      if (!this.ok) this.log('info', `${this.symbol} futures statistics: polling recovered`);
      this.ok = true;
      this.notify();
    } catch (e) {
      if (this.ok) this.log('warn', `${this.symbol} futures statistics: ${(e as Error).message}`);
      this.ok = false;
    }
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  listen(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.tick) clearTimeout(this.tick);
    this.timer = this.tick = null;
    this.listeners.clear();
  }
}

/** The replay clock of a session (a futures kline feed of the same symbol paces it). */
export function replayMetricClock(feed: SeriesFeed): MetricClock {
  return {
    kind: 'replay',
    now: () => feed.watermark() + 1,
    ready: () => feed.ready(),
    recent: () => null,
    listen: (cb) => feed.listen({ onKline: () => cb() }),
    status: () => feed.status(),
    release: () => feed.release(),
  };
}

function sameSample(a: CandleSeries, i: number, b: CandleSeries, j: number): boolean {
  const eq = (x: number, y: number) => x === y || (x !== x && y !== y);
  return eq(a.o[i], b.o[j]) && eq(a.h[i], b.h[j]) && eq(a.l[i], b.l[j]) && eq(a.c[i], b.c[j]) && eq(a.v[i], b.v[j]);
}

export class MetricSeries {
  readonly key: string;
  readonly tf: Timeframe;
  readonly metric: MetricKind;
  status: SeriesStatus = 'loading';
  info: SeriesInfo;
  hasMore = true;
  refs = 0;
  ready: Promise<void>;
  /** Resolves when the older history (loaded after `ready`) is in as well. */
  complete: Promise<void>;
  lastPrice = NaN;
  private bars = new CandleSeries(16);
  private raw = new CandleSeries(16);
  private revealed = 0;
  private dirty = Infinity;
  private flushQueued = false;
  private listeners = new Set<(u: SeriesUpdate) => void>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  private inited = false;
  private loading: Promise<void> | null = null;
  /** Replay: samples are loaded up to here (ahead of the clock). */
  private loadedTo = 0;
  private gapTried = NaN;

  constructor(
    readonly spec: SeriesSpec,
    private clock: MetricClock,
    private store: CandleStore,
    private log: Logger,
    initialBars: number,
    keySuffix = '',
  ) {
    this.key = seriesKey(spec) + keySuffix;
    const tf = parseTimeframe(spec.tf);
    if (!tf) throw new Error(`Invalid timeframe "${spec.tf}"`);
    if (!spec.metric) throw new Error('Not a statistics series');
    this.tf = tf;
    this.metric = spec.metric;
    this.info = { key: this.key, baseInterval: '5m', construction: '' };
    let older: Promise<void> = Promise.resolve();
    this.ready = this.init(initialBars, (p) => (older = p)).catch((e) => {
      this.status = 'error';
      this.info.error = (e as Error).message;
      this.log('error', `series ${this.key}: ${(e as Error).message}`);
      this.emit({ key: this.key, index: 0, packed: new Float64Array(0), length: 0, reset: true, status: 'error' });
    });
    this.complete = this.ready.then(() => older);
  }

  /** Bars up to the clock; read lazily, so a reader right after a 5-minute mark sees the new sample. */
  get out(): CandleSeries {
    if (this.inited) this.reveal();
    return this.bars;
  }

  private async init(initialBars: number, background: (p: Promise<void>) => void): Promise<void> {
    if (this.spec.market !== 'futures') throw new Error('Futures statistics exist for perpetual futures only');
    await this.clock.ready();
    const now = this.clock.now();
    const from = Math.max(METRICS_EPOCH, timeForBarsBack(this.tf, bucketStart(this.tf, now), initialBars) - METRIC_STEP);
    const to = this.clock.kind === 'replay' ? now + 3 * DAY : now + METRIC_STEP;
    // the last two months first (one daily archive per day beyond Binance's 30-day REST window),
    // older history afterwards
    const quick = Math.max(from, Math.floor((now - QUICK_DAYS * DAY) / METRIC_STEP) * METRIC_STEP);
    this.raw = await this.store.get('metrics', 'futures', this.spec.symbol, '5m', quick, to);
    this.loadedTo = to;
    this.hasMore = from > METRICS_EPOCH;
    if (quick > from) background(this.loadOlder(from, quick));
    if (this.clock.kind === 'live') this.mergeRecent();
    this.rebuild();
    this.dirty = Infinity;
    this.status = this.clock.status();
    this.info.construction = `Binance futures statistics: ${METRICS[this.metric].title.toLowerCase()}, 5-minute samples${this.spec.tf === '5m' ? '' : ` aggregated to ${this.spec.tf}`}; a sample counts from the next 5-minute mark (Binance publishes it 2–3 minutes after measuring)${this.clock.kind === 'replay' ? '; replay clock' : ''}`;
    if (!this.raw.length && !this.clock.recent()?.length) this.info.construction += ' — no data for this range';
    this.inited = true;
    if (this.disposed) return;
    this.unlisten = this.clock.listen(() => this.onClock());
  }

  private onClock(): void {
    if (this.disposed) return;
    this.status = this.clock.status();
    if (this.clock.kind === 'replay') {
      this.extendReplay();
      this.reveal();
      return;
    }
    const rec = this.clock.recent();
    const last = this.raw.length ? this.raw.t[this.raw.length - 1] : NaN;
    // after a long sleep the polled window may not reach back to the cache: fill the gap first
    if (rec?.length && last === last && rec.t[0] > last + METRIC_STEP && this.gapTried !== rec.t[0]) {
      if (this.loading) return;
      this.gapTried = rec.t[0];
      this.loading = this.store.get('metrics', 'futures', this.spec.symbol, '5m', last + 1, rec.t[0]).then(
        (more) => {
          this.loading = null;
          if (this.disposed) return;
          if (more.length) this.raw = this.raw.merge(more);
          this.mergeRecent();
          this.rebuild();
        },
        (e) => {
          this.loading = null;
          this.log('warn', `series ${this.key}: ${(e as Error).message}`);
        },
      );
      return;
    }
    if (this.mergeRecent()) this.rebuild();
    else this.reveal();
  }

  /** Merge newly polled samples (or corrections of recent ones). True when anything changed. */
  private mergeRecent(): boolean {
    const rec = this.clock.recent();
    if (!rec?.length) return false;
    let changed = false;
    for (let i = rec.length - 1; i >= 0 && !changed; i--) {
      const j = this.raw.indexOfTime(rec.t[i]);
      if (j < 0 || !sameSample(this.raw, j, rec, i)) changed = true;
    }
    if (changed) this.raw = this.raw.length ? this.raw.merge(rec) : rec.clone();
    return changed;
  }

  /** Replay: keep the samples loaded three days ahead of the clock. */
  private extendReplay(): void {
    const now = this.clock.now();
    if (this.loading || now < this.loadedTo - DAY) return;
    const from = this.loadedTo;
    const to = from + 3 * DAY;
    this.loading = this.store.get('metrics', 'futures', this.spec.symbol, '5m', from, to).then(
      (more) => {
        this.loading = null;
        this.loadedTo = to;
        if (this.disposed || !more.length) return;
        const lb = more.lowerBound(this.raw.length ? this.raw.t[this.raw.length - 1] + 1 : -Infinity);
        if (lb < more.length) this.raw = this.raw.merge(more.slice(lb));
        this.reveal();
      },
      (e) => {
        this.loading = null;
        this.loadedTo = to;
        this.log('warn', `series ${this.key}: ${(e as Error).message}`);
      },
    );
  }

  /** Fold samples that became usable into the bars. */
  private reveal(): void {
    const n0 = this.bars.length;
    const r = revealMetric(this.raw, this.metric, this.tf, this.bars, this.revealed, this.clock.now());
    this.revealed = r.next;
    if (r.first < this.bars.length || this.bars.length !== n0) this.markDirty(r.first);
  }

  /** Recompute all bars (the samples changed) and mark what differs. */
  private rebuild(): void {
    const prev = this.bars;
    const next = new CandleSeries(Math.max(16, prev.length + 8));
    this.revealed = revealMetric(this.raw, this.metric, this.tf, next, 0, this.clock.now()).next;
    const n = Math.min(prev.length, next.length);
    let i = 0;
    while (i < n && prev.t[i] === next.t[i] && prev.o[i] === next.o[i] && prev.h[i] === next.h[i] && prev.l[i] === next.l[i] && prev.c[i] === next.c[i]) i++;
    this.bars = next;
    if (i < next.length || next.length !== prev.length) this.markDirty(i);
  }

  private markDirty(from: number): void {
    this.dirty = Math.min(this.dirty, from);
    if (this.bars.length) this.lastPrice = this.bars.c[this.bars.length - 1];
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.dirty === Infinity || this.disposed) return;
    const len = this.bars.length;
    const from = Math.max(0, Math.min(this.dirty, len));
    this.dirty = Infinity;
    this.emit({ key: this.key, index: from, packed: this.bars.pack(from, len), length: len, status: this.status, lastPrice: this.lastPrice });
  }

  private emit(u: SeriesUpdate): void {
    for (const l of this.listeners) l(u);
  }

  subscribe(cb: (u: SeriesUpdate) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  snapshot(maxBars = 0): SeriesSnapshot {
    const out = this.out;
    const len = out.length;
    const from = maxBars > 0 ? Math.max(0, len - maxBars) : 0;
    return { key: this.key, packed: out.pack(from, len), status: this.status, info: this.info, hasMore: this.hasMore || from > 0 };
  }

  /** History before the first load; merged in with a reset so clients refetch. */
  private async loadOlder(from: number, to: number): Promise<void> {
    try {
      const older = await this.store.get('metrics', 'futures', this.spec.symbol, '5m', from, to);
      if (this.disposed || !older.length) return;
      this.raw = older.merge(this.raw);
      this.rebuild();
      this.dirty = Infinity;
      this.emit({ key: this.key, index: 0, packed: new Float64Array(0), length: this.bars.length, reset: true, status: this.status });
    } catch (e) {
      this.log('warn', `series ${this.key}: older history unavailable (${(e as Error).message})`);
    }
  }

  /** Load samples for `count` older bars. Emits a reset so clients refetch. */
  async loadMore(count: number): Promise<boolean> {
    await this.ready;
    if (!this.hasMore || this.status === 'error') return false;
    const firstT = this.raw.length ? this.raw.t[0] : this.clock.now();
    const from = Math.max(METRICS_EPOCH, timeForBarsBack(this.tf, bucketStart(this.tf, firstT), count) - METRIC_STEP);
    if (from >= firstT) {
      this.hasMore = false;
      return false;
    }
    const older = await this.store.get('metrics', 'futures', this.spec.symbol, '5m', from, firstT);
    this.hasMore = from > METRICS_EPOCH;
    if (!older.length) return false;
    this.raw = older.merge(this.raw);
    this.rebuild();
    this.dirty = Infinity;
    this.emit({ key: this.key, index: 0, packed: new Float64Array(0), length: this.bars.length, reset: true, status: this.status });
    return true;
  }

  /** Number of closed bars at `now`; the rest is the forming bar. */
  closedLength(now: number): number {
    const out = this.out;
    let n = out.length;
    while (n > 0 && bucketEnd(this.tf, out.t[n - 1]) > now) n--;
    return n;
  }

  source(): CandleSeries {
    return this.out;
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.clock.release();
    this.listeners.clear();
  }
}
