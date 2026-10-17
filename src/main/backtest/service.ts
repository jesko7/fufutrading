/**
 * BacktestService — runs strategies over long histories in background workers.
 *
 *  - history comes from the local candle cache (only missing ranges are downloaded), with
 *    warm-up bars before the test range that feed indicators but never trade,
 *  - Heikin-Ashi / Renko inputs are built from real klines (HA fills can use real OHLC),
 *  - request.security / data.htf dependencies are discovered and loaded automatically,
 *  - futures runs include historical funding rates and mark-price bars (liquidations use mark),
 *  - optional fee-sensitivity reruns, analytics, and a persistent run history.
 */
import path from 'node:path';
import type { AppCore } from '../core';
import type { ScriptService } from '../scripts/service';
import { runContext } from '../scripts/service';
import { DocStore, uid } from '../storage/jsonStore';
import type { FundingCache } from '../market/funding';
import { computeMetrics, type Metrics } from '../../engine/backtest/metrics';
import { randomBenchmark, tradeMonteCarlo, type RandomBenchmark, type TradeMonteCarlo } from '../../engine/backtest/benchmarks';
import { describeKey, keyParts } from '../../engine/host';
import { METRICS } from '../../shared/metrics';
import { fromCandles } from '../../engine/data';
import type { BrokerConfig } from '../../engine/backtest/broker';
import { buildMagnifier, magnifierCoverage, type Magnifier } from '../../engine/backtest/magnifier';
import type { BarSeries, ScriptLanguage, StrategyRaw, TradeRec } from '../../engine/types';
import { CandleSeries, aggregate, heikinAshi, renko, type RenkoOptions } from '../../shared/candles';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, timeForBarsBack, baseIntervalFor, intervalToTf, bucketStart, tfDurationMs, intervalMs, type Timeframe } from '../../shared/timeframes';
import { costPreset } from '../../shared/trading/presets';

export interface BacktestRequest {
  scriptId?: string;
  code?: string;
  language?: ScriptLanguage;
  name?: string;
  inputs?: Record<string, unknown>;
  symbol: SymbolId;
  market: Market;
  tf: string;
  chartType?: 'candles' | 'heikinashi' | 'renko';
  renko?: RenkoOptions;
  /** Test range (ms). */
  from: number;
  to: number;
  warmupBars?: number;
  /** 'script' keeps the script's declared costs; otherwise a cost preset id or 'custom'. */
  costs?: string;
  broker?: Partial<BrokerConfig>;
  /** Heikin-Ashi: fill orders on the real OHLC of the same bars (recommended). */
  fillOnStandardOhlc?: boolean;
  feeSensitivity?: boolean;
  riskFree?: number;
  label?: string;
  /** Intrabar precision: fill along lower-timeframe klines ('auto' picks the finest practical interval). */
  intrabar?: 'auto' | 'off' | '1s' | '1m' | '5m' | '15m' | '1h';
  /** Don't keep the run in the Strategy Tester history (e.g. robustness sweeps). */
  ephemeral?: boolean;
}

export interface FeeSensitivityRow {
  feePct: number;
  netProfitPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  trades: number;
  sharpe: number;
}

export interface BacktestRecord {
  id: string;
  created: number;
  label: string;
  request: BacktestRequest;
  script: { id: string | null; name: string; language: ScriptLanguage; code: string };
  ok: boolean;
  error?: string;
  metrics: Omit<Metrics, 'curves'> | null;
  curves: { t: number[]; equity: number[]; drawdownPct: number[]; buyHold: number[] } | null;
  trades: TradeRec[];
  openTrades: StrategyRaw['openTrades'];
  feeSensitivity: FeeSensitivityRow[] | null;
  /** The strategy against random counterparts (same trades at random times / directions). */
  random?: RandomBenchmark | null;
  /** Monte Carlo of the trade sequence (shuffled and resampled). */
  monteCarlo?: TradeMonteCarlo | null;
  warnings: string[];
  /** Lookahead and repainting patterns found in the script (with lines). */
  scriptWarnings?: import('../../engine/types').ScriptWarning[];
  /**
   * Live replay after the run: the most recent bars of the instrument replayed as a bot sees them,
   * the strategy's position and orders compared with the backtest's (see engine/repaint).
   */
  replay?: { ok: boolean; error?: string; checked: number; window: number; differing: number; diffs: import('../../engine/repaint').RepaintDiff[]; at: number };
  /** security: other data the script requested (symbols, timeframes, futures data), for people. */
  info: { bars: number; warmup: number; source: string; fills: string; funding: number; mark: boolean; ms: number; config: Record<string, unknown>; security?: string[] };
  logs: { bar: number; time: number; level: string; msg: string }[];
}

