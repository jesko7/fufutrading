/** Pine standard library (non-TA): math, str, color, array, map, time, plotting, drawings, alerts, logs. */
import type { Runtime, LabelObj, LineObj, BoxObj, TableObj } from '../runtime';

const NA = NaN;
const isNa = (x: unknown) => x === null || x === undefined || (typeof x === 'number' && x !== x);

// ---------------------------------------------------------------- math

export const math = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  sqrt: (x: number) => (x < 0 ? NA : Math.sqrt(x)),
  exp: Math.exp,
  log: (x: number) => (x <= 0 ? NA : Math.log(x)),
  log10: (x: number) => (x <= 0 ? NA : Math.log10(x)),
  pow: Math.pow,
  sign: Math.sign,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  todegrees: (x: number) => (x * 180) / Math.PI,
  toradians: (x: number) => (x * Math.PI) / 180,
  round: (x: number, precision?: number) => {
    if (isNa(x)) return NA;
    if (precision === undefined || isNa(precision)) {
      const r = Math.sign(x) * Math.round(Math.abs(x)); // half away from zero, like Pine
      return r === 0 ? 0 : r;
    }
    const p = Math.pow(10, precision);
    return (Math.sign(x) * Math.round(Math.abs(x) * p)) / p;
  },
  max: (...xs: number[]) => {
    let m = -Infinity;
    for (const x of xs) {
      if (isNa(x)) return NA;
      if (x > m) m = x;
    }
    return m;
  },
  min: (...xs: number[]) => {
    let m = Infinity;
    for (const x of xs) {
      if (isNa(x)) return NA;
      if (x < m) m = x;
    }
    return m;
  },
  avg: (...xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length,
  random: (min = 0, max = 1, seed?: number) => {
    void seed;
    return min + Math.random() * (max - min);
  },
  round_to_mintick: (rt: Runtime, x: number) => Math.round(x / rt.sym.mintick) * rt.sym.mintick,
};

export function nz(x: unknown, repl?: unknown): unknown {
  if (isNa(x)) return repl === undefined ? (typeof x === 'number' || x === undefined || x === null ? 0 : x) : repl;
  return x;
}

export function na(x: unknown): boolean {
  return isNa(x);
}

// ---------------------------------------------------------------- strings

