/**
 * MarketHub — owns all Binance connections and shares them between consumers
 * (charts in any window, paper trading, bots, alerts). Everything is ref-counted so a stream
 * is opened once no matter how many modules use it, and closed shortly after the last user.
 */
import { EventEmitter } from 'node:events';
import type { Market, SymbolId } from '../../shared/symbols';
import { SYMBOLS } from '../../shared/symbols';
import type { Ticker, ConnectionInfo } from '../../shared/marketTypes';
import { BinanceRest } from '../binance/rest';
import { BinanceStreams } from '../binance/ws';
import { LiveTape } from './tape';
import { ServerClock } from '../binance/clock';
import { BookManager } from './orderbook';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

interface Ref<T> {
  obj: T;
  refs: number;
  stopTimer: NodeJS.Timeout | null;
}

export interface MarkInfo {
  symbol: SymbolId;
  mark: number;
  index: number;
  fundingRate: number;
  nextFundingTime: number;
  t: number;
}

export class MarketHub extends EventEmitter {
  readonly rest: BinanceRest;
  readonly streams: BinanceStreams;
  /** Binance server time (bars open and close on it). Started by the app core. */
  readonly clock: ServerClock;
  private tapes = new Map<string, Ref<LiveTape>>();
  private books = new Map<string, Ref<BookManager>>();
  readonly tickers = new Map<string, Ticker>();
  private tickerSubs = new Map<string, { refs: number; unsub: () => void }>();
  readonly marks = new Map<SymbolId, MarkInfo>();
  private markSubs = new Map<SymbolId, { refs: number; unsub: () => void }>();
  private lingerMs = 20000;

  constructor(private log: Logger) {
    super();
    this.setMaxListeners(1000);
    this.rest = new BinanceRest(log);
    this.streams = new BinanceStreams(log);
    this.clock = new ServerClock(this.rest, log);
  }

  private key(market: Market, symbol: SymbolId): string {
    return `${market}:${symbol}`;
  }

  /** Acquire the live tape for an instrument (started on first use). */
  acquireTape(market: Market, symbol: SymbolId): { tape: LiveTape; release: () => void } {
    const k = this.key(market, symbol);
    let r = this.tapes.get(k);
    if (!r) {
      const tape = new LiveTape(market, symbol, this.rest, this.streams, this.log, () => this.clock.now());
      r = { obj: tape, refs: 0, stopTimer: null };
      this.tapes.set(k, r);
      tape.start();
      // feed trades to the order book (if any) for large-order classification
      tape.addListener({
        onTrade: (t) => {
          const b = this.books.get(k);
          if (b) b.obj.onTrade(t);
          this.emit(`trade:${k}`, t);
        },
      });
    }
    if (r.stopTimer) {
      clearTimeout(r.stopTimer);
      r.stopTimer = null;
    }
    r.refs++;
    const ref = r;
    let released = false;
    return {
      tape: r.obj,
      release: () => {
        if (released) return;
        released = true;
        ref.refs--;
        if (ref.refs <= 0) {
          ref.stopTimer = setTimeout(() => {
            if (ref.refs <= 0) {
              ref.obj.stop();
              this.tapes.delete(k);
            }
          }, this.lingerMs);
        }
      },
    };
  }

