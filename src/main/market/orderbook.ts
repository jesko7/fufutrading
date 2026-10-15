/**
 * Local order book maintained from Binance diff-depth streams following Binance's documented
 * procedures (spot: U/u continuity; futures: pu continuity). Provides grouped snapshots,
 * imbalance metrics, a liquidity heatmap sampler and a large-resting-order tracker.
 *
 * Important: resting liquidity is *observable intent*, not executed volume. Large orders can be
 * pulled at any time; the tracker classifies disappearances as "pulled" (no trades through the
 * level) or "consumed" (trades printed at/through the level while it disappeared).
 */
import type { Market, SymbolId } from '../../shared/symbols';
import { SYMBOL_SPECS } from '../../shared/symbols';
import type { TradeTick } from '../../shared/live';
import type { BinanceRest } from '../binance/rest';
import type { BinanceStreams } from '../binance/ws';
import type {
  BookSnapshot,
  HeatmapColumn,
  ImbalanceMethod,
  LargeOrderEvent,
  BookMetrics,
} from '../../shared/marketTypes';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export class LocalBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  lastUpdateId = 0;
  private sortedBids: number[] | null = null;
  private sortedAsks: number[] | null = null;

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.sortedBids = this.sortedAsks = null;
    this.lastUpdateId = 0;
  }

  setSnapshot(bids: [string, string][], asks: [string, string][], lastUpdateId: number): void {
    this.reset();
    for (const [p, q] of bids) {
      const qq = +q;
      if (qq > 0) this.bids.set(+p, qq);
    }
    for (const [p, q] of asks) {
      const qq = +q;
      if (qq > 0) this.asks.set(+p, qq);
    }
    this.lastUpdateId = lastUpdateId;
  }

  applyLevels(bids: [string, string][], asks: [string, string][]): void {
    if (bids.length) this.sortedBids = null;
    if (asks.length) this.sortedAsks = null;
    for (const [p, q] of bids) {
      const qq = +q;
      if (qq === 0) this.bids.delete(+p);
      else this.bids.set(+p, qq);
    }
    for (const [p, q] of asks) {
      const qq = +q;
      if (qq === 0) this.asks.delete(+p);
      else this.asks.set(+p, qq);
    }
  }

  bidPrices(): number[] {
    if (!this.sortedBids) this.sortedBids = [...this.bids.keys()].sort((a, b) => b - a);
    return this.sortedBids;
  }

  askPrices(): number[] {
    if (!this.sortedAsks) this.sortedAsks = [...this.asks.keys()].sort((a, b) => a - b);
    return this.sortedAsks;
  }

  bestBid(): number {
    const b = this.bidPrices();
    return b.length ? b[0] : NaN;
  }

  bestAsk(): number {
    const a = this.askPrices();
    return a.length ? a[0] : NaN;
  }

  mid(): number {
    return (this.bestBid() + this.bestAsk()) / 2;
  }

  /** Grouped levels; bids floor to group, asks ceil to group. */
  grouped(side: 'bid' | 'ask', group: number, maxLevels: number): [number, number][] {
    const prices = side === 'bid' ? this.bidPrices() : this.askPrices();
    const map = side === 'bid' ? this.bids : this.asks;
    const out: [number, number][] = [];
    if (!(group > 0)) {
      for (let i = 0; i < prices.length && out.length < maxLevels; i++) out.push([prices[i], map.get(prices[i])!]);
      return out;
    }
    let curKey = NaN;
    let curQ = 0;
    for (const p of prices) {
      const key = side === 'bid' ? Math.floor(p / group + 1e-9) * group : Math.ceil(p / group - 1e-9) * group;
      if (key !== curKey) {
        if (!isNaN(curKey)) {
          out.push([curKey, curQ]);
          if (out.length >= maxLevels) return out;
        }
        curKey = key;
        curQ = 0;
      }
      curQ += map.get(p)!;
    }
    if (!isNaN(curKey) && out.length < maxLevels) out.push([curKey, curQ]);
    return out;
  }

  /** Walk the book to estimate the average fill price for a market order (null if too deep). */
  /** Walk the opposite side for `qty`, optionally only through levels at or better than `limit`. */
  sweep(side: 'buy' | 'sell', qty: number, limit?: number): { avgPrice: number; filled: number; worstPrice: number } {
    const prices = side === 'buy' ? this.askPrices() : this.bidPrices();
    const map = side === 'buy' ? this.asks : this.bids;
    let rem = qty;
    let cost = 0;
    let worst = NaN;
    for (const p of prices) {
      if (limit !== undefined && (side === 'buy' ? p > limit : p < limit)) break;
      const q = map.get(p)!;
      const take = Math.min(q, rem);
      cost += take * p;
      rem -= take;
      worst = p;
      if (rem <= 1e-12) break;
    }
    const filled = qty - rem;
    return { avgPrice: filled > 0 ? cost / filled : NaN, filled, worstPrice: worst };
  }
}

