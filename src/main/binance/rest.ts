/**
 * Binance REST client (public market data only — no API keys, no real orders).
 *
 * - Spot host rotation (api.binance.com → data-api.binance.vision → api1/api2) for regions
 *   where one endpoint is blocked or slow.
 * - Weight-aware throttling using X-MBX-USED-WEIGHT-1M, honours 429/418 Retry-After.
 * - Bounded concurrency per market.
 * - Bulk archive downloads from data.binance.vision (monthly/daily zips) for large ranges.
 */
import { unzipSync } from 'fflate';
import { CandleSeries } from '../../shared/candles';
import type { Market, SymbolId } from '../../shared/symbols';
import type { TradeTick } from '../../shared/live';
import { parseMetricsCsv } from '../../shared/metrics';

const SPOT_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com', 'https://api2.binance.com'];
const FUT_HOST = 'https://fapi.binance.com';
const BULK_HOST = 'https://data.binance.vision';
const OPTIONS_HOST = 'https://eapi.binance.com';

const WEIGHT_LIMIT: Record<Market, number> = { spot: 6000, futures: 2400 };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
  }
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseKlineRows(rows: unknown[][]): CandleSeries {
  const s = new CandleSeries(rows.length);
  for (const r of rows) {
    s.push(+(r[0] as number), +(r[1] as string), +(r[2] as string), +(r[3] as string), +(r[4] as string), +(r[5] as string), +(r[7] as string), +(r[8] as number), +(r[9] as string));
  }
  return s;
}

export class BinanceRest {
  private spotHostIdx = 0;
  private usedWeight: Record<Market, number> = { spot: 0, futures: 0 };
  private weightResetAt: Record<Market, number> = { spot: 0, futures: 0 };
  private bannedUntil: Record<Market, number> = { spot: 0, futures: 0 };
  private limiters: Record<Market, Limiter> = { spot: new Limiter(6), futures: new Limiter(5) };
  private bulkLimiter = new Limiter(4);
  private optionsLimiter = new Limiter(4);
  private optionsWeight = 0;
  private optionsWeightResetAt = 0;
  private optionsBannedUntil = 0;
  /** Small daily archives (futures metrics, ~10 KB): latency bound, so more in parallel. */
  private smallLimiter = new Limiter(20);
  public requestCount = 0;

  constructor(private log: Logger = () => {}) {}

  private host(market: Market): string {
    return market === 'spot' ? SPOT_HOSTS[this.spotHostIdx] : FUT_HOST;
  }

  /** Share of the per-minute request weight used in the current minute (0..1). */
  weightShare(market: Market): number {
    return Date.now() < this.weightResetAt[market] ? this.usedWeight[market] / WEIGHT_LIMIT[market] : 0;
  }

