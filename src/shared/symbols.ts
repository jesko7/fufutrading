/**
 * Supported instruments. The platform is intentionally limited to BTC, ETH and SOL
 * quoted in USDT on Binance, for both spot and USDⓈ-M perpetual futures.
 *
 * Exchange filters below are a bundled snapshot (verified 2026-10-12 against
 * /api/v3/exchangeInfo and /fapi/v1/exchangeInfo). At runtime the app refreshes them
 * from Binance and falls back to these values only when offline.
 */

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
export type SymbolId = (typeof SYMBOLS)[number];
export type Market = 'spot' | 'futures';
export const MARKETS: Market[] = ['spot', 'futures'];

export interface MarketFilters {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface FuturesExtras {
  /** Liquidation clearance fee rate (exchangeInfo.liquidationFee). */
  liquidationFeeRate: number;
  /** Max leverage of the first bracket. */
  maxLeverage: number;
  /** Funding interval in hours (fundingInfo; 8h for these symbols at verification time). */
  fundingIntervalHours: number;
}

export interface SymbolSpec {
  symbol: SymbolId;
  base: string;
  quote: string;
  name: string;
  color: string;
  spot: MarketFilters;
  futures: MarketFilters & FuturesExtras;
}

export const SYMBOL_SPECS: Record<SymbolId, SymbolSpec> = {
  BTCUSDT: {
    symbol: 'BTCUSDT',
    base: 'BTC',
    quote: 'USDT',
    name: 'Bitcoin',
    color: '#F7931A',
    spot: { tickSize: 0.01, stepSize: 0.00001, minQty: 0.00001, minNotional: 5 },
    futures: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 50, liquidationFeeRate: 0.0125, maxLeverage: 150, fundingIntervalHours: 8 },
  },
  ETHUSDT: {
    symbol: 'ETHUSDT',
    base: 'ETH',
    quote: 'USDT',
    name: 'Ethereum',
    color: '#627EEA',
    spot: { tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, minNotional: 5 },
    futures: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 20, liquidationFeeRate: 0.0125, maxLeverage: 150, fundingIntervalHours: 8 },
  },
  SOLUSDT: {
    symbol: 'SOLUSDT',
    base: 'SOL',
    quote: 'USDT',
    name: 'Solana',
    color: '#14F195',
    spot: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
    futures: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, liquidationFeeRate: 0.015, maxLeverage: 100, fundingIntervalHours: 8 },
  },
};

export function isSymbol(s: unknown): s is SymbolId {
  return typeof s === 'string' && (SYMBOLS as readonly string[]).includes(s);
}

export function filtersFor(symbol: SymbolId, market: Market): MarketFilters {
  return SYMBOL_SPECS[symbol][market];
}

export function decimalsOf(step: number): number {
  if (!isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function priceDecimals(symbol: SymbolId, market: Market): number {
  return decimalsOf(SYMBOL_SPECS[symbol][market].tickSize);
}

export function qtyDecimals(symbol: SymbolId, market: Market): number {
  return decimalsOf(SYMBOL_SPECS[symbol][market].stepSize);
}

/** Round a price to the instrument tick (nearest). */
export function roundToTick(price: number, tick: number): number {
  const d = decimalsOf(tick);
  return +(Math.round(price / tick) * tick).toFixed(d);
}

/** Round a quantity down to the lot step (exchange behaviour for order quantities). */
export function floorToStep(qty: number, step: number): number {
  const d = decimalsOf(step);
  return +(Math.floor(qty / step + 1e-9) * step).toFixed(d);
}

export function marketLabel(m: Market): string {
  return m === 'spot' ? 'Spot' : 'Perp';
}

export function instrumentLabel(symbol: SymbolId, market: Market): string {
  const s = SYMBOL_SPECS[symbol];
  return `${s.base}/${s.quote}${market === 'futures' ? ' Perp' : ''}`;
}
