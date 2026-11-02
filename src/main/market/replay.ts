/**
 * Market replay — TradingView-style bar replay with paper trading.
 *
 * One session per window; every chart of the window follows the session's replay clock (cursor).
 *  - Data is revealed strictly before the cursor. Replay series are built from the local cache up
 *    to the cursor and then fed closed klines at the session's update interval as the cursor
 *    advances, through the same LiveAggregator path as live data. Charts, indicators,
 *    request.security and replay trading all read these feeds, so nothing beyond the cursor is
 *    ever loaded into a series or a script.
 *  - Real data at its real resolution: klines of the update interval (1s on spot, 1m on futures
 *    at the finest), never invented ticks. The interval adapts to the speed (and must divide every
 *    replayed timeframe) so fast playback stays light.
 *  - Replay paper accounts are matched on the replayed klines (OHLC path within each kline — with
 *    1s klines this is close to tick resolution). Futures accounts use Binance mark-price klines
 *    for liquidation checks and historical funding rates.
 */
import type { AppCore } from '../core';
import type { TradingEngine } from '../trading/engine';
import type { SeriesFeed } from './series';
import type { TapeListener } from './tape';
import type { BaseKline } from '../../shared/live';
import type { SeriesSpec } from '../../shared/marketTypes';
import type { MarketCtx } from '../../shared/trading/account';
import { CandleSeries } from '../../shared/candles';
import { barPath } from '../../shared/trading/matching';
import { parseTimeframe, tfDurationMs, intervalMs, bucketStart, bucketEnd, type Timeframe } from '../../shared/timeframes';
import { SYMBOL_SPECS, isSymbol, floorToStep, type Market, type SymbolId } from '../../shared/symbols';
import type { FundingCache } from './funding';
import { uid } from '../storage/jsonStore';
import { buildReplayReport, type ReplayReport, type ReplayReportInput } from './replayReport';

export interface ReplayRef {
  session: string;
  epoch: number;
}

export interface ReplayView {
  id: string;
  windowId: string;
  start: number;
  cursor: number;
  playing: boolean;
  /** Market milliseconds per wall-clock millisecond (1 = real time). */
  speed: number;
  /** 'auto' or a fixed update interval. */
  resolution: string;
  /** Interval klines are revealed at right now. */
  interval: string;
  intervals: string[];
  epoch: number;
  /** Latest replayable time (closed data). */
  end: number;
  status: 'loading' | 'ready' | 'ended';
  message?: string;
  owner?: string;
  accounts: Partial<Record<Market, string>>;
  /** Latest revealed close per "market:SYMBOL". */
  prices: Record<string, number>;
}

const INTERVALS = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];
const TICK_MS = 100;
const RECENT = 6000;
/** Klines revealed per wall-clock second at most (auto interval). */
const MAX_RATE = 120;

class Track {
  interval: string;
  ms: number;
  /** Every kline with open time < emittedTo has been revealed. */
  emittedTo: number;
  private buf = new CandleSeries(64);
  private pos = 0;
  loadedTo: number;
  private loading: Promise<void> | null = null;
  private nextInterval: string | null = null;
  recent: BaseKline[] = [];
  listeners = new Set<TapeListener>();
  last = NaN;
  // futures mark-price klines (1m)
  private mark = new CandleSeries(16);
  private markPos = 0;
  private markLoadedTo: number;
  markEmittedTo: number;
  lastMark = NaN;
  error: string | null = null;

  constructor(
    private s: ReplaySession,
    readonly market: Market,
    readonly symbol: SymbolId,
    interval: string,
  ) {
    this.interval = interval;
    this.ms = intervalMs(interval);
    this.emittedTo = Math.floor(s.cursor / this.ms) * this.ms;
    this.loadedTo = this.emittedTo;
    this.markEmittedTo = Math.floor(s.cursor / 60000) * 60000;
    this.markLoadedTo = this.markEmittedTo;
  }

  get key(): string {
    return `${this.market}:${this.symbol}`;
  }