function fmtNumber(rt: Runtime, v: number, format?: string): string {
  if (isNa(v)) return 'NaN';
  if (!format) return String(+v.toFixed(10));
  if (format === 'mintick') {
    const d = Math.max(0, Math.ceil(-Math.log10(rt.sym.mintick) - 1e-9));
    return v.toFixed(d);
  }
  if (format === 'percent') return `${v.toFixed(2)}%`;
  if (format === 'volume') {
    const a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(3)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(3)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(3)}K`;
    return v.toFixed(2);
  }
  if (format === 'inherit' || format === 'price') return String(+v.toFixed(8));
  // pattern like "#.##", "0.00", "#,##0.00"
  const m = /^([#,0]*)(?:\.([#0]+))?(%?)$/.exec(format);
  if (m) {
    const frac = m[2] || '';
    const minD = (frac.match(/0/g) || []).length;
    const maxD = frac.length;
    const val = m[3] ? v * 100 : v;
    let s = val.toLocaleString('en-US', { minimumFractionDigits: minD, maximumFractionDigits: maxD, useGrouping: m[1].includes(',') });
    if (m[3]) s += '%';
    return s;
  }
  return String(v);
}

export const str = {
  tostring: (rt: Runtime, v: unknown, format?: string): string => {
    if (v === null || v === undefined) return 'NaN';
    if (typeof v === 'number') return fmtNumber(rt, v, format);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `[${v.map((x) => str.tostring(rt, x, format)).join(', ')}]`;
    return String(v);
  },
  tonumber: (s: unknown) => {
    const v = parseFloat(String(s));
    return isFinite(v) ? v : NA;
  },
  format: (rt: Runtime, fmt: string, ...args: unknown[]) =>
    String(fmt).replace(/\{(\d+)(?:,\s*(number|date|time)\s*(?:,\s*([^}]+))?)?\}/g, (_m, idx, kind, pattern) => {
      const v = args[+idx];
      if (kind === 'number' && typeof v === 'number') {
        if (pattern === 'percent') return `${(v * 100).toFixed(0)}%`;
        if (pattern === 'integer') return String(Math.round(v));
        if (pattern === 'currency') return `$${v.toFixed(2)}`;
        return fmtNumber(rt, v, pattern ? pattern.trim() : '#.###');
      }
      if ((kind === 'date' || kind === 'time') && typeof v === 'number') return new Date(v).toISOString().replace('T', ' ').slice(0, 19);
      return str.tostring(rt, v);
    }),
  format_time: (t: number, format = "yyyy-MM-dd'T'HH:mm:ssZ", tz?: string) => {
    void tz;
    const d = new Date(t);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return String(format)
      .replace(/yyyy/g, String(d.getUTCFullYear()))
      .replace(/MM/g, p2(d.getUTCMonth() + 1))
      .replace(/dd/g, p2(d.getUTCDate()))
      .replace(/HH/g, p2(d.getUTCHours()))
      .replace(/mm/g, p2(d.getUTCMinutes()))
      .replace(/ss/g, p2(d.getUTCSeconds()))
      .replace(/'T'/g, 'T')
      .replace(/Z/g, '+0000');
  },
  length: (s: string) => (isNa(s) ? NA : String(s).length),
  contains: (s: string, sub: string) => String(s).includes(String(sub)),
  startswith: (s: string, sub: string) => String(s).startsWith(String(sub)),
  endswith: (s: string, sub: string) => String(s).endsWith(String(sub)),
  pos: (s: string, sub: string) => {
    const i = String(s).indexOf(String(sub));
    return i < 0 ? NA : i;
  },
  substring: (s: string, a: number, b?: number) => String(s).substring(a, b),
  replace: (s: string, target: string, repl: string, occurrence = 0) => {
    const src = String(s);
    let idx = -1;
    let from = 0;
    for (let k = 0; k <= occurrence; k++) {
      idx = src.indexOf(target, from);
      if (idx < 0) return src;
      from = idx + 1;
    }
    return src.slice(0, idx) + repl + src.slice(idx + String(target).length);
  },
  replace_all: (s: string, target: string, repl: string) => String(s).split(String(target)).join(String(repl)),
  split: (s: string, sep: string) => String(s).split(String(sep)),
  upper: (s: string) => String(s).toUpperCase(),
  lower: (s: string) => String(s).toLowerCase(),
  trim: (s: string) => String(s).trim(),
  repeat: (s: string, n: number, sep = '') => Array.from({ length: Math.max(0, n) }, () => s).join(sep),
  match: (s: string, regex: string) => {
    const m = new RegExp(regex).exec(String(s));
    return m ? m[0] : '';
  },
};

// ---------------------------------------------------------------- colors (#RRGGBBAA strings)

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

export function parseColor(c: string | null): [number, number, number, number] | null {
  if (!c) return null;
  if (c.startsWith('#')) {
    const h = c.slice(1);
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

function toHex(r: number, g: number, b: number, a: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`;
}

export const COLORS: Record<string, string> = {
  aqua: '#00BCD4ff',
  black: '#363A45ff',
  blue: '#2196F3ff',
  fuchsia: '#E040FBff',
  gray: '#787B86ff',
  green: '#4CAF50ff',
  lime: '#00E676ff',
  maroon: '#880E4Fff',
  navy: '#311B92ff',
  olive: '#808000ff',
  orange: '#FF9800ff',
  purple: '#9C27B0ff',
  red: '#F23645ff',
  silver: '#B2B5BEff',
  teal: '#089981ff',
  white: '#FFFFFFff',
  yellow: '#FFEB3Bff',
};

export const color = {
  new: (c: string | null, transp: number) => {
    const p = parseColor(c);
    if (!p || isNa(transp)) return c;
    return toHex(p[0], p[1], p[2], 1 - Math.max(0, Math.min(100, transp)) / 100);
  },
  rgb: (r: number, g: number, b: number, transp = 0) => toHex(r, g, b, 1 - transp / 100),
  r: (c: string) => parseColor(c)?.[0] ?? NA,
  g: (c: string) => parseColor(c)?.[1] ?? NA,
  b: (c: string) => parseColor(c)?.[2] ?? NA,
  t: (c: string) => {
    const p = parseColor(c);
    return p ? Math.round((1 - p[3]) * 100) : NA;
  },
  from_gradient: (value: number, bottom: number, top: number, c1: string, c2: string) => {
    const a = parseColor(c1);
    const b = parseColor(c2);
    if (!a || !b || isNa(value)) return null;
    const f = Math.max(0, Math.min(1, (value - bottom) / (top - bottom || 1)));
    return toHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
  },
};

