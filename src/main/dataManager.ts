/**
 * Data manager: what is cached locally (candles by interval, mark-price candles, futures
 * statistics, aggregate trades), coverage and gaps, disk use, prefetching ranges for offline
 * backtests and replays, and cleanup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { AppCore } from './core';
import type { TradeStore } from './storage/tradeStore';
import type { CandleKind } from './storage/candleStore';
import { isSymbol, type Market, type SymbolId } from '../shared/symbols';
import { intervalMs } from '../shared/timeframes';
import { METRICS_EPOCH } from '../shared/metrics';

const KINDS: CandleKind[] = ['klines', 'mark', 'metrics'];
const kindOf = (k: unknown): CandleKind => (KINDS.includes(k as CandleKind) ? (k as CandleKind) : 'klines');

export interface CacheEntry {
  kind: CandleKind;
  market: Market;
  symbol: SymbolId;
  interval: string;
  ranges: [number, number][];
  bytes: number;
  /** Gaps between cached ranges (not downloaded yet). */
  gaps: number;
}

const INTERVALS = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

function dirSize(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) n += f.isDirectory() ? dirSize(path.join(dir, f.name)) : fs.statSync(path.join(dir, f.name)).size;
  } catch {
    /* missing */
  }
  return n;
}

export function registerDataManager(core: AppCore, trades: TradeStore): void {
  const r = core.router;
  const store = core.store;
  const overview = (): { root: string; entries: CacheEntry[]; trades: ReturnType<TradeStore['stats']>; totalBytes: number } => {
    const entries: CacheEntry[] = [];
    const base = path.join(store.root, 'candles');
    for (const kind of KINDS) {
      for (const market of ['spot', 'futures'] as Market[]) {
        const md = path.join(base, kind, market);
        if (!fs.existsSync(md)) continue;
        for (const symbol of fs.readdirSync(md)) {
          if (!isSymbol(symbol)) continue;
          for (const interval of fs.readdirSync(path.join(md, symbol))) {
            const st = store.stats(kind, market, symbol, interval);
            if (!st.ranges.length && !st.bytes) continue;
            entries.push({ kind, market, symbol, interval, ranges: st.ranges, bytes: st.bytes, gaps: Math.max(0, st.ranges.length - 1) });
          }
        }
      }
    }
    entries.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.market.localeCompare(b.market) || INTERVALS.indexOf(a.interval) - INTERVALS.indexOf(b.interval));
    return { root: core.paths.data, entries, trades: trades.stats(), totalBytes: dirSize(core.paths.data) };
  };
  r.handle('data:overview', () => overview());
  r.handle('data:clear', ([kind, market, symbol, interval]) => {
    if (!isSymbol(symbol)) throw new Error('Validation: unsupported symbol');
    store.clear(kindOf(kind), market === 'futures' ? 'futures' : 'spot', symbol, String(interval));
    return true;
  });
  r.handle('data:openFolder', () => shell.openPath(core.paths.data));
  /** Prefetch a range (progress pushed while downloading). */
  r.topic('data:download', (p: { kind?: CandleKind; market: Market; symbol: SymbolId; interval: string; from: number; to: number }, push) => {
    let cancelled = false;
    void (async () => {
      try {
        if (!isSymbol(p.symbol) || (p.market !== 'spot' && p.market !== 'futures')) throw new Error('invalid instrument');
        if (!INTERVALS.includes(p.interval)) throw new Error('invalid interval');
        if (p.interval === '1s' && p.market === 'futures') throw new Error('Binance has no 1s klines for futures');
        const kind = kindOf(p.kind);
        if (kind === 'metrics' && (p.market !== 'futures' || p.interval !== '5m')) throw new Error('futures statistics are 5-minute samples of the perpetuals');
        const to = Math.min(Number(p.to) || Date.now(), core.hub.clock.now());
        const from = Math.max(Number(p.from) || 0, kind === 'metrics' ? METRICS_EPOCH : Date.UTC(2017, 6, 1));
        if (!(to > from)) throw new Error('empty range');
        const bars = (to - from) / intervalMs(p.interval);
        if (bars > 5_000_000) throw new Error('range too large for this interval (more than 5 million candles)');
        await store.get(kind, p.market, p.symbol, p.interval, from, to, (pr) => !cancelled && push({ type: 'progress', ...pr }));
        if (!cancelled) push({ type: 'done' });
      } catch (e) {
        if (!cancelled) push({ type: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  });
}
