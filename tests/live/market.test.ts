import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarketHub } from '../../src/main/market/hub';
import { CandleStore, binanceKlineSource } from '../../src/main/storage/candleStore';
import { SeriesService } from '../../src/main/market/series';
import type { SeriesUpdate } from '../../src/shared/marketTypes';
import { FundingCache } from '../../src/main/market/funding';

const logs: string[] = [];
const log = (level: string, msg: string) => logs.push(`${level} ${msg}`);
const hub = new MarketHub(log);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-live-'));
const store = new CandleStore(dir, binanceKlineSource(hub.rest), log);
const series = new SeriesService(hub, store, log, new FundingCache(path.join(dir, 'funding'), hub.rest));

afterAll(() => {
  hub.shutdown();
  if (logs.some((l) => l.startsWith('error'))) console.log(logs.join('\n'));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('live market data', () => {
  it('builds a live 30s spot series that matches Binance 1s klines', async () => {
    const { series: s, release } = series.acquire({ symbol: 'BTCUSDT', market: 'spot', tf: '30s', chartType: 'candles' }, { bars: 200 });
    await s.ready;
    expect(s.status).not.toBe('error');
    expect(s.out.length).toBeGreaterThan(100);
    const updates: SeriesUpdate[] = [];
    const unsub = s.subscribe((u) => updates.push(u));
    await wait(7000);
    unsub();
    expect(updates.length).toBeGreaterThan(3);
    // verify the last fully closed 30s candle against REST 1s klines (authoritative)
    const out = s.out;
    const i = out.length - 2;
    const t0 = out.t[i];
    const ks = await hub.rest.klines('spot', 'BTCUSDT', '1s', { startTime: t0, endTime: t0 + 29_999, limit: 30 });
    let h = -Infinity;
    let l = Infinity;
    let v = 0;
    for (let k = 0; k < ks.length; k++) {
      h = Math.max(h, ks.h[k]);
      l = Math.min(l, ks.l[k]);
      v += ks.v[k];
    }
    expect(out.o[i]).toBe(ks.o[0]);
    expect(out.c[i]).toBe(ks.c[ks.length - 1]);
    expect(out.h[i]).toBe(h);
    expect(out.l[i]).toBe(l);
    expect(out.v[i]).toBeCloseTo(v, 6);
    release();
  });

  it('builds futures 1m and Heikin-Ashi series', async () => {
    const a = series.acquire({ symbol: 'ETHUSDT', market: 'futures', tf: '1m', chartType: 'candles' }, { bars: 300 });
    const b = series.acquire({ symbol: 'ETHUSDT', market: 'futures', tf: '1m', chartType: 'heikinashi' }, { bars: 300 });
    await Promise.all([a.series.ready, b.series.ready]);
    expect(a.series.status).not.toBe('error');
    expect(b.series.out.length).toBe(a.series.out.length);
    const n = a.series.out.length - 1;
    expect(b.series.out.c[n]).toBeCloseTo((a.series.out.o[n] + a.series.out.h[n] + a.series.out.l[n] + a.series.out.c[n]) / 4, 8);
    a.release();
    b.release();
  });

  it('reports an honest error for sub-minute futures timeframes', async () => {
    const { series: s, release } = series.acquire({ symbol: 'SOLUSDT', market: 'futures', tf: '15s', chartType: 'candles' });
    await s.ready;
    expect(s.status).toBe('error');
    expect(s.info.error).toMatch(/futures/);
    release();
  });

  it('syncs the spot and futures order books', async () => {
    const sp = hub.acquireBook('spot', 'SOLUSDT');
    const fu = hub.acquireBook('futures', 'SOLUSDT');
    const t0 = Date.now();
    while ((sp.book.status !== 'live' || fu.book.status !== 'live') && Date.now() - t0 < 20000) await wait(100);
    expect(sp.book.status).toBe('live');
    expect(fu.book.status).toBe('live');
    await wait(3000);
    for (const b of [sp.book, fu.book]) {
      const snap = b.snapshot(0, 10, { method: 'depthPct', param: 0.5 });
      expect(snap.bids.length).toBe(10);
      expect(snap.metrics.bestBid).toBeLessThan(snap.metrics.bestAsk);
      expect(Math.abs(snap.metrics.imbalance)).toBeLessThanOrEqual(1);
      expect(b.heatmap.length).toBeGreaterThan(0);
    }
    sp.release();
    fu.release();
  });
});
