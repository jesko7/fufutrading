import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import { ScriptPool } from '../../src/main/scripts/pool';
import { OptimizerService, type OptimizeRequest } from '../../src/main/backtest/optimizer';
import type { Prepared } from '../../src/main/backtest/service';
import { bars, ctx } from '../helpers/bars';

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-opt-'));
let pool: ScriptPool;
let svc: OptimizerService;

const CODE = `//@version=6
strategy("x", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fastLen = input.int(10, "Fast")
slowLen = input.int(40, "Slow")
f = ta.ema(close, fastLen)
s = ta.ema(close, slowLen)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")`;

const H = 3600000;
// trending regimes with noise: slow MAs work, fast ones whipsaw
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const path_: number[] = [];
let p = 100;
for (let i = 0; i <= 4000; i++) {
  p *= 1 + Math.sin(i / 160) * 0.0025 + rnd() * 0.01;
  path_.push(p);
}
const DATA = bars(4000, (i) => path_[i], Date.UTC(2025, 0, 1), H);

function prepared(): Prepared {
  return {
    code: CODE,
    language: 'pine',
    name: 'MA test',
    ctx: { ...ctx, tf: '1h' },
    bars: DATA,
    tradeFrom: 200,
    brokerCfg: { market: 'spot', makerFee: 0.001, takerFee: 0.001, tradeFrom: 200 },
    security: {},
    loadSecurity: async () => {},
    warnings: [],
    fills: 'OHLC',
    fundingN: 0,
    markUsed: false,
    source: 'synthetic',
    inputs: [
      { key: 'in0', type: 'int', title: 'Fast', defval: 10 },
      { key: 'in1', type: 'int', title: 'Slow', defval: 40 },
    ],
  };
}

beforeAll(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'src/workers/scriptWorker.ts')], outfile: path.join(tmp, 'scriptWorker.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['pyodide'], logLevel: 'error' });
  pool = new ScriptPool(path.join(tmp, 'scriptWorker.js'), null, () => {});
  const core = { paths: { userData: tmp }, router: { topic: () => {}, handle: () => {}, broadcast: () => {} } } as never;
  const scripts = { pool } as never;
  const backtests = { prepare: async () => prepared() } as never;
  svc = new OptimizerService(core, scripts, backtests);
}, 60000);

afterAll(async () => {
  await pool?.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function req(over: Partial<OptimizeRequest>): OptimizeRequest {
  return {
    symbol: 'BTCUSDT',
    market: 'spot',
    tf: '1h',
    from: DATA.t[200],
    to: DATA.t[3999],
    space: [
      { key: 'in0', kind: 'int', min: 5, max: 30, step: 5 },
      { key: 'in1', kind: 'int', min: 30, max: 90, step: 10 },
    ],
    method: 'grid',
    budget: 100,
    objective: 'sharpe',
    constraints: { minTrades: 3 },
    validation: { mode: 'none' },
    ...over,
  } as OptimizeRequest;
}

describe('OptimizerService (real workers)', () => {
  it('grid search over the full range with robustness and statistics', async () => {
    const rec = await svc.run(req({ secondary: ['maxDrawdownPct'] }), () => {}, { cancelled: false });
    expect(rec.info.trials).toBe(42);
    expect(rec.trials.filter((t) => t.metrics).length).toBe(42);
    const ranking = rec.scopes[0].ranking;
    expect(ranking[0].key).toBe(rec.bestKey);
    expect(ranking[0].score).toBeGreaterThanOrEqual(ranking[1].score);
    expect(rec.robustness.length).toBeGreaterThan(5);
    expect(rec.pareto.length).toBeGreaterThan(0);
    expect(rec.stats.dsr!.trials).toBe(42);
    expect(rec.stats.pvalues!.length).toBe(10);
    expect(rec.stats.bootstrap!.returnPct.p5).toBeLessThanOrEqual(rec.stats.bootstrap!.returnPct.p95);
    expect(rec.stats.randomEntry!.pValue).toBeGreaterThan(0);
    expect(rec.stats.pbo!.splits).toBeGreaterThan(0);
    expect(rec.regimes.length).toBeGreaterThan(0);
  }, 240000);

  it('holdout: search on in-sample only, report out-of-sample of the IS winner', async () => {
    const rec = await svc.run(req({ method: 'random', budget: 20, validation: { mode: 'holdout', oosPct: 30 } }), () => {}, { cancelled: false });
    expect(rec.scopes[0].name).toBe('In-sample');
    expect(rec.validation.holdout!.top.length).toBeGreaterThan(0);
    const [[isFrom, isTo]] = rec.scopes[0].segs;
    expect(isFrom).toBe(200);
    expect(isTo).toBe(200 + Math.floor(3800 * 0.7));
    expect(Number.isFinite(rec.validation.holdout!.oosMetrics.netProfitPct)).toBe(true);
  }, 240000);

  it('walk-forward with Bayesian search per window stitches out-of-sample equity', async () => {
    const rec = await svc.run(req({ method: 'bayes', budget: 12, validation: { mode: 'walkforward', windows: 3, isRatio: 3 } }), () => {}, { cancelled: false });
    const wins = rec.validation.wfo!.windows;
    expect(wins.length).toBeGreaterThanOrEqual(3);
    for (const w of wins) expect(w.isTo).toBeLessThanOrEqual(w.oosFrom);
    expect(rec.validation.wfo!.stitched.eq.length).toBeGreaterThan(10);
    // trials are shared across windows: far fewer than windows × budget
    expect(rec.info.trials).toBeLessThanOrEqual(42);
  }, 240000);

  it('purged k-fold cross-validation with a genetic search', async () => {
    const rec = await svc.run(req({ method: 'genetic', budget: 14, validation: { mode: 'cv', folds: 3, embargoPct: 1 } }), () => {}, { cancelled: false });
    const cv = rec.validation.cv!;
    expect(cv.folds.length).toBe(3);
    expect(cv.purgeBars).toBeGreaterThan(0);
    expect(rec.scopes[rec.scopes.length - 1].name).toBe('Full range');
  }, 240000);

  it('can be cancelled', async () => {
    const signal = { cancelled: false };
    const run = svc.run(req({ method: 'random', budget: 40 }), () => (signal.cancelled = true), signal);
    await expect(run).rejects.toThrow(/Cancelled/);
  }, 120000);
});
