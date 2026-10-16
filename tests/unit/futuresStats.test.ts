import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CandleSeries } from '../../src/shared/candles';
import { METRIC_STEP, fundingSamples, metricBars, parseMetricsCsv, revealMetric, splitMetricSuffix } from '../../src/shared/metrics';
import { FundingCache } from '../../src/main/market/funding';
import { parseTimeframe } from '../../src/shared/timeframes';
import { CandleStore, type KlineSource } from '../../src/main/storage/candleStore';
import { MetricSeries, type MetricClock } from '../../src/main/market/metricSeries';
import { compileCached, runPine, securityRequests } from '../../src/engine/pine';
import { fromCandles } from '../../src/engine/data';
import type { RunContext } from '../../src/engine/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const tf = (s: string) => parseTimeframe(s)!;

/** Raw samples measured every 5 minutes in [a, b): oi = 1000 + k, the ratios around 1. */
function samples(a: number, b: number, f = (t: number) => 1000 + (t - a) / METRIC_STEP): CandleSeries {
  const s = new CandleSeries(64);
  for (let t = Math.ceil(a / METRIC_STEP) * METRIC_STEP; t < b; t += METRIC_STEP) s.push(t, f(t), f(t) * 50000, 1.5, 1.2, 1.1);
  return s;
}