  /** Low-level GET with retries, throttling and host rotation. */
  async get<T = unknown>(market: Market, pathname: string, params: Record<string, string | number | undefined> = {}, weight = 1): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.limiters[market].run(async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const now = Date.now();
        if (this.bannedUntil[market] > now) await sleep(this.bannedUntil[market] - now);
        // proactive throttle near the per-minute weight limit
        if (now < this.weightResetAt[market] && this.usedWeight[market] + weight > WEIGHT_LIMIT[market] * 0.85) {
          await sleep(Math.max(250, this.weightResetAt[market] - now));
        }
        const url = `${this.host(market)}${pathname}${qs ? `?${qs}` : ''}`;
        try {
          this.requestCount++;
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          const uw = res.headers.get('x-mbx-used-weight-1m') ?? res.headers.get('x-mbx-used-weight');
          if (uw) {
            this.usedWeight[market] = parseInt(uw, 10) || 0;
            const n = Date.now();
            this.weightResetAt[market] = n - (n % 60000) + 60000;
          }
          if (res.status === 429 || res.status === 418) {
            const ra = parseInt(res.headers.get('retry-after') || '0', 10);
            const wait = Math.max(ra * 1000, res.status === 418 ? 120000 : 5000);
            this.bannedUntil[market] = Date.now() + wait;
            this.log('warn', `Binance ${market} rate limited (${res.status}); backing off ${Math.round(wait / 1000)}s`);
            if (attempt < 6) continue;
          }
          if (res.status === 451 || res.status === 403) {
            if (market === 'spot' && attempt < SPOT_HOSTS.length + 1) {
              this.spotHostIdx = (this.spotHostIdx + 1) % SPOT_HOSTS.length;
              this.log('warn', `Spot host blocked (${res.status}); switching to ${this.host('spot')}`);
              continue;
            }
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            if (res.status >= 500 && attempt < 5) {
              await sleep(500 * attempt);
              continue;
            }
            throw new HttpError(res.status, `HTTP ${res.status} ${pathname}: ${body.slice(0, 200)}`, body);
          }
          return (await res.json()) as T;
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (attempt >= 5) throw e;
          if (market === 'spot') this.spotHostIdx = (this.spotHostIdx + 1) % SPOT_HOSTS.length;
          await sleep(400 * attempt + Math.random() * 300);
        }
      }
    });
  }

  // ------------------------------------------------------------------ market data

  async klines(market: Market, symbol: SymbolId, interval: string, opts: { startTime?: number; endTime?: number; limit?: number }): Promise<CandleSeries> {
    const limit = opts.limit ?? (market === 'spot' ? 1000 : 1500);
    const path = market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
    const weight = market === 'spot' ? 2 : limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10;
    const rows = await this.get<unknown[][]>(market, path, { symbol, interval, startTime: opts.startTime, endTime: opts.endTime, limit }, weight);
    return parseKlineRows(rows);
  }

  /** Mark price klines (futures only). Volume fields are zero. */
  async markPriceKlines(symbol: SymbolId, interval: string, opts: { startTime?: number; endTime?: number; limit?: number }): Promise<CandleSeries> {
    const limit = opts.limit ?? 1500;
    const rows = await this.get<unknown[][]>('futures', '/fapi/v1/markPriceKlines', { symbol, interval, startTime: opts.startTime, endTime: opts.endTime, limit }, limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10);
    return parseKlineRows(rows);
  }

  async aggTrades(market: Market, symbol: SymbolId, opts: { fromId?: number; startTime?: number; endTime?: number; limit?: number }): Promise<TradeTick[]> {
    const path = market === 'spot' ? '/api/v3/aggTrades' : '/fapi/v1/aggTrades';
    const rows = await this.get<{ a: number; p: string; q: string; T: number; m: boolean }[]>(
      market,
      path,
      { symbol, fromId: opts.fromId, startTime: opts.startTime, endTime: opts.endTime, limit: opts.limit ?? 1000 },
      market === 'spot' ? 4 : 20,
    );
    return rows.map((r) => ({ id: r.a, t: r.T, p: +r.p, q: +r.q, m: r.m }));
  }

  async depth(market: Market, symbol: SymbolId, limit: number): Promise<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }> {
    const path = market === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
    const weight = market === 'spot' ? (limit <= 100 ? 5 : limit <= 500 ? 25 : limit <= 1000 ? 50 : 250) : limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20;
    return this.get(market, path, { symbol, limit }, weight);
  }

  async ticker24h(market: Market, symbol: SymbolId): Promise<Record<string, string | number>> {
    return this.get(market, market === 'spot' ? '/api/v3/ticker/24hr' : '/fapi/v1/ticker/24hr', { symbol }, 2);
  }

  /**
   * Binance options (eapi.binance.com): public data of the USDT-margined European options.
   * Its own budget (400 weight a minute) and concurrency, separate from spot and futures.
   */
  async eapi<T = unknown>(pathname: string, params: Record<string, string | number | undefined> = {}, weight = 1): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.optionsLimiter.run(async () => {
      for (let attempt = 1; ; attempt++) {
        const now = Date.now();
        if (this.optionsBannedUntil > now) await sleep(this.optionsBannedUntil - now);
        if (now < this.optionsWeightResetAt && this.optionsWeight + weight > 400 * 0.85) await sleep(Math.max(250, this.optionsWeightResetAt - now));
        try {
          this.requestCount++;
          const res = await fetch(`${OPTIONS_HOST}${pathname}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(15000) });
          const uw = res.headers.get('x-mbx-used-weight-1m');
          if (uw) {
            this.optionsWeight = parseInt(uw, 10) || 0;
            const n = Date.now();
            this.optionsWeightResetAt = n - (n % 60000) + 60000;
          }
          if (res.status === 429 || res.status === 418) {
            const ra = parseInt(res.headers.get('retry-after') || '0', 10);
            const wait = Math.max(ra * 1000, res.status === 418 ? 120000 : 5000);
            this.optionsBannedUntil = Date.now() + wait;
            this.log('warn', `Binance options rate limited (${res.status}); backing off ${Math.round(wait / 1000)}s`);
            if (attempt < 4) continue;
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            if (res.status >= 500 && attempt < 4) {
              await sleep(500 * attempt);
              continue;
            }
            throw new HttpError(res.status, `HTTP ${res.status} ${pathname}: ${body.slice(0, 200)}`, body);
          }
          return (await res.json()) as T;
        } catch (e) {
          if (e instanceof HttpError || attempt >= 4) throw e;
          await sleep(400 * attempt + Math.random() * 300);
        }
      }
    });
  }

  async exchangeInfo(market: Market): Promise<any> {
    if (market === 'spot') return this.get('spot', '/api/v3/exchangeInfo', { symbols: JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) }, 20);
    return this.get('futures', '/fapi/v1/exchangeInfo', {}, 1);
  }

  async premiumIndex(symbol: SymbolId): Promise<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number; time: number; interestRate: string }> {
    return this.get('futures', '/fapi/v1/premiumIndex', { symbol }, 1);
  }

  async fundingRates(symbol: SymbolId, startTime?: number, endTime?: number, limit = 1000): Promise<{ t: number; rate: number; markPrice: number }[]> {
    const rows = await this.get<{ fundingTime: number; fundingRate: string; markPrice: string }[]>('futures', '/fapi/v1/fundingRate', { symbol, startTime, endTime, limit }, 1);
    return rows.map((r) => ({ t: r.fundingTime, rate: +r.fundingRate, markPrice: +r.markPrice || NaN }));
  }

  /**
   * Open interest and long/short ratios measured in [startTime, endTime) (5-minute samples, at
   * most 500; Binance serves the last 30 days only), in the layout of shared/metrics.
   */
  async futuresStats(symbol: SymbolId, startTime: number, endTime: number): Promise<CandleSeries> {
    type Row = Record<string, string | number>;
    const q = (name: string) => this.get<Row[]>('futures', `/futures/data/${name}`, { symbol, period: '5m', limit: 500, startTime, endTime: endTime - 1 }, 1);
    const [oi, topAcc, topPos, global] = await Promise.all([q('openInterestHist'), q('topLongShortAccountRatio'), q('topLongShortPositionRatio'), q('globalLongShortAccountRatio')]);
    const rows = new Map<number, number[]>();
    const put = (list: Row[], slot: number, key: string) => {
      for (const r of list) {
        const t = Number(r.timestamp);
        if (!(t >= startTime && t < endTime)) continue;
        let row = rows.get(t);
        if (!row) rows.set(t, (row = [NaN, NaN, NaN, NaN, NaN]));
        const v = Number(r[key]);
        row[slot] = v > 0 ? v : NaN;
      }
    };
    put(oi, 0, 'sumOpenInterest');
    put(oi, 1, 'sumOpenInterestValue');
    put(topAcc, 2, 'longShortRatio');
    put(topPos, 3, 'longShortRatio');
    put(global, 4, 'longShortRatio');
    const ts = [...rows.keys()].sort((a, b) => a - b);
    const s = new CandleSeries(ts.length);
    for (const t of ts) {
      const r = rows.get(t)!;
      s.push(t, r[0], r[1], r[2], r[3], r[4]);
    }
    return s;
  }

  async fundingInfo(): Promise<{ symbol: string; fundingIntervalHours: number }[]> {
    return this.get('futures', '/fapi/v1/fundingInfo', {}, 1);
  }

  /** Public leverage brackets (maintenance margin tiers) used by Binance's website. */
  async leverageBrackets(): Promise<any> {
    const res = await fetch('https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets', { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new HttpError(res.status, `brackets HTTP ${res.status}`);
    return res.json();
  }

  async serverTime(market: Market): Promise<number> {
    const r = await this.get<{ serverTime: number }>(market, market === 'spot' ? '/api/v3/time' : '/fapi/v1/time', {}, 1);
    return r.serverTime;
  }

  // ------------------------------------------------------------------ bulk archives

  private bulkUrl(market: Market, kind: string, period: 'monthly' | 'daily', symbol: SymbolId, interval: string | null, date: string): string {
    const base = market === 'spot' ? `${BULK_HOST}/data/spot/${period}/${kind}/${symbol}` : `${BULK_HOST}/data/futures/um/${period}/${kind}/${symbol}`;
    if (interval) return `${base}/${interval}/${symbol}-${interval}-${date}.zip`;
    return `${base}/${symbol}-${kind}-${date}.zip`;
  }

  /** Download and unzip one archive; returns CSV text or null if not published (404). */
  async fetchArchiveCsv(url: string, small = false): Promise<string | null> {
    return (small ? this.smallLimiter : this.bulkLimiter).run(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
          if (res.status === 404) return null;
          if (!res.ok) throw new HttpError(res.status, `archive HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          const files = unzipSync(buf);
          const name = Object.keys(files).find((n) => n.endsWith('.csv'));
          if (!name) return null;
          return new TextDecoder().decode(files[name]);
        } catch (e) {
          if (e instanceof HttpError && e.status < 500) throw e;
          if (attempt >= 3) throw e;
          await sleep(1000 * attempt);
        }
      }
    });
  }

  /** Klines from a monthly ("YYYY-MM") or daily ("YYYY-MM-DD") archive, or null if unavailable. */
  async archiveKlines(market: Market, symbol: SymbolId, interval: string, period: 'monthly' | 'daily', date: string, kind: 'klines' | 'markPriceKlines' = 'klines'): Promise<CandleSeries | null> {
    const csv = await this.fetchArchiveCsv(this.bulkUrl(market, kind, period, symbol, interval, date));
    if (csv === null) return null;
    return parseKlineCsv(csv);
  }

  /** Futures statistics (5-minute samples) of one UTC day from the daily metrics archive; empty if not published. */
  async archiveMetrics(symbol: SymbolId, date: string): Promise<CandleSeries> {
    const csv = await this.fetchArchiveCsv(`${BULK_HOST}/data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${date}.zip`, true);
    return csv === null ? new CandleSeries(1) : parseMetricsCsv(csv);
  }

  /** Aggregate trades for one UTC day from the daily archive (can be very large for BTC). */
  async archiveAggTrades(market: Market, symbol: SymbolId, date: string): Promise<TradeTick[] | null> {
    const csv = await this.fetchArchiveCsv(this.bulkUrl(market, 'aggTrades', 'daily', symbol, null, date));
    if (csv === null) return null;
    return parseAggTradeCsv(csv);
  }
}

