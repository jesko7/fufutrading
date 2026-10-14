/**
 * TradingEngine — live paper trading for all accounts (manual and bot).
 * Subscribes to exactly the market data the accounts need (trades for matching, mark price and
 * funding for futures, order books for realistic market fills), runs housekeeping (prop rules,
 * day rollover, equity sampling) and persists every account.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { AppCore } from '../core';
import { DocStore, uid, writeJsonAtomic, readJson } from '../storage/jsonStore';
import { AccountRuntime, OrderError, type MarketCtx, type PersistedAccount } from '../../shared/trading/account';
import type { AccountConfig, AccountEvent, AccountSnapshot, PlaceOrderRequest } from '../../shared/trading/types';
import { ACCOUNT_PRESETS, COST_PRESETS, newAccountConfig } from '../../shared/trading/presets';
import { setBrackets, parseBracketResponse, bracketsInfo, DEFAULT_BRACKETS } from '../../shared/trading/brackets';
import { PROFILES, profileById } from '../../shared/propfirm/profiles';
import { SYMBOL_SPECS, isSymbol, type Market, type SymbolId } from '../../shared/symbols';
import type { MarkInfo } from '../market/hub';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];

export interface CreateAccountRequest {
  name: string;
  kind: 'manual' | 'bot';
  market: Market;
  initialBalance: number;
  costPreset: string;
  futures?: Partial<AccountConfig['futures']>;
  risk?: Partial<AccountConfig['risk']>;
  execution?: Partial<AccountConfig['execution']>;
  prop?: { profileId: string; size: number; options?: Record<string, unknown> };
  bot?: AccountConfig['bot'];
  replay?: boolean;
}

export class TradingEngine {
  readonly accounts = new Map<string, AccountRuntime>();
  private store: DocStore<PersistedAccount & { id: string }>;
  private dirty = new Set<string>();
  private tapes = new Map<string, { release: () => void; unlisten: () => void; prev: number }>();
  private books = new Map<string, () => void>();
  private markSubs = new Map<SymbolId, () => void>();
  private funding = new Map<SymbolId, { rate: number; next: number; mark: number }>();
  private timer: NodeJS.Timeout | null = null;
  private lastEquitySample = 0;
  private needsRecalc = true;
  readonly ctx: MarketCtx;
  listeners = new Set<(id: string) => void>();
  eventListeners = new Set<(id: string, e: AccountEvent) => void>();
  /** Called before an account is removed or reset (bots stop their runners). */
  beforeRemove = new Set<(id: string) => void>();
  /** Market context of a replay account while its replay runs (set by the replay service). */
  replayCtx: ((id: string) => MarketCtx | null) | null = null;

  constructor(private core: AppCore) {
    this.store = new DocStore(path.join(core.paths.userData, 'accounts'));
    const hub = core.hub;
    this.ctx = {
      now: () => hub.clock.now(),
      last: (market, symbol) => hub.lastPrice(market, symbol),
      mark: (symbol) => hub.marks.get(symbol)?.mark || 0,
      sweep: (market, symbol, side, qty) => {
        const b = hub.bookFor(market, symbol);
        if (!b || b.status !== 'live') return null;
        return b.book.sweep(side, qty);
      },
      bestBidAsk: (market, symbol) => {
        const b = hub.bookFor(market, symbol);
        if (!b || b.status !== 'live') return null;
        const bid = b.book.bestBid();
        const ask = b.book.bestAsk();
        return isFinite(bid) && isFinite(ask) ? { bid, ask } : null;
      },
    };
  }

  async start(): Promise<void> {
    for (const doc of this.store.loadAll()) {
      try {
        this.attach(new AccountRuntime(doc.config, doc));
      } catch (e) {
        this.core.log('error', `failed to load account ${doc.id}: ${(e as Error).message}`);
      }
    }
    this.core.log('info', `trading: ${this.accounts.size} accounts loaded`);
    this.loadBrackets();
    this.timer = setInterval(() => this.tick(), 1000);
    this.recalcSubscriptions();
  }

  private loadBrackets(): void {
    const file = path.join(this.core.paths.userData, 'brackets.json');
    const cached = readJson<{ verifiedAt: string; table: any } | null>(file, null);
    if (cached?.table) setBrackets(cached.table, cached.verifiedAt);
    this.core.hub.rest
      .leverageBrackets()
      .then((json) => {
        const table = parseBracketResponse(json);
        if (Object.keys(table).length === 3) {
          const verifiedAt = new Date().toISOString().slice(0, 10);
          setBrackets(table, verifiedAt);
          writeJsonAtomic(file, { verifiedAt, table });
          this.core.log('info', 'trading: leverage brackets refreshed from Binance');
        }
      })
      .catch((e) => this.core.log('warn', `trading: bracket refresh failed (${e.message}); using ${cached ? 'cached' : 'bundled'} table`));
    void DEFAULT_BRACKETS;
  }

  private attach(rt: AccountRuntime): void {
    rt.onChange = () => {
      this.markDirty(rt.config.id);
      this.needsRecalc = true;
    };
    rt.onEvent = (e) => this.onAccountEvent(rt, e);
    this.accounts.set(rt.config.id, rt);
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    for (const l of this.listeners) l(id);
  }

  private onAccountEvent(rt: AccountRuntime, e: AccountEvent): void {
    for (const l of this.eventListeners) l(rt.config.id, e);
    const important = e.kind === 'liquidation' || e.kind === 'marginCall' || (e.kind === 'rule' && /breach|passed|restricted|limit/i.test(e.message)) || e.kind === 'error';
    const fillNote = e.kind === 'fill' && (rt.config.kind === 'bot' || e.data?.source === 'bracket');
    if (important || fillNote) {
      this.core.notify(`${rt.config.name}`, e.message);
      this.core.router.broadcast('toast', { title: rt.config.name, body: e.message, kind: e.kind === 'liquidation' || e.kind === 'error' ? 'error' : e.kind === 'marginCall' || e.kind === 'rule' ? 'warn' : 'ok' });
    }
  }

  // ------------------------------------------------------------------ subscriptions

  /** Subscribe to the data the accounts need, release what is no longer needed. */
  recalcSubscriptions(): void {
    this.needsRecalc = false;
    const needTapes = new Set<string>();
    const needMarks = new Set<SymbolId>();
    for (const rt of this.accounts.values()) {
      if (rt.config.archived || rt.config.replay) continue;
      const syms = new Set<SymbolId>([...rt.ledger.positions.keys(), ...rt.orders.map((o) => o.symbol)]);
      if (rt.config.bot && rt.config.bot.status === 'running') syms.add(rt.config.bot.symbol);
      for (const s of syms) {
        needTapes.add(`${rt.config.market}:${s}`);
        if (rt.config.market === 'futures') needMarks.add(s);
      }
    }
    for (const key of needTapes) {
      if (this.tapes.has(key)) continue;
      const [market, symbol] = key.split(':') as [Market, SymbolId];
      const { tape, release } = this.core.hub.acquireTape(market, symbol);
      const entry = { release, unlisten: () => {}, prev: tape.lastPrice };
      entry.unlisten = tape.addListener({
        onTrade: (tr) => {
          const prev = entry.prev > 0 ? entry.prev : tr.p;
          entry.prev = tr.p;
          for (const rt of this.accounts.values()) {
            if (rt.config.market !== market || rt.config.archived || rt.config.replay) continue;
            if (!rt.orders.some((o) => o.symbol === symbol) && !rt.ledger.positions.has(symbol)) continue;
            try {
              rt.onPrice(symbol, { from: prev, to: tr.p, volume: tr.q, t: tr.t }, this.ctx, 'tick');
            } catch (e) {
              this.core.log('warn', `matching error ${rt.config.id}: ${(e as Error).message}`);
            }
          }
        },
      });
      this.tapes.set(key, entry);
      // keep the order book synced for realistic market fills
      if (!this.books.has(key)) this.books.set(key, this.core.hub.acquireBook(market, symbol).release);
    }
    for (const [key, e] of this.tapes) {
      if (needTapes.has(key)) continue;
      e.unlisten();
      e.release();
      this.tapes.delete(key);
      this.books.get(key)?.();
      this.books.delete(key);
    }
    for (const s of needMarks) {
      if (this.markSubs.has(s)) continue;
      this.markSubs.set(s, this.core.hub.subscribeMark(s, (m) => this.onMark(m)));
    }
    for (const [s, un] of this.markSubs) {
      if (needMarks.has(s)) continue;
      un();
      this.markSubs.delete(s);
    }
  }

  private onMark(m: MarkInfo): void {
    const f = this.funding.get(m.symbol);
    if (f && m.nextFundingTime > f.next && f.next > 0) {
      // the previous funding time passed: settle at the last observed rate
      for (const rt of this.accounts.values()) {
        if (rt.config.market !== 'futures' || rt.config.replay || rt.config.archived) continue;
        rt.onFunding(m.symbol, f.rate, f.mark || m.mark, f.next);
      }
    }
    this.funding.set(m.symbol, { rate: m.fundingRate, next: m.nextFundingTime, mark: m.mark });
    for (const rt of this.accounts.values()) {
      if (rt.config.market !== 'futures' || rt.config.replay || rt.config.archived) continue;
      if (!rt.ledger.positions.has(m.symbol)) continue;
      rt.onMark(this.ctx, (s) => SYMBOL_SPECS[s].futures.liquidationFeeRate);
      // mark-triggered SL/TP
      if (rt.orders.some((o) => o.symbol === m.symbol && o.trigger === 'mark')) rt.onPrice(m.symbol, { from: m.mark, to: m.mark, volume: 0, t: m.t }, this.ctx, 'tick');
    }
  }

  private tick(): void {
    const now = Date.now();
    const sample = now - this.lastEquitySample >= 60000;
    if (sample) this.lastEquitySample = now;
    for (const rt of this.accounts.values()) {
      if (rt.config.archived || rt.config.replay) continue;
      try {
        const flatten = rt.housekeeping(this.ctx, sample && (rt.ledger.positions.size > 0 || rt.equity.length === 0 || now - (rt.equity[rt.equity.length - 1]?.[0] || 0) > 3600e3));
        if (flatten) rt.flattenAll(this.ctx, 'rule', 'prop rule');
        if (sample) this.markDirty(rt.config.id);
      } catch (e) {
        this.core.log('warn', `housekeeping ${rt.config.id}: ${(e as Error).message}`);
      }
    }
    if (this.needsRecalc) this.recalcSubscriptions();
    this.flush(false);
  }

  flush(all: boolean): void {
    const ids = all ? [...this.accounts.keys()] : [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const rt = this.accounts.get(id);
      if (rt) this.store.put({ ...rt.toPersisted(), id });
    }
    this.store.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush(true);
  }

  // ------------------------------------------------------------------ API

  get(id: string): AccountRuntime {
    const rt = this.accounts.get(id);
    if (!rt) throw new Error('Account not found');
    return rt;
  }

  async create(req: CreateAccountRequest): Promise<AccountConfig> {
    if (!(req.initialBalance > 0)) throw new Error('Validation: initial balance must be positive');
    let eurUsdt: number | undefined;
    if (req.costPreset === 'tradingview-flat') {
      try {
        const r = await this.core.hub.rest.get<{ price: string }>('spot', '/api/v3/ticker/price', { symbol: 'EURUSDT' }, 2);
        eurUsdt = +r.price;
      } catch {
        eurUsdt = undefined;
      }
    }
    let market = req.market;
    let initial = req.initialBalance;
    let costPreset = req.costPreset;
    const futures: Partial<AccountConfig['futures']> = { ...(req.futures || {}) };
    const risk: Partial<AccountConfig['risk']> = { ...(req.risk || {}) };
    if (req.prop) {
      const prof = profileById(req.prop.profileId);
      if (!prof) throw new Error('Unknown prop profile');
      market = 'futures';
      initial = req.prop.size;
      costPreset = req.costPreset || prof.costPreset;
      futures.defaultLeverage = Math.min(futures.defaultLeverage || prof.leverage.default, prof.leverage.max);
      risk.maxLeverage = Math.min(risk.maxLeverage || prof.leverage.max, prof.leverage.max);
    }
    const id = uid('a');
    const cfg = newAccountConfig({ id, name: req.name || 'Account', kind: req.kind, market, initialBalance: initial, costPreset, eurUsdt, futures, risk, color: COLORS[this.accounts.size % COLORS.length] });
    if (req.execution) cfg.execution = { ...cfg.execution, ...req.execution };
    if (req.prop) {
      const prof = profileById(req.prop.profileId)!;
      cfg.prop = { profileId: prof.id, profileVersion: prof.version, firm: prof.firm, program: prof.program, phase: prof.phase, size: req.prop.size, options: req.prop.options || {} };
    }
    if (req.bot) cfg.bot = req.bot;
    if (req.replay) cfg.replay = true;
    const rt = new AccountRuntime(cfg);
    rt.event('info', `Account created (${cfg.market === 'spot' ? 'spot' : 'USDⓈ-M futures'}, ${cfg.initialBalance} USDT, costs: ${cfg.costs.preset})`);
    this.attach(rt);
    this.markDirty(id);
    this.flush(false);
    return cfg;
  }

  /** Create the next phase of a passed prop account. */
  async nextPhase(id: string): Promise<AccountConfig> {
    const rt = this.get(id);
    const prop = rt.config.prop;
    if (!prop || !rt.prop) throw new Error('Not a prop account');
    if (rt.prop.state.status !== 'passed') throw new Error('Phase not passed yet');
    const next = rt.prop.profile.next;
    if (!next) throw new Error('This is the final phase');
    const prof = profileById(next)!;
    return this.create({ name: `${rt.config.name.replace(/ · .*$/, '')} · ${prof.phase}`, kind: rt.config.kind, market: 'futures', initialBalance: prop.size, costPreset: rt.config.costs.preset, prop: { profileId: next, size: prop.size, options: prop.options }, bot: rt.config.bot ? { ...rt.config.bot, status: 'stopped' } : undefined });
  }

  update(id: string, patch: Partial<AccountConfig>): AccountConfig {
    const rt = this.get(id);
    const allowed: (keyof AccountConfig)[] = ['name', 'color', 'costs', 'execution', 'risk', 'futures', 'archived', 'bot'];
    for (const k of allowed) if (patch[k] !== undefined) (rt.config as any)[k] = patch[k];
    rt.event('info', 'Settings updated');
    this.markDirty(id);
    this.needsRecalc = true;
    return rt.config;
  }

  /** Persist an account soon (bots change their config in place). */
  persist(id: string): void {
    this.markDirty(id);
  }

  /** Re-evaluate market data subscriptions on the next tick. */
  recalc(): void {
    this.needsRecalc = true;
  }

  reset(id: string): AccountConfig {
    for (const l of this.beforeRemove) l(id);
    const old = this.get(id);
    const cfg = { ...old.config, createdAt: Date.now() };
    if (cfg.bot) cfg.bot = { ...cfg.bot, status: 'stopped', state: undefined, lastError: undefined, startedAt: undefined };
    const rt = new AccountRuntime(cfg);
    rt.event('reset', 'Account reset to its initial balance');
    this.attach(rt);
    this.markDirty(id);
    this.needsRecalc = true;
    return cfg;
  }

  remove(id: string): void {
    for (const l of this.beforeRemove) l(id);
    this.accounts.delete(id);
    this.store.delete(id);
    this.needsRecalc = true;
  }

  /** Prices, time and order book an account trades on: live, or its replay's clock. */
  ctxFor(id: string): MarketCtx {
    const rt = this.accounts.get(id);
    if (rt?.config.replay) {
      const c = this.replayCtx?.(id);
      if (!c) throw new Error('Validation: replay accounts trade only while their replay is running');
      return c;
    }
    return this.ctx;
  }

  /** Manual actions on an account a running bot controls would be undone by the bot. */
  assertManual(id: string): void {
    const b = this.get(id).config.bot;
    if (b && b.status === 'running') throw new Error('Validation: a running bot controls this account — pause or stop the bot to trade manually');
  }

  place(id: string, req: PlaceOrderRequest) {
    if (!isSymbol(req.symbol)) throw new Error('Validation: unsupported symbol');
    const rt = this.get(id);
    if ((req.source || 'manual') === 'manual') this.assertManual(id);
    try {
      const o = rt.placeOrder(req, this.ctxFor(id));
      this.needsRecalc = true;
      this.markDirty(id);
      return o;
    } catch (e) {
      if (e instanceof OrderError) throw new Error(`Validation: ${e.message}`);
      throw e;
    }
  }

  snapshot(id: string): AccountSnapshot {
    const rt = this.get(id);
    return rt.snapshot(rt.config.replay ? this.replayCtx?.(id) || this.ctx : this.ctx);
  }

  list(): AccountSnapshot[] {
    return [...this.accounts.values()].filter((r) => !r.config.replay).map((r) => r.snapshot(this.ctx));
  }

  activeBots(): number {
    let n = 0;
    for (const rt of this.accounts.values()) if (rt.config.bot?.status === 'running' && !rt.config.archived) n++;
    return n;
  }
}

