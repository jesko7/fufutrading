import { describe, it, expect } from 'vitest';
import { findNodes, stackedImbalances, HvnEngine, ImbalanceEngine, AbsorptionEngine, OrderFlowEngine } from '../../src/main/market/orderflowEngine';
import { bookSum, groupBook, flowWindow } from '../../src/main/market/orderflow';
import { LocalBook } from '../../src/main/market/orderbook';
import { autoRow, niceStep, orderFlowKind, orderFlowInputs, fmtFlowQty, type AbsorptionParams } from '../../src/shared/orderflow';

const MIN = 60000;
const HOUR = 3600000;
const bucket = (t: number) => t - (t % MIN);
const cells = (o: Record<number, [number, number]>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v] as [number, [number, number]]));

describe('order flow: shared helpers', () => {
  it('maps script ids, fills defaults and formats volumes', () => {
    expect(orderFlowKind('of:hvn')).toBe('hvn');
    expect(orderFlowKind('of:nope')).toBeNull();
    expect(orderFlowKind('builtin:rsi')).toBeNull();
    expect(orderFlowInputs('absorption', { gap: 5 })).toMatchObject({ gap: 5, hold: 8, sensitivity: 'Medium' });
    expect(autoRow(77000, 0.01)).toBe(10);
    expect(autoRow(2300, 0.01)).toBe(0.25);
    expect(niceStep(0.003, 0.01)).toBe(0.01);
    expect(fmtFlowQty(0.844)).toBe('0.84');
    expect(fmtFlowQty(12.44)).toBe('12.4');
    expect(fmtFlowQty(156.2)).toBe('156');
    expect(fmtFlowQty(1234)).toBe('1.2K');
  });
});

describe('order flow: HVN profile', () => {
  it('finds band-sum peaks, strongest first, apart by a band', () => {
    // two humps: around row 10 (big) and row 30 (smaller); background 1 per row
    const o: Record<number, [number, number]> = {};
    for (let r = 0; r <= 40; r++) o[r] = [0.5, 0.5];
    o[9] = [3, 1];
    o[10] = [8, 4];
    o[11] = [3, 1];
    o[29] = [1, 2];
    o[30] = [2, 4];
    o[31] = [1, 2];
    const nodes = findNodes(cells(o), 3, 5, 1.4);
    expect(nodes.map((n) => n.row)).toEqual([10, 30]);
    expect(nodes[0].vol).toBe(4 + 12 + 4);
    expect(nodes[0].buy).toBe(3 + 8 + 3);
    expect(nodes[1].vol).toBe(3 + 6 + 3);
    // a higher strength keeps only the big node
    expect(findNodes(cells(o), 3, 5, 3).map((n) => n.row)).toEqual([10]);
  });

  it('keeps completed periods and ends a node at the first bar trading back into it', () => {
    const e = new HvnEngine({ row: 1, periodMs: HOUR, periods: 1, count: 3, strength: 1.2, band: 1, untilTouched: true }, bucket);
    // period 0: heavy volume at 100, light around
    for (let i = 0; i < 50; i++) e.add(i * 1000, 100.5, i % 3 ? 1 : -1);
    for (let p = 95; p <= 105; p++) e.add(60000 + p, p + 0.5, 0.2);
    // period 1 trades away from 100, most at 110
    for (let i = 0; i < 20; i++) e.add(HOUR + 1000 + i, 110.5, 1);
    for (let p = 106; p <= 114; p++) e.add(HOUR + 3000 + p, p + 0.5, 0.2);
    let L = e.levels().filter((l) => !l.developing);
    expect(L).toHaveLength(1);
    expect(L[0]).toMatchObject({ lo: 100, hi: 101, from: 0, to: null });
    expect(L[0].buy / L[0].vol).toBeGreaterThan(0.6);
    // the forming period has its own node
    expect(e.levels().some((l) => l.developing && l.lo === 110)).toBe(true);
    // price comes back: the band ends at that bar
    e.add(HOUR + 7 * MIN + 30000, 100.2, -1);
    L = e.levels().filter((l) => !l.developing);
    expect(L[0].to).toBe(HOUR + 7 * MIN);
  });
});

