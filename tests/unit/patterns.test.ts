import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPine } from '../../src/engine/pine';
import type { BarSeries, RunContext } from '../../src/engine/types';

const code = fs.readFileSync(path.resolve(__dirname, '../../src/engine/library/candlestick_patterns.pine'), 'utf8');
const ctx: RunContext = { symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles', mintick: 0.01, base: 'BTC', quote: 'USDT' };
const HOUR = 3_600_000;

/** Bars from [open, high, low, close] rows after 30 ordinary candles (bodies of 1). */
function series(pattern: [number, number, number, number][]): BarSeries {
  const rows: [number, number, number, number][] = [];
  let p = 100;
  for (let i = 0; i < 30; i++) {
    const up = i % 2 === 0;
    const o = p;
    const c = up ? p + 1 : p - 1;
    rows.push([o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c]);
    p = c;
  }
  rows.push(...pattern);
  const n = rows.length;
  const t = Float64Array.from({ length: n }, (_, i) => Date.UTC(2026, 0, 1) + i * HOUR);
  const col = (k: number) => Float64Array.from(rows, (r) => r[k]);
  return { t, o: col(0), h: col(1), l: col(2), c: col(3), v: new Float64Array(n).fill(1), tc: t.map((x) => x + HOUR), length: n };
}

/** Which plotshapes fire on the last bar (all patterns on, no trend filter). */
function detect(pattern: [number, number, number, number][], inputs: Record<string, unknown> = {}): string[] {
  const all: Record<string, unknown> = { in0: 'None' };
  for (let k = 5; k <= 16; k++) all[`in${k}`] = true;
  const r = runPine(code, { data: series(pattern), ctx, inputs: { ...all, ...inputs } });
  if (r.error) throw new Error(r.error.message);
  const last = r.plots[0].values.length - 1;
  return r.plots.filter((p) => p.kind === 'shape' && p.values[last]).map((p) => p.title);
}

describe('candlestick patterns', () => {
  it('finds engulfing, hammer and shooting star', () => {
    // a small black candle, then a long white one that engulfs it (opening at its close: no gap)
    expect(detect([[100.4, 100.6, 99.9, 100], [100, 101.8, 99.9, 101.6]])).toContain('Bullish engulfing');
    expect(detect([[100, 100.5, 99.8, 100.4], [100.4, 100.5, 98.6, 98.8]])).toContain('Bearish engulfing');
    // small body at the top, lower shadow over twice the body, no upper shadow
    expect(detect([[100, 100.35, 98.8, 100.3]])).toEqual(expect.arrayContaining(['Hammer', 'Hanging man']));
    // the mirror image
    expect(detect([[100.3, 101.5, 100, 100]])).toEqual(expect.arrayContaining(['Inverted hammer', 'Shooting star']));
  });

  it('finds morning stars and three white soldiers', () => {
    // long black, a small black star below its body, a long white closing above its middle
    expect(detect([[102, 102.1, 99.9, 100], [100, 100.1, 99.6, 99.8], [99.8, 101.9, 99.7, 101.6]])).toContain('Morning star');
    expect(detect([[100, 101.7, 99.9, 101.5], [101.5, 103.1, 101.4, 103], [103, 104.7, 102.9, 104.5]])).toContain('Three white soldiers');
  });

  it('only detects what is switched on, and a downtrend filter blocks bullish reversals in an uptrend', () => {
    const engulf: [number, number, number, number][] = [[100.4, 100.6, 99.9, 100], [100, 101.8, 99.9, 101.6]];
    expect(detect(engulf, { in5: false })).not.toContain('Bullish engulfing');
    // after 30 bars hovering around 100 the price sits above its 50-bar average only in a rally
    const rally: [number, number, number, number][] = [];
    let p = 100;
    for (let i = 0; i < 30; i++) {
      rally.push([p, p + 1.2, p - 0.1, p + 1]);
      p += 1;
    }
    rally.push([p + 0.4, p + 0.6, p - 0.1, p], [p, p + 1.8, p - 0.1, p + 1.6]);
    expect(detect(rally, { in0: 'SMA 50' })).not.toContain('Bullish engulfing');
    expect(detect(rally, { in0: 'None' })).toContain('Bullish engulfing');
  });
});
