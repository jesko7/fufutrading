/**
 * Strategy builder model and code generation. The visual flowchart edits a BuilderModel; this
 * module turns it into readable Pine Script or Python (fufu API) with an input for every
 * parameter, so generated strategies can be edited, optimized and backtested like hand-written
 * ones. Only documented, supported functions are emitted.
 */

export type IndKind = 'sma' | 'ema' | 'rsi' | 'macd' | 'macdSignal' | 'macdHist' | 'bbUpper' | 'bbBasis' | 'bbLower' | 'atr' | 'stochK' | 'stochD' | 'highest' | 'lowest' | 'vwap' | 'volume' | 'volumeSma' | 'supertrend';
export type PriceField = 'close' | 'open' | 'high' | 'low';

export type Operand = { kind: 'price'; field: PriceField } | { kind: 'value'; v: number } | { kind: 'ind'; ind: IndKind; len?: number; len2?: number; len3?: number; mult?: number; src?: PriceField; offset?: number };

export type Cmp = 'crossAbove' | 'crossBelow' | 'above' | 'below';

export interface Cond {
  left: Operand;
  cmp: Cmp;
  right: Operand;
}

export interface Group {
  op: 'and' | 'or';
  conds: Cond[];
}

export interface BuilderModel {
  name: string;
  language: 'pine' | 'python';
  long: { enabled: boolean; when: Group };
  short: { enabled: boolean; when: Group };
  exitLong: Group;
  exitShort: Group;
  /** Higher-timeframe trend filter: longs only above / shorts only below an EMA on `tf`. */
  filter: { enabled: boolean; tf: string; len: number };
  risk: { stopPct: number | null; takePct: number | null; trailPct: number | null; sizePct: number };
}

export const IND_LABEL: Record<IndKind, string> = {
  sma: 'SMA',
  ema: 'EMA',
  rsi: 'RSI',
  macd: 'MACD line',
  macdSignal: 'MACD signal',
  macdHist: 'MACD histogram',
  bbUpper: 'Bollinger upper',
  bbBasis: 'Bollinger basis',
  bbLower: 'Bollinger lower',
  atr: 'ATR',
  stochK: 'Stochastic %K',
  stochD: 'Stochastic %D',
  highest: 'Highest high',
  lowest: 'Lowest low',
  vwap: 'VWAP',
  volume: 'Volume',
  volumeSma: 'Volume SMA',
  supertrend: 'Supertrend line',
};

/** Default parameters for an indicator operand. */
export function defaultInd(ind: IndKind): Operand {
  switch (ind) {
    case 'sma':
    case 'ema':
      return { kind: 'ind', ind, len: 20, src: 'close' };
    case 'rsi':
      return { kind: 'ind', ind, len: 14, src: 'close' };
    case 'macd':
    case 'macdSignal':
    case 'macdHist':
      return { kind: 'ind', ind, len: 12, len2: 26, len3: 9, src: 'close' };
    case 'bbUpper':
    case 'bbBasis':
    case 'bbLower':
      return { kind: 'ind', ind, len: 20, mult: 2, src: 'close' };
    case 'atr':
      return { kind: 'ind', ind, len: 14 };
    case 'stochK':
    case 'stochD':
      return { kind: 'ind', ind, len: 14, len2: 3, len3: 3 };
    case 'highest':
    case 'lowest':
      return { kind: 'ind', ind, len: 20, offset: 1 };
    case 'volumeSma':
      return { kind: 'ind', ind, len: 20 };
    case 'supertrend':
      return { kind: 'ind', ind, len: 10, mult: 3 };
    default:
      return { kind: 'ind', ind };
  }
}

export function emptyGroup(): Group {
  return { op: 'and', conds: [] };
}

