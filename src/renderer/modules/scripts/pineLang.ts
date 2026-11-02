/**
 * Pine Script support for CodeMirror: stream tokenizer (highlighting, indentation, comments),
 * completions built from the engine's builtin registry (so the editor only suggests what FuFu
 * actually implements), user symbols from the document, and hover signatures.
 */
import { StreamLanguage, type StreamParser, LanguageSupport, indentUnit, indentService } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { hoverTooltip, type Tooltip } from '@codemirror/view';
import { BUILTINS, VARIABLES, CONSTANTS, UNSUPPORTED } from '../../../engine/pine/builtins/registry';

const KEYWORDS = new Set(['if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'break', 'continue', 'var', 'varip', 'import', 'export', 'method', 'type', 'enum', 'and', 'or', 'not']);
const ATOMS = new Set(['true', 'false', 'na']);
const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'linefill', 'polyline', 'array', 'matrix', 'map', 'series', 'simple', 'const']);
const NAMESPACES = new Set(['ta', 'math', 'str', 'array', 'map', 'matrix', 'color', 'request', 'input', 'strategy', 'syminfo', 'timeframe', 'barstate', 'session', 'label', 'line', 'box', 'table', 'linefill', 'chart', 'runtime', 'log', 'plot', 'hline', 'shape', 'location', 'size', 'format', 'display', 'barmerge', 'position', 'extend', 'xloc', 'yloc', 'text', 'font', 'order', 'currency', 'alert', 'dayofweek', 'ticker', 'adjustment', 'earnings', 'scale', 'polyline']);

interface PineState {
  afterDot: boolean;
}

