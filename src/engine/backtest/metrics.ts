/**
 * Backtest analytics: performance summary (TradingView-style definitions where they exist),
 * long/short breakdown, risk-adjusted ratios from daily equity returns, monthly/yearly
 * returns, buy & hold and cash benchmarks, and market-regime breakdowns.
 * Pure functions over the broker's raw output.
 */
import type { BarSeries, StrategyRaw, TradeRec } from '../types';

const DAY = 86400000;

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgTrade: number;
  avgTradePct: number;
  avgWin: number;
  avgLoss: number;
  ratioAvgWinLoss: number;
  largestWin: number;
  largestLoss: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  avgBarsInTrade: number;
  avgBarsWin: number;
  avgBarsLoss: number;
  expectancy: number;
  commission: number;
}

export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  netProfit: number;
  netProfitPct: number;
  openPnl: number;
  all: TradeStats;
  long: TradeStats;
  short: TradeStats;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxDrawdownDuration: number;
  maxRunup: number;
  maxRunupPct: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  volatility: number;
  exposure: number;
  feesPaid: number;
  fundingPaid: number;
  borrowPaid: number;
  liquidations: number;
  bars: number;
  days: number;
  start: number;
  end: number;
  buyHold: { returnPct: number; maxDrawdownPct: number; sharpe: number; finalEquity: number };
  cash: { returnPct: number; rateAnnual: number; finalEquity: number };
  monthly: { year: number; month: number; returnPct: number }[];
  yearly: { year: number; returnPct: number; buyHoldPct: number }[];
  regimes: RegimeStat[];
  /** Per-bar curves aligned to the analysed range. */
  curves: { t: Float64Array; equity: Float64Array; drawdownPct: Float64Array; buyHold: Float64Array };
}

export interface RegimeStat {
  group: 'trend' | 'volatility';
  name: string;
  bars: number;
  share: number;
  strategyReturnPct: number;
  buyHoldReturnPct: number;
  trades: number;
  winRate: number;
}

function tradeStats(trades: TradeRec[]): TradeStats {
  const n = trades.length;
  let wins = 0;
  let losses = 0;
  let gp = 0;
  let gl = 0;
  let net = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let cw = 0;
  let cl = 0;
  let mcw = 0;
  let mcl = 0;
  let bars = 0;
  let barsW = 0;
  let barsL = 0;
  let pct = 0;
  let comm = 0;
  for (const t of trades) {
    const p = t.profit;
    net += p;
    pct += t.returnPct;
    comm += t.commission;
    const b = t.exitBar - t.entryBar;
    bars += b;
    if (p > 0) {
      wins++;
      gp += p;
      barsW += b;
      largestWin = Math.max(largestWin, p);
      cw++;
      cl = 0;
      mcw = Math.max(mcw, cw);
    } else {
      losses++;
      gl += p;
      barsL += b;
      largestLoss = Math.min(largestLoss, p);
      cl++;
      cw = 0;
      mcl = Math.max(mcl, cl);
    }
  }
  const avgWin = wins ? gp / wins : 0;
  const avgLoss = losses ? gl / losses : 0;
  return {
    trades: n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    netProfit: net,
    grossProfit: gp,
    grossLoss: gl,
    profitFactor: gl < 0 ? gp / -gl : gp > 0 ? Infinity : 0,
    avgTrade: n ? net / n : 0,
    avgTradePct: n ? pct / n : 0,
    avgWin,
    avgLoss,
    ratioAvgWinLoss: avgLoss < 0 ? avgWin / -avgLoss : avgWin > 0 ? Infinity : 0,
    largestWin,
    largestLoss,
    maxConsecWins: mcw,
    maxConsecLosses: mcl,
    avgBarsInTrade: n ? bars / n : 0,
    avgBarsWin: wins ? barsW / wins : 0,
    avgBarsLoss: losses ? barsL / losses : 0,
    expectancy: n ? (wins / n) * avgWin + (losses / n) * avgLoss : 0,
    commission: comm,
  };
}