export const TEMPLATES: { id: string; label: string; model: BuilderModel }[] = [
  {
    id: 'ma',
    label: 'Moving-average crossover',
    model: {
      name: 'MA crossover (builder)',
      language: 'pine',
      long: { enabled: true, when: { op: 'and', conds: [{ left: { kind: 'ind', ind: 'ema', len: 20, src: 'close' }, cmp: 'crossAbove', right: { kind: 'ind', ind: 'ema', len: 50, src: 'close' } }] } },
      short: { enabled: false, when: { op: 'and', conds: [{ left: { kind: 'ind', ind: 'ema', len: 20, src: 'close' }, cmp: 'crossBelow', right: { kind: 'ind', ind: 'ema', len: 50, src: 'close' } }] } },
      exitLong: { op: 'or', conds: [{ left: { kind: 'ind', ind: 'ema', len: 20, src: 'close' }, cmp: 'crossBelow', right: { kind: 'ind', ind: 'ema', len: 50, src: 'close' } }] },
      exitShort: emptyGroup(),
      filter: { enabled: false, tf: '4h', len: 200 },
      risk: { stopPct: null, takePct: null, trailPct: null, sizePct: 100 },
    },
  },
  {
    id: 'rsi',
    label: 'RSI mean reversion',
    model: {
      name: 'RSI reversion (builder)',
      language: 'pine',
      long: { enabled: true, when: { op: 'and', conds: [{ left: { kind: 'ind', ind: 'rsi', len: 14, src: 'close' }, cmp: 'crossAbove', right: { kind: 'value', v: 30 } }] } },
      short: { enabled: false, when: { op: 'and', conds: [{ left: { kind: 'ind', ind: 'rsi', len: 14, src: 'close' }, cmp: 'crossBelow', right: { kind: 'value', v: 70 } }] } },
      exitLong: { op: 'or', conds: [{ left: { kind: 'ind', ind: 'rsi', len: 14, src: 'close' }, cmp: 'above', right: { kind: 'value', v: 60 } }] },
      exitShort: emptyGroup(),
      filter: { enabled: true, tf: '4h', len: 200 },
      risk: { stopPct: 3, takePct: null, trailPct: null, sizePct: 100 },
    },
  },
  {
    id: 'bb',
    label: 'Bollinger breakout',
    model: {
      name: 'Bollinger breakout (builder)',
      language: 'pine',
      long: { enabled: true, when: { op: 'and', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'crossAbove', right: { kind: 'ind', ind: 'bbUpper', len: 20, mult: 2, src: 'close' } }] } },
      short: { enabled: false, when: { op: 'and', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'crossBelow', right: { kind: 'ind', ind: 'bbLower', len: 20, mult: 2, src: 'close' } }] } },
      exitLong: { op: 'or', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'crossBelow', right: { kind: 'ind', ind: 'bbBasis', len: 20, mult: 2, src: 'close' } }] },
      exitShort: emptyGroup(),
      filter: { enabled: false, tf: '1D', len: 50 },
      risk: { stopPct: null, takePct: null, trailPct: 4, sizePct: 100 },
    },
  },
  {
    id: 'donchian',
    label: 'Donchian breakout',
    model: {
      name: 'Donchian breakout (builder)',
      language: 'pine',
      long: { enabled: true, when: { op: 'and', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'above', right: { kind: 'ind', ind: 'highest', len: 20, offset: 1 } }] } },
      short: { enabled: false, when: emptyGroup() },
      exitLong: { op: 'or', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'below', right: { kind: 'ind', ind: 'lowest', len: 10, offset: 1 } }] },
      exitShort: emptyGroup(),
      filter: { enabled: false, tf: '1D', len: 50 },
      risk: { stopPct: 5, takePct: null, trailPct: null, sizePct: 100 },
    },
  },
];

// ------------------------------------------------------------------ helpers

/** App timeframe ("15m", "4h", "1D") → Pine Script timeframe string ("15", "240", "1D"). */
export function pineTf(tf: string): string {
  const m = /^(\d+)\s*([smhDWM])$/.exec(tf.trim());
  if (!m) return tf;
  const n = +m[1];
  switch (m[2]) {
    case 's':
      return `${n}S`;
    case 'm':
      return String(n);
    case 'h':
      return String(n * 60);
    default:
      return `${n}${m[2]}`;
  }
}

function operandKey(o: Operand): string {
  if (o.kind === 'price') return o.field;
  if (o.kind === 'value') return `v${o.v}`;
  return [o.ind, o.len, o.len2, o.len3, o.mult, o.src, o.offset].filter((x) => x !== undefined).join('_').replace(/\./g, 'p');
}

