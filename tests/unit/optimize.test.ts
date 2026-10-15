import { describe, it, expect } from 'vitest';
import { gridSize, gridPoints, neighbours, spaceFromInputs, pointKey, type ParamDef } from '../../src/engine/optimize/space';
import { makeSearcher, paretoRanks, type Trial } from '../../src/engine/optimize/search';
import { neighbourStats, walkForwardWindows, purgedKFold, segmentScore, deflatedSharpe, holm, bootstrapTrades, randomEntryTest, pbo, normCdf, normInv, score, type CompactTrade } from '../../src/engine/optimize/analysis';

const SPACE: ParamDef[] = [
  { key: 'a', kind: 'int', min: 1, max: 20, step: 1 },
  { key: 'b', kind: 'int', min: 0, max: 50, step: 5 },
  { key: 'c', kind: 'bool' },
];

// smooth objective with a broad optimum at a=12, b=30, c=true
const f = (p: Record<string, unknown>) => -((Number(p.a) - 12) ** 2) - ((Number(p.b) - 30) / 5) ** 2 + (p.c ? 3 : 0);

function drive(method: 'grid' | 'random' | 'bayes' | 'genetic', budget: number) {
  const s = makeSearcher(method, SPACE, budget, 42);
  const seen = new Set<string>();
  let best = -Infinity;
  let evals = 0;
  while (!s.done()) {
    const batch = s.ask(8);
    if (!batch.length) break;
    const trials: Trial[] = batch.map((p) => {
      const k = pointKey(SPACE, p);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      evals++;
      const v = f(p);
      best = Math.max(best, v);
      return { point: p, key: k, score: v };
    });
    s.tell(trials);
  }
  return { best, evals };
}

describe('optimizer: spaces and search', () => {
  it('enumerates grids and neighbours', () => {
    expect(gridSize(SPACE)).toBe(20 * 11 * 2);
    expect([...gridPoints(SPACE)].length).toBe(440);
    const n = neighbours(SPACE, { a: 1, b: 25, c: false });
    expect(n.length).toBe(1 + 2 + 1);
  });

  it('derives a space from script inputs', () => {
    const sp = spaceFromInputs([
      { key: 'len', type: 'int', title: 'Len', defval: 14, min: 2, max: 50 },
      { key: 'mult', type: 'float', title: 'Mult', defval: 2 },
      { key: 'on', type: 'bool', title: 'On', defval: true },
      { key: 'mode', type: 'string', title: 'Mode', defval: 'EMA', options: ['EMA', 'SMA'] },
      { key: 'src', type: 'source', title: 'Src', defval: 'close' },
    ]);
    expect(sp.map((p) => p.kind)).toEqual(['int', 'float', 'bool', 'choice']);
    expect(sp[0]).toMatchObject({ min: 2, max: 50 });
  });

  it('grid finds the optimum exactly; random/bayes/genetic get close with a small budget, never repeating points', () => {
    expect(drive('grid', 1000).best).toBe(3);
    const r = drive('random', 120);
    const b = drive('bayes', 120);
    const g = drive('genetic', 120);
    expect(r.evals).toBe(120);
    expect(b.best).toBeGreaterThan(-3);
    expect(g.best).toBeGreaterThan(-6);
    expect(b.best).toBeGreaterThanOrEqual(r.best - 3);
  });

  it('computes Pareto ranks', () => {
    const { rank } = paretoRanks([
      [1, 1],
      [2, 0],
      [0, 2],
      [0.5, 0.5],
      [2, 2],
    ]);
    expect(rank[4]).toBe(0);
    expect(rank[0]).toBe(1);
    expect(rank[3]).toBe(2);
  });
});

describe('optimizer: robustness and partitions', () => {
  it('flags narrow peaks and computes plateaus', () => {
    const sp: ParamDef[] = [{ key: 'x', kind: 'int', min: 0, max: 20, step: 1 }];
    const res = Array.from({ length: 21 }, (_, x) => ({ point: { x }, score: x === 5 ? 10 : x >= 12 && x <= 16 ? 6 : 1 }));
    const st = neighbourStats(sp, res);
    expect(st.get('5')!.narrowPeak).toBe(true);
    expect(st.get('14')!.narrowPeak).toBe(false);
    expect(st.get('14')!.plateau).toBeCloseTo(1, 9);
  });

  it('builds walk-forward windows without overlap between IS and OOS', () => {
    const w = walkForwardWindows(0, 1000, { isBars: 300, oosBars: 100, anchored: false });
    expect(w.length).toBe(7);
    for (const x of w) {
      expect(x.isTo).toBeLessThanOrEqual(x.oosFrom);
      expect(x.isTo - x.isFrom).toBe(300);
    }
    const a = walkForwardWindows(0, 1000, { isBars: 300, oosBars: 100, anchored: true, gapBars: 10 });
    expect(a.every((x) => x.isFrom === 0 && x.oosFrom - x.isTo === 10)).toBe(true);
  });

  it('purges and embargoes k-fold training sets', () => {
    const folds = purgedKFold(0, 1000, 5, 20, 10);
    expect(folds.length).toBe(5);
    const f2 = folds[2];
    expect(f2.test).toEqual([400, 600]);
    expect(f2.train).toEqual([
      [0, 380],
      [610, 1000],
    ]);
  });

  it('scores segments from trades fully inside them', () => {
    const trades: CompactTrade[] = [
      { entryBar: 10, exitBar: 20, returnPct: 10, profit: 100, dir: 1 },
      { entryBar: 95, exitBar: 105, returnPct: 50, profit: 500, dir: 1 },
      { entryBar: 120, exitBar: 130, returnPct: -10, profit: -100, dir: -1 },
    ];
    const s = segmentScore(trades, [[0, 100]]);
    expect(s.trades).toBe(1);
    expect(s.returnPct).toBeCloseTo(10, 9);
    const s2 = segmentScore(trades, [
      [0, 100],
      [110, 200],
    ]);
    expect(s2.trades).toBe(2);
    expect(s2.returnPct).toBeCloseTo((1.1 * 0.9 - 1) * 100, 9);
    expect(s2.maxDrawdownPct).toBeCloseTo(10, 9);
  });

  it('applies constraints in scores', () => {
    const m = { netProfitPct: 30, maxDrawdownPct: 25, sharpe: 1.2, sortino: 1.5, calmar: 1, cagr: 30, profitFactor: 1.4, winRate: 0.5, trades: 40, expectancy: 1, exposure: 50 };
    expect(score('sharpe', m, {})).toBe(1.2);
    expect(score('sharpe', m, { maxDrawdownPct: 20 })).toBe(-Infinity);
    expect(score('returnOverDd', m, { minTrades: 10 })).toBeCloseTo(1.2, 9);
  });
});