/** Convert Pine color to CSS rgba for the chart. */
export function cssColor(c: string | null | undefined): string | null {
  const p = parseColor(c ?? null);
  if (!p) return null;
  return p[3] >= 1 ? `rgb(${p[0]},${p[1]},${p[2]})` : `rgba(${p[0]},${p[1]},${p[2]},${+p[3].toFixed(3)})`;
}

// ---------------------------------------------------------------- arrays

function chk(a: unknown[], i: number, rt?: Runtime): number {
  const n = a.length;
  const j = i < 0 ? n + i : i;
  if (j < 0 || j >= n || !Number.isInteger(j)) {
    const msg = `Index ${i} is out of bounds. Array size is ${n}.`;
    if (rt) rt.error(msg);
    throw new Error(msg);
  }
  return j;
}

export const array = {
  new: (size = 0, initial: unknown = NaN) => Array.from({ length: Math.max(0, size) }, () => initial),
  from: (...xs: unknown[]) => xs,
  copy: (a: unknown[]) => a.slice(),
  size: (a: unknown[]) => (a ? a.length : NA),
  get: (rt: Runtime, a: unknown[], i: number) => a[chk(a, i, rt)],
  set: (rt: Runtime, a: unknown[], i: number, v: unknown) => {
    a[chk(a, i, rt)] = v;
  },
  push: (a: unknown[], v: unknown) => {
    a.push(v);
  },
  pop: (a: unknown[]) => a.pop(),
  shift: (a: unknown[]) => a.shift(),
  unshift: (a: unknown[], v: unknown) => {
    a.unshift(v);
  },
  insert: (a: unknown[], i: number, v: unknown) => {
    a.splice(i, 0, v);
  },
  remove: (rt: Runtime, a: unknown[], i: number) => a.splice(chk(a, i, rt), 1)[0],
  clear: (a: unknown[]) => {
    a.length = 0;
  },
  concat: (a: unknown[], b: unknown[]) => {
    a.push(...b);
    return a;
  },
  fill: (a: unknown[], v: unknown, from = 0, to?: number) => {
    a.fill(v, from, to);
  },
  first: (rt: Runtime, a: unknown[]) => a[chk(a, 0, rt)],
  last: (rt: Runtime, a: unknown[]) => a[chk(a, -1, rt)],
  includes: (a: unknown[], v: unknown) => a.includes(v),
  indexof: (a: unknown[], v: unknown) => a.indexOf(v),
  lastindexof: (a: unknown[], v: unknown) => a.lastIndexOf(v),
  join: (rt: Runtime, a: unknown[], sep = ',') => a.map((x) => str.tostring(rt, x)).join(sep),
  reverse: (a: unknown[]) => {
    a.reverse();
  },
  slice: (a: unknown[], from: number, to?: number) => a.slice(from, to),
  sort: (a: unknown[], order: string = 'ascending') => {
    a.sort((x: any, y: any) => (order === 'descending' ? (y > x ? 1 : y < x ? -1 : 0) : x > y ? 1 : x < y ? -1 : 0));
  },
  sort_indices: (a: unknown[], order: string = 'ascending') => a.map((_, i) => i).sort((i, j) => ((a[i] as number) - (a[j] as number)) * (order === 'descending' ? -1 : 1)),
  sum: (a: number[]) => a.reduce((s, x) => s + x, 0),
  avg: (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NA),
  min: (a: number[], nth = 0) => (a.length ? a.slice().sort((x, y) => x - y)[nth] : NA),
  max: (a: number[], nth = 0) => (a.length ? a.slice().sort((x, y) => y - x)[nth] : NA),
  range: (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : NA),
  median: (a: number[]) => {
    if (!a.length) return NA;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  mode: (a: number[]) => {
    const c = new Map<number, number>();
    let best = NA;
    let bc = 0;
    for (const x of a) {
      const n = (c.get(x) || 0) + 1;
      c.set(x, n);
      if (n > bc || (n === bc && x < best)) {
        bc = n;
        best = x;
      }
    }
    return best;
  },
  stdev: (a: number[], biased = true) => {
    if (!a.length) return NA;
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (biased ? a.length : Math.max(1, a.length - 1));
    return Math.sqrt(v);
  },
  variance: (a: number[], biased = true) => {
    if (!a.length) return NA;
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (biased ? a.length : Math.max(1, a.length - 1));
  },
  covariance: (a: number[], b: number[], biased = true) => {
    const n = Math.min(a.length, b.length);
    if (!n) return NA;
    const ma = a.reduce((s, x) => s + x, 0) / n;
    const mb = b.reduce((s, x) => s + x, 0) / n;
    let c = 0;
    for (let i = 0; i < n; i++) c += (a[i] - ma) * (b[i] - mb);
    return c / (biased ? n : Math.max(1, n - 1));
  },
  abs: (a: number[]) => a.map(Math.abs),
  percentrank: (a: number[], i: number) => {
    const v = a[i];
    return (a.filter((x) => x <= v).length - 1) / Math.max(1, a.length - 1) * 100;
  },
  percentile_linear_interpolation: (a: number[], p: number) => {
    if (!a.length) return NA;
    const s = a.slice().sort((x, y) => x - y);
    const pos = (p / 100) * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  },
  percentile_nearest_rank: (a: number[], p: number) => {
    if (!a.length) return NA;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  },
  standardize: (a: number[]) => {
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
    return a.map((x) => (sd ? (x - m) / sd : 0));
  },
  binary_search: (a: number[], v: number) => {
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m] === v) return m;
      if (a[m] < v) lo = m + 1;
      else hi = m - 1;
    }
    return -1;
  },
  every: (a: unknown[]) => a.every((x) => !!x),
  some: (a: unknown[]) => a.some((x) => !!x),
};