/** Normalise archive timestamps (spot archives use microseconds from 2025-01-01). */
function normTs(x: number): number {
  return x > 1e14 ? Math.floor(x / 1000) : x;
}

export function parseKlineCsv(csv: string): CandleSeries {
  const lines = csv.split('\n');
  const s = new CandleSeries(lines.length);
  for (const line of lines) {
    if (!line || line.charCodeAt(0) < 48 || line.charCodeAt(0) > 57) continue; // header / blank
    const p = line.split(',');
    s.push(normTs(+p[0]), +p[1], +p[2], +p[3], +p[4], +p[5], +p[7], +p[8], +p[9]);
  }
  return s;
}

export function parseAggTradeCsv(csv: string): TradeTick[] {
  // agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker[,is_best_match]
  const out: TradeTick[] = [];
  let start = 0;
  const len = csv.length;
  while (start < len) {
    let end = csv.indexOf('\n', start);
    if (end < 0) end = len;
    const c0 = csv.charCodeAt(start);
    if (c0 >= 48 && c0 <= 57) {
      const p = csv.slice(start, end).split(',');
      out.push({ id: +p[0], p: +p[1], q: +p[2], t: normTs(+p[5]), m: p[6].trim().toLowerCase() === 'true' });
    }
    start = end + 1;
  }
  return out;
}
