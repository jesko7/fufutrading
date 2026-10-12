/** Backtest configuration shared by the Strategy Tester and the Optimizer. */
import { NumberField, Select, Toggle } from '../../components/ui';
import { COST_PRESETS } from '../../../shared/trading/presets';
import type { Market, SymbolId } from '../../../shared/symbols';
import type { BacktestRequest } from '../../../main/backtest/service';

export type RangePreset = '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y' | '5Y' | 'custom';

export interface TesterCfg {
  scriptId: string | null;
  inputs: Record<string, unknown>;
  symbol: SymbolId;
  market: Market;
  tf: string;
  chartType?: 'candles' | 'heikinashi' | 'renko';
  range?: { preset: RangePreset; from?: number; to?: number };
  costs?: string;
  capital?: number;
  leverage?: number;
  slippageBps?: number;
  limitFill?: 'touch' | 'through';
  partialFills?: boolean;
  fillOnStandardOhlc?: boolean;
  feeSensitivity?: boolean;
  warmupBars?: number;
  allowShortSpot?: boolean;
  borrowRateAnnual?: number;
  riskFree?: number;
  runId?: string | null;
  autorun?: number;
  tab?: string;
  title?: string;
}

export interface RunSummary {
  id: string;
  created: number;
  label: string;
  ok: boolean;
  script: { id: string | null; name: string; language: string };
  request: BacktestRequest;
  summary: { netProfitPct: number; maxDrawdownPct: number; profitFactor: number; trades: number; sharpe: number; winRate: number; buyHoldPct: number } | null;
}

export const RANGE_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1826 };

export function rangeOf(cfg: TesterCfg): { from: number; to: number } {
  const r = cfg.range || { preset: '1Y' };
  const now = Date.now();
  if (r.preset === 'custom' && r.from && r.to) return { from: r.from, to: r.to };
  const days = RANGE_DAYS[(r.preset === 'custom' ? '1Y' : r.preset) as Exclude<RangePreset, 'custom'>] || 365;
  return { from: now - days * 86400000, to: now };
}


export function buildRequest(cfg: TesterCfg): BacktestRequest {
  const { from, to } = rangeOf(cfg);
  const broker: Record<string, unknown> = {};
  if (cfg.capital) broker.initialCapital = cfg.capital;
  if (cfg.market === 'futures') broker.leverage = cfg.leverage || 1;
  if (cfg.slippageBps !== undefined && cfg.costs !== 'script') broker.slippageBps = cfg.slippageBps;
  if (cfg.limitFill) broker.limitFill = cfg.limitFill;
  if (cfg.partialFills) broker.partialFills = true;
  if (cfg.market === 'spot' && cfg.allowShortSpot) {
    broker.allowShortSpot = true;
    broker.borrowRateAnnual = (cfg.borrowRateAnnual ?? 5) / 100;
  }
  return { scriptId: cfg.scriptId || undefined, inputs: cfg.inputs || {}, symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: cfg.chartType || 'candles', from, to, warmupBars: cfg.warmupBars ?? 500, costs: cfg.costs || (cfg.market === 'futures' ? 'binance-futures' : 'binance-spot'), broker, fillOnStandardOhlc: cfg.fillOnStandardOhlc !== false, feeSensitivity: !!cfg.feeSensitivity, riskFree: (cfg.riskFree ?? 0) / 100 };
}

// ------------------------------------------------------------------ settings

