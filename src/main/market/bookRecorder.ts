/**
 * Order-book recording and the book frames scripts read (Pine book.*, Python data.book).
 *
 * Recording keeps the local book of each chosen instrument running and saves every level of it
 * once a minute, a quarter second before the minute closes (Binance server time), so the frame
 * belongs to the bar that is closing — the same moment a live chart's last update shows.
 * Spot books hold up to 5000 levels a side, USDⓈ-M futures books 1000 (plus levels the diff
 * stream added since), about 23 KB and 5 KB a minute.
 *
 * Scripts get, per bar, the last recorded frame taken while the bar formed; live charts add the
 * current book on the forming bar.
 */
import type { MarketHub } from './hub';
import type { BookManager, LocalBook } from './orderbook';
import { BookStore, type BookIndexEntry } from '../storage/bookStore';
import { encodeBook } from '../../shared/bookFrame';
import { alignBook, packBook, type BookWire } from '../../engine/book';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import type { BookRecordingSettings } from '../../shared/settings';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** Levels a side kept in a frame (Binance's deepest spot snapshot). */
const MAX_LEVELS = 5000;
/** Frame bytes loaded for one script run; older bars go without (newest first). */
const BUDGET_BYTES = 96 * 1024 * 1024;

export function encodeLocalBook(book: LocalBook, tick: number, step: number, maxLevels = MAX_LEVELS): Uint8Array {
  const bids = book.bidPrices();
  const asks = book.askPrices();
  const nb = Math.min(bids.length, maxLevels);
  const na = Math.min(asks.length, maxLevels);
  const bp = new Float64Array(nb);
  const bq = new Float64Array(nb);
  const ap = new Float64Array(na);
  const aq = new Float64Array(na);
  for (let k = 0; k < nb; k++) {
    bp[k] = bids[k];
    bq[k] = book.bids.get(bids[k])!;
  }
  for (let k = 0; k < na; k++) {
    ap[k] = asks[k];
    aq[k] = book.asks.get(asks[k])!;
  }
  return encodeBook(bp, bq, ap, aq, tick, step);
}

/** A note for backtests and bots when bars from `from` on lack a recorded book (null when all have one). */
export function bookCoverageNote(w: BookWire, from: number, label: string): string | null {
  const n = w.t.length;
  let have = 0;
  let first = NaN;
  for (let i = Math.max(0, from); i < n; i++)
    if (w.t[i] === w.t[i]) {
      have++;
      if (first !== first) first = w.t[i];
    }
  const total = n - Math.max(0, from);
  if (have >= total) return null;
  if (!have) return `No recorded order book for ${label} in this range: book.* / data.book are na. Turn on recording in Data → Order books.`;
  return `The order book of ${label} is recorded for ${have} of ${total} bars (from ${new Date(first).toISOString().slice(0, 16).replace('T', ' ')} UTC); book.* / data.book are na before.`;
}

export function validRecordKey(k: string): k is `${Market}:${SymbolId}` {
  const [m, s] = k.split(':');
  return (m === 'spot' || m === 'futures') && isSymbol(s);
}

export class BookRecorder {
  readonly store: BookStore;
  private rec = new Map<string, { book: BookManager; release: () => void; saved: number }>();
  private timer: NodeJS.Timeout | null = null;
  private keepDays = 30;
  private lastPrune = 0;
  private live = new WeakMap<BookManager, { at: number; t: number; bytes: Uint8Array }>();

  constructor(
    private hub: MarketHub,
    dir: string,
    private log: Logger,
  ) {
    this.store = new BookStore(dir);
  }

  configure(s: BookRecordingSettings): void {
    const want = new Set<string>(s.record.filter(validRecordKey));
    for (const [k, r] of this.rec)
      if (!want.has(k)) {
        r.release();
        this.rec.delete(k);
        this.log('info', `book recording stopped: ${k}`);
      }
    for (const k of want) {
      if (this.rec.has(k)) continue;
      const [market, symbol] = k.split(':') as [Market, SymbolId];
      const { book, release } = this.hub.acquireBook(market, symbol);
      this.rec.set(k, { book, release, saved: 0 });
      this.log('info', `book recording started: ${k}`);
    }
    this.keepDays = Math.max(1, Math.round(s.keepDays) || 30);
    if (this.rec.size && !this.timer) this.arm();
    if (!this.rec.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.configure({ record: [], keepDays: this.keepDays });
  }

  private arm(): void {
    const now = this.hub.clock.now();
    let at = Math.floor(now / 60_000) * 60_000 + 60_000 - 250;
    if (at - now < 50) at += 60_000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
      if (this.rec.size) this.arm();
    }, at - now);
    this.timer.unref?.();
  }

  private tick(): void {
    const now = this.hub.clock.now();
    for (const [k, r] of this.rec) {
      if (r.book.status !== 'live') {
        this.log('info', `book recording ${k}: skipped a minute (book ${r.book.status})`);
        continue;
      }
      const [market, symbol] = k.split(':') as [Market, SymbolId];
      try {
        const f = this.liveFrame(r.book, 0)!;
        this.store.append(market, symbol, f.t, f.bytes);
        r.saved = f.t;
      } catch (e) {
        this.log('warn', `book recording ${k}: ${(e as Error).message}`);
      }
    }
    if (now - this.lastPrune > 3_600_000) {
      this.lastPrune = now;
      try {
        this.store.prune(this.keepDays, now);
      } catch (e) {
        this.log('warn', `book recording cleanup: ${(e as Error).message}`);
      }
    }
  }

  /** Recording state per instrument ("market:SYMBOL"): the book's status and the last saved frame. */
  status(): Record<string, { status: string; saved: number }> {
    const out: Record<string, { status: string; saved: number }> = {};
    for (const [k, r] of this.rec) out[k] = { status: r.book.status, saved: r.saved };
    return out;
  }

  /** The book encoded now (reused for `maxAgeMs`); null while it is not live. */
  liveFrame(book: BookManager, maxAgeMs = 900): { t: number; bytes: Uint8Array } | null {
    if (book.status !== 'live') return null;
    const now = Date.now();
    const c = this.live.get(book);
    if (c && now - c.at <= maxAgeMs) return c;
    const spec = SYMBOL_SPECS[book.symbol][book.market];
    const f = { at: now, t: this.hub.clock.now(), bytes: encodeLocalBook(book.book, spec.tickSize, spec.stepSize) };
    this.live.set(book, f);
    return f;
  }

  /**
   * Recorded frames for bars: each bar gets the last frame taken while it formed (and before
   * `until`, the replay clock). Within the byte budget, newest bars first.
   */
  framesFor(market: Market, symbol: string, barT: ArrayLike<number>, barTc: ArrayLike<number>, n: number, until = Infinity): { t: number[]; frames: (Uint8Array | null)[]; count: number } {
    const t: number[] = new Array(n).fill(NaN);
    const frames: (Uint8Array | null)[] = new Array(n).fill(null);
    if (!n) return { t, frames, count: 0 };
    const to = Math.min(Number.isFinite(barTc[n - 1]) ? barTc[n - 1] : Infinity, until, this.hub.clock.now() + 60_000);
    const idx = this.store.index(market, symbol, barT[0], to);
    const pick = alignBook(barT, barTc, n, idx.map((e) => e.t));
    const chosen: { bar: number; e: BookIndexEntry }[] = [];
    let bytes = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (pick[i] < 0) continue;
      const e = idx[pick[i]];
      if (bytes + e.len > BUDGET_BYTES) break;
      bytes += e.len;
      chosen.push({ bar: i, e });
    }
    chosen.reverse();
    const data = this.store.load(chosen.map((c) => c.e));
    chosen.forEach((c, k) => {
      t[c.bar] = c.e.t;
      frames[c.bar] = data[k];
    });
    return { t, frames, count: chosen.length };
  }

  /** framesFor() packed for a worker. */
  wireFor(market: Market, symbol: string, barT: ArrayLike<number>, barTc: ArrayLike<number>, n: number, until = Infinity): BookWire {
    const f = this.framesFor(market, symbol, barT, barTc, n, until);
    return packBook(f.t, f.frames);
  }
}
