import { describe, it, expect } from 'vitest';
import { parseTimeframe, bucketStart, bucketEnd, baseIntervalFor, nativeInterval, tfToString, DAY, MIN } from '../../src/shared/timeframes';

const T = Date.UTC(2026, 9, 12, 13, 47, 31, 250); // Mon 2026-10-12 13:47:31.250Z

describe('timeframes', () => {
  it('parses standard and custom timeframes', () => {
    expect(tfToString(parseTimeframe('30s')!)).toBe('30s');
    expect(tfToString(parseTimeframe('7m')!)).toBe('7m');
    expect(tfToString(parseTimeframe('60m')!)).toBe('1h');
    expect(tfToString(parseTimeframe('240')!)).toBe('4h');
    expect(tfToString(parseTimeframe('1d')!)).toBe('1D');
    expect(tfToString(parseTimeframe('24h')!)).toBe('1D');
    expect(tfToString(parseTimeframe('1W')!)).toBe('1W');
    expect(tfToString(parseTimeframe('3M')!)).toBe('3M');
    expect(tfToString(parseTimeframe('7D')!)).toBe('7D');
    expect(parseTimeframe('abc')).toBeNull();
  });

  it('aligns dividing intervals to the epoch', () => {
    expect(bucketStart(parseTimeframe('15m')!, T)).toBe(Date.UTC(2026, 9, 12, 13, 45));
    expect(bucketStart(parseTimeframe('30s')!, T)).toBe(Date.UTC(2026, 9, 12, 13, 47, 30));
    expect(bucketStart(parseTimeframe('4h')!, T)).toBe(Date.UTC(2026, 9, 12, 12));
  });

  it('anchors non-dividing intraday intervals to the UTC day (TradingView convention)', () => {
    const tf = parseTimeframe('7m')!;
    const b = bucketStart(tf, T);
    const dayStart = Date.UTC(2026, 9, 12);
    expect((b - dayStart) % (7 * MIN)).toBe(0);
    expect(b).toBeLessThanOrEqual(T);
    expect(bucketEnd(tf, b)).toBeGreaterThan(T);
    // last bucket of the day is truncated at midnight
    const late = Date.UTC(2026, 9, 12, 23, 58);
    const lb = bucketStart(tf, late);
    expect(bucketEnd(tf, lb)).toBe(Date.UTC(2026, 9, 13));
  });

  it('matches Binance 3d and weekly alignment', () => {
    const b3 = bucketStart(parseTimeframe('3D')!, T);
    expect((b3 / DAY) % 3).toBe(1);
    const w = bucketStart(parseTimeframe('1W')!, T);
    expect(new Date(w).getUTCDay()).toBe(1); // Monday
    expect(w).toBe(Date.UTC(2026, 9, 12));
  });

  it('aligns months to calendar months', () => {
    expect(bucketStart(parseTimeframe('1M')!, T)).toBe(Date.UTC(2026, 9, 1));
    expect(bucketStart(parseTimeframe('3M')!, T)).toBe(Date.UTC(2026, 9, 1));
    expect(bucketEnd(parseTimeframe('1M')!, Date.UTC(2026, 11, 1))).toBe(Date.UTC(2027, 0, 1));
  });

  it('chooses nesting base intervals', () => {
    expect(nativeInterval(parseTimeframe('1h')!, 'spot')).toBe('1h');
    expect(baseIntervalFor(parseTimeframe('7m')!, 'spot')).toBe('1m');
    expect(baseIntervalFor(parseTimeframe('90m')!, 'spot')).toBe('30m');
    expect(baseIntervalFor(parseTimeframe('30s')!, 'spot')).toBe('1s');
    expect(baseIntervalFor(parseTimeframe('30s')!, 'futures')).toBeNull();
    expect(baseIntervalFor(parseTimeframe('5D')!, 'futures')).toBe('1d');
    expect(baseIntervalFor(parseTimeframe('2W')!, 'spot')).toBe('1w');
    expect(baseIntervalFor(parseTimeframe('10h')!, 'spot')).toBe('2h');
  });
});
