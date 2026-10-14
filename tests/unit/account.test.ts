import { describe, it, expect } from 'vitest';
import { AccountRuntime, type MarketCtx } from '../../src/shared/trading/account';
import { newAccountConfig } from '../../src/shared/trading/presets';
import type { Order } from '../../src/shared/trading/types';

const DAY = 86400000;

function setup(market: 'spot' | 'futures' = 'futures', prop = false) {
  const cfg = newAccountConfig({ id: 'a1', name: 'test', kind: 'manual', market, initialBalance: 100000, costPreset: 'zero', futures: { defaultLeverage: 5 } });
  if (prop) cfg.prop = { profileId: 'ftmo-2step-challenge', profileVersion: '1', firm: 'FTMO', program: '2-Step', phase: 'Challenge', size: 100000, options: {} };
  const rt = new AccountRuntime(cfg);
  const m = { px: 50000, t: Date.UTC(2026, 3, 6, 12) };
  const ctx: MarketCtx = { now: () => m.t, last: () => m.px, mark: () => m.px };
  const tick = (to: number) => {
    const from = m.px;
    m.px = to;
    m.t += 1000;
    rt.onPrice('BTCUSDT', { from, to, volume: 1, t: m.t }, ctx);
  };
  return { rt, ctx, m, tick };
}

describe('AccountRuntime reduce-only orders', () => {
  it('cancels the old stop loss and take profit when a position is reversed', () => {
    const { rt, ctx, tick } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    rt.setBrackets('BTCUSDT', { sl: 49000, tp: 52000 }, ctx);
    expect(rt.orders.filter((o) => o.bracket).length).toBe(2);
    // reverse: sell 2 → short 1
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 2 }, ctx);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(-1);
    expect(rt.orders.length).toBe(0);
    // the old sell stop at 49,000 must not add to the short
    tick(48900);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(-1);
  });

  it('cancels plain reduce-only orders when the position closes, but keeps them after a partial close', () => {
    const { rt, ctx } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 2 }, ctx);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', qty: 1, price: 53000, reduceOnly: true }, ctx);
    rt.setBrackets('BTCUSDT', { sl: 48000 }, ctx);
    rt.closePosition('BTCUSDT', ctx, 1);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(1);
    expect(rt.orders.length).toBe(2);
    rt.closePosition('BTCUSDT', ctx);
    expect(rt.ledger.positions.size).toBe(0);
    expect(rt.orders.length).toBe(0);
  });

  it('never lets a stale reduce-only order add to a position', () => {
    const { rt, ctx, tick } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 1 }, ctx);
    // e.g. restored from an older save: a sell stop marked reduce-only while the account is short
    const stale: Order = { id: 'stale', accountId: 'a1', symbol: 'BTCUSDT', market: 'futures', side: 'sell', type: 'stop', qty: 1, stopPrice: 49500, reduceOnly: true, closePosition: true, tif: 'GTC', trigger: 'last', status: 'new', filledQty: 0, avgFillPrice: 0, createdAt: 0, updatedAt: 0, source: 'bracket', bracket: 'sl' };
    rt.orders.push(stale);
    tick(49400);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(-1);
    expect(rt.orders.length).toBe(0);
    expect(stale.status).toBe('canceled');
  });

  it('attaches the new brackets after a reversing entry with SL/TP', () => {
    const { rt, ctx } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1, sl: 49000 }, ctx);
    expect(rt.orders.map((o) => `${o.bracket}:${o.side}`)).toEqual(['sl:sell']);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 2, sl: 51000, tp: 47000 }, ctx);
    expect(rt.orders.map((o) => `${o.bracket}:${o.side}:${o.stopPrice}`).sort()).toEqual(['sl:buy:51000', 'tp:buy:47000']);
  });
});

describe('AccountRuntime prop trading days', () => {
  it('counts the day a position was opened, not the day it was closed', () => {
    const { rt, ctx, m } = setup('futures', true);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1 }, ctx);
    m.t += DAY;
    rt.closePosition('BTCUSDT', ctx);
    expect(rt.prop!.state.tradingDays.length).toBe(1);
    // a reversal on a later day opens a position and counts
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1 }, ctx);
    m.t += DAY;
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 0.2 }, ctx);
    expect(rt.prop!.state.tradingDays.length).toBe(3);
  });
});