export type Progress = (p: { phase: string; done?: number; total?: number; message?: string }) => void;

/** Each closed trade's P&L relative to the equity just before it was entered. */
export function tradeReturns(raw: StrategyRaw, equity: ArrayLike<number>, from: number): number[] {
  const init = raw.initialCapital;
  return raw.trades
    .filter((t) => t.entryBar >= from)
    .map((t) => {
      const k = t.entryBar - from - 1;
      const before = k >= 0 && Number.isFinite(equity[k]) && equity[k] > 0 ? equity[k] : init;
      return t.profit / before;
    });
}

/** Random counterparts of a backtest: same trades, sizes and costs at random times or directions. */
export function randomCounterparts(raw: StrategyRaw, bars: BarSeries, from: number, equity: ArrayLike<number>, fill?: BarSeries | null, opts: { iterations?: number; seed?: number } = {}): RandomBenchmark | null {
  const to = bars.length - 1;
  if (to - from < 2) return null;
  const px = fill && fill.length === bars.length ? fill : bars;
  const cfg = raw.config as Record<string, unknown>;
  const last = px.c[to] || 1;
  const cost = (Number(cfg.takerFee) || 0) + (Number(cfg.slippageBps) || 0) / 1e4 + ((Number(cfg.slippageTicks) || 0) * (Number(cfg.tick) || 0)) / last;
  const closed = raw.trades.filter((x) => x.entryBar >= from).map((x) => ({ entryBar: x.entryBar, exitBar: x.exitBar, dir: x.dir, qty: x.qty, entryPrice: x.entryPrice, exitPrice: x.exitPrice, profit: x.profit }));
  const open = raw.openTrades.filter((x) => x.entryBar >= from).map((x) => ({ entryBar: x.entryBar, exitBar: to, dir: x.dir, qty: x.qty, entryPrice: x.entryPrice, exitPrice: px.c[to], profit: (px.c[to] - x.entryPrice) * x.qty * x.dir }));
  try {
    return randomBenchmark({ t: bars.t, o: px.o, c: px.c, from, to, trades: [...closed, ...open], openCount: open.length, equity, initialCapital: raw.initialCapital, costPerSide: cost, iterations: opts.iterations, seed: opts.seed });
  } catch {
    return null;
  }
}

export interface Prepared {
  code: string;
  language: ScriptLanguage;
  name: string;
  ctx: ReturnType<typeof runContext>;
  bars: BarSeries;
  tradeFrom: number;
  brokerCfg: Partial<BrokerConfig>;
  security: Record<string, BarSeries>;
  loadSecurity: (keys: string[]) => Promise<void>;
  warnings: string[];
  fills: string;
  fundingN: number;
  markUsed: boolean;
  source: string;
  inputs: import('../../engine/types').ScriptInputDef[];
  magnifier?: Magnifier;
}

const MAX_POINTS = 2500;

function downsample(m: Metrics['curves']): BacktestRecord['curves'] {
  const n = m.t.length;
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const t: number[] = [];
  const equity: number[] = [];
  const dd: number[] = [];
  const bh: number[] = [];
  for (let i = 0; i < n; i += step) {
    // keep the worst drawdown inside each bucket so the curve shows true troughs
    let k = i;
    for (let j = i; j < Math.min(n, i + step); j++) if (m.drawdownPct[j] < m.drawdownPct[k]) k = j;
    t.push(m.t[k]);
    equity.push(m.equity[k]);
    dd.push(m.drawdownPct[k]);
    bh.push(m.buyHold[k]);
  }
  if (n && t[t.length - 1] !== m.t[n - 1]) {
    t.push(m.t[n - 1]);
    equity.push(m.equity[n - 1]);
    dd.push(m.drawdownPct[n - 1]);
    bh.push(m.buyHold[n - 1]);
  }
  return { t, equity, drawdownPct: dd, buyHold: bh };
}

