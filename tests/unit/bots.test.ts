import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPine } from '../../src/engine/pine';
import { ScriptHost, botStep, type BotStepResult } from '../../src/engine/host';
import type { BrokerConfig } from '../../src/engine/backtest/broker';
import type { BarSeries, RunContext } from '../../src/engine/types';
import { planBot, scaleFor, BOT_TAG, type BotPlanInput } from '../../src/shared/trading/botPlan';
import { AccountRuntime, type MarketCtx } from '../../src/shared/trading/account';
import { newAccountConfig } from '../../src/shared/trading/presets';
import { barPath } from '../../src/shared/trading/matching';
import { SYMBOL_SPECS, type Market } from '../../src/shared/symbols';
import type { BotConfig } from '../../src/shared/trading/types';
import { bars, ctx } from '../helpers/bars';

const root = path.resolve(__dirname, '../..');

function sub(b: BarSeries, n: number): BarSeries {
  return { t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n), tc: b.tc.slice(0, n), length: n };
}

const ENTRY_WITH_BRACKETS = `//@version=6
strategy("t", overlay=true, default_qty_type=strategy.fixed, default_qty_value=2)
if bar_index == 10
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", profit=500, loss=300)
`;

describe('StrategyBroker snapshot for bots', () => {
  it('fills market orders of the last bar at its close and exposes concrete exit levels', () => {
    const data = sub(bars(200), 11);
    const plain = runPine(ENTRY_WITH_BRACKETS, { data, ctx, inputs: {} });
    expect(plain.strategy!.position).toBe(0);
    expect(plain.strategy!.pending).toEqual([]);
    const live = runPine(ENTRY_WITH_BRACKETS, { data, ctx, inputs: {}, bot: true });
    const st = live.strategy!;
    expect(st.position).toBe(2);
    expect(st.avgPrice).toBeCloseTo(data.c[10], 9);
    // the virtual fill happens at the bar close = next bar open
    expect(st.fills.at(-1)!.t).toBe(data.tc[10]);
    expect(st.pending).toHaveLength(1);
    const x = st.pending![0];
    expect(x).toMatchObject({ id: 'X', kind: 'exit', side: -1, closeQty: 2, openQty: 0, closeAll: true });
    expect(x.limit).toBeCloseTo(data.c[10] + 5, 9);
    expect(x.stop).toBeCloseTo(data.c[10] - 3, 9);
  });

  it('reports resting limit entries with resolved quantities, reversals split into close and open parts', () => {
    const data = sub(bars(200), 12);
    const code = `//@version=6
strategy("t", overlay=true, default_qty_type=strategy.fixed, default_qty_value=3)
if bar_index == 9
    strategy.entry("S", strategy.short)
if bar_index == 11
    strategy.entry("L", strategy.long, limit=close - 4)
`;
    const r = runPine(code, { data, ctx, inputs: {}, bot: true, strategy: { market: 'futures', leverage: 1 } });
    const st = r.strategy!;
    expect(st.position).toBeCloseTo(-3, 9);
    expect(st.pending).toHaveLength(1);
    expect(st.pending![0]).toMatchObject({ id: 'L', kind: 'entry', side: 1, closeQty: 3, openQty: 3 });
    expect(st.pending![0].limit).toBeCloseTo(data.c[11] - 4, 9);
  });
});

function input(over: Partial<BotPlanInput> = {}): BotPlanInput {
  return {
    market: 'spot',
    symbol: 'BTCUSDT',
    filters: SYMBOL_SPECS.BTCUSDT.spot,
    price: 100,
    equity: 10000,
    leverage: 1,
    sizing: { mode: 'percentEquity', value: 10 },
    scale: null,
    hold: null,
    sim: { position: 0, pending: [] },
    prevSimPos: null,
    prevTarget: null,
    actual: 0,
    orders: [],
    ...over,
  };
}

const EXIT = { id: 'X', kind: 'exit' as const, side: -1 as const, closeQty: 2, openQty: 0, closeAll: true, limit: 105, stop: 97 };

