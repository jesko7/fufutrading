/** Language-neutral script execution types (Pine and Python produce the same result shape). */

export type ScriptLanguage = 'pine' | 'python';

export interface ScriptInputDef {
  key: string;
  type: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source' | 'timeframe' | 'symbol' | 'session' | 'price' | 'time' | 'text_area' | 'enum';
  title: string;
  defval: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  tooltip?: string;
  group?: string;
  inline?: string;
}

export interface ScriptPlot {
  id: string;
  title: string;
  kind: 'plot' | 'shape' | 'char' | 'arrow' | 'candle' | 'bar';
  style: string;
  color: string;
  colors: (string | null)[] | null;
  values: Float64Array;
  width: number;
  offset: number;
  histbase: number;
  display: boolean;
  trackPrice: boolean;
  location?: string;
  text?: string;
  char?: string;
  textColor?: string;
  size?: string;
  o?: Float64Array;
  h?: Float64Array;
  l?: Float64Array;
  colorup?: string;
  colordown?: string;
}

export interface ScriptWarning {
  line?: number;
  message: string;
  kind: 'lookahead' | 'repaint' | 'compat' | 'info' | 'runtime';
}

export interface ScriptError {
  message: string;
  line?: number;
  col?: number;
  kind: 'syntax' | 'compile' | 'runtime' | 'unsupported' | 'timeout' | 'python';
  bar?: number;
  traceback?: string;
}

export interface TradeRec {
  entryId: string;
  exitId: string;
  dir: 1 | -1;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  profit: number;
  commission: number;
  funding: number;
  returnPct: number;
  mae: number;
  mfe: number;
  entryComment?: string;
  exitComment?: string;
  cumProfit: number;
}

export interface StrategyRaw {
  trades: TradeRec[];
  openTrades: { entryId: string; dir: 1 | -1; qty: number; entryPrice: number; entryBar: number; entryTime: number }[];
  equity: Float64Array;
  fills: { bar: number; t: number; side: 'buy' | 'sell'; qty: number; price: number; fee: number; id: string; kind: string }[];
  initialCapital: number;
  feesPaid: number;
  fundingPaid: number;
  borrowPaid: number;
  liquidations: number;
  warnings: string[];
  ticksUsedBars: number;
  config: Record<string, unknown>;
  /** Position at the end of the run (signed) and its average entry price. */
  position?: number;
  avgPrice?: number;
  /** Orders still resting at the end of the run. */
  pending?: import('./backtest/broker').PendingSnap[];
}

export interface ScriptResult {
  ok: boolean;
  language: ScriptLanguage;
  meta: { type: 'indicator' | 'strategy'; title: string; shortTitle: string; overlay: boolean; precision?: number; scaleMin?: number; scaleMax?: number };
  inputs: ScriptInputDef[];
  plots: ScriptPlot[];
  hlines: { id: string; title: string; price: number; color: string; style: string; width: number; display: boolean }[];
  fills: { a: string; b: string; color: string; colors: (string | null)[] | null }[];
  bgcolors: (string | null)[] | null;
  barcolors: (string | null)[] | null;
  labels: { x: number; y: number; yloc: string; text: string; color: string; textColor: string; style: string; size: string; tooltip?: string }[];
  lines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number; style: string; extend: string }[];
  boxes: { left: number; top: number; right: number; bottom: number; border: string; bg: string; width: number; text?: string; textColor?: string; extend?: string; style?: string }[];
  tables: { position: string; cells: { row: number; col: number; text: string; bg?: string; color?: string }[]; bg?: string; border?: string }[];
  /** linefills and polylines: paths in bar index / price, filled and/or stroked. */
  polys?: { pts: [number, number][]; fill?: string; stroke?: string; width?: number; style?: string; closed?: boolean; curved?: boolean }[];
  alerts: { title: string; message: string; values: Uint8Array }[];
  alertEvents: { bar: number; time: number; message: string }[];
  logs: { bar: number; time: number; level: 'info' | 'warning' | 'error'; msg: string }[];
  warnings: ScriptWarning[];
  error?: ScriptError;
  strategy?: StrategyRaw;
  /** Per-bar values of user variables (debug inspector, opt-in). */
  trace?: Record<string, Float64Array>;
  stats: { bars: number; ms: number };
}

export interface BarSeries {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  tbv?: Float64Array;
  tc: Float64Array;
  length: number;
}

export interface RunContext {
  symbol: string;
  market: 'spot' | 'futures';
  tf: string;
  chartType: string;
  mintick: number;
  base: string;
  quote: string;
}

export function emptyResult(language: ScriptLanguage, error?: ScriptError): ScriptResult {
  return {
    ok: !error,
    language,
    meta: { type: 'indicator', title: 'Script', shortTitle: 'Script', overlay: true },
    inputs: [],
    plots: [],
    hlines: [],
    fills: [],
    bgcolors: null,
    barcolors: null,
    labels: [],
    lines: [],
    boxes: [],
    tables: [],
    alerts: [],
    alertEvents: [],
    logs: [],
    warnings: [],
    error,
    stats: { bars: 0, ms: 0 },
  };
}
