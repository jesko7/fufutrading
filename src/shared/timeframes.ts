/**
 * Timeframes: parsing, formatting, bucket alignment and native-interval selection.
 *
 * Supported units: s (seconds), m (minutes), h (hours), D (days), W (weeks), M (months).
 * Arbitrary multiples are allowed ("30s", "7m", "90m", "5D", "2W", "3M").
 *
 * Alignment rules (consistent for history and live data):
 *  - Intraday intervals (< 1 day) are anchored to the UTC day start. If the interval divides
 *    the day this equals epoch alignment (and matches Binance). If it does not (e.g. 7m),
 *    the last bucket of each day is shorter — the same convention TradingView uses for
 *    24/7 crypto sessions.
 *  - Day multiples are epoch-day aligned; 3D uses Binance's offset (epochDay ≡ 1 mod 3).
 *  - Weeks start Monday 00:00 UTC (Binance 1w).
 *  - Months are calendar months (UTC); n-month buckets start at month indices divisible by n.
 */

import type { Market } from './symbols';

export type TfUnit = 's' | 'm' | 'h' | 'D' | 'W' | 'M';
export interface Timeframe {
  n: number;
  unit: TfUnit;
}

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

const UNIT_MS: Record<Exclude<TfUnit, 'M'>, number> = { s: SEC, m: MIN, h: HOUR, D: DAY, W: WEEK };

/** Binance kline intervals (string form used by the API). */
export const BINANCE_INTERVALS_SPOT = ['1s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export const BINANCE_INTERVALS_FUTURES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;

export const STANDARD_TIMEFRAMES = ['1s', '5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1D', '3D', '1W', '1M'];
export const QUICK_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'];

export function parseTimeframe(input: string): Timeframe | null {
  if (!input) return null;
  const s = input.trim();
  const m = /^(\d+)?\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|D|day|days|w|W|wk|weeks?|M|mo|mon|months?)$/.exec(s);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    if (!(n >= 1 && n <= 100000)) return null;
    const u = m[2];
    let unit: TfUnit;
    if (u === 'M' || u.startsWith('mo')) unit = 'M';
    else if (u === 'm' || u.startsWith('min')) unit = 'm';
    else if (u.startsWith('s')) unit = 's';
    else if (u.startsWith('h')) unit = 'h';
    else if (u === 'd' || u === 'D' || u.startsWith('day')) unit = 'D';
    else unit = 'W';
    return normalize({ n, unit });
  }
  // TradingView-style bare number = minutes ("5" -> 5m, "240" -> 4h)
  if (/^\d+$/.test(s)) return normalize({ n: parseInt(s, 10), unit: 'm' });
  return null;
}

/** Normalize to the largest exact unit (120m -> 2h, 60s -> 1m, 24h -> 1D). */
export function normalize(tf: Timeframe): Timeframe {
  if (tf.unit === 'M' || tf.unit === 'W') return tf;
  if (tf.unit === 'D') return tf; // keep day multiples as days (7D stays 7D, not 1W)
  const ms = tf.n * UNIT_MS[tf.unit];
  if (ms % DAY === 0) return { n: ms / DAY, unit: 'D' };
  if (ms % HOUR === 0) return { n: ms / HOUR, unit: 'h' };
  if (ms % MIN === 0) return { n: ms / MIN, unit: 'm' };
  return { n: ms / SEC, unit: 's' };
}

export function tfToString(tf: Timeframe): string {
  return `${tf.n}${tf.unit}`;
}

export function tfKey(input: string | Timeframe): string {
  const tf = typeof input === 'string' ? parseTimeframe(input) : input;
  if (!tf) throw new Error(`Invalid timeframe: ${input}`);
  return tfToString(tf);
}

export function tfLabel(input: string | Timeframe): string {
  const tf = typeof input === 'string' ? parseTimeframe(input) : input;
  if (!tf) return String(input);
  const names: Record<TfUnit, string> = { s: 's', m: 'm', h: 'h', D: 'D', W: 'W', M: 'M' };
  return `${tf.n}${names[tf.unit]}`;
}

export function tfLongLabel(input: string | Timeframe): string {
  const tf = typeof input === 'string' ? parseTimeframe(input) : input;
  if (!tf) return String(input);
  const names: Record<TfUnit, [string, string]> = {
    s: ['second', 'seconds'],
    m: ['minute', 'minutes'],
    h: ['hour', 'hours'],
    D: ['day', 'days'],
    W: ['week', 'weeks'],
    M: ['month', 'months'],
  };
  return `${tf.n} ${names[tf.unit][tf.n === 1 ? 0 : 1]}`;
}

/** Nominal duration in ms (months use 30.4375 days; only for estimates and spacing). */
export function tfDurationMs(tf: Timeframe): number {
  if (tf.unit === 'M') return tf.n * 30.4375 * DAY;
  return tf.n * UNIT_MS[tf.unit];
}

export function isFixedDuration(tf: Timeframe): boolean {
  return tf.unit !== 'M';
}

export function isIntraday(tf: Timeframe): boolean {
  return tf.unit === 's' || tf.unit === 'm' || tf.unit === 'h';
}

export function tfSeconds(tf: Timeframe): number {
  return Math.round(tfDurationMs(tf) / 1000);
}