describe('bot planner', () => {
  it('sizes a new position from the sizing rule and mirrors its exit brackets', () => {
    const p = planBot(input({ sim: { position: 2, pending: [EXIT] } }));
    // 10% of 10,000 USDT at 100 = 10 units for a simulated 2 → scale 5
    expect(p.scale).toEqual({ k: 5, dir: 1 });
    expect(p.target).toBe(10);
    expect(p.market).toMatchObject({ side: 'buy', type: 'market', qty: 10 });
    expect(p.place.map((o) => [o.type, o.side, o.qty, o.price ?? o.stopPrice, o.reduceOnly, o.closePosition, o.tag])).toEqual([
      ['limit', 'sell', 10, 105, true, true, `${BOT_TAG}X|tp`],
      ['stop', 'sell', 10, 97, true, true, `${BOT_TAG}X|sl`],
    ]);
  });

  it('keeps matching orders and replaces changed ones', () => {
    const orders = [
      { id: 'o1', tag: `${BOT_TAG}X|tp`, type: 'limit' as const, side: 'sell' as const, qty: 10, price: 105, reduceOnly: true, closePosition: true },
      { id: 'o2', tag: `${BOT_TAG}X|sl`, type: 'stop' as const, side: 'sell' as const, qty: 10, stopPrice: 96, reduceOnly: true, closePosition: true },
      { id: 'o3', tag: `${BOT_TAG}old|e`, type: 'limit' as const, side: 'buy' as const, qty: 1, price: 90, reduceOnly: false },
    ];
    const p = planBot(input({ sim: { position: 2, pending: [EXIT] }, scale: { k: 5, dir: 1 }, actual: 10, prevSimPos: 2, prevTarget: 10, orders }));
    expect(p.market).toBeNull();
    expect(p.cancel.map((c) => c.id).sort()).toEqual(['o2', 'o3']);
    expect(p.place.map((o) => o.tag)).toEqual([`${BOT_TAG}X|sl`]);
    expect(p.place[0].stopPrice).toBe(97);
  });

  it('executes a stop at market when the price already crossed it', () => {
    const p = planBot(input({ price: 96, sim: { position: 2, pending: [EXIT] }, scale: { k: 5, dir: 1 }, actual: 10, prevSimPos: 2, prevTarget: 10 }));
    const sl = p.place.find((o) => o.tag === `${BOT_TAG}X|sl`)!;
    expect(sl.type).toBe('market');
    expect(sl.reduceOnly).toBe(true);
  });

  it('does not re-enter a position that was closed outside the strategy', () => {
    const p = planBot(input({ sim: { position: 2, pending: [EXIT] }, scale: { k: 5, dir: 1 }, actual: 0, prevSimPos: 2, prevTarget: 10 }));
    expect(p.hold).toEqual({ simPos: 2 });
    expect(p.target).toBe(0);
    expect(p.market).toBeNull();
    expect(p.place).toEqual([]);
    expect(p.notes[0]).toMatch(/outside the strategy/);
    // the hold ends when the strategy's position changes
    const q = planBot(input({ sim: { position: 0, pending: [] }, hold: p.hold, scale: p.scale, actual: 0, prevSimPos: 2, prevTarget: 0 }));
    expect(q.hold).toBeNull();
    const r = planBot(input({ sim: { position: 3, pending: [] }, hold: null, actual: 0, prevSimPos: 0, prevTarget: 0 }));
    expect(r.market?.side).toBe('buy');
  });

  it('reverses futures positions with one order and a new scale', () => {
    const p = planBot(input({ market: 'futures', filters: SYMBOL_SPECS.BTCUSDT.futures, leverage: 5, sim: { position: -2, pending: [] }, scale: { k: 5, dir: 1 }, actual: 10, prevSimPos: 2, prevTarget: 10 }));
    // 10% of equity × 5x leverage = 5,000 USDT notional = 50 units for 2 simulated → scale 25
    expect(p.scale).toEqual({ k: 25, dir: -1 });
    expect(p.target).toBe(-50);
    expect(p.market).toMatchObject({ side: 'sell', qty: 60, why: 'reverse' });
    expect(p.market!.reduceOnly).toBeUndefined();
  });

  it('closes with closePosition when the strategy goes flat and skips orders below exchange minimums', () => {
    const p = planBot(input({ sim: { position: 0, pending: [] }, scale: { k: 5, dir: 1 }, actual: 10, prevSimPos: 2, prevTarget: 10 }));
    expect(p.market).toMatchObject({ side: 'sell', closePosition: true, reduceOnly: true });
    const tiny = planBot(input({ sizing: { mode: 'fixedUsd', value: 2 }, sim: { position: 1, pending: [] } }));
    expect(tiny.market).toBeNull();
    expect(tiny.notes[0]).toMatch(/below the minimum/);
  });

  it('never shorts on spot and mirrors limit entries with the entry scale', () => {
    const p = planBot(input({ sim: { position: -1, pending: [{ id: 'S', kind: 'entry', side: -1, closeQty: 0, openQty: 1, closeAll: false, limit: 110 }] } }));
    expect(p.target).toBe(0);
    expect(p.market).toBeNull();
    expect(p.place).toEqual([]);
    const q = planBot(input({ sizing: { mode: 'fixedQty', value: 0.5 }, sim: { position: 0, pending: [{ id: 'L', kind: 'entry', side: 1, closeQty: 0, openQty: 2, closeAll: false, limit: 95 }] } }));
    expect(q.place).toHaveLength(1);
    expect(q.place[0]).toMatchObject({ type: 'limit', side: 'buy', qty: 0.5, price: 95, tag: `${BOT_TAG}L|e` });
  });

  it('computes scales for every sizing mode', () => {
    expect(scaleFor({ mode: 'strategy', value: 1 }, 3, 100, 1e4, 1, 'spot')).toBe(1);
    expect(scaleFor({ mode: 'strategy', value: 0.5 }, 3, 100, 1e4, 1, 'spot')).toBe(0.5);
    expect(scaleFor({ mode: 'fixedUsd', value: 1000 }, 2, 100, 1e4, 1, 'spot')).toBe(5);
    expect(scaleFor({ mode: 'fixedQty', value: 4 }, 2, 100, 1e4, 1, 'spot')).toBe(2);
    expect(scaleFor({ mode: 'percentEquity', value: 50 }, 1, 100, 1e4, 3, 'futures')).toBe(150);
  });
});