export function operandLabel(o: Operand): string {
  if (o.kind === 'price') return o.field[0].toUpperCase() + o.field.slice(1);
  if (o.kind === 'value') return String(o.v);
  const args = [o.len, o.len2, o.len3, o.mult].filter((x) => x !== undefined);
  return `${IND_LABEL[o.ind]}${args.length ? `(${args.join(', ')})` : ''}${o.offset ? ` [${o.offset}]` : ''}`;
}

const CMP_TEXT: Record<Cmp, string> = { crossAbove: 'crosses above', crossBelow: 'crosses below', above: 'is above', below: 'is below' };

export function condText(c: Cond): string {
  return `${operandLabel(c.left)} ${CMP_TEXT[c.cmp]} ${operandLabel(c.right)}`;
}

function allConds(m: BuilderModel): Cond[] {
  return [...(m.long.enabled ? m.long.when.conds : []), ...(m.short.enabled ? m.short.when.conds : []), ...(m.long.enabled ? m.exitLong.conds : []), ...(m.short.enabled ? m.exitShort.conds : [])];
}

/** Problems that make generation impossible or meaningless. */
export function validate(m: BuilderModel): string[] {
  const out: string[] = [];
  if (!m.long.enabled && !m.short.enabled) out.push('Enable long or short entries.');
  if (m.long.enabled && !m.long.when.conds.length) out.push('Add at least one long entry condition.');
  if (m.short.enabled && !m.short.when.conds.length) out.push('Add at least one short entry condition.');
  for (const c of allConds(m)) if (c.left.kind === 'value' && c.right.kind === 'value') out.push(`"${condText(c)}" compares two constants.`);
  if (!(m.risk.sizePct > 0 && m.risk.sizePct <= 100)) out.push('Position size must be between 0 and 100% of equity.');
  return out;
}

// ------------------------------------------------------------------ Pine

interface Decl {
  key: string;
  pine: string[];
  inputs: string[];
}

function pineOperand(o: Operand, decls: Map<string, Decl>): string {
  if (o.kind === 'price') return o.field;
  if (o.kind === 'value') return String(o.v);
  const key = operandKey(o);
  const name = `x_${key}`;
  if (decls.has(key)) return name;
  const inputs: string[] = [];
  const inp = (suffix: string, v: number | undefined, title: string, float = false) => {
    const id = `i_${key}_${suffix}`;
    inputs.push(`${id} = ${float ? 'input.float' : 'input.int'}(${v}, "${title}"${float ? ', step=0.1' : ', minval=1'})`);
    return id;
  };
  const src = o.src || 'close';
  const lines: string[] = [];
  const lbl = IND_LABEL[o.ind];
  switch (o.ind) {
    case 'sma':
    case 'ema':
    case 'rsi':
      lines.push(`${name} = ta.${o.ind}(${src}, ${inp('len', o.len, `${lbl} length`)})`);
      break;
    case 'macd':
    case 'macdSignal':
    case 'macdHist': {
      const f = inp('fast', o.len, 'MACD fast');
      const s = inp('slow', o.len2, 'MACD slow');
      const g = inp('sig', o.len3, 'MACD signal');
      const idx = o.ind === 'macd' ? 0 : o.ind === 'macdSignal' ? 1 : 2;
      lines.push(`[${name}_m, ${name}_s, ${name}_h] = ta.macd(${src}, ${f}, ${s}, ${g})`);
      lines.push(`${name} = ${[`${name}_m`, `${name}_s`, `${name}_h`][idx]}`);
      break;
    }
    case 'bbUpper':
    case 'bbBasis':
    case 'bbLower': {
      const l = inp('len', o.len, 'Bollinger length');
      const k = inp('mult', o.mult, 'Bollinger width (σ)', true);
      lines.push(`[${name}_b, ${name}_u, ${name}_l] = ta.bb(${src}, ${l}, ${k})`);
      lines.push(`${name} = ${o.ind === 'bbBasis' ? `${name}_b` : o.ind === 'bbUpper' ? `${name}_u` : `${name}_l`}`);
      break;
    }
    case 'atr':
      lines.push(`${name} = ta.atr(${inp('len', o.len, 'ATR length')})`);
      break;
    case 'stochK':
    case 'stochD': {
      const l = inp('len', o.len, 'Stochastic length');
      const ks = inp('k', o.len2, 'Stochastic %K smoothing');
      const ds = inp('d', o.len3, 'Stochastic %D smoothing');
      lines.push(`${name}_k = ta.sma(ta.stoch(close, high, low, ${l}), ${ks})`);
      lines.push(`${name} = ${o.ind === 'stochK' ? `${name}_k` : `ta.sma(${name}_k, ${ds})`}`);
      break;
    }
    case 'highest':
    case 'lowest': {
      const l = inp('len', o.len, `${o.ind === 'highest' ? 'Highest high' : 'Lowest low'} lookback`);
      lines.push(`${name} = ta.${o.ind}(${o.ind === 'highest' ? 'high' : 'low'}, ${l})${o.offset ? `[${o.offset}]` : ''}`);
      break;
    }
    case 'vwap':
      lines.push(`${name} = ta.vwap(hlc3)`);
      break;
    case 'volume':
      lines.push(`${name} = volume`);
      break;
    case 'volumeSma':
      lines.push(`${name} = ta.sma(volume, ${inp('len', o.len, 'Volume average length')})`);
      break;
    case 'supertrend': {
      const f = inp('mult', o.mult, 'Supertrend factor', true);
      const p = inp('len', o.len, 'Supertrend ATR length');
      lines.push(`[${name}, ${name}_dir] = ta.supertrend(${f}, ${p})`);
      break;
    }
  }
  decls.set(key, { key, pine: lines, inputs });
  return name;
}