export class BacktestService {
  private store: DocStore<BacktestRecord>;
  private funding: FundingCache;
  /** Live-replay checks still running, by record id. */
  private replays = new Map<string, Promise<void>>();

  constructor(
    private core: AppCore,
    private scripts: ScriptService,
  ) {
    this.store = new DocStore<BacktestRecord>(path.join(core.paths.userData, 'backtests'));
    this.funding = core.funding;
    this.register();
  }

  /** Candles for [from, to) of the instrument at `tf` (closed bars only). */
  private async candles(symbol: SymbolId, market: Market, tf: string, from: number, to: number, progress?: Progress): Promise<CandleSeries> {
    return this.core.series.history({ symbol, market, tf }, from, to, (p) => progress?.({ phase: `Loading ${symbol} ${tf} history`, done: p.done, total: p.total }));
  }

  private transform(cs: CandleSeries, req: Pick<BacktestRequest, 'chartType' | 'renko' | 'symbol' | 'market'>): CandleSeries {
    if (req.chartType === 'heikinashi') return heikinAshi(cs);
    if (req.chartType === 'renko') return renko(cs, { atrLength: 14, ...(req.renko || {}), tick: SYMBOL_SPECS[req.symbol][req.market].tickSize }).series;
    return cs;
  }

  /** Mark-price bars aligned to `bars` (futures liquidation checks use mark prices like Binance). */
  private async markBars(symbol: SymbolId, tf: string, bars: BarSeries): Promise<{ h: Float64Array; l: Float64Array; c: Float64Array } | null> {
    const p = parseTimeframe(tf);
    if (!p || !bars.length) return null;
    const iv = baseIntervalFor(p, 'futures');
    if (!iv) return null;
    const raw = await this.core.store.get('mark', 'futures', symbol, iv, bars.t[0], bars.tc[bars.length - 1]);
    const ivTf = intervalToTf(iv);
    const agg = ivTf.n === p.n && ivTf.unit === p.unit ? raw : aggregate(raw, p);
    const h = new Float64Array(bars.length).fill(NaN);
    const l = new Float64Array(bars.length).fill(NaN);
    const c = new Float64Array(bars.length).fill(NaN);
    let j = 0;
    for (let i = 0; i < bars.length; i++) {
      while (j < agg.length && agg.t[j] < bars.t[i]) j++;
      if (j < agg.length && agg.t[j] === bars.t[i]) {
        h[i] = agg.h[j];
        l[i] = agg.l[j];
        c[i] = agg.c[j];
      } else {
        // missing mark bar: fall back to trade prices for this bar
        h[i] = bars.h[i];
        l[i] = bars.l[i];
        c[i] = bars.c[i];
      }
    }
    return { h, l, c };
  }

  private brokerConfig(req: BacktestRequest): Partial<BrokerConfig> {
    const spec = SYMBOL_SPECS[req.symbol][req.market];
    const cfg: Partial<BrokerConfig> = { market: req.market, step: spec.stepSize, minQty: spec.minQty, liquidationFeeRate: req.market === 'futures' ? SYMBOL_SPECS[req.symbol].futures.liquidationFeeRate : 0.0125 };
    if (req.costs && req.costs !== 'script' && req.costs !== 'custom') {
      const c = costPreset(req.costs).costs;
      cfg.makerFee = c.makerFee;
      cfg.takerFee = c.takerFee;
      cfg.flatFee = c.flatFee;
      if (c.slippage.model !== 'none') cfg.slippageBps = c.slippage.bps;
    }
    return { ...cfg, ...(req.broker || {}) };
  }