export function computeImbalance(book: LocalBook, method: ImbalanceMethod, param: number): number {
  const mid = book.mid();
  if (!isFinite(mid)) return NaN;
  let b = 0;
  let a = 0;
  if (method === 'levels') {
    const n = Math.max(1, Math.round(param));
    const bp = book.bidPrices();
    const ap = book.askPrices();
    for (let i = 0; i < Math.min(n, bp.length); i++) b += book.bids.get(bp[i])! * bp[i];
    for (let i = 0; i < Math.min(n, ap.length); i++) a += book.asks.get(ap[i])! * ap[i];
  } else if (method === 'depthPct') {
    const lo = mid * (1 - param / 100);
    const hi = mid * (1 + param / 100);
    for (const p of book.bidPrices()) {
      if (p < lo) break;
      b += book.bids.get(p)! * p;
    }
    for (const p of book.askPrices()) {
      if (p > hi) break;
      a += book.asks.get(p)! * p;
    }
  } else {
    // 'weighted': exponential decay with half-life `param` basis points from mid
    const hl = Math.max(0.1, param) / 10000;
    const k = Math.LN2 / hl;
    for (const p of book.bidPrices()) {
      const d = (mid - p) / mid;
      if (d > hl * 10) break;
      b += book.bids.get(p)! * p * Math.exp(-k * d);
    }
    for (const p of book.askPrices()) {
      const d = (p - mid) / mid;
      if (d > hl * 10) break;
      a += book.asks.get(p)! * p * Math.exp(-k * d);
    }
  }
  return b + a > 0 ? (b - a) / (b + a) : 0;
}

interface TrackedLevel {
  side: 'bid' | 'ask';
  price: number;
  firstSeen: number;
  lastSeen: number;
  qty: number;
  maxQty: number;
}

export interface BookManagerListener {
  onBook?(): void;
  onStatus?(s: string): void;
}

export class BookManager {
  readonly book = new LocalBook();
  status: 'stopped' | 'syncing' | 'live' | 'resyncing' = 'stopped';
  private buffer: any[] = [];
  private syncing = false;
  private unsub: (() => void) | null = null;
  private listeners = new Set<BookManagerListener>();
  private lastFuturesU = -1;
  // heatmap
  readonly heatmap: HeatmapColumn[] = [];
  heatmapMax = 3600 * 2;
  heatmapBin: number;
  heatmapRangePct = 1.5;
  private sampleTimer: NodeJS.Timeout | null = null;
  // large orders
  private tracked = new Map<string, TrackedLevel>();
  readonly largeEvents: LargeOrderEvent[] = [];
  largeThresholdUsd: number;
  private recentTradeLow = Infinity;
  private recentTradeHigh = -Infinity;
  stats = { events: 0, resyncs: 0, lastEventAt: 0 };

  constructor(
    readonly market: Market,
    readonly symbol: SymbolId,
    private rest: BinanceRest,
    private streams: BinanceStreams,
    private log: Logger,
    /** Binance server time for snapshot / heatmap timestamps (comparable with trade times). */
    private now: () => number = Date.now,
  ) {
    const defaultsBin: Record<SymbolId, number> = { BTCUSDT: 5, ETHUSDT: 0.25, SOLUSDT: 0.02 };
    const defaultsLarge: Record<SymbolId, number> = { BTCUSDT: 1_000_000, ETHUSDT: 500_000, SOLUSDT: 200_000 };
    this.heatmapBin = defaultsBin[symbol];
    this.largeThresholdUsd = defaultsLarge[symbol];
  }

