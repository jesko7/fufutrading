/**
 * Order-flow chart tools: HVN Profile, Heavy Absorption, Imbalance Levels and DOM.
 *
 * They are native chart indicators (not scripts): the first three are computed in the main
 * process from Binance aggregate trades, trade by trade (aggressor side from the maker flag),
 * and Heavy Absorption also reads the live order book; the DOM draws the live local order book.
 * On a chart they are indicator instances whose script id is `of:<kind>`.
 */
import type { Market, SymbolId } from './symbols';

export type OrderFlowKind = 'hvn' | 'absorption' | 'imbalance' | 'dom';

export const ORDERFLOW_KINDS: OrderFlowKind[] = ['hvn', 'absorption', 'imbalance', 'dom'];

export function orderFlowKind(scriptId: string | null | undefined): OrderFlowKind | null {
  if (!scriptId || !scriptId.startsWith('of:')) return null;
  const k = scriptId.slice(3) as OrderFlowKind;
  return ORDERFLOW_KINDS.includes(k) ? k : null;
}

export interface OrderFlowInputDef {
  key: string;
  type: 'int' | 'float' | 'bool' | 'string' | 'color';
  title: string;
  defval: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tooltip?: string;
  group?: string;
}

export interface OrderFlowTool {
  kind: OrderFlowKind;
  id: string;
  name: string;
  description: string;
  inputs: OrderFlowInputDef[];
}

const ROW: OrderFlowInputDef = {
  key: 'row',
  type: 'float',
  title: 'Row size (price, 0 = auto)',
  defval: 0,
  min: 0,
  step: 1,
  tooltip: 'Price step that trades are grouped into. Auto: about 1 basis point of the price, rounded to a multiple of the tick (BTC ≈ 10, ETH ≈ 0.25).',
};