const parser: StreamParser<PineState> = {
  name: 'pine',
  startState: () => ({ afterDot: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    const afterDot = state.afterDot;
    state.afterDot = false;
    if (stream.match('//')) {
      const isMeta = stream.match(/^\s*@(version|description|name|category|strategy_alert_message|function|param|returns|type|field|enum|variable)/, false);
      stream.skipToEnd();
      return isMeta ? 'meta' : 'comment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      const q = stream.next();
      let esc = false;
      let c: string | void;
      while ((c = stream.next()) != null) {
        if (c === q && !esc) break;
        esc = !esc && c === '\\';
      }
      return 'string';
    }
    if (stream.match(/^#[0-9a-fA-F]{8}\b/) || stream.match(/^#[0-9a-fA-F]{6}\b/)) return 'atom';
    if (stream.match(/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^(=>|:=|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|[-+*/%<>=?:])/)) return 'operator';
    if (ch === '.') {
      stream.next();
      state.afterDot = true;
      return 'punctuation';
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const w = stream.current();
      if (afterDot) return stream.match(/^\s*(<[^>]*>)?\s*\(/, false) ? 'function' : 'property';
      if (KEYWORDS.has(w)) return 'keyword';
      if (ATOMS.has(w)) return 'atom';
      if (TYPES.has(w) && stream.match(/^\s*(<|\[\]|\s+[A-Za-z_])/, false)) return 'type';
      if (NAMESPACES.has(w) && stream.peek() === '.') return 'builtin';
      if (stream.match(/^\s*(<[^>]*>)?\s*\(/, false)) return BUILTINS[w] || SIMPLE_FUNCS.has(w) ? 'builtin' : 'function';
      if (VARIABLES[w]) return 'builtin';
      return 'variable';
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '//' },
    indentOnInput: /^\s*(else)$/,
    closeBrackets: { brackets: ['(', '[', '"', "'"] },
  },
  tokenTable: {
    function: tags.function(tags.variableName),
  },
};

const SIMPLE_FUNCS = new Set(['plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar', 'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'alert', 'indicator', 'strategy', 'library', 'study', 'nz', 'na', 'fixnan', 'time', 'time_close', 'timestamp', 'max_bars_back', 'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear', 'int', 'float', 'bool', 'string', 'color']);

/** Signatures of functions the compiler handles itself (outputs, declarations, inputs, orders). */
const SPECIAL_SIGS: Record<string, string> = {
  indicator: 'title, shorttitle, overlay, format, precision, scale, max_bars_back, timeframe, timeframe_gaps, explicit_plot_zorder, max_lines_count, max_labels_count, max_boxes_count',
  strategy: 'title, shorttitle, overlay, format, precision, scale, pyramiding, calc_on_order_fills, calc_on_every_tick, max_bars_back, backtest_fill_limits_assumption, default_qty_type, default_qty_value, initial_capital, currency, slippage, commission_type, commission_value, process_orders_on_close, close_entries_rule, margin_long, margin_short',
  plot: 'series, title, color, linewidth, style, trackprice, histbase, offset, join, editable, show_last, display, format, precision',
  plotshape: 'series, title, style, location, color, offset, text, textcolor, editable, size, show_last, display',
  plotchar: 'series, title, char, location, color, offset, text, textcolor, editable, size, show_last, display',
  plotarrow: 'series, title, colorup, colordown, offset, minheight, maxheight, editable, show_last, display',
  plotcandle: 'open, high, low, close, title, color, wickcolor, editable, show_last, bordercolor, display',
  plotbar: 'open, high, low, close, title, color, editable, show_last, display',
  hline: 'price, title, color, linestyle, linewidth, editable, display',
  fill: 'hline1|plot1, hline2|plot2, color, title, editable, fillgaps, display',
  bgcolor: 'color, offset, editable, show_last, title, display',
  barcolor: 'color, offset, editable, show_last, title, display',
  alertcondition: 'condition, title, message',
  'request.security': 'symbol, timeframe, expression, gaps, lookahead, ignore_invalid_symbol, currency, calc_bars_count',
  'request.security_lower_tf': 'symbol, timeframe, expression, ignore_invalid_symbol, currency, ignore_invalid_timeframe, calc_bars_count',
  input: 'defval, title, tooltip, inline, group, confirm, display',
  'input.int': 'defval, title, minval, maxval, step, tooltip, inline, group, confirm, display | defval, title, options, …',
  'input.float': 'defval, title, minval, maxval, step, tooltip, inline, group, confirm, display | defval, title, options, …',
  'input.bool': 'defval, title, tooltip, inline, group, confirm, display',
  'input.string': 'defval, title, options, tooltip, inline, group, confirm, display',
  'input.color': 'defval, title, tooltip, inline, group, confirm, display',
  'input.source': 'defval, title, tooltip, inline, group, display',
  'input.timeframe': 'defval, title, options, tooltip, inline, group, confirm, display',
  'input.symbol': 'defval, title, tooltip, inline, group, confirm, display',
  'input.session': 'defval, title, options, tooltip, inline, group, confirm, display',
  'input.price': 'defval, title, tooltip, inline, group, confirm, display',
  'input.time': 'defval, title, tooltip, inline, group, confirm, display',
  'input.text_area': 'defval, title, tooltip, group, confirm, display',
  'input.enum': 'defval, title, options, tooltip, inline, group, confirm, display',
  'strategy.entry': 'id, direction, qty, limit, stop, oca_name, oca_type, comment, alert_message, disable_alert',
  'strategy.order': 'id, direction, qty, limit, stop, oca_name, oca_type, comment, alert_message, disable_alert',
  'strategy.exit': 'id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price, trail_points, trail_offset, oca_name, comment, comment_profit, comment_loss, comment_trailing',
  'strategy.close': 'id, comment, qty, qty_percent, alert_message, immediately, disable_alert',
  'strategy.close_all': 'comment, alert_message, immediately, disable_alert',
  'strategy.cancel': 'id',
  'strategy.cancel_all': '',
};

const DOCS: Record<string, string> = {
  'ta.sma': 'Simple moving average of the last `length` values.',
  'ta.ema': 'Exponential moving average (alpha = 2/(length+1)), seeded with the SMA like TradingView.',
  'ta.rma': "Wilder's moving average (alpha = 1/length), seeded with the SMA.",
  'ta.rsi': "Relative Strength Index using Wilder's smoothing.",
  'ta.crossover': '`a` crosses above `b` on this bar: a > b and a[1] <= b[1].',
  'ta.crossunder': '`a` crosses below `b` on this bar: a < b and a[1] >= b[1].',
  'request.security': 'Values from another symbol/timeframe. Without lookahead a chart bar only sees bars that have closed. FuFu: Binance BTCUSDT, ETHUSDT, SOLUSDT (spot or .P perpetuals).',
  'strategy.entry': 'Enter (and reverse) a position. Market orders fill at the next bar open; limit/stop orders when price reaches them.',
  'strategy.exit': 'Bracket exit for an entry: profit/loss/trail in ticks, limit/stop as prices.',
  'strategy.close': 'Close the position of the given entry id at market (next bar open, or this close with immediately=true).',
  plot: 'Plot a series on the chart.',
  'input.int': 'Integer input shown in the settings dialog.',
  'input.source': 'Price source input (open, high, low, close, hl2, hlc3, ohlc4, hlcc4, volume).',
  'input.timeframe': 'Timeframe input, e.g. "60" or "240" (minutes), "D", "W". Empty = chart timeframe.',
  nz: 'Replace na with 0 (or the replacement value).',
  'book.available': "FuFu: does this bar have an order-book snapshot? (Live book on the forming bar; recordings from Data → Order books before.)",
  'book.bid_price': 'FuFu: price of a bid level, 0 = best. na without a snapshot.',
  'book.bid_qty': 'FuFu: quantity resting at a bid level, 0 = best.',
  'book.ask_price': 'FuFu: price of an ask level, 0 = best.',
  'book.ask_qty': 'FuFu: quantity resting at an ask level, 0 = best.',
  'book.bid_depth': 'FuFu: bid quantity (base asset) within `percent` % of the mid; all levels with na.',
  'book.ask_depth': 'FuFu: ask quantity (base asset) within `percent` % of the mid; all levels with na.',
  'book.bid_notional': 'FuFu: bid value in USDT within `percent` % of the mid.',
  'book.ask_notional': 'FuFu: ask value in USDT within `percent` % of the mid.',
  'book.imbalance': 'FuFu: (bid − ask) / (bid + ask) quantity over the best `levels` levels a side: −1 … +1.',
  'book.depth_imbalance': 'FuFu: (bid − ask) / (bid + ask) quantity within `percent` % of the mid.',
  'book.bid_wall': 'FuFu: [price, qty] of the largest bid level within `percent` % of the mid.',
  'book.ask_wall': 'FuFu: [price, qty] of the largest ask level within `percent` % of the mid.',
  'book.qty_at': 'FuFu: quantity resting at exactly `price` (0 if no level).',
  'book.fill_price': 'FuFu: average fill price of a market order walked through the book (qty > 0 buys, < 0 sells); na if too thin.',
  'book.bid_prices': 'FuFu: every bid price, best first (array<float>).',
  'book.ask_prices': 'FuFu: every ask price, best first (array<float>).',
  na: 'Is the value na (not available)?',
};

interface Sym {
  label: string;
  type: 'function' | 'variable' | 'constant' | 'keyword' | 'namespace' | 'type' | 'property' | 'method';
  detail?: string;
  info?: string;
}

let SYMBOLS: Sym[] | null = null;

function symbols(): Sym[] {
  if (SYMBOLS) return SYMBOLS;
  const out: Sym[] = [];
  for (const [name, spec] of Object.entries(BUILTINS)) out.push({ label: name, type: 'function', detail: `(${spec.params.join(', ')})`, info: DOCS[name] });
  for (const [name, sig] of Object.entries(SPECIAL_SIGS)) out.push({ label: name, type: 'function', detail: `(${sig})`, info: DOCS[name] });
  for (const name of Object.keys(VARIABLES)) out.push({ label: name, type: 'variable' });
  for (const name of Object.keys(CONSTANTS)) out.push({ label: name, type: 'constant' });
  for (const k of KEYWORDS) out.push({ label: k, type: 'keyword' });
  for (const k of ['true', 'false', 'na']) out.push({ label: k, type: 'constant' });
  for (const t of TYPES) out.push({ label: t, type: 'type' });
  for (const ns of NAMESPACES) if (!out.some((s) => s.label === ns)) out.push({ label: ns, type: 'namespace' });
  for (const n of SIMPLE_FUNCS) if (!out.some((s) => s.label === n)) out.push({ label: n, type: 'function', detail: SPECIAL_SIGS[n] ? `(${SPECIAL_SIGS[n]})` : '' });
  SYMBOLS = out;
  return out;
}

/** User-declared names in the document (variables and functions). */
function userSymbols(doc: string): Sym[] {
  const out = new Map<string, Sym>();
  const fn = /^([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=>/gm;
  let m: RegExpExecArray | null;
  while ((m = fn.exec(doc))) out.set(m[1], { label: m[1], type: 'function', detail: `(${m[2].trim()})`, info: 'User function' });
  const v = /^\s*(?:var\s+|varip\s+)?(?:(?:int|float|bool|string|color|line|label|box|table)\s+)?([A-Za-z_]\w*)\s*(?::?=)(?!=)/gm;
  while ((m = v.exec(doc))) if (!out.has(m[1]) && !KEYWORDS.has(m[1])) out.set(m[1], { label: m[1], type: 'variable', info: 'User variable' });
  const tup = /^\s*\[([^\]]+)\]\s*=/gm;
  while ((m = tup.exec(doc))) for (const n of m[1].split(',').map((s) => s.trim())) if (/^[A-Za-z_]\w*$/.test(n)) out.set(n, { label: n, type: 'variable', info: 'User variable' });
  return [...out.values()];
}

function pineComplete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word) return ctx.explicit ? { from: ctx.pos, options: symbols().map(toCompletion) } : null;
  if (word.from === word.to && !ctx.explicit) return null;
  // inside a comment or string: no completions
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (/\/\//.test(before) || (before.split('"').length - 1) % 2 === 1) return null;
  const all = [...userSymbols(ctx.state.doc.toString()), ...symbols()];
  const dot = word.text.lastIndexOf('.');
  if (dot >= 0) {
    // namespace members: complete the part after the dot only
    const ns = word.text.slice(0, dot + 1);
    const opts = all.filter((s) => s.label.startsWith(ns) && !s.label.slice(ns.length).includes('.')).map((s) => ({ ...toCompletion(s), label: s.label.slice(ns.length) }));
    return { from: word.from + dot + 1, options: opts, validFor: /^\w*$/ };
  }
  return { from: word.from, options: all.filter((s) => !s.label.includes('.') || NAMESPACES.has(s.label.split('.')[0])).map(toCompletion), validFor: /^[\w.]*$/ };
}

function toCompletion(s: Sym): Completion {
  return { label: s.label, type: s.type === 'namespace' ? 'namespace' : s.type === 'constant' ? 'constant' : s.type, detail: s.detail, info: s.info, boost: s.type === 'variable' && ['close', 'open', 'high', 'low', 'volume', 'bar_index'].includes(s.label) ? 5 : 0 };
}

export const pineHover = hoverTooltip((view, pos): Tooltip | null => {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let a = pos - line.from;
  let b = a;
  while (a > 0 && /[\w.]/.test(text[a - 1])) a--;
  while (b < text.length && /[\w.]/.test(text[b])) b++;
  if (a === b) return null;
  let name = text.slice(a, b).replace(/^\.+|\.+$/g, '');
  // hovering a namespace member: include the namespace
  const spec = BUILTINS[name] || (SPECIAL_SIGS[name] !== undefined ? { params: SPECIAL_SIGS[name].split(', ') } : null);
  const unsupported = UNSUPPORTED[name];
  if (!spec && !unsupported && !VARIABLES[name] && !CONSTANTS[name] && !DOCS[name]) {
    name = '';
    return null;
  }
  return {
    pos: line.from + a,
    end: line.from + b,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-pine-hover';
      const sig = document.createElement('div');
      sig.className = 'sig';
      sig.textContent = spec ? `${name}(${spec.params.join(', ')})` : name;
      dom.appendChild(sig);
      const doc = unsupported ? `Not supported in FuFu: ${unsupported}` : DOCS[name] || (VARIABLES[name] ? 'Built-in variable' : CONSTANTS[name] ? 'Built-in constant' : '');
      if (doc) {
        const d = document.createElement('div');
        d.className = unsupported ? 'doc warn' : 'doc';
        d.textContent = doc;
        dom.appendChild(d);
      }
      return { dom };
    },
  };
});

/** Indentation: keep the previous code line's indent, one level deeper after block headers (`=>`, if, for, …). */
const pineIndent = indentService.of((cx, pos) => {
  let prev = cx.lineAt(pos, -1);
  if (prev.from === pos) {
    if (pos === 0) return 0;
    prev = cx.lineAt(pos - 1, -1);
  }
  for (let guard = 0; !prev.text.trim() && prev.from > 0 && guard < 50; guard++) prev = cx.lineAt(prev.from - 1, -1);
  const base = /^\s*/.exec(prev.text)![0].length;
  const code = prev.text.replace(/\/\/.*$/, '').trimEnd();
  const opens = /=>$/.test(code) || /^\s*(if|else|for|while|switch|type|enum)\b/.test(code) || /(:?=)\s*(if|switch|for|while)\b/.test(code);
  return base + (opens ? cx.unit : 0);
});

export const pineLanguage = StreamLanguage.define(parser);

export function pine(): LanguageSupport {
  return new LanguageSupport(pineLanguage, [pineLanguage.data.of({ autocomplete: pineComplete }), indentUnit.of('    '), pineIndent, pineHover]);
}

// ------------------------------------------------------------------ Python (fufu API) completions

const FUFU: Sym[] = [
  ...['indicator', 'strategy', 'plot', 'plotshape', 'plotchar', 'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'crossover', 'crossunder', 'cross', 'nz'].map((l) => ({ label: l, type: 'function' as const, info: 'fufu' })),
  ...['Strategy', 'long', 'short', 'na', 'np', 'ta', 'input', 'color', 'log'].map((l) => ({ label: l, type: 'variable' as const, info: 'fufu' })),
  ...['sma', 'ema', 'rma', 'wma', 'hma', 'vwma', 'alma', 'linreg', 'stdev', 'variance', 'highest', 'lowest', 'change', 'roc', 'mom', 'rsi', 'cci', 'cmo', 'mfi', 'tsi', 'median', 'percentrank', 'correlation', 'cum', 'atr', 'tr', 'wpr', 'sar', 'vwap', 'macd', 'bb', 'kc', 'supertrend', 'dmi', 'stoch', 'pivothigh', 'pivotlow', 'barssince', 'valuewhen', 'crossover', 'crossunder', 'obv'].map((l) => ({ label: `ta.${l}`, type: 'function' as const, info: 'Same implementation as Pine ta.*' })),
  ...['int', 'float', 'bool', 'string', 'source', 'color', 'timeframe'].map((l) => ({ label: `input.${l}`, type: 'function' as const, info: 'Script input (settings dialog)' })),
  ...['red', 'green', 'blue', 'orange', 'purple', 'teal', 'yellow', 'gray', 'white', 'black', 'aqua', 'lime', 'fuchsia', 'new', 'rgb'].map((l) => ({ label: `color.${l}`, type: 'constant' as const })),
  ...['info', 'warning', 'error'].map((l) => ({ label: `log.${l}`, type: 'function' as const })),
  ...['data.open', 'data.high', 'data.low', 'data.close', 'data.volume', 'data.time', 'data.hl2', 'data.hlc3', 'data.ohlc4', 'data.htf', 'data.security', 'data.bar_index', 'data.taker_buy_volume'].map((l) => ({ label: l, type: 'property' as const })),
  ...['self.I', 'self.buy', 'self.sell', 'self.entry', 'self.exit', 'self.close', 'self.close_all', 'self.order', 'self.cancel', 'self.cancel_all', 'self.position', 'self.equity', 'self.bar', 'self.time', 'self.data', 'self.net_profit', 'self.closed_trades', 'self.log'].map((l) => ({ label: l, type: (l.match(/position|equity|bar$|time|data|net_profit|closed_trades/) ? 'property' : 'method') as Sym['type'] })),
];

export function fufuPythonComplete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const dot = word.text.lastIndexOf('.');
  if (dot >= 0) {
    const ns = word.text.slice(0, dot + 1);
    const opts = FUFU.filter((s) => s.label.startsWith(ns)).map((s) => ({ ...toCompletion(s), label: s.label.slice(ns.length) }));
    if (!opts.length) return null;
    return { from: word.from + dot + 1, options: opts, validFor: /^\w*$/ };
  }
  return { from: word.from, options: FUFU.filter((s) => !s.label.includes('.')).map(toCompletion), validFor: /^\w*$/ };
}
