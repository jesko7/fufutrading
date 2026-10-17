import { describe, it, expect } from 'vitest';
import { accountGreeks, alignedDailyReturns, computeGreeks, randomBenchmark, type RandomBenchmarkTrade } from '../../src/engine/backtest/benchmarks';

const DAY = 86400000;
const HOUR = 3600000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hourly random walk with a little drift. */
function walk(n: number, seed = 3) {
  const r = rng(seed);
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const c = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    t[i] = Date.UTC(2025, 0, 1) + i * HOUR;
    o[i] = p;
    p *= 1 + (r() - 0.5) * 0.02;
    c[i] = p;
  }
  return { t, o, c };
}

/** Run trades on bar opens with a cost per side; returns per-bar equity. */
function equityOf(o: Float64Array, c: Float64Array, trades: RandomBenchmarkTrade[], init: number, cost: number) {
  const eq = new Float64Array(c.length).fill(init);
  let realized = 0;
  for (let i = 0; i < c.length; i++) {
    let open = 0;
    for (const tr of trades) {
      if (tr.exitBar <= i) continue;
      if (tr.entryBar <= i) open += tr.qty * tr.dir * (c[i] - tr.entryPrice) - tr.qty * tr.entryPrice * cost;
    }
    realized = trades.filter((tr) => tr.exitBar <= i).reduce((a, tr) => a + tr.profit, 0);
    eq[i] = init + realized + open;
  }
  return eq;
}

function mkTrades(o: Float64Array, spans: [number, number, 1 | -1][], notional: number, cost: number): RandomBenchmarkTrade[] {
  return spans.map(([e, x, dir]) => {
    const qty = notional / o[e];
    const entryPrice = o[e];
    const exitPrice = o[x];
    const profit = qty * dir * (exitPrice - entryPrice) - qty * entryPrice * cost - qty * exitPrice * cost;
    return { entryBar: e, exitBar: x, dir, qty, entryPrice, exitPrice, profit };
  });
}

describe('Greeks', () => {
  it('measures beta, correlation and alpha of a levered copy of the benchmark', () => {
    const r = rng(1);
    const rb = Array.from({ length: 400 }, () => (r() - 0.5) * 0.04);
    const ra = rb.map((x) => 2 * x + 0.001);
    const g = computeGreeks(ra, rb)!;
    expect(g.beta).toBeCloseTo(2, 9);
    expect(g.correlation).toBeCloseTo(1, 9);
    expect(g.rSquared).toBeCloseTo(1, 9);
    expect(g.alpha).toBeCloseTo(0.001 * 365 * 100, 6);
    expect(g.sigma).toBeCloseTo(2 * g.benchSigma, 6);
    expect(g.upCapture).toBeGreaterThan(200);
    expect(g.downCapture).toBeLessThan(200);
    expect(g.downsideBeta).toBeCloseTo(2, 6);
  });

  it('finds no beta for returns unrelated to the benchmark', () => {
    const r1 = rng(2);
    const r2 = rng(9);
    const rb = Array.from({ length: 3000 }, () => (r1() - 0.5) * 0.04);
    const ra = Array.from({ length: 3000 }, () => (r2() - 0.5) * 0.02);
    const g = computeGreeks(ra, rb)!;
    expect(Math.abs(g.beta)).toBeLessThan(0.08);
    expect(Math.abs(g.correlation)).toBeLessThan(0.08);
    expect(g.var95).toBeGreaterThan(0);
    expect(g.cvar95).toBeGreaterThanOrEqual(g.var95);
    expect(Math.abs(g.skew)).toBeLessThan(0.2);
    expect(g.kurtosis).toBeLessThan(-1); // uniform distribution: excess kurtosis −1.2
  });

  it('aligns daily returns of two curves on the same days', () => {
    const t = Array.from({ length: 72 }, (_, i) => Date.UTC(2025, 0, 1) + i * HOUR);
    const a = t.map((_, i) => 100 + i);
    const b = t.map(() => 50);
    const { ra, rb } = alignedDailyReturns(t, a, b);
    expect(ra.length).toBe(rb.length);
    expect(ra.length).toBe(3);
    expect(ra[0]).toBeCloseTo(123 / 100 - 1, 12);
    expect(rb.every((x) => x === 0)).toBe(true);
    expect(computeGreeks([0.01, 0.02], [0.01, 0.02])).toBeNull();
    void DAY;
  });
});