function pineCond(c: Cond, decls: Map<string, Decl>): string {
  const a = pineOperand(c.left, decls);
  const b = pineOperand(c.right, decls);
  switch (c.cmp) {
    case 'crossAbove':
      return `ta.crossover(${a}, ${b})`;
    case 'crossBelow':
      return `ta.crossunder(${a}, ${b})`;
    case 'above':
      return `${a} > ${b}`;
    default:
      return `${a} < ${b}`;
  }
}

function pineGroup(g: Group, decls: Map<string, Decl>): string {
  if (!g.conds.length) return 'false';
  return g.conds.map((c) => (g.conds.length > 1 ? `(${pineCond(c, decls)})` : pineCond(c, decls))).join(g.op === 'and' ? ' and ' : ' or ');
}

export function toPine(m: BuilderModel): string {
  const decls = new Map<string, Decl>();
  const longEntry = m.long.enabled ? pineGroup(m.long.when, decls) : 'false';
  const shortEntry = m.short.enabled ? pineGroup(m.short.when, decls) : 'false';
  const longExit = m.long.enabled && m.exitLong.conds.length ? pineGroup(m.exitLong, decls) : null;
  const shortExit = m.short.enabled && m.exitShort.conds.length ? pineGroup(m.exitShort, decls) : null;
  const L: string[] = [];
  L.push('//@version=6');
  L.push(`// @name ${m.name}`);
  L.push('// @category Strategies');
  L.push('// @description Generated by the FuFu strategy builder. Edit freely — the builder will not overwrite your changes.');
  L.push(`strategy("${m.name.replace(/"/g, "'")}", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=${m.risk.sizePct}, commission_type=strategy.commission.percent, commission_value=0.1)`);
  L.push('');
  L.push('// ---- inputs');
  for (const d of decls.values()) L.push(...d.inputs);
  if (m.filter.enabled) {
    L.push(`i_filterTf = input.timeframe("${pineTf(m.filter.tf)}", "Trend filter timeframe")`);
    L.push(`i_filterLen = input.int(${m.filter.len}, "Trend filter EMA length", minval=1)`);
  }
  if (m.risk.stopPct) L.push(`i_stopPct = input.float(${m.risk.stopPct}, "Stop loss %", minval=0.1, step=0.1)`);
  if (m.risk.takePct) L.push(`i_takePct = input.float(${m.risk.takePct}, "Take profit %", minval=0.1, step=0.1)`);
  if (m.risk.trailPct) L.push(`i_trailPct = input.float(${m.risk.trailPct}, "Trailing stop %", minval=0.1, step=0.1)`);
  L.push('');
  L.push('// ---- indicators');
  for (const d of decls.values()) L.push(...d.pine);
  const plots = [...decls.values()].filter((d) => /^(sma|ema|bb|vwap|supertrend|highest|lowest)/.test(d.key));
  for (const d of plots) L.push(`plot(x_${d.key}, "${operandLabel(operandFromKey(d.key, m) || { kind: 'value', v: 0 }).replace(/"/g, "'")}")`);
  if (m.filter.enabled) {
    L.push('');
    L.push('// ---- higher-timeframe trend filter (confirmed bars only: no lookahead)');
    L.push('htfEma = request.security(syminfo.tickerid, i_filterTf, ta.ema(close, i_filterLen)[1], lookahead=barmerge.lookahead_on)');
    L.push('trendUp = close > htfEma');
    L.push('trendDown = close < htfEma');
  }
  L.push('');
  L.push('// ---- signals');
  L.push(`longSignal = ${longEntry}${m.filter.enabled && m.long.enabled ? ' and trendUp' : ''}`);
  L.push(`shortSignal = ${shortEntry}${m.filter.enabled && m.short.enabled ? ' and trendDown' : ''}`);
  if (longExit) L.push(`longExit = ${longExit}`);
  if (shortExit) L.push(`shortExit = ${shortExit}`);
  L.push('');
  L.push('// ---- orders');
  if (m.long.enabled) L.push('if longSignal\n    strategy.entry("Long", strategy.long)');
  if (m.short.enabled) L.push('if shortSignal\n    strategy.entry("Short", strategy.short)');
  if (longExit) L.push('if longExit\n    strategy.close("Long", comment="exit rule")');
  if (shortExit) L.push('if shortExit\n    strategy.close("Short", comment="exit rule")');
  if (m.risk.stopPct || m.risk.takePct || m.risk.trailPct) {
    L.push('');
    L.push('// ---- risk management (percent of the entry price, converted to ticks)');
    L.push('avg = strategy.position_avg_price');
    const args = (dir: 1 | -1) => {
      const a: string[] = [];
      if (m.risk.stopPct) a.push(`stop=avg * (1 ${dir === 1 ? '-' : '+'} i_stopPct / 100)`);
      if (m.risk.takePct) a.push(`limit=avg * (1 ${dir === 1 ? '+' : '-'} i_takePct / 100)`);
      if (m.risk.trailPct) a.push('trail_points=avg * i_trailPct / 100 / syminfo.mintick, trail_offset=avg * i_trailPct / 100 / syminfo.mintick');
      return a.join(', ');
    };
    if (m.long.enabled) L.push(`if strategy.position_size > 0\n    strategy.exit("Long risk", "Long", ${args(1)})`);
    if (m.short.enabled) L.push(`if strategy.position_size < 0\n    strategy.exit("Short risk", "Short", ${args(-1)})`);
  }
  L.push('');
  L.push('plotshape(longSignal, "Long signal", shape.triangleup, location.belowbar, color.new(color.teal, 0), size=size.tiny)');
  if (m.short.enabled) L.push('plotshape(shortSignal, "Short signal", shape.triangledown, location.abovebar, color.new(color.red, 0), size=size.tiny)');
  return `${L.join('\n')}\n`;
}