// ---------------------------------------------------------------- maps

export const map = {
  new: () => new Map<unknown, unknown>(),
  put: (m: Map<unknown, unknown>, k: unknown, v: unknown) => {
    const prev = m.get(k);
    m.set(k, v);
    return prev === undefined ? null : prev;
  },
  get: (m: Map<unknown, unknown>, k: unknown) => {
    const v = m.get(k);
    return v === undefined ? null : v;
  },
  contains: (m: Map<unknown, unknown>, k: unknown) => m.has(k),
  remove: (m: Map<unknown, unknown>, k: unknown) => {
    const v = m.get(k);
    m.delete(k);
    return v === undefined ? null : v;
  },
  size: (m: Map<unknown, unknown>) => m.size,
  keys: (m: Map<unknown, unknown>) => [...m.keys()],
  values: (m: Map<unknown, unknown>) => [...m.values()],
  clear: (m: Map<unknown, unknown>) => m.clear(),
  copy: (m: Map<unknown, unknown>) => new Map(m),
  put_all: (m: Map<unknown, unknown>, o: Map<unknown, unknown>) => {
    for (const [k, v] of o) m.set(k, v);
  },
};

// ---------------------------------------------------------------- time

function partsTz(t: number, tz?: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT+0' || tz === 'UTC+0') {
    const d = new Date(t);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() + 1 };
  }
  const m = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
  if (m) {
    const off = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0)) * 60000;
    return partsTz(t + off);
  }
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) + 1;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd };
}

export const time = {
  year: (t: number, tz?: string) => partsTz(t, tz).y,
  month: (t: number, tz?: string) => partsTz(t, tz).mo,
  dayofmonth: (t: number, tz?: string) => partsTz(t, tz).d,
  dayofweek: (t: number, tz?: string) => partsTz(t, tz).wd,
  hour: (t: number, tz?: string) => partsTz(t, tz).h,
  minute: (t: number, tz?: string) => partsTz(t, tz).mi,
  second: (t: number, tz?: string) => partsTz(t, tz).s,
  weekofyear: (t: number) => {
    const d = new Date(t);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((t - start) / 86400000 + new Date(start).getUTCDay() + 1) / 7);
  },
  timestamp: (...a: unknown[]) => {
    // timestamp(year, month, day, hour, minute, second) | timestamp(tz, year, ...) | timestamp(dateString)
    if (a.length === 1 && typeof a[0] === 'string') return Date.parse(a[0] as string);
    let args = a as number[];
    if (typeof a[0] === 'string') args = a.slice(1) as number[];
    const [y, mo, d = 1, h = 0, mi = 0, s = 0] = args;
    return Date.UTC(y, mo - 1, d, h, mi, s);
  },
};

// ---------------------------------------------------------------- drawings

function gc<T extends { deleted: boolean }>(list: T[], max: number): void {
  let alive = list.filter((x) => !x.deleted).length;
  for (let k = 0; k < list.length && alive > max; k++) {
    if (!list[k].deleted) {
      list[k].deleted = true;
      alive--;
    }
  }
  if (list.length > max * 4) {
    const keep = list.filter((x) => !x.deleted);
    list.length = 0;
    list.push(...keep);
  }
}

