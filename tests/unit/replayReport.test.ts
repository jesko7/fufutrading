import { describe, it, expect } from 'vitest';
import { buildReplayReport } from '../../src/main/market/replayReport';
import { CandleSeries } from '../../src/shared/candles';
import type { ClosedTrade } from '../../src/shared/trading/types';

const MIN = 60000;
const T0 = Date.UTC(2026, 3, 6, 0, 0);

/** A fake core whose candle store serves a gently rising market of 1-minute klines. */
function fakeCore() {
  return {
    store: {
      get: async (_kind: string, _m: string, _s: string, iv: string, from: number, to: number) => {
        const ms = iv === '1m' ? MIN : iv === '5m' ? 5 * MIN : 60 * MIN;
        const cs = new CandleSeries(4096);
        for (let t = Math.floor(from / ms) * ms; t < to; t += ms) {
          const k = (t - T0) / MIN;
          const o = 100 + k * 0.01 + Math.sin(k / 15);
          const c = 100 + (k + 1) * 0.01 + Math.sin((k + 1) / 15);
          cs.push(t, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, 1);
        }
        return cs;
      },
    },
  } as any;
}

function trade(i: number, side: 1 | -1, entry: number, exit: number, openMin: number, holdMin: number): ClosedTrade {
  const qty = 10;
  const pnl = (exit - entry) * qty * side;
  return { id: `t${i}`, symbol: 'BTCUSDT', market: 'spot', side, qty, entry, exit, openedAt: T0 + openMin * MIN, closedAt: T0 + (openMin + holdMin) * MIN, pnl, fees: 0, funding: 0, returnPct: (pnl / (entry * qty)) * 100, mae: 0, mfe: 0, leverage: 1 } as ClosedTrade;
}

describe('replay session report', () => {
  it('summarises the trades and compares them with buy & hold and random twins', async () => {
    const trades = [trade(1, 1, 100.2, 101.0, 20, 30), trade(2, 1, 101.5, 101.2, 80, 20), trade(3, 1, 100.8, 102.1, 130, 40), trade(4, 1, 101.9, 102.6, 200, 25), trade(5, 1, 102.0, 101.7, 260, 15), trade(6, 1, 101.0, 101.9, 300, 30), trade(7, 1, 102.2, 102.9, 360, 20)];
    const net = trades.reduce((s, t) => s + t.pnl, 0);
    const rep = await buildReplayReport(fakeCore(), { from: T0, to: T0 + 400 * MIN, accounts: [{ market: 'spot', trades, equityStart: 10000, equityEnd: 10000 + net, feesPaid: 3, costPerSide: 0.001 }] });
    expect(rep.summary.count).toBe(7);
    expect(rep.summary.wins).toBe(5);
    expect(rep.summary.net).toBeCloseTo(net, 9);
    expect(rep.summary.profitFactor).toBeCloseTo((net + 6) / 6, 6);
    expect(rep.summary.avgHoldMs).toBeCloseTo((180 / 7) * MIN, 0);
    expect(rep.summary.maxClosedDrawdownPct).toBeCloseTo((3 / 10000) * 100, 9);
    expect(rep.instrument).toEqual({ symbol: 'BTCUSDT', market: 'spot' });
    expect(rep.buyHoldPct).not.toBeNull();
    expect(rep.random).not.toBeNull();
    expect(rep.random!.trades).toBe(7);
    expect(rep.random!.direction).toBeNull(); // long only
    // the user's equity ends where the trades put it (marked like the twins)
    const c = rep.random!.curves;
    expect(c.strategy[c.strategy.length - 1]).toBeCloseTo((net / 10000) * 100, 1);
  });

  it('reports an empty session without comparisons', async () => {
    const rep = await buildReplayReport(fakeCore(), { from: T0, to: T0 + 60 * MIN, accounts: [{ market: 'spot', trades: [], equityStart: 10000, equityEnd: 10000, feesPaid: 0, costPerSide: 0.001 }] });
    expect(rep.summary.count).toBe(0);
    expect(rep.random).toBeNull();
    expect(rep.buyHoldPct).toBeNull();
  });
});
