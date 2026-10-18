import { describe, it, expect } from 'vitest';
import { AccountRuntime, type MarketCtx } from '../../src/shared/trading/account';
import { newAccountConfig } from '../../src/shared/trading/presets';
import type { Order } from '../../src/shared/trading/types';
import { twapPlan } from '../../src/shared/trading/twap';

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
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', qty: 1, price: 52000, reduceOnly: true }, ctx);
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

describe('AccountRuntime Binance order rules', () => {
  it('rejects futures limit prices outside 5% of the mark price', () => {
    const { rt, ctx } = setup();
    expect(() => rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'limit', qty: 0.01, price: 53000 }, ctx)).toThrow(/higher than 52500/);
    expect(() => rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 0.01, price: 47000 }, ctx)).toThrow(/lower than 47500/);
    expect(rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 0.01, price: 48000 }, ctx).status).toBe('new');
  });

  it('caps the size of one futures market order', () => {
    const { rt, ctx } = setup();
    rt.config.risk.maxLeverage = 125;
    rt.ledger.wallet = 1e9;
    expect(() => rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 121 }, ctx)).toThrow(/at most 120 BTC/);
  });

  it('fills marketable limits from the book: GTC rests the rest, IOC cancels it, FOK fills all or nothing', () => {
    const { rt, ctx } = setup();
    // 0.5 BTC available up to the limit price
    const book: MarketCtx = { ...ctx, bestBidAsk: () => ({ bid: 49999, ask: 50000 }), sweep: (_m, _s, _side, qty, limit) => (limit !== undefined && limit >= 50000 ? { avgPrice: 50001, filled: Math.min(qty, 0.5), worstPrice: 50002 } : null) };
    const gtc = rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 1, price: 50010 }, book);
    expect(gtc.filledQty).toBe(0.5);
    expect(gtc.avgFillPrice).toBe(50001);
    expect(rt.orders.includes(gtc)).toBe(true);
    const ioc = rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 1, price: 50010, tif: 'IOC' }, book);
    expect(ioc.filledQty).toBe(0.5);
    expect(ioc.status).toBe('expired');
    expect(rt.orders.includes(ioc)).toBe(false);
    const pos = rt.ledger.signedQty('BTCUSDT');
    const fok = rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 1, price: 50010, tif: 'FOK' }, book);
    expect(fok.status).toBe('expired');
    expect(fok.filledQty).toBe(0);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(pos);
    // non-marketable IOC expires right away
    const idle = rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'limit', qty: 0.1, price: 49000, tif: 'IOC' }, book);
    expect(idle.status).toBe('expired');
  });

  it('trails a sell stop behind the high and triggers on the pullback', () => {
    const { rt, ctx, tick } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    const o = rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'trailingStop', qty: 1, callbackRate: 0.02, reduceOnly: true }, ctx);
    expect(o.stopPrice).toBe(49000);
    tick(52000);
    expect(o.stopPrice).toBe(50960);
    tick(51500);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(1);
    tick(50900);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(0);
    expect(o.status).toBe('filled');
  });

  it('waits for the activation price before trailing (buy side)', () => {
    const { rt, ctx, tick } = setup();
    const o = rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'trailingStop', qty: 0.1, callbackRate: 0.01, activationPrice: 48000 }, ctx);
    expect(o.stopPrice).toBeUndefined();
    tick(49000);
    tick(48500);
    expect(o.trailExtreme).toBeUndefined();
    tick(47500); // activates at 48,000 and follows the low
    expect(o.trailExtreme).toBe(47500);
    expect(o.stopPrice).toBe(47975);
    tick(47900);
    expect(rt.ledger.signedQty('BTCUSDT')).toBe(0);
    tick(48000);
    expect(rt.ledger.signedQty('BTCUSDT')).toBeCloseTo(0.1, 9);
    expect(() => rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'trailingStop', qty: 0.1, callbackRate: 0.2 }, ctx)).toThrow(/between 0.1% and 10%/);
  });

  it('triggers a trailing stop exactly on a bar path (replay)', () => {
    const { rt, ctx, m } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    const o = rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'trailingStop', qty: 1, callbackRate: 0.01, reduceOnly: true }, ctx);
    // one bar: open 50,000 → high 51,000 → low 49,000: the stop sits at 50,490 after the high
    for (const [from, to] of [[50000, 51000], [51000, 49000]]) {
      m.px = to;
      rt.onPrice('BTCUSDT', { from, to, volume: 1, t: m.t }, ctx, 'path');
    }
    expect(o.status).toBe('filled');
    expect(o.avgFillPrice).toBeCloseTo(50490, 6);
  });
});