export const ORDERFLOW_TOOLS: Record<OrderFlowKind, OrderFlowTool> = {
  hvn: {
    kind: 'hvn',
    id: 'of:hvn',
    name: 'HVN Profile',
    description: 'High-volume nodes of the volume profile, from every Binance trade. Bands show the volume traded there and the buyers’ share; a band ends where price trades back into it.',
    inputs: [
      { key: 'period', type: 'string', title: 'Profile period', defval: 'Auto', options: ['Auto', '1h', '4h', '8h', '1D'], tooltip: 'Each period gets its own volume profile, starting at UTC boundaries. Auto: 4h on charts below 15 minutes, 1D otherwise.' },
      { key: 'periods', type: 'int', title: 'Earlier periods', defval: 2, min: 0, max: 6, tooltip: 'Completed periods whose nodes stay on the chart, besides the one that is forming' },
      { key: 'count', type: 'int', title: 'Nodes per period', defval: 6, min: 1, max: 20 },
      { key: 'strength', type: 'float', title: 'Min. strength (× average)', defval: 1.2, min: 1, max: 6, step: 0.1, tooltip: 'A node’s band must hold this many times the profile’s average volume per band' },
      { key: 'band', type: 'int', title: 'Band height (rows)', defval: 3, min: 1, max: 9, step: 2 },
      ROW,
      { key: 'extend', type: 'string', title: 'Bands', defval: 'Until touched', options: ['Until touched', 'Always'], tooltip: 'Until touched: a node of a completed period ends at the first bar that trades into it' },
      { key: 'color', type: 'color', title: 'Color', defval: '#c08a2e', group: 'Style' },
      { key: 'labels', type: 'bool', title: 'Volume | buy % labels', defval: true, group: 'Style' },
    ],
  },
  absorption: {
    kind: 'absorption',
    id: 'of:absorption',
    name: 'Heavy Absorption',
    description: 'Bubbles where heavy aggressive volume hit one price level while it held: passive limit orders absorbed it. Live from every trade, with the order book’s resting size for comparison. A bubble stays; if price later trades through its level it gets a dashed outline.',
    inputs: [
      { key: 'sensitivity', type: 'string', title: 'Sensitivity', defval: 'Medium', options: ['Low', 'Medium', 'High'], tooltip: 'Automatic threshold: the absorbed volume must be in the top 1% (low), 2% (medium) or 5% (high) of recent hit clusters (runs of aggressive trades into one row)' },
      { key: 'minVolume', type: 'float', title: 'Min. absorbed volume (0 = auto)', defval: 0, min: 0, step: 0.1, tooltip: 'In the base asset (BTC, ETH, SOL). 0 adapts to the market' },
      { key: 'gap', type: 'float', title: 'Max. pause between hits (s)', defval: 3, min: 0.5, max: 30, step: 0.5 },
      { key: 'minAge', type: 'float', title: 'Show once the level held for (s)', defval: 2, min: 0, max: 30, step: 0.5, tooltip: 'The level must take the hits and hold this long before the bubble prints, so a fast sweep through several levels is not shown as absorption. At most the pause between hits' },
      { key: 'hold', type: 'float', title: 'Level must hold for (s)', defval: 8, min: 0, max: 120, step: 1, tooltip: 'After the last hit, the level is confirmed when price does not trade through it for this long. A bubble whose level breaks stays on the chart with a dashed outline' },
      { key: 'tolerance', type: 'int', title: 'Break tolerance (rows)', defval: 1, min: 0, max: 5 },
      ROW,
      { key: 'book', type: 'bool', title: 'Only when more traded than the book showed', defval: false, tooltip: 'Live only: keep bubbles where the volume absorbed exceeded the resting size the order book showed at the level when the hits began (refilled or hidden orders)' },
      { key: 'buyColor', type: 'color', title: 'Buying absorbed', defval: '#22a861', group: 'Style', tooltip: 'Aggressive buyers absorbed by resting sell orders (usually at highs)' },
      { key: 'sellColor', type: 'color', title: 'Selling absorbed', defval: '#e0453c', group: 'Style', tooltip: 'Aggressive sellers absorbed by resting buy orders (usually at lows)' },
      { key: 'numbers', type: 'bool', title: 'Volume in the bubble', defval: true, group: 'Style' },
    ],
  },
  imbalance: {
    kind: 'imbalance',
    id: 'of:imbalance',
    name: 'Imbalance Levels',
    description: 'Stacked diagonal bid/ask imbalances from each bar’s footprint, extended as levels until price trades back into them. Labels: ratio × | imbalanced volume.',
    inputs: [
      { key: 'ratio', type: 'float', title: 'Imbalance ratio (×)', defval: 3, min: 1.5, max: 20, step: 0.5, tooltip: 'Buying at a row against selling one row lower (and selling against buying one row higher)' },
      { key: 'stack', type: 'int', title: 'Stacked rows', defval: 3, min: 2, max: 10 },
      { key: 'minVolume', type: 'float', title: 'Min. volume per row (0 = auto)', defval: 0, min: 0, step: 0.1, tooltip: 'Auto: the average volume of a row side in the bars so far' },
      ROW,
      { key: 'maxLevels', type: 'int', title: 'Levels shown', defval: 10, min: 1, max: 200 },
      { key: 'hideFilled', type: 'bool', title: 'Hide levels price came back to', defval: false },
      { key: 'buyColor', type: 'color', title: 'Buy imbalance', defval: '#1f9d55', group: 'Style' },
      { key: 'sellColor', type: 'color', title: 'Sell imbalance', defval: '#d63a3a', group: 'Style' },
    ],
  },
  dom: {
    kind: 'dom',
    id: 'of:dom',
    name: 'DOM',
    description: 'Depth of market on the price axis: every level of the live Binance order book, bids green below the price and asks red above, updated several times a second.',
    inputs: [
      { key: 'width', type: 'int', title: 'Width (% of the chart)', defval: 22, min: 5, max: 60 },
      { key: 'interval', type: 'int', title: 'Update every (ms)', defval: 200, min: 100, max: 2000, step: 50 },
      { key: 'scale', type: 'string', title: 'Bar length', defval: 'Largest visible level', options: ['Largest visible level', 'Square root'] },
      { key: 'bidColor', type: 'color', title: 'Bids', defval: '#1fae3a', group: 'Style' },
      { key: 'askColor', type: 'color', title: 'Asks', defval: '#e32222', group: 'Style' },
    ],
  },
};

