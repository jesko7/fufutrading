/**
 * Binance USDⓈ-M futures statistics as data series: open interest and long/short ratios,
 * measured every 5 minutes. Scripts request them like TradingView's open interest symbols,
 * e.g. request.security("BINANCE:BTCUSDT.P_OI", "60", close).
 *
 * Sources: the /futures/data REST endpoints for the last 30 days (Binance keeps no more there)
 * and the data.binance.vision daily "metrics" archives before that. Raw samples are stored like
 * candles (packed STRIDE layout), one value per slot:
 *   t   measurement time (the REST timestamp; archive rows are labelled 5 minutes earlier)
 *   o   open interest in contracts (base asset)
 *   h   open interest value (USDT)
 *   l   top traders' long/short account ratio
 *   c   top traders' long/short position ratio
 *   v   long/short account ratio of all accounts
 *
 * Binance publishes a sample 2–3 minutes after measuring it, so every sample counts from the
 * next 5-minute mark: a value measured at 12:00 closes the bar that ends at 12:05. Backtests,
 * replays and live bots therefore see the same values at the same times, without lookahead.
 * (The live /fapi/v1/openInterest value differs from the sampled history by a few tenths of a
 * percent, so it is not mixed in.)
 *
 * Funding rates (BINANCE:BTCUSDT.P_FUNDING) come from the funding history instead: one value per
 * settlement (every 8 hours for BTC, ETH and SOL) in % of the position, usable at the settlement.
 */
import { CandleSeries } from './candles';
import { bucketStart, type Timeframe } from './timeframes';

export type MetricKind = 'oi' | 'oiusd' | 'lsr' | 'toplsr' | 'toppos' | 'funding';

export interface MetricInfo {
  /** Ticker suffix: BINANCE:BTCUSDT.P<suffix>. */
  suffix: string;
  /** The raw sample column (CandleSeries slot). */
  slot: 'o' | 'h' | 'l' | 'c' | 'v';
  title: string;
  /** Binance's 5-minute statistics or the funding history. */
  source: 'stats' | 'funding';
  /** A sample can be used this long after its time. */
  delayMs: number;
  /** Usual distance between samples. */
  stepMs: number;
  /** Values may be zero or negative (funding); the statistics are positive. */
  signed: boolean;
  /** First data Binance has. */
  epoch: number;
}

/** Sampling interval of the statistics, and the delay after which a sample may be used. */
export const METRIC_STEP = 5 * 60_000;
/** First daily metrics archive on data.binance.vision. */
export const METRICS_EPOCH = Date.UTC(2020, 8, 1);
/** Funding of the USDⓈ-M perpetuals (BTCUSDT launched in September 2019). */
export const FUNDING_EPOCH = Date.UTC(2019, 8, 1);

const STAT = { source: 'stats', delayMs: METRIC_STEP, stepMs: METRIC_STEP, signed: false, epoch: METRICS_EPOCH } as const;

export const METRICS: Record<MetricKind, MetricInfo> = {
  oi: { suffix: '_OI', slot: 'o', title: 'Open interest (contracts)', ...STAT },
  oiusd: { suffix: '_OI_USD', slot: 'h', title: 'Open interest value (USDT)', ...STAT },
  lsr: { suffix: '_LSR', slot: 'v', title: 'Long/short account ratio (all accounts)', ...STAT },
  toplsr: { suffix: '_TOP_LSR', slot: 'l', title: 'Long/short account ratio (top traders)', ...STAT },
  toppos: { suffix: '_TOP_POS', slot: 'c', title: 'Long/short position ratio (top traders)', ...STAT },
  funding: { suffix: '_FUNDING', slot: 'o', title: 'Funding rate (% per funding interval)', source: 'funding', delayMs: 0, stepMs: 8 * 3_600_000, signed: true, epoch: FUNDING_EPOCH },
};

export const METRIC_KINDS = Object.keys(METRICS) as MetricKind[];

export function isMetric(x: unknown): x is MetricKind {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(METRICS, x);
}