export const label = {
  new: (rt: Runtime, x: number, y: number, text = '', xloc = 'bar_index', yloc = 'price', clr: string | null = '#2196F3ff', style = 'label_down', textcolor: string | null = '#FFFFFFff', size = 'normal', _textalign?: string, tooltip = '') => {
    const l: LabelObj = { id: rt.objSeq++, x, y, xloc, yloc, text: String(text ?? ''), color: clr, textcolor, style, size, tooltip, deleted: false, bar: rt.i };
    rt.labels.push(l);
    gc(rt.labels, rt.maxLabels);
    return l;
  },
  delete: (l: LabelObj | null) => {
    if (l) l.deleted = true;
  },
  copy: (rt: Runtime, l: LabelObj | null) => {
    if (!l) return null;
    const c = { ...l, id: rt.objSeq++, bar: rt.i };
    rt.labels.push(c);
    gc(rt.labels, rt.maxLabels);
    return c;
  },
  set_x: (l: LabelObj | null, v: number) => l && (l.x = v),
  set_y: (l: LabelObj | null, v: number) => l && (l.y = v),
  set_xy: (l: LabelObj | null, x: number, y: number) => l && ((l.x = x), (l.y = y)),
  set_text: (l: LabelObj | null, v: string) => l && (l.text = String(v)),
  set_color: (l: LabelObj | null, v: string) => l && (l.color = v),
  set_textcolor: (l: LabelObj | null, v: string) => l && (l.textcolor = v),
  set_style: (l: LabelObj | null, v: string) => l && (l.style = v),
  set_size: (l: LabelObj | null, v: string) => l && (l.size = v),
  set_yloc: (l: LabelObj | null, v: string) => l && (l.yloc = v),
  set_xloc: (l: LabelObj | null, x: number, xloc: string) => l && ((l.x = x), (l.xloc = xloc)),
  set_tooltip: (l: LabelObj | null, v: string) => l && (l.tooltip = v),
  set_textalign: () => {},
  get_x: (l: LabelObj | null) => (l ? l.x : NA),
  get_y: (l: LabelObj | null) => (l ? l.y : NA),
  get_text: (l: LabelObj | null) => (l ? l.text : null),
};

export const line = {
  new: (rt: Runtime, x1: number, y1: number, x2: number, y2: number, xloc = 'bar_index', extend = 'none', clr: string | null = '#2196F3ff', style = 'solid', width = 1) => {
    const l: LineObj = { id: rt.objSeq++, x1, y1, x2, y2, xloc, extend, color: clr, style, width, deleted: false, bar: rt.i };
    rt.lines.push(l);
    gc(rt.lines, rt.maxLines);
    return l;
  },
  delete: (l: LineObj | null) => {
    if (l) l.deleted = true;
  },
  copy: (rt: Runtime, l: LineObj | null) => {
    if (!l) return null;
    const c = { ...l, id: rt.objSeq++, bar: rt.i };
    rt.lines.push(c);
    gc(rt.lines, rt.maxLines);
    return c;
  },
  set_x1: (l: LineObj | null, v: number) => l && (l.x1 = v),
  set_x2: (l: LineObj | null, v: number) => l && (l.x2 = v),
  set_y1: (l: LineObj | null, v: number) => l && (l.y1 = v),
  set_y2: (l: LineObj | null, v: number) => l && (l.y2 = v),
  set_xy1: (l: LineObj | null, x: number, y: number) => l && ((l.x1 = x), (l.y1 = y)),
  set_xy2: (l: LineObj | null, x: number, y: number) => l && ((l.x2 = x), (l.y2 = y)),
  set_color: (l: LineObj | null, v: string) => l && (l.color = v),
  set_style: (l: LineObj | null, v: string) => l && (l.style = v),
  set_width: (l: LineObj | null, v: number) => l && (l.width = v),
  set_extend: (l: LineObj | null, v: string) => l && (l.extend = v),
  get_x1: (l: LineObj | null) => (l ? l.x1 : NA),
  get_x2: (l: LineObj | null) => (l ? l.x2 : NA),
  get_y1: (l: LineObj | null) => (l ? l.y1 : NA),
  get_y2: (l: LineObj | null) => (l ? l.y2 : NA),
  get_price: (l: LineObj | null, x: number) => (l && l.x2 !== l.x1 ? l.y1 + ((l.y2 - l.y1) * (x - l.x1)) / (l.x2 - l.x1) : NA),
};

