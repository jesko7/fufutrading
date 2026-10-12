import { describe, it, expect } from 'vitest';
import { CandleSeries, aggregate, heikinAshi, renko, STRIDE } from '../../src/shared/candles';
import { parseTimeframe, MIN } from '../../src/shared/timeframes';

function minuteSeries(n: number, start = Date.UTC(2026, 0, 1), f = (i: number) => 100 + Math.sin(i / 5) * 10): CandleSeries {
  const s = new CandleSeries(n);
  for (let i = 0; i < n; i++) {
    const o = f(i);
    const c = f(i + 1);
    s.push(start + i * MIN, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, 2, 2 * c, 3, 1);
  }
  return s;
}

describe('CandleSeries', () => {
  it('packs and unpacks losslessly', () => {
    const s = minuteSeries(50);
    const p = s.pack();
    expect(p.length).toBe(50 * STRIDE);
    const u = CandleSeries.unpack(p);
    expect(u.length).toBe(50);
    expect(u.bar(17)).toEqual(s.bar(17));
  });

  it('merges with later data winning on equal times', () => {
    const a = minuteSeries(10);
    const b = minuteSeries(5, Date.UTC(2026, 0, 1) + 8 * MIN, () => 500);
    const m = a.merge(b);
    expect(m.length).toBe(13);
    expect(m.c[8]).toBe(500);
    for (let i = 1; i < m.length; i++) expect(m.t[i]).toBeGreaterThan(m.t[i - 1]);
  });

  it('binary searches by time', () => {
    const s = minuteSeries(100);
    const t = s.t[42];
    expect(s.indexOfTime(t)).toBe(42);
    expect(s.indexOfTime(t + 1)).toBe(-1);
    expect(s.floorIndex(t + 30_000)).toBe(42);
    expect(s.lowerBound(t + 1)).toBe(43);
  });
});

describe('aggregate', () => {
  it('builds 7m candles consistently from 1m candles', () => {
    const s = minuteSeries(60);
    const a = aggregate(s, parseTimeframe('7m')!);
    // 60 minutes from midnight -> buckets 0,7,...,56 => 9 buckets
    expect(a.length).toBe(9);
    expect(a.o[0]).toBe(s.o[0]);
    expect(a.c[0]).toBe(s.c[6]);
    let hi = -Infinity;
    let vol = 0;
    for (let i = 0; i < 7; i++) {
      hi = Math.max(hi, s.h[i]);
      vol += s.v[i];
    }
    expect(a.h[0]).toBe(hi);
    expect(a.v[0]).toBe(vol);
    expect(a.t[1] - a.t[0]).toBe(7 * MIN);
  });
});

describe('heikinAshi', () => {
  it('follows the HA formulas', () => {
    const s = minuteSeries(20);
    const h = heikinAshi(s);
    const i = 10;
    expect(h.c[i]).toBeCloseTo((s.o[i] + s.h[i] + s.l[i] + s.c[i]) / 4, 10);
    expect(h.o[i]).toBeCloseTo((h.o[i - 1] + h.c[i - 1]) / 2, 10);
    expect(h.h[i]).toBe(Math.max(s.h[i], h.o[i], h.c[i]));
    expect(h.l[i]).toBe(Math.min(s.l[i], h.o[i], h.c[i]));
  });
});

describe('renko', () => {
  it('needs one box to continue and two boxes to reverse', () => {
    const closes = [100, 104, 111, 121, 115, 99, 85];
    const s = new CandleSeries(10);
    closes.forEach((c, i) => s.push(i * MIN, i ? closes[i - 1] : 100, c, c, c, 1));
    const { series: r } = renko(s, { boxSize: 10 });
    const bricks = Array.from({ length: r.length }, (_, i) => [r.o[i], r.c[i]]);
    // 100->110 (at 111), 110->120 (at 121), 115 no brick, 99: reversal requires <= 100 (open of last up brick) - 10 = ...
    expect(bricks.slice(0, 2)).toEqual([
      [100, 110],
      [110, 120],
    ]);
    // reversal from last up brick (110->120): down brick 110->100 once price <= 100
    expect(bricks[2]).toEqual([110, 100]);
    // 85 continues down: 100->90
    expect(bricks[3]).toEqual([100, 90]);
    expect(r.length).toBe(4);
  });
});
