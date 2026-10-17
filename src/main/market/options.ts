/**
 * Binance options market data for the Options module and Claude: the listed contracts, marks
 * with Binance's Greeks and implied volatilities, quotes and 24-hour activity, the index price and
 * open interest per expiry (USDT-margined European options on eapi.binance.com).
 * Polled only while a window or a tool watches an underlying: marks and the index every 5 s,
 * quotes every 15 s, open interest every minute, the contract list every 30 minutes.
 */
import type { AppCore } from '../core';
import { isSymbol, SYMBOL_SPECS, type SymbolId } from '../../shared/symbols';
import { expiryCode, type OptionRow, type OptionsSnapshot } from '../../shared/options';

const SEC = 1000;
const MIN = 60 * SEC;

interface Contract {
  symbol: string;
  underlying: string;
  expiry: number;
  strike: number;
  side: 'C' | 'P';
}

interface MarkRow {
  symbol: string;
  markPrice: string;
  bidIV: string;
  askIV: string;
  markIV: string;
  delta: string;
  theta: string;
  gamma: string;
  vega: string;
  riskFreeInterest: string;
}

interface TickerRow {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  bidPrice: string;
  askPrice: string;
}

interface Watched {
  refs: number;
  listeners: Set<(s: OptionsSnapshot) => void>;
  timers: NodeJS.Timeout[];
  pushTimer: NodeJS.Timeout | null;
  index: number;
  indexAt: number;
  oi: Map<string, number>;
  oiAt: number;
  error?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
/** Binance sends 0 for a missing quote or volatility. */
const pos = (v: unknown): number => {
  const n = num(v);
  return n > 0 ? n : NaN;
};

export class OptionsService {
  private watched = new Map<SymbolId, Watched>();
  private contracts: Contract[] = [];
  private contractsAt = 0;
  private marks = new Map<string, MarkRow>();
  private marksAt = 0;
  private tickers = new Map<string, TickerRow>();
  private global: NodeJS.Timeout[] = [];

  constructor(private core: AppCore) {}

  watch(underlying: SymbolId, cb: (s: OptionsSnapshot) => void): () => void {
    let w = this.watched.get(underlying);
    if (!w) {
      w = { refs: 0, listeners: new Set(), timers: [], pushTimer: null, index: NaN, indexAt: 0, oi: new Map(), oiAt: 0 };
      this.watched.set(underlying, w);
      this.startGlobal();
      this.start(underlying, w);
    }
    w.refs++;
    w.listeners.add(cb);
    cb(this.snapshot(underlying));
    return () => {
      w!.listeners.delete(cb);
      if (--w!.refs > 0) return;
      for (const t of w!.timers) clearInterval(t);
      if (w!.pushTimer) clearTimeout(w!.pushTimer);
      this.watched.delete(underlying);
      if (!this.watched.size) this.stopGlobal();
    };
  }

  /** One complete snapshot (marks, index and open interest), waiting at most `timeoutMs`. */
  once(underlying: SymbolId, timeoutMs = 15000): Promise<OptionsSnapshot> {
    return new Promise((resolve) => {
      let last: OptionsSnapshot | null = null;
      let off: (() => void) | null = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        queueMicrotask(() => off?.());
        resolve(last!);
      };
      const timer = setTimeout(finish, timeoutMs);
      off = this.watch(underlying, (s) => {
        last = s;
        const w = this.watched.get(underlying);
        if (s.error || (s.rows.length && s.index > 0 && w && w.oiAt > 0 && this.tickers.size)) finish();
      });
      if (finished) off();
    });
  }

  private log(e: unknown, what: string): void {
    this.core.log('warn', `options ${what}: ${(e as Error).message}`);
  }

  private startGlobal(): void {
    if (this.global.length) return;
    const rest = this.core.hub.rest;
    const contracts = async () => {
      const info = await rest.eapi<{ optionSymbols: { symbol: string; underlying: string; expiryDate: number; strikePrice: string; side: string }[] }>('/eapi/v1/exchangeInfo', {}, 1);
      this.contracts = (info.optionSymbols || [])
        .map((x) => ({ symbol: x.symbol, underlying: x.underlying, expiry: num(x.expiryDate), strike: num(x.strikePrice), side: x.side === 'PUT' ? ('P' as const) : ('C' as const) }))
        .filter((c) => c.expiry > 0 && c.strike > 0);
      this.contractsAt = Date.now();
      this.pushAll();
    };
    const marks = async () => {
      // the contract list failed (offline at start): retry it before the marks
      if (!this.contractsAt) await contracts();
      const rows = await rest.eapi<MarkRow[]>('/eapi/v1/mark', {}, 5);
      for (const r of rows) this.marks.set(r.symbol, r);
      this.marksAt = Date.now();
      for (const w of this.watched.values()) w.error = undefined;
      this.pushAll();
    };
    const tickers = async () => {
      const rows = await rest.eapi<TickerRow[]>('/eapi/v1/ticker', {}, 5);
      for (const r of rows) this.tickers.set(r.symbol, r);
      this.pushAll();
    };
    const fail = (what: string) => (e: unknown) => {
      this.log(e, what);
      for (const w of this.watched.values()) w.error = `Binance options data unavailable (${(e as Error).message})`;
      this.pushAll();
    };
    // contracts first: marks and quotes are merged into them
    void contracts()
      .catch(fail('contracts'))
      .finally(() => {
        void marks().catch(fail('marks'));
        void tickers().catch(fail('quotes'));
      });
    this.global.push(
      setInterval(() => void marks().catch(fail('marks')), 5 * SEC),
      setInterval(() => void tickers().catch(fail('quotes')), 15 * SEC),
      setInterval(() => void contracts().catch(fail('contracts')), 30 * MIN),
    );
  }