  /**
   * Everything a run needs: script, bars (with warm-up), broker settings (costs, funding, mark,
   * real-OHLC fills) and a loader for request.security / htf data the script asks for.
   */
  async prepare(req: BacktestRequest, progress: Progress, signal: { cancelled: boolean }): Promise<Prepared> {
    if (!isSymbol(req.symbol) || (req.market !== 'spot' && req.market !== 'futures')) throw new Error('Validation: invalid instrument');
    const tf = parseTimeframe(req.tf);
    if (!tf) throw new Error(`Validation: invalid timeframe ${req.tf}`);
    if (!(req.to > req.from)) throw new Error('Validation: the end date must be after the start date');
    // ---- script
    let code = req.code;
    let language: ScriptLanguage = req.language === 'python' ? 'python' : 'pine';
    let name = req.name || 'Script';
    if (code === undefined) {
      const doc = req.scriptId ? this.scripts.library.get(req.scriptId) : undefined;
      if (!doc) throw new Error('Script not found');
      code = doc.code;
      language = doc.language;
      name = doc.name;
    }
    progress({ phase: 'Analyzing script' });
    const spec = { symbol: req.symbol, market: req.market, tf: req.tf, chartType: req.chartType === 'heikinashi' || req.chartType === 'renko' ? req.chartType : ('candles' as const) };
    const ctx = runContext(spec);
    const an = await this.scripts.pool.analyze(language, code, ctx);
    if (!an.ok) throw new Error(`Script error${an.error?.line ? ` (line ${an.error.line})` : ''}: ${an.error?.message}`);
    if (an.meta?.type !== 'strategy') throw new Error(`"${an.meta?.title}" is an indicator — the Strategy Tester needs a strategy (strategy() in Pine, @strategy in Python).`);
    name = req.name || an.meta.title || name;
    // ---- data
    const warmup = Math.max(0, Math.min(20000, req.warmupBars ?? 500));
    const fromWarm = timeForBarsBack(tf, bucketStart(tf, req.from), warmup);
    const to = Math.min(req.to, Date.now());
    let cs = await this.candles(req.symbol, req.market, req.tf, fromWarm, to, progress);
    if (signal.cancelled) throw new Error('Cancelled');
    if (cs.length < 2) throw new Error('No historical data for this range');
    const real = cs;
    cs = this.transform(cs, req);
    const bars = fromCandles(cs, req.tf, spec.chartType);
    const tradeFrom = Math.max(0, cs.lowerBound(req.from));
    if (tradeFrom >= bars.length - 1) throw new Error('The test range contains no complete bars');
    const brokerCfg: Partial<BrokerConfig> = { ...(req.costs === 'script' ? {} : this.brokerConfig(req)), market: req.market, step: SYMBOL_SPECS[req.symbol][req.market].stepSize, tradeFrom };
    if (req.costs === 'script') Object.assign(brokerCfg, req.broker || {});
    const warnings: string[] = [];
    let fills = 'Bar OHLC path (open → nearer extreme → other extreme → close)';
    if (req.chartType === 'heikinashi' && req.fillOnStandardOhlc !== false) {
      warnings.push('Heikin-Ashi signals; orders filled on real OHLC prices of the same bars (TradingView "fill orders on standard OHLC").');
      brokerCfg.fillData = fromCandles(real, req.tf, 'candles');
    } else if (req.chartType === 'heikinashi') warnings.push('Orders fill at synthetic Heikin-Ashi prices — results are not achievable in real trading.');
    if (req.chartType === 'renko') warnings.push('Renko bricks have no fixed duration and their prices are synthetic: fills at brick prices are optimistic. Use Renko results as a rough signal study only.');
    // ---- futures extras
    let fundingN = 0;
    let markUsed = false;
    if (req.market === 'futures') {
      try {
        progress({ phase: 'Loading funding rates' });
        const f = await this.funding.get(req.symbol, bars.t[0], bars.tc[bars.length - 1]);
        brokerCfg.funding = f;
        fundingN = f.t.length;
      } catch (e) {
        warnings.push(`Funding rates unavailable (${(e as Error).message}) — funding not applied.`);
      }
      if (req.chartType !== 'renko') {
        try {
          progress({ phase: 'Loading mark prices' });
          const m = await this.markBars(req.symbol, req.tf, bars);
          if (m) {
            brokerCfg.mark = m;
            markUsed = true;
          }
        } catch (e) {
          warnings.push(`Mark prices unavailable (${(e as Error).message}) — liquidations checked against trade prices.`);
        }
      }
    }
    // ---- bar magnifier (intrabar precision from lower-timeframe klines)
    let magnifier: Magnifier | undefined;
    if (req.chartType !== 'renko' && req.intrabar !== 'off') {
      const iv = this.magnifierInterval(req, tf, bars.tc[bars.length - 1] - bars.t[0], bars.length);
      if (iv) {
        try {
          progress({ phase: `Loading ${iv} klines for intrabar precision` });
          const sub = await this.core.store.get('klines', req.market, req.symbol, iv, bars.t[0], bars.tc[bars.length - 1], progress);
          if (signal.cancelled) throw new Error('Cancelled');
          magnifier = buildMagnifier(bars, sub, iv);
          const cov = magnifierCoverage(magnifier, tradeFrom);
          fills = `Bar magnifier: orders fill along the ${iv} klines inside each ${req.tf} bar (${Math.round(cov * 100)}% of bars), each following open → nearer extreme → other extreme → close`;
          if (cov < 0.95) warnings.push(`Intrabar data (${iv}) covers ${Math.round(cov * 100)}% of the bars; the rest use the bar's own OHLC path.`);
        } catch (e) {
          if ((e as Error).message === 'Cancelled') throw e;
          warnings.push(`Intrabar precision unavailable (${(e as Error).message}); bar OHLC paths used.`);
        }
      } else if (req.intrabar && req.intrabar !== 'auto') warnings.push(`${req.intrabar} intrabar data is not finer than ${req.tf} or too large for this range; bar OHLC paths used.`);
    }
    if (markUsed) fills += '; liquidations on mark price';
    if (signal.cancelled) throw new Error('Cancelled');
    const security: Record<string, BarSeries> = {};
    const loadSecurity = async (keys: string[]) => {
      for (const key of keys) {
        if (security[key]) continue;
        const kp = keyParts(key);
        if (!isSymbol(kp.symbol)) throw new Error(`Unsupported symbol ${kp.symbol}`);
        const ktf = parseTimeframe(kp.tf);
        if (!ktf) throw new Error(`Invalid timeframe ${kp.tf}`);
        progress({ phase: `Loading ${kp.symbol}${kp.metric ? ` ${METRICS[kp.metric].title.toLowerCase()}` : ''} ${kp.tf}` });
        const from2 = timeForBarsBack(ktf, bucketStart(ktf, fromWarm), warmup);
        if (kp.metric) {
          const stats = await this.core.series.metricHistory({ symbol: kp.symbol as SymbolId, tf: kp.tf, metric: kp.metric }, from2, to, (p) => progress({ phase: `Loading ${kp.symbol} futures statistics`, done: p.done, total: p.total }));
          if (!stats.length) warnings.push(`No ${METRICS[kp.metric].title.toLowerCase()} for ${kp.symbol} in this range (Binance has these statistics since September 2020).`);
          security[key] = fromCandles(stats, kp.tf, 'candles');
          continue;
        }
        let other = await this.candles(kp.symbol as SymbolId, kp.market, kp.tf, from2, to, progress);
        if (kp.chartType === 'heikinashi') other = heikinAshi(other);
        security[key] = fromCandles(other, kp.tf, kp.chartType);
      }
    };
    return { code, language, name, ctx, bars, tradeFrom, brokerCfg, security, loadSecurity, warnings, fills, fundingN, markUsed, source: `Binance ${req.market} klines (${baseIntervalFor(tf, req.market)} cache, aggregated to ${req.tf})`, inputs: an.inputs, magnifier };
  }

