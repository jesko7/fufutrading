/** Chart engine types. All script outputs are aligned to bar indexes of the chart's series. */

export interface ChartTheme {
  bg: string;
  grid: string;
  text: string;
  textStrong: string;
  cross: string;
  border: string;
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  accent: string;
  labelBg: string;
  font: string;
  fontSize: number;
  volumeOpacity: number;
  hollowUp: boolean;
  showGrid: boolean;
  /** Horizontal wheel / touchpad scrolling reversed. */
  reverseScroll?: boolean;
}

export interface ChartBars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  tbv: Float64Array;
  length: number;
}

export type SeriesStyle = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'footprint';
export type ScaleMode = 'linear' | 'log' | 'percent';

export type PlotType = 'line' | 'linebr' | 'stepline' | 'histogram' | 'columns' | 'area' | 'areabr' | 'circles' | 'cross' | 'candles' | 'bars';

export interface PlotSeries {
  id: string;
  title: string;
  type: PlotType;
  values: Float64Array;
  /** One color for the whole plot, or per-bar colors (null = hidden). */
  color: string;
  colors?: (string | null)[];
  width: number;
  offset?: number;
  histbase?: number;
  visible?: boolean;
  /** Show the last value on the price axis. */
  trackPrice?: boolean;
  precision?: number;
  /** plotcandle / plotbar: open, high and low (values = close). */
  o?: Float64Array;
  h?: Float64Array;
  l?: Float64Array;
}

export type ShapeStyle = 'triangleup' | 'triangledown' | 'circle' | 'cross' | 'xcross' | 'arrowup' | 'arrowdown' | 'labelup' | 'labeldown' | 'square' | 'diamond' | 'flag' | 'char';
export type ShapeLocation = 'abovebar' | 'belowbar' | 'top' | 'bottom' | 'absolute';

export interface ShapeSeries {
  id: string;
  title: string;
  style: ShapeStyle;
  location: ShapeLocation;
  /** For absolute: price per bar; else truthy (non-zero, non-NaN) = draw. */
  values: Float64Array;
  color: string;
  colors?: (string | null)[];
  text?: string;
  char?: string;
  textColor?: string;
  size: 'tiny' | 'small' | 'normal' | 'large' | 'huge' | 'auto';
  offset?: number;
}

export interface HLineSpec {
  id: string;
  price: number;
  color: string;
  style: 'solid' | 'dashed' | 'dotted';
  width: number;
  title?: string;
}

export interface FillSpec {
  a: string;
  b: string;
  color: string;
  colors?: (string | null)[];
}

export interface ScriptLabel {
  x: number; // bar index (fractional ok)
  y: number;
  text: string;
  color: string;
  textColor: string;
  style: string;
  size: string;
  yloc?: 'price' | 'abovebar' | 'belowbar';
  tooltip?: string;
}

export interface ScriptLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style: 'solid' | 'dashed' | 'dotted' | 'arrow_left' | 'arrow_right' | 'arrow_both';
  extend: 'none' | 'left' | 'right' | 'both';
}

export interface ScriptBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  border: string;
  bg: string;
  width: number;
  text?: string;
  textColor?: string;
  extend?: 'none' | 'left' | 'right' | 'both';
  /** Border style: solid, dashed or dotted. */
  style?: string;
}

export interface ScriptTableCell {
  row: number;
  col: number;
  text: string;
  bg?: string;
  color?: string;
}

export interface ScriptTable {
  position: string;
  cells: ScriptTableCell[];
  bg?: string;
  border?: string;
}

export interface IndicatorOutput {
  id: string;
  title: string;
  shortTitle?: string;
  overlay: boolean;
  plots: PlotSeries[];
  shapes: ShapeSeries[];
  hlines: HLineSpec[];
  fills: FillSpec[];
  bgcolors?: (string | null)[];
  barcolors?: (string | null)[];
  labels?: ScriptLabel[];
  lines?: ScriptLine[];
  boxes?: ScriptBox[];
  tables?: ScriptTable[];
  /** linefills and polylines (bar index / price paths). */
  polys?: { pts: [number, number][]; fill?: string; stroke?: string; width?: number; style?: string; closed?: boolean; curved?: boolean }[];
  /** Fixed scale bounds for separate panes (e.g. RSI 0..100), optional. */
  scaleMin?: number;
  scaleMax?: number;
  precision?: number;
  /** "volume" shows values as K/M/B, "percent" with a % sign. */
  format?: string;
  error?: string;
  /** Lookahead / repainting patterns and run notes (legend ⚠). */
  warnings?: import('../../engine/types').ScriptWarning[];
  visible: boolean;
  /** Strategy outputs: trades to draw on the chart. */
  trades?: { entryIndex: number; exitIndex: number; entryPrice: number; exitPrice: number; dir: 1 | -1; pnl: number; entryLabel?: string; exitLabel?: string; open?: boolean }[];
}

export interface CompareSeries {
  id: string;
  label: string;
  color: string;
  t: Float64Array;
  c: Float64Array;
  length: number;
}

export interface MtfSeries {
  id: string;
  tf: string;
  style: 'boxes' | 'line';
  color: string;
  bars: ChartBars;
  /** bucket end times (exclusive) per HTF bar */
  ends: Float64Array;
}

export interface TradeLine {
  id: string;
  kind: 'position' | 'limit' | 'stop' | 'sl' | 'tp' | 'liq' | 'alert';
  price: number;
  label: string;
  color: string;
  draggable: boolean;
  cancellable: boolean;
  side?: 'buy' | 'sell';
  /** For position lines: allow dragging out SL/TP handles. */
  bracket?: boolean;
  pnl?: number;
}

/** A light horizontal level with a label at the right edge (options levels). Colors: hex, or 'up' / 'down' / 'accent'. */
export interface LevelLine {
  id: string;
  price: number;
  label: string;
  color: string;
}

/** A shaded price range (expected move). */
export interface LevelBand {
  from: number;
  to: number;
  color: string;
}

export interface Execution {
  t: number;
  price: number;
  side: 'buy' | 'sell';
  qty: number;
  label?: string;
}

export interface VolumeProfileOptions {
  mode: 'off' | 'visible' | 'fixed' | 'session';
  rows: number;
  valueArea: number;
  from?: number;
  to?: number;
  width?: number;
}

export interface FootprintBar {
  t: number;
  /** price level step */
  step: number;
  prices: Float64Array;
  buy: Float64Array; // aggressive buy volume at level (ask side)
  sell: Float64Array; // aggressive sell volume at level (bid side)
}

export interface FootprintOptions {
  group: number;
  mode: 'bidask' | 'delta' | 'volume';
  imbalanceRatio: number;
}

export type DrawingType = 'trend' | 'ray' | 'extended' | 'hline' | 'hray' | 'vline' | 'channel' | 'fib' | 'fibext' | 'fibtime' | 'rect' | 'text' | 'measure';

export interface DrawingPoint {
  t: number;
  p: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  color: string;
  width: number;
  dash: 'solid' | 'dashed' | 'dotted';
  text?: string;
  fill?: string;
  locked?: boolean;
  hidden?: boolean;
  levels?: number[];
  extendLeft?: boolean;
  extendRight?: boolean;
  showLabels?: boolean;
}

export const DRAWING_POINTS: Record<DrawingType, number> = {
  trend: 2,
  ray: 2,
  extended: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  channel: 3,
  fib: 2,
  fibext: 3,
  fibtime: 2,
  rect: 2,
  text: 1,
  measure: 2,
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
export const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export interface CrosshairInfo {
  index: number;
  time: number;
  price: number;
  pane: number;
  x: number;
  y: number;
}
