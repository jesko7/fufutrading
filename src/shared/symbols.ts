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
  /** Largest quantity of one market order (MARKET_LOT_SIZE). */
  maxMarketQty: number;
  /** Limit prices must stay within these multiples of the mark price (PERCENT_PRICE). */
  priceBandUp: number;
  priceBandDown: number;
  /** Open orders per symbol (MAX_NUM_ORDERS). */
  maxOrders: number;
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
    futures: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 50, liquidationFeeRate: 0.0125, maxLeverage: 150, fundingIntervalHours: 8, maxMarketQty: 120, priceBandUp: 1.05, priceBandDown: 0.95, maxOrders: 200 },
  },
  ETHUSDT: {
    symbol: 'ETHUSDT',
    base: 'ETH',
    quote: 'USDT',
    name: 'Ethereum',
    color: '#627EEA',
    spot: { tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, minNotional: 5 },
    futures: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 20, liquidationFeeRate: 0.0125, maxLeverage: 150, fundingIntervalHours: 8, maxMarketQty: 2000, priceBandUp: 1.05, priceBandDown: 0.95, maxOrders: 200 },
  },
  SOLUSDT: {
    symbol: 'SOLUSDT',
    base: 'SOL',
    quote: 'USDT',
    name: 'Solana',
    color: '#14F195',
    spot: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
    futures: { tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5, liquidationFeeRate: 0.015, maxLeverage: 100, fundingIntervalHours: 8, maxMarketQty: 80000, priceBandUp: 1.05, priceBandDown: 0.95, maxOrders: 200 },
  },
};

/** Filters per symbol and market as parsed from Binance's exchangeInfo (only the fields it provided). */
export type FilterTable = Partial<Record<SymbolId, { spot?: Partial<MarketFilters>; futures?: Partial<MarketFilters & FuturesExtras> }>>;

const pos = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Parse /api/v3/exchangeInfo (spot) or /fapi/v1/exchangeInfo (futures). */
export function parseExchangeInfo(market: Market, json: any): FilterTable {
  const out: FilterTable = {};
  for (const s of json?.symbols || []) {
    if (!isSymbol(s?.symbol)) continue;
    if (market === 'futures' && s.contractType && s.contractType !== 'PERPETUAL') continue;
    const f: Record<string, any> = {};
    for (const x of s.filters || []) f[x.filterType] = x;
    const base = { tickSize: pos(f.PRICE_FILTER?.tickSize), stepSize: pos(f.LOT_SIZE?.stepSize), minQty: pos(f.LOT_SIZE?.minQty) };
    const sym = s.symbol as SymbolId;
    if (market === 'spot') out[sym] = { ...out[sym], spot: defined({ ...base, minNotional: pos(f.NOTIONAL?.minNotional ?? f.MIN_NOTIONAL?.minNotional) }) };
    else
      out[sym] = {
        ...out[sym],
        futures: defined({
          ...base,
          minNotional: pos(f.MIN_NOTIONAL?.notional),
          liquidationFeeRate: pos(s.liquidationFee),
          maxMarketQty: pos(f.MARKET_LOT_SIZE?.maxQty),
          priceBandUp: pos(f.PERCENT_PRICE?.multiplierUp),
          priceBandDown: pos(f.PERCENT_PRICE?.multiplierDown),
          maxOrders: pos(f.MAX_NUM_ORDERS?.limit),
        }),
      };
  }
  return out;
}

/** Apply parsed filters to SYMBOL_SPECS in place (main process, renderer and workers each hold a copy). */
export function applyFilterTable(t: FilterTable | null | undefined): void {
  if (!t) return;
  for (const sym of SYMBOLS) {
    const e = t[sym];
    if (!e) continue;
    if (e.spot) Object.assign(SYMBOL_SPECS[sym].spot, defined(e.spot));
    if (e.futures) Object.assign(SYMBOL_SPECS[sym].futures, defined(e.futures));
  }
}

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