function operandFromKey(key: string, m: BuilderModel): Operand | null {
  for (const c of allConds(m)) for (const o of [c.left, c.right]) if (o.kind === 'ind' && operandKey(o) === key) return o;
  return null;
}

// ------------------------------------------------------------------ Python

function pyOperand(o: Operand, decls: Map<string, Decl>, params: string[]): string {
  if (o.kind === 'price') return `self.data.${o.field}`;
  if (o.kind === 'value') return String(o.v);
  const key = operandKey(o);
  const name = `self.x_${key}`;
  if (decls.has(key)) return name;
  const p = (suffix: string, v: number | undefined, title: string, float = false) => {
    const id = `p_${key}_${suffix}`;
    params.push(`    ${id} = ${float ? 'input.float' : 'input.int'}(${v}, "${title}"${float ? ', step=0.1' : ', min=1'})`);
    return `self.${id}`;
  };
  const src = `self.data.${o.src || 'close'}`;
  const lines: string[] = [];
  const lbl = IND_LABEL[o.ind];
  const reg = (expr: string, plot: boolean) => lines.push(`        ${name} = self.I(${expr}, "${operandLabel(o).replace(/"/g, "'")}"${plot ? '' : ', plot=False'})`);
  switch (o.ind) {
    case 'sma':
    case 'ema':
      reg(`ta.${o.ind}(${src}, ${p('len', o.len, `${lbl} length`)})`, true);
      break;
    case 'rsi':
      reg(`ta.rsi(${src}, ${p('len', o.len, 'RSI length')})`, false);
      break;
    case 'macd':
    case 'macdSignal':
    case 'macdHist': {
      const idx = o.ind === 'macd' ? 0 : o.ind === 'macdSignal' ? 1 : 2;
      reg(`ta.macd(${src}, ${p('fast', o.len, 'MACD fast')}, ${p('slow', o.len2, 'MACD slow')}, ${p('sig', o.len3, 'MACD signal')})[${idx}]`, false);
      break;
    }
    case 'bbUpper':
    case 'bbBasis':
    case 'bbLower': {
      const idx = o.ind === 'bbBasis' ? 0 : o.ind === 'bbUpper' ? 1 : 2;
      reg(`ta.bb(${src}, ${p('len', o.len, 'Bollinger length')}, ${p('mult', o.mult, 'Bollinger width', true)})[${idx}]`, true);
      break;
    }
    case 'atr':
      reg(`ta.atr(${p('len', o.len, 'ATR length')})`, false);
      break;
    case 'stochK':
    case 'stochD': {
      const k = `ta.sma(ta.stoch(self.data.close, self.data.high, self.data.low, ${p('len', o.len, 'Stochastic length')}), ${p('k', o.len2, '%K smoothing')})`;
      reg(o.ind === 'stochK' ? k : `ta.sma(${k}, ${p('d', o.len3, '%D smoothing')})`, false);
      break;
    }
    case 'highest':
    case 'lowest': {
      const base = `ta.${o.ind}(self.data.${o.ind === 'highest' ? 'high' : 'low'}, ${p('len', o.len, `${lbl} lookback`)})`;
      reg(o.offset ? `np.concatenate([np.full(${o.offset}, np.nan), ${base}[:-${o.offset}]])` : base, true);
      break;
    }
    case 'vwap':
      reg('ta.vwap()', true);
      break;
    case 'volume':
      reg('self.data.volume', false);
      break;
    case 'volumeSma':
      reg(`ta.sma(self.data.volume, ${p('len', o.len, 'Volume average length')})`, false);
      break;
    case 'supertrend':
      reg(`ta.supertrend(${p('mult', o.mult, 'Supertrend factor', true)}, ${p('len', o.len, 'Supertrend ATR length')})[0]`, true);
      break;
  }
  decls.set(key, { key, pine: lines, inputs: [] });
  return name;
}

