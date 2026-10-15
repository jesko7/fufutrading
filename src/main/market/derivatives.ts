/**
 * Futures market data for the Derivatives module, from Binance's public endpoints:
 *  - open interest (current, and 5-minute history over the last day),
 *  - funding rate history and the predicted rate (mark price stream),
 *  - long/short ratios (all accounts, top traders' positions) and taker buy/sell volume,
 *  - the live liquidation feed (<symbol>@forceOrder; Binance sends at most one liquidation per
 *    symbol and second, the largest).
 * Everything is polled or streamed only while a window watches the symbol.
 */
import type { AppCore } from '../core';
import type { SymbolId } from '../../shared/symbols';
import { isSymbol } from '../../shared/symbols';
import type { DerivativesSnapshot, LiquidationEvent } from '../../shared/derivatives';

const MIN = 60000;
const DAY = 24 * 60 * MIN;

interface Watched {
  refs: number;
  snap: DerivativesSnapshot;
  liq: LiquidationEvent[];
  timers: NodeJS.Timeout[];
  unsub: (() => void)[];
  listeners: Set<(s: DerivativesSnapshot) => void>;
  pushTimer: NodeJS.Timeout | null;
  since: number;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export class DerivativesService {
  private watched = new Map<SymbolId, Watched>();

  constructor(private core: AppCore) {}

  watch(symbol: SymbolId, cb: (s: DerivativesSnapshot) => void): () => void {
    let w = this.watched.get(symbol);
    if (!w) {
      w = { refs: 0, snap: empty(symbol), liq: [], timers: [], unsub: [], listeners: new Set(), pushTimer: null, since: Date.now() };
      this.watched.set(symbol, w);
      this.start(symbol, w);
    }
    w.refs++;
    w.listeners.add(cb);
    cb(this.snapshotOf(w));
    return () => {
      w!.listeners.delete(cb);
      if (--w!.refs > 0) return;
      for (const t of w!.timers) clearInterval(t);
      for (const u of w!.unsub) u();
      if (w!.pushTimer) clearTimeout(w!.pushTimer);
      this.watched.delete(symbol);
    };
  }

  /** One complete snapshot (open interest, ratios, funding history), waiting at most `timeoutMs`. */
  once(symbol: SymbolId, timeoutMs = 12000): Promise<DerivativesSnapshot> {
    return new Promise((resolve) => {
      let last: DerivativesSnapshot | null = null;
      let off: (() => void) | null = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // the first snapshot arrives synchronously, before `off` exists
        queueMicrotask(() => off?.());
        resolve(last!);
      };
      const timer = setTimeout(finish, timeoutMs);
      off = this.watch(symbol, (s) => {
        last = s;
        if (s.openInterest?.history.length && s.longShort && s.fundingHistory.length && s.funding) finish();
      });
      if (finished) off();
    });
  }

