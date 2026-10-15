/**
 * Trading-cost and account presets. Presets are starting points — every value stays editable.
 *
 * Binance fee assumptions (regular user, VIP 0):
 *  - Spot: 0.10 % maker / 0.10 % taker → ≈ 0.20 % round trip with market orders;
 *    0.075 % with fees paid in BNB (25 % discount).
 *  - USDⓈ-M futures: 0.02 % maker / 0.05 % taker; 0.018 % / 0.045 % with BNB (10 % discount).
 * Source: https://www.binance.com/en/fee/schedule (check for your own tier).
 */
import type { AccountConfig, CostModel, ExecutionModel, RiskLimits, FuturesSettings } from './types';
import type { Market } from '../symbols';

export interface CostPreset {
  id: string;
  label: string;
  description: string;
  market?: Market;
  costs: CostModel;
}

export const COST_PRESETS: CostPreset[] = [
  {
    id: 'binance-spot',
    label: 'Binance spot (~0.2% round trip)',
    description: '0.10% maker / 0.10% taker (VIP 0, no BNB discount). A market round trip costs about 0.20% plus slippage.',
    market: 'spot',
    costs: { preset: 'binance-spot', makerFee: 0.001, takerFee: 0.001, flatFee: 0, slippage: { model: 'book', bps: 2 }, funding: false },
  },
  {
    id: 'binance-futures',
    label: 'Binance USDⓈ-M futures',
    description: '0.02% maker / 0.05% taker (VIP 0) plus funding payments every 8 hours.',
    market: 'futures',
    costs: { preset: 'binance-futures', makerFee: 0.0002, takerFee: 0.0005, flatFee: 0, slippage: { model: 'book', bps: 1 }, funding: true },
  },
  {
    id: 'binance-spot-bnb',
    label: 'Binance spot, fees in BNB (−25%)',
    description: '0.075% maker / 0.075% taker: VIP 0 with fees paid in BNB (25% discount).',
    market: 'spot',
    costs: { preset: 'binance-spot-bnb', makerFee: 0.00075, takerFee: 0.00075, flatFee: 0, slippage: { model: 'book', bps: 2 }, funding: false },
  },
  {
    id: 'binance-futures-bnb',
    label: 'Binance futures, fees in BNB (−10%)',
    description: '0.018% maker / 0.045% taker: VIP 0 with fees paid in BNB (10% discount), plus funding.',
    market: 'futures',
    costs: { preset: 'binance-futures-bnb', makerFee: 0.00018, takerFee: 0.00045, flatFee: 0, slippage: { model: 'book', bps: 1 }, funding: true },
  },
  {
    id: 'tradingview-flat',
    label: 'TradingView-style flat €1',
    description: 'A flat €1 commission per order fill (converted to USDT at the EUR/USDT rate when the account is created), no percentage fees.',
    costs: { preset: 'tradingview-flat', makerFee: 0, takerFee: 0, flatFee: 1, flatFeeNote: '€1 per fill', slippage: { model: 'fixedBps', bps: 1 }, funding: false },
  },
  {
    id: 'zero',
    label: 'No costs',
    description: 'Frictionless fills — useful for comparing raw signal quality. Not realistic.',
    costs: { preset: 'zero', makerFee: 0, takerFee: 0, flatFee: 0, slippage: { model: 'none', bps: 0 }, funding: false },
  },
  {
    id: 'ftmo-crypto',
    label: 'FTMO crypto commission',
    description: '0.0325% per side on notional (FTMO crypto pricing effective 28 Jul 2025). Spreads and swaps of FTMO’s CFD feed are not reproduced.',
    costs: { preset: 'ftmo-crypto', makerFee: 0.000325, takerFee: 0.000325, flatFee: 0, slippage: { model: 'fixedBps', bps: 2 }, funding: false },
  },
];

export const DEFAULT_EXECUTION: ExecutionModel = { limitFill: 'through', throughTicks: 0, partialFills: false, participation: 0.25, stopTrigger: 'last' };

export const DEFAULT_RISK: RiskLimits = { maxLeverage: 20, maxPositionNotional: 0, maxOpenPositions: 3, maxDailyLossPct: 0, riskPerTradePct: 1 };

export const DEFAULT_FUTURES: FuturesSettings = { marginMode: 'cross', defaultLeverage: 10, leverage: {}, marginModes: {}, marginCallRatio: 0.8 };

export interface AccountPreset {
  id: string;
  label: string;
  description: string;
  market: Market;
  initialBalance: number;
  costPreset: string;
  futures?: Partial<FuturesSettings>;
  risk?: Partial<RiskLimits>;
}

export const ACCOUNT_PRESETS: AccountPreset[] = [
  { id: 'spot-10k', label: 'Spot · $10,000', description: 'Spot account with Binance spot fees. Long only, no leverage.', market: 'spot', initialBalance: 10000, costPreset: 'binance-spot' },
  { id: 'perp-10k', label: 'Perpetual futures · $10,000', description: 'USDⓈ-M futures with Binance fees, funding, cross margin, 10x default leverage.', market: 'futures', initialBalance: 10000, costPreset: 'binance-futures' },
  { id: 'perp-1k-hi', label: 'Small futures · $1,000', description: 'Small futures account, isolated margin, 5x leverage, conservative risk limits.', market: 'futures', initialBalance: 1000, costPreset: 'binance-futures', futures: { marginMode: 'isolated', defaultLeverage: 5 }, risk: { maxLeverage: 10, maxDailyLossPct: 5 } },
  { id: 'tv-flat', label: 'TradingView-style · $10,000', description: 'Flat €1 per fill, spot.', market: 'spot', initialBalance: 10000, costPreset: 'tradingview-flat' },
];

export function costPreset(id: string): CostPreset {
  return COST_PRESETS.find((p) => p.id === id) || COST_PRESETS[0];
}

export function newAccountConfig(p: { id: string; name: string; kind: AccountConfig['kind']; market: Market; initialBalance: number; costPreset: string; eurUsdt?: number; futures?: Partial<FuturesSettings>; risk?: Partial<RiskLimits>; color?: string }): AccountConfig {
  const cp = costPreset(p.costPreset);
  const costs: CostModel = JSON.parse(JSON.stringify(cp.costs));
  if (cp.id === 'tradingview-flat') {
    const rate = p.eurUsdt && p.eurUsdt > 0 ? p.eurUsdt : 1.08;
    costs.flatFee = +(1 * rate).toFixed(4);
    costs.flatFeeNote = `€1 per fill ≈ ${costs.flatFee} USDT (EUR/USDT ${rate.toFixed(4)} at creation)`;
  }
  if (p.market === 'spot') costs.funding = false;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    market: p.market,
    initialBalance: p.initialBalance,
    color: p.color || '#3b82f6',
    costs,
    execution: { ...DEFAULT_EXECUTION },
    risk: { ...DEFAULT_RISK, ...(p.market === 'spot' ? { maxLeverage: 1 } : {}), ...(p.risk || {}) },
    futures: { ...DEFAULT_FUTURES, ...(p.futures || {}) },
    createdAt: Date.now(),
  };
}
