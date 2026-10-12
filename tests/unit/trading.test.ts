import { describe, it, expect, afterEach } from 'vitest';
import { Ledger } from '../../src/shared/trading/ledger';
import { setBrackets, DEFAULT_BRACKETS, liquidationPrice, maintenanceMargin, tierFor, maxNotionalFor } from '../../src/shared/trading/brackets';
import { evaluateOrder, barPath } from '../../src/shared/trading/matching';
import type { Order, ExecutionModel } from '../../src/shared/trading/types';

afterEach(() => setBrackets(DEFAULT_BRACKETS, '2026-10-12'));

describe('Binance liquidation formula', () => {
  it('reproduces Binance’s published cross-margin worked example', () => {
    // The FAQ example used older tiers: ETH 10% / cum 135,365 and BTC 2.5% / cum 16,300.
    setBrackets(
      {
        ETHUSDT: [{ floor: 0, cap: 1e15, mmr: 0.1, cum: 135365, minLeverage: 1, maxLeverage: 125 }],
        BTCUSDT: [{ floor: 0, cap: 1e15, mmr: 0.025, cum: 16300, minLeverage: 1, maxLeverage: 125 }],
      },
      'test',
    );
    const l = new Ledger('futures', 1535443.01);
    l.positions.set('ETHUSDT', { id: 'e', symbol: 'ETHUSDT', market: 'futures', side: 1, qty: 3683.979, entry: 1456.84, leverage: 10, marginMode: 'cross', isolatedMargin: 0, openedAt: 0, realizedPnl: 0, fees: 0, funding: 0, maxPrice: 0, minPrice: 0 });
    l.positions.set('BTCUSDT', { id: 'b', symbol: 'BTCUSDT', market: 'futures', side: 1, qty: 109.488, entry: 32481.98, leverage: 10, marginMode: 'cross', isolatedMargin: 0, openedAt: 0, realizedPnl: 0, fees: 0, funding: 0, maxPrice: 0, minPrice: 0 });
    const marks = { ETHUSDT: 1335.18, BTCUSDT: 31967.27 };
    expect(l.maintMargin(l.positions.get('ETHUSDT')!, marks.ETHUSDT)).toBeCloseTo(356512.508, 2);
    expect(l.maintMargin(l.positions.get('BTCUSDT')!, marks.BTCUSDT)).toBeCloseTo(71200.81144, 2);
    expect(l.liqPrice(l.positions.get('ETHUSDT')!, marks)).toBeCloseTo(1153.26, 1);
    expect(l.liqPrice(l.positions.get('BTCUSDT')!, marks)).toBeCloseTo(26316.89, 1);
  });

  it('selects tiers and limits', () => {
    expect(tierFor('BTCUSDT', 100000).mmr).toBe(0.004);
    expect(tierFor('BTCUSDT', 500000).mmr).toBe(0.005);
    expect(maintenanceMargin('BTCUSDT', 500000)).toBeCloseTo(500000 * 0.005 - 300, 6);
    expect(maxNotionalFor('BTCUSDT', 125)).toBe(300000);
    expect(maxNotionalFor('BTCUSDT', 20)).toBe(100000000);
  });
});

