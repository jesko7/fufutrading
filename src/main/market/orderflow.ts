/**
 * Order-flow chart tools in the main process.
 *
 * `orderflow`: HVN Profile, Heavy Absorption and Imbalance Levels for one chart, computed by
 * OrderFlowEngine from Binance aggregate trades — the local trade cache for history (loaded
 * newest first, so the latest hour shows up within seconds) and the live trade tape after that.
 * Absorption bubbles also carry the live order book's resting size at the level.
 *
 * `orderflow:dom`: the live local order book for the DOM, every level grouped to a price step.
 */
import type { AppCore } from '../core';
import type { TradeStore } from '../storage/tradeStore';
import type { LocalBook } from './orderbook';
import { OrderFlowEngine, type BookProbe } from './orderflowEngine';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfDurationMs, bucketStart, isFixedDuration } from '../../shared/timeframes';
import { autoRow, niceStep, type AbsorptionParams, type HvnParams, type ImbalanceParams, type OrderFlowRequest } from '../../shared/orderflow';

const HOUR = 3600000;
/** Longest history: perpetual trades cost five times the request weight of spot trades. */
const MAX_WINDOW: Record<Market, number> = { spot: 48 * HOUR, futures: 24 * HOUR };

const num = (v: unknown, def: number, lo: number, hi: number): number => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def;
};

/** Sum of resting size on one side of a book within [lo, hi). */
export function bookSum(book: LocalBook, side: 'bid' | 'ask', lo: number, hi: number): number {
  if (side === 'bid') {
    const ps = book.bidPrices(); // descending
    let a = 0;
    let b = ps.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (ps[m] >= hi) a = m + 1;
      else b = m;
    }
    let s = 0;
    for (let i = a; i < ps.length && ps[i] >= lo; i++) s += book.bids.get(ps[i])!;
    return s;
  }
  const ps = book.askPrices(); // ascending
  let a = 0;
  let b = ps.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (ps[m] < lo) a = m + 1;
    else b = m;
  }
  let s = 0;
  for (let i = a; i < ps.length && ps[i] < hi; i++) s += book.asks.get(ps[i])!;
  return s;
}

/** All levels of one side grouped to `step` (bids floor, asks ceil), best first. */
export function groupBook(book: LocalBook, side: 'bid' | 'ask', step: number): { p: Float64Array; q: Float64Array } {
  const ps = side === 'bid' ? book.bidPrices() : book.askPrices();
  const map = side === 'bid' ? book.bids : book.asks;
  const P: number[] = [];
  const Q: number[] = [];
  let key = NaN;
  let acc = 0;
  for (const p of ps) {
    const k = side === 'bid' ? Math.floor(p / step + 1e-9) : Math.ceil(p / step - 1e-9);
    if (k !== key) {
      if (key === key) {
        P.push(key * step);
        Q.push(acc);
      }
      key = k;
      acc = 0;
    }
    acc += map.get(p)!;
  }
  if (key === key) {
    P.push(key * step);
    Q.push(acc);
  }
  return { p: Float64Array.from(P), q: Float64Array.from(Q) };
}

function sanitize(p: any, row: number, tfMs: number, tick = 0.01): { hvn: HvnParams | null; absorption: AbsorptionParams | null; imbalance: ImbalanceParams | null } {
  const rowOr = (v: unknown, auto = row) => (Number(v) > 0 ? Number(v) : auto);
  // footprint rows follow the bar size: a few rows per bar on second charts, coarser on hours
  const imbRow = niceStep(row * (tfMs <= 15000 ? 0.25 : tfMs <= 60000 ? 0.5 : tfMs <= 900000 ? 1 : tfMs <= 4 * HOUR ? 2 : 5), tick);
  const h = p.hvn;
  const a = p.absorption;
  const im = p.imbalance;
  const periods = [HOUR, 4 * HOUR, 8 * HOUR, 24 * HOUR];
  return {
    hvn: h
      ? {
          row: rowOr(h.row),
          periodMs: periods.includes(Number(h.periodMs)) ? Number(h.periodMs) : tfMs <= 60000 ? HOUR : tfMs <= 900000 ? 4 * HOUR : 24 * HOUR,
          periods: Math.round(num(h.periods, 2, 0, 6)),
          count: Math.round(num(h.count, 6, 1, 20)),
          strength: num(h.strength, 1.2, 1, 10),
          band: Math.round(num(h.band, 3, 1, 15)),
          untilTouched: h.untilTouched !== false,
        }
      : null,
    absorption: a
      ? {
          row: rowOr(a.row),
          quantile: num(a.quantile, 0.98, 0.5, 0.9999),
          minVolume: num(a.minVolume, 0, 0, 1e9),
          gapMs: num(a.gapMs, 3000, 200, 60000),
          holdMs: num(a.holdMs, 8000, 0, 600000),
          tolerance: Math.round(num(a.tolerance, 1, 0, 10)),
          bookOnly: !!a.bookOnly,
        }
      : null,
    imbalance: im
      ? {
          row: rowOr(im.row, imbRow),
          ratio: num(im.ratio, 3, 1.1, 100),
          stack: Math.round(num(im.stack, 3, 1, 20)),
          minVolume: num(im.minVolume, 0, 0, 1e9),
          maxLevels: Math.round(num(im.maxLevels, 10, 1, 400)),
        }
      : null,
  };
}