function utcDayStart(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Start time (ms) of the bucket containing t. */
export function bucketStart(tf: Timeframe, t: number): number {
  switch (tf.unit) {
    case 's':
    case 'm':
    case 'h': {
      const d = tf.n * UNIT_MS[tf.unit];
      if (DAY % d === 0) return Math.floor(t / d) * d;
      if (d > DAY) return Math.floor(t / d) * d;
      const ds = utcDayStart(t);
      return ds + Math.floor((t - ds) / d) * d;
    }
    case 'D': {
      const day = Math.floor(t / DAY);
      const off = tf.n === 3 ? 1 : 0;
      return (Math.floor((day - off) / tf.n) * tf.n + off) * DAY;
    }
    case 'W': {
      const day = Math.floor(t / DAY);
      const span = 7 * tf.n;
      return (Math.floor((day - 4) / span) * span + 4) * DAY; // epoch day 4 = Monday 1970-01-05
    }
    case 'M': {
      const dt = new Date(t);
      const mi = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      const start = Math.floor(mi / tf.n) * tf.n;
      return Date.UTC(Math.floor(start / 12), start % 12, 1);
    }
  }
}

/** Exclusive end of the bucket that starts at `start`. */
export function bucketEnd(tf: Timeframe, start: number): number {
  switch (tf.unit) {
    case 's':
    case 'm':
    case 'h': {
      const d = tf.n * UNIT_MS[tf.unit];
      if (DAY % d === 0 || d > DAY) return start + d;
      const nextDay = utcDayStart(start) + DAY;
      return Math.min(start + d, nextDay);
    }
    case 'D':
      return start + tf.n * DAY;
    case 'W':
      return start + tf.n * WEEK;
    case 'M': {
      const dt = new Date(start);
      return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + tf.n, 1);
    }
  }
}

/** Binance interval string for a timeframe if it is natively provided, else null. */
export function nativeInterval(tf: Timeframe, market: Market): string | null {
  const list: readonly string[] = market === 'spot' ? BINANCE_INTERVALS_SPOT : BINANCE_INTERVALS_FUTURES;
  let s: string;
  switch (tf.unit) {
    case 's':
      s = `${tf.n}s`;
      break;
    case 'm':
      s = `${tf.n}m`;
      break;
    case 'h':
      s = `${tf.n}h`;
      break;
    case 'D':
      s = `${tf.n}d`;
      break;
    case 'W':
      s = `${tf.n}w`;
      break;
    case 'M':
      s = `${tf.n}M`;
      break;
  }
  return list.includes(s) ? s : null;
}

export function intervalToTf(interval: string): Timeframe {
  const m = /^(\d+)([smhdwM])$/.exec(interval);
  if (!m) throw new Error(`Bad interval ${interval}`);
  const n = parseInt(m[1], 10);
  const map: Record<string, TfUnit> = { s: 's', m: 'm', h: 'h', d: 'D', w: 'W', M: 'M' };
  return { n, unit: map[m[2]] };
}

export function intervalMs(interval: string): number {
  return tfDurationMs(intervalToTf(interval));
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * The native Binance interval used to build a timeframe. Returns the largest native interval
 * whose buckets nest exactly inside the timeframe's buckets. Returns null when no native
 * interval can build it (e.g. sub-minute timeframes on futures, which require trade data).
 */
export function baseIntervalFor(tf: Timeframe, market: Market): string | null {
  const native = nativeInterval(tf, market);
  if (native) return native;
  if (tf.unit === 'M') return '1M';
  if (tf.unit === 'W') return '1w';
  if (tf.unit === 'D') return '1d';
  // Intraday buckets restart at each UTC day (or are epoch aligned when > 1 day), so a native
  // interval nests iff it divides gcd(duration, 1 day).
  const g = gcd(tfDurationMs(tf), DAY);
  const candidates: [string, number][] = (
    market === 'spot'
      ? [['12h', 12 * HOUR], ['8h', 8 * HOUR], ['6h', 6 * HOUR], ['4h', 4 * HOUR], ['2h', 2 * HOUR], ['1h', HOUR], ['30m', 30 * MIN], ['15m', 15 * MIN], ['5m', 5 * MIN], ['3m', 3 * MIN], ['1m', MIN], ['1s', SEC]]
      : [['12h', 12 * HOUR], ['8h', 8 * HOUR], ['6h', 6 * HOUR], ['4h', 4 * HOUR], ['2h', 2 * HOUR], ['1h', HOUR], ['30m', 30 * MIN], ['15m', 15 * MIN], ['5m', 5 * MIN], ['3m', 3 * MIN], ['1m', MIN]]
  ) as [string, number][];
  for (const [iv, ms] of candidates) {
    if (g % ms === 0) return iv;
  }
  return null;
}

/** Iterate bucket starts in [from, to). */
export function* bucketsBetween(tf: Timeframe, from: number, to: number): Generator<number> {
  let b = bucketStart(tf, from);
  while (b < to) {
    yield b;
    b = bucketEnd(tf, b);
  }
}

/** Approximate start time of `count` bars before `end`. */
export function timeForBarsBack(tf: Timeframe, end: number, count: number): number {
  if (tf.unit === 'M') {
    const dt = new Date(end);
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() - count * tf.n, 1);
  }
  return bucketStart(tf, end - count * tfDurationMs(tf));
}

export function compareTimeframes(a: string, b: string): number {
  const ta = parseTimeframe(a);
  const tb = parseTimeframe(b);
  if (!ta || !tb) return 0;
  return tfDurationMs(ta) - tfDurationMs(tb);
}
