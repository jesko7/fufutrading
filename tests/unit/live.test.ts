import { describe, it, expect } from 'vitest';
import { CandleSeries } from '../../src/shared/candles';
import { LiveAggregator, type TradeTick, type BaseKline } from '../../src/shared/live';
import { parseTimeframe, SEC, MIN } from '../../src/shared/timeframes';

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);


/** Reference: aggregate all trades of a bucket directly. */
function reference(trades: TradeTick[], tfMs: number) {
  const m = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const t of [...trades].sort((a, b) => a.t - b.t || a.id - b.id)) {
    const b = Math.floor(t.t / tfMs) * tfMs;
    const x = m.get(b);
    if (!x) m.set(b, { o: t.p, h: t.p, l: t.p, c: t.p, v: t.q });
    else {
      x.h = Math.max(x.h, t.p);
      x.l = Math.min(x.l, t.p);
      x.c = t.p;
      x.v += t.q;
    }
  }
  return m;
}

function genTrades(n: number, seed = 1): TradeTick[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: TradeTick[] = [];
  let p = 100;
  let t = T0;
  for (let i = 0; i < n; i++) {
    t += Math.floor(rnd() * 400);
    p += (rnd() - 0.5) * 0.4;
    out.push({ id: 1000 + i, t, p: +p.toFixed(2), q: +(rnd() * 2).toFixed(3), m: rnd() > 0.5 });
  }
  return out;
}

/** Build closed 1s klines from trades (what Binance would send). */
function klinesFromTrades(trades: TradeTick[], from: number, to: number): BaseKline[] {
  const out: BaseKline[] = [];
  for (let t = from; t < to; t += SEC) {
    const ts = trades.filter((x) => x.t >= t && x.t < t + SEC);
    if (!ts.length) continue; // keep it simple: skip empty seconds
    const o = ts[0].p;
    let h = o;
    let l = o;
    let v = 0;
    let tbv = 0;
    for (const x of ts) {
      h = Math.max(h, x.p);
      l = Math.min(l, x.p);
      v += x.q;
      if (!x.m) tbv += x.q;
    }
    out.push({ t, T: t + SEC - 1, o, h, l, c: ts[ts.length - 1].p, v, qv: 0, n: ts.length, tbv });
  }
  return out;
}

describe('LiveAggregator', () => {
  const tf = parseTimeframe('30s')!;

  it('builds candles from trades only', () => {
    const trades = genTrades(300);
    const agg = new LiveAggregator(tf, new CandleSeries(), T0 - 1);
    for (const t of trades) agg.applyTrade(t);
    const ref = reference(trades, 30 * SEC);
    expect(agg.series.length).toBe(ref.size);
    for (let i = 0; i < agg.series.length; i++) {
      const r = ref.get(agg.series.t[i])!;
      expect(agg.series.o[i]).toBe(r.o);
      expect(agg.series.h[i]).toBe(r.h);
      expect(agg.series.l[i]).toBe(r.l);
      expect(agg.series.c[i]).toBe(r.c);
      expect(agg.series.v[i]).toBeCloseTo(r.v, 9);
    }
  });

  it('is unaffected by duplicate trades', () => {
    const trades = genTrades(200, 7);
    const a = new LiveAggregator(tf, new CandleSeries(), T0 - 1);
    const b = new LiveAggregator(tf, new CandleSeries(), T0 - 1);
    for (const t of trades) {
      a.applyTrade(t);
      b.applyTrade(t);
      b.applyTrade({ ...t }); // duplicate
    }
    expect(b.series.pack()).toEqual(a.series.pack());
  });

  it('reconciles with authoritative base klines and drops covered trades', () => {
    const trades = genTrades(400, 3);
    const klines = klinesFromTrades(trades, T0, trades[trades.length - 1].t - 5 * SEC);
    const agg = new LiveAggregator(tf, new CandleSeries(), T0 - 1);
    // interleave: trades arrive first, klines shortly after their second closes
    let ki = 0;
    for (const t of trades) {
      while (ki < klines.length && klines[ki].T < t.t - 800) agg.applyBaseKline(klines[ki++]);
      agg.applyTrade(t);
    }
    while (ki < klines.length) agg.applyBaseKline(klines[ki++]);
    const ref = reference(trades, 30 * SEC);
    for (let i = 0; i < agg.series.length; i++) {
      const r = ref.get(agg.series.t[i])!;
      expect(agg.series.o[i]).toBe(r.o);
      expect(agg.series.h[i]).toBe(r.h);
      expect(agg.series.l[i]).toBe(r.l);
      expect(agg.series.c[i]).toBe(r.c);
      expect(agg.series.v[i]).toBeCloseTo(r.v, 9);
    }
  });

  it('heals a missed trade once the base kline closes', () => {
    const trades = genTrades(120, 11);
    const klines = klinesFromTrades(trades, T0, T0 + 20 * SEC);
    const agg = new LiveAggregator(tf, new CandleSeries(), T0 - 1);
    const missing = trades[10];
    for (const t of trades) if (t !== missing) agg.applyTrade(t);
    expect(agg.degraded).toBe(true);
    for (const k of klines) agg.applyBaseKline(k);
    expect(agg.degraded).toBe(false);
    const ref = reference(trades, 30 * SEC);
    const r = ref.get(agg.series.t[0])!;
    expect(agg.series.v[0]).toBeCloseTo(r.v, 9);
    expect(agg.series.h[0]).toBe(r.h);
  });

  it('handles late (out-of-order) trades by recomputing the bucket', () => {
    const tf1m = parseTimeframe('1m')!;
    const agg = new LiveAggregator(tf1m, new CandleSeries(), T0 - 1);
    agg.applyTrade({ id: 1, t: T0 + 1000, p: 10, q: 1, m: false });
    agg.applyTrade({ id: 3, t: T0 + 3000, p: 12, q: 1, m: false });
    // id 2 arrives late with an earlier timestamp
    agg.applyTrade({ id: 2, t: T0 + 2000, p: 9, q: 1, m: true });
    // id 2 < lastTradeId -> treated as duplicate by design (tape guarantees id order)
    expect(agg.series.l[0]).toBe(10);
    // a trade with higher id but earlier time (exchange clock skew) is merged correctly
    agg.applyTrade({ id: 4, t: T0 + 500, p: 8, q: 1, m: true });
    expect(agg.series.o[0]).toBe(8);
    expect(agg.series.c[0]).toBe(12);
    expect(agg.series.l[0]).toBe(8);
  });

  it('continues seamlessly from history', () => {
    const tf1m = parseTimeframe('1m')!;
    const hist = new CandleSeries();
    hist.push(T0 - MIN, 1, 2, 0.5, 1.5, 10);
    hist.push(T0, 1.5, 1.6, 1.4, 1.55, 3); // partial bucket covering up to watermark
    const W = T0 + 20 * SEC - 1;
    const agg = new LiveAggregator(tf1m, hist, W);
    agg.applyTrade({ id: 1, t: T0 + 19 * SEC, p: 99, q: 1, m: false }); // before watermark -> ignored
    agg.applyTrade({ id: 2, t: T0 + 25 * SEC, p: 1.7, q: 2, m: false });
    expect(agg.series.length).toBe(2);
    expect(agg.series.h[1]).toBe(1.7);
    expect(agg.series.c[1]).toBe(1.7);
    expect(agg.series.v[1]).toBe(5);
    agg.applyTrade({ id: 3, t: T0 + MIN + 1, p: 1.8, q: 1, m: false });
    expect(agg.series.length).toBe(3);
    expect(agg.series.o[2]).toBe(1.8);
  });
});