  private stopGlobal(): void {
    for (const t of this.global) clearInterval(t);
    this.global = [];
  }

  /** Stop all polling (app shutdown). */
  stop(): void {
    for (const w of this.watched.values()) {
      for (const t of w.timers) clearInterval(t);
      if (w.pushTimer) clearTimeout(w.pushTimer);
    }
    this.watched.clear();
    this.stopGlobal();
  }

  private start(underlying: SymbolId, w: Watched): void {
    const rest = this.core.hub.rest;
    const base = SYMBOL_SPECS[underlying].base;
    const index = async () => {
      const r = await rest.eapi<{ indexPrice: string; time: number }>('/eapi/v1/index', { underlying }, 1);
      w.index = num(r.indexPrice);
      w.indexAt = r.time || Date.now();
      this.push(w, underlying);
    };
    const openInterest = async () => {
      // the contract list arrives first on a cold start
      for (let k = 0; k < 20 && !this.contractsAt; k++) await new Promise((r) => setTimeout(r, 500));
      const now = Date.now();
      const expiries = [...new Set(this.contracts.filter((c) => c.underlying === underlying && c.expiry > now).map((c) => c.expiry))].sort((a, b) => a - b);
      // nearest expiries first, a few at a time (the REST limiter caps concurrency)
      await Promise.all(
        expiries.map(async (e) => {
          const rows = await rest.eapi<{ symbol: string; sumOpenInterest: string }[]>('/eapi/v1/openInterest', { underlyingAsset: base, expiration: expiryCode(e) }, 1);
          for (const r of rows) w.oi.set(r.symbol, num(r.sumOpenInterest));
          this.push(w, underlying);
        }),
      );
      w.oiAt = Date.now();
      this.push(w, underlying);
    };
    const run = (f: () => Promise<void>, what: string) => () => void f().catch((e) => this.log(e, `${what} ${underlying}`));
    run(index, 'index')();
    run(openInterest, 'open interest')();
    w.timers.push(setInterval(run(index, 'index'), 5 * SEC), setInterval(run(openInterest, 'open interest'), MIN));
  }

  snapshot(underlying: SymbolId): OptionsSnapshot {
    const w = this.watched.get(underlying);
    const now = Date.now();
    const rows: OptionRow[] = [];
    let rf = NaN;
    for (const c of this.contracts) {
      if (c.underlying !== underlying || c.expiry <= now) continue;
      const m = this.marks.get(c.symbol);
      const t = this.tickers.get(c.symbol);
      if (!m) continue;
      if (!Number.isFinite(rf)) rf = num(m.riskFreeInterest);
      rows.push({
        symbol: c.symbol,
        expiry: c.expiry,
        strike: c.strike,
        side: c.side,
        mark: num(m.markPrice),
        bid: pos(t?.bidPrice),
        ask: pos(t?.askPrice),
        bidIV: pos(m.bidIV),
        askIV: pos(m.askIV),
        markIV: pos(m.markIV),
        delta: num(m.delta),
        gamma: num(m.gamma),
        theta: num(m.theta),
        vega: num(m.vega),
        oi: w?.oi.get(c.symbol) ?? NaN,
        volume: num(t?.volume) || 0,
        last: pos(t?.lastPrice),
        changePct: num(t?.priceChangePercent) * 100,
      });
    }
    rows.sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || (a.side === b.side ? 0 : a.side === 'C' ? -1 : 1));
    return { underlying, base: SYMBOL_SPECS[underlying].base, index: w?.index ?? NaN, rf: Number.isFinite(rf) ? rf : 0, t: this.marksAt || now, expiries: [...new Set(rows.map((r) => r.expiry))], rows, error: w?.error };
  }

  private pushAll(): void {
    for (const [u, w] of this.watched) this.push(w, u);
  }

  /** At most two updates a second per underlying. */
  private push(w: Watched, underlying: SymbolId): void {
    if (w.pushTimer) return;
    w.pushTimer = setTimeout(() => {
      w.pushTimer = null;
      const s = this.snapshot(underlying);
      for (const l of w.listeners) l(s);
    }, 500);
  }
}

export function registerOptions(core: AppCore): OptionsService {
  const svc = new OptionsService(core);
  core.router.topic('options', (p: { underlying?: string }, push) => {
    const underlying = isSymbol(p?.underlying) ? p.underlying : 'BTCUSDT';
    return svc.watch(underlying, (s) => push(s));
  });
  core.onShutdown(async () => svc.stop());
  return svc;
}