describe('random counterparts', () => {
  const n = 3000;
  const { t, o, c } = walk(n);
  const init = 10000;
  const cost = 0.0005;

  it('a strategy with perfect foresight beats nearly all random twins', () => {
    // go long for 6 bars whenever the next 6 bars rise, short when they fall (non-overlapping)
    const spans: [number, number, 1 | -1][] = [];
    for (let e = 100; e + 6 < n - 1; e += 20) spans.push([e, e + 6, o[e + 6] > o[e] ? 1 : -1]);
    const trades = mkTrades(o, spans, 5000, cost);
    const eq = equityOf(o, c, trades, init, cost);
    const rb = randomBenchmark({ t, o, c, from: 0, to: n - 1, trades, equity: eq, initialCapital: init, costPerSide: cost, iterations: 400, seed: 5 })!;
    expect(rb.trades).toBe(trades.length);
    expect(rb.timing.beats.returnPct).toBeGreaterThan(99);
    expect(rb.timing.pReturn).toBeLessThan(0.01);
    expect(rb.direction).not.toBeNull();
    expect(rb.direction!.beats.returnPct).toBeGreaterThan(99);
    expect(rb.verdict.level).toBe('strong');
    // bands are ordered and the curve has the display length
    const d = rb.curves.t.length;
    expect(rb.curves.p5.length).toBe(d);
    for (let i = 0; i < d; i++) expect(rb.curves.p5[i]).toBeLessThanOrEqual(rb.curves.p95[i]);
    expect(rb.curves.strategy[d - 1]).toBeCloseTo((eq[n - 1] / init - 1) * 100, 1);
  });

  it('random entries are not mistaken for an edge', () => {
    const r = rng(42);
    const spans: [number, number, 1 | -1][] = [];
    for (let e = 50; e + 8 < n - 1; e += 25 + Math.floor(r() * 10)) spans.push([e, e + 8, 1]);
    const trades = mkTrades(o, spans, 5000, cost);
    const eq = equityOf(o, c, trades, init, cost);
    const rb = randomBenchmark({ t, o, c, from: 0, to: n - 1, trades, equity: eq, initialCapital: init, costPerSide: cost, iterations: 400, seed: 5 })!;
    expect(rb.timing.pReturn).toBeGreaterThan(0.02);
    expect(['none', 'weak', 'worse']).toContain(rb.verdict.level);
    // long-only: no direction test
    expect(rb.direction).toBeNull();
    expect(rb.notes.join(' ')).toMatch(/only goes long/);
  });

  it('random twins pay the same costs: on a flat market they lose about the fees', () => {
    const flat = { t, o: new Float64Array(n).fill(100), c: new Float64Array(n).fill(100) };
    const spans: [number, number, 1 | -1][] = [];
    for (let e = 10; e + 5 < n - 1; e += 30) spans.push([e, e + 5, 1]);
    const trades = mkTrades(flat.o, spans, 5000, cost);
    const eq = equityOf(flat.o, flat.c, trades, init, cost);
    const rb = randomBenchmark({ ...flat, from: 0, to: n - 1, trades, equity: eq, initialCapital: init, costPerSide: cost, iterations: 200 })!;
    const fees = trades.length * 5000 * cost * 2;
    expect(rb.timing.random.returnPct.p50).toBeCloseTo((-fees / init) * 100, 6);
    expect(rb.timing.strategy.returnPct).toBeCloseTo((-fees / init) * 100, 6);
  });

  it('handles overlapping (pyramiding) trades and open trades', () => {
    const spans: [number, number, 1 | -1][] = [];
    for (let e = 100; e + 200 < n - 1; e += 60) spans.push([e, e + 200, 1]);
    spans.push([n - 50, n - 1, 1]);
    const trades = mkTrades(o, spans, 1000, cost);
    const eq = equityOf(o, c, trades, init, cost);
    const rb = randomBenchmark({ t, o, c, from: 0, to: n - 1, trades, openCount: 1, equity: eq, initialCapital: init, costPerSide: cost, iterations: 200 })!;
    expect(rb.overlapping).toBe(true);
    expect(rb.timing.iterations).toBe(200);
    expect(Number.isFinite(rb.timing.random.returnPct.p50)).toBe(true);
    expect(rb.notes.join(' ')).toMatch(/several positions/);
    expect(rb.notes.join(' ')).toMatch(/open trade/);
  });

  it('returns null without trades', () => {
    expect(randomBenchmark({ t, o, c, from: 0, to: n - 1, trades: [], equity: new Float64Array(n).fill(init), initialCapital: init, costPerSide: cost })).toBeNull();
  });
});

