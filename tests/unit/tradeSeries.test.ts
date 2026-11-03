import { describe, it, expect } from 'vitest';
import { CandleSeries } from '../../src/shared/candles';
import type { TradeTick } from '../../src/shared/live';
import { parseTimeframe } from '../../src/shared/timeframes';
import { ManagedSeries, barsFromTrades, isTradeBuilt, type SeriesFeed } from '../../src/main/market/series';
import type { TapeListener } from '../../src/main/market/tape';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const tf10 = parseTimeframe('10s')!;

function genTrades(from: number, to: number, seed = 7, id0 = 1): TradeTick[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: TradeTick[] = [];
  let p = 77000;
  for (let t = from, id = id0; t < to; id++) {
    t += 50 + Math.floor(rnd() * 900);
    if (t >= to) break;
    p += Math.round((rnd() - 0.5) * 40) / 10;
    out.push({ id, t, p, q: +(0.001 + rnd()).toFixed(3), m: rnd() > 0.5 });
  }
  return out;
}

/** Reference bars: every trade of a bucket aggregated directly. */
function reference(trades: TradeTick[], ms: number) {
  const m = new Map<number, { o: number; h: number; l: number; c: number; v: number; tbv: number; n: number }>();
  for (const t of trades) {
    const b = t.t - (t.t % ms);
    const x = m.get(b);
    if (!x) m.set(b, { o: t.p, h: t.p, l: t.p, c: t.p, v: t.q, tbv: t.m ? 0 : t.q, n: 1 });
    else {
      x.h = Math.max(x.h, t.p);
      x.l = Math.min(x.l, t.p);
      x.c = t.p;
      x.v += t.q;
      x.tbv += t.m ? 0 : t.q;
      x.n++;
    }
  }
  return m;
}

function arrays(list: TradeTick[]) {
  return { id: Float64Array.from(list, (x) => x.id), t: Float64Array.from(list, (x) => x.t), p: Float64Array.from(list, (x) => x.p), q: Float64Array.from(list, (x) => (x.m ? -x.q : x.q)), length: list.length };
}

function expectBars(s: CandleSeries, ref: ReturnType<typeof reference>, from = -Infinity) {
  const keys = [...ref.keys()].filter((k) => k >= from).sort((a, b) => a - b);
  const got = Array.from({ length: s.length }, (_, i) => s.bar(i)).filter((b) => b.t >= from);
  expect(got.map((b) => b.t)).toEqual(keys);
  for (const b of got) {
    const r = ref.get(b.t)!;
    expect([b.o, b.h, b.l, b.c, b.n]).toEqual([r.o, r.h, r.l, r.c, r.n]);
    expect(b.v).toBeCloseTo(r.v, 9);
    expect(b.tbv).toBeCloseTo(r.tbv, 9);
  }
}

describe('sub-minute perpetual bars from aggregate trades', () => {
  it('only perpetual timeframes under a minute are built from trades', () => {
    expect(isTradeBuilt(tf10, 'futures')).toBe(true);
    expect(isTradeBuilt(parseTimeframe('1s')!, 'futures')).toBe(true);
    expect(isTradeBuilt(tf10, 'spot')).toBe(false);
    expect(isTradeBuilt(parseTimeframe('1m')!, 'futures')).toBe(false);
  });

  it('aggregates trades into OHLCV bars with taker-buy volume', () => {
    const tr = genTrades(T0, T0 + 120000);
    expectBars(barsFromTrades(tf10, arrays(tr)), reference(tr, 10000));
  });

  it('a chart series: cached history, the tape after the watermark, live trades, older bars on demand', async () => {
    const all = genTrades(T0 - 3 * 3600000, T0 + 90000);
    const W = T0 + 59999; // the tape's last closed 1m kline
    const pending = all.filter((x) => x.t > W && x.t <= T0 + 70000);
    const later = all.filter((x) => x.t > T0 + 70000);
    let listener: TapeListener | null = null;
    const feed: SeriesFeed = {
      baseInterval: '1m',
      kind: 'live',
      ready: async () => {},
      watermark: () => W,
      recentKlinesAfter: () => [],
      pendingTrades: () => pending,
      listen: (l) => {
        listener = l;
        return () => (listener = null);
      },
      status: () => 'live',
      release: () => {},
    };
    const asked: [number, number][] = [];
    const trades = {
      get: async (_m: string, _s: string, from: number, to: number) => {
        asked.push([from, to]);
        return arrays(all.filter((x) => x.t >= from && x.t < to));
      },
    };
    const s = new ManagedSeries({ symbol: 'BTCUSDT', market: 'futures', tf: '10s', chartType: 'candles' }, feed, {} as never, () => {}, 900, '', trades as never);
    await s.ready;
    expect(s.status).toBe('live');
    expect(s.info.construction).toMatch(/aggregate trades/);
    // the first load: half an hour up to the watermark
    expect(asked[0]).toEqual([W + 1 - 30 * 60000, W + 1]);
    const seen = all.filter((x) => x.t >= asked[0][0] && x.t <= T0 + 70000);
    expectBars(s.out, reference(seen, 10000));
    // live trades extend the forming bar and open new ones; 1m klines are not applied
    for (const t of later) listener!.onTrade!(t);
    listener!.onKline?.({ t: T0 + 60000, T: T0 + 119999, o: 1, h: 1, l: 1, c: 1, v: 1, qv: 1, n: 1, tbv: 1 });
    expectBars(s.out, reference(all.filter((x) => x.t >= asked[0][0]), 10000));
    // scrolling back loads up to an hour more per step
    expect(await s.loadMore(2000)).toBe(true);
    expect(asked[1]).toEqual([asked[0][0] - 3600000, asked[0][0]]);
    expectBars(s.out, reference(all.filter((x) => x.t >= asked[1][0]), 10000));
    // a duplicate trade from a reconnect changes nothing
    const n = s.out.length;
    const v = s.out.v[n - 1];
    listener!.onTrade!(later[later.length - 1]);
    expect(s.out.v[n - 1]).toBe(v);
    s.dispose();
  });

  it('is not available in a replay', async () => {
    const feed = { baseInterval: '1m', kind: 'replay', ready: async () => {}, watermark: () => T0, recentKlinesAfter: () => [], pendingTrades: () => [], listen: () => () => {}, status: () => 'live', release: () => {} } as SeriesFeed;
    const s = new ManagedSeries({ symbol: 'BTCUSDT', market: 'futures', tf: '10s', chartType: 'candles' }, feed, {} as never, () => {}, 900, '', { get: async () => arrays([]) } as never);
    await s.ready;
    expect(s.status).toBe('error');
    expect(s.info.error).toMatch(/replay/);
  });
});