describe('futures statistics: tickers', () => {
  it('splits TradingView-style suffixes, longest first', () => {
    expect(splitMetricSuffix('BTCUSDT.P_OI')).toEqual(['BTCUSDT.P', 'oi']);
    expect(splitMetricSuffix('BTCUSDT.P_OI_USD')).toEqual(['BTCUSDT.P', 'oiusd']);
    expect(splitMetricSuffix('ethusdt_top_lsr')).toEqual(['ethusdt', 'toplsr']);
    expect(splitMetricSuffix('SOLUSDT.P_LSR')).toEqual(['SOLUSDT.P', 'lsr']);
    expect(splitMetricSuffix('BTCUSDT.P')).toEqual(['BTCUSDT.P', null]);
  });

  it('request.security keys select the perpetual statistics', () => {
    const ctx: RunContext = { symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles', mintick: 0.01, base: 'BTC', quote: 'USDT' };
    const code = `//@version=6
indicator("x")
a = request.security("BINANCE:BTCUSDT.P_OI", "60", close)
b = request.security(syminfo.prefix + ":" + syminfo.ticker + "_OI_USD", timeframe.period, close)
c = request.security("ETHUSDT_TOP_POS", "240", close)
plot(a + b + c)`;
    const keys = securityRequests(compileCached(code), {}, ctx).map((r) => r.key);
    // a spot chart still gets the perpetual's statistics
    expect(keys).toEqual(['futures:BTCUSDT:1h:oi', 'futures:BTCUSDT:1h:oiusd', 'futures:ETHUSDT:4h:toppos']);
  });

  it('syminfo.ticker is TradingView-like: BTCUSDT.P on perpetuals', () => {
    const run = (market: 'spot' | 'futures') => {
      const ctx: RunContext = { symbol: 'BTCUSDT', market, tf: '1m', chartType: 'candles', mintick: 0.1, base: 'BTC', quote: 'USDT' };
      const t = new Float64Array([0, MIN]);
      const one = new Float64Array([1, 1]);
      const r = runPine(`//@version=6\nindicator("x")\nvar label l = label.new(bar_index, close, syminfo.ticker + "|" + syminfo.tickerid)`, { data: { t, o: one, h: one, l: one, c: one, v: one, tc: new Float64Array([MIN, 2 * MIN]), length: 2 }, ctx, inputs: {} });
      return r.labels[0]?.text;
    };
    expect(run('futures')).toBe('BTCUSDT.P|BINANCE:BTCUSDT.P');
    expect(run('spot')).toBe('BTCUSDT|BINANCE:BTCUSDT');
  });
});

describe('futures statistics: samples and bars', () => {
  it('parses daily archives: sorted, unique, measurement times, zeros dropped', () => {
    const csv = [
      'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
      '2026-10-01 00:05:00,BTCUSDT,95000.5,8000000000,1.4,2.1,1.3,0.9',
      '2026-10-01 00:00:00,BTCUSDT,94000.5,7900000000,1.41,2.11,1.31,0.8',
      '2026-10-01 00:05:00,BTCUSDT,95000.5,8000000000,1.4,2.1,1.3,0.9',
      '2026-10-01 00:10:00,BTCUSDT,0,0,1.42,,1.32,0.7',
      '',
    ].join('\n');
    const s = parseMetricsCsv(csv);
    expect(s.length).toBe(3);
    // archive rows are labelled with the start of the period; stored at its end (the REST timestamp)
    expect(s.t[0]).toBe(Date.UTC(2026, 9, 1, 0, 5));
    expect([s.o[0], s.h[0], s.l[0], s.c[0], s.v[0]]).toEqual([94000.5, 7900000000, 1.41, 2.11, 1.31]);
    expect(s.o[2]).toBeNaN();
    expect(s.c[2]).toBeNaN();
    expect(s.l[2]).toBe(1.42);
  });

  it('a sample closes the bar that ends 5 minutes after its measurement', () => {
    const a = Date.UTC(2026, 0, 1);
    const raw = samples(a, a + 3 * HOUR);
    const h1 = metricBars(raw, 'oi', tf('1h'));
    // measured 00:00 … 00:55 → usable 00:05 … 01:00 → all close the first hour
    expect(h1.t[0]).toBe(a);
    expect(h1.c[0]).toBe(1011);
    expect(h1.o[0]).toBe(1000);
    expect(h1.h[0]).toBe(1011);
    // the next bar opens at the previous close
    expect(h1.o[1]).toBe(1011);
    expect(h1.c[1]).toBe(1023);
    // 5-minute bars: the sample measured at 00:00 is the close of 00:00–00:05
    const m5 = metricBars(raw, 'oi', tf('5m'));
    expect(m5.t[0]).toBe(a);
    expect(m5.c[0]).toBe(1000);
    expect(m5.c[1]).toBe(1001);
    // other statistics come from their own slot
    expect(metricBars(raw, 'toppos', tf('1h')).c[0]).toBe(1.2);
    expect(metricBars(raw, 'oiusd', tf('1h')).c[0]).toBe(1011 * 50000);
  });

  it('missing values do not break the bars, revealing step by step equals the full build', () => {
    const a = Date.UTC(2026, 0, 1);
    const raw = samples(a, a + 6 * HOUR, (t) => 500 + Math.sin(t / 3e6) * 50);
    raw.o[7] = NaN;
    raw.o[30] = NaN;
    const full = metricBars(raw, 'oi', tf('15m'));
    const inc = new CandleSeries(16);
    let next = 0;
    for (let now = a; now <= a + 7 * HOUR; now += 7 * MIN) next = revealMetric(raw, 'oi', tf('15m'), inc, next, now).next;
    expect(Array.from(inc.c.subarray(0, inc.length))).toEqual(Array.from(full.c.subarray(0, full.length)));
    expect(Array.from(inc.h.subarray(0, inc.length))).toEqual(Array.from(full.h.subarray(0, full.length)));
    expect(full.c.subarray(0, full.length).every((x) => x > 0)).toBe(true);
  });

  it('the TradingView-style Open Interest indicator plots the statistics without lookahead', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../src/engine/library/open_interest.pine'), 'utf8');
    const ctx: RunContext = { symbol: 'BTCUSDT', market: 'futures', tf: '1h', chartType: 'candles', mintick: 0.1, base: 'BTC', quote: 'USDT' };
    const a = Date.UTC(2026, 0, 1);
    const n = 48;
    const chart = new CandleSeries(n);
    for (let i = 0; i < n; i++) chart.push(a + i * HOUR, 100, 101, 99, 100.5, 10);
    const reqs = securityRequests(compileCached(code), {}, ctx);
    expect(reqs.map((r) => r.key)).toEqual(['futures:BTCUSDT:1h:oi']);
    const oi = metricBars(samples(a - HOUR, a + n * HOUR), 'oi', tf('1h'));
    const r = runPine(code, { data: fromCandles(chart, '1h'), ctx, inputs: {}, security: { [reqs[0].key]: fromCandles(oi, '1h') } });
    expect(r.error).toBeUndefined();
    const candle = r.plots.find((p) => p.title === 'Open interest')!;
    const k = oi.lowerBound(a + 5 * HOUR);
    // the chart bar 05:00–06:00 sees the open interest bar of the same hour once both have closed
    expect(candle.values[5]).toBe(oi.c[k]);
    expect(candle.o![5]).toBe(oi.o[k]);
  });
});