export const box = {
  new: (rt: Runtime, left: number, top: number, right: number, bottom: number, border: string | null = '#2196F3ff', borderWidth = 1, borderStyle = 'solid', extend = 'none', xloc = 'bar_index', bg: string | null = '#2196F333', text = '', _textSize?: string, textColor: string | null = '#000000ff') => {
    const b: BoxObj = { id: rt.objSeq++, left, top, right, bottom, xloc, border, bg, borderWidth, borderStyle, extend, text: String(text ?? ''), textColor, deleted: false, bar: rt.i };
    rt.boxes.push(b);
    gc(rt.boxes, rt.maxBoxes);
    return b;
  },
  delete: (b: BoxObj | null) => {
    if (b) b.deleted = true;
  },
  set_left: (b: BoxObj | null, v: number) => b && (b.left = v),
  set_right: (b: BoxObj | null, v: number) => b && (b.right = v),
  set_top: (b: BoxObj | null, v: number) => b && (b.top = v),
  set_bottom: (b: BoxObj | null, v: number) => b && (b.bottom = v),
  set_lefttop: (b: BoxObj | null, l: number, t: number) => b && ((b.left = l), (b.top = t)),
  set_rightbottom: (b: BoxObj | null, r: number, bt: number) => b && ((b.right = r), (b.bottom = bt)),
  set_border_color: (b: BoxObj | null, v: string) => b && (b.border = v),
  set_bgcolor: (b: BoxObj | null, v: string) => b && (b.bg = v),
  set_text: (b: BoxObj | null, v: string) => b && (b.text = String(v)),
  set_extend: (b: BoxObj | null, v: string) => b && (b.extend = v),
  get_left: (b: BoxObj | null) => (b ? b.left : NA),
  get_right: (b: BoxObj | null) => (b ? b.right : NA),
  get_top: (b: BoxObj | null) => (b ? b.top : NA),
  get_bottom: (b: BoxObj | null) => (b ? b.bottom : NA),
};

export const table = {
  new: (rt: Runtime, position: string, columns: number, rows: number, bg: string | null = null, frame: string | null = null, _fw?: number, border: string | null = null) => {
    const t: TableObj = { id: rt.objSeq++, position, cols: columns, rows, bg, frame, border, cells: new Map(), deleted: false };
    rt.tables.push(t);
    return t;
  },
  cell: (t: TableObj | null, col: number, row: number, text = '', _w?: number, _h?: number, textColor: string | null = null, _ha?: string, _va?: string, _size?: string, bg: string | null = null) => {
    if (t) t.cells.set(`${col},${row}`, { text: String(text ?? ''), color: textColor, bg });
  },
  cell_set_text: (t: TableObj | null, col: number, row: number, text: string) => {
    if (!t) return;
    const c = t.cells.get(`${col},${row}`) || { text: '', color: null, bg: null };
    c.text = String(text);
    t.cells.set(`${col},${row}`, c);
  },
  cell_set_bgcolor: (t: TableObj | null, col: number, row: number, bg: string) => {
    if (!t) return;
    const c = t.cells.get(`${col},${row}`) || { text: '', color: null, bg: null };
    c.bg = bg;
    t.cells.set(`${col},${row}`, c);
  },
  cell_set_text_color: (t: TableObj | null, col: number, row: number, clr: string) => {
    if (!t) return;
    const c = t.cells.get(`${col},${row}`) || { text: '', color: null, bg: null };
    c.color = clr;
    t.cells.set(`${col},${row}`, c);
  },
  clear: (t: TableObj | null) => t?.cells.clear(),
  delete: (t: TableObj | null) => {
    if (t) t.deleted = true;
  },
};

// ---------------------------------------------------------------- logs & alerts

export const log = {
  info: (rt: Runtime, fmt: string, ...args: unknown[]) => rt.logs.push({ bar: rt.i, time: rt.d.t[rt.i], level: 'info', msg: args.length ? str.format(rt, fmt, ...args) : str.tostring(rt, fmt) }),
  warning: (rt: Runtime, fmt: string, ...args: unknown[]) => rt.logs.push({ bar: rt.i, time: rt.d.t[rt.i], level: 'warning', msg: args.length ? str.format(rt, fmt, ...args) : str.tostring(rt, fmt) }),
  error: (rt: Runtime, fmt: string, ...args: unknown[]) => rt.logs.push({ bar: rt.i, time: rt.d.t[rt.i], level: 'error', msg: args.length ? str.format(rt, fmt, ...args) : str.tostring(rt, fmt) }),
};

export function alert(rt: Runtime, message: string): void {
  if (rt.logs.length > 100000) return;
  rt.alertEvents.push({ bar: rt.i, time: rt.d.t[rt.i], message: String(message) });
}
