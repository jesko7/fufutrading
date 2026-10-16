/**
 * Historical funding rates per perpetual (Binance /fapi/v1/fundingRate), cached on disk with the
 * ranges known to be complete. Only missing ranges are downloaded. Used by backtests (funding
 * payments), replays and the funding-rate data series of scripts (BINANCE:BTCUSDT.P_FUNDING).
 */
import path from 'node:path';
import fs from 'node:fs';
import type { SymbolId } from '../../shared/symbols';
import type { BinanceRest } from '../binance/rest';
import { readJson, writeJsonAtomic } from '../storage/jsonStore';
import { addRange, subtractRanges, type Range } from '../storage/candleStore';

interface FundingDoc {
  ranges: Range[];
  /** [funding time, rate] sorted by time. */
  events: [number, number][];
}

export class FundingCache {
  private locks = new Map<SymbolId, Promise<unknown>>();

  constructor(
    private dir: string,
    private rest: Pick<BinanceRest, 'fundingRates'>,
    /** Binance server time. */
    private now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Funding events with time in [from, to], downloading what is not cached yet. */
  async get(symbol: SymbolId, from: number, to: number): Promise<{ t: Float64Array; rate: Float64Array }> {
    const run = (this.locks.get(symbol) || Promise.resolve()).then(() => this.load(symbol, from, to));
    this.locks.set(
      symbol,
      run.catch(() => undefined),
    );
    return run;
  }

  private async load(symbol: SymbolId, from: number, to: number): Promise<{ t: Float64Array; rate: Float64Array }> {
    const file = path.join(this.dir, `${symbol}.json`);
    const doc = readJson<FundingDoc>(file, { ranges: [], events: [] });
    // settled events only: the newest minute may still be on its way
    const end = Math.min(to, this.now() - 60_000);
    const gaps = end > from ? subtractRanges([from, end], doc.ranges) : [];
    if (gaps.length) {
      const map = new Map(doc.events);
      let ranges = doc.ranges;
      for (const [a, b] of gaps) {
        let start = a;
        for (let guard = 0; guard < 100 && start < b; guard++) {
          const rows = await this.rest.fundingRates(symbol, start, b, 1000);
          for (const r of rows) if (Number.isFinite(r.rate)) map.set(r.t, r.rate);
          if (rows.length < 1000) break;
          start = rows[rows.length - 1].t + 1;
        }
        ranges = addRange(ranges, [a, b]);
      }
      doc.events = [...map.entries()].sort((x, y) => x[0] - y[0]);
      doc.ranges = ranges;
      writeJsonAtomic(file, doc);
    }
    let i0 = 0;
    while (i0 < doc.events.length && doc.events[i0][0] < from) i0++;
    let i1 = i0;
    while (i1 < doc.events.length && doc.events[i1][0] <= to) i1++;
    const ev = doc.events.slice(i0, i1);
    return { t: Float64Array.from(ev, (e) => e[0]), rate: Float64Array.from(ev, (e) => e[1]) };
  }
}