/** End-of-day equity values (UTC days) → daily returns. */
function dailyReturns(t: Float64Array, eq: Float64Array, from: number, to: number): number[] {
  const out: number[] = [];
  let prevDay = Math.floor(t[from] / DAY);
  let prevEq = eq[from];
  let lastEq = eq[from];
  for (let i = from + 1; i <= to; i++) {
    const d = Math.floor(t[i] / DAY);
    if (d !== prevDay) {
      if (prevEq > 0 && Number.isFinite(lastEq)) out.push(lastEq / prevEq - 1);
      prevEq = lastEq;
      prevDay = d;
    }
    if (Number.isFinite(eq[i])) lastEq = eq[i];
  }
  if (prevEq > 0 && Number.isFinite(lastEq) && lastEq !== prevEq) out.push(lastEq / prevEq - 1);
  return out;
}

function sharpeSortino(rets: number[], rfAnnual = 0): { sharpe: number; sortino: number; vol: number } {
  if (rets.length < 2) return { sharpe: 0, sortino: 0, vol: 0 };
  const rf = rfAnnual / 365;
  const ex = rets.map((r) => r - rf);
  const mean = ex.reduce((a, b) => a + b, 0) / ex.length;
  const sd = Math.sqrt(ex.reduce((a, b) => a + (b - mean) ** 2, 0) / (ex.length - 1));
  const down = Math.sqrt(ex.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / ex.length);
  const ann = Math.sqrt(365);
  return { sharpe: sd > 0 ? (mean / sd) * ann : 0, sortino: down > 0 ? (mean / down) * ann : 0, vol: sd * ann };
}

function sma(c: Float64Array, len: number, i: number, cache: { sum: number }): number {
  cache.sum += c[i];
  if (i >= len) cache.sum -= c[i - len];
  return i >= len - 1 ? cache.sum / len : NaN;
}

export interface MetricsOptions {
  /** First bar of the evaluated range (bars before are indicator warm-up). */
  from?: number;
  /** Annual risk-free / cash rate for Sharpe and the cash benchmark (fraction, e.g. 0.04). */
  riskFree?: number;
  /** Trend regime moving-average length (bars). */
  regimeMa?: number;
  /** Volatility regime window (bars). */
  regimeVol?: number;
}