describe('futures statistics: cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-stats-'));
  });

  function source(calls: { rest: [number, number][]; archive: string[] }, failDates: string[] = [], missingDates: string[] = []): KlineSource {
    return {
      restLimit: () => 1500,
      rest: async () => new CandleSeries(1),
      archive: async () => null,
      metrics: {
        rest: async (_s, start, end) => {
          calls.rest.push([start, end]);
          expect(end - start).toBeLessThanOrEqual(500 * METRIC_STEP);
          return samples(start, end);
        },
        archive: async (_s, date) => {
          calls.archive.push(date);
          if (failDates.includes(date)) throw new Error('network down');
          if (missingDates.includes(date)) return new CandleSeries(1);
          const [y, m, d] = date.split('-').map(Number);
          const day = Date.UTC(y, m - 1, d);
          // archive day D holds measurements (D, D + 1 day]
          return samples(day + METRIC_STEP, day + DAY + METRIC_STEP);
        },
      },
    };
  }

  it('uses daily archives before the 30-day REST window and REST inside it', async () => {
    const now = Date.UTC(2026, 9, 16, 13, 7, 30);
    const calls = { rest: [] as [number, number][], archive: [] as string[] };
    const store = new CandleStore(dir, source(calls), () => {}, () => now);
    const from = now - 40 * DAY;
    const s = await store.get('metrics', 'futures', 'BTCUSDT', '5m', from, now);
    // complete and unique 5-minute samples up to 10 minutes ago (newer ones may not be published yet)
    const last = Math.floor((now - 10 * MIN) / METRIC_STEP) * METRIC_STEP;
    const first = Math.ceil(from / METRIC_STEP) * METRIC_STEP;
    expect(s.length).toBe((last - first) / METRIC_STEP);
    for (let i = 1; i < s.length; i++) expect(s.t[i] - s.t[i - 1]).toBe(METRIC_STEP);
    expect(s.t[s.length - 1]).toBe(last - METRIC_STEP);
    // archives only for days that ended before the REST window
    const restFrom = Date.UTC(2026, 8, 17) + METRIC_STEP;
    // 2026-09-06 13:05 … 2026-09-17 00:05: the archives of 09-06 to 09-16
    expect(calls.archive).toEqual(Array.from({ length: 11 }, (_, k) => `2026-09-${String(6 + k).padStart(2, '0')}`));
    expect(calls.rest.every(([a]) => a >= restFrom)).toBe(true);
    // cached: nothing is downloaded again
    const n = calls.rest.length + calls.archive.length;
    await store.get('metrics', 'futures', 'BTCUSDT', '5m', from, now);
    expect(calls.rest.length + calls.archive.length).toBe(n);
  });

  it('a failed archive is retried later, an unpublished one is not', async () => {
    const now = Date.UTC(2026, 9, 16, 12);
    const calls = { rest: [] as [number, number][], archive: [] as string[] };
    const store = new CandleStore(dir, source(calls, ['2026-03-02'], ['2026-03-03']), () => {}, () => now);
    const a = Date.UTC(2026, 2, 1) + METRIC_STEP;
    const b = Date.UTC(2026, 2, 5) + METRIC_STEP;
    const s = await store.get('metrics', 'futures', 'BTCUSDT', '5m', a, b);
    expect(s.length).toBe(2 * 288);
    expect(store.missing('metrics', 'futures', 'BTCUSDT', '5m', a, b)).toEqual([[Date.UTC(2026, 2, 2) + METRIC_STEP, Date.UTC(2026, 2, 3) + METRIC_STEP]]);
    // every task failing is an error
    const store2 = new CandleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-stats-')), source(calls, ['2026-03-02']), () => {}, () => now);
    await expect(store2.get('metrics', 'futures', 'BTCUSDT', '5m', Date.UTC(2026, 2, 2) + METRIC_STEP, Date.UTC(2026, 2, 3))).rejects.toThrow(/network down/);
  });
});

