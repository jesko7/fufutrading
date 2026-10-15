/**
 * Tools the AI assistant uses to work inside the app — the same interfaces a user has:
 * documentation, the script library, compile checks, script runs on real Binance data,
 * backtests and optimizations (recorded in the Strategy Tester / Optimizer history), market
 * statistics and "show it to the user" actions. Results are compact JSON so the model can
 * reason about them; the UI renders them as cards.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppCore } from '../core';
import type { ScriptService } from '../scripts/service';
import { runContext } from '../scripts/service';
import type { BacktestService, BacktestRecord, BacktestRequest } from '../backtest/service';
import type { OptimizerService, OptimizeRequest } from '../backtest/optimizer';
import type { McpTool } from './mcp';
import { pineFunctionReference } from '../../engine/docs';
import { fromPacked } from '../../engine/data';
import { keyParts } from '../../engine/host';
import type { ScriptLanguage, ScriptResult } from '../../engine/types';
import { isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfDurationMs } from '../../shared/timeframes';
import { COST_PRESETS } from '../../shared/trading/presets';

export interface AiToolDeps {
  core: AppCore;
  scripts: ScriptService;
  backtests: BacktestService;
  optimizer: OptimizerService;
  docsDir: string;
}

/** Structured result shown to the user as a card next to the model's text. */
export interface AiCard {
  kind: 'script' | 'check' | 'run' | 'backtest' | 'robustness' | 'optimization' | 'market' | 'docs' | 'list' | 'ui';
  title: string;
  data: Record<string, unknown>;
}

export interface AiTool extends McpTool {
  /** Read-only tools are available in every mode; others only when building. */
  readOnly: boolean;
  card?: (args: Record<string, unknown>, result: any) => AiCard | null;
}

const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

