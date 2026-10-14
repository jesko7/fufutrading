import { describe, it, expect } from 'vitest';
import { ScriptHost } from '../../src/engine/host';
import { buildMagnifier, magnifierCoverage } from '../../src/engine/backtest/magnifier';
import type { BarSeries } from '../../src/engine/types';
import { ctx } from '../helpers/bars';

const H = 3600000;
const M = 60000;
const T0 = Date.UTC(2026, 0, 1);

function series(rows: number[][], step: number): BarSeries {
  const n = rows.length;
  const f = (k: number) => Float64Array.from(rows.map((r) => r[k]));
  const t = Float64Array.from(rows.map((_, i) => T0 + i * step));
  return { t, o: f(0), h: f(1), l: f(2), c: f(3), v: Float64Array.from(rows.map(() => 10)), tc: Float64Array.from(t.map((x) => x + step)), length: n };
}

const CODE = `//@version=5
strategy("m", overlay=true, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("X", "L", stop=95, limit=108)
`;

describe('bar magnifier', () => {
  // hourly bars: entry at the open of bar 1 (100); bar 1 spans 90..110
  const hourly = series([[100, 101, 99, 100], [100, 110, 90, 105], [105, 106, 104, 105]], H);
  // inside bar 1 the price first rallies to 110, then falls to 90
  const subRows: number[][] = [];
  for (let k = 0; k < 60; k++) subRows.push([100, 100.5, 99.5, 100]);
  subRows.push([100, 110, 100, 110], [110, 110, 90, 95], [95, 105, 95, 105]);
  for (let k = 3; k < 60; k++) subRows.push([105, 105, 105, 105]);
  for (let k = 0; k < 60; k++) subRows.push([105, 106, 104, 105]);
  const minutes = series(subRows, M);

  it('fills along the real lower-timeframe path instead of the bar assumption', async () => {
    const host = new ScriptHost(null);
    const plain = await host.run({ lang: 'pine', code: CODE, ctx: { ...ctx, tf: '1h' }, inputs: {}, data: hourly });
    // the generic path (open → nearer extreme…) visits the low first: stop loss
    expect(plain.result.strategy!.trades[0].exitPrice).toBe(95);
    const mg = buildMagnifier(hourly, { ...minutes, length: minutes.length }, '1m');
    expect(magnifierCoverage(mg)).toBe(1);
    const fine = await host.run({ lang: 'pine', code: CODE, ctx: { ...ctx, tf: '1h' }, inputs: {}, data: hourly, magnifier: mg });
    // the minutes show the rally came first: take profit
    expect(fine.result.strategy!.trades[0].exitPrice).toBe(108);
    expect(fine.result.strategy!.ticksUsedBars).toBe(3);
  });
});
