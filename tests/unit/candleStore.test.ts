import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CandleStore, addRange, subtractRanges, type KlineSource } from '../../src/main/storage/candleStore';
import { CandleSeries } from '../../src/shared/candles';
import { MIN } from '../../src/shared/timeframes';

function synthetic(from: number, to: number, ms: number): CandleSeries {
  const s = new CandleSeries();
  for (let t = Math.ceil(from / ms) * ms; t < to; t += ms) s.push(t, t / 1e9, t / 1e9 + 1, t / 1e9 - 1, t / 1e9 + 0.5, 1, 1, 1, 0.5);
  return s;
}

function mockSource(calls: { rest: number; archive: number }): KlineSource {
  return {
    restLimit: () => 1000,
    rest: async (_k, _m, _s, interval, start, end, limit) => {
      calls.rest++;
      const ms = interval === '1m' ? MIN : interval === '1h' ? 60 * MIN : 1000;
      const s = synthetic(start, end + 1, ms);
      return s.slice(0, limit);
    },
    archive: async (_k, _m, _s, interval, period, date) => {
      calls.archive++;
      const ms = interval === '1m' ? MIN : 1000;
      const [y, mo, d] = date.split('-').map(Number);
      const a = period === 'monthly' ? Date.UTC(y, mo - 1, 1) : Date.UTC(y, mo - 1, d);
      const b = period === 'monthly' ? Date.UTC(y, mo, 1) : a + 86400000;
      return synthetic(a, b, ms);
    },
  };
}

describe('range helpers', () => {
  it('adds and merges ranges', () => {
    let r: [number, number][] = [];
    r = addRange(r, [10, 20]);
    r = addRange(r, [30, 40]);
    r = addRange(r, [20, 30]);
    expect(r).toEqual([[10, 40]]);
  });
  it('subtracts coverage', () => {
    expect(subtractRanges([0, 100], [[10, 20], [50, 60]])).toEqual([[0, 10], [20, 50], [60, 100]]);
    expect(subtractRanges([0, 100], [[0, 100]])).toEqual([]);
  });
});

describe('CandleStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-store-'));
  });

  it('downloads only missing ranges and reads them back', async () => {
    const calls = { rest: 0, archive: 0 };
    const store = new CandleStore(dir, mockSource(calls));
    const a = Date.UTC(2025, 0, 10);
    const b = a + 3000 * MIN;
    const s1 = await store.get('klines', 'spot', 'BTCUSDT', '1m', a, b);
    expect(s1.length).toBe(3000);
    const restAfterFirst = calls.rest;
    expect(restAfterFirst).toBeGreaterThan(0);
    // fully cached now
    const s2 = await store.get('klines', 'spot', 'BTCUSDT', '1m', a + 100 * MIN, b - 100 * MIN);
    expect(calls.rest).toBe(restAfterFirst);
    expect(s2.length).toBe(2800);
    expect(s2.t[0]).toBe(a + 100 * MIN);
    // extend: only the extension is fetched
    await store.get('klines', 'spot', 'BTCUSDT', '1m', a, b + 500 * MIN);
    expect(calls.rest).toBe(restAfterFirst + 1);
    const cov = store.coverage('klines', 'spot', 'BTCUSDT', '1m');
    expect(cov).toEqual([[a, b + 500 * MIN]]);
  });

  it('uses monthly archives for large historical gaps', async () => {
    const calls = { rest: 0, archive: 0 };
    const store = new CandleStore(dir, mockSource(calls));
    const a = Date.UTC(2024, 0, 1);
    const b = Date.UTC(2024, 3, 1);
    const s = await store.get('klines', 'spot', 'ETHUSDT', '1m', a, b);
    expect(calls.archive).toBe(3);
    expect(s.length).toBe((b - a) / MIN);
    for (let i = 1; i < s.length; i++) expect(s.t[i] - s.t[i - 1]).toBe(MIN);
  });

  it('never caches the forming candle', async () => {
    const calls = { rest: 0, archive: 0 };
    const store = new CandleStore(dir, mockSource(calls));
    const now = Date.now();
    await store.get('klines', 'spot', 'SOLUSDT', '1m', now - 30 * MIN, now + 5 * MIN);
    const cov = store.coverage('klines', 'spot', 'SOLUSDT', '1m');
    expect(cov[0][1]).toBeLessThanOrEqual(Math.floor(now / MIN) * MIN);
  });
});
