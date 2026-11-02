/** Assemble the `B` object used by generated Pine code. */
import * as ta from './ta';
import { math, nz, str, color, array, map, time, label, line, box, table, linefill, polyline, chartPoint, log, alert } from './lib';
import { matrix, PineMatrix } from './matrix';
import { book } from './book';
import type { Runtime } from '../runtime';
import { parseTimeframe, tfDurationMs, bucketStart, normalize, tfToString } from '../../../shared/timeframes';
import type { StrategyBroker } from '../../backtest/broker';

const isNa = (x: unknown) => x === null || x === undefined || (typeof x === 'number' && x !== x);

/** Pine timeframe string → our timeframe string ('' = chart timeframe). */
export function pineTfToOurs(tf: string, chartTf: string): string {
  const s = String(tf ?? '').trim();
  if (!s) return chartTf;
  const m = /^(\d*)([SDWM]?)$/.exec(s);
  if (!m) throw new Error(`Invalid timeframe "${tf}"`);
  const n = m[1] ? +m[1] : 1;
  const u = m[2];
  if (u === 'S') return tfToString(normalize({ n, unit: 's' }));
  if (u === 'D') return `${n}D`;
  if (u === 'W') return `${n}W`;
  if (u === 'M') return `${n}M`;
  return tfToString(normalize({ n, unit: 'm' }));
}

/** Our timeframe string → Pine timeframe.period (v5 style "D"/"W"/"M" for multiplier 1). */
export function oursToPineTf(tf: string, version = 5): string {
  const t = parseTimeframe(tf);
  if (!t) return tf;
  switch (t.unit) {
    case 's':
      return `${t.n}S`;
    case 'm':
      return String(t.n);
    case 'h':
      return String(t.n * 60);
    case 'D':
      return t.n === 1 && version < 6 ? 'D' : `${t.n}D`;
    case 'W':
      return t.n === 1 && version < 6 ? 'W' : `${t.n}W`;
    case 'M':
      return t.n === 1 && version < 6 ? 'M' : `${t.n}M`;
  }
}

function tfOf(R: Runtime, tf: unknown) {
  const ours = pineTfToOurs(String(tf ?? ''), R.sym.tf);
  const t = parseTimeframe(ours);
  if (!t) throw new Error(`Invalid timeframe ${tf}`);
  return t;
}

function inSession(t: number, session: string): boolean {
  // "HHMM-HHMM[:1234567]" in exchange time (UTC for Binance)
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::(\d+))?$/.exec(session.trim());
  if (!m) return true;
  const d = new Date(t);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const a = +m[1] * 60 + +m[2];
  const b = +m[3] * 60 + +m[4];
  const days = m[5];
  if (days && !days.includes(String(d.getUTCDay() + 1))) return false;
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