  private start(symbol: SymbolId, w: Watched): void {
    const hub = this.core.hub;
    const rest = hub.rest;
    const log = (e: unknown) => this.core.log('warn', `derivatives ${symbol}: ${(e as Error).message}`);
    const fast = async () => {
      const oi = await rest.get<{ openInterest: string; time: number }>('futures', '/fapi/v1/openInterest', { symbol }, 1);
      const qty = num(oi.openInterest);
      const mark = hub.marks.get(symbol)?.mark || hub.lastPrice('futures', symbol);
      const hist = w.snap.openInterest?.history || [];
      w.snap.openInterest = { ...stats(hist, qty * mark), qty, value: qty * mark, history: hist };
      this.push(w);
    };
    const slow = async () => {
      const [oiHist, global, top, taker] = await Promise.all([
        rest.get<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>('futures', '/futures/data/openInterestHist', { symbol, period: '5m', limit: 288 }, 1),
        rest.get<{ longAccount: string; shortAccount: string; longShortRatio: string; timestamp: number }[]>('futures', '/futures/data/globalLongShortAccountRatio', { symbol, period: '5m', limit: 288 }, 1),
        rest.get<{ longAccount: string; shortAccount: string; longShortRatio: string; timestamp: number }[]>('futures', '/futures/data/topLongShortPositionRatio', { symbol, period: '5m', limit: 1 }, 1),
        rest.get<{ buySellRatio: string; buyVol: string; sellVol: string; timestamp: number }[]>('futures', '/futures/data/takerlongshortRatio', { symbol, period: '5m', limit: 288 }, 1),
      ]);
      // Binance's history occasionally has zero entries: skip them
      const history = oiHist.map((x) => [x.timestamp, num(x.sumOpenInterestValue)] as [number, number]).filter(([, v]) => Number.isFinite(v) && v > 0);
      const cur = w.snap.openInterest;
      const value = cur?.value ?? history[history.length - 1]?.[1] ?? NaN;
      w.snap.openInterest = { qty: cur?.qty ?? num(oiHist[oiHist.length - 1]?.sumOpenInterest), value, history, ...stats(history, value) };
      const g = global[global.length - 1];
      const tp = top[top.length - 1];
      if (g) w.snap.longShort = { long: num(g.longAccount), short: num(g.shortAccount), ratio: num(g.longShortRatio), topLong: tp ? num(tp.longAccount) : NaN, topRatio: tp ? num(tp.longShortRatio) : NaN, history: global.map((x) => [x.timestamp, num(x.longShortRatio)]) };
      const tk = taker[taker.length - 1];
      if (tk) {
        let buy = 0;
        let sell = 0;
        for (const x of taker.slice(-12)) {
          buy += num(x.buyVol);
          sell += num(x.sellVol);
        }
        w.snap.taker = { ratio: num(tk.buySellRatio), buy1h: buy, sell1h: sell, history: taker.map((x) => [x.timestamp, num(x.buySellRatio)]) };
      }
      this.push(w);
    };
    const funding = async () => {
      const rows = await rest.get<{ fundingTime: number; fundingRate: string }[]>('futures', '/fapi/v1/fundingRate', { symbol, limit: 30 }, 1);
      const history = rows.map((r) => ({ t: r.fundingTime, rate: num(r.fundingRate) }));
      const week = history.filter((r) => r.t > Date.now() - 7 * DAY);
      const avg = week.length ? week.reduce((s, r) => s + r.rate, 0) / week.length : NaN;
      w.snap.fundingHistory = history;
      // annualised: three fundings a day
      w.snap.funding7dAnnualPct = avg * 3 * 365 * 100;
      this.push(w);
    };
    const run = (f: () => Promise<void>) => () => void f().catch(log);
    run(fast)();
    run(slow)();
    run(funding)();
    w.timers.push(setInterval(run(fast), MIN), setInterval(run(slow), 5 * MIN), setInterval(run(funding), 30 * MIN));
    w.unsub.push(
      hub.subscribeMark(symbol, (m) => {
        const prev = w.snap.funding;
        w.snap.funding = { rate: m.fundingRate, next: m.nextFundingTime, mark: m.mark };
        if (!prev || prev.next !== m.nextFundingTime) this.push(w);
      }),
      hub.streams.subscribe('futures', `${symbol.toLowerCase()}@forceOrder`, {
        onData: (d) => {
          const o = d?.o;
          if (!o || o.s !== symbol) return;
          const price = num(o.ap) || num(o.p);
          const qty = num(o.z) || num(o.q);
          if (!(price > 0 && qty > 0)) return;
          // a SELL order liquidates a long position, a BUY order a short one
          w.liq.push({ t: o.T || d.E || Date.now(), symbol, side: o.S === 'SELL' ? 'long' : 'short', price, qty, notional: price * qty });
          const cutoff = Date.now() - DAY;
          while (w.liq.length && (w.liq[0].t < cutoff || w.liq.length > 20000)) w.liq.shift();
          this.push(w);
        },
      }),
    );
  }

  private snapshotOf(w: Watched): DerivativesSnapshot {
    const now = Date.now();
    const sum = (from: number, side: 'long' | 'short') => w.liq.reduce((s, e) => (e.t >= from && e.side === side ? s + e.notional : s), 0);
    return {
      ...w.snap,
      t: now,
      liquidations: {
        since: w.since,
        long1h: sum(now - 60 * MIN, 'long'),
        short1h: sum(now - 60 * MIN, 'short'),
        long24h: sum(now - DAY, 'long'),
        short24h: sum(now - DAY, 'short'),
        recent: w.liq.slice(-60).reverse(),
      },
    };
  }

  /** At most two updates a second per symbol. */
  private push(w: Watched): void {
    if (w.pushTimer) return;
    w.pushTimer = setTimeout(() => {
      w.pushTimer = null;
      const s = this.snapshotOf(w);
      for (const l of w.listeners) l(s);
    }, 500);
  }
}

function empty(symbol: SymbolId): DerivativesSnapshot {
  return { symbol, t: Date.now(), openInterest: null, funding: null, fundingHistory: [], funding7dAnnualPct: NaN, longShort: null, taker: null, liquidations: { since: Date.now(), long1h: 0, short1h: 0, long24h: 0, short24h: 0, recent: [] } };
}

/** Changes of the open interest value over the last hour and day from the 5-minute history. */
function stats(history: [number, number][], value: number): { change1hPct: number; change24hPct: number } {
  const at = (ago: number) => {
    const target = Date.now() - ago;
    let best: number | null = null;
    for (const [t, v] of history) if (t <= target) best = v;
    return best ?? (history.length ? history[0][1] : NaN);
  };
  const h1 = at(60 * MIN);
  const d1 = at(DAY);
  return { change1hPct: h1 > 0 ? (value / h1 - 1) * 100 : NaN, change24hPct: d1 > 0 ? (value / d1 - 1) * 100 : NaN };
}

export function registerDerivatives(core: AppCore): DerivativesService {
  const svc = new DerivativesService(core);
  core.router.topic('derivatives', (p: { symbol?: string }, push) => {
    const symbol = isSymbol(p?.symbol) ? p.symbol : 'BTCUSDT';
    return svc.watch(symbol, (s) => push(s));
  });
  return svc;
}