  /** Finest lower-timeframe interval that is useful (≥ 3 per bar) and practical (≤ 1.5 M klines). */
  private magnifierInterval(req: BacktestRequest, tf: Timeframe, spanMs: number, nBars: number): string | null {
    const tfMs = tfDurationMs(tf);
    const MAX = 1_500_000;
    const candidates = req.intrabar && req.intrabar !== 'auto' ? [req.intrabar] : ['1s', '1m', '5m', '15m', '1h'];
    for (const iv of candidates) {
      if (iv === '1s' && req.market !== 'spot') continue;
      const ms = intervalMs(iv);
      if (tfMs < ms * 3 || tfMs % ms !== 0) continue;
      if (spanMs / ms > MAX) continue;
      void nBars;
      return iv;
    }
    return null;
  }

  async run(req: BacktestRequest, progress: Progress, signal: { cancelled: boolean; onCancel?: () => void }): Promise<BacktestRecord> {
    const t0 = Date.now();
    const P = await this.prepare(req, progress, signal);
    const { bars, tradeFrom, brokerCfg, security } = P;
    const runOnce = async (cfg: Partial<BrokerConfig>) => {
      for (let round = 0; round < 4; round++) {
        const handle = this.scripts.pool.run({ lang: P.language, code: P.code, ctx: P.ctx, inputs: req.inputs || {}, strategy: cfg, data: bars, security, magnifier: P.magnifier }, { timeoutMs: 30 * 60000 });
        signal.onCancel = () => handle.cancel();
        const r = await handle.promise;
        if (!r.need.length) return r.result;
        await P.loadSecurity(r.need);
      }
      throw new Error('Could not resolve the data the script requests');
    };
    progress({ phase: 'Running strategy', message: `${bars.length - tradeFrom} bars + ${tradeFrom} warm-up` });
    const result = await runOnce(brokerCfg);
    if (signal.cancelled) throw new Error('Cancelled');
    const rec: BacktestRecord = {
      id: uid('bt'),
      created: Date.now(),
      label: req.label || `${P.name} · ${SYMBOL_SPECS[req.symbol].base}${req.market === 'futures' ? '.P' : ''} ${req.tf}`,
      request: { ...req, code: undefined },
      script: { id: req.scriptId || null, name: P.name, language: P.language, code: P.code },
      ok: result.ok,
      error: result.ok ? undefined : `${result.error?.line ? `Line ${result.error.line}: ` : ''}${result.error?.message}`,
      metrics: null,
      curves: null,
      trades: [],
      openTrades: [],
      feeSensitivity: null,
      warnings: [...P.warnings, ...result.warnings.filter((w) => w.kind === 'runtime' || w.kind === 'compat').map((w) => w.message), ...(result.strategy?.warnings || [])],
      scriptWarnings: result.warnings.filter((w) => w.kind === 'lookahead' || w.kind === 'repaint').map((w) => ({ line: w.line, kind: w.kind, message: w.message })),
      info: { bars: bars.length - tradeFrom, warmup: tradeFrom, source: P.source, fills: P.fills, funding: P.fundingN, mark: P.markUsed, ms: 0, config: { ...(result.strategy?.config || {}) }, security: Object.keys(security).map(describeKey) },
      logs: result.logs.slice(-500),
    };
    if (result.ok && result.strategy) {
      const m = computeMetrics(result.strategy, bars, { from: tradeFrom, riskFree: req.riskFree ?? 0 });
      const { curves, ...rest } = m;
      rec.metrics = rest;
      rec.curves = downsample(curves);
      rec.trades = result.strategy.trades.slice(-20000);
      rec.openTrades = result.strategy.openTrades;
      progress({ phase: 'Random counterparts' });
      rec.random = randomCounterparts(result.strategy, bars, tradeFrom, curves.equity, brokerCfg.fillData as BarSeries | undefined);
      rec.monteCarlo = tradeMonteCarlo(tradeReturns(result.strategy, curves.equity, tradeFrom));
      if (req.feeSensitivity) {
        progress({ phase: 'Fee sensitivity' });
        const fees = [0, 0.0002, 0.0005, 0.001, 0.002];
        const rows = await Promise.all(
          fees.map(async (fee) => {
            const r = await runOnce({ ...brokerCfg, makerFee: fee, takerFee: fee, flatFee: 0 });
            if (!r.ok || !r.strategy) return null;
            const mm = computeMetrics(r.strategy, bars, { from: tradeFrom });
            return { feePct: fee * 100, netProfitPct: mm.netProfitPct, profitFactor: mm.all.profitFactor, maxDrawdownPct: mm.maxDrawdownPct, trades: mm.all.trades, sharpe: mm.sharpe };
          }),
        );
        rec.feeSensitivity = rows.filter((x): x is FeeSensitivityRow => !!x);
      }
    }
    rec.info.ms = Date.now() - t0;
    if (!req.ephemeral) {
      this.store.put(rec, true);
      this.core.router.broadcast('backtests:changed', { id: rec.id });
      if (rec.ok && rec.metrics && req.chartType !== 'renko') {
        const p = this.replayCheck(rec, P).finally(() => this.replays.delete(rec.id));
        this.replays.set(rec.id, p);
      }
    }
    return rec;
  }