export const B = {
  ta,
  math,
  nz,
  str,
  color,
  array,
  map,
  time,
  label,
  line,
  box,
  table,
  linefill,
  polyline,
  chartPoint,
  matrix,
  book,
  /** for-in: matrices iterate over their rows (as arrays). */
  iter: (x: unknown) => (x instanceof PineMatrix ? Array.from({ length: x.rows }, (_, r) => x.rowArray(r)) : x),
  tickerInherit: (_from: string, symbol: string) => symbol,
  log,
  alert,
  toInt: (x: unknown) => (isNa(x) ? NaN : Math.trunc(Number(x))),
  toFloat: (x: unknown) => (isNa(x) ? NaN : Number(x)),
  toBool: (x: unknown) => !isNa(x) && !!x,
  toStr: (x: unknown) => (x === null || x === undefined ? null : String(x)),
  identity: (x: unknown) => x,
  noop: () => undefined,

  // ---------------------------------------------------------------- inputs
  inInt: (R: Runtime, key: string, dv: number) => {
    const v = R.inputs[key];
    return v === undefined || v === null || v === '' || isNaN(Number(v)) ? dv : Math.round(Number(v));
  },
  inFloat: (R: Runtime, key: string, dv: number) => {
    const v = R.inputs[key];
    return v === undefined || v === null || v === '' || isNaN(Number(v)) ? dv : Number(v);
  },
  inBool: (R: Runtime, key: string, dv: boolean) => {
    const v = R.inputs[key];
    return v === undefined || v === null ? dv : v === true || v === 'true' || v === 1;
  },
  inAny: (R: Runtime, key: string, dv: unknown) => {
    const v = R.inputs[key];
    return v === undefined || v === null ? dv : v;
  },
  src: (R: Runtime, name: unknown, i: number) => {
    const d = R.d;
    switch (String(name)) {
      case 'open':
        return d.o[i];
      case 'high':
        return d.h[i];
      case 'low':
        return d.l[i];
      case 'volume':
        return d.v[i];
      case 'hl2':
        return (d.h[i] + d.l[i]) / 2;
      case 'hlc3':
        return (d.h[i] + d.l[i] + d.c[i]) / 3;
      case 'ohlc4':
        return (d.o[i] + d.h[i] + d.l[i] + d.c[i]) / 4;
      case 'hlcc4':
        return (d.h[i] + d.l[i] + 2 * d.c[i]) / 4;
      case 'time':
        return d.t[i];
      default:
        return d.c[i];
    }
  },

  // ---------------------------------------------------------------- outputs
  out: {
    plot: (R: Runtime, k: number, v: unknown, c?: unknown) => {
      const p = R.plots[k];
      if (!p) return k;
      const i = R.i;
      p.values[i] = typeof v === 'boolean' ? (v ? 1 : 0) : v === null || v === undefined ? NaN : (v as number);
      if (p.colors) p.colors[i] = (c as string) ?? null;
      return k;
    },
    candle: (R: Runtime, k: number, o: unknown, h: unknown, l: unknown, c: unknown, col?: string) => {
      const p = R.plots[k];
      const i = R.i;
      // na may arrive as null (e.g. from a ternary): a typed array would store it as 0
      const n = (x: unknown) => (x === null || x === undefined ? NaN : (x as number));
      p.o![i] = n(o);
      p.h![i] = n(h);
      p.l![i] = n(l);
      p.values[i] = n(c);
      if (p.colors) p.colors[i] = col ?? null;
    },
    hline: (R: Runtime, k: number, price: number) => {
      if (R.hlines[k]) R.hlines[k].price = price;
    },
    fill: (R: Runtime, k: number, c: string | null) => {
      const f = R.fills[k];
      if (f && f.colors) f.colors[R.i] = c;
    },
    bg: (R: Runtime, c: string | null) => {
      if (!R.bgcolors) R.bgcolors = new Array(R.n).fill(null);
      R.bgcolors[R.i] = c;
    },
    barcolor: (R: Runtime, c: string | null) => {
      if (!R.barcolors) R.barcolors = new Array(R.n).fill(null);
      R.barcolors[R.i] = c;
    },
    alertcond: (R: Runtime, k: number, cond: unknown) => {
      const a = R.alerts[k];
      if (a) a.values[R.i] = R.bool(cond) ? 1 : 0;
    },
  },

  // ---------------------------------------------------------------- strategy
  strat: {
    /** The quantity a strategy.entry without qty would use at `price`. */
    defaultEntryQty: (R: Runtime, price: number) => {
      const br = R.broker as StrategyBroker | null;
      if (!br || !(price > 0)) return NaN;
      return br.resolveQty({ qty: NaN } as never, price);
    },
    entry: (R: Runtime, kind: 'entry' | 'order', id: string, dir: number, qty?: number, limit?: number, stop?: number, oca?: string, ocaType?: string, comment?: string) => {
      const br = R.broker as StrategyBroker | null;
      if (!br || R.secMode) return;
      br.submit({ id: String(id), kind, dir: dir === -1 || (dir as unknown) === false ? -1 : 1, qty: isNa(qty) ? NaN : (qty as number), limit: isNa(limit) ? undefined : limit, stop: isNa(stop) ? undefined : stop, oca: oca || undefined, ocaType: (ocaType as any) || undefined, comment: comment ?? undefined });
    },
    exit: (R: Runtime, id: string, fromEntry?: string, qty?: number, qtyPct?: number, profit?: number, limit?: number, loss?: number, stop?: number, trailPrice?: number, trailPoints?: number, trailOffset?: number, oca?: string, comment?: string) => {
      const br = R.broker as StrategyBroker | null;
      if (!br || R.secMode) return;
      const num = (x: unknown) => (isNa(x) ? undefined : (x as number));
      br.submit({ id: `__exit_${id}`, kind: 'exit', dir: 1, qty: isNa(qty) ? NaN : (qty as number), qtyPercent: num(qtyPct), fromEntry: fromEntry || undefined, profitTicks: num(profit), lossTicks: num(loss), limit: num(limit), stop: num(stop), trailPrice: num(trailPrice), trailPoints: num(trailPoints), trailOffset: num(trailOffset), oca: oca || undefined, comment: comment ?? undefined });
    },
    close: (R: Runtime, id?: string, comment?: string, qty?: number, qtyPct?: number, immediately?: boolean) => {
      const br = R.broker as StrategyBroker | null;
      if (!br || R.secMode) return;
      br.submit({ id: id ? `__close_${id}` : '__close_all', kind: 'close', dir: 1, qty: isNa(qty) ? NaN : (qty as number), qtyPercent: isNa(qtyPct) ? undefined : qtyPct, fromEntry: id || undefined, comment: comment ?? undefined, immediately: !!immediately });
    },
    cancel: (R: Runtime, id?: string) => {
      const br = R.broker as StrategyBroker | null;
      if (!br) return;
      if (id === undefined) br.cancelAll();
      else br.cancel(String(id));
    },
    v: (R: Runtime, name: string) => {
      const br = R.broker as StrategyBroker | null;
      if (!br) return name === 'position_entry_name' ? null : name === 'position_size' ? 0 : NaN;
      const closed = br.closed;
      switch (name) {
        case 'position_size':
          return br.positionSize;
        case 'position_avg_price':
          return br.positionAvgPrice;
        case 'position_entry_name':
          return br.open[0]?.entryId ?? null;
        case 'equity':
          return br.equityNow();
        case 'netprofit':
          return br.netProfit();
        case 'openprofit':
          return br.openProfit();
        case 'grossprofit':
          return closed.filter((t) => t.profit > 0).reduce((s, t) => s + t.profit, 0);
        case 'grossloss':
          return -closed.filter((t) => t.profit < 0).reduce((s, t) => s + t.profit, 0);
        case 'closedtrades':
          return closed.length;
        case 'opentrades':
          return br.open.length;
        case 'wintrades':
          return closed.filter((t) => t.profit > 0).length;
        case 'losstrades':
          return closed.filter((t) => t.profit < 0).length;
        case 'eventrades':
          return closed.filter((t) => t.profit === 0).length;
        case 'initial_capital':
          return br.cfg.initialCapital;
        case 'max_drawdown':
          return br.drawdownMax;
        case 'max_runup':
          return br.peak - br.cfg.initialCapital;
        default:
          return NaN;
      }
    },
    trade: (R: Runtime, kind: string, field: string, n: number) => {
      const br = R.broker as StrategyBroker | null;
      if (!br) return NaN;
      if (kind === 'closedtrades') {
        const t = br.closed[n];
        if (!t) return NaN;
        const map: Record<string, unknown> = { entry_price: t.entryPrice, exit_price: t.exitPrice, profit: t.profit, entry_bar_index: t.entryBar, exit_bar_index: t.exitBar, entry_time: t.entryTime, exit_time: t.exitTime, size: t.qty * t.dir, commission: t.commission, max_drawdown: t.mae * t.entryPrice * t.qty, max_runup: t.mfe * t.entryPrice * t.qty, entry_id: t.entryId, exit_id: t.exitId, entry_comment: t.entryComment ?? null, exit_comment: t.exitComment ?? null, profit_percent: t.returnPct };
        return map[field] ?? NaN;
      }
      const t = br.open[n];
      if (!t) return NaN;
      const price = R.d.c[R.i];
      const map: Record<string, unknown> = { entry_price: t.entryPrice, profit: (price - t.entryPrice) * t.qty * t.dir, entry_bar_index: t.entryBar, entry_time: t.entryTime, size: t.qty * t.dir, commission: t.commission, entry_id: t.entryId, entry_comment: t.comment ?? null };
      return map[field] ?? NaN;
    },
  },

  // ---------------------------------------------------------------- request.security
  security: (R: Runtime, site: number, value: unknown) => {
    if (R.secMode) {
      if (R.secKeyOf[site] === R.secMode.key) {
        (R.secMode.record[site] ??= [])[R.i] = Array.isArray(value) ? value.slice() : value;
        return value;
      }
      R.warn('Nested request.security calls with different contexts are not supported; returning na.');
      return NaN;
    }
    const arr = R.sec[site];
    if (!arr) R.error('request.security data is not available');
    const v = arr[R.i];
    return v === undefined ? NaN : v;
  },

  // ---------------------------------------------------------------- methods on values
  method: (R: Runtime, obj: unknown, name: string, args: unknown[]) => {
    const needsRt = new Set(['get', 'set', 'remove', 'first', 'last', 'join']);
    if (Array.isArray(obj)) {
      const f = (array as any)[name];
      if (!f) R.error(`array.${name} is not supported`);
      return needsRt.has(name) ? f(R, obj, ...args) : f(obj, ...args);
    }
    if (obj instanceof PineMatrix) {
      const f = (matrix as any)[name];
      if (!f) R.error(`matrix.${name} is not supported`);
      return f(obj, ...args);
    }
    if (obj instanceof Map) {
      const f = (map as any)[name];
      if (!f) R.error(`map.${name} is not supported`);
      return f(obj, ...args);
    }
    if (typeof obj === 'string') {
      const f = (str as any)[name];
      if (!f) R.error(`str.${name} is not supported`);
      return name === 'tostring' || name === 'format' ? f(R, obj, ...args) : f(obj, ...args);
    }
    if (obj === null || obj === undefined) return name.startsWith('get_') ? NaN : undefined;
    if (typeof obj === 'object') {
      const o = obj as Record<string, unknown>;
      let ns: any = null;
      if ('yloc' in o) ns = label;
      else if ('x1' in o) ns = line;
      else if ('bottom' in o && 'left' in o) ns = box;
      else if ('cells' in o) ns = table;
      else if ('l1' in o && 'l2' in o) ns = linefill;
      else if ('points' in o && 'curved' in o) ns = polyline;
      else if ('price' in o && 'index' in o) ns = chartPoint;
      if (ns) {
        const f = ns[name];
        if (!f) R.error(`Method ${name} is not supported`);
        const needsRt = (name === 'copy' && ns !== chartPoint) || name.endsWith('_point') || name === 'set_point';
        return needsRt ? f(R, obj, ...args) : f(obj, ...args);
      }
      if (name === 'copy') return { ...o };
    }
    R.error(`Unknown method '${name}'`);
  },

  // ---------------------------------------------------------------- timeframe & time helpers
  tfSeconds: (R: Runtime, tf: unknown) => tfDurationMs(tfOf(R, tf)) / 1000,
  tfMultiplier: (R: Runtime) => {
    const t = parseTimeframe(R.sym.tf)!;
    return t.unit === 'h' ? t.n * 60 : t.n;
  },
  tfFromSeconds: (s: number) => oursToPineTf(tfToString(normalize({ n: Math.round(s), unit: 's' }))),
  tfChange: (st: any, R: Runtime, tf: unknown) => {
    const t = tfOf(R, tf);
    const b = bucketStart(t, R.d.t[R.i]);
    const changed = st.last !== undefined && b !== st.last;
    st.last = b;
    return changed || R.i === 0;
  },
  timeFn: (R: Runtime, tf?: unknown, session?: string) => {
    const t = R.d.t[R.i];
    if (session && !inSession(t, session)) return NaN;
    return tf ? bucketStart(tfOf(R, tf), t) : t;
  },
  timeCloseFn: (R: Runtime, tf?: unknown, session?: string) => {
    const t = R.d.t[R.i];
    if (session && !inSession(t, session)) return NaN;
    if (!tf) return R.d.tc[R.i];
    const tt = tfOf(R, tf);
    return bucketStart(tt, t) + tfDurationMs(tt);
  },
  tickerNew: (prefix: string, ticker: string) => `${prefix}:${ticker}`,
  tickerHA: (sym: string) => `${sym}#HA`,
};

export type Bindings = typeof B;