/** Inputs with defaults filled in. */
export function orderFlowInputs(kind: OrderFlowKind, inputs: Record<string, unknown> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of ORDERFLOW_TOOLS[kind].inputs) {
    const v = inputs?.[d.key];
    out[d.key] = v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) ? d.defval : v;
  }
  return out;
}

// ------------------------------------------------------------------ engine parameters

export interface HvnParams {
  row: number;
  periodMs: number;
  periods: number;
  count: number;
  strength: number;
  /** Band height in rows (odd). */
  band: number;
  untilTouched: boolean;
}

export interface AbsorptionParams {
  row: number;
  /** Quantile of hit-cluster volumes used as the automatic threshold. */
  quantile: number;
  minVolume: number;
  gapMs: number;
  /** The level must take hits and hold this long before the bubble shows (filters sweeps). */
  minAgeMs: number;
  holdMs: number;
  tolerance: number;
  bookOnly: boolean;
}

export interface ImbalanceParams {
  row: number;
  ratio: number;
  stack: number;
  minVolume: number;
  maxLevels: number;
}

export interface OrderFlowRequest {
  symbol: SymbolId;
  market: Market;
  tf: string;
  hvn?: HvnParams | null;
  absorption?: AbsorptionParams | null;
  imbalance?: ImbalanceParams | null;
}

// ------------------------------------------------------------------ outputs

/** A high-volume node: a price band of one profile period. */
export interface HvnLevel {
  id: string;
  lo: number;
  hi: number;
  /** Volume traded in the band during the period (base asset). */
  vol: number;
  /** Aggressive buy volume in the band. */
  buy: number;
  /** Period start (the band starts there). */
  from: number;
  /** Bar time where price first traded back into the band after the period; null: still open. */
  to: number | null;
  /** The node belongs to the period that is still forming. */
  developing: boolean;
}

/** Stacked imbalance zone of one bar. */
export interface ImbalanceLevel {
  id: string;
  /** 1: buyers (ask side) dominated, -1: sellers. */
  side: 1 | -1;
  lo: number;
  hi: number;
  /** Bar open time. */
  t: number;
  rows: number;
  /** Imbalanced side's volume / the diagonal opposite volume (at least the noise floor). */
  ratio: number;
  /** Imbalanced side's volume. */
  vol: number;
  /** The diagonal opposite side's volume. */
  opp: number;
  /** Bar time where price traded back into the zone; null: untouched. */
  end: number | null;
  /** Still forming (the bar is open). */
  live: boolean;
}

/** Heavy absorption: aggressive volume that one price level absorbed while holding. */
export interface AbsorptionEvent {
  id: string;
  /** 1: aggressive buying absorbed by resting asks; -1: aggressive selling absorbed by bids. */
  side: 1 | -1;
  /** Volume-weighted price of the hits. */
  price: number;
  lo: number;
  hi: number;
  /** When the absorbed volume crossed the threshold (the bubble's bar). */
  t: number;
  /** First and last hit. */
  t0: number;
  t1: number;
  vol: number;
  trades: number;
  /** Resting size the order book showed at the level at the first hit (live only). */
  shown: number | null;
  /** Largest resting size seen at the level while it was hit (live only). */
  maxShown: number | null;
  /** live: being hit or within the hold time; held: the level held; broken: price traded through it afterwards. */
  state: 'live' | 'held' | 'broken';
  /** When price traded through the level (state broken). */
  broke: number | null;
}

export interface DomBook {
  t: number;
  status: string;
  step: number;
  bestBid: number;
  bestAsk: number;
  /** Rows by price (bids floor, asks ceil to the step), best first. */
  bp: Float64Array;
  bq: Float64Array;
  ap: Float64Array;
  aq: Float64Array;
}

/** A "nice" step at or above `raw`, a multiple of the tick. */
export function niceStep(raw: number, tick: number): number {
  const r = Math.max(tick, raw);
  const mag = 10 ** Math.floor(Math.log10(r));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= r * 0.999) || 10 * mag;
  return Math.max(tick, Math.round(nice / tick) * tick);
}

/** Automatic order-flow row: about one basis point of the price. */
export function autoRow(price: number, tick: number): number {
  return niceStep(price * 0.0001, tick);
}

/** Absorbed volume, compact: 0.84, 12.4, 156, 1.2K. */
export function fmtFlowQty(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