/**
 * End-to-end: a bot following a strategy bar by bar on a paper account, with intrabar price paths
 * feeding the account's matching engine, must reproduce the strategy's own trades.
 */
async function runBot(code: string, inputs: Record<string, unknown>, data: BarSeries, o: { market: Market; startAt: number; sizing?: BotConfig['sizing']; preset?: string }) {
  const host = new ScriptHost(null);
  const cfg = newAccountConfig({ id: 'bot1', name: 'bot', kind: 'bot', market: o.market, initialBalance: 10000, costPreset: o.preset || 'zero', futures: { defaultLeverage: 1 } });
  const rt = new AccountRuntime(cfg);
  let last = data.o[0];
  let now = data.t[0];
  const mctx: MarketCtx = { now: () => now, last: () => last, mark: () => last };
  const rctx: RunContext = { ...ctx, market: o.market };
  const f = SYMBOL_SPECS.BTCUSDT[o.market];
  const broker: Partial<BrokerConfig> = { market: o.market, initialCapital: 10000, leverage: 1, makerFee: cfg.costs.makerFee, takerFee: cfg.costs.takerFee, flatFee: 0, slippageBps: 0, step: f.stepSize, minQty: f.minQty, limitFill: cfg.execution.limitFill, throughTicks: cfg.execution.throughTicks, tradeFrom: o.startAt };
  const st: { scale: BotPlanInput['scale']; hold: BotPlanInput['hold']; prevSimPos: number | null; prevTarget: number | null } = { scale: null, hold: null, prevSimPos: null, prevTarget: null };
  let res: BotStepResult | null = null;
  const errors: string[] = [];
  for (let i = 0; i < data.length; i++) {
    const p = barPath(data.o[i], data.h[i], data.l[i], data.c[i]);
    for (let k = 1; k < p.length; k++) {
      last = p[k];
      now = data.t[i] + k * 1000;
      rt.onPrice('BTCUSDT', { from: p[k - 1], to: p[k], volume: data.v[i] / 3, t: now }, mctx, 'path');
    }
    if (i < o.startAt) continue;
    now = data.tc[i];
    last = data.c[i];
    res = await botStep(host, { lang: 'pine', code, ctx: rctx, inputs, strategy: broker, data: sub(data, i + 1), since: 0 });
    expect(res.ok, res.error).toBe(true);
    const plan = planBot({ market: o.market, symbol: 'BTCUSDT', filters: f, price: last, equity: rt.snapshot(mctx).equity, leverage: 1, sizing: o.sizing || { mode: 'strategy', value: 1 }, ...st, sim: { position: res.position, pending: res.pending }, actual: rt.ledger.signedQty('BTCUSDT'), orders: rt.orders.filter((x) => x.source === 'bot').map((x) => ({ id: x.id, tag: x.tag, type: x.type, side: x.side, qty: x.qty, price: x.price, stopPrice: x.stopPrice, reduceOnly: x.reduceOnly, closePosition: x.closePosition })) });
    for (const c of plan.cancel) rt.cancelOrder(c.id, now);
    for (const req of [...(plan.market ? [plan.market] : []), ...plan.place]) {
      try {
        rt.placeOrder({ ...req, source: 'bot' }, mctx);
      } catch (e) {
        errors.push(`bar ${i}: ${(e as Error).message}`);
      }
    }
    st.scale = plan.scale;
    st.hold = plan.hold;
    st.prevSimPos = res.position;
    st.prevTarget = plan.target;
  }
  return { rt, res: res!, errors };
}