  /** Wait until a tape has completed its initial sync. */
  async tapeReady(tape: LiveTape, timeoutMs = 20000): Promise<void> {
    const t0 = Date.now();
    while (tape.watermark <= 0 || tape.status === 'syncing') {
      if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out connecting to Binance (${tape.market} ${tape.symbol})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  acquireBook(market: Market, symbol: SymbolId): { book: BookManager; release: () => void } {
    const k = this.key(market, symbol);
    let r = this.books.get(k);
    if (!r) {
      const mgr = new BookManager(market, symbol, this.rest, this.streams, this.log, () => this.clock.now());
      r = { obj: mgr, refs: 0, stopTimer: null };
      this.books.set(k, r);
      mgr.start();
    }
    if (r.stopTimer) {
      clearTimeout(r.stopTimer);
      r.stopTimer = null;
    }
    r.refs++;
    const ref = r;
    let released = false;
    return {
      book: r.obj,
      release: () => {
        if (released) return;
        released = true;
        ref.refs--;
        if (ref.refs <= 0) {
          ref.stopTimer = setTimeout(() => {
            if (ref.refs <= 0) {
              ref.obj.stop();
              this.books.delete(k);
            }
          }, this.lingerMs * 3);
        }
      },
    };
  }

  /** 24h ticker stream (1s cadence). The callback receives merged ticker objects. */
  subscribeTicker(market: Market, symbol: SymbolId, cb: (t: Ticker) => void): () => void {
    const k = this.key(market, symbol);
    const ev = `ticker:${k}`;
    this.on(ev, cb);
    let s = this.tickerSubs.get(k);
    if (!s) {
      const unsub = this.streams.subscribe(market, `${symbol.toLowerCase()}@ticker`, {
        onData: (d) => {
          const prev = this.tickers.get(k);
          const t: Ticker = {
            symbol,
            market,
            last: +d.c,
            open24h: +d.o,
            high24h: +d.h,
            low24h: +d.l,
            change24h: +d.p,
            changePct24h: +d.P,
            volume24h: +d.v,
            quoteVolume24h: +d.q,
            t: d.E,
            mark: prev?.mark,
            index: prev?.index,
            fundingRate: prev?.fundingRate,
            nextFundingTime: prev?.nextFundingTime,
          };
          // the trade tape is faster than the 1s ticker; prefer it when available
          const tape = this.tapes.get(k);
          if (tape && tape.obj.lastPrice > 0 && tape.obj.lastTradeTime >= d.E - 2000) t.last = tape.obj.lastPrice;
          this.tickers.set(k, t);
          this.emit(ev, t);
        },
      });
      s = { refs: 0, unsub };
      this.tickerSubs.set(k, s);
      // seed immediately via REST so the UI is not empty for a second
      this.rest
        .ticker24h(market, symbol)
        .then((d: any) => {
          if (this.tickers.has(k)) return;
          const t: Ticker = {
            symbol,
            market,
            last: +d.lastPrice,
            open24h: +d.openPrice,
            high24h: +d.highPrice,
            low24h: +d.lowPrice,
            change24h: +d.priceChange,
            changePct24h: +d.priceChangePercent,
            volume24h: +d.volume,
            quoteVolume24h: +d.quoteVolume,
            t: Date.now(),
          };
          this.tickers.set(k, t);
          this.emit(ev, t);
        })
        .catch(() => {});
    }
    s.refs++;
    const cur = this.tickers.get(k);
    if (cur) setImmediate(() => cb(cur));
    const sub = s;
    return () => {
      this.off(ev, cb);
      sub.refs--;
      if (sub.refs <= 0) {
        sub.unsub();
        this.tickerSubs.delete(k);
      }
    };
  }

  /** Futures mark price / funding (1s). */
  subscribeMark(symbol: SymbolId, cb: (m: MarkInfo) => void): () => void {
    const ev = `mark:${symbol}`;
    this.on(ev, cb);
    let s = this.markSubs.get(symbol);
    if (!s) {
      const unsub = this.streams.subscribe('futures', `${symbol.toLowerCase()}@markPrice@1s`, {
        onData: (d) => {
          const m: MarkInfo = { symbol, mark: +d.p, index: +d.i, fundingRate: +d.r, nextFundingTime: d.T, t: d.E };
          this.marks.set(symbol, m);
          const tk = this.tickers.get(this.key('futures', symbol));
          if (tk) {
            tk.mark = m.mark;
            tk.index = m.index;
            tk.fundingRate = m.fundingRate;
            tk.nextFundingTime = m.nextFundingTime;
          }
          this.emit(ev, m);
        },
      });
      s = { refs: 0, unsub };
      this.markSubs.set(symbol, s);
      this.rest
        .premiumIndex(symbol)
        .then((d) => {
          if (this.marks.has(symbol)) return;
          const m: MarkInfo = { symbol, mark: +d.markPrice, index: +d.indexPrice, fundingRate: +d.lastFundingRate, nextFundingTime: d.nextFundingTime, t: d.time };
          this.marks.set(symbol, m);
          this.emit(ev, m);
        })
        .catch(() => {});
    }
    s.refs++;
    const cur = this.marks.get(symbol);
    if (cur) setImmediate(() => cb(cur));
    const sub = s;
    return () => {
      this.off(ev, cb);
      sub.refs--;
      if (sub.refs <= 0) {
        sub.unsub();
        this.markSubs.delete(symbol);
      }
    };
  }

  /** Best available last price for an instrument (tape > ticker). */
  lastPrice(market: Market, symbol: SymbolId): number {
    const k = this.key(market, symbol);
    const tape = this.tapes.get(k);
    if (tape && tape.obj.lastPrice > 0) return tape.obj.lastPrice;
    const t = this.tickers.get(k);
    return t ? t.last : NaN;
  }

  bookFor(market: Market, symbol: SymbolId): BookManager | undefined {
    return this.books.get(this.key(market, symbol))?.obj;
  }

  tapeFor(market: Market, symbol: SymbolId): LiveTape | undefined {
    return this.tapes.get(this.key(market, symbol))?.obj;
  }

  connectionInfo(): ConnectionInfo {
    return {
      conns: this.streams.status(),
      tapes: [...this.tapes.entries()].map(([key, r]) => ({ key, status: r.obj.status, lastPrice: r.obj.lastPrice, watermark: r.obj.watermark, stats: { ...r.obj.stats } })),
      books: [...this.books.entries()].map(([key, r]) => ({ key, status: r.obj.status, resyncs: r.obj.stats.resyncs })),
    };
  }

  allSymbols(): readonly SymbolId[] {
    return SYMBOLS;
  }

  shutdown(): void {
    for (const r of this.tapes.values()) r.obj.stop();
    for (const r of this.books.values()) r.obj.stop();
    this.streams.closeAll();
  }
}