function pyCond(c: Cond, decls: Map<string, Decl>, params: string[]): string {
  const a = pyOperand(c.left, decls, params);
  const b = pyOperand(c.right, decls, params);
  const last = (x: string, o: Operand) => (o.kind === 'value' ? x : `${x}[-1]`);
  switch (c.cmp) {
    case 'crossAbove':
      return `crossover(${a}, ${b})`;
    case 'crossBelow':
      return `crossunder(${a}, ${b})`;
    case 'above':
      return `${last(a, c.left)} > ${last(b, c.right)}`;
    default:
      return `${last(a, c.left)} < ${last(b, c.right)}`;
  }
}

function pyGroup(g: Group, decls: Map<string, Decl>, params: string[]): string {
  if (!g.conds.length) return 'False';
  return g.conds.map((c) => `(${pyCond(c, decls, params)})`).join(g.op === 'and' ? ' and ' : ' or ');
}

export function toPython(m: BuilderModel): string {
  const decls = new Map<string, Decl>();
  const params: string[] = [];
  const longEntry = m.long.enabled ? pyGroup(m.long.when, decls, params) : 'False';
  const shortEntry = m.short.enabled ? pyGroup(m.short.when, decls, params) : 'False';
  const longExit = m.long.enabled && m.exitLong.conds.length ? pyGroup(m.exitLong, decls, params) : null;
  const shortExit = m.short.enabled && m.exitShort.conds.length ? pyGroup(m.exitShort, decls, params) : null;
  const cls = (m.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Builder').replace(/^\d/, 'S$&');
  const L: string[] = [];
  L.push(`# @name ${m.name}`);
  L.push('# @category Strategies');
  L.push('# @description Generated by the FuFu strategy builder. Edit freely — the builder will not overwrite your changes.');
  L.push('from fufu import *');
  L.push('');
  L.push('');
  L.push(`@strategy("${m.name.replace(/"/g, "'")}", initial_capital=10000, default_qty_type="percent_of_equity", default_qty_value=${m.risk.sizePct}, commission=0.001)`);
  L.push(`class ${cls}(Strategy):`);
  L.push(...params);
  if (m.filter.enabled) {
    L.push(`    filter_tf = input.timeframe("${m.filter.tf}", "Trend filter timeframe")`);
    L.push(`    filter_len = input.int(${m.filter.len}, "Trend filter EMA length", min=1)`);
  }
  if (m.risk.stopPct) L.push(`    stop_pct = input.float(${m.risk.stopPct}, "Stop loss %", step=0.1)`);
  if (m.risk.takePct) L.push(`    take_pct = input.float(${m.risk.takePct}, "Take profit %", step=0.1)`);
  if (m.risk.trailPct) L.push(`    trail_pct = input.float(${m.risk.trailPct}, "Trailing stop %", step=0.1)`);
  L.push('');
  L.push('    def init(self):');
  for (const d of decls.values()) L.push(...d.pine);
  if (m.filter.enabled) {
    L.push('        # higher-timeframe EMA as of the last *closed* higher-timeframe bar (no lookahead)');
    L.push('        htf_close = self.data.htf(self.filter_tf, "close")');
    L.push('        self.trend = self.I(ta.ema(np.nan_to_num(htf_close, nan=self.data.close[0]), self.filter_len), "HTF trend EMA")');
  }
  if (!decls.size && !m.filter.enabled) L.push('        pass');
  L.push('');
  L.push('    def next(self):');
  L.push(`        long_signal = ${longEntry}${m.filter.enabled && m.long.enabled ? ' and self.data.close[-1] > self.trend.last' : ''}`);
  L.push(`        short_signal = ${shortEntry}${m.filter.enabled && m.short.enabled ? ' and self.data.close[-1] < self.trend.last' : ''}`);
  if (longExit) L.push(`        if self.position.is_long and (${longExit}):\n            self.close("Long", comment="exit rule")`);
  if (shortExit) L.push(`        if self.position.is_short and (${shortExit}):\n            self.close("Short", comment="exit rule")`);
  const price = 'self.data.close[-1]';
  const risk = (dir: 1 | -1) => {
    const a: string[] = [];
    if (m.risk.stopPct) a.push(`sl=${price} * (1 ${dir === 1 ? '-' : '+'} self.stop_pct / 100)`);
    if (m.risk.takePct) a.push(`tp=${price} * (1 ${dir === 1 ? '+' : '-'} self.take_pct / 100)`);
    return a.length ? `, ${a.join(', ')}` : '';
  };
  if (m.long.enabled) L.push(`        if long_signal and not self.position.is_long:\n            self.entry("Long", long${risk(1)})`);
  if (m.short.enabled) L.push(`        if short_signal and not self.position.is_short:\n            self.entry("Short", short${risk(-1)})`);
  if (m.risk.trailPct) {
    L.push('        # trailing stop in ticks from the entry price');
    L.push('        if self.position:');
    L.push('            ticks = self.position.avg_price * self.trail_pct / 100 / self.data.mintick');
    L.push(`            self.exit("Trail", from_entry="Long" if self.position.is_long else "Short", trail_points=ticks, trail_offset=ticks)`);
  }
  return `${L.join('\n')}\n`;
}

export function generate(m: BuilderModel): string {
  return m.language === 'python' ? toPython(m) : toPine(m);
}
