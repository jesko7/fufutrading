/**
 * Pine Script v4 (and older) compatibility. v4 has no `ta.` / `math.` / `request.` / `str.`
 * namespaces, uses `study()`, `iff()`, `security()`, a `transp` parameter on plots, positional
 * `when` conditions on strategy calls and bare built-in variables such as `tr` or `obv`. The
 * compiler resolves these to their v5 equivalents, so v4 scripts run on the same engine and give
 * the same values.
 */
import type { Arg, Expr } from './ast';

/** v4 function name → v5 name. Only used when the script doesn't define the name itself. */
export const V4_FUNCTIONS: Record<string, string> = {
  // ta.*
  alma: 'ta.alma',
  atr: 'ta.atr',
  barssince: 'ta.barssince',
  bb: 'ta.bb',
  bbw: 'ta.bbw',
  cci: 'ta.cci',
  change: 'ta.change',
  cmo: 'ta.cmo',
  cog: 'ta.cog',
  correlation: 'ta.correlation',
  cross: 'ta.cross',
  crossover: 'ta.crossover',
  crossunder: 'ta.crossunder',
  cum: 'ta.cum',
  dev: 'ta.dev',
  dmi: 'ta.dmi',
  ema: 'ta.ema',
  falling: 'ta.falling',
  highest: 'ta.highest',
  highestbars: 'ta.highestbars',
  hma: 'ta.hma',
  kc: 'ta.kc',
  kcw: 'ta.kcw',
  linreg: 'ta.linreg',
  lowest: 'ta.lowest',
  lowestbars: 'ta.lowestbars',
  macd: 'ta.macd',
  median: 'ta.median',
  mfi: 'ta.mfi',
  mode: 'ta.mode',
  mom: 'ta.mom',
  percentile_linear_interpolation: 'ta.percentile_linear_interpolation',
  percentile_nearest_rank: 'ta.percentile_nearest_rank',
  percentrank: 'ta.percentrank',
  pivothigh: 'ta.pivothigh',
  pivotlow: 'ta.pivotlow',
  range: 'ta.range',
  rising: 'ta.rising',
  rma: 'ta.rma',
  roc: 'ta.roc',
  rsi: 'ta.rsi',
  sar: 'ta.sar',
  sma: 'ta.sma',
  stdev: 'ta.stdev',
  stoch: 'ta.stoch',
  supertrend: 'ta.supertrend',
  swma: 'ta.swma',
  tr: 'ta.tr',
  tsi: 'ta.tsi',
  valuewhen: 'ta.valuewhen',
  variance: 'ta.variance',
  vwap: 'ta.vwap',
  vwma: 'ta.vwma',
  wma: 'ta.wma',
  wpr: 'ta.wpr',
  // math.*
  abs: 'math.abs',
  acos: 'math.acos',
  asin: 'math.asin',
  atan: 'math.atan',
  avg: 'math.avg',
  ceil: 'math.ceil',
  cos: 'math.cos',
  exp: 'math.exp',
  floor: 'math.floor',
  log: 'math.log',
  log10: 'math.log10',
  max: 'math.max',
  min: 'math.min',
  pow: 'math.pow',
  random: 'math.random',
  round: 'math.round',
  sign: 'math.sign',
  sin: 'math.sin',
  sqrt: 'math.sqrt',
  sum: 'math.sum',
  tan: 'math.tan',
  todegrees: 'math.todegrees',
  toradians: 'math.toradians',
  // requests, tickers, strings, declarations
  security: 'request.security',
  financial: 'request.financial',
  quandl: 'request.quandl',
  splits: 'request.splits',
  dividends: 'request.dividends',
  earnings: 'request.earnings',
  heikinashi: 'ticker.heikinashi',
  renko: 'ticker.renko',
  linebreak: 'ticker.linebreak',
  kagi: 'ticker.kagi',
  pointfigure: 'ticker.pointfigure',
  tickerid: 'ticker.new',
  tostring: 'str.tostring',
  tonumber: 'str.tonumber',
  study: 'indicator',
};

/** v4 built-in variables that moved into namespaces. `vwap` is a call (VWAP of hlc3). */
export const V4_VARIABLES: Record<string, string> = {
  tr: 'ta.tr',
  obv: 'ta.obv',
  accdist: 'ta.accdist',
  iii: 'ta.iii',
  nvi: 'ta.nvi',
  pvi: 'ta.pvi',
  pvt: 'ta.pvt',
  wad: 'ta.wad',
  wvad: 'ta.wvad',
};

/**
 * v4 signatures of functions whose parameters differ from v5 (positional order, `transp`,
 * `when`, `resolution`, `long`). `transp` is folded into the colour parameters listed in
 * TRANSP_TARGETS; `when` becomes a guard around the call.
 */