  addListener(l: BookManagerListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  start(): void {
    if (this.unsub) return;
    this.status = 'syncing';
    this.unsub = this.streams.subscribe(this.market, `${this.symbol.toLowerCase()}@depth@100ms`, {
      onData: (d) => this.onEvent(d),
      onReconnect: () => {
        this.log('info', `book ${this.market} ${this.symbol}: reconnect -> resync`);
        void this.resync();
      },
      onDisconnect: () => {
        this.status = 'resyncing';
        this.emitStatus();
      },
    });
    void this.resync();
    this.sampleTimer = setInterval(() => this.sample(), 1000);
    this.sampleTimer.unref?.();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.status = 'stopped';
    this.book.reset();
  }

  private emitStatus(): void {
    for (const l of this.listeners) l.onStatus?.(this.status);
  }

  private onEvent(d: any): void {
    this.stats.events++;
    this.stats.lastEventAt = Date.now();
    if (this.syncing || this.status !== 'live') {
      this.buffer.push(d);
      if (this.buffer.length > 5000) this.buffer.splice(0, this.buffer.length - 5000);
      return;
    }
    if (!this.applyEvent(d)) {
      this.log('warn', `book ${this.market} ${this.symbol}: sequence gap, resyncing`);
      this.buffer = [d];
      void this.resync();
      return;
    }
    for (const l of this.listeners) l.onBook?.();
  }

  /** Apply a diff event to a synced book. Returns false on a sequence gap. */
  private applyEvent(d: any): boolean {
    const U: number = d.U;
    const u: number = d.u;
    if (this.market === 'spot') {
      if (u <= this.book.lastUpdateId) return true; // old
      if (U > this.book.lastUpdateId + 1) return false; // gap
    } else {
      if (u < this.book.lastUpdateId) return true;
      if (this.lastFuturesU >= 0 && d.pu !== this.lastFuturesU) return false;
      this.lastFuturesU = u;
    }
    this.book.applyLevels(d.b, d.a);
    this.book.lastUpdateId = u;
    return true;
  }

  async resync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.stats.resyncs++;
    this.status = this.status === 'stopped' ? 'syncing' : 'resyncing';
    this.emitStatus();
    try {
      for (let attempt = 1; attempt < 20 && this.unsub; attempt++) {
        // wait for at least one buffered event so we know U
        const t0 = Date.now();
        while (!this.buffer.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
        try {
          const snap = await this.rest.depth(this.market, this.symbol, this.market === 'spot' ? 5000 : 1000);
          const firstU = this.buffer.length ? this.buffer[0].U : 0;
          if (this.market === 'spot' && this.buffer.length && snap.lastUpdateId < firstU) {
            await new Promise((r) => setTimeout(r, 300));
            continue; // snapshot too old, retry
          }
          this.book.setSnapshot(snap.bids, snap.asks, snap.lastUpdateId);
          this.lastFuturesU = -1;
          const buf = this.buffer;
          this.buffer = [];
          let ok = true;
          let first = true;
          for (const ev of buf) {
            if (this.market === 'spot') {
              if (ev.u <= snap.lastUpdateId) continue;
              if (!this.applyEvent(ev)) {
                ok = false;
                break;
              }
            } else {
              if (ev.u < snap.lastUpdateId) continue;
              if (first) {
                if (!(ev.U <= snap.lastUpdateId && ev.u >= snap.lastUpdateId)) {
                  ok = false;
                  break;
                }
                first = false;
                this.book.applyLevels(ev.b, ev.a);
                this.book.lastUpdateId = ev.u;
                this.lastFuturesU = ev.u;
                continue;
              }
              if (!this.applyEvent(ev)) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          this.status = 'live';
          this.emitStatus();
          for (const l of this.listeners) l.onBook?.();
          return;
        } catch (e) {
          this.log('warn', `book ${this.market} ${this.symbol} snapshot failed: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, Math.min(10000, 500 * attempt)));
        }
      }
    } finally {
      this.syncing = false;
      // apply anything that arrived while finishing
      if (this.status === 'live' && this.buffer.length) {
        const buf = this.buffer;
        this.buffer = [];
        for (const ev of buf) this.onEvent(ev);
      }
    }
  }

  /** Feed trades from the tape (used to classify large-order disappearances). */
  onTrade(t: TradeTick): void {
    if (t.p < this.recentTradeLow) this.recentTradeLow = t.p;
    if (t.p > this.recentTradeHigh) this.recentTradeHigh = t.p;
  }

  snapshot(group: number, levels: number, imb: { method: ImbalanceMethod; param: number }): BookSnapshot {
    const b = this.book;
    const metrics: BookMetrics = {
      bestBid: b.bestBid(),
      bestAsk: b.bestAsk(),
      mid: b.mid(),
      spread: b.bestAsk() - b.bestBid(),
      imbalance: computeImbalance(b, imb.method, imb.param),
      imbalanceMethod: imb.method,
      imbalanceParam: imb.param,
      bidDepth1pct: 0,
      askDepth1pct: 0,
    };
    const mid = metrics.mid;
    for (const p of b.bidPrices()) {
      if (p < mid * 0.99) break;
      metrics.bidDepth1pct += b.bids.get(p)! * p;
    }
    for (const p of b.askPrices()) {
      if (p > mid * 1.01) break;
      metrics.askDepth1pct += b.asks.get(p)! * p;
    }
    return {
      t: this.now(),
      status: this.status,
      bids: b.grouped('bid', group, levels),
      asks: b.grouped('ask', group, levels),
      metrics,
    };
  }

  /** Sample the book into a heatmap column and update large-order tracking. */
  private sample(): void {
    if (this.status !== 'live') return;
    const b = this.book;
    const mid = b.mid();
    if (!isFinite(mid)) return;
    const now = this.now();
    const bin = this.heatmapBin;
    const lo = Math.floor((mid * (1 - this.heatmapRangePct / 100)) / bin) * bin;
    const hi = Math.ceil((mid * (1 + this.heatmapRangePct / 100)) / bin) * bin;
    const n = Math.max(1, Math.round((hi - lo) / bin));
    const bids = new Float32Array(n);
    const asks = new Float32Array(n);
    for (const p of b.bidPrices()) {
      if (p < lo) break;
      const i = Math.floor((p - lo) / bin);
      if (i >= 0 && i < n) bids[i] += b.bids.get(p)!;
    }
    for (const p of b.askPrices()) {
      if (p >= hi) break;
      const i = Math.floor((p - lo) / bin);
      if (i >= 0 && i < n) asks[i] += b.asks.get(p)!;
    }
    this.heatmap.push({ t: now, p0: lo, bin, bids, asks, bestBid: b.bestBid(), bestAsk: b.bestAsk() });
    if (this.heatmap.length > this.heatmapMax) this.heatmap.splice(0, this.heatmap.length - this.heatmapMax);
    this.trackLarge(now, mid);
    this.recentTradeLow = Infinity;
    this.recentTradeHigh = -Infinity;
  }

  private trackLarge(now: number, mid: number): void {
    const b = this.book;
    const thr = this.largeThresholdUsd;
    const seen = new Set<string>();
    const scan = (side: 'bid' | 'ask') => {
      const prices = side === 'bid' ? b.bidPrices() : b.askPrices();
      const map = side === 'bid' ? b.bids : b.asks;
      for (const p of prices) {
        if (Math.abs(p - mid) / mid > 0.05) break;
        const q = map.get(p)!;
        if (q * p < thr) continue;
        const key = `${side}:${p}`;
        seen.add(key);
        const tr = this.tracked.get(key);
        if (tr) {
          tr.lastSeen = now;
          tr.qty = q;
          tr.maxQty = Math.max(tr.maxQty, q);
        } else {
          const lvl: TrackedLevel = { side, price: p, firstSeen: now, lastSeen: now, qty: q, maxQty: q };
          this.tracked.set(key, lvl);
          // movement: a similar order vanished on the same side within 3s near this price
          const moved = this.findRecentVanished(side, p, q, now);
          this.pushLarge({ t: now, side, price: p, qty: q, notional: q * p, kind: moved ? 'moved' : 'appeared', fromPrice: moved?.price, ageMs: 0 });
        }
      }
    };
    scan('bid');
    scan('ask');
    for (const [key, lvl] of this.tracked) {
      if (seen.has(key)) continue;
      this.tracked.delete(key);
      // consumed if trades printed at/through the level since last sample
      const consumed = lvl.side === 'bid' ? this.recentTradeLow <= lvl.price : this.recentTradeHigh >= lvl.price;
      this.pushLarge({ t: now, side: lvl.side, price: lvl.price, qty: lvl.qty, notional: lvl.qty * lvl.price, kind: consumed ? 'consumed' : 'pulled', ageMs: now - lvl.firstSeen });
    }
  }

  private findRecentVanished(side: 'bid' | 'ask', price: number, qty: number, now: number): LargeOrderEvent | undefined {
    const spec = SYMBOL_SPECS[this.symbol][this.market];
    for (let i = this.largeEvents.length - 1; i >= 0; i--) {
      const e = this.largeEvents[i];
      if (now - e.t > 3000) break;
      if (e.kind !== 'pulled' || e.side !== side) continue;
      if (Math.abs(e.qty - qty) / qty < 0.2 && Math.abs(e.price - price) <= spec.tickSize * 2000) {
        e.kind = 'moved-from';
        return e;
      }
    }
    return undefined;
  }

  private pushLarge(e: LargeOrderEvent): void {
    this.largeEvents.push(e);
    if (this.largeEvents.length > 500) this.largeEvents.splice(0, this.largeEvents.length - 500);
  }

  activeLargeOrders(): { side: 'bid' | 'ask'; price: number; qty: number; notional: number; ageMs: number }[] {
    const now = this.now();
    return [...this.tracked.values()].map((l) => ({ side: l.side, price: l.price, qty: l.qty, notional: l.qty * l.price, ageMs: now - l.firstSeen }));
  }
}