describe('Ledger (futures)', () => {
  it('opens, marks and closes a long with fees', () => {
    const l = new Ledger('futures', 10000);
    l.applyFill({ symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 50000, fee: 25, t: 1, leverage: 10, marginMode: 'cross' });
    expect(l.wallet).toBe(9975);
    expect(l.equity({ BTCUSDT: 51000 })).toBe(10975);
    const r = l.applyFill({ symbol: 'BTCUSDT', side: 'sell', qty: 1, price: 51000, fee: 25.5, t: 2 });
    expect(r.realized).toBe(1000);
    expect(l.wallet).toBeCloseTo(10949.5, 9);
    expect(r.closedTrade!.pnl).toBeCloseTo(949.5, 9);
    expect(l.positions.size).toBe(0);
  });

  it('flips position direction with correct entry', () => {
    const l = new Ledger('futures', 10000);
    l.applyFill({ symbol: 'ETHUSDT', side: 'buy', qty: 2, price: 2000, fee: 0, t: 1, leverage: 5 });
    l.applyFill({ symbol: 'ETHUSDT', side: 'buy', qty: 2, price: 2100, fee: 0, t: 2, leverage: 5 });
    expect(l.position('ETHUSDT')!.entry).toBe(2050);
    const r = l.applyFill({ symbol: 'ETHUSDT', side: 'sell', qty: 6, price: 2150, fee: 0, t: 3, leverage: 5 });
    expect(r.realized).toBeCloseTo(400, 9);
    const p = l.position('ETHUSDT')!;
    expect(p.side).toBe(-1);
    expect(p.qty).toBeCloseTo(2, 9);
    expect(p.entry).toBe(2150);
  });

  it('liquidates an isolated long and loses exactly its margin', () => {
    const l = new Ledger('futures', 10000);
    l.applyFill({ symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 50000, fee: 0, t: 1, leverage: 10, marginMode: 'isolated' });
    const p = l.position('BTCUSDT')!;
    expect(p.isolatedMargin).toBe(5000);
    const lp = l.liqPrice(p, { BTCUSDT: 50000 });
    expect(lp).toBeCloseTo(45000 / 0.996, 6);
    expect(l.liquidationCandidates({ BTCUSDT: lp + 5 })).toEqual([]);
    expect(l.liquidationCandidates({ BTCUSDT: lp - 0.01 })).toEqual(['BTCUSDT']);
    const res = l.liquidate('BTCUSDT', lp, 2, 0.0125)!;
    expect(res.bankrupt).toBe(false);
    expect(res.clearanceFee).toBeCloseTo(5000 - (50000 - lp), 6);
    expect(l.wallet).toBeCloseTo(5000, 6);
    expect(l.positions.size).toBe(0);
  });

  it('caps a bankrupt isolated liquidation at the margin (no clearance fee)', () => {
    const l = new Ledger('futures', 10000);
    l.applyFill({ symbol: 'SOLUSDT', side: 'sell', qty: 100, price: 100, fee: 0, t: 1, leverage: 20, marginMode: 'isolated' });
    const res = l.liquidate('SOLUSDT', 110, 2, 0.015)!;
    expect(res.bankrupt).toBe(true);
    expect(res.clearanceFee).toBe(0);
    expect(l.wallet).toBeCloseTo(10000 - 500, 6);
  });

  it('cross liquidation triggers when margin balance falls to maintenance margin', () => {
    const l = new Ledger('futures', 1000);
    l.applyFill({ symbol: 'BTCUSDT', side: 'buy', qty: 0.5, price: 40000, fee: 0, t: 1, leverage: 20, marginMode: 'cross' });
    const lp = l.liqPrice(l.position('BTCUSDT')!, { BTCUSDT: 40000 });
    // closed form for a single cross position: (WB - side*q*ep)/(q*mmr - side*q)
    expect(lp).toBeCloseTo((1000 - 0.5 * 40000) / (0.5 * 0.004 - 0.5), 6);
    expect(l.liquidationCandidates({ BTCUSDT: lp + 1 })).toEqual([]);
    expect(l.liquidationCandidates({ BTCUSDT: lp - 1 })).toEqual(['BTCUSDT']);
    expect(l.marginRatio({ BTCUSDT: lp })).toBeCloseTo(1, 3);
  });

  it('settles funding (longs pay positive rates)', () => {
    const l = new Ledger('futures', 10000);
    l.applyFill({ symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 50000, fee: 0, t: 1, leverage: 10 });
    expect(l.applyFunding('BTCUSDT', 0.0001, 50000)).toBeCloseTo(5, 9);
    expect(l.wallet).toBeCloseTo(9995, 9);
    const s = new Ledger('futures', 10000);
    s.applyFill({ symbol: 'BTCUSDT', side: 'sell', qty: 1, price: 50000, fee: 0, t: 1, leverage: 10 });
    s.applyFunding('BTCUSDT', 0.0001, 50000);
    expect(s.wallet).toBeCloseTo(10005, 9);
  });

  it('liquidation price matches the standalone formula', () => {
    const lp = liquidationPrice({ symbol: 'ETHUSDT', side: -1, qty: 10, entry: 2000, wallet: 1000 });
    // short: (1000 + 0 + 20000)/(10*0.004 + 10)
    expect(lp).toBeCloseTo(21000 / 10.04, 6);
  });
});

