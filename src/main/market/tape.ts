/**
 * LiveTape — the single source of live trades and closed base klines for one instrument.
 *
 * Guarantees to listeners:
 *  - base klines (1s spot / 1m futures) are delivered closed, contiguous and in order;
 *    missing klines (gaps, reconnects) are backfilled from REST before newer ones are emitted;
 *  - aggregate trades are delivered in strictly increasing id order without duplicates;
 *    id gaps are backfilled from REST (fromId) before newer trades are emitted;
 *  - a snapshot (watermark + trades after it) lets late subscribers start consistently.
 */
import type { Market, SymbolId } from '../../shared/symbols';
import type { BaseKline, TradeTick } from '../../shared/live';
import { intervalMs } from '../../shared/timeframes';
import type { BinanceRest } from '../binance/rest';
import type { BinanceStreams } from '../binance/ws';

export type TapeStatus = 'syncing' | 'live' | 'reconnecting' | 'degraded' | 'stopped';

export interface TapeListener {
  onTrade?(t: TradeTick): void;
  onKline?(k: BaseKline): void;
  onStatus?(s: TapeStatus, detail?: string): void;
}

export interface TapeSnapshot {
  watermark: number;
  lastTradeId: number;
  trades: TradeTick[];
  lastPrice: number;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export class LiveTape {
  readonly baseInterval: string;
  readonly baseMs: number;
  watermark = -1;
  lastTradeId = -1;
  lastPrice = NaN;
  lastTradeTime = 0;
  status: TapeStatus = 'stopped';
  /** Trades after the watermark (cleared as base klines close). */
  private afterWatermark: TradeTick[] = [];
  /** Recent trades for time & sales (ring). */
  readonly recent: TradeTick[] = [];
  private recentMax = 3000;
  recentKlines: BaseKline[] = [];
  private listeners = new Set<TapeListener>();
  private unsub: (() => void)[] = [];
  private bufTrades: TradeTick[] = [];
  private bufKlines: BaseKline[] = [];
  private syncing = false;
  private klineQueue: Promise<void> = Promise.resolve();
  private tradeGapFetch: Promise<void> | null = null;
  private heldTrades: TradeTick[] = [];
  stats = { trades: 0, klines: 0, backfilledKlines: 0, backfilledTrades: 0, resyncs: 0 };

  constructor(
    readonly market: Market,
    readonly symbol: SymbolId,
    private rest: BinanceRest,
    private streams: BinanceStreams,
    private log: Logger,
  ) {
    this.baseInterval = market === 'spot' ? '1s' : '1m';
    this.baseMs = intervalMs(this.baseInterval);
  }

  addListener(l: TapeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  snapshot(): TapeSnapshot {
    return { watermark: this.watermark, lastTradeId: this.lastTradeId, trades: this.afterWatermark.slice(), lastPrice: this.lastPrice };
  }

  private setStatus(s: TapeStatus, detail?: string): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.listeners) l.onStatus?.(s, detail);
  }

  start(): void {
    if (this.unsub.length) return;
    const sym = this.symbol.toLowerCase();
    this.unsub.push(
      this.streams.subscribe(this.market, `${sym}@aggTrade`, {
        onData: (d) => this.onWsTrade({ id: d.a, t: d.T, p: +d.p, q: +d.q, m: !!d.m }),
        onReconnect: () => this.resync('reconnect'),
        onDisconnect: () => this.setStatus('reconnecting'),
      }),
    );
    this.unsub.push(
      this.streams.subscribe(this.market, `${sym}@kline_${this.baseInterval}`, {
        onData: (d) => {
          const k = d.k;
          if (!k || !k.x) return; // only closed klines are authoritative
          this.onWsKline({ t: k.t, T: k.T, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, qv: +k.q, n: +k.n, tbv: +k.V });
        },
      }),
    );
    void this.resync('start');
  }

  stop(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.setStatus('stopped');
  }