describe('bot following a strategy on a paper account', () => {
  // prices on the 0.01 tick grid like real market data
  const data = bars(700, (i) => Math.round((100 + Math.sin(i / 9) * 8 + Math.sin(i / 31) * 5 + i * 0.01) * 100) / 100);

  it('reproduces a reversing MA-cross strategy trade for trade (futures, no costs)', async () => {
    const code = fs.readFileSync(path.join(root, 'src/engine/library/strat_ma_cross.pine'), 'utf8');
    const { rt, res, errors } = await runBot(code, { fastLen: 5, slowLen: 15, allowShort: true }, data, { market: 'futures', startAt: 100 });
    expect(errors).toEqual([]);
    const sim = res.trades.filter((t) => t.entryTime >= data.t[100]);
    expect(sim.length).toBeGreaterThan(8);
    // the last simulated trade closes at the final bar's close (reversal), open ones are still open
    const real = rt.trades;
    expect(real.length).toBe(sim.length);
    for (let k = 0; k < sim.length; k++) {
      expect(real[k].side, `trade ${k}`).toBe(sim[k].dir);
      expect(real[k].entry, `entry ${k}`).toBeCloseTo(sim[k].entryPrice, 6);
      expect(real[k].exit, `exit ${k}`).toBeCloseTo(sim[k].exitPrice, 6);
      expect(real[k].qty, `qty ${k}`).toBeCloseTo(sim[k].qty, 6);
    }
    expect(rt.ledger.signedQty('BTCUSDT')).toBeCloseTo(res.position, 6);
  });

  it('mirrors take-profit and stop-loss brackets intrabar (spot)', async () => {
    const code = `//@version=6
strategy("Brackets", overlay=true, default_qty_type=strategy.fixed, default_qty_value=1)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
strategy.exit("XL", "L", profit=300, loss=200)
`;
    const { rt, res, errors } = await runBot(code, {}, data, { market: 'spot', startAt: 50 });
    expect(errors).toEqual([]);
    const sim = res.trades.filter((t) => t.entryTime >= data.t[50]);
    expect(sim.length).toBeGreaterThan(4);
    const real = rt.trades;
    expect(real.length).toBe(sim.length);
    for (let k = 0; k < sim.length; k++) {
      expect(real[k].exit, `exit ${k}`).toBeCloseTo(sim[k].exitPrice, 6);
      expect(real[k].pnl, `pnl ${k}`).toBeCloseTo(sim[k].profit, 6);
    }
    // exits filled by the account's matching engine as resting orders, not at bar closes
    const exitFills = rt.fills.filter((fl) => fl.side === 'sell');
    expect(exitFills.some((fl) => !data.c.includes(fl.price))).toBe(true);
  });

  it('scales quantities with the sizing rule while keeping the same trades', async () => {
    const code = fs.readFileSync(path.join(root, 'src/engine/library/strat_ma_cross.pine'), 'utf8');
    const { rt, res } = await runBot(code, { fastLen: 5, slowLen: 15, allowShort: false }, data, { market: 'spot', startAt: 100, sizing: { mode: 'fixedUsd', value: 1000 } });
    const sim = res.trades.filter((t) => t.entryTime >= data.t[100]);
    expect(rt.trades.length).toBe(sim.length);
    for (let k = 0; k < sim.length; k++) expect(rt.trades[k].qty * rt.trades[k].entry).toBeLessThanOrEqual(1000 + 1e-6);
    expect(rt.trades.every((t) => t.qty * t.entry > 990)).toBe(true);
  });
});
