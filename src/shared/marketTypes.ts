/** Types shared between the main process (market data services) and renderers. */
import type { Market, SymbolId } from './symbols';
import type { RenkoOptions } from './candles';
import type { MetricKind } from './metrics';

export type ChartType = 'candles' | 'heikinashi' | 'renko' | 'bars' | 'line' | 'area' | 'hollow' | 'footprint';

export interface SeriesSpec {
  symbol: SymbolId;
  market: Market;
  tf: string;
  chartType: ChartType;
  renko?: RenkoOptions;
  /** Futures statistics instead of klines (open interest, long/short ratios; see shared/metrics). */
  metric?: MetricKind;
}

export type SeriesStatus = 'loading' | 'live' | 'syncing' | 'reconnecting' | 'degraded' | 'error' | 'replay';

export interface SeriesInfo {
  key: string;
  baseInterval: string | null;
  /** Human readable description of how the series is built. */
  construction: string;
  renkoBox?: number;
  error?: string;
}

export interface SeriesSnapshot {
  key: string;
  packed: Float64Array;
  status: SeriesStatus;
  info: SeriesInfo;
  /** True if older history exists beyond the first bar. */
  hasMore: boolean;
}

export interface SeriesUpdate {
  key: string;
  /** Index of the first changed bar. Bars after it in `packed` follow contiguously. */
  index: number;
  packed: Float64Array;
  /** New total length after applying (bars beyond it are removed, e.g. provisional Renko bricks). */
  length: number;
  /** When true the client must replace its data with a fresh snapshot request. */
  reset?: boolean;
  status?: SeriesStatus;
  lastPrice?: number;
}

export interface Ticker {
  symbol: SymbolId;
  market: Market;
  last: number;
  open24h: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePct24h: number;
  volume24h: number;
  quoteVolume24h: number;
  t: number;
  mark?: number;
  index?: number;
  fundingRate?: number;
  nextFundingTime?: number;
}

export type ImbalanceMethod = 'levels' | 'depthPct' | 'weighted';

export interface BookMetrics {
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  imbalance: number;
  imbalanceMethod: ImbalanceMethod;
  imbalanceParam: number;
  bidDepth1pct: number;
  askDepth1pct: number;
}

export interface BookSnapshot {
  t: number;
  status: string;
  bids: [number, number][];
  asks: [number, number][];
  metrics: BookMetrics;
}

export interface HeatmapColumn {
  t: number;
  p0: number;
  bin: number;
  bids: Float32Array;
  asks: Float32Array;
  bestBid: number;
  bestAsk: number;
}

export type LargeOrderKind = 'appeared' | 'pulled' | 'consumed' | 'moved' | 'moved-from';

export interface LargeOrderEvent {
  t: number;
  side: 'bid' | 'ask';
  price: number;
  qty: number;
  notional: number;
  kind: LargeOrderKind;
  fromPrice?: number;
  ageMs: number;
}

export interface TradePrint {
  id: number;
  t: number;
  p: number;
  q: number;
  m: boolean;
}

export interface ConnectionInfo {
  conns: Record<string, { state: string; lastMessageAt: number; messages: number }>;
  tapes: { key: string; status: string; lastPrice: number; watermark: number; stats: Record<string, number> }[];
  books: { key: string; status: string; resyncs: number }[];
}

export function seriesKey(s: SeriesSpec): string {
  const r = s.chartType === 'renko' && s.renko ? `:${s.renko.boxSize || ''}/${s.renko.atrLength || ''}/${s.renko.percent || ''}/${s.renko.source || 'close'}` : '';
  const ct = s.metric ? s.metric : s.chartType === 'heikinashi' || s.chartType === 'renko' ? s.chartType : 'ohlc';
  return `${s.market}:${s.symbol}:${s.tf}:${ct}${r}`;
}