/** Wire the engine into IPC. */
export function registerTrading(core: AppCore): TradingEngine {
  const eng = new TradingEngine(core);
  const r = core.router;
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw new Error((e as Error).message.startsWith('Validation') ? (e as Error).message : `Validation: ${(e as Error).message}`);
    }
  };
  r.handle('trading:presets', () => ({
    costPresets: COST_PRESETS,
    accountPresets: ACCOUNT_PRESETS,
    profiles: PROFILES,
    brackets: bracketsInfo(),
  }));
  r.handle('trading:create', ([req]) => eng.create(req));
  r.handle('trading:list', () => eng.list());
  r.handle('trading:snapshot', ([id]) => eng.snapshot(id));
  r.handle('trading:update', ([id, patch]) => wrap(() => eng.update(id, patch)));
  r.handle('trading:reset', ([id]) => eng.reset(id));
  r.handle('trading:delete', ([id]) => eng.remove(id));
  r.handle('trading:nextPhase', ([id]) => eng.nextPhase(id));
  r.handle('trading:place', ([id, req]) => eng.place(id, req));
  r.handle('trading:cancel', ([id, orderId]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).cancelOrder(orderId);
  }));
  r.handle('trading:cancelAll', ([id, symbol]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).cancelAll(symbol);
  }));
  r.handle('trading:modify', ([id, orderId, patch]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).modifyOrder(orderId, patch, eng.ctxFor(id));
  }));
  r.handle('trading:close', ([id, symbol, qty]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).closePosition(symbol, eng.ctxFor(id), qty);
  }));
  r.handle('trading:flatten', ([id]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).flattenAll(eng.ctxFor(id), 'manual', 'flatten all');
  }));
  r.handle('trading:setBrackets', ([id, symbol, b]) => wrap(() => {
    eng.assertManual(id);
    return eng.get(id).setBrackets(symbol, b, eng.ctxFor(id));
  }));
  r.handle('trading:setLeverage', ([id, symbol, lev]) =>
    wrap(() => {
      const rt = eng.get(id);
      if (rt.config.market !== 'futures') throw new Error('Leverage applies to futures accounts');
      const L = Math.round(lev);
      if (!(L >= 1 && L <= Math.min(rt.config.risk.maxLeverage, SYMBOL_SPECS[symbol as SymbolId].futures.maxLeverage))) throw new Error(`Leverage must be 1–${Math.min(rt.config.risk.maxLeverage, SYMBOL_SPECS[symbol as SymbolId].futures.maxLeverage)}x`);
      if (rt.ledger.position(symbol)) throw new Error('Close the position before changing leverage');
      rt.config.futures.leverage = { ...rt.config.futures.leverage, [symbol]: L };
      rt.event('info', `${symbol} leverage set to ${L}x`);
      return L;
    }),
  );
  r.handle('trading:setMarginMode', ([id, symbol, mode]) =>
    wrap(() => {
      const rt = eng.get(id);
      if (rt.ledger.position(symbol) || rt.orders.some((o) => o.symbol === symbol)) throw new Error('Close positions and orders on this symbol first');
      rt.config.futures.marginModes = { ...rt.config.futures.marginModes, [symbol]: mode };
      rt.event('info', `${symbol} margin mode: ${mode}`);
      return mode;
    }),
  );
  r.handle('trading:adjustMargin', ([id, symbol, delta]) =>
    wrap(() => {
      const ok = eng.get(id).ledger.adjustIsolatedMargin(symbol, delta);
      if (!ok) throw new Error('Margin adjustment not possible');
      return true;
    }),
  );
  r.handle('trading:history', ([id]) => {
    const rt = eng.get(id);
    return { fills: rt.fills.slice(-1000), trades: rt.trades.slice(-2000), events: rt.events.slice(-500), equity: rt.equity, orders: [] };
  });
  r.topic('accounts', (_p, push) => {
    push(eng.list());
    const timer = setInterval(() => push(eng.list()), 1000);
    return () => clearInterval(timer);
  });
  r.topic('account', (p: { id: string }, push) => {
    let dirty = true;
    const l = (id: string) => {
      if (id === p.id) dirty = true;
    };
    eng.listeners.add(l);
    const el = (id: string, e: AccountEvent) => id === p.id && push({ event: e });
    eng.eventListeners.add(el);
    const send = () => {
      try {
        push({ snapshot: eng.snapshot(p.id) });
      } catch {
        push({ missing: true });
      }
    };
    send();
    // P&L moves with prices, so refresh periodically; faster when something changed
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (dirty || n % 4 === 0) {
        dirty = false;
        send();
      }
    }, 250);
    return () => {
      clearInterval(timer);
      eng.listeners.delete(l);
      eng.eventListeners.delete(el);
    };
  });
  core.activeBotCount = () => eng.activeBots();
  core.onShutdown(() => eng.stop());
  void fs;
  return eng;
}