export function TesterSettings({ cfg, setCfg }: { cfg: TesterCfg; setCfg: (p: Partial<TesterCfg>) => void }) {
  const costs = cfg.costs || (cfg.market === 'futures' ? 'binance-futures' : 'binance-spot');
  const preset = COST_PRESETS.find((p) => p.id === costs);
  return (
    <div className="pop-pad tester-settings">
      <div className="set-group-title">Account</div>
      <label className="set-row">
        <span>Initial capital (USDT)</span>
        <NumberField value={cfg.capital ?? 10000} onChange={(v) => setCfg({ capital: Math.max(1, v) })} min={1} step={1000} decimals={2} />
      </label>
      {cfg.market === 'futures' && (
        <label className="set-row">
          <span>Leverage</span>
          <NumberField value={cfg.leverage ?? 1} onChange={(v) => setCfg({ leverage: Math.max(1, Math.min(125, Math.round(v))) })} min={1} max={125} decimals={0} />
        </label>
      )}
      {cfg.market === 'spot' && (
        <label className="set-row">
          <span>Allow shorting (margin borrow)</span>
          <Toggle value={!!cfg.allowShortSpot} onChange={(v) => setCfg({ allowShortSpot: v })} />
        </label>
      )}
      {cfg.market === 'spot' && cfg.allowShortSpot && (
        <label className="set-row">
          <span>Borrow rate (% per year)</span>
          <NumberField value={cfg.borrowRateAnnual ?? 5} onChange={(v) => setCfg({ borrowRateAnnual: Math.max(0, v) })} min={0} step={0.5} decimals={2} />
        </label>
      )}
      <div className="set-group-title">Costs</div>
      <label className="set-row">
        <span>Fees</span>
        <Select value={costs} options={[{ value: 'script', label: "Script's strategy() settings" }, ...COST_PRESETS.map((p) => ({ value: p.id, label: p.label }))]} onChange={(v) => setCfg({ costs: v })} />
      </label>
      {preset && <div className="muted small">{preset.description}</div>}
      {costs !== 'script' && (
        <label className="set-row">
          <span>Slippage (bps per fill)</span>
          <NumberField value={cfg.slippageBps ?? preset?.costs.slippage.bps ?? 0} onChange={(v) => setCfg({ slippageBps: Math.max(0, v) })} min={0} step={0.5} decimals={2} />
        </label>
      )}
      <div className="set-group-title">Fills</div>
      <label className="set-row">
        <span>Limit orders fill when price</span>
        <Select value={cfg.limitFill || 'through'} options={[{ value: 'through', label: 'trades through the limit' }, { value: 'touch', label: 'touches the limit' }]} onChange={(v) => setCfg({ limitFill: v })} />
      </label>
      <label className="set-row">
        <span>Partial fills (bar volume participation)</span>
        <Toggle value={!!cfg.partialFills} onChange={(v) => setCfg({ partialFills: v })} />
      </label>
      <label className="set-row">
        <span>Chart type</span>
        <Select value={cfg.chartType || 'candles'} options={[{ value: 'candles', label: 'Candles' }, { value: 'heikinashi', label: 'Heikin-Ashi' }, { value: 'renko', label: 'Renko (ATR 14)' }]} onChange={(v) => setCfg({ chartType: v })} />
      </label>
      {cfg.chartType === 'heikinashi' && (
        <label className="set-row">
          <span>Fill on real OHLC (recommended)</span>
          <Toggle value={cfg.fillOnStandardOhlc !== false} onChange={(v) => setCfg({ fillOnStandardOhlc: v })} />
        </label>
      )}
      <label className="set-row">
        <span>Warm-up bars before the start</span>
        <NumberField value={cfg.warmupBars ?? 500} onChange={(v) => setCfg({ warmupBars: Math.max(0, Math.min(20000, Math.round(v))) })} min={0} step={100} decimals={0} />
      </label>
      <div className="set-group-title">Analysis</div>
      <label className="set-row">
        <span>Fee sensitivity (5 extra runs)</span>
        <Toggle value={!!cfg.feeSensitivity} onChange={(v) => setCfg({ feeSensitivity: v })} />
      </label>
      <label className="set-row">
        <span>Cash / risk-free rate (% per year)</span>
        <NumberField value={cfg.riskFree ?? 0} onChange={(v) => setCfg({ riskFree: Math.max(0, v) })} min={0} step={0.5} decimals={2} />
      </label>
      <div className="set-group-title">Custom range</div>
      <div className="row" style={{ gap: 6 }}>
        <input type="date" className="input" value={cfg.range?.preset === 'custom' && cfg.range.from ? new Date(cfg.range.from).toISOString().slice(0, 10) : ''} onChange={(e) => e.target.value && setCfg({ range: { preset: 'custom', from: Date.parse(`${e.target.value}T00:00:00Z`), to: cfg.range?.to || Date.now() } })} />
        <span className="muted">→</span>
        <input type="date" className="input" value={cfg.range?.preset === 'custom' && cfg.range.to ? new Date(cfg.range.to).toISOString().slice(0, 10) : ''} onChange={(e) => e.target.value && setCfg({ range: { preset: 'custom', from: cfg.range?.from || Date.now() - 365 * 86400000, to: Date.parse(`${e.target.value}T23:59:59Z`) } })} />
      </div>
    </div>
  );
}

