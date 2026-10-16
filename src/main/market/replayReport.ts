/**
 * Replay session report: how the user traded during a replay (from its start or last jump to the
 * cursor) — P&L, win rate, profit factor, closed-trade drawdown, holding times — against buy & hold
 * of the instrument and against random twins of the same trades (same sizes, holding times and
 * costs at random times), so practice shows whether the entries had an edge or were luck.
 */
import type { ClosedTrade } from '../../shared/trading/types';
import type { Market, SymbolId } from '../../shared/symbols';
import { fromCandles } from '../../engine/data';
import { randomBenchmark, type RandomBenchmark } from '../../engine/backtest/benchmarks';
import type { BarSeries } from '../../engine/types';
import type { AppCore } from '../core';

export interface ReplayReportTrade {
  market: Market;
  symbol: SymbolId;
  side: 'long' | 'short';
  qty: number;
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  returnPct: number;
}

export interface ReplayReport {
  from: number;
  to: number;
  trades: ReplayReportTrade[];
  summary: {
    count: number;
    wins: number;
    winRate: number;
    net: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    best: number;
    worst: number;
    avgHoldMs: number;
    fees: number;
    equityStart: number;
    equityEnd: number;
    returnPct: number;
    /** Largest drop of the realised P&L from its peak, % of the starting equity. */
    maxClosedDrawdownPct: number;
  };
  instrument: { symbol: SymbolId; market: Market } | null;
  buyHoldPct: number | null;
  random: RandomBenchmark | null;
}

const IV: [string, number][] = [
  ['1m', 60000],
  ['5m', 300000],
  ['15m', 900000],
  ['1h', 3600000],
  ['4h', 14400000],
  ['1d', 86400000],
];

/** Index of the bar containing time `t` (bars sorted by open time). */
function barAt(t: Float64Array, time: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (t[m] <= time) lo = m;
    else hi = m - 1;
  }
  return lo;
}

export interface ReplayReportInput {
  from: number;
  to: number;
  /** Closed trades of this replay per market, with the account's equity when the replay began. */
  accounts: { market: Market; trades: ClosedTrade[]; equityStart: number; equityEnd: number; feesPaid: number; costPerSide: number }[];
}

export async function buildReplayReport(core: AppCore, inp: ReplayReportInput): Promise<ReplayReport> {
  const trades: ReplayReportTrade[] = [];
  for (const a of inp.accounts)
    for (const t of a.trades) {
      if (t.closedAt < inp.from || t.closedAt > inp.to + 1) continue;
      trades.push({ market: a.market, symbol: t.symbol, side: t.side === 1 ? 'long' : 'short', qty: t.qty, entry: t.entry, exit: t.exit, openedAt: t.openedAt, closedAt: t.closedAt, pnl: t.pnl, returnPct: t.returnPct });
    }
  trades.sort((a, b) => a.closedAt - b.closedAt);
  const equityStart = inp.accounts.reduce((s, a) => s + a.equityStart, 0);
  const equityEnd = inp.accounts.reduce((s, a) => s + a.equityEnd, 0);
  let gp = 0;
  let gl = 0;
  let wins = 0;
  let hold = 0;
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      gp += t.pnl;
      wins++;
    } else gl -= t.pnl;
    hold += t.closedAt - t.openedAt;
    cum += t.pnl;
    peak = Math.max(peak, cum);
    mdd = Math.max(mdd, peak - cum);
  }
  const n = trades.length;
  const losses = n - wins;
  const summary: ReplayReport['summary'] = {
    count: n,
    wins,
    winRate: n ? wins / n : 0,
    net: gp - gl,
    grossProfit: gp,
    grossLoss: gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgWin: wins ? gp / wins : 0,
    avgLoss: losses ? -gl / losses : 0,
    best: n ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worst: n ? Math.min(...trades.map((t) => t.pnl)) : 0,
    avgHoldMs: n ? hold / n : 0,
    fees: inp.accounts.reduce((s, a) => s + a.feesPaid, 0),
    equityStart,
    equityEnd,
    returnPct: equityStart > 0 ? (equityEnd / equityStart - 1) * 100 : 0,
    maxClosedDrawdownPct: equityStart > 0 ? (mdd / equityStart) * 100 : 0,
  };
  const report: ReplayReport = { from: inp.from, to: inp.to, trades: trades.slice(-300), summary, instrument: null, buyHoldPct: null, random: null };
  if (!n || !(inp.to > inp.from)) return report;

  // the instrument traded most
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(`${t.market}:${t.symbol}`, (counts.get(`${t.market}:${t.symbol}`) || 0) + 1);
  const [key] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [market, symbol] = key.split(':') as [Market, SymbolId];
  report.instrument = { symbol, market };
  const span = inp.to - inp.from;
  const [iv] = IV.find(([, ms]) => span / ms <= 5000) || IV[IV.length - 1];
  let bars: BarSeries;
  try {
    bars = fromCandles(await core.store.get('klines', market, symbol, iv, inp.from, inp.to), iv, 'candles');
  } catch {
    return report;
  }
  if (bars.length < 3) return report;
  report.buyHoldPct = (bars.c[bars.length - 1] / bars.o[0] - 1) * 100;

  // the user's trades on this instrument, marked to market like the random twins
  const mine = trades.filter((t) => t.market === market && t.symbol === symbol && t.openedAt >= bars.t[0]);
  if (mine.length < 3) return report;
  const acct = inp.accounts.find((a) => a.market === market)!;
  const rbTrades = mine.map((t) => ({ entryBar: barAt(bars.t, t.openedAt), exitBar: Math.max(barAt(bars.t, t.openedAt), barAt(bars.t, t.closedAt)), dir: (t.side === 'long' ? 1 : -1) as 1 | -1, qty: t.qty, entryPrice: t.entry, exitPrice: t.exit, profit: t.pnl }));
  const init = acct.equityStart;
  const equity = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    let e = init;
    for (const t of rbTrades) {
      if (i >= t.exitBar) e += t.profit;
      else if (i >= t.entryBar) e += t.qty * t.dir * (bars.c[i] - t.entryPrice);
    }
    equity[i] = e;
  }
  report.random = randomBenchmark({ t: bars.t, o: bars.o, c: bars.c, from: 0, to: bars.length - 1, trades: rbTrades, equity, initialCapital: init, costPerSide: acct.costPerSide, iterations: 1000 });
  return report;
}