describe('futures statistics: live series', () => {
  it('reveals samples at the 5-minute marks, follows polled samples and corrections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-stats-'));
    let now = Date.UTC(2026, 9, 16, 12, 3);
    const store = new CandleStore(
      dir,
      { restLimit: () => 1500, rest: async () => new CandleSeries(1), archive: async () => null, metrics: { rest: async (_s, a, b) => samples(a, b, (t) => t / METRIC_STEP), archive: async () => new CandleSeries(1) } },
      () => {},
      () => now,
    );
    let recent = samples(now - 30 * MIN, now - 2 * MIN, (t) => t / METRIC_STEP);
    let tick: (() => void) | null = null;
    const clock: MetricClock = { kind: 'live', now: () => now, ready: async () => {}, recent: () => recent, listen: (cb) => ((tick = cb), () => (tick = null)), status: () => 'live', release: () => {} };
    const ser = new MetricSeries({ symbol: 'BTCUSDT', market: 'futures', tf: '5m', chartType: 'candles', metric: 'oi' }, clock, (a, b) => store.get('metrics', 'futures', 'BTCUSDT', '5m', a, b), () => {}, 300);
    await ser.ready;
    expect(ser.status).toBe('live');
    const lastBar = () => ({ t: ser.out.t[ser.out.length - 1], c: ser.out.c[ser.out.length - 1] });
    // at 12:03 the sample measured at 11:55 closed the bar 11:55–12:00; the 12:00 sample is usable from 12:05
    expect(lastBar()).toEqual({ t: Date.UTC(2026, 9, 16, 11, 55), c: Date.UTC(2026, 9, 16, 11, 55) / METRIC_STEP });
    const updates: number[] = [];
    ser.subscribe((u) => updates.push(u.index));
    now = Date.UTC(2026, 9, 16, 12, 5, 1);
    // read lazily right after the mark
    expect(lastBar()).toEqual({ t: Date.UTC(2026, 9, 16, 12, 0), c: Date.UTC(2026, 9, 16, 12, 0) / METRIC_STEP });
    expect(ser.closedLength(now)).toBe(ser.out.length);
    await Promise.resolve();
    expect(updates.length).toBe(1);
    // a correction of a polled sample rebuilds from that bar
    recent = recent.clone();
    recent.o[recent.length - 1] = 7;
    tick!();
    expect(ser.out.c[ser.out.length - 1]).toBe(7);
    await Promise.resolve();
    expect(updates[updates.length - 1]).toBe(ser.out.length - 1);
    ser.dispose();
  });
});