  /**
   * In the background after a run: replay the most recent bars as a bot sees them and compare the
   * strategy's position and orders with the backtest's — a lookahead check of the code itself.
   */
  private async replayCheck(rec: BacktestRecord, P: Prepared): Promise<void> {
    const q = rec.request;
    let replay: NonNullable<BacktestRecord['replay']>;
    try {
      const r = await this.scripts.repaintCheck({
        code: P.code,
        language: P.language,
        inputs: q.inputs || {},
        spec: { symbol: q.symbol, market: q.market, tf: q.tf, chartType: q.chartType === 'heikinashi' ? 'heikinashi' : 'candles' },
        strategy: { market: q.market },
        window: 150,
        budgetMs: P.language === 'python' ? 20000 : 6000,
        maxChecks: P.language === 'python' ? 16 : 60,
      });
      replay = { ok: r.ok, error: r.error, checked: r.checked, window: r.window, differing: r.badTimes.length, diffs: r.diffs.slice(0, 6), at: Date.now() };
    } catch (e) {
      replay = { ok: false, error: (e as Error).message.replace(/^Validation: /, ''), checked: 0, window: 0, differing: 0, diffs: [], at: Date.now() };
    }
    const cur = this.store.get(rec.id);
    if (!cur) return;
    cur.replay = replay;
    this.store.put(cur, true);
    this.core.router.broadcast('backtests:changed', { id: rec.id });
  }