/** History each tool needs: absorption and imbalances a few hours (by timeframe), HVN its periods. */
export function flowWindow(now: number, tfMs: number, prm: ReturnType<typeof sanitize>, maxMs = MAX_WINDOW.spot): number {
  let from = now;
  if (prm.absorption || prm.imbalance) from = now - (tfMs <= 60000 ? 2 : tfMs <= 300000 ? 6 : tfMs <= 900000 ? 12 : 24) * HOUR;
  if (prm.hvn) from = Math.min(from, Math.floor(now / prm.hvn.periodMs) * prm.hvn.periodMs - prm.hvn.periods * prm.hvn.periodMs);
  return Math.max(from, now - maxMs);
}

export function registerOrderFlow(core: AppCore, store: TradeStore): void {
  const r = core.router;

  r.topic('orderflow', async (p: OrderFlowRequest, push) => {
    if (!isSymbol(p.symbol) || (p.market !== 'spot' && p.market !== 'futures')) throw new Error('Validation: invalid instrument');
    const market: Market = p.market;
    const symbol: SymbolId = p.symbol;
    const tf = parseTimeframe(p.tf);
    const fixed = !!tf && isFixedDuration(tf);
    const tfMs = fixed ? tfDurationMs(tf!) : 60000;
    const bucket = (t: number) => (fixed ? bucketStart(tf!, t) : t - (t % 60000));
    const spec = SYMBOL_SPECS[symbol][market];
    const { tape, release } = core.hub.acquireTape(market, symbol);
    const price = tape.lastPrice > 0 ? tape.lastPrice : core.hub.lastPrice(market, symbol) || 1;
    const prm = sanitize(p, autoRow(price, spec.tickSize), tfMs, spec.tickSize);
    const bookH = prm.absorption ? core.hub.acquireBook(market, symbol) : null;
    const probe: BookProbe | null = bookH ? (side, lo, hi) => (bookH.book.status === 'live' ? bookSum(bookH.book.book, side, lo, hi) : NaN) : null;
    const signal = { cancelled: false };
    const now = core.hub.clock.now();
    const from = flowWindow(now, tfMs, prm, MAX_WINDOW[market]);
    const histTo = now - 1500;
    const rows = { hvn: prm.hvn?.row ?? null, absorption: prm.absorption?.row ?? null, imbalance: prm.imbalance?.row ?? null };

    let eng: OrderFlowEngine | null = null;
    let maxId = -1;
    let loadedFrom = histTo;
    let complete = false;
    // live trades since the subscription began: applied after the history, replayed on each rebuild
    const live: { id: number; t: number; p: number; q: number }[] = [];
    const unlisten = tape.addListener({
      onTrade: (tr) => {
        const q = tr.m ? -tr.q : tr.q;
        if (!complete) live.push({ id: tr.id, t: tr.t, p: tr.p, q });
        if (eng && tr.id > maxId) {
          maxId = tr.id;
          eng.add(tr.t, tr.p, q);
        }
      },
    });

    let sentHvn = -1;
    let sentImb = -1;
    let sentThr = NaN;
    const state = () => ({
      hvn: eng?.hvn ? eng.hvn.levels() : undefined,
      imb: eng?.imb ? eng.imb.levels() : undefined,
      thr: eng?.abs ? eng.abs.threshold() : undefined,
    });
    /** Rebuild the analysis from the cached history [loadedFrom, histTo) and the live trades. */
    const rebuild = () => {
      const e = new OrderFlowEngine({ bucket, hvn: prm.hvn, imbalance: prm.imbalance, absorption: prm.absorption, book: null });
      let last = -1;
      store.scan(market, symbol, loadedFrom, histTo, (id, t, px, q) => {
        if (id <= last) return;
        last = id;
        e.add(t, px, q);
      });
      // the book only describes the present: history bubbles carry no resting size
      if (e.abs) e.abs.book = probe;
      for (const tr of live) {
        if (tr.id <= last) continue;
        last = tr.id;
        e.add(tr.t, tr.p, tr.q);
      }
      maxId = Math.max(maxId, last);
      e.tick(core.hub.clock.now());
      e.abs?.drain();
      eng = e;
      const s = state();
      sentHvn = e.hvn?.version ?? -1;
      sentImb = e.imb?.version ?? -1;
      sentThr = s.thr ?? NaN;
      push({ type: 'snapshot', rows, from: loadedFrom, complete, trades: e.trades, hvn: s.hvn, imb: s.imb, abs: e.abs ? e.abs.list() : undefined, thr: s.thr, source: 'Binance aggregate trades' });
    };

    const fast = setInterval(() => {
      const e = eng;
      if (!e?.abs) return;
      e.tick(core.hub.clock.now());
      e.abs.probeLive();
      const d = e.abs.drain();
      const thr = e.abs.threshold();
      if (!d.changed.length && !d.removed.length && (thr === sentThr || (!(thr === thr) && !(sentThr === sentThr)))) return;
      sentThr = thr;
      push({ type: 'update', abs: d.changed, absRemoved: d.removed, thr });
    }, 200);
    const slow = setInterval(() => {
      const e = eng;
      if (!e) return;
      const msg: Record<string, unknown> = {};
      if (e.hvn && e.hvn.version !== sentHvn) {
        sentHvn = e.hvn.version;
        msg.hvn = e.hvn.levels();
      }
      if (e.imb && e.imb.version !== sentImb) {
        sentImb = e.imb.version;
        msg.imb = e.imb.levels();
      }
      if (Object.keys(msg).length) push({ type: 'update', ...msg });
    }, 1000);

    void (async () => {
      try {
        // newest first: half an hour, then doubling spans back to the window start
        let span = HOUR / 2;
        while (loadedFrom > from && !signal.cancelled) {
          const a = Math.max(from, loadedFrom - span);
          push({ type: 'progress', done: histTo - loadedFrom, total: histTo - from, rows });
          let lastPush = 0;
          await store.get(market, symbol, a, loadedFrom, (pr) => {
            const n = Date.now();
            if (n - lastPush < 400) return;
            lastPush = n;
            push({ type: 'progress', done: histTo - loadedFrom + pr.done, total: histTo - from, trades: pr.trades, rows });
          }, signal);
          if (signal.cancelled) return;
          loadedFrom = a;
          span *= 2;
          if (loadedFrom <= from) complete = true;
          rebuild();
        }
        complete = true;
        live.length = 0;
      } catch (e) {
        complete = true;
        live.length = 0;
        if (!signal.cancelled) push({ type: 'error', message: (e as Error).message, rows });
      }
    })();

    return () => {
      signal.cancelled = true;
      clearInterval(fast);
      clearInterval(slow);
      unlisten();
      release();
      bookH?.release();
    };
  });

  r.topic('orderflow:dom', (p: { symbol: SymbolId; market: Market; step: number; intervalMs?: number }, push) => {
    if (!isSymbol(p.symbol) || (p.market !== 'spot' && p.market !== 'futures')) throw new Error('Validation: invalid instrument');
    const tick = SYMBOL_SPECS[p.symbol][p.market].tickSize;
    const step = Math.max(tick, Number(p.step) > 0 ? Math.round(Number(p.step) / tick) * tick : tick);
    const { book, release } = core.hub.acquireBook(p.market, p.symbol);
    let dirty = true;
    const unl = book.addListener({ onBook: () => (dirty = true), onStatus: () => (dirty = true) });
    const timer = setInterval(
      () => {
        if (!dirty) return;
        dirty = false;
        if (book.status !== 'live') {
          push({ t: core.hub.clock.now(), status: book.status, step, bestBid: NaN, bestAsk: NaN, bp: new Float64Array(0), bq: new Float64Array(0), ap: new Float64Array(0), aq: new Float64Array(0) });
          return;
        }
        const b = groupBook(book.book, 'bid', step);
        const a = groupBook(book.book, 'ask', step);
        push({ t: core.hub.clock.now(), status: 'live', step, bestBid: book.book.bestBid(), bestAsk: book.book.bestAsk(), bp: b.p, bq: b.q, ap: a.p, aq: a.q });
      },
      Math.max(100, Math.min(2000, Number(p.intervalMs) || 200)),
    );
    return () => {
      clearInterval(timer);
      unl();
      release();
    };
  });
}