/** Split a metric suffix off a ticker ("BTCUSDT.P_OI" → ["BTCUSDT.P", "oi"]); the longest suffix wins. */
export function splitMetricSuffix(ticker: string): [string, MetricKind | null] {
  const up = ticker.toUpperCase();
  let best: MetricKind | null = null;
  for (const k of METRIC_KINDS) if (up.endsWith(METRICS[k].suffix) && (!best || METRICS[k].suffix.length > METRICS[best].suffix.length)) best = k;
  return best ? [ticker.slice(0, ticker.length - METRICS[best].suffix.length), best] : [ticker, null];
}

/** When a sample of `kind` with time `t` may be used. */
export function metricAvailableAt(kind: MetricKind, t: number): number {
  return t + METRICS[kind].delayMs;
}

/**
 * Fold one value, usable from `vt`, into the bars: it closes the bar (start, end] that contains
 * vt; a new bar opens at the previous close. Returns the index of the changed bar.
 */
export function appendMetric(bars: CandleSeries, tf: Timeframe, vt: number, x: number, signed = false): number {
  const n = bars.length;
  if (signed ? !Number.isFinite(x) : !(x > 0)) return n;
  const s = bucketStart(tf, vt - 1);
  if (n && bars.t[n - 1] === s) {
    if (x > bars.h[n - 1]) bars.h[n - 1] = x;
    if (x < bars.l[n - 1]) bars.l[n - 1] = x;
    bars.c[n - 1] = x;
    return n - 1;
  }
  if (n && bars.t[n - 1] > s) return n;
  const o = n ? bars.c[n - 1] : x;
  bars.push(s, o, Math.max(o, x), Math.min(o, x), x);
  return n;
}

/**
 * Reveal raw samples from index `from` that are usable by `upTo` into the bars. Returns the next
 * unrevealed sample and the first changed bar (bars.length when nothing changed).
 */
export function revealMetric(raw: CandleSeries, kind: MetricKind, tf: Timeframe, bars: CandleSeries, from: number, upTo = Infinity): { next: number; first: number } {
  const m = METRICS[kind];
  const col = raw[m.slot];
  let first = bars.length;
  let i = from;
  for (; i < raw.length; i++) {
    const vt = raw.t[i] + m.delayMs;
    if (vt > upTo) break;
    first = Math.min(first, appendMetric(bars, tf, vt, col[i], m.signed));
  }
  return { next: i, first };
}

/** OHLC bars of one statistic (bars without samples are left out, like klines without trades). */
export function metricBars(raw: CandleSeries, kind: MetricKind, tf: Timeframe, upTo = Infinity): CandleSeries {
  const out = new CandleSeries(Math.max(16, Math.min(raw.length, 4096)));
  revealMetric(raw, kind, tf, out, 0, upTo);
  return out;
}

/**
 * Funding events (time, rate as a fraction) as raw samples: the rate in % in slot `o`, the time
 * rounded down to the second (Binance stamps settlements a few milliseconds after the hour).
 */
export function fundingSamples(t: ArrayLike<number>, rate: ArrayLike<number>): CandleSeries {
  const s = new CandleSeries(t.length);
  for (let i = 0; i < t.length; i++) {
    const ts = Math.floor(t[i] / 1000) * 1000;
    const r = rate[i] * 100;
    if (!Number.isFinite(r)) continue;
    if (s.length && s.t[s.length - 1] >= ts) continue;
    s.push(ts, r, r, r, r);
  }
  return s;
}

/** Parse a data.binance.vision daily metrics CSV into raw samples (sorted, unique, measurement times). */
export function parseMetricsCsv(csv: string): CandleSeries {
  // create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,
  // sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio
  const rows: [number, number, number, number, number, number][] = [];
  const num = (s: string | undefined) => {
    const v = s === undefined || s === '' ? NaN : +s;
    return v > 0 ? v : NaN;
  };
  for (const line of csv.split('\n')) {
    const c0 = line.charCodeAt(0);
    if (!(c0 >= 48 && c0 <= 57)) continue;
    const p = line.split(',');
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(p[0]);
    if (!m) continue;
    // archive rows are labelled with the start of the 5-minute period, REST with its end (the measurement)
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + METRIC_STEP;
    rows.push([t, num(p[2]), num(p[3]), num(p[4]), num(p[5]), num(p[6])]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const s = new CandleSeries(rows.length);
  for (const r of rows) {
    if (s.length && s.t[s.length - 1] === r[0]) continue;
    s.push(r[0], r[1], r[2], r[3], r[4], r[5]);
  }
  return s;
}