describe('AccountRuntime leverage and isolated margin (Binance rules)', () => {
  it('changes the leverage of an open cross position up and down', () => {
    const { rt, ctx } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    expect(rt.ledger.position('BTCUSDT')!.leverage).toBe(5);
    rt.setLeverage('BTCUSDT', 10, ctx);
    expect(rt.ledger.position('BTCUSDT')!.leverage).toBe(10);
    expect(rt.snapshot(ctx).marginUsed).toBeCloseTo(5000, 6);
    rt.setLeverage('BTCUSDT', 2, ctx);
    expect(rt.snapshot(ctx).marginUsed).toBeCloseTo(25000, 6);
    // 1x would need 50,000 margin for this position; 100,000 wallet still covers it
    rt.setLeverage('BTCUSDT', 1, ctx);
    expect(rt.ledger.position('BTCUSDT')!.leverage).toBe(1);
  });

  it('rejects lowering the leverage without enough available balance', () => {
    const { rt, ctx } = setup();
    rt.setLeverage('BTCUSDT', 20, ctx);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 30 }, ctx); // 1.5M notional at 20x = 75,000 margin
    expect(() => rt.setLeverage('BTCUSDT', 10, ctx)).toThrow(/Insufficient margin/);
    expect(rt.ledger.position('BTCUSDT')!.leverage).toBe(20);
  });

  it('caps the leverage by the bracket of the position size', () => {
    const { rt, ctx } = setup();
    rt.config.risk.maxLeverage = 125;
    rt.setLeverage('BTCUSDT', 20, ctx);
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 30 }, ctx);
    expect(() => rt.setLeverage('BTCUSDT', 125, ctx)).toThrow(/Binance leverage brackets/);
  });

  it('only raises the leverage of an open isolated position', () => {
    const { rt, ctx } = setup();
    rt.config.futures.marginModes = { BTCUSDT: 'isolated' };
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    const p = rt.ledger.position('BTCUSDT')!;
    expect(p.isolatedMargin).toBeCloseTo(10000, 6);
    expect(() => rt.setLeverage('BTCUSDT', 3, ctx)).toThrow(/isolated/);
    rt.setLeverage('BTCUSDT', 10, ctx);
    expect(p.leverage).toBe(10);
    // the allocated margin stays; the excess over the new initial margin can be removed
    expect(p.isolatedMargin).toBeCloseTo(10000, 6);
    expect(rt.maxRemovableMargin(p, 50000)).toBeCloseTo(5000, 6);
  });

  it('limits adding and removing isolated margin', () => {
    const { rt, ctx, tick } = setup();
    rt.config.futures.marginModes = { BTCUSDT: 'isolated' };
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx); // 10,000 margin at 5x
    expect(() => rt.adjustMargin('BTCUSDT', -1, ctx)).toThrow(/At most 0.00/);
    rt.adjustMargin('BTCUSDT', 2000, ctx);
    expect(rt.ledger.position('BTCUSDT')!.isolatedMargin).toBeCloseTo(12000, 6);
    // a loss reduces what can be taken out
    tick(49000);
    expect(rt.maxRemovableMargin(rt.ledger.position('BTCUSDT')!, 49000)).toBeCloseTo(12000 - 1000 - 9800, 6);
    expect(() => rt.adjustMargin('BTCUSDT', 1e6, ctx)).toThrow(/available to add/);
    rt.adjustMargin('BTCUSDT', -1200, ctx);
    expect(rt.ledger.position('BTCUSDT')!.isolatedMargin).toBeCloseTo(10800, 6);
  });

  it('counts unrealized profit of cross positions in the available balance', () => {
    const { rt, ctx, m } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx); // 10,000 IM
    m.px = 60000; // +10,000 uPnL, IM at mark 12,000
    expect(rt.snapshot(ctx).available).toBeCloseTo(100000 + 10000 - 12000, 6);
  });
});