describe('funding rates as data', () => {
  const H8 = 8 * HOUR;

  it('settlements in % at the second, negative rates kept, usable at the settlement', () => {
    const a = Date.UTC(2026, 0, 1);
    // Binance stamps settlements a few milliseconds after the hour
    const raw = fundingSamples([a + 1, a + H8 + 2, a + 2 * H8, a + 2 * H8 + 5], [0.0001, -0.00025, 0, 0.0003]);
    expect(Array.from(raw.t.subarray(0, raw.length))).toEqual([a, a + H8, a + 2 * H8]);
    expect(Array.from(raw.o.subarray(0, raw.length))).toEqual([0.01, -0.025, 0]);
    expect(splitMetricSuffix('BTCUSDT.P_FUNDING')).toEqual(['BTCUSDT.P', 'funding']);
    // the 08:00 settlement closes the 07:00–08:00 bar, so a strategy can use it at 08:00
    const h1 = metricBars(raw, 'funding', tf('1h'));
    const k = h1.lowerBound(a + H8 - HOUR);
    expect(h1.t[k]).toBe(a + H8 - HOUR);
    expect(h1.c[k]).toBeCloseTo(-0.025, 12);
    expect(h1.o[k]).toBeCloseTo(0.01, 12);
    // zero is a value, not a gap
    expect(h1.c[h1.length - 1]).toBe(0);
    // nothing before the settlement time
    expect(metricBars(raw, 'funding', tf('1h'), a + H8 - 1).length).toBe(1);
  });

  it('request.security keys and a Pine run of the Funding Rate indicator', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../../src/engine/library/funding_rate.pine'), 'utf8');
    const ctx: RunContext = { symbol: 'ETHUSDT', market: 'spot', tf: '1h', chartType: 'candles', mintick: 0.01, base: 'ETH', quote: 'USDT' };
    const reqs = securityRequests(compileCached(code), {}, ctx);
    expect(reqs.map((r) => r.key)).toEqual(['futures:ETHUSDT:1h:funding']);
    const a = Date.UTC(2026, 0, 1);
    const chart = new CandleSeries(48);
    for (let i = 0; i < 48; i++) chart.push(a + i * HOUR, 100, 101, 99, 100, 1);
    const f = metricBars(fundingSamples([a - H8, a, a + H8, a + 2 * H8, a + 3 * H8, a + 4 * H8], [0.0001, 0.0002, -0.0001, 0.0006, 0.0001, 0.0001]), 'funding', tf('1h'));
    const r = runPine(code, { data: fromCandles(chart, '1h'), ctx, inputs: {}, security: { [reqs[0].key]: fromCandles(f, '1h') } });
    expect(r.error).toBeUndefined();
    const plot = r.plots.find((p) => p.title === 'Funding')!;
    // between settlements the last rate holds; it changes at the bar that closes on a settlement
    expect(plot.values[5]).toBeCloseTo(0.02, 10);
    expect(plot.values[7]).toBeCloseTo(-0.01, 10);
    expect(plot.values[15]).toBeCloseTo(0.06, 10);
    // the extreme alert fires on the 0.06% settlement
    expect(r.alerts[0].values[15]).toBe(1);
  });

  it('the funding cache downloads only what is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-funding-'));
    const calls: [number, number][] = [];
    const a = Date.UTC(2026, 0, 1);
    let now = a + 10 * DAY;
    const rest = {
      fundingRates: async (_s: string, start?: number, end?: number) => {
        calls.push([start!, end!]);
        const out: { t: number; rate: number; markPrice: number }[] = [];
        for (let t = Math.ceil(start! / H8) * H8; t <= end! && t <= now; t += H8) out.push({ t: t + 3, rate: 0.0001, markPrice: NaN });
        return out;
      },
    };
    const fc = new FundingCache(dir, rest, () => now);
    const r1 = await fc.get('BTCUSDT', a, a + 5 * DAY);
    expect(r1.t.length).toBe(15);
    expect(calls.length).toBe(1);
    await fc.get('BTCUSDT', a + DAY, a + 4 * DAY);
    expect(calls.length).toBe(1);
    // later: only the new tail is fetched
    now = a + 20 * DAY;
    const r3 = await fc.get('BTCUSDT', a, a + 8 * DAY);
    expect(calls.length).toBe(2);
    expect(calls[1][0]).toBe(a + 5 * DAY);
    expect(r3.t.length).toBe(24);
  });
});
