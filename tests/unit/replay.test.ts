import { describe, it, expect } from 'vitest';
import { ReplaySession, type ReplayService } from '../../src/main/market/replay';
import { CandleSeries } from '../../src/shared/candles';
import { intervalMs } from '../../src/shared/timeframes';
import { AccountRuntime } from '../../src/shared/trading/account';
import { newAccountConfig } from '../../src/shared/trading/presets';
import type { BaseKline } from '../../src/shared/live';

const H = 3600000;
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0);
const NOW = T0 + 30 * 24 * H;

/** Deterministic klines of any interval: price is a smooth function of time. */
function price(t: number): number {
  return 100 + Math.sin(t / (7 * 60000)) * 5 + (t - T0) / (24 * H);
}
function klines(iv: string, from: number, to: number): CandleSeries {
  const ms = intervalMs(iv);
  const s = new CandleSeries(64);
  for (let t = Math.ceil(from / ms) * ms; t + ms <= to; t += ms) {
    const o = price(t);
    const c = price(t + ms);
    s.push(t, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c, 1, o, 1, 0.5);
  }
  return s;
}

function fakeService(accounts = new Map<string, AccountRuntime>()) {
  const calls: { kind: string; iv: string; from: number; to: number }[] = [];
  const svc = {
    core: {
      store: {
        get: async (kind: string, _m: string, _s: string, iv: string, from: number, to: number) => {
          calls.push({ kind, iv, from, to });
          return klines(iv, from, Math.min(to, NOW));
        },
      },
      log: () => {},
      hub: { clock: { now: () => NOW } },
    },
    engine: { accounts },
    latest: () => NOW - 2000,
    changed: () => {},
    fundingCache: { get: async () => ({ t: new Float64Array(0), rate: new Float64Array(0) }) },
  } as unknown as ReplayService;
  return { svc, calls };
}

describe('replay session', () => {
  it('reveals klines only up to the replay clock and nests them in every replayed timeframe', async () => {
    const { svc, calls } = fakeService();
    const start = T0 + 10 * 24 * H + 15 * 60000;
    const s = new ReplaySession(svc, 'main', start, 'chart1');
    const feed15 = s.feed({ symbol: 'BTCUSDT', market: 'spot', tf: '15m', chartType: 'candles' });
    const got: BaseKline[] = [];
    feed15.listen({ onKline: (k) => got.push(k) });
    expect(feed15.watermark()).toBe(start - 1);
    s.setSpeed(3600);
    // auto interval at 1 hour per second: 1m (at most ~120 klines revealed per second)
    expect(s.interval).toBe('1m');
    await s.step('15m');
    expect(s.cursor).toBe(start + 15 * 60000);
    expect(got.length).toBe(15);
    expect(got.every((k) => k.T < s.cursor && k.T - k.t === 59999)).toBe(true);
    // a 7-minute chart joins: 1m still divides it; a 90-second chart forces 1s (spot) at once
    s.feed({ symbol: 'BTCUSDT', market: 'spot', tf: '7m', chartType: 'candles' });
    expect(s.validIntervals()).toEqual(['1s', '1m']);
    s.feed({ symbol: 'BTCUSDT', market: 'spot', tf: '90s', chartType: 'candles' });
    expect(s.interval).toBe('1s');
    got.length = 0;
    await s.step('15m');
    expect(got.length).toBe(15 * 60);
    expect(got.every((k) => k.T < s.cursor)).toBe(true);
    // contiguous, no gaps, no duplicates
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBe(got[i - 1].T + 1);
    // nothing was ever requested from the cache beyond the look-ahead buffer, and the series never saw it
    expect(calls.every((c) => c.from >= start - 1)).toBe(true);
  });

  it('plays forward at the chosen speed and stops at the present', async () => {
    const { svc } = fakeService();
    const start = NOW - 2 * H;
    const s = new ReplaySession(svc, 'main', start, undefined);
    const f = s.feed({ symbol: 'ETHUSDT', market: 'futures', tf: '1h', chartType: 'candles' });
    const got: BaseKline[] = [];
    f.listen({ onKline: (k) => got.push(k) });
    s.setSpeed(3600 * 2);
    await s.step(); // one update interval, also loads data
    s.setPlaying(true);
    await new Promise((r) => setTimeout(r, 1700));
    s.setPlaying(false);
    expect(s.status).toBe('ended');
    expect(s.cursor).toBe(NOW - 2000);
    // futures reveal 1m klines at the finest
    expect(got.every((k) => k.T - k.t + 1 >= 60000)).toBe(true);
    expect(got.at(-1)!.T).toBeLessThan(s.cursor);
    s.dispose();
  });

  it('fills replay orders on replayed prices', async () => {
    const accounts = new Map<string, AccountRuntime>();
    const { svc } = fakeService(accounts);
    const start = T0 + 5 * 24 * H;
    const s = new ReplaySession(svc, 'main', start, undefined);
    s.feed({ symbol: 'BTCUSDT', market: 'spot', tf: '5m', chartType: 'candles' });
    const rt = new AccountRuntime({ ...newAccountConfig({ id: 'r1', name: 'Replay', kind: 'manual', market: 'spot', initialBalance: 10000, costPreset: 'zero' }), replay: true });
    accounts.set('r1', rt);
    s.accounts.spot = 'r1';
    await s.step('5m');
    const ctx = s.ctx();
    const px = ctx.last('spot', 'BTCUSDT');
    expect(px).toBeCloseTo(price(start + 5 * 60000), 6);
    expect(ctx.now()).toBe(s.cursor);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 10 }, ctx);
    expect(rt.ledger.position('BTCUSDT')!.qty).toBe(10);
    // a resting sell limit above the market fills when the replay reaches it
    const target = +(px + 1).toFixed(2);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', qty: 10, price: target }, ctx);
    for (let k = 0; k < 40 && rt.ledger.position('BTCUSDT'); k++) await s.step('5m');
    expect(rt.ledger.position('BTCUSDT')).toBeUndefined();
    const tr = rt.trades.at(-1)!;
    expect(tr.exit).toBeCloseTo(target, 6);
    expect(tr.closedAt).toBeLessThanOrEqual(s.cursor);
    expect(tr.closedAt).toBeGreaterThan(start);
    s.dispose();
  });
});
