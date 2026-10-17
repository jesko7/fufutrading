import { describe, it, expect } from 'vitest';
import { scaledOrders } from '../../src/shared/trading/scaled';

const base = { tickSize: 0.1, stepSize: 0.001 };

describe('scaled orders', () => {
  it('spreads the prices evenly from start to end, on the tick', () => {
    const o = scaledOrders({ ...base, from: 80000, to: 78000, qty: 1, count: 5, distribution: 'flat' });
    expect(o.map((x) => x.price)).toEqual([80000, 79500, 79000, 78500, 78000]);
    expect(o.map((x) => x.qty)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
    const odd = scaledOrders({ ...base, from: 100, to: 101, qty: 0.003, count: 3, distribution: 'flat' });
    expect(odd.map((x) => x.price)).toEqual([100, 100.5, 101]);
  });

  it('splits the quantity in whole lot steps that add up to the total', () => {
    for (const distribution of ['flat', 'increasing', 'decreasing'] as const)
      for (const [qty, count] of [[0.01, 3], [0.123, 7], [1.5, 100], [0.0059, 4]] as const) {
        const o = scaledOrders({ ...base, from: 100, to: 90, qty, count, distribution });
        const sum = o.reduce((a, b) => a + b.qty, 0);
        expect(sum).toBeCloseTo(Math.floor(qty / 0.001 + 1e-9) * 0.001, 9);
        for (const x of o) expect(Math.abs(x.qty / 0.001 - Math.round(x.qty / 0.001))).toBeLessThan(1e-6);
      }
  });

  it('grows or shrinks the orders from the first to the last', () => {
    const inc = scaledOrders({ ...base, from: 100, to: 90, qty: 1, count: 4, distribution: 'increasing' });
    expect(inc.map((x) => x.qty)).toEqual([0.1, 0.2, 0.3, 0.4]);
    const dec = scaledOrders({ ...base, from: 100, to: 90, qty: 1, count: 4, distribution: 'decreasing' });
    expect(dec.map((x) => x.qty)).toEqual([0.4, 0.3, 0.2, 0.1]);
  });

  it('keeps 2 to 100 orders and needs prices and a quantity', () => {
    expect(scaledOrders({ ...base, from: 100, to: 90, qty: 1, count: 1, distribution: 'flat' })).toHaveLength(2);
    expect(scaledOrders({ ...base, from: 100, to: 90, qty: 10, count: 500, distribution: 'flat' })).toHaveLength(100);
    expect(scaledOrders({ ...base, from: 0, to: 90, qty: 1, count: 3, distribution: 'flat' })).toEqual([]);
  });
});