describe('AccountRuntime break-even price and margin ratio', () => {
  it("matches Binance's break-even example (fees paid, partial close; funding left out)", () => {
    const { rt, ctx, m } = setup();
    rt.config.costs = { ...rt.config.costs, makerFee: 0.0002, takerFee: 0.0002 };
    for (const [px, qty] of [[20000, 0.5], [22000, 1.5], [25000, 0.5]]) {
      m.px = px;
      rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty }, ctx);
    }
    // (10,000 + 33,000 + 12,500 + 11.1 fees) / 2.5
    expect(rt.snapshot(ctx).positions[0].breakEven).toBeCloseTo(22204.44, 2);
    m.px = 25000;
    rt.closePosition('BTCUSDT', ctx, 0.5);
    // (55,511.1 + 2.5 − 12,500) / 2
    expect(rt.snapshot(ctx).positions[0].breakEven).toBeCloseTo(21506.8, 2);
  });

  it('puts a short break-even below the entry by the fees', () => {
    const { rt, ctx } = setup();
    rt.config.costs = { ...rt.config.costs, makerFee: 0.0002, takerFee: 0.0005 };
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 1 }, ctx);
    const p = rt.snapshot(ctx).positions[0];
    expect(p.breakEven).toBeCloseTo(50000 - 25, 6);
  });

  it("uses the account's ratio for cross and the position's own for isolated", () => {
    const { rt, ctx, tick } = setup();
    rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, ctx);
    tick(48000);
    const s = rt.snapshot(ctx);
    expect(s.positions[0].marginRatio).toBe(s.marginRatio);
    expect(s.marginRatio).toBeGreaterThan(0);
    // isolated: maintenance margin / (isolated margin + unrealised P&L)
    const iso = setup();
    iso.rt.config.futures.marginModes = { BTCUSDT: 'isolated' };
    iso.rt.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1 }, iso.ctx);
    iso.tick(48000);
    const q = iso.rt.snapshot(iso.ctx);
    const p = q.positions[0];
    expect(p.marginMode).toBe('isolated');
    expect(p.marginRatio).toBeCloseTo(p.maintMargin / (p.isolatedMargin + p.uPnl), 12);
    expect(q.marginRatio).toBe(0);
  });
});

describe('TWAP orders', () => {
  const futSpec = { stepSize: 0.001, minQty: 0.001, minNotional: 50 };

  it('plans an order every 10 s or more, fewer when they would be too small', () => {
    expect(twapPlan(1, 3600000, 50000, futSpec)).toMatchObject({ slices: 120, intervalMs: 30000 });
    expect(twapPlan(1, 5 * 60000, 50000, futSpec)).toMatchObject({ slices: 30, intervalMs: 10000 });
    // 0.004 BTC is worth 200 USDT: four orders of 50 at most
    expect(twapPlan(0.004, 3600000, 50000, futSpec)).toMatchObject({ slices: 4, intervalMs: 900000 });
    expect(twapPlan(0.001, 3600000, 50000, futSpec)).toHaveProperty('error');
    expect(twapPlan(1, 60000, 50000, futSpec)).toHaveProperty('error');
  });

  it('executes the quantity in equal market orders on schedule and finishes exactly', () => {
    const { rt, ctx, m } = setup();
    const a = rt.placeTwap({ symbol: 'BTCUSDT', side: 'buy', qty: 0.1, durationMs: 5 * 60000 }, ctx);
    // the first order goes at once
    expect(a.done).toBe(1);
    expect(rt.ledger.signedQty('BTCUSDT')).toBeCloseTo(0.003, 9);
    m.t += 5000;
    rt.stepAlgos(ctx);
    expect(a.done).toBe(1);
    for (let k = 0; k < 40; k++) {
      m.t += 10000;
      rt.stepAlgos(ctx);
    }
    expect(a.status).toBe('finished');
    expect(a.done).toBe(30);
    expect(a.filled).toBeCloseTo(0.1, 9);
    expect(rt.ledger.signedQty('BTCUSDT')).toBeCloseTo(0.1, 9);
    expect(a.avgPrice).toBeCloseTo(50000, 6);
    // equal orders: 0.003 or 0.004 each
    const sizes = rt.fills.map((f) => f.qty);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(0.001 + 1e-9);
  });

  it('stops when canceled, ends a reduce-only TWAP when the position is gone, and resumes after a pause', () => {
    const { rt, ctx, m } = setup();
    const a = rt.placeTwap({ symbol: 'BTCUSDT', side: 'buy', qty: 0.1, durationMs: 5 * 60000 }, ctx);
    m.t += 10000;
    rt.stepAlgos(ctx);
    expect(rt.cancelAlgo(a.id)).toBe(true);
    m.t += 60000;
    rt.stepAlgos(ctx);
    expect(a.status).toBe('canceled');
    expect(a.done).toBe(2);
    // reduce-only: sell 0.1 over 5 min against the 0.006 long; it ends when the long is closed
    const r = rt.placeTwap({ symbol: 'BTCUSDT', side: 'sell', qty: 0.1, durationMs: 5 * 60000, reduceOnly: true }, ctx);
    for (let k = 0; k < 5; k++) {
      m.t += 10000;
      rt.stepAlgos(ctx);
    }
    expect(rt.ledger.signedQty('BTCUSDT')).toBeCloseTo(0, 9);
    expect(r.status).toBe('finished');
    // a pause (app closed): the schedule continues from now instead of catching up at once
    const p = rt.placeTwap({ symbol: 'BTCUSDT', side: 'buy', qty: 0.1, durationMs: 5 * 60000 }, ctx);
    m.t += 30 * 60000;
    rt.stepAlgos(ctx);
    expect(p.done).toBe(2);
    expect(p.note).toMatch(/resumed/);
    expect(p.endsAt).toBeGreaterThan(m.t);
  });
});
