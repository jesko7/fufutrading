/**
 * OptimizerService — parameter search on background workers with leakage-free validation.
 *
 * Each candidate parameter set is simulated once over the prepared history (bars shared with
 * workers via SharedArrayBuffer, so parallel trials never copy data). Scopes (full range,
 * in-sample part, walk-forward IS windows, purged/embargoed CV training folds) score
 * candidates only from equity and trades inside their bars; adaptive searchers (Bayesian,
 * genetic) run per scope on that scope's score, so out-of-sample data never steers the search.
 * Results include rankings, neighbourhood robustness, Pareto fronts, IS/OOS degradation,
 * walk-forward stitched OOS equity, bootstrap CIs, randomized-entry tests, Deflated Sharpe,
 * Holm-adjusted p-values, PBO and regime stability.
 */
import path from 'node:path';
import type { AppCore } from '../core';
import type { ScriptService } from '../scripts/service';
import type { BacktestService, BacktestRequest, Prepared } from './service';
import { DocStore, uid } from '../storage/jsonStore';
import { shareDeep, truncateBars } from '../../engine/data';
import type { TrialResult } from '../../engine/host';
import { type ParamDef, type Point, pointKey, gridSize, fromIndices } from '../../engine/optimize/space';
import { makeSearcher, paretoRanks, type Method } from '../../engine/optimize/search';
import {
  type ObjectiveId,
  type Constraints,
  type TrialMetrics,
  type CompactTrade,
  score,
  multiRank,
  neighbourStats,
  walkForwardWindows,
  purgedKFold,
  sliceMetrics,
  sliceReturns,
  bootstrapTrades,
  randomEntryTest,
  deflatedSharpe,
  sharpePValue,
  holm,
  pbo,
  regimeLabels,
  regimeReturns,
  objectiveValue,
} from '../../engine/optimize/analysis';
import { SYMBOL_SPECS } from '../../shared/symbols';

export interface OptimizeRequest extends BacktestRequest {
  space: ParamDef[];
  method: Method;
  /** Trials (per window/fold for walk-forward and cross-validation). */
  budget: number;
  seed?: number;
  objective: ObjectiveId;
  constraints: Constraints;
  /** Additional objectives for the Pareto front / multi-metric ranking. */
  secondary?: (ObjectiveId | 'maxDrawdownPct' | 'trades')[];
  validation: { mode: 'none' | 'holdout' | 'walkforward' | 'cv'; oosPct?: number; windows?: number; isRatio?: number; anchored?: boolean; folds?: number; embargoPct?: number };
  extras?: { bootstrap?: boolean; randomEntries?: boolean; pbo?: boolean; regimes?: boolean };
}

export interface TrialRow {
  key: string;
  point: Point;
  metrics: TrialMetrics | null;
  error?: string;
}

export interface ScopeResult {
  name: string;
  segs: [number, number][];
  /** Times of the segment bounds (for display). */
  times: [number, number][];
  /** Trial keys ranked by this scope's score (best first, at most 200). */
  ranking: { key: string; score: number }[];
  best: string | null;
  evaluated: number;
}

export interface OptimizationRecord {
  id: string;
  created: number;
  label: string;
  request: OptimizeRequest;
  script: { id: string | null; name: string; language: string; code: string };
  trials: TrialRow[];
  scopes: ScopeResult[];
  bestKey: string | null;
  bestPoint: Point | null;
  validation: {
    mode: string;
    holdout?: { isMetrics: TrialMetrics; oosMetrics: TrialMetrics; top: { key: string; is: number; oos: number }[] };
    wfo?: { windows: { isFrom: number; isTo: number; oosFrom: number; oosTo: number; best: string | null; point: Point | null; isMetrics: TrialMetrics | null; oosMetrics: TrialMetrics | null }[]; stitched: { t: number[]; eq: number[] }; oosMetrics: TrialMetrics | null; wfe: number };
    cv?: { folds: { test: [number, number]; best: string | null; point: Point | null; trainScore: number; testMetrics: TrialMetrics | null }[]; meanTrain: number; meanTest: number; purgeBars: number };
  };
  robustness: { key: string; mean: number; min: number; plateau: number; smoothed: number; narrowPeak: boolean; evaluated: number }[];
  pareto: string[];
  multiRank: { key: string; rank: number }[];
  stats: {
    scope: string;
    bootstrap?: ReturnType<typeof bootstrapTrades>;
    randomEntry?: ReturnType<typeof randomEntryTest>;
    dsr?: { sr: number; sr0: number; dsr: number; trials: number };
    pvalues?: { key: string; p: number; adjusted: number }[];
    pbo?: { pbo: number; splits: number; candidates: number };
  };
  regimes: { key: string; returns: Record<string, number> }[];
  bestCurve: { t: number[]; eq: number[] } | null;
  warnings: string[];
  info: { bars: number; warmup: number; trials: number; ms: number; parallel: number; grid: number; fromT: number; toT: number };
}