export function computeMetrics(raw: StrategyRaw, data: BarSeries, opts: MetricsOptions = {}): Metrics {
  const n = data.length;
  const from = Math.max(0, Math.min(n - 1, opts.from ?? 0));
  const to = n - 1;
  const t = data.t;
  const init = raw.initialCapital;
  // equity curve (forward-filled; before the first value = initial capital)
  const m = Math.max(0, to - from + 1);
  const equity = new Float64Array(m);
  let last = init;
  for (let i = from; i <= to; i++) {
    const e = raw.equity[i];
    if (Number.isFinite(e)) last = e;
    equity[i - from] = last;
  }
  const finalEquity = m ? equity[m - 1] : init;
  // drawdown / run-up
  const ddPct = new Float64Array(m);
  let peak = init;
  let trough = init;
  let maxDd = 0;
  let maxDdPct = 0;
  let maxRun = 0;
  let maxRunPct = 0;
  let ddStart = 0;
  let maxDdDur = 0;
  for (let k = 0; k < m; k++) {
    const e = equity[k];
    if (e >= peak) {
      peak = e;
      ddStart = k;
    }
    const dd = peak - e;
    ddPct[k] = peak > 0 ? -dd / peak : 0;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
    if (k - ddStart > maxDdDur && dd > 0) maxDdDur = k - ddStart;
    // run-up: rise above the lowest equity seen so far
    if (e < trough) trough = e;
    const ru = e - trough;
    if (ru > maxRun) maxRun = ru;
    if (trough > 0 && ru / trough > maxRunPct) maxRunPct = ru / trough;
  }
  // buy & hold from the open of the first evaluated bar
  const bh = new Float64Array(m);
  const p0 = data.o[from] || data.c[from];
  let bhPeak = init;
  let bhMdd = 0;
  for (let k = 0; k < m; k++) {
    const v = p0 > 0 ? (init * data.c[from + k]) / p0 : init;
    bh[k] = v;
    if (v > bhPeak) bhPeak = v;
    if (bhPeak > 0) bhMdd = Math.max(bhMdd, (bhPeak - v) / bhPeak);
  }
  const ct = t.subarray(from, to + 1);
  const days = m ? Math.max(1 / 24, (data.tc[to] - t[from]) / DAY) : 0;
  const years = days / 365;
  const rets = m ? dailyReturns(ct, equity, 0, m - 1) : [];
  const ss = sharpeSortino(rets, opts.riskFree ?? 0);
  const bhRets = m ? dailyReturns(ct, bh, 0, m - 1) : [];
  const bhSS = sharpeSortino(bhRets, opts.riskFree ?? 0);
  const cagr = years > 0 && finalEquity > 0 ? Math.pow(finalEquity / init, 1 / years) - 1 : 0;
  // exposure: bars with an open position (between entry and exit bars)
  const inPos = new Uint8Array(n);
  for (const tr of raw.trades) for (let i = Math.max(from, tr.entryBar); i < Math.min(n, tr.exitBar); i++) inPos[i] = 1;
  for (const tr of raw.openTrades) for (let i = Math.max(from, tr.entryBar); i < n; i++) inPos[i] = 1;
  let exposed = 0;
  for (let i = from; i <= to; i++) exposed += inPos[i];
  const trades = raw.trades.filter((x) => x.exitBar >= from);
  const openPnl = raw.openTrades.reduce((a, x) => a + (data.c[to] - x.entryPrice) * x.qty * x.dir, 0);
  // monthly & yearly returns from month-end equity
  const monthly: Metrics['monthly'] = [];
  const yearly: Metrics['yearly'] = [];
  if (m) {
    let mStartEq = init;
    let yStartEq = init;
    let yStartBh = init;
    const first = new Date(ct[0]);
    let curKey = first.getUTCFullYear() * 12 + first.getUTCMonth();
    let curYear = first.getUTCFullYear();
    for (let k = 0; k < m; k++) {
      const d = new Date(ct[k]);
      const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (key !== curKey) {
        const e = equity[k - 1];
        monthly.push({ year: Math.floor(curKey / 12), month: curKey % 12, returnPct: mStartEq > 0 ? (e / mStartEq - 1) * 100 : 0 });
        mStartEq = e;
        curKey = key;
      }
      if (d.getUTCFullYear() !== curYear) {
        yearly.push({ year: curYear, returnPct: yStartEq > 0 ? (equity[k - 1] / yStartEq - 1) * 100 : 0, buyHoldPct: yStartBh > 0 ? (bh[k - 1] / yStartBh - 1) * 100 : 0 });
        yStartEq = equity[k - 1];
        yStartBh = bh[k - 1];
        curYear = d.getUTCFullYear();
      }
    }
    monthly.push({ year: Math.floor(curKey / 12), month: curKey % 12, returnPct: mStartEq > 0 ? (equity[m - 1] / mStartEq - 1) * 100 : 0 });
    yearly.push({ year: curYear, returnPct: yStartEq > 0 ? (equity[m - 1] / yStartEq - 1) * 100 : 0, buyHoldPct: yStartBh > 0 ? (bh[m - 1] / yStartBh - 1) * 100 : 0 });
  }
  // regimes
  const regimes: RegimeStat[] = [];
  if (m > 2) {
    const maLen = opts.regimeMa ?? 200;
    const volLen = opts.regimeVol ?? 50;
    const c = data.c;
    const cache = { sum: 0 };
    const ma = new Float64Array(n);
    for (let i = 0; i < n; i++) ma[i] = sma(c, maLen, i, cache);
    const vol = new Float64Array(n).fill(NaN);
    let s1 = 0;
    let s2 = 0;
    const lr = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      lr[i] = c[i - 1] > 0 ? Math.log(c[i] / c[i - 1]) : 0;
      s1 += lr[i];
      s2 += lr[i] * lr[i];
      if (i > volLen) {
        s1 -= lr[i - volLen];
        s2 -= lr[i - volLen] * lr[i - volLen];
      }
      if (i >= volLen) vol[i] = Math.sqrt(Math.max(0, s2 / volLen - (s1 / volLen) ** 2));
    }
    const vals = [...vol.subarray(from, to + 1)].filter(Number.isFinite).sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : NaN;
    const slope = (i: number) => (i >= 10 && Number.isFinite(ma[i]) && Number.isFinite(ma[i - 10]) ? (ma[i] - ma[i - 10]) / ma[i - 10] : NaN);
    const trendOf = (i: number): string | null => {
      if (!Number.isFinite(ma[i])) return null;
      const sl = slope(i);
      if (c[i] > ma[i] && sl > 0.002) return 'Uptrend';
      if (c[i] < ma[i] && sl < -0.002) return 'Downtrend';
      return 'Sideways';
    };
    const volOf = (i: number): string | null => (Number.isFinite(vol[i]) && Number.isFinite(med) ? (vol[i] >= med ? 'High volatility' : 'Low volatility') : null);
    const acc = new Map<string, { group: 'trend' | 'volatility'; bars: number; sr: number; br: number; trades: TradeRec[] }>();
    const add = (group: 'trend' | 'volatility', name: string | null, k: number) => {
      if (!name) return;
      let a = acc.get(name);
      if (!a) acc.set(name, (a = { group, bars: 0, sr: 0, br: 0, trades: [] }));
      a.bars++;
      if (k > 0) {
        if (equity[k - 1] > 0) a.sr += Math.log(equity[k] / equity[k - 1]);
        if (bh[k - 1] > 0) a.br += Math.log(bh[k] / bh[k - 1]);
      }
    };
    for (let k = 0; k < m; k++) {
      const i = from + k;
      add('trend', trendOf(i), k);
      add('volatility', volOf(i), k);
    }
    for (const tr of trades) {
      for (const name of [trendOf(tr.entryBar), volOf(tr.entryBar)]) if (name && acc.has(name)) acc.get(name)!.trades.push(tr);
    }
    const order = ['Uptrend', 'Sideways', 'Downtrend', 'High volatility', 'Low volatility'];
    for (const name of order) {
      const a = acc.get(name);
      if (!a) continue;
      regimes.push({ group: a.group, name, bars: a.bars, share: a.bars / m, strategyReturnPct: (Math.exp(a.sr) - 1) * 100, buyHoldReturnPct: (Math.exp(a.br) - 1) * 100, trades: a.trades.length, winRate: a.trades.length ? a.trades.filter((x) => x.profit > 0).length / a.trades.length : 0 });
    }
  }
  const rf = opts.riskFree ?? 0;
  const cashFinal = init * Math.pow(1 + rf, years);
  const all = tradeStats(trades);
  return {
    initialCapital: init,
    finalEquity,
    netProfit: all.netProfit,
    netProfitPct: (all.netProfit / init) * 100,
    openPnl,
    all,
    long: tradeStats(trades.filter((x) => x.dir === 1)),
    short: tradeStats(trades.filter((x) => x.dir === -1)),
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct * 100,
    maxDrawdownDuration: maxDdDur,
    maxRunup: maxRun,
    maxRunupPct: maxRunPct * 100,
    cagr: cagr * 100,
    sharpe: ss.sharpe,
    sortino: ss.sortino,
    calmar: maxDdPct > 0 ? (cagr * 100) / (maxDdPct * 100) : 0,
    volatility: ss.vol * 100,
    exposure: m ? (exposed / m) * 100 : 0,
    feesPaid: raw.feesPaid,
    fundingPaid: raw.fundingPaid,
    borrowPaid: raw.borrowPaid,
    liquidations: raw.liquidations,
    bars: m,
    days,
    start: m ? t[from] : 0,
    end: m ? data.tc[to] : 0,
    buyHold: { returnPct: m && p0 > 0 ? (data.c[to] / p0 - 1) * 100 : 0, maxDrawdownPct: bhMdd * 100, sharpe: bhSS.sharpe, finalEquity: m ? bh[m - 1] : init },
    cash: { returnPct: (cashFinal / init - 1) * 100, rateAnnual: rf, finalEquity: cashFinal },
    monthly,
    yearly,
    regimes,
    curves: { t: Float64Array.from(ct), equity, drawdownPct: ddPct, buyHold: bh },
  };
}