  /** The record once its live-replay check finished (or after `timeoutMs`). */
  async withReplay(id: string, timeoutMs = 30000): Promise<BacktestRecord | null> {
    const p = this.replays.get(id);
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, timeoutMs))]);
    return this.getRecord(id);
  }

  /** A saved backtest record (null when unknown). */
  getRecord(id: string): BacktestRecord | null {
    return this.store.get(String(id)) || null;
  }

  private register(): void {
    const r = this.core.router;
    r.topic('backtest', async (req: BacktestRequest, push) => {
      const signal: { cancelled: boolean; onCancel?: () => void } = { cancelled: false };
      void this.run(req, (p) => push({ type: 'progress', ...p }), signal)
        .then((rec) => push({ type: 'done', record: rec }))
        .catch((e) => push({ type: 'error', message: String((e as Error).message || e).replace(/^Validation: /, '') }));
      return () => {
        signal.cancelled = true;
        signal.onCancel?.();
      };
    });
    r.handle('backtests:list', () =>
      this.store
        .loadAll()
        .sort((a, b) => b.created - a.created)
        .map((x) => ({ id: x.id, created: x.created, label: x.label, ok: x.ok, script: { id: x.script.id, name: x.script.name, language: x.script.language }, request: x.request, summary: x.metrics ? { netProfitPct: x.metrics.netProfitPct, maxDrawdownPct: x.metrics.maxDrawdownPct, profitFactor: x.metrics.all.profitFactor, trades: x.metrics.all.trades, sharpe: x.metrics.sharpe, winRate: x.metrics.all.winRate, buyHoldPct: x.metrics.buyHold.returnPct } : null })),
    );
    r.handle('backtests:get', ([id]) => {
      const rec = this.store.get(String(id));
      if (!rec) throw new Error('Backtest not found');
      return rec;
    });
    r.handle('backtests:delete', ([id]) => {
      this.store.delete(String(id));
      this.core.router.broadcast('backtests:changed', { id });
      return true;
    });
    r.handle('backtests:rename', ([id, label]) => {
      const rec = this.store.get(String(id));
      if (!rec) throw new Error('Backtest not found');
      rec.label = String(label).slice(0, 160);
      this.store.put(rec, true);
      this.core.router.broadcast('backtests:changed', { id });
      return true;
    });
  }
}

export function registerBacktests(core: AppCore, scripts: ScriptService): BacktestService {
  return new BacktestService(core, scripts);
}
