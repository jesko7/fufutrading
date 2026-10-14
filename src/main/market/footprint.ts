/**
 * Footprints: buyer- and seller-initiated volume per price level and bar, built from Binance
 * aggregate trades — history from the local trade cache, live from the shared trade tape.
 * The aggressor side comes from Binance's maker flag on every aggregate trade; nothing is
 * estimated. Bars without trade data are simply not sent (the chart shows a plain candle).
 */
import path from 'node:path';
import type { AppCore } from '../core';
import { TradeStore } from '../storage/tradeStore';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfDurationMs, bucketStart, isFixedDuration } from '../../shared/timeframes';

export interface FootprintWire {
  t: number;
  step: number;
  prices: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
}

const MAX_SPAN = 3 * 86400000;

/** Base price step: about 1 bp of the price, rounded to a nice multiple of the tick. */
export function baseStep(price: number, tick: number): number {
  const raw = Math.max(tick, price * 0.0001);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw * 0.999) || 10 * mag;
  return Math.max(tick, Math.round(nice / tick) * tick);
}

class Accum {
  levels = new Map<number, [number, number]>();
  add(level: number, q: number): void {
    let e = this.levels.get(level);
    if (!e) {
      e = [0, 0];
      this.levels.set(level, e);
    }
    if (q >= 0) e[0] += q;
    else e[1] -= q;
  }
  wire(t: number, step: number): FootprintWire {
    const keys = [...this.levels.keys()].sort((a, b) => a - b);
    return { t, step, prices: Float64Array.from(keys), buy: Float64Array.from(keys.map((k) => this.levels.get(k)![0])), sell: Float64Array.from(keys.map((k) => this.levels.get(k)![1])) };
  }
}

export function registerFootprint(core: AppCore): TradeStore {
  const store = new TradeStore(path.join(core.paths.data, 'trades'), core.hub.rest, core.log);
  const r = core.router;
  r.topic('footprint', async (p: { symbol: SymbolId; market: Market; tf: string; bars?: number }, push) => {
    if (!isSymbol(p.symbol) || (p.market !== 'spot' && p.market !== 'futures')) throw new Error('Validation: invalid instrument');
    const tf = parseTimeframe(p.tf);
    if (!tf || !isFixedDuration(tf)) throw new Error('Validation: footprints need a fixed-length timeframe (seconds to days)');
    const tfMs = tfDurationMs(tf);
    const signal = { cancelled: false };
    const spec = SYMBOL_SPECS[p.symbol][p.market];
    const now = core.hub.clock.now();
    const bars = Math.max(1, Math.min(Math.round(p.bars || 150), 1000, Math.floor(MAX_SPAN / tfMs) || 1));
    const from = bucketStart(tf, now) - (bars - 1) * tfMs;
    const { tape, release } = core.hub.acquireTape(p.market, p.symbol);
    const price = tape.lastPrice > 0 ? tape.lastPrice : core.hub.lastPrice(p.market, p.symbol) || 1;
    const step = baseStep(price, spec.tickSize);
    const acc = new Map<number, Accum>();
    const dirty = new Set<number>();
    let liveFrom = Infinity;
    let maxId = -1;
    const addTrade = (t: number, px: number, q: number) => {
      const b = bucketStart(tf, t);
      let a = acc.get(b);
      if (!a) {
        a = new Accum();
        acc.set(b, a);
      }
      a.add(Math.floor(px / step + 1e-9) * step, q);
      dirty.add(b);
    };
    // live trades are buffered until the history is in, then applied after it (no gaps, no doubles)
    const buffered: { id: number; t: number; p: number; q: number }[] = [];
    const unlisten = tape.addListener({
      onTrade: (tr) => {
        const q = tr.m ? -tr.q : tr.q;
        if (liveFrom === Infinity) buffered.push({ id: tr.id, t: tr.t, p: tr.p, q });
        else if (tr.id > maxId) {
          maxId = tr.id;
          addTrade(tr.t, tr.p, q);
        }
      },
    });
    const timer = setInterval(() => {
      if (!dirty.size || liveFrom === Infinity) return;
      const out: FootprintWire[] = [];
      for (const b of dirty) {
        const a = acc.get(b);
        if (a) out.push(a.wire(b, step));
      }
      dirty.clear();
      push({ type: 'update', bars: out });
    }, 250);
    void (async () => {
      try {
        push({ type: 'progress', done: 0, total: 1, trades: 0, step });
        const to = core.hub.clock.now() - 1500;
        let lastPush = 0;
        const hist = await store.get(p.market, p.symbol, from, to, (pr) => {
          const n = Date.now();
          if (n - lastPush < 300) return;
          lastPush = n;
          push({ type: 'progress', ...pr, step });
        }, signal);
        if (signal.cancelled) return;
        for (let i = 0; i < hist.length; i++) {
          addTrade(hist.t[i], hist.p[i], hist.q[i]);
          if (hist.id[i] > maxId) maxId = hist.id[i];
        }
        liveFrom = to;
        for (const tr of buffered) {
          if (tr.id <= maxId) continue;
          maxId = tr.id;
          addTrade(tr.t, tr.p, tr.q);
        }
        buffered.length = 0;
        dirty.clear();
        const all = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([b, a]) => a.wire(b, step));
        push({ type: 'snapshot', bars: all, step, from, trades: hist.length, source: 'Binance aggregate trades (aggressor side from the maker flag)' });
      } catch (e) {
        if (!signal.cancelled) push({ type: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      signal.cancelled = true;
      clearInterval(timer);
      unlisten();
      release();
    };
  });
  r.handle('trades:stats', () => store.stats());
  r.handle('trades:clear', ([market, symbol]) => {
    store.clear(market || undefined, symbol || undefined);
    return true;
  });
  return store;
}
