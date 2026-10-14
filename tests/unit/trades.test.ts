import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TradeStore } from '../../src/main/storage/tradeStore';
import { baseStep } from '../../src/main/market/footprint';
import type { TradeTick } from '../../src/shared/live';

const H = 3600000;
const T0 = Date.UTC(2026, 5, 1);

/** A synthetic exchange: one trade every 7 s with increasing ids; sells on odd ids. */
function exchange(from: number, to: number) {
  const all: TradeTick[] = [];
  let id = 1000;
  for (let t = from; t < to; t += 7000) all.push({ id: id++, t, p: 100 + (id % 13) * 0.5, q: 0.01 * (1 + (id % 5)), m: id % 2 === 1 });
  const calls: string[] = [];
  const rest = {
    aggTrades: async (_m: string, _s: string, o: { fromId?: number; startTime?: number; endTime?: number; limit?: number }) => {
      const lim = o.limit ?? 1000;
      if (o.fromId !== undefined) {
        calls.push(`id:${o.fromId}`);
        return all.filter((x) => x.id >= o.fromId!).slice(0, lim);
      }
      calls.push(`t:${o.startTime}-${o.endTime}`);
      if (o.endTime! - o.startTime! >= H) throw new Error('window too large');
      return all.filter((x) => x.t >= o.startTime! && x.t <= o.endTime!).slice(0, lim);
    },
  };
  return { all, rest, calls };
}

let dir = '';
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

describe('trade cache', () => {
  it('downloads only missing stretches, pages by id and keeps the aggressor side', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-trades-'));
    const ex = exchange(T0, T0 + 30 * H);
    const store = new TradeStore(dir, ex.rest as any);
    const a = await store.get('spot', 'BTCUSDT', T0 + 2 * H, T0 + 4 * H);
    const expected = ex.all.filter((x) => x.t >= T0 + 2 * H && x.t < T0 + 4 * H);
    expect(a.length).toBe(expected.length);
    expect(Array.from(a.id)).toEqual(expected.map((x) => x.id));
    // seller-initiated trades are stored with a negative quantity
    expect(a.q[0]).toBeCloseTo(expected[0].m ? -expected[0].q : expected[0].q, 12);
    expect(store.coverage('spot', 'BTCUSDT')).toEqual([[T0 + 2 * H, T0 + 4 * H]]);
    // overlapping request: only [4h, 5h) is fetched
    ex.calls.length = 0;
    const b = await store.get('spot', 'BTCUSDT', T0 + 3 * H, T0 + 5 * H);
    expect(ex.calls.every((c) => !c.startsWith('t:') || +c.slice(2).split('-')[0] >= T0 + 4 * H)).toBe(true);
    expect(b.length).toBe(ex.all.filter((x) => x.t >= T0 + 3 * H && x.t < T0 + 5 * H).length);
    expect(store.coverage('spot', 'BTCUSDT')).toEqual([[T0 + 2 * H, T0 + 5 * H]]);
    // a fully cached request makes no calls
    ex.calls.length = 0;
    await store.get('spot', 'BTCUSDT', T0 + 2 * H, T0 + 5 * H);
    expect(ex.calls).toEqual([]);
  });

  it('pages through busy hours (more than 1000 trades per window)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-trades-'));
    const all: TradeTick[] = [];
    for (let k = 0; k < 2500; k++) all.push({ id: k + 1, t: T0 + k * 1000, p: 50, q: 1, m: false });
    const rest = {
      aggTrades: async (_m: string, _s: string, o: any) => (o.fromId !== undefined ? all.filter((x) => x.id >= o.fromId) : all.filter((x) => x.t >= o.startTime && x.t <= o.endTime)).slice(0, 1000),
    };
    const store = new TradeStore(dir, rest as any);
    const a = await store.get('futures', 'ETHUSDT', T0, T0 + 2400 * 1000);
    expect(a.length).toBe(2400);
    expect(new Set(Array.from(a.id)).size).toBe(2400);
  });

  it('prunes old days and their coverage', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-trades-'));
    const ex = exchange(T0, T0 + 4 * 24 * H);
    const store = new TradeStore(dir, ex.rest as any, () => {}, 2);
    await store.get('spot', 'SOLUSDT', T0 + 12 * H, T0 + 3 * 24 * H + 12 * H);
    const st = store.stats().find((x) => x.symbol === 'SOLUSDT')!;
    expect(st.days).toBe(2);
    expect(store.coverage('spot', 'SOLUSDT')[0][0]).toBe(T0 + 2 * 24 * H);
  });

  it('chooses readable base price steps', () => {
    expect(baseStep(83000, 0.01)).toBe(10);
    expect(baseStep(2500, 0.01)).toBe(0.25);
    expect(baseStep(107, 0.01)).toBe(0.02);
    expect(baseStep(83000, 0.1)).toBe(10);
  });
});