function str(v: unknown, name: string, max = 200000): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required`);
  if (v.length > max) throw new Error(`"${name}" is too long`);
  return v;
}

function lang(v: unknown): ScriptLanguage {
  if (v === 'python' || v === 'pine') return v;
  throw new Error('"language" must be "pine" or "python"');
}

function instrument(args: Record<string, unknown>): { symbol: SymbolId; market: Market; tf: string } {
  const symbol = String(args.symbol || 'BTCUSDT').toUpperCase().replace('/', '') as SymbolId;
  if (!isSymbol(symbol)) throw new Error('symbol must be BTCUSDT, ETHUSDT or SOLUSDT');
  const market: Market = args.market === 'futures' ? 'futures' : 'spot';
  const tf = String(args.tf || '1h');
  if (!parseTimeframe(tf)) throw new Error(`invalid timeframe "${tf}" (examples: 1m, 15m, 1h, 4h, 1D)`);
  return { symbol, market, tf };
}

function errText(e?: { line?: number; col?: number; message: string } | null): string | null {
  return e ? `${e.line ? `line ${e.line}${e.col ? `:${e.col}` : ''}: ` : ''}${e.message}` : null;
}

function readDoc(dir: string, file: string): string {
  for (const d of [dir, path.resolve(__dirname, '../../docs'), path.resolve(process.cwd(), 'docs')]) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return `(${file} not found)`;
}

const DAY = 86400000;
const TF_LADDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1D'];

/** The timeframes just below and above `tf` on the usual ladder. */
function neighbourTfs(tf: string): string[] {
  const ms = tfDurationMs(parseTimeframe(tf)!);
  let i = TF_LADDER.findIndex((x) => tfDurationMs(parseTimeframe(x)!) === ms);
  if (i < 0) {
    // custom timeframe: the nearest ladder steps on both sides
    const lower = TF_LADDER.filter((x) => tfDurationMs(parseTimeframe(x)!) < ms);
    const upper = TF_LADDER.filter((x) => tfDurationMs(parseTimeframe(x)!) > ms);
    return [lower[lower.length - 1], upper[0]].filter(Boolean) as string[];
  }
  return [TF_LADDER[i - 1], TF_LADDER[i + 1]].filter(Boolean) as string[];
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

const INSTRUMENT_SCHEMA = {
  symbol: { type: 'string', enum: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], description: 'Instrument (default BTCUSDT)' },
  market: { type: 'string', enum: ['spot', 'futures'], description: 'spot or USDⓈ-M perpetual futures (default spot)' },
  tf: { type: 'string', description: 'Timeframe such as 1m, 5m, 15m, 1h, 4h, 1D; custom ones like 7m or 90m work too (default 1h)' },
};

const CODE_SCHEMA = {
  id: { type: 'string', description: 'Script id from the library (alternative to code)' },
  code: { type: 'string', description: 'Script source (alternative to id)' },
  language: { type: 'string', enum: ['pine', 'python'], description: 'Language of `code`' },
};

function summarizeMetrics(rec: BacktestRecord) {
  const m = rec.metrics;
  if (!m) return null;
  return {
    period: `${new Date(m.start).toISOString().slice(0, 10)} → ${new Date(m.end).toISOString().slice(0, 10)} (${Math.round(m.days)} days)`,
    netProfitPct: r2(m.netProfitPct),
    cagrPct: r2(m.cagr),
    maxDrawdownPct: r2(m.maxDrawdownPct),
    sharpe: r2(m.sharpe),
    sortino: r2(m.sortino),
    calmar: r2(m.calmar),
    trades: m.all.trades,
    winRatePct: r2(m.all.winRate * 100),
    profitFactor: r2(m.all.profitFactor),
    avgTradePct: r2(m.all.avgTradePct),
    expectancy: r2(m.all.expectancy),
    exposurePct: r2(m.exposure),
    feesPaid: r2(m.feesPaid),
    fundingPaid: r2(m.fundingPaid),
    liquidations: m.liquidations,
    long: { trades: m.long.trades, netProfit: r2(m.long.netProfit), winRatePct: r2(m.long.winRate * 100) },
    short: { trades: m.short.trades, netProfit: r2(m.short.netProfit), winRatePct: r2(m.short.winRate * 100) },
    buyAndHold: { returnPct: r2(m.buyHold.returnPct), maxDrawdownPct: r2(m.buyHold.maxDrawdownPct), sharpe: r2(m.buyHold.sharpe) },
    cashReturnPct: r2(m.cash.returnPct),
    yearly: m.yearly.map((y) => ({ year: y.year, strategyPct: r2(y.returnPct), buyHoldPct: r2(y.buyHoldPct) })),
    regimes: m.regimes.map((g) => ({ regime: `${g.group}: ${g.name}`, sharePct: r2(g.share * 100), strategyPct: r2(g.strategyReturnPct), buyHoldPct: r2(g.buyHoldReturnPct), trades: g.trades })),
    greeks: m.greeks
      ? {
          alphaPctPerYear: r2(m.greeks.alpha),
          beta: r2(m.greeks.beta),
          correlation: r2(m.greeks.correlation),
          volatilityPct: r2(m.greeks.sigma),
          omega: r2(m.greeks.omega),
          upCapturePct: r2(m.greeks.upCapture),
          downCapturePct: r2(m.greeks.downCapture),
          downsideBeta: r2(m.greeks.downsideBeta),
          var95DailyPct: r2(m.greeks.var95),
          days: m.greeks.days,
        }
      : null,
    vsRandom: randomSummary(rec),
  };
}

/** The strategy against random twins (same trades at random times / coin-flip directions). */
function randomSummary(rec: BacktestRecord) {
  const r = rec.random;
  if (!r) return null;
  const t = r.timing;
  return {
    verdict: r.verdict.title,
    twins: r.iterations,
    timing: { beatsReturnPct: r2(t.beats.returnPct), beatsSharpePct: r2(t.beats.sharpe), pReturn: r4(t.pReturn), pSharpe: r4(t.pSharpe), randomMedianReturnPct: r2(t.random.returnPct.p50), random95thReturnPct: r2(t.random.returnPct.p95) },
    direction: r.direction ? { beatsReturnPct: r2(r.direction.beats.returnPct), pReturn: r4(r.direction.pReturn) } : null,
    notes: r.notes.filter((n) => !/bar opens/.test(n)),
  };
}

/** Average forward returns after the bars in `idx` (entry at the signal bar's close). */
function forward(c: ArrayLike<number>, idx: number[], h: number) {
  let s = 0;
  let k = 0;
  let pos = 0;
  for (const i of idx) {
    if (i + h >= c.length || !(c[i] > 0)) continue;
    const r = c[i + h] / c[i] - 1;
    s += r;
    k++;
    if (r > 0) pos++;
  }
  return k ? { n: k, avgPct: r4((s / k) * 100), upPct: r2((pos / k) * 100) } : null;
}

/** Pearson correlation of an indicator's values with the forward return over `h` bars (information coefficient). */
function infoCoefficient(c: ArrayLike<number>, v: ArrayLike<number>, h: number): number | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i + h < c.length; i++) {
    const x = v[i];
    if (x !== x || !(c[i] > 0)) continue;
    const y = c[i + h] / c[i] - 1;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  if (n < 30) return null;
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  return vx > 0 && vy > 0 ? r4(cov / Math.sqrt(vx * vy)) : null;
}

const HORIZONS = [1, 5, 20];

function signalQuality(c: ArrayLike<number>, series: { title: string; values: ArrayLike<number> }[]) {
  const all = Array.from({ length: c.length }, (_, i) => i);
  const baseline = Object.fromEntries(HORIZONS.map((h) => [`${h}bars`, forward(c, all, h)]));
  const signals = series
    .map((s) => {
      const idx: number[] = [];
      for (let i = 0; i < s.values.length; i++) if (s.values[i] && s.values[i] === s.values[i]) idx.push(i);
      return { title: s.title, signals: idx.length, after: Object.fromEntries(HORIZONS.map((h) => [`${h}bars`, forward(c, idx, h)])) };
    })
    .filter((s) => s.signals > 0);
  return signals.length ? { baseline, signals } : null;
}

async function loadSecurityFor(deps: AiToolDeps, keys: string[], spanMs: number): Promise<Record<string, Float64Array>> {
  const out: Record<string, Float64Array> = {};
  for (const key of keys) {
    const kp = keyParts(key);
    const ptf = parseTimeframe(kp.tf);
    if (!isSymbol(kp.symbol) || !ptf) throw new Error(`unsupported data request ${key}`);
    const n = Math.min(20000, Math.max(300, Math.ceil(spanMs / tfDurationMs(ptf)) + 50));
    out[key] = await deps.scripts.closedBars({ symbol: kp.symbol as SymbolId, market: kp.market, tf: kp.tf, chartType: kp.chartType === 'heikinashi' ? 'heikinashi' : 'candles' }, n);
  }
  return out;
}

/** Resolve code from an id or inline code. */
function codeOf(deps: AiToolDeps, args: Record<string, unknown>): { code: string; language: ScriptLanguage; name: string; id: string | null } {
  if (args.id) {
    const d = deps.scripts.library.get(String(args.id));
    if (!d) throw new Error(`script "${args.id}" not found (use list_scripts)`);
    return { code: d.code, language: d.language, name: d.name, id: d.id };
  }
  return { code: str(args.code, 'code'), language: lang(args.language), name: 'AI draft', id: null };
}

export function aiTools(deps: AiToolDeps): AiTool[] {
  const { scripts } = deps;
  return [
    {
      name: 'get_docs',
      readOnly: true,
      description:
        'FuFu documentation. Read it before writing code. Topics: "pine" (supported Pine Script subset and semantics), "pine_functions" (every supported built-in with parameters, generated from the engine), "python" (the fufu Python API), "backtesting" (fills, costs, metrics), "examples" (example scripts from the built-in library).',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: ['pine', 'pine_functions', 'python', 'backtesting', 'examples'] } }, required: ['topic'] },
      async run(args) {
        switch (args.topic) {
          case 'pine':
            return readDoc(deps.docsDir, 'pine.md');
          case 'pine_functions':
            return pineFunctionReference();
          case 'python':
            return readDoc(deps.docsDir, 'python.md');
          case 'backtesting':
            return readDoc(deps.docsDir, 'backtesting.md');
          case 'examples': {
            const ids = ['builtin:strat_ma_cross', 'builtin:strat_rsi_reversion', 'builtin:rsi', 'builtin:py_sma_cross', 'builtin:py_zscore'];
            return ids
              .map((id) => scripts.library.get(id))
              .filter(Boolean)
              .map((d) => `### ${d!.name} (${d!.language}, id ${d!.id})\n\n\`\`\`${d!.language === 'python' ? 'python' : 'pine'}\n${d!.code}\n\`\`\``)
              .join('\n\n');
          }
          default:
            throw new Error('unknown topic');
        }
      },
      card: (args) => ({ kind: 'docs', title: `Read the ${String(args.topic).replace('_', ' ')} docs`, data: { topic: args.topic } }),
    },
    {
      name: 'list_scripts',
      readOnly: true,
      description: 'List scripts in the library (built-in and user scripts) with id, name, language, kind (indicator/strategy) and description.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['indicator', 'strategy', 'all'] }, query: { type: 'string', description: 'Filter by name/description' } } },
      async run(args) {
        const q = String(args.query || '').toLowerCase();
        return scripts.library
          .list()
          .filter((s) => (!args.kind || args.kind === 'all' || s.kind === args.kind) && (!q || `${s.name} ${s.description || ''}`.toLowerCase().includes(q)))
          .slice(0, 120)
          .map((s) => ({ id: s.id, name: s.name, language: s.language, kind: s.kind, builtin: s.builtin, description: s.description || undefined }));
      },
      card: (_a, r) => {
        const n = Array.isArray(r) ? r.length : 0;
        return { kind: 'list', title: `Looked through ${n} script${n === 1 ? '' : 's'}`, data: {} };
      },
    },
    {
      name: 'read_script',
      readOnly: true,
      description: 'Read a script from the library: name, language and source code.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(args) {
        const d = scripts.library.get(str(args.id, 'id'));
        if (!d) throw new Error(`script "${args.id}" not found`);
        return { id: d.id, name: d.name, language: d.language, kind: d.kind, builtin: d.builtin, code: d.code };
      },
      card: (_a, r) => ({ kind: 'script', title: `Read “${r?.name}”`, data: { id: r?.id, name: r?.name, language: r?.language, read: true } }),
    },
    {
      name: 'check_script',
      readOnly: true,
      description:
        'Compile/analyse code without running it: syntax and compile errors (with line numbers), lookahead and repainting warnings, unsupported features, inputs, plots and alert conditions. Always check code before saving or running it.',
      inputSchema: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string', enum: ['pine', 'python'] } }, required: ['code', 'language'] },
      async run(args) {
        const code = str(args.code, 'code');
        const language = lang(args.language);
        const a = await scripts.pool.analyze(language, code, runContext({ symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' }));
        return {
          ok: a.ok,
          error: errText(a.error),
          errorKind: a.error?.kind,
          type: a.meta?.type,
          title: a.meta?.title,
          warnings: a.warnings.map((w) => `${w.line ? `line ${w.line}: ` : ''}[${w.kind}] ${w.message}`),
          inputs: a.inputs.map((i) => ({ key: i.key, title: i.title, type: i.type, default: i.defval, min: i.min, max: i.max, options: i.options })),
          plots: a.plots?.map((p) => p.title),
          alertconditions: a.alertconditions,
          dataRequests: a.security,
        };
      },
      card: (_a, r) => ({ kind: 'check', title: r?.ok ? `Compiles${r.warnings?.length ? ` · ${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}` : ''}` : `Error: ${r?.error}`, data: { ok: r?.ok, error: r?.error, warnings: r?.warnings } }),
    },
    {
      name: 'save_script',
      readOnly: false,
      description:
        'Save a script to the user\'s library (new, or update an existing user script by id; built-in scripts are copied). Check it first. Returns the id and the compile result. The user sees saved scripts in the Script Editor and can add them to charts.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, language: { type: 'string', enum: ['pine', 'python'] }, code: { type: 'string' }, id: { type: 'string', description: 'Existing user script to update' }, description: { type: 'string', description: 'One-line description' } },
        required: ['name', 'language', 'code'],
      },
      async run(args) {
        const language = lang(args.language);
        let code = str(args.code, 'code');
        const name = str(args.name, 'name', 120).trim();
        const desc = typeof args.description === 'string' ? args.description.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
        // a description header shows in the library
        if (desc && !/@description/.test(code)) code = language === 'python' ? `# @description ${desc}\n${code}` : `// @description ${desc}\n${code}`;
        let id = typeof args.id === 'string' && args.id ? args.id : undefined;
        if (id) {
          const cur = scripts.library.get(id);
          if (!cur) throw new Error(`script "${id}" not found`);
          if (cur.builtin) id = undefined; // built-ins are copied
        }
        const meta = scripts.library.save({ id, name, code, language });
        const a = await scripts.pool.analyze(language, code, runContext({ symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' }));
        return { id: meta.id, name: meta.name, language, kind: a.meta?.type, compiles: a.ok, error: errText(a.error), warnings: a.warnings.length };
      },
      card: (_a, r) => ({ kind: 'script', title: `Saved “${r?.name}”`, data: { id: r?.id, name: r?.name, language: r?.language, kind: r?.kind, compiles: r?.compiles, error: r?.error } }),
    },
    {
      name: 'run_script',
      readOnly: true,
      description:
        "Run an indicator or strategy once on real recent Binance data (closed bars) and report errors, the last values and statistics of every plot, alert signals, log output and (for strategies) a short trade summary. Use it to verify an indicator behaves as intended. It also measures predictive value: each plot's information coefficient (correlation of its value with the return over the next 5 and 20 bars) and, for signals (plotshape/plotchar/alertcondition), the average return and share of up-moves 1, 5 and 20 bars after a signal against the baseline of all bars.",
      inputSchema: { type: 'object', properties: { ...CODE_SCHEMA, ...INSTRUMENT_SCHEMA, bars: { type: 'number', description: 'Bars of history (default 1000, max 20000)' }, inputs: { type: 'object', description: 'Input values by key' } } },
      async run(args) {
        const src = codeOf(deps, args);
        const ins = instrument(args);
        const nBars = Math.max(50, Math.min(20000, Math.round(Number(args.bars) || 1000)));
        const spec = { ...ins, chartType: 'candles' as const };
        const data = await scripts.closedBars(spec, nBars);
        const ctx = runContext(spec);
        const bars = fromPacked(data, ins.tf, 'candles');
        let security: Record<string, Float64Array> = {};
        let res: { result: ScriptResult; need: string[] } | null = null;
        for (let k = 0; k < 3; k++) {
          res = await scripts.pool.run({ lang: src.language, code: src.code, ctx, inputs: (args.inputs as Record<string, unknown>) || {}, data, security }, { timeoutMs: 120000 }).promise;
          if (!res.need.length) break;
          security = { ...security, ...(await loadSecurityFor(deps, res.need, bars.length ? bars.tc[bars.length - 1] - bars.t[0] : 0)) };
        }
        const r = res!.result;
        const n = bars.length;
        const plots = r.plots
          .filter((p) => p.kind === 'plot' || p.kind === 'shape' || p.kind === 'char')
          .slice(0, 16)
          .map((p) => {
            const v = p.values;
            let min = Infinity;
            let max = -Infinity;
            let nan = 0;
            let signals = 0;
            for (let i = 0; i < v.length; i++) {
              const x = v[i];
              if (x !== x) nan++;
              else {
                if (x < min) min = x;
                if (x > max) max = x;
                if (p.kind !== 'plot' && x) signals++;
              }
            }
            const last = Array.from(v.slice(-8)).map((x) => r4(x));
            return p.kind === 'plot'
              ? { title: p.title, last, min: r4(min), max: r4(max), naBars: nan, icNext5Bars: infoCoefficient(bars.c, v, 5), icNext20Bars: infoCoefficient(bars.c, v, 20) }
              : { title: p.title, kind: p.kind, signals, lastSignalBarsAgo: (() => { for (let i = v.length - 1; i >= 0; i--) if (v[i] && v[i] === v[i]) return v.length - 1 - i; return null; })() };
          });
        const alerts = r.alerts.map((a) => {
          let c = 0;
          for (let i = 0; i < a.values.length; i++) if (a.values[i]) c++;
          return { title: a.title, signals: c };
        });
        const st = r.strategy;
        return {
          ok: r.ok,
          error: r.error ? `${errText(r.error)}${r.error.bar !== undefined ? ` (bar ${r.error.bar})` : ''}` : null,
          type: r.meta?.type,
          bars: n,
          from: n ? new Date(bars.t[0]).toISOString() : null,
          to: n ? new Date(bars.t[n - 1]).toISOString() : null,
          lastClose: n ? bars.c[n - 1] : null,
          ms: Math.round(r.stats?.ms || 0),
          plots,
          alertconditions: alerts,
          signalQuality: signalQuality(bars.c, [
            ...r.plots.filter((p) => p.kind === 'shape' || p.kind === 'char').map((p) => ({ title: p.title, values: p.values })),
            ...r.alerts.map((a) => ({ title: `alertcondition: ${a.title}`, values: a.values })),
          ]),
          alertCalls: r.alertEvents.length,
          logs: r.logs.slice(-15).map((l) => `[${l.level}] bar ${l.bar}: ${l.msg}`),
          warnings: r.warnings.map((w) => `${w.line ? `line ${w.line}: ` : ''}${w.message}`).slice(0, 10),
          strategy: st ? { trades: st.trades.length, openPosition: st.position ?? 0, netProfit: r2(st.trades.reduce((s, t) => s + t.profit, 0)), lastTrades: st.trades.slice(-5).map((t) => ({ dir: t.dir === 1 ? 'long' : 'short', entry: r2(t.entryPrice), exit: r2(t.exitPrice), returnPct: r2(t.returnPct) })) } : undefined,
        };
      },
      card: (args, r) => ({ kind: 'run', title: r?.ok ? `Ran on ${String(args.symbol || 'BTCUSDT')} ${String(args.tf || '1h')} · ${r?.bars} bars` : `Run failed: ${r?.error}`, data: { ok: r?.ok, error: r?.error, plots: r?.plots, strategy: r?.strategy } }),
    },
    {
      name: 'backtest',
      readOnly: true,
      description:
        'Backtest a strategy on Binance history with realistic costs (Binance fees + slippage by default, funding on futures) and report performance against buy & hold and cash: return, CAGR, max drawdown, Sharpe/Sortino/Calmar, trades, win rate, profit factor, long/short split, yearly returns and market regimes; the Greeks against buy & hold (alpha, beta, correlation, volatility, omega, capture ratios, VaR); and vsRandom: how many of 1,000 random twins (same trades, holding times, sizes and costs at random times; and coin-flip directions at the same times) the strategy beats, with p-values. The run is saved in the Strategy Tester history. Use robustness_test before calling a strategy robust.',
      inputSchema: {
        type: 'object',
        properties: {
          ...CODE_SCHEMA,
          ...INSTRUMENT_SCHEMA,
          days: { type: 'number', description: 'Test the last N days (default 365)' },
          from: { type: 'string', description: 'Start date (ISO, alternative to days)' },
          to: { type: 'string', description: 'End date (ISO, default now)' },
          inputs: { type: 'object', description: 'Input values by key' },
          costs: { type: 'string', enum: [...COST_PRESETS.map((c) => c.id), 'script'], description: 'Cost preset (default binance-spot / binance-futures)' },
          capital: { type: 'number', description: 'Initial capital in USDT (default 10000)' },
          leverage: { type: 'number', description: 'Futures leverage (default 1)' },
        },
      },
      async run(args) {
        const src = codeOf(deps, args);
        const ins = instrument(args);
        const now = Date.now();
        const to = args.to ? Date.parse(String(args.to)) : now;
        const from = args.from ? Date.parse(String(args.from)) : to - Math.max(7, Math.min(3650, Number(args.days) || 365)) * 86400000;
        if (!(to > from)) throw new Error('invalid date range');
        const req: BacktestRequest = {
          scriptId: src.id || undefined,
          code: src.id ? undefined : src.code,
          language: src.language,
          name: src.id ? undefined : `${src.name} (AI)`,
          inputs: (args.inputs as Record<string, unknown>) || {},
          symbol: ins.symbol,
          market: ins.market,
          tf: ins.tf,
          from,
          to: Math.min(to, now),
          costs: typeof args.costs === 'string' ? args.costs : ins.market === 'futures' ? 'binance-futures' : 'binance-spot',
          broker: { initialCapital: Math.max(10, Number(args.capital) || 10000), ...(ins.market === 'futures' ? { leverage: Math.max(1, Math.min(125, Math.round(Number(args.leverage) || 1))) } : {}) },
          label: `AI · ${src.name}`,
        };
        const rec = await deps.backtests.run(req, () => {}, { cancelled: false });
        if (!rec.ok) return { ok: false, error: rec.error, recordId: rec.id };
        return {
          ok: true,
          recordId: rec.id,
          script: rec.script.name,
          market: `${ins.symbol} ${ins.market} ${ins.tf}`,
          costs: req.costs,
          metrics: summarizeMetrics(rec),
          sampleTrades: rec.trades.slice(-6).map((t) => ({ dir: t.dir === 1 ? 'long' : 'short', entry: new Date(t.entryTime).toISOString().slice(0, 16), exit: new Date(t.exitTime).toISOString().slice(0, 16), returnPct: r2(t.returnPct), profit: r2(t.profit) })),
          warnings: rec.warnings.slice(0, 8),
          assumptions: rec.info.fills,
        };
      },
      card: (_a, r) => ({ kind: 'backtest', title: r?.ok ? `Backtest ${r.market}` : `Backtest failed: ${r?.error}`, data: r || {} }),
    },
    {
      name: 'optimize',
      readOnly: true,
      description:
        'Optimize strategy inputs with Bayesian search and an out-of-sample holdout (the last 30% of the period is never used to choose parameters). Reports the best parameters with in-sample vs out-of-sample metrics, robustness of the neighbourhood (narrow peaks are overfitting signs) and the top candidates. Keep the budget small (default 40 trials, max 150). Saved in the Optimizer history.',
      inputSchema: {
        type: 'object',
        properties: {
          ...CODE_SCHEMA,
          ...INSTRUMENT_SCHEMA,
          days: { type: 'number', description: 'Period in days (default 730)' },
          params: {
            type: 'array',
            description: 'Inputs to optimize',
            items: { type: 'object', properties: { key: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, values: { type: 'array', items: {} } }, required: ['key'] },
          },
          objective: { type: 'string', enum: ['sharpe', 'sortino', 'calmar', 'returnOverDd', 'netProfitPct', 'profitFactor'], description: 'default sharpe' },
          budget: { type: 'number' },
          inputs: { type: 'object', description: 'Fixed values for the other inputs' },
          validation: { type: 'string', enum: ['holdout', 'walkforward'], description: 'holdout (default): the last 30% is out-of-sample. walkforward: rolling windows (optimize on three parts, test on the next), stitched out-of-sample results and walk-forward efficiency. Stricter, takes longer.' },
        },
        required: ['params'],
      },
      async run(args) {
        const src = codeOf(deps, args);
        const ins = instrument(args);
        const a = await scripts.pool.analyze(src.language, src.code, runContext({ ...ins, chartType: 'candles' }));
        if (!a.ok) throw new Error(`script error: ${errText(a.error)}`);
        const defs = new Map(a.inputs.map((i) => [i.key, i]));
        const space = (Array.isArray(args.params) ? args.params : []).map((p: any) => {
          const d = defs.get(String(p.key)) || [...defs.values()].find((x) => x.title === p.key);
          if (!d) throw new Error(`unknown input "${p.key}" (inputs: ${[...defs.values()].map((x) => `${x.key}=${x.title}`).join(', ')})`);
          if (Array.isArray(p.values) && p.values.length) return { key: d.key, title: d.title, kind: 'choice' as const, values: p.values };
          if (d.type === 'bool') return { key: d.key, title: d.title, kind: 'bool' as const };
          const kind = d.type === 'int' ? ('int' as const) : ('float' as const);
          const min = Number(p.min ?? d.min ?? 1);
          const max = Number(p.max ?? d.max ?? min * 4);
          const step = Number(p.step ?? (kind === 'int' ? 1 : (max - min) / 20));
          if (!(max > min) || !(step > 0)) throw new Error(`invalid range for ${d.key}`);
          return { key: d.key, title: d.title, kind, min, max, step };
        });
        if (!space.length) throw new Error('choose at least one input to optimize');
        const now = Date.now();
        const days = Math.max(60, Math.min(3650, Number(args.days) || 730));
        const req: OptimizeRequest = {
          scriptId: src.id || undefined,
          code: src.id ? undefined : src.code,
          language: src.language,
          name: src.id ? undefined : `${src.name} (AI)`,
          inputs: (args.inputs as Record<string, unknown>) || {},
          symbol: ins.symbol,
          market: ins.market,
          tf: ins.tf,
          from: now - days * 86400000,
          to: now,
          costs: ins.market === 'futures' ? 'binance-futures' : 'binance-spot',
          space,
          method: 'bayes',
          budget: Math.max(8, Math.min(150, Math.round(Number(args.budget) || 40))),
          objective: (args.objective as OptimizeRequest['objective']) || 'sharpe',
          constraints: { minTrades: 10 },
          validation: args.validation === 'walkforward' ? { mode: 'walkforward', windows: 4, isRatio: 3 } : { mode: 'holdout', oosPct: 30 },
          extras: { pbo: false },
          label: `AI · ${src.name}`,
        };
        const rec = await deps.optimizer.run(req, () => {}, { cancelled: false });
        const trial = (k: string | null) => rec.trials.find((t) => t.key === k);
        const best = trial(rec.bestKey);
        const ho = rec.validation.holdout;
        const rob = rec.robustness.find((x) => x.key === rec.bestKey);
        const fmt = (m: any) => (m ? { netProfitPct: r2(m.netProfitPct), sharpe: r2(m.sharpe), maxDrawdownPct: r2(m.maxDrawdownPct), trades: m.trades, profitFactor: r2(m.profitFactor), winRatePct: r2(m.winRate * 100) } : null);
        const scope = rec.scopes[0];
        const wfo = rec.validation.wfo;
        return {
          recordId: rec.id,
          trials: rec.info.trials,
          validation: rec.validation.mode,
          bestParams: rec.bestPoint,
          inSample: fmt(ho?.isMetrics || best?.metrics),
          outOfSample: fmt(ho?.oosMetrics || wfo?.oosMetrics),
          walkForward: wfo ? { efficiency: r2(wfo.wfe), windows: wfo.windows.map((w) => ({ params: w.point, inSample: fmt(w.isMetrics), outOfSample: fmt(w.oosMetrics) })) } : undefined,
          randomEntryTest: rec.stats.randomEntry ? { pValue: r4(rec.stats.randomEntry.pValue), strategyReturnPct: r2(rec.stats.randomEntry.strategyReturnPct), randomMedianPct: r2(rec.stats.randomEntry.randomMedianPct) } : undefined,
          deflatedSharpe: rec.stats.dsr ? r4(rec.stats.dsr.dsr) : undefined,
          robustness: rob ? { neighbourMeanScore: r2(rob.mean), neighbourMinScore: r2(rob.min), plateauPct: r2(rob.plateau * 100), narrowPeak: rob.narrowPeak } : null,
          top: (scope?.ranking || []).slice(0, 5).map((x) => ({ params: trial(x.key)?.point, score: r2(x.score), metrics: fmt(trial(x.key)?.metrics) })),
          warnings: rec.warnings.slice(0, 6),
        };
      },
      card: (_a, r) => ({ kind: 'optimization', title: `Optimized ${r?.trials ?? ''} trials`, data: r || {} }),
    },
    {
      name: 'robustness_test',
      readOnly: true,
      description:
        'Check whether a strategy holds up beyond the data it was built on. Runs the same code and inputs on all three coins (BTC, ETH, SOL), on the neighbouring timeframes and in three separate sub-periods, each with realistic costs, Greeks and the random-twin comparison. Reports every run and a summary: share of runs that are profitable, beat buy & hold and beat random (p < 0.1), median Sharpe and the worst drawdown. Runs are not added to the Strategy Tester history. Takes a while; use it once a strategy looks promising and before calling it robust.',
      inputSchema: {
        type: 'object',
        properties: {
          ...CODE_SCHEMA,
          ...INSTRUMENT_SCHEMA,
          days: { type: 'number', description: 'Period in days (default 730); shortened for very small timeframes' },
          inputs: { type: 'object', description: 'Input values by key' },
          costs: { type: 'string', enum: [...COST_PRESETS.map((c) => c.id), 'script'], description: 'Cost preset (default binance-spot / binance-futures)' },
        },
      },
      async run(args) {
        const src = codeOf(deps, args);
        const ins = instrument(args);
        const now = Date.now();
        const days = Math.max(60, Math.min(1825, Number(args.days) || 730));
        // at most ~250k bars per run
        const fromFor = (tf: string, to: number, span: number) => Math.max(to - span, to - 250000 * tfDurationMs(parseTimeframe(tf)!));
        const costs = typeof args.costs === 'string' ? args.costs : ins.market === 'futures' ? 'binance-futures' : 'binance-spot';
        const cells: { axis: 'coin' | 'timeframe' | 'period'; label: string; symbol: SymbolId; tf: string; from: number; to: number }[] = [];
        for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as SymbolId[]) cells.push({ axis: 'coin', label: `${s.replace('USDT', '')} ${ins.tf}`, symbol: s, tf: ins.tf, from: fromFor(ins.tf, now, days * DAY), to: now });
        for (const tf of neighbourTfs(ins.tf)) cells.push({ axis: 'timeframe', label: `${ins.symbol.replace('USDT', '')} ${tf}`, symbol: ins.symbol, tf, from: fromFor(tf, now, days * DAY), to: now });
        const start = fromFor(ins.tf, now, days * DAY);
        const third = (now - start) / 3;
        for (let k = 0; k < 3; k++) {
          const a = Math.round(start + k * third);
          const b = Math.round(start + (k + 1) * third);
          cells.push({ axis: 'period', label: `${iso(a)} → ${iso(b)}`, symbol: ins.symbol, tf: ins.tf, from: a, to: b });
        }
        const runs: Record<string, unknown>[] = [];
        for (const c of cells) {
          try {
            const rec = await deps.backtests.run(
              { scriptId: src.id || undefined, code: src.id ? undefined : src.code, language: src.language, name: src.id ? undefined : `${src.name} (AI)`, inputs: (args.inputs as Record<string, unknown>) || {}, symbol: c.symbol, market: ins.market, tf: c.tf, from: c.from, to: c.to, costs, ephemeral: true, label: 'robustness' },
              () => {},
              { cancelled: false },
            );
            const m = rec.metrics;
            if (!rec.ok || !m) {
              runs.push({ axis: c.axis, label: c.label, error: rec.error || 'failed' });
              continue;
            }
            runs.push({
              axis: c.axis,
              label: c.label,
              returnPct: r2(m.netProfitPct),
              buyHoldPct: r2(m.buyHold.returnPct),
              sharpe: r2(m.sharpe),
              maxDrawdownPct: r2(m.maxDrawdownPct),
              trades: m.all.trades,
              profitFactor: r2(m.all.profitFactor),
              alphaPctPerYear: m.greeks ? r2(m.greeks.alpha) : null,
              beta: m.greeks ? r2(m.greeks.beta) : null,
              beatsRandomPct: rec.random ? r2(rec.random.timing.beats.returnPct) : null,
              pRandom: rec.random ? r4(rec.random.timing.pReturn) : null,
            });
          } catch (e) {
            runs.push({ axis: c.axis, label: c.label, error: (e as Error).message });
          }
        }
        const ok = runs.filter((r) => r.error === undefined) as { returnPct: number; buyHoldPct: number; sharpe: number; maxDrawdownPct: number; trades: number; pRandom: number | null }[];
        const share = (f: (r: (typeof ok)[number]) => boolean) => (ok.length ? r2((ok.filter(f).length / ok.length) * 100) : null);
        const sharpes = ok.map((r) => r.sharpe).sort((a, b) => a - b);
        const median = sharpes.length ? sharpes[Math.floor(sharpes.length / 2)] : null;
        const profitable = share((r) => r.returnPct > 0) ?? 0;
        const beatRandom = share((r) => r.pRandom !== null && r.pRandom < 0.1) ?? 0;
        const verdict = !ok.length ? 'no successful runs' : profitable >= 75 && beatRandom >= 50 && (median ?? 0) > 0.5 ? 'robust' : profitable >= 50 ? 'mixed' : 'fragile';
        return {
          strategy: src.name,
          market: ins.market,
          runs,
          summary: {
            runs: ok.length,
            failed: runs.length - ok.length,
            profitablePct: profitable,
            beatBuyHoldPct: share((r) => r.returnPct > r.buyHoldPct),
            beatRandomPct: beatRandom,
            medianSharpe: median,
            worstDrawdownPct: ok.length ? r2(Math.max(...ok.map((r) => r.maxDrawdownPct))) : null,
            runsWithUnder20Trades: ok.filter((r) => r.trades < 20).length,
            verdict,
          },
        };
      },
      card: (_a, r) => ({ kind: 'robustness', title: `Robustness: ${r?.summary?.verdict ?? 'tested'} · ${r?.summary?.runs ?? 0} runs`, data: r || {} }),
    },
    {
      name: 'market_snapshot',
      readOnly: true,
      description: 'Recent market statistics for an instrument and timeframe: last price, change, range, ATR %, annualised volatility, trend (price vs SMA 50/200) and volume. Use it to choose sensible parameter ranges.',
      inputSchema: { type: 'object', properties: { ...INSTRUMENT_SCHEMA, bars: { type: 'number', description: 'default 500' } } },
      async run(args) {
        const ins = instrument(args);
        const nBars = Math.max(50, Math.min(5000, Math.round(Number(args.bars) || 500)));
        const b = fromPacked(await scripts.closedBars({ ...ins, chartType: 'candles' }, nBars), ins.tf, 'candles');
        const n = b.length;
        if (n < 20) throw new Error('not enough data');
        let hi = -Infinity;
        let lo = Infinity;
        let atr = 0;
        let vol = 0;
        const rets: number[] = [];
        for (let i = 0; i < n; i++) {
          hi = Math.max(hi, b.h[i]);
          lo = Math.min(lo, b.l[i]);
          vol += b.v[i];
          if (i > 0) {
            rets.push(Math.log(b.c[i] / b.c[i - 1]));
            if (i >= n - 14) atr += Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) / 14;
          }
        }
        const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
        const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
        const perYear = (365.25 * 86400000) / tfDurationMs(parseTimeframe(ins.tf)!);
        const sma = (k: number) => (n >= k ? b.c.slice(n - k).reduce((s, x) => s + x, 0) / k : NaN);
        const last = b.c[n - 1];
        return {
          instrument: `${ins.symbol} ${ins.market} ${ins.tf}`,
          from: new Date(b.t[0]).toISOString(),
          to: new Date(b.t[n - 1]).toISOString(),
          last: r2(last),
          changePct: r2((last / b.o[0] - 1) * 100),
          rangeHigh: r2(hi),
          rangeLow: r2(lo),
          atr14Pct: r2((atr / last) * 100),
          annualVolatilityPct: r2(sd * Math.sqrt(perYear) * 100),
          sma50: r2(sma(50)),
          sma200: r2(sma(200)),
          trend: Number.isFinite(sma(200)) ? (last > sma(50) && sma(50) > sma(200) ? 'up' : last < sma(50) && sma(50) < sma(200) ? 'down' : 'mixed') : last > sma(50) ? 'up' : 'down',
          avgVolume: r2(vol / n),
        };
      },
      card: (_a, r) => ({ kind: 'market', title: `Market: ${r?.instrument}`, data: r || {} }),
    },
    {
      name: 'show_in_app',
      readOnly: true,
      description:
        'Show something to the user in the app: open a script in the Script Editor, add a script to the focused chart (with inputs), open a backtest in the Strategy Tester or an optimization in the Optimizer. Use it at the end so the user sees the result.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open_script', 'add_to_chart', 'open_backtest', 'open_optimization'] },
          id: { type: 'string', description: 'Script id, backtest record id or optimization record id' },
          inputs: { type: 'object' },
          symbol: INSTRUMENT_SCHEMA.symbol,
          market: INSTRUMENT_SCHEMA.market,
          tf: INSTRUMENT_SCHEMA.tf,
        },
        required: ['action', 'id'],
      },
      async run(args) {
        const action = String(args.action);
        const id = str(args.id, 'id');
        if ((action === 'open_script' || action === 'add_to_chart') && !scripts.library.get(id)) throw new Error(`script "${id}" not found`);
        deps.core.router.broadcast('ai:ui', { action, id, inputs: args.inputs || {}, symbol: args.symbol, market: args.market, tf: args.tf });
        return { done: true, action, id };
      },
      card: (a) => ({ kind: 'ui', title: a.action === 'add_to_chart' ? 'Added to the chart' : a.action === 'open_script' ? 'Opened in the editor' : a.action === 'open_backtest' ? 'Opened in the Strategy Tester' : 'Opened in the Optimizer', data: { action: a.action, id: a.id } }),
    },
  ];
}