describe('order flow: imbalance levels', () => {
  it('finds stacked diagonal imbalances with ratio and volume', () => {
    // rows 0..5; buyers dominate rows 2..4 against sells one row lower
    const rows = cells({ 0: [1, 1], 1: [1, 1], 2: [5, 1], 3: [6, 1], 4: [4, 2], 5: [1, 1] });
    const z = stackedImbalances(rows, 10, 3, 3, 0.5, 1000, false);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ side: 1, lo: 20, hi: 50, rows: 3, vol: 15, t: 1000, end: null });
    expect(z[0].ratio).toBeCloseTo(15 / 3, 6);
    // nothing sold below: the ratio is against the noise floor (min. volume per row × rows / ratio)
    const f = stackedImbalances(cells({ 0: [1, 0], 1: [4, 0], 2: [5, 0], 3: [6, 0] }), 1, 3, 3, 0.5, 0, false);
    expect(f[0]).toMatchObject({ side: 1, lo: 1, hi: 4, vol: 15, opp: 0 });
    expect(f[0].ratio).toBeCloseTo(15 / 0.5, 9);
    // a zone never reads below the ratio it was found with
    const m = stackedImbalances(cells({ 0: [0, 0.01], 1: [0.5, 0.01], 2: [0.5, 0.01], 3: [0.5, 0] }), 1, 3, 3, 0.5, 0, false);
    expect(m[0].ratio).toBeGreaterThanOrEqual(3);
    // a stack of two is not enough when three are required
    expect(stackedImbalances(cells({ 0: [1, 1], 1: [5, 1], 2: [5, 1], 3: [1, 1] }), 10, 3, 3, 0.5, 0, false)).toHaveLength(0);
    // sellers: selling at a row against buying one row higher
    const s = stackedImbalances(cells({ 0: [1, 9], 1: [1, 8], 2: [2, 7], 3: [1, 1] }), 1, 3, 3, 0.5, 0, false);
    expect(s).toEqual([expect.objectContaining({ side: -1, lo: 0, hi: 3, vol: 24 })]);
  });

  it('extends a zone until a later bar trades back into it', () => {
    const e = new ImbalanceEngine({ row: 1, ratio: 3, stack: 3, minVolume: 0.5, maxLevels: 10 }, bucket);
    // bar 0: buy imbalance on rows 11..13
    const add = (t: number, p: number, q: number) => e.add(t, p + 0.5, q);
    add(0, 10, 1);
    add(1, 10, -1);
    add(2, 11, 5);
    add(3, 11, -1);
    add(4, 12, 6);
    add(5, 12, -1);
    add(6, 13, 4);
    add(7, 13, -1);
    add(8, 14, 1);
    expect(e.levels()).toEqual([expect.objectContaining({ side: 1, lo: 11, hi: 14, live: true })]);
    // bar 1 trades above the zone: still open
    add(MIN, 16, 1);
    add(MIN + 1, 17, -1);
    let z = e.levels().filter((x) => !x.live);
    expect(z).toEqual([expect.objectContaining({ lo: 11, hi: 14, end: null, live: false })]);
    // bar 2 dips into it
    add(2 * MIN, 15, -1);
    add(2 * MIN + 1, 13, -1);
    z = e.levels().filter((x) => !x.live);
    expect(z[0].end).toBe(2 * MIN);
  });
});

