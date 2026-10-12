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
import fs from 'node:fs';
import type { AppCore } from '../core';
import type { ScriptService } from '../scripts/service';
import { runContext } from '../scripts/service';
import { DocStore, uid, readJson, writeJsonAtomic } from '../storage/jsonStore';
import { computeMetrics, type Metrics } from '../../engine/backtest/metrics';
import { keyParts } from '../../engine/host';
import { fromCandles } from '../../engine/data';
import type { BrokerConfig } from '../../engine/backtest/broker';
import type { BarSeries, ScriptLanguage, StrategyRaw, TradeRec } from '../../engine/types';
import { CandleSeries, aggregate, heikinAshi, renko, type RenkoOptions } from '../../shared/candles';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, timeForBarsBack, baseIntervalFor, intervalToTf, bucketStart } from '../../shared/timeframes';
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
  warnings: string[];
  info: { bars: number; warmup: number; source: string; fills: string; funding: number; mark: boolean; ms: number; config: Record<string, unknown> };
  logs: { bar: number; time: number; level: string; msg: string }[];
}

export type Progress = (p: { phase: string; done?: number; total?: number; message?: string }) => void;

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

/** Historical funding events per symbol, cached with coverage ranges. */
class FundingCache {
  constructor(
    private dir: string,
    private core: AppCore,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  async get(symbol: SymbolId, from: number, to: number): Promise<{ t: Float64Array; rate: Float64Array }> {
    const file = path.join(this.dir, `${symbol}.json`);
    const doc = readJson<{ ranges: [number, number][]; events: [number, number][] }>(file, { ranges: [], events: [] });
    const covered = doc.ranges.some(([a, b]) => a <= from && b >= Math.min(to, Date.now() - 60000));
    if (!covered) {
      const map = new Map(doc.events.map(([t, r]) => [t, r]));
      let start = from;
      for (let guard = 0; guard < 100 && start < to; guard++) {
        const rows = await this.core.hub.rest.fundingRates(symbol, start, to, 1000);
        for (const r of rows) map.set(r.t, r.rate);
        if (rows.length < 1000) break;
        start = rows[rows.length - 1].t + 1;
      }
      doc.events = [...map.entries()].sort((a, b) => a[0] - b[0]);
      doc.ranges = mergeRanges([...doc.ranges, [from, Math.min(to, Date.now() - 60000)]]);
      writeJsonAtomic(file, doc);
    }
    const ev = doc.events.filter(([t]) => t >= from && t <= to);
    return { t: Float64Array.from(ev.map((e) => e[0])), rate: Float64Array.from(ev.map((e) => e[1])) };
  }
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const s = r.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

export class BacktestService {
  private store: DocStore<BacktestRecord>;
  private funding: FundingCache;

  constructor(
    private core: AppCore,
    private scripts: ScriptService,
  ) {
    this.store = new DocStore<BacktestRecord>(path.join(core.paths.userData, 'backtests'));
    this.funding = new FundingCache(path.join(core.paths.data, 'funding'), core);
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
        progress({ phase: `Loading ${kp.symbol} ${kp.tf}` });
        const from2 = timeForBarsBack(ktf, bucketStart(ktf, fromWarm), warmup);
        let other = await this.candles(kp.symbol as SymbolId, kp.market, kp.tf, from2, to, progress);
        if (kp.chartType === 'heikinashi') other = heikinAshi(other);
        security[key] = fromCandles(other, kp.tf, kp.chartType);
      }
    };
    return { code, language, name, ctx, bars, tradeFrom, brokerCfg, security, loadSecurity, warnings, fills, fundingN, markUsed, source: `Binance ${req.market} klines (${baseIntervalFor(tf, req.market)} cache, aggregated to ${req.tf})`, inputs: an.inputs };
  }

  async run(req: BacktestRequest, progress: Progress, signal: { cancelled: boolean; onCancel?: () => void }): Promise<BacktestRecord> {
    const t0 = Date.now();
    const P = await this.prepare(req, progress, signal);
    const { bars, tradeFrom, brokerCfg, security } = P;
    const runOnce = async (cfg: Partial<BrokerConfig>) => {
      for (let round = 0; round < 4; round++) {
        const handle = this.scripts.pool.run({ lang: P.language, code: P.code, ctx: P.ctx, inputs: req.inputs || {}, strategy: cfg, data: bars, security }, { timeoutMs: 30 * 60000 });
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
      warnings: [...P.warnings, ...result.warnings.filter((w) => w.kind !== 'info').map((w) => w.message), ...(result.strategy?.warnings || [])],
      info: { bars: bars.length - tradeFrom, warmup: tradeFrom, source: P.source, fills: P.fills, funding: P.fundingN, mark: P.markUsed, ms: 0, config: { ...(result.strategy?.config || {}) } },
      logs: result.logs.slice(-500),
    };
    if (result.ok && result.strategy) {
      const m = computeMetrics(result.strategy, bars, { from: tradeFrom, riskFree: req.riskFree ?? 0 });
      const { curves, ...rest } = m;
      rec.metrics = rest;
      rec.curves = downsample(curves);
      rec.trades = result.strategy.trades.slice(-20000);
      rec.openTrades = result.strategy.openTrades;
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
    this.store.put(rec, true);
    this.core.router.broadcast('backtests:changed', { id: rec.id });
    return rec;
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