describe('trade-order Monte Carlo', () => {
  it('keeps the result when reordering and widens the range when resampling', async () => {
    const { tradeMonteCarlo } = await import('../../src/engine/backtest/benchmarks');
    // ten +2% trades then five -3% trades: the backtest order has a late drawdown
    const r = [...Array(10).fill(0.02), ...Array(5).fill(-0.03)];
    const mc = tradeMonteCarlo(r, 1000, 3)!;
    expect(mc.trades).toBe(15);
    expect(mc.actualMaxDrawdownPct).toBeCloseTo((1 - 0.97 ** 5) * 100, 9);
    // reordering never gives a deeper drawdown than all losses in a row, and on average a shallower one
    expect(mc.shuffled.maxDrawdownPct.p95).toBeLessThanOrEqual(mc.actualMaxDrawdownPct + 1e-9);
    expect(mc.shuffled.maxDrawdownPct.p50).toBeLessThan(mc.actualMaxDrawdownPct);
    expect(mc.resampled.returnPct.p5).toBeLessThan(mc.resampled.returnPct.p95);
    expect(mc.resampled.probLossPct).toBeGreaterThan(0);
    expect(mc.ddOver.map((d) => d.level)).toEqual([10, 20, 30, 50]);
    expect(tradeMonteCarlo([0.01, 0.02])).toBeNull();
  });
});

describe('account Greeks', () => {
  it('compares end-of-day equity with the same days of the benchmark, gaps included', () => {
    const DAY = 86400000;
    const t0 = Date.UTC(2026, 8, 1);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const closes: { t: number; c: number }[] = [];
    let px = 100;
    for (let d = 0; d < 40; d++) {
      px *= 1 + rnd() * 0.06;
      closes.push({ t: t0 + d * DAY, c: px });
    }
    // an account holding twice its equity in the coin, rebalanced daily: samples during each
    // day, the last one at the close
    const equity: [number, number, number][] = [];
    let eq = 10000;
    for (let d = 0; d < 40; d++) {
      if (d > 0) eq *= 1 + 2 * (closes[d].c / closes[d - 1].c - 1);
      if (d >= 10 && d < 13) continue; // the app was closed for three days
      equity.push([t0 + d * DAY + 3600000, 1, 1]); // an intraday sample, superseded by the later one
      equity.push([t0 + d * DAY + 23 * 3600000, eq, 0]);
    }
    const res = accountGreeks(equity, closes);
    expect(res.days).toBe(36);
    expect(res.from).toBe(t0);
    // exactly 2x on consecutive days; the one three-day gap compounds slightly differently
    expect(res.greeks!.beta).toBeGreaterThan(1.95);
    expect(res.greeks!.beta).toBeLessThan(2.05);
    expect(res.greeks!.correlation).toBeGreaterThan(0.999);
    expect(accountGreeks(equity.slice(0, 8), closes).greeks).toBeNull();
  });
});