type Progress = (p: { phase: string; done?: number; total?: number; best?: { key: string; score: number; point: Point } | null; message?: string }) => void;

function metricsOf(r: TrialResult): TrialMetrics | null {
  const m = r.metrics;
  if (!r.ok || !m) return null;
  return { netProfitPct: m.netProfitPct, maxDrawdownPct: m.maxDrawdownPct, sharpe: m.sharpe, sortino: m.sortino, calmar: m.calmar, cagr: m.cagr, profitFactor: m.all.profitFactor, winRate: m.all.winRate, trades: m.all.trades, expectancy: m.all.avgTradePct, exposure: m.exposure, alpha: m.greeks?.alpha, beta: m.greeks?.beta };
}

export class OptimizerService {
  private store: DocStore<OptimizationRecord>;

  constructor(
    private core: AppCore,
    private scripts: ScriptService,
    private backtests: BacktestService,
  ) {
    this.store = new DocStore<OptimizationRecord>(path.join(core.paths.userData, 'optimizations'));
    this.register();
  }

  async run(req: OptimizeRequest, progress: Progress, signal: { cancelled: boolean }): Promise<OptimizationRecord> {
    const t0 = Date.now();
    if (!Array.isArray(req.space) || !req.space.length) throw new Error('Validation: choose at least one parameter to optimize');
    const budget = Math.max(1, Math.min(5000, Math.round(req.budget || 100)));
    const P: Prepared = await this.backtests.prepare(req, (p) => progress({ phase: p.phase, done: p.done, total: p.total }), signal);
    const warnings = [...P.warnings];
    // shared memory: workers read the same bars without copying
    let bars = shareDeep(P.bars);
    let broker = shareDeep(P.brokerCfg);
    let security = shareDeep(P.security);
    let book = P.book ? shareDeep(P.book) : undefined;
    const magnifier = P.magnifier ? shareDeep(P.magnifier) : undefined;
    const n = bars.length;
    const from = P.tradeFrom;
    const cache = new Map<string, TrialResult>();
    const inflight = new Map<string, Promise<TrialResult>>();
    const handles = new Set<{ cancel: () => void }>();
    let evaluated = 0;
    const evaluate = (pt: Point): Promise<TrialResult> => {
      const key = pointKey(req.space, pt);
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      const running = inflight.get(key);
      if (running) return running;
      const job = (async () => {
        for (let round = 0; round < 4; round++) {
          if (signal.cancelled) throw new Error('Cancelled');
          const h = this.scripts.pool.trial({ lang: P.language, code: P.code, ctx: P.ctx, inputs: { ...(req.inputs || {}), ...pt }, strategy: broker, data: bars, security, book, from, riskFree: req.riskFree ?? 0, magnifier });
          handles.add(h);
          let r: TrialResult;
          try {
            r = await h.promise;
          } finally {
            handles.delete(h);
          }
          if (!r.need.length) return r;
          await P.loadSecurity(r.need);
          security = shareDeep(P.security);
          if (P.book && !book) book = shareDeep(P.book);
          for (const w of P.warnings) if (!warnings.includes(w)) warnings.push(w);
        }
        throw new Error('Could not resolve the data the script requests');
      })();
      inflight.set(key, job);
      return job
        .then((r) => {
          cache.set(key, r);
          evaluated++;
          return r;
        })
        .catch((e) => {
          const r: TrialResult = { ok: false, error: (e as Error).message, need: [], metrics: null, trades: [], daily: { t: [], eq: [], bar: [] } };
          if ((e as Error).message !== 'Cancelled') cache.set(key, r);
          return r;
        })
        .finally(() => inflight.delete(key));
    };
    const cancelAll = () => {
      for (const h of handles) h.cancel();
    };
    const par = Math.max(1, this.scripts.pool.parallelism);
    const timeOf = (bar: number) => bars.t[Math.max(0, Math.min(n - 1, bar))];

    /** Search in a scope: score = objective over the scope's bars (or full metrics). */
    const searchScope = async (name: string, segs: [number, number][] | null, label: string, bud: number, offset: number, totalWork: number): Promise<ScopeResult> => {
      const scoreOf = (r: TrialResult): number => {
        if (!r.ok) return -Infinity;
        if (!segs) return score(req.objective, metricsOf(r), req.constraints);
        const m = sliceMetrics(r.daily, r.trades, segs);
        const share = segs.reduce((a, [x, y]) => a + (y - x), 0) / Math.max(1, n - from);
        const c: Constraints = { ...req.constraints, minTrades: req.constraints.minTrades !== undefined ? Math.max(1, Math.round(req.constraints.minTrades * share)) : undefined };
        return score(req.objective, m, c);
      };
      const searcher = makeSearcher(req.method, req.space, bud, (req.seed ?? 1) + offset);
      const seen: { key: string; score: number }[] = [];
      let best: { key: string; score: number; point: Point } | null = null;
      let guard = 0;
      while (!searcher.done() && guard++ < 100000) {
        if (signal.cancelled) throw new Error('Cancelled');
        const batch = searcher.ask(par);
        if (!batch.length) break;
        const results = await Promise.all(batch.map((p) => evaluate(p)));
        if (signal.cancelled) throw new Error('Cancelled');
        const trials = batch.map((p, k) => {
          const key = pointKey(req.space, p);
          const sc = scoreOf(results[k]);
          const objectives = req.secondary?.length ? [sc, ...req.secondary.map((o) => (results[k].ok ? secondaryValue(o, segs ? sliceMetrics(results[k].daily, results[k].trades, segs) : metricsOf(results[k])!) : -Infinity))] : undefined;
          seen.push({ key, score: sc });
          if (Number.isFinite(sc) && (!best || sc > best.score)) best = { key, score: sc, point: p };
          return { point: p, key, score: sc, objectives };
        });
        searcher.tell(trials);
        progress({ phase: label, done: offset * bud + seen.length, total: totalWork, best });
      }
      seen.sort((a, b) => (Number.isFinite(b.score) ? b.score : -1e300) - (Number.isFinite(a.score) ? a.score : -1e300));
      const segsOut = segs || [[from, n]];
      return { name, segs: segsOut, times: segsOut.map(([a, b]) => [timeOf(a), timeOf(b - 1)] as [number, number]), ranking: seen.slice(0, 200), best: seen.length && Number.isFinite(seen[0].score) ? seen[0].key : null, evaluated: seen.length };
    };

    const pointOf = (key: string | null): Point | null => (key ? pointFromKey(req.space, key) : null);

    const scopes: ScopeResult[] = [];
    const validation: OptimizationRecord['validation'] = { mode: req.validation.mode };
    let evalScope: { name: string; segs: [number, number][] } = { name: 'Full range', segs: [[from, n]] };
    let bestKey: string | null = null;
    try {
      const mode = req.validation.mode;
      if (mode === 'none') {
        const s = await searchScope('Full range', null, 'Optimizing', budget, 0, budget);
        scopes.push(s);
        bestKey = s.best;
      } else if (mode === 'holdout') {
        const oosPct = Math.max(5, Math.min(60, req.validation.oosPct ?? 30));
        const split = from + Math.floor((n - from) * (1 - oosPct / 100));
        const s = await searchScope('In-sample', [[from, split]], 'Optimizing in-sample', budget, 0, budget);
        scopes.push(s);
        bestKey = s.best;
        evalScope = { name: 'Out-of-sample', segs: [[split, n]] };
        if (bestKey) {
          const top = s.ranking.filter((x) => Number.isFinite(x.score)).slice(0, 20);
          const rows = top.map((x) => {
            const r = cache.get(x.key)!;
            return { key: x.key, is: x.score, oos: score(req.objective, sliceMetrics(r.daily, r.trades, [[split, n]]), {}) };
          });
          const br = cache.get(bestKey)!;
          validation.holdout = { isMetrics: sliceMetrics(br.daily, br.trades, [[from, split]]), oosMetrics: sliceMetrics(br.daily, br.trades, [[split, n]]), top: rows };
        }
      } else if (mode === 'walkforward') {
        const W = Math.max(2, Math.min(20, req.validation.windows ?? 5));
        const ratio = Math.max(1, Math.min(10, req.validation.isRatio ?? 3));
        const span = n - from;
        const oosBars = Math.max(10, Math.floor(span / (ratio + W)));
        const wins = walkForwardWindows(from, n, { isBars: oosBars * ratio, oosBars, anchored: !!req.validation.anchored });
        if (!wins.length) throw new Error('The range is too short for walk-forward windows');
        const out: NonNullable<OptimizationRecord['validation']['wfo']>['windows'] = [];
        const stitchedRets: { t: number; r: number }[] = [];
        let wfeSum = 0;
        let wfeN = 0;
        for (let w = 0; w < wins.length; w++) {
          const win = wins[w];
          const s = await searchScope(`Window ${w + 1} IS`, [[win.isFrom, win.isTo]], `Walk-forward window ${w + 1}/${wins.length}`, budget, w, budget * wins.length);
          scopes.push(s);
          const b = s.best ? cache.get(s.best)! : null;
          const isM = b ? sliceMetrics(b.daily, b.trades, [[win.isFrom, win.isTo]]) : null;
          const oosM = b ? sliceMetrics(b.daily, b.trades, [[win.oosFrom, win.oosTo]]) : null;
          out.push({ ...win, best: s.best, point: pointOf(s.best), isMetrics: isM, oosMetrics: oosM });
          if (b) {
            for (let k = 1; k < b.daily.eq.length; k++) {
              const bar = b.daily.bar[k];
              if (bar >= win.oosFrom && bar < win.oosTo && b.daily.eq[k - 1] > 0) stitchedRets.push({ t: b.daily.t[k], r: b.daily.eq[k] / b.daily.eq[k - 1] - 1 });
            }
            if (isM && oosM && isM.cagr > 0) {
              wfeSum += oosM.cagr / isM.cagr;
              wfeN++;
            }
          } else warnings.push(`Walk-forward window ${w + 1}: no parameter set met the constraints — the window stays in cash.`);
        }
        let eq = 1;
        const st = { t: [] as number[], eq: [] as number[] };
        for (const x of stitchedRets) {
          eq *= 1 + x.r;
          st.t.push(x.t);
          st.eq.push(eq);
        }
        let peak = 1;
        let mdd = 0;
        for (const v of st.eq) {
          if (v > peak) peak = v;
          mdd = Math.max(mdd, (peak - v) / peak);
        }
        const rets = stitchedRets.map((x) => x.r);
        const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
        const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0;
        const oosTrades = out.flatMap((w) => (w.best ? cache.get(w.best)!.trades.filter((t) => t.entryBar >= w.oosFrom && t.exitBar < w.oosTo) : []));
        const years = rets.length / 365;
        validation.wfo = {
          windows: out,
          stitched: st,
          oosMetrics: {
            netProfitPct: (eq - 1) * 100,
            maxDrawdownPct: mdd * 100,
            sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
            sortino: 0,
            calmar: 0,
            cagr: years > 0 && eq > 0 ? (Math.pow(eq, 1 / years) - 1) * 100 : 0,
            profitFactor: (() => {
              const gp = oosTrades.filter((t) => t.returnPct > 0).reduce((a, t) => a + t.returnPct, 0);
              const gl = -oosTrades.filter((t) => t.returnPct <= 0).reduce((a, t) => a + t.returnPct, 0);
              return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
            })(),
            winRate: oosTrades.length ? oosTrades.filter((t) => t.returnPct > 0).length / oosTrades.length : 0,
            trades: oosTrades.length,
            expectancy: oosTrades.length ? oosTrades.reduce((a, t) => a + t.returnPct, 0) / oosTrades.length : 0,
            exposure: NaN,
          },
          wfe: wfeN ? wfeSum / wfeN : NaN,
        };
        bestKey = out[out.length - 1].best;
        evalScope = { name: 'Walk-forward OOS', segs: out.map((w) => [w.oosFrom, w.oosTo] as [number, number]) };
      } else {
        const k = Math.max(3, Math.min(10, req.validation.folds ?? 5));
        // purge window: the typical holding time of the default parameters (95th percentile)
        const def = await evaluate(defaultPoint(req, P.inputs));
        const durs = def.trades.map((t) => t.exitBar - t.entryBar).sort((a, b) => a - b);
        const p95 = durs.length ? durs[Math.floor(durs.length * 0.95)] : 0;
        const embargo = Math.max(1, Math.round(((req.validation.embargoPct ?? 1) / 100) * (n - from)));
        const purge = Math.max(p95, embargo);
        const folds = purgedKFold(from, n, k, purge, Math.max(embargo, p95));
        const out: NonNullable<OptimizationRecord['validation']['cv']>['folds'] = [];
        let trainSum = 0;
        let testSum = 0;
        let cnt = 0;
        for (let f = 0; f < folds.length; f++) {
          const s = await searchScope(`Fold ${f + 1} train`, folds[f].train, `Cross-validation fold ${f + 1}/${folds.length}`, budget, f, budget * folds.length);
          scopes.push(s);
          const b = s.best ? cache.get(s.best)! : null;
          const testM = b ? sliceMetrics(b.daily, b.trades, [folds[f].test]) : null;
          const trainScore = s.ranking.length ? s.ranking[0].score : NaN;
          out.push({ test: folds[f].test, best: s.best, point: pointOf(s.best), trainScore, testMetrics: testM });
          if (testM && Number.isFinite(trainScore)) {
            trainSum += trainScore;
            testSum += objectiveValue(req.objective, testM);
            cnt++;
          }
        }
        validation.cv = { folds: out, meanTrain: cnt ? trainSum / cnt : NaN, meanTest: cnt ? testSum / cnt : NaN, purgeBars: purge };
        // the final suggestion: best on all data (cross-validation estimates its out-of-sample quality)
        const all = await searchScope('Full range', null, 'Final selection on the full range', budget, folds.length, budget * (folds.length + 1));
        scopes.push(all);
        bestKey = all.best;
      }
    } catch (e) {
      cancelAll();
      throw e;
    }
    if (signal.cancelled) throw new Error('Cancelled');

    // ---- trials table
    const trials: TrialRow[] = [...cache.entries()].map(([key, r]) => ({ key, point: pointFromKey(req.space, key), metrics: metricsOf(r), error: r.ok ? undefined : r.error }));
    const validTrials = trials.filter((t) => t.metrics);
    if (!validTrials.length) warnings.push('No parameter set produced a valid result — check the script and the parameter ranges.');
    // ---- robustness (on the main ranking scope)
    const mainScope = scopes[scopes.length - 1];
    const scoreMap = new Map(mainScope.ranking.map((x) => [x.key, x.score]));
    const ns = neighbourStats(
      req.space,
      trials.map((t) => ({ point: t.point, score: scoreMap.get(t.key) ?? (t.metrics ? score(req.objective, t.metrics, req.constraints) : -Infinity) })),
    );
    const robustness = mainScope.ranking
      .slice(0, 30)
      .map((x) => {
        const st = ns.get(x.key);
        return st ? { key: x.key, mean: st.mean, min: st.min, plateau: st.plateau, smoothed: st.smoothed, narrowPeak: st.narrowPeak, evaluated: st.evaluated } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (bestKey && ns.get(bestKey)?.narrowPeak) warnings.push('The best parameter set sits on a narrow peak: neighbouring values perform much worse. Prefer a set on a broad plateau (see Robustness).');
    // ---- Pareto & multi-metric ranking (full-range metrics)
    let pareto: string[] = [];
    let mr: { key: string; rank: number }[] = [];
    if (validTrials.length) {
      const objs = [req.objective, ...(req.secondary || [])];
      if (objs.length > 1) {
        const { rank } = paretoRanks(validTrials.map((t) => objs.map((o) => secondaryValue(o, t.metrics!))));
        pareto = validTrials.filter((_, i) => rank[i] === 0).map((t) => t.key);
      }
      const ranks = multiRank(
        validTrials.map((t) => t.metrics!),
        ['sharpe', 'returnOverDd', 'profitFactor', 'netProfitPct'],
      );
      mr = validTrials.map((t, i) => ({ key: t.key, rank: ranks[i] })).sort((a, b) => a.rank - b.rank).slice(0, 50);
    }
    // ---- statistics on the evaluation scope of the selected parameters
    const stats: OptimizationRecord['stats'] = { scope: evalScope.name };
    const ex = req.extras || {};
    const best = bestKey ? cache.get(bestKey) : undefined;
    if (best && best.ok) {
      // for walk-forward the evaluation uses each window's own selection
      const evalTrades: CompactTrade[] =
        req.validation.mode === 'walkforward' && validation.wfo
          ? validation.wfo.windows.flatMap((w) => (w.best ? cache.get(w.best)!.trades.filter((t) => t.entryBar >= w.oosFrom && t.exitBar < w.oosTo) : []))
          : best.trades.filter((t) => evalScope.segs.some(([a, b]) => t.entryBar >= a && t.exitBar < b));
      if (ex.bootstrap !== false) stats.bootstrap = bootstrapTrades(evalTrades.map((t) => t.returnPct), 2000, req.seed ?? 7);
      if (ex.randomEntries !== false) {
        const [a, b] = [evalScope.segs[0][0], evalScope.segs[evalScope.segs.length - 1][1]];
        stats.randomEntry = randomEntryTest(bars.c, a, b, evalTrades, (broker.takerFee as number) ?? 0.001, 1000, req.seed ?? 11);
      }
      // deflated Sharpe over all evaluated trials (multiple-testing correction)
      const perPeriodSr = (r: TrialResult) => {
        const rets = sliceReturns(r.daily, [[from, n]]);
        const m = rets.reduce((x, y) => x + y, 0) / Math.max(1, rets.length);
        const sd = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, rets.length - 1));
        return sd > 0 ? m / sd : 0;
      };
      const srs = [...cache.values()].filter((r) => r.ok).map(perPeriodSr);
      const mu = srs.reduce((a, b) => a + b, 0) / Math.max(1, srs.length);
      const varSr = srs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, srs.length - 1);
      const bestRets = req.validation.mode === 'walkforward' && validation.wfo ? validation.wfo.stitched.eq.map((v, i, a) => (i ? v / a[i - 1] - 1 : v - 1)) : sliceReturns(best.daily, evalScope.segs);
      stats.dsr = { ...deflatedSharpe(bestRets, Math.max(1, cache.size), varSr), trials: cache.size };
      // Holm-adjusted p-values of the top candidates (H0: mean daily return <= 0)
      const keys = [...cache.keys()].filter((k) => cache.get(k)!.ok);
      const ps = keys.map((k) => sharpePValue(sliceReturns(cache.get(k)!.daily, [[from, n]])));
      const adj = holm(ps);
      const top = mainScope.ranking.slice(0, 10).map((x) => x.key);
      stats.pvalues = top.map((k) => ({ key: k, p: ps[keys.indexOf(k)] ?? 1, adjusted: adj[keys.indexOf(k)] ?? 1 }));
      if (ex.pbo !== false && keys.length >= 4) {
        const cands = mainScope.ranking.filter((x) => Number.isFinite(x.score)).slice(0, 40).map((x) => x.key);
        const S = 10;
        const edges = Array.from({ length: S + 1 }, (_, i) => from + Math.floor(((n - from) * i) / S));
        const perf = cands.map((k) => {
          const r = cache.get(k)!;
          return Array.from({ length: S }, (_, b) => sliceReturns(r.daily, [[edges[b], edges[b + 1]]]).reduce((a, x) => a + Math.log(1 + x), 0));
        });
        const res = pbo(perf);
        stats.pbo = { pbo: res.pbo, splits: res.splits, candidates: cands.length };
      }
    }
    // ---- regime stability of the top candidates
    const regimes: OptimizationRecord['regimes'] = [];
    if (ex.regimes !== false && validTrials.length) {
      const lab = regimeLabels(bars.c, from, n);
      for (const x of mainScope.ranking.slice(0, 8)) {
        const r = cache.get(x.key);
        if (!r || !r.ok) continue;
        regimes.push({ key: x.key, returns: { ...regimeReturns(r.daily, lab.trend), ...regimeReturns(r.daily, lab.vol) } });
      }
    }
    if (req.method !== 'grid' && gridSize(req.space) <= budget) warnings.push('The whole grid fits into the budget — grid search would evaluate every combination.');
    if (cache.size >= 200 && stats.dsr && stats.dsr.dsr < 0.5) warnings.push(`After ${cache.size} trials the Deflated Sharpe Ratio is ${(stats.dsr.dsr * 100).toFixed(0)}% — the best result is likely a product of the search, not an edge.`);
    const rec: OptimizationRecord = {
      id: uid('opt'),
      created: Date.now(),
      label: req.label || `${P.name} · ${SYMBOL_SPECS[req.symbol].base}${req.market === 'futures' ? '.P' : ''} ${req.tf} · ${req.method}`,
      request: { ...req, code: undefined },
      script: { id: req.scriptId || null, name: P.name, language: P.language, code: P.code },
      trials,
      scopes,
      bestKey,
      bestPoint: bestKey ? pointFromKey(req.space, bestKey) : null,
      validation,
      robustness,
      pareto,
      multiRank: mr,
      stats,
      regimes,
      bestCurve: best && best.ok ? { t: best.daily.t, eq: best.daily.eq } : null,
      warnings,
      info: { bars: n - from, warmup: from, trials: cache.size, ms: Date.now() - t0, parallel: par, grid: gridSize(req.space), fromT: bars.t[from], toT: bars.tc[n - 1] },
    };
    // free shared memory references
    bars = truncateBars(bars, 0);
    broker = {};
    security = {};
    this.store.put(rec, true);
    this.core.router.broadcast('optimizations:changed', { id: rec.id });
    return rec;
  }

  private register(): void {
    const r = this.core.router;
    r.topic('optimize', async (req: OptimizeRequest, push) => {
      const signal = { cancelled: false };
      let last = 0;
      void this.run(
        req,
        (p) => {
          const now = Date.now();
          if (now - last < 150 && p.done !== p.total) return;
          last = now;
          push({ type: 'progress', ...p });
        },
        signal,
      )
        .then((rec) => push({ type: 'done', record: rec }))
        .catch((e) => push({ type: 'error', message: String((e as Error).message || e).replace(/^Validation: /, '') }));
      return () => {
        signal.cancelled = true;
      };
    });
    r.handle('optimizations:list', () =>
      this.store
        .loadAll()
        .sort((a, b) => b.created - a.created)
        .map((x) => ({ id: x.id, created: x.created, label: x.label, request: x.request, bestPoint: x.bestPoint, trials: x.info.trials, mode: x.validation.mode, script: { id: x.script.id, name: x.script.name } })),
    );
    r.handle('optimizations:get', ([id]) => {
      const rec = this.store.get(String(id));
      if (!rec) throw new Error('Optimization not found');
      return rec;
    });
    r.handle('optimizations:delete', ([id]) => {
      this.store.delete(String(id));
      this.core.router.broadcast('optimizations:changed', { id });
      return true;
    });
  }
}