describe('Ledger (spot)', () => {
  it('buys and sells with USDT fees', () => {
    const l = new Ledger('spot', 10000);
    l.applyFill({ symbol: 'BTCUSDT', side: 'buy', qty: 0.1, price: 50000, fee: 5, t: 1 });
    expect(l.wallet).toBeCloseTo(4995, 9);
    expect(l.equity({ BTCUSDT: 52000 })).toBeCloseTo(4995 + 5200, 9);
    const r = l.applyFill({ symbol: 'BTCUSDT', side: 'sell', qty: 0.1, price: 51000, fee: 5.1, t: 2 });
    expect(r.realized).toBeCloseTo(100, 9);
    expect(l.wallet).toBeCloseTo(10089.9, 9);
    expect(r.closedTrade!.pnl).toBeCloseTo(89.9, 9);
  });
});

describe('matching', () => {
  const exec: ExecutionModel = { limitFill: 'touch', throughTicks: 0, partialFills: false, participation: 0.25, stopTrigger: 'last' };
  const order = (o: Partial<Order>): Order => ({ id: 'o', accountId: 'a', symbol: 'BTCUSDT', market: 'spot', side: 'buy', type: 'limit', qty: 1, reduceOnly: false, tif: 'GTC', trigger: 'last', status: 'new', filledQty: 0, avgFillPrice: 0, createdAt: 0, updatedAt: 0, source: 'manual', ...o });

  it('fills a resting buy limit on touch vs through', () => {
    const o = order({ price: 100 });
    expect(evaluateOrder(o, { from: 101, to: 100, volume: 1, t: 0 }, exec, 0.01, 'tick')).not.toBeNull();
    expect(evaluateOrder(o, { from: 101, to: 100, volume: 1, t: 0 }, { ...exec, limitFill: 'through' }, 0.01, 'tick')).toBeNull();
    expect(evaluateOrder(o, { from: 101, to: 99.99, volume: 1, t: 0 }, { ...exec, limitFill: 'through' }, 0.01, 'tick')!.price).toBe(100);
  });

  it('partially fills by participation when touching', () => {
    const o = order({ price: 100, qty: 10 });
    const d = evaluateOrder(o, { from: 100.5, to: 100, volume: 8, t: 0 }, { ...exec, partialFills: true, participation: 0.25 }, 0.01, 'tick')!;
    expect(d.qty).toBe(2);
  });

  it('fills stops at the stop level or the gap price on bar paths', () => {
    const s = order({ type: 'stop', side: 'sell', stopPrice: 95 });
    expect(evaluateOrder(s, { from: 100, to: 90, volume: 0, t: 0 }, exec, 0.01, 'path')!.price).toBe(95);
    expect(evaluateOrder(s, { from: 93, to: 90, volume: 0, t: 0 }, exec, 0.01, 'path')!.price).toBe(93);
    const tp = order({ type: 'takeProfit', side: 'sell', stopPrice: 110 });
    expect(evaluateOrder(tp, { from: 100, to: 112, volume: 0, t: 0 }, exec, 0.01, 'path')!.price).toBe(110);
    expect(evaluateOrder(tp, { from: 100, to: 105, volume: 0, t: 0 }, exec, 0.01, 'path')).toBeNull();
  });

  it('orders the intrabar path by proximity of the open', () => {
    expect(barPath(100, 101, 90, 95)).toEqual([100, 101, 90, 95]);
    expect(barPath(100, 110, 99, 105)).toEqual([100, 99, 110, 105]);
  });
});