  /** Switch the update interval at the next kline boundary both intervals share. */
  setInterval(iv: string): void {
    if (iv === this.interval) {
      this.nextInterval = null;
      return;
    }
    this.nextInterval = iv;
    this.trySwitch();
  }

  /** Switch now to an interval that divides the current one (always aligned). */
  forceInterval(iv: string): void {
    const ms = intervalMs(iv);
    if (iv === this.interval || this.emittedTo % ms !== 0) return;
    this.nextInterval = null;
    this.interval = iv;
    this.ms = ms;
    this.buf = new CandleSeries(64);
    this.pos = 0;
    this.loadedTo = this.emittedTo;
  }

  private trySwitch(): void {
    const iv = this.nextInterval;
    if (!iv) return;
    const ms = intervalMs(iv);
    if (this.emittedTo % ms !== 0) return;
    this.interval = iv;
    this.ms = ms;
    this.nextInterval = null;
    this.buf = new CandleSeries(64);
    this.pos = 0;
    this.loadedTo = this.emittedTo;
  }

  /** Load klines (and mark klines for futures) so that everything before `until` is available. */
  ensure(until: number): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loadedTo >= until && (this.market !== 'futures' || this.markLoadedTo >= Math.min(until, this.s.end))) return Promise.resolve();
    this.loading = (async () => {
      try {
        const look = Math.max(this.ms * 600, this.s.speed * 60000);
        if (this.loadedTo < until) {
          const to = Math.min(this.s.end, Math.max(until, this.loadedTo + look));
          if (to > this.loadedTo) {
            const iv = this.interval;
            const from = this.loadedTo;
            const chunk = await this.s.core.store.get('klines', this.market, this.symbol, iv, from, to);
            if (iv === this.interval && from === this.loadedTo) {
              this.append(chunk);
              this.loadedTo = to;
            }
          }
        }
        if (this.market === 'futures' && this.markLoadedTo < Math.min(until, this.s.end)) {
          const to = Math.min(this.s.end, Math.max(until, this.markLoadedTo + Math.max(600 * 60000, this.s.speed * 60000)));
          const from = this.markLoadedTo;
          try {
            const m = await this.s.core.store.get('mark', 'futures', this.symbol, '1m', from, to);
            this.appendMark(m);
          } catch {
            /* mark klines unavailable: last price stands in */
          }
          this.markLoadedTo = to;
        }
        this.error = null;
      } catch (e) {
        this.error = (e as Error).message;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private append(c: CandleSeries): void {
    // drop revealed klines to keep memory bounded
    if (this.pos > 20000) {
      this.buf = this.buf.slice(this.pos, this.buf.length);
      this.pos = 0;
    }
    for (let i = 0; i < c.length; i++) if (c.t[i] >= this.emittedTo && (!this.buf.length || c.t[i] > this.buf.t[this.buf.length - 1])) this.buf.pushBar(c.bar(i));
  }

  private appendMark(c: CandleSeries): void {
    if (this.markPos > 20000) {
      this.mark = this.mark.slice(this.markPos, this.mark.length);
      this.markPos = 0;
    }
    for (let i = 0; i < c.length; i++) if (!this.mark.length || c.t[i] > this.mark.t[this.mark.length - 1]) this.mark.pushBar(c.bar(i));
  }

  /** Reveal every kline that closes at or before `cursor`. */
  emitUpTo(cursor: number, out: (BaseKline & { market: Market; symbol: SymbolId })[]): void {
    for (;;) {
      const b = this.buf;
      if (this.pos >= b.length) {
        // no data in this stretch (exchange outage): move on with the clock
        const lim = Math.min(cursor, this.loadedTo);
        if (lim - this.emittedTo >= this.ms) this.emittedTo = Math.floor(lim / this.ms) * this.ms;
        this.trySwitch();
        return;
      }
      const t = b.t[this.pos];
      if (t + this.ms > cursor) return;
      const k: BaseKline = { t, T: t + this.ms - 1, o: b.o[this.pos], h: b.h[this.pos], l: b.l[this.pos], c: b.c[this.pos], v: b.v[this.pos], qv: b.qv[this.pos], n: b.n[this.pos], tbv: b.tbv[this.pos] };
      this.pos++;
      this.emittedTo = t + this.ms;
      this.last = k.c;
      this.recent.push(k);
      if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
      for (const l of this.listeners) l.onKline?.(k);
      out.push({ ...k, market: this.market, symbol: this.symbol });
      this.trySwitch();
    }
  }

  /** Mark-price klines closed by `cursor`. */
  markUpTo(cursor: number): { t: number; o: number; h: number; l: number; c: number }[] {
    const out: { t: number; o: number; h: number; l: number; c: number }[] = [];
    while (this.markPos < this.mark.length && this.mark.t[this.markPos] + 60000 <= cursor) {
      const i = this.markPos++;
      out.push({ t: this.mark.t[i], o: this.mark.o[i], h: this.mark.h[i], l: this.mark.l[i], c: this.mark.c[i] });
      this.lastMark = this.mark.c[i];
      this.markEmittedTo = this.mark.t[i] + 60000;
    }
    return out;
  }
}

class ReplayFeed implements SeriesFeed {
  readonly kind = 'replay' as const;
  readonly baseInterval: string;
  constructor(
    private s: ReplaySession,
    readonly track: Track,
    readonly tf: Timeframe,
  ) {
    this.baseInterval = track.interval;
    s.feeds.add(this);
  }
  async ready(): Promise<void> {
    void this.track.ensure(this.s.cursor + this.track.ms * 300);
  }
  watermark(): number {
    return this.track.emittedTo - 1;
  }
  recentKlinesAfter(w: number): BaseKline[] {
    return this.track.recent.filter((k) => k.T > w);
  }
  pendingTrades() {
    return [];
  }
  listen(l: TapeListener): () => void {
    this.track.listeners.add(l);
    return () => this.track.listeners.delete(l);
  }
  status() {
    return 'live' as const;
  }
  release(): void {
    this.s.feeds.delete(this);
    this.s.recomputeInterval();
  }
}

export class ReplaySession {
  readonly id = uid('rp');
  epoch = 0;
  playing = false;
  speed = 60;
  resolution = 'auto';
  interval = '1m';
  start: number;
  cursor: number;
  end: number;
  status: ReplayView['status'] = 'ready';
  message: string | undefined;
  readonly tracks = new Map<string, Track>();
  readonly feeds = new Set<ReplayFeed>();
  accounts: Partial<Record<Market, string>> = {};
  /** Where this replay's trading began per account (trade count, equity, fees) — for the session report. */
  marks: Partial<Record<Market, { tradeIdx: number; equity: number; fees: number }>> = {};
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private ctxTime = 0;
  private fundingCache = new Map<SymbolId, { t: Float64Array; rate: Float64Array; from: number; to: number }>();
  private lastPush = 0;

  constructor(
    readonly svc: ReplayService,
    readonly windowId: string,
    start: number,
    public owner: string | undefined,
  ) {
    this.start = start;
    this.cursor = start;
    this.end = svc.latest();
    this.ctxTime = start;
  }

  get core(): AppCore {
    return this.svc.core;
  }

  view(): ReplayView {
    const prices: Record<string, number> = {};
    for (const t of this.tracks.values()) if (isFinite(t.last)) prices[t.key] = t.last;
    return { id: this.id, windowId: this.windowId, start: this.start, cursor: this.cursor, playing: this.playing, speed: this.speed, resolution: this.resolution, interval: this.interval, intervals: this.validIntervals(), epoch: this.epoch, end: this.end, status: this.status, message: this.message, owner: this.owner, accounts: { ...this.accounts }, prices };
  }

  // ------------------------------------------------------------------ data

  track(market: Market, symbol: SymbolId): Track {
    const key = `${market}:${symbol}`;
    let t = this.tracks.get(key);
    if (!t) {
      t = new Track(this, market, symbol, this.intervalFor(market));
      this.tracks.set(key, t);
      void t.ensure(this.cursor + t.ms * 300);
      this.recomputeInterval();
    }
    return t;
  }

  private intervalFor(market: Market): string {
    return market === 'futures' && this.interval === '1s' ? '1m' : this.interval;
  }

  feed(spec: SeriesSpec): ReplayFeed {
    const tf = parseTimeframe(spec.tf);
    if (!tf) throw new Error(`Invalid timeframe ${spec.tf}`);
    // a timeframe the current interval does not divide: refine at once to an interval that divides
    // both (klines must nest in every replayed bar)
    const cur = intervalMs(this.interval);
    if (!fitsTf(cur, tf)) {
      const iv = [...INTERVALS].reverse().find((x) => {
        const ms = intervalMs(x);
        return ms <= cur && cur % ms === 0 && fitsTf(ms, tf);
      });
      if (iv) {
        this.interval = iv;
        for (const t of this.tracks.values()) t.forceInterval(this.intervalFor(t.market));
      }
    }
    const f = new ReplayFeed(this, this.track(spec.market, spec.symbol), tf);
    this.recomputeInterval();
    return f;
  }

  /** Update intervals that divide every replayed timeframe (futures reveal 1m at the finest). */
  validIntervals(): string[] {
    const tfs = [...this.feeds].map((f) => f.tf);
    return INTERVALS.filter((iv) => tfs.every((tf) => fitsTf(intervalMs(iv), tf)));
  }

  recomputeInterval(): void {
    const valid = this.validIntervals();
    if (!valid.length) return;
    let iv: string;
    if (this.resolution !== 'auto' && valid.includes(this.resolution)) iv = this.resolution;
    else {
      // the finest interval that keeps the reveal rate light at this speed
      iv = valid.find((x) => intervalMs(x) * MAX_RATE >= this.speed * 1000) || valid[valid.length - 1];
    }
    if (iv === this.interval) return;
    this.interval = iv;
    for (const t of this.tracks.values()) t.setInterval(this.intervalFor(t.market));
    this.push(true);
  }

  // ------------------------------------------------------------------ clock

  setPlaying(on: boolean): void {
    if (on && this.cursor >= this.end - 1000) {
      this.message = 'The replay reached the present.';
      on = false;
    }
    this.playing = on;
    if (on) {
      this.status = 'ready';
      this.message = undefined;
      this.lastTick = Date.now();
      if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.push(true);
  }

  setSpeed(x: number): void {
    this.speed = Math.max(0.05, Math.min(5_000_000, x));
    this.recomputeInterval();
    this.push(true);
  }

  setResolution(r: string): void {
    this.resolution = r === 'auto' || INTERVALS.includes(r) ? r : 'auto';
    this.recomputeInterval();
    this.push(true);
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(1000, now - this.lastTick);
    this.lastTick = now;
    if (!this.playing) return;
    this.end = this.svc.latest();
    let target = this.cursor + dt * this.speed;
    let stalled = false;
    for (const t of this.tracks.values()) {
      const lookahead = t.ms * 300 + this.speed * 20000;
      if (t.loadedTo < target + lookahead) void t.ensure(target + lookahead);
      if (t.loadedTo < target) {
        target = Math.max(this.cursor, Math.min(target, t.loadedTo));
        stalled = true;
      }
      if (t.error) this.message = `Data: ${t.error}`;
    }
    if (target >= this.end) {
      target = this.end;
      this.advance(target);
      this.playing = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.status = 'ended';
      this.message = 'The replay reached the present.';
      this.push(true);
      return;
    }
    this.status = stalled ? 'loading' : 'ready';
    this.advance(target);
  }

  /** Step to the close of the next bar of `tf` (or by one update interval). */
  async step(tfStr?: string): Promise<void> {
    if (this.playing) this.setPlaying(false);
    const tf = tfStr ? parseTimeframe(tfStr) : null;
    let target: number;
    if (tf) {
      const b = bucketStart(tf, this.cursor);
      const e = bucketEnd(tf, b);
      target = e > this.cursor ? e : bucketEnd(tf, e);
    } else target = this.cursor + intervalMs(this.interval);
    target = Math.min(target, this.svc.latest());
    if (target <= this.cursor) {
      this.status = 'ended';
      this.message = 'The replay reached the present.';
      this.push(true);
      return;
    }
    this.status = 'loading';
    this.push(true);
    await this.load(target);
    this.status = 'ready';
    this.advance(target);
    this.push(true);
  }

  /** Wait until every track holds the data up to `target` (a load for a superseded interval is redone). */
  private async load(target: number): Promise<void> {
    await Promise.all(
      [...this.tracks.values()].map(async (t) => {
        for (let guard = 0; guard < 6 && t.loadedTo < target && !t.error; guard++) await t.ensure(target + t.ms * 300);
      }),
    );
  }

  /** Move the replay clock forward and reveal klines to series and replay accounts. */
  advance(target: number): void {
    const prev = this.cursor;
    if (target <= prev) return;
    this.cursor = target;
    const ks: (BaseKline & { market: Market; symbol: SymbolId })[] = [];
    for (const t of this.tracks.values()) t.emitUpTo(target, ks);
    this.trade(ks, prev, target);
    this.push(false);
  }

  // ------------------------------------------------------------------ replay accounts

  ctx(): MarketCtx {
    return {
      now: () => this.ctxTime || this.cursor,
      last: (market, symbol) => this.tracks.get(`${market}:${symbol}`)?.last || this.tracks.get(`${market === 'spot' ? 'futures' : 'spot'}:${symbol}`)?.last || NaN,
      mark: (symbol) => {
        const t = this.tracks.get(`futures:${symbol}`);
        return this.markOverride.get(symbol) ?? (t ? (isFinite(t.lastMark) ? t.lastMark : t.last) : NaN);
      },
    };
  }

  private markOverride = new Map<SymbolId, number>();

  private trade(ks: (BaseKline & { market: Market; symbol: SymbolId })[], prev: number, cursor: number): void {
    const eng = this.svc.engine;
    const accts = Object.values(this.accounts)
      .map((id) => (id ? eng.accounts.get(id) : undefined))
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (!accts.length) {
      for (const t of this.tracks.values()) if (t.market === 'futures') t.markUpTo(cursor);
      return;
    }
    const ctx = this.ctx();
    ks.sort((a, b) => a.t - b.t);
    for (const k of ks) {
      const ms = k.T + 1 - k.t;
      const p = barPath(k.o, k.h, k.l, k.c);
      for (const rt of accts) {
        if (rt.config.market !== k.market) continue;
        for (let i = 1; i < p.length; i++) {
          this.ctxTime = k.t + Math.round((i * ms) / (p.length - 1)) - 1;
          try {
            rt.onPrice(k.symbol, { from: p[i - 1], to: p[i], volume: k.v / 3, t: this.ctxTime }, ctx, 'path');
          } catch (e) {
            this.core.log('warn', `replay matching ${rt.config.id}: ${(e as Error).message}`);
          }
        }
      }
    }
    // futures: liquidation on mark-price extremes, funding
    for (const t of this.tracks.values()) {
      if (t.market !== 'futures') continue;
      const marks = t.markUpTo(cursor);
      for (const rt of accts) {
        if (rt.config.market !== 'futures') continue;
        const fee = SYMBOL_SPECS[t.symbol].futures.liquidationFeeRate;
        for (const m of marks) {
          this.ctxTime = m.t + 59999;
          const pos = rt.ledger.position(t.symbol);
          if (pos) {
            const snap = rt.snapshot(ctx).positions.find((x) => x.symbol === t.symbol);
            const liq = snap?.liqPrice || 0;
            if (liq > 0 && (pos.side === 1 ? m.l <= liq : m.h >= liq)) {
              this.markOverride.set(t.symbol, pos.side === 1 ? Math.min(liq, m.o) : Math.max(liq, m.o));
              rt.onMark(ctx, () => fee);
            }
          }
          this.markOverride.delete(t.symbol);
          rt.onMark(ctx, () => fee);
        }
      }
      void this.funding(t.symbol, prev, cursor, accts.filter((a) => a.config.market === 'futures' && a.ledger.position(t.symbol)));
    }
    this.ctxTime = cursor;
    const hourChanged = Math.floor(prev / 3600000) !== Math.floor(cursor / 3600000);
    for (const rt of accts) {
      try {
        if (rt.housekeeping(ctx, hourChanged)) rt.flattenAll(ctx, 'rule', 'prop rule');
      } catch (e) {
        this.core.log('warn', `replay housekeeping: ${(e as Error).message}`);
      }
    }
  }

  private async funding(symbol: SymbolId, from: number, to: number, accts: ReturnType<TradingEngine['accounts']['get']>[]): Promise<void> {
    if (!accts.length) return;
    let f = this.fundingCache.get(symbol);
    if (!f || from < f.from || to > f.to) {
      const a = from - 86400000;
      const b = Math.min(this.svc.latest(), to + 7 * 86400000);
      const r = await this.svc.fundingCache.get(symbol, a, b);
      f = { ...r, from: a, to: b };
      this.fundingCache.set(symbol, f);
    }
    for (let i = 0; i < f.t.length; i++) {
      const ft = f.t[i];
      if (ft <= from || ft > to) continue;
      const mark = this.ctx().mark(symbol);
      for (const rt of accts) if (rt && rt.ledger.position(symbol)) rt.onFunding(symbol, f.rate[i], mark, ft);
    }
  }

  // ------------------------------------------------------------------ jumps & lifecycle

  /** Close replay positions and orders at the last replay prices. */
  flattenAccounts(reason: string): void {
    const ctx = this.ctx();
    for (const id of Object.values(this.accounts)) {
      const rt = id ? this.svc.engine.accounts.get(id) : undefined;
      if (!rt || (!rt.ledger.positions.size && !rt.orders.length)) continue;
      try {
        rt.flattenAll(ctx, 'replay', reason);
      } catch {
        /* ignore */
      }
    }
  }

  /** Remember where the replay's trading starts on an account (for the session report). */
  markAccount(market: Market): void {
    const id = this.accounts[market];
    const rt = id ? this.svc.engine.accounts.get(id) : undefined;
    if (!rt) return;
    this.marks[market] = { tradeIdx: rt.trades.length, equity: rt.ledger.equity(rt.marks(this.ctx())) || rt.ledger.wallet, fees: rt.ledger.feesPaid };
  }

  /** Restart from another point in time: series are rebuilt, open replay positions are closed. */
  jump(start: number): void {
    if (this.playing) this.setPlaying(false);
    this.flattenAccounts('replay restarted at another point');
    for (const m of Object.keys(this.accounts) as Market[]) this.markAccount(m);
    for (const t of this.tracks.values()) t.listeners.clear();
    this.tracks.clear();
    this.feeds.clear();
    this.fundingCache.clear();
    this.start = start;
    this.cursor = start;
    this.ctxTime = start;
    this.end = this.svc.latest();
    this.epoch++;
    this.status = 'ready';
    this.message = undefined;
    this.push(true);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    for (const t of this.tracks.values()) t.listeners.clear();
    this.tracks.clear();
    this.feeds.clear();
  }

  push(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPush < 150) return;
    this.lastPush = now;
    this.svc.changed(this);
  }
}

export class ReplayService {
  private sessions = new Map<string, ReplaySession>();
  private listeners = new Set<(s: ReplaySession | null, windowId: string) => void>();
  readonly fundingCache: FundingCache;

  constructor(
    readonly core: AppCore,
    readonly engine: TradingEngine,
  ) {
    this.fundingCache = core.funding;
    engine.replayCtx = (id) => {
      for (const s of this.sessions.values()) if (Object.values(s.accounts).includes(id)) return s.ctx();
      return null;
    };
    core.replayAcquire = (spec, ref) => this.acquire(spec, ref);
    core.replayClock = (ref) => {
      const s = this.bySession(ref.session);
      return s && s.epoch === ref.epoch ? s.cursor : NaN;
    };
  }

  /** Latest replayable time: closed data only. */
  latest(): number {
    return this.core.hub.clock.now() - 2000;
  }

  bySession(id: string): ReplaySession | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return s;
    return undefined;
  }

  forWindow(windowId: string): ReplaySession | undefined {
    return this.sessions.get(windowId);
  }

  changed(s: ReplaySession): void {
    for (const l of this.listeners) l(s, s.windowId);
  }

  onChange(l: (s: ReplaySession | null, windowId: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** A replay series (cached per session epoch). */
  acquire(spec: SeriesSpec, ref: ReplayRef) {
    const s = this.bySession(ref.session);
    if (!s) throw new Error('Replay session ended');
    if (ref.epoch !== s.epoch) throw new Error('Replay restarted');
    if (!isSymbol(spec.symbol)) throw new Error('Validation: unsupported symbol');
    const feed = s.feed(spec);
    return this.core.series.acquire(spec, { feed, keySuffix: `|replay:${s.id}:${s.epoch}` });
  }

  start(windowId: string, start: number, owner?: string): ReplaySession {
    const latest = this.latest();
    if (!(start > Date.UTC(2017, 6, 1)) || start >= latest) throw new Error('Validation: choose a point in the past');
    let s = this.sessions.get(windowId);
    if (s) {
      s.owner = owner || s.owner;
      s.jump(start);
      return s;
    }
    s = new ReplaySession(this, windowId, start, owner);
    this.sessions.set(windowId, s);
    this.changed(s);
    return s;
  }

  stopAll(): void {
    for (const w of [...this.sessions.keys()]) this.stop(w);
  }

  stop(windowId: string): void {
    const s = this.sessions.get(windowId);
    if (!s) return;
    s.flattenAccounts('replay ended');
    s.dispose();
    this.sessions.delete(windowId);
    for (const l of this.listeners) l(null, windowId);
  }

  /** The session report of a window's replay (from its start or last jump to the cursor). */
  async report(windowId: string): Promise<ReplayReport | null> {
    const s = this.sessions.get(windowId);
    if (!s) return null;
    const ctx = s.ctx();
    const accounts: ReplayReportInput['accounts'] = [];
    for (const market of Object.keys(s.accounts) as Market[]) {
      const id = s.accounts[market];
      const rt = id ? this.engine.accounts.get(id) : undefined;
      const m = s.marks[market];
      if (!rt || !m) continue;
      const c = rt.config.costs;
      accounts.push({ market, trades: rt.trades.slice(m.tradeIdx), equityStart: m.equity, equityEnd: rt.ledger.equity(rt.marks(ctx)), feesPaid: rt.ledger.feesPaid - m.fees, costPerSide: c.takerFee + (c.slippage.model === 'fixedBps' ? c.slippage.bps / 1e4 : c.slippage.model === 'book' ? 1 / 1e4 : 0) });
    }
    return buildReplayReport(this.core, { from: s.start, to: s.cursor, accounts });
  }

  /** End a replay: close its positions, report on the session, then stop. */
  async finish(windowId: string): Promise<ReplayReport | null> {
    const s = this.sessions.get(windowId);
    if (!s) return null;
    s.flattenAccounts('replay ended');
    let rep: ReplayReport | null = null;
    try {
      rep = await this.report(windowId);
    } catch (e) {
      this.core.log('warn', `replay report: ${(e as Error).message}`);
    }
    this.stop(windowId);
    return rep;
  }

  /** The window's replay paper account for a market (created on first use). */
  async account(windowId: string, market: Market): Promise<string> {
    const s = this.sessions.get(windowId);
    if (!s) throw new Error('Validation: no replay running in this window');
    const existing = s.accounts[market];
    if (existing && this.engine.accounts.has(existing)) {
      if (!s.marks[market]) s.markAccount(market);
      return existing;
    }
    // reuse the window's replay account from earlier sessions
    for (const rt of this.engine.accounts.values()) {
      if (rt.config.replay && rt.config.market === market && rt.config.name === replayAccountName(windowId, market)) {
        s.accounts[market] = rt.config.id;
        s.markAccount(market);
        s.push(true);
        return rt.config.id;
      }
    }
    const cfg = await this.engine.create({ name: replayAccountName(windowId, market), kind: 'manual', market, initialBalance: 10000, costPreset: market === 'futures' ? 'binance-futures' : 'binance-spot', futures: { defaultLeverage: 10 }, replay: true });
    s.accounts[market] = cfg.id;
    s.markAccount(market);
    s.push(true);
    return cfg.id;
  }
}

/** Klines of `ms` nest in every bar of `tf`. */
function fitsTf(ms: number, tf: Timeframe): boolean {
  if (tf.unit === 'W' || tf.unit === 'M') return ms <= 86400000;
  const d = tfDurationMs(tf);
  return d >= ms && d % ms === 0;
}

function replayAccountName(windowId: string, market: Market): string {
  return `Replay · ${market === 'futures' ? 'futures' : 'spot'}${windowId === 'main' ? '' : ` · ${windowId}`}`;
}

export function registerReplay(core: AppCore, engine: TradingEngine): ReplayService {
  const svc = new ReplayService(core, engine);
  const r = core.router;
  r.handle('replay:start', ([p], ctx) => svc.start(ctx.windowId, Number(p?.start), p?.owner).view());
  r.handle('replay:report', (_a, ctx) => svc.report(ctx.windowId));
  r.handle('replay:finish', (_a, ctx) => svc.finish(ctx.windowId));
  r.handle('replay:stop', (_a, ctx) => {
    svc.stop(ctx.windowId);
    return true;
  });
  r.handle('replay:cmd', async ([p], ctx) => {
    const s = svc.forWindow(ctx.windowId);
    if (!s) throw new Error('Validation: no replay running in this window');
    switch (p?.cmd) {
      case 'play':
        s.setPlaying(true);
        break;
      case 'pause':
        s.setPlaying(false);
        break;
      case 'toggle':
        s.setPlaying(!s.playing);
        break;
      case 'step':
        await s.step(p.tf);
        break;
      case 'speed':
        s.setSpeed(Number(p.value));
        break;
      case 'resolution':
        s.setResolution(String(p.value));
        break;
      case 'jump':
        svc.start(ctx.windowId, Number(p.value), p.owner);
        break;
      default:
        throw new Error(`Validation: unknown replay command ${p?.cmd}`);
    }
    return s.view();
  });
  r.handle('replay:account', ([market], ctx) => svc.account(ctx.windowId, market === 'futures' ? 'futures' : 'spot'));
  /** Quick replay trade sized in USDT at the replay price. */
  r.handle('replay:trade', async ([p], ctx) => {
    const s = svc.forWindow(ctx.windowId);
    if (!s) throw new Error('Validation: no replay running in this window');
    const market: Market = p?.market === 'futures' ? 'futures' : 'spot';
    if (!isSymbol(p?.symbol)) throw new Error('Validation: unsupported symbol');
    const symbol = p.symbol as SymbolId;
    const id = await svc.account(ctx.windowId, market);
    const last = s.ctx().last(market, symbol);
    if (!(last > 0)) throw new Error('Validation: no replay price yet — press play or step forward first');
    const qty = floorToStep(Math.max(0, +p.usd || 0) / last, SYMBOL_SPECS[symbol][market].stepSize);
    return engine.place(id, { symbol, side: p.side === 'sell' ? 'sell' : 'buy', type: 'market', qty, source: 'replay', reason: 'replay trade' });
  });
  r.handle('replay:get', (_a, ctx) => svc.forWindow(ctx.windowId)?.view() ?? null);
  r.topic('replay', (p: { windowId: string }, push) => {
    const s = svc.forWindow(p.windowId);
    push(s ? s.view() : null);
    return svc.onChange((sess, windowId) => {
      if (windowId === p.windowId) push(sess ? sess.view() : null);
    });
  });
  core.onShutdown(() => svc.stopAll());
  return svc;
}