/** Secondary objectives are oriented so that higher is better (drawdown → negative). */
function secondaryValue(o: ObjectiveId | 'maxDrawdownPct' | 'trades', m: TrialMetrics): number {
  if ((o as string) === 'maxDrawdownPct') return -m.maxDrawdownPct;
  if ((o as string) === 'trades') return m.trades;
  const v = objectiveValue(o as ObjectiveId, m);
  return Number.isFinite(v) ? v : -1e9;
}

function pointFromKey(space: ParamDef[], key: string): Point {
  return fromIndices(space, key.split(',').map(Number));
}

/** The script's own defaults (overridden by the request's fixed inputs) for the optimized keys. */
function defaultPoint(req: OptimizeRequest, defs: { key: string; defval: unknown }[]): Point {
  const pt: Point = {};
  for (const p of req.space) {
    const v = req.inputs?.[p.key] ?? defs.find((d) => d.key === p.key)?.defval;
    if (v !== undefined && v !== null) pt[p.key] = v as never;
    else pt[p.key] = p.kind === 'bool' ? false : p.kind === 'choice' ? p.values[0] : p.min;
  }
  return pt;
}

export function registerOptimizer(core: AppCore, scripts: ScriptService, backtests: BacktestService): OptimizerService {
  return new OptimizerService(core, scripts, backtests);
}