  /** (Re)establish a consistent state from REST, then drain buffered websocket events. */
  private async resync(reason: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.stats.resyncs++;
    this.setStatus(reason === 'start' ? 'syncing' : 'reconnecting', reason);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bootstrap();
          break;
        } catch (e) {
          this.log('warn', `tape ${this.market} ${this.symbol} resync failed (${(e as Error).message}), retry ${attempt}`);
          await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * attempt)));
          if (!this.unsub.length) return;
        }
      }
    } finally {
      this.syncing = false;
    }
    // drain buffers in order
    const ks = this.bufKlines.sort((a, b) => a.t - b.t);
    this.bufKlines = [];
    for (const k of ks) this.onWsKline(k);
    const ts = this.bufTrades.sort((a, b) => a.id - b.id);
    this.bufTrades = [];
    for (const t of ts) this.onWsTrade(t);
    this.setStatus('live');
  }

  private async bootstrap(): Promise<void> {
    const now = Date.now();
    // 1) closed base klines since the watermark (or just the latest few on first start)
    const from = this.watermark > 0 ? this.watermark + 1 : now - this.baseMs * 5;
    const ks = await this.rest.klines(this.market, this.symbol, this.baseInterval, { startTime: from, limit: this.market === 'spot' ? 1000 : 1500 });
    const serverNow = Date.now();
    for (let i = 0; i < ks.length; i++) {
      const T = ks.t[i] + this.baseMs - 1;
      if (T >= serverNow - 250) break; // still forming
      this.emitKline({ t: ks.t[i], T, o: ks.o[i], h: ks.h[i], l: ks.l[i], c: ks.c[i], v: ks.v[i], qv: ks.qv[i], n: ks.n[i], tbv: ks.tbv[i] }, true);
    }
    if (this.watermark < 0 && ks.length) this.watermark = ks.t[0] - 1;
    // 2) trades after the watermark (or after the last known trade id)
    let trades: TradeTick[];
    if (this.lastTradeId >= 0) trades = await this.rest.aggTrades(this.market, this.symbol, { fromId: this.lastTradeId + 1, limit: 1000 });
    else trades = await this.rest.aggTrades(this.market, this.symbol, { startTime: this.watermark + 1, limit: 1000 });
    for (let guard = 0; guard < 50 && trades.length; guard++) {
      for (const t of trades) this.emitTrade(t, true);
      const firstBuffered = this.bufTrades.length ? Math.min(...this.bufTrades.map((x) => x.id)) : Infinity;
      if (trades.length < 1000 || this.lastTradeId + 1 >= firstBuffered) break;
      trades = await this.rest.aggTrades(this.market, this.symbol, { fromId: this.lastTradeId + 1, limit: 1000 });
    }
  }

  private onWsTrade(t: TradeTick): void {
    if (this.syncing) {
      this.bufTrades.push(t);
      return;
    }
    if (this.tradeGapFetch) {
      this.heldTrades.push(t);
      return;
    }
    if (t.id <= this.lastTradeId) return;
    if (this.lastTradeId >= 0 && t.id > this.lastTradeId + 1) {
      // id gap: backfill before releasing newer trades
      this.heldTrades.push(t);
      const fromId = this.lastTradeId + 1;
      const toId = t.id - 1;
      this.tradeGapFetch = (async () => {
        try {
          let next = fromId;
          for (let guard = 0; guard < 20 && next <= toId; guard++) {
            const page = await this.rest.aggTrades(this.market, this.symbol, { fromId: next, limit: 1000 });
            if (!page.length) break;
            for (const x of page) if (x.id <= toId) this.emitTrade(x, true);
            next = page[page.length - 1].id + 1;
            if (page.length < 1000) break;
          }
        } catch (e) {
          this.log('warn', `tape ${this.symbol}: trade gap backfill failed: ${(e as Error).message}`);
          this.setStatus('degraded', 'trade gap');
        } finally {
          this.tradeGapFetch = null;
          const held = this.heldTrades.sort((a, b) => a.id - b.id);
          this.heldTrades = [];
          for (const h of held) {
            if (h.id <= this.lastTradeId) continue;
            this.emitTrade(h, false);
          }
          if (this.status === 'degraded') this.setStatus('live');
        }
      })();
      return;
    }
    this.emitTrade(t, false);
  }

  private emitTrade(t: TradeTick, backfill: boolean): void {
    if (t.id <= this.lastTradeId) return;
    this.lastTradeId = t.id;
    if (backfill) this.stats.backfilledTrades++;
    this.stats.trades++;
    if (t.t >= this.lastTradeTime) {
      this.lastPrice = t.p;
      this.lastTradeTime = t.t;
    }
    this.recent.push(t);
    if (this.recent.length > this.recentMax) this.recent.splice(0, this.recent.length - this.recentMax);
    if (t.t > this.watermark) this.afterWatermark.push(t);
    for (const l of this.listeners) l.onTrade?.(t);
  }

  private onWsKline(k: BaseKline): void {
    if (this.syncing) {
      this.bufKlines.push(k);
      return;
    }
    // serialize so backfills complete before newer klines are emitted
    this.klineQueue = this.klineQueue.then(() => this.processKline(k)).catch((e) => this.log('warn', `kline queue: ${(e as Error).message}`));
  }

  private async processKline(k: BaseKline): Promise<void> {
    if (k.T <= this.watermark) return;
    const expected = this.watermark + 1;
    if (this.watermark > 0 && k.t > expected) {
      // gap in base klines: backfill [expected, k.t)
      try {
        let start = expected;
        for (let guard = 0; guard < 100 && start < k.t; guard++) {
          const ks = await this.rest.klines(this.market, this.symbol, this.baseInterval, { startTime: start, endTime: k.t - 1, limit: this.market === 'spot' ? 1000 : 1500 });
          if (!ks.length) break;
          for (let i = 0; i < ks.length; i++) {
            if (ks.t[i] >= k.t) break;
            this.emitKline({ t: ks.t[i], T: ks.t[i] + this.baseMs - 1, o: ks.o[i], h: ks.h[i], l: ks.l[i], c: ks.c[i], v: ks.v[i], qv: ks.qv[i], n: ks.n[i], tbv: ks.tbv[i] }, true);
          }
          start = ks.t[ks.length - 1] + this.baseMs;
          if (ks.length < 1000) break;
        }
      } catch (e) {
        this.log('warn', `tape ${this.symbol}: kline backfill failed: ${(e as Error).message}`);
      }
    }
    this.emitKline(k, false);
  }

  private emitKline(k: BaseKline, backfill: boolean): void {
    if (k.T <= this.watermark) return;
    this.watermark = k.T;
    if (backfill) this.stats.backfilledKlines++;
    this.stats.klines++;
    this.recentKlines.push(k);
    if (this.recentKlines.length > 600) this.recentKlines.splice(0, this.recentKlines.length - 600);
    let drop = 0;
    while (drop < this.afterWatermark.length && this.afterWatermark[drop].t <= k.T) drop++;
    if (drop) this.afterWatermark.splice(0, drop);
    if (!(this.lastPrice > 0)) this.lastPrice = k.c;
    for (const l of this.listeners) l.onKline?.(k);
  }
}
