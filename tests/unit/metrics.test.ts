import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/engine/backtest/metrics';
import { runPine } from '../../src/engine/pine';
import type { StrategyRaw, TradeRec } from '../../src/engine/types';
import { bars, ctx } from '../helpers/bars';

const H = 3600000;

function trade(entryBar: number, exitBar: number, profit: number, dir: 1 | -1 = 1): TradeRec {
  return { entryId: 'L', exitId: 'x', dir, qty: 1, entryPrice: 100, exitPrice: 100 + profit * dir, entryBar, exitBar, entryTime: 0, exitTime: 0, profit, commission: 1, funding: 0, returnPct: profit, mae: 0, mfe: 0, cumProfit: 0 };
}

describe('backtest metrics', () => {
  it('computes trade statistics, drawdown, exposure and buy & hold', () => {
    const n = 72;
    const data = bars(n, (i) => 100 + (20 * i) / n, Date.UTC(2026, 2, 1), H);
    const equity = new Float64Array(n);
    for (let i = 0; i < n; i++) equity[i] = i <= 10 ? 1000 + i * 10 : i <= 30 ? 1100 - (i - 10) * 5.5 : i <= 60 ? 990 + (i - 30) * 2 : 1050;
    const raw: StrategyRaw = {
      trades: [trade(0, 10, 100), trade(20, 30, -110), trade(40, 60, 60, -1)],
      openTrades: [],
      equity,
      fills: [],
      initialCapital: 1000,
      feesPaid: 3,
      fundingPaid: 0,
      borrowPaid: 0,
      liquidations: 0,
      warnings: [],
      ticksUsedBars: 0,
      config: {},
    };
    const m = computeMetrics(raw, data);
    expect(m.netProfit).toBe(50);
    expect(m.all.trades).toBe(3);
    expect(m.all.winRate).toBeCloseTo(2 / 3, 12);
    expect(m.all.profitFactor).toBeCloseTo(160 / 110, 12);
    expect(m.all.largestWin).toBe(100);
    expect(m.all.largestLoss).toBe(-110);
    expect(m.all.maxConsecWins).toBe(1);
    expect(m.long.trades).toBe(2);
    expect(m.short.trades).toBe(1);
    expect(m.maxDrawdown).toBeCloseTo(110, 9);
    expect(m.maxDrawdownPct).toBeCloseTo(10, 9);
    expect(m.exposure).toBeCloseTo(((10 + 10 + 20) / 72) * 100, 9);
    expect(m.buyHold.returnPct).toBeCloseTo((data.c[n - 1] / data.o[0] - 1) * 100, 9);
    expect(m.monthly).toEqual([{ year: 2026, month: 2, returnPct: expect.closeTo(5, 9) }]);
    expect(m.curves.equity.length).toBe(n);
    expect(m.days).toBeCloseTo(3, 9);
  });

  it('agrees with the broker on a real strategy run (net profit = closed trades, equity consistent)', () => {
    const data = bars(1500, (i) => 100 + Math.sin(i / 25) * 8 + Math.sin(i / 7) * 2, Date.UTC(2026, 0, 1), H);
    const r = runPine(
      `//@version=6
strategy("x", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1)
f = ta.ema(close, 8)
s = ta.ema(close, 30)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.entry("S", strategy.short)
if bar_index == last_bar_index
    strategy.close_all(immediately=true)`,
      { data, ctx, inputs: {}, strategy: { market: 'futures', leverage: 1 } },
    );
    expect(r.error).toBeUndefined();
    const m = computeMetrics(r.strategy!, data);
    const sum = r.strategy!.trades.reduce((a, t) => a + t.profit, 0);
    expect(m.netProfit).toBeCloseTo(sum, 9);
    expect(m.all.trades).toBeGreaterThan(10);
    expect(m.finalEquity - m.initialCapital).toBeCloseTo(sum, 6);
    expect(m.long.trades + m.short.trades).toBe(m.all.trades);
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(m.yearly.length).toBe(1);
    expect(m.monthly.length).toBe(3);
    const reg = m.regimes.filter((x) => x.group === 'volatility');
    expect(reg.reduce((a, x) => a + x.bars, 0)).toBeLessThanOrEqual(m.bars);
  });

  it('ignores orders during warm-up (tradeFrom) and evaluates from that bar', () => {
    const data = bars(400, (i) => 100 + Math.sin(i / 10) * 5, Date.UTC(2026, 0, 1), H);
    const code = `//@version=6
strategy("x", initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
if ta.crossover(close, ta.sma(close, 20))
    strategy.entry("L", strategy.long)
if ta.crossunder(close, ta.sma(close, 20))
    strategy.close("L")`;
    const r = runPine(code, { data, ctx, inputs: {}, strategy: { tradeFrom: 200 } });
    expect(r.strategy!.trades.every((t) => t.entryBar > 200)).toBe(true);
    const m = computeMetrics(r.strategy!, data, { from: 200 });
    expect(m.bars).toBe(200);
    expect(m.curves.t[0]).toBe(data.t[200]);
  });
});

describe('broker fill data (Heikin-Ashi on real OHLC)', () => {
  it('fills and values equity on fillData while the script sees synthetic bars', () => {
    const real = bars(300, (i) => 100 + Math.sin(i / 9) * 6, Date.UTC(2026, 0, 1), H);
    const synth = { ...real, o: real.o.map((x) => x + 50), h: real.h.map((x) => x + 50), l: real.l.map((x) => x + 50), c: real.c.map((x) => x + 50) };
    const code = `//@version=6
strategy("x", initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index % 40 == 5
    strategy.entry("L", strategy.long)
if bar_index % 40 == 25
    strategy.close("L")`;
    const r = runPine(code, { data: synth, ctx, inputs: {}, strategy: { fillData: real, makerFee: 0, takerFee: 0 } });
    const t0 = r.strategy!.trades[0];
    expect(t0.entryPrice).toBe(real.o[t0.entryBar]);
    expect(t0.exitPrice).toBe(real.o[t0.exitBar]);
    expect(r.strategy!.config.fillData).toBe('real OHLC');
    expect(r.strategy!.equity[299]).toBeLessThan(100000 + 1000);
  });
});