const V4_SIGNATURES: Record<string, string> = {
  plot: 'series,title,color,linewidth,style,transp,trackprice,histbase,offset,join,editable,show_last,display',
  plotshape: 'series,title,style,location,color,transp,offset,text,textcolor,editable,size,show_last,display',
  plotchar: 'series,title,char,location,color,transp,offset,text,textcolor,editable,size,show_last,display',
  plotarrow: 'series,title,colorup,colordown,transp,offset,minheight,maxheight,editable,show_last,display',
  fill: 'hline1,hline2,color,transp,title,editable,fillgaps',
  bgcolor: 'color,transp,offset,editable,show_last,title',
  indicator: 'title,shorttitle,overlay,format,precision,scale,max_bars_back,resolution,resolution_gaps,max_lines_count,max_labels_count,max_boxes_count',
  'request.security': 'symbol,resolution,expression,gaps,lookahead',
  'strategy.entry': 'id,long,qty,limit,stop,oca_name,oca_type,comment,when,alert_message',
  'strategy.order': 'id,long,qty,limit,stop,oca_name,oca_type,comment,when,alert_message',
  'strategy.exit': 'id,from_entry,qty,qty_percent,profit,limit,loss,stop,trail_price,trail_points,trail_offset,oca_name,comment,when,alert_message',
  'strategy.close': 'id,when,comment,qty,qty_percent,alert_message',
  'strategy.close_all': 'when,comment,alert_message',
  'strategy.cancel': 'id,when',
  'strategy.cancel_all': 'when',
};

const TRANSP_TARGETS: Record<string, string[]> = {
  plot: ['color'],
  plotshape: ['color'],
  plotchar: ['color'],
  plotarrow: ['colorup', 'colordown'],
  fill: ['color'],
  bgcolor: ['color'],
};

/** v4 parameter names that v5 renamed. */
const RENAMED: Record<string, string> = { resolution: 'timeframe', resolution_gaps: 'timeframe_gaps', long: 'direction' };

/** Strategy calls accept `when` up to v5 (removed in v6). */
const WHEN_FUNCS = new Set(['strategy.entry', 'strategy.order', 'strategy.exit', 'strategy.close', 'strategy.close_all', 'strategy.cancel', 'strategy.cancel_all']);

let synth = 0;

function colorNew(color: Expr, transp: Expr): Expr {
  const pos = { line: color.line, col: color.col };
  const callee: Expr = { k: 'member', obj: { k: 'id', name: 'color', ...pos } as Expr, prop: 'new', ...pos } as Expr;
  return { k: 'call', callee, args: [{ value: color }, { value: transp }], id: 2_000_000 + synth++, ...pos } as Expr;
}

/**
 * Rewrite a call to a special function into v5 form (named arguments with v5 names, `transp`
 * folded into the colour) and pull out a `when` condition. Calls of v5+ scripts only lose
 * `when` (v5); everything else is returned unchanged.
 */
export function normalizeLegacyCall(name: string, e: Extract<Expr, { k: 'call' }>, version: number): { call: Extract<Expr, { k: 'call' }>; when?: Expr } {
  if (version >= 5) {
    if (version >= 6 || !WHEN_FUNCS.has(name)) return { call: e };
    const w = e.args.find((a) => a.name === 'when');
    return w ? { call: { ...e, args: e.args.filter((a) => a !== w) }, when: w.value } : { call: e };
  }
  const sig = V4_SIGNATURES[name];
  if (!sig) return { call: e };
  const params = sig.split(',');
  const byName = new Map<string, Expr>();
  let pos = 0;
  for (const a of e.args) {
    if (a.name) byName.set(a.name, a.value);
    else if (pos < params.length) byName.set(params[pos++], a.value);
  }
  let when: Expr | undefined;
  if (byName.has('when')) {
    when = byName.get('when');
    byName.delete('when');
  }
  const transp = byName.get('transp');
  byName.delete('transp');
  if (transp) for (const t of TRANSP_TARGETS[name] || []) if (byName.has(t)) byName.set(t, colorNew(byName.get(t)!, transp));
  const args: Arg[] = [...byName.entries()].map(([k, v]) => ({ name: RENAMED[k] || k, value: v }));
  return { call: { ...e, args }, when };
}

/** Pine v3 and older: bare constants and variables (resolved only when the script doesn't define the name). */
export const V3_COLORS = ['aqua', 'black', 'blue', 'fuchsia', 'gray', 'green', 'lime', 'maroon', 'navy', 'olive', 'orange', 'purple', 'red', 'silver', 'teal', 'white', 'yellow'];
export const V3_PLOT_STYLES: Record<string, string> = { line: 'plot.style_line', linebr: 'plot.style_linebr', stepline: 'plot.style_stepline', histogram: 'plot.style_histogram', cross: 'plot.style_cross', area: 'plot.style_area', areabr: 'plot.style_areabr', columns: 'plot.style_columns', circles: 'plot.style_circles' };
export const V3_INPUT_TYPES = ['integer', 'float', 'bool', 'string', 'source', 'resolution', 'session', 'symbol'];
export const V3_VARIABLES: Record<string, string> = {
  tickerid: 'syminfo.tickerid',
  ticker: 'syminfo.ticker',
  period: 'timeframe.period',
  interval: 'timeframe.multiplier',
  isintraday: 'timeframe.isintraday',
  isdaily: 'timeframe.isdaily',
  isweekly: 'timeframe.isweekly',
  ismonthly: 'timeframe.ismonthly',
  isdwm: 'timeframe.isdwm',
  n: 'bar_index',
};

/** `vwap` as a v4 variable: VWAP of hlc3. */
export function v4Vwap(at: { line: number; col: number }): Extract<Expr, { k: 'call' }> {
  const callee: Expr = { k: 'member', obj: { k: 'id', name: 'ta', ...at } as Expr, prop: 'vwap', ...at } as Expr;
  return { k: 'call', callee, args: [{ value: { k: 'id', name: 'hlc3', ...at } as Expr }], id: 2_000_000 + synth++, ...at } as Extract<Expr, { k: 'call' }>;
}