describe('optimizer: statistics', () => {
  it('normal distribution helpers are accurate', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(normInv(0.01)).toBeCloseTo(-2.326348, 4);
  });

  it('deflates the Sharpe ratio for many trials', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const rets = Array.from({ length: 500 }, () => 0.002 + rnd() * 0.04);
    const one = deflatedSharpe(rets, 1, 0.01);
    const many = deflatedSharpe(rets, 1000, 0.01);
    expect(many.sr0).toBeGreaterThan(one.sr0);
    expect(many.dsr).toBeLessThan(one.dsr);
  });

  it('Holm adjustment is monotone and conservative', () => {
    const adj = holm([0.01, 0.04, 0.03, 0.2]);
    expect(adj[0]).toBeCloseTo(0.04, 12);
    expect(adj[2]).toBeCloseTo(0.09, 12);
    expect(adj[1]).toBeCloseTo(0.09, 12);
    expect(adj[3]).toBeCloseTo(0.2, 12);
  });

  it('bootstraps trade sequences', () => {
    const b = bootstrapTrades([2, -1, 3, -1, 2, 1, -2, 4, -1, 1], 1000);
    expect(b.returnPct.p5).toBeLessThan(b.returnPct.p50);
    expect(b.returnPct.p50).toBeLessThan(b.returnPct.p95);
    expect(b.maxDrawdownPct.p5).toBeGreaterThanOrEqual(0);
  });

  it('randomized entry test separates a real edge from luck', () => {
    // prices trend up strongly every 50 bars for 10 bars; the "strategy" catches those moves
    const n = 2000;
    const close = new Float64Array(n);
    let p = 100;
    for (let i = 0; i < n; i++) {
      p *= i % 50 < 10 ? 1.01 : 0.9995;
      close[i] = p;
    }
    const trades: CompactTrade[] = [];
    for (let i = 0; i + 10 < n; i += 50) trades.push({ entryBar: i, exitBar: i + 10, returnPct: ((close[i + 10] - close[i]) / close[i]) * 100, profit: 0, dir: 1 });
    const r = randomEntryTest(close, 0, n, trades, 0, 500);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.strategyReturnPct).toBeGreaterThan(r.random95Pct);
  });

  it('PBO is high for pure noise and low for a consistently better trial', () => {
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const noise = Array.from({ length: 30 }, () => Array.from({ length: 8 }, () => rnd()));
    const n = pbo(noise);
    expect(n.pbo).toBeGreaterThan(0.25);
    const good = noise.map((row) => row.slice());
    good[0] = good[0].map((v) => v + 2);
    expect(pbo(good).pbo).toBeLessThan(0.05);
  });
});

describe('segment alpha and beta', () => {
  it('measures beta and alpha inside segments against buy & hold', async () => {
    const { sliceMetrics, objectiveValue } = await import('../../src/engine/optimize/analysis');
    const n = 200;
    const bh: number[] = [100];
    const eq: number[] = [100];
    for (let k = 1; k < n; k++) {
      const r = Math.sin(k / 3) * 0.02;
      bh.push(bh[k - 1] * (1 + r));
      eq.push(eq[k - 1] * (1 + 2 * r + 0.0005));
    }
    const d = { t: bh.map((_, k) => k * 86400000), eq, bar: bh.map((_, k) => k * 24), bh };
    const m = sliceMetrics(d, [], [[0, n * 24]]);
    expect(m.beta).toBeCloseTo(2, 6);
    expect(m.alpha).toBeCloseTo(0.0005 * 365 * 100, 4);
    expect(objectiveValue('alpha', m)).toBeCloseTo(m.alpha!, 9);
    // without buy & hold data there is no alpha (and the objective is not finite)
    const m2 = sliceMetrics({ t: d.t, eq, bar: d.bar }, [], [[0, n * 24]]);
    expect(m2.alpha).toBeUndefined();
  });
});