describe('order flow: heavy absorption', () => {
  const P: AbsorptionParams = { row: 1, quantile: 0.99, minVolume: 10, gapMs: 3000, holdMs: 10000, tolerance: 1, bookOnly: false };

  it('marks selling absorbed at a level that holds, live and then confirmed', () => {
    const e = new AbsorptionEngine(P, (side, lo, hi) => (side === 'bid' && lo === 100 && hi === 101 ? 4 : 0));
    for (let i = 0; i < 6; i++) e.add(i * 500, 100.3, -2); // 12 sold into the 100 row
    e.add(3000, 101.2, 0.5); // a buy above: price lifts
    const list = e.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ side: -1, lo: 100, hi: 101, vol: 12, trades: 6, shown: 4, state: 'live' });
    expect(list[0].t).toBe(2000); // the hit that reached 10
    expect(list[0].price).toBeCloseTo(100.3, 9);
    e.tick(2500 + 3000 + 10001); // last hit + pause + hold
    expect(e.list()[0].state).toBe('held');
    const d = e.drain();
    expect(d.changed.map((x) => x.state)).toEqual(['held']);
  });

  it('removes the bubble when price breaks through the level within the hold time', () => {
    const e = new AbsorptionEngine(P);
    for (let i = 0; i < 6; i++) e.add(i * 500, 100.3, -2);
    expect(e.list()).toHaveLength(1);
    const id = e.list()[0].id;
    e.add(4000, 99.5, -1); // one row below: within tolerance
    expect(e.list()).toHaveLength(1);
    e.add(5000, 98.5, -1); // two rows below: broken
    expect(e.list()).toHaveLength(0);
    expect(e.drain().removed).toEqual([id]);
  });

  it('a level that held stays, whatever price does later', () => {
    const e = new AbsorptionEngine(P);
    for (let i = 0; i < 6; i++) e.add(i * 500, 100.3, -2);
    e.add(20000, 101.5, 1);
    expect(e.list()[0].state).toBe('held');
    e.add(30000, 90.5, -5);
    expect(e.list()).toHaveLength(1);
  });

  it('buying absorbed at the highs is side 1', () => {
    const e = new AbsorptionEngine(P);
    for (let i = 0; i < 4; i++) e.add(i * 400, 200.7, 3);
    expect(e.list()[0]).toMatchObject({ side: 1, lo: 200, hi: 201, vol: 12, shown: null });
  });

  it('learns an automatic threshold from hit clusters', () => {
    const e = new AbsorptionEngine({ ...P, minVolume: 0, quantile: 0.95 });
    expect(e.threshold()).toBe(Infinity);
    // 300 small clusters on alternating rows (each closes after the gap)
    for (let i = 0; i < 300; i++) e.add(i * 4000, 100.5 + (i % 2) * 5, i % 2 ? 1 : -1);
    expect(e.threshold()).toBe(1);
    expect(e.list()).toHaveLength(0);
  });
});

describe('order flow: combined engine and service helpers', () => {
  it('feeds every tool from the same trades', () => {
    const e = new OrderFlowEngine({ bucket, hvn: { row: 1, periodMs: HOUR, periods: 1, count: 3, strength: 1.2, band: 1, untilTouched: true }, imbalance: { row: 1, ratio: 3, stack: 3, minVolume: 0.5, maxLevels: 5 }, absorption: { row: 1, quantile: 0.99, minVolume: 5, gapMs: 3000, holdMs: 1000, tolerance: 1, bookOnly: false } });
    for (let i = 0; i < 10; i++) e.add(i * 100, 100.5, -1);
    for (let p = 101; p <= 105; p++) e.add(2000 + p, p + 0.5, 0.1);
    expect(e.trades).toBe(15);
    expect(e.abs!.list()).toHaveLength(1);
    expect(e.hvn!.levels().length).toBeGreaterThan(0);
  });

  it('sums and groups the local book', () => {
    const b = new LocalBook();
    b.setSnapshot(
      [
        ['100.00', '1'],
        ['99.50', '2'],
        ['99.00', '3'],
        ['98.20', '4'],
      ],
      [
        ['100.10', '5'],
        ['100.60', '6'],
        ['101.00', '7'],
      ],
      1,
    );
    expect(bookSum(b, 'bid', 99, 100)).toBe(5);
    expect(bookSum(b, 'bid', 99, 100.01)).toBe(6);
    expect(bookSum(b, 'ask', 100, 101)).toBe(11);
    const g = groupBook(b, 'bid', 1);
    expect([...g.p]).toEqual([100, 99, 98]);
    expect([...g.q]).toEqual([1, 5, 4]);
    const a = groupBook(b, 'ask', 1);
    expect([...a.p]).toEqual([101]);
    expect([...a.q]).toEqual([18]);
  });

  it('loads a few hours for absorption and imbalances, whole periods for HVN', () => {
    const now = Date.UTC(2026, 10, 3, 14, 20);
    const base = { hvn: null, absorption: null, imbalance: null };
    expect(flowWindow(now, 10000, { ...base, absorption: {} as never })).toBe(now - 2 * HOUR);
    expect(flowWindow(now, 15 * MIN, { ...base, imbalance: {} as never })).toBe(now - 12 * HOUR);
    expect(flowWindow(now, 10000, { ...base, hvn: { periodMs: HOUR, periods: 2 } as never })).toBe(Date.UTC(2026, 10, 3, 12));
    expect(flowWindow(now, HOUR, { ...base, hvn: { periodMs: 24 * HOUR, periods: 6 } as never })).toBe(now - 48 * HOUR);
    expect(flowWindow(now, HOUR, { ...base, hvn: { periodMs: 24 * HOUR, periods: 6 } as never }, 24 * HOUR)).toBe(now - 24 * HOUR);
  });
});
