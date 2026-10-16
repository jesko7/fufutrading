/**
 * BotService — strategy bots trading their own paper accounts.
 *
 * A bot account carries one BotConfig: a strategy (Pine or Python) with parameters, an instrument,
 * timeframe, chart type and a sizing rule. When a bar closes the strategy runs on a worker over the
 * bars since the bot started (plus a warm-up) and the planner (shared/trading/botPlan) aligns the
 * account with the simulated position and the strategy's resting orders. Every decision is written
 * to the account's activity log with its reason. Script errors, worker crashes and rejected orders
 * only pause the bot concerned — they never affect other bots or the app.
 */
import type { AppCore } from '../core';
import type { ScriptService } from '../scripts/service';
import { runContext } from '../scripts/service';
import type { TradingEngine } from './engine';
import type { ManagedSeries } from '../market/series';
import type { BotStepResult } from '../../engine/host';
import type { BrokerConfig } from '../../engine/backtest/broker';
import { fromPacked } from '../../engine/data';
import { planBot, type BotPlan } from '../../shared/trading/botPlan';
import type { BotConfig, BotGuards, BotRunState, BotView, AccountEvent, ClosedTrade } from '../../shared/trading/types';
import { SYMBOL_SPECS, isSymbol, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfDurationMs, bucketStart, bucketEnd, type Timeframe } from '../../shared/timeframes';
import type { SeriesSpec } from '../../shared/marketTypes';

const DEFAULT_WARMUP = 1000;
/** "Join" mode: bars of history the strategy trades on before the bot takes its current position. */
const JOIN_BARS = 1000;
const MAX_BARS = 150000;
const MAX_FAILURES = 3;

function lowerBound(t: Float64Array, n: number, x: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const fmtQ = (q: number) => `${+Math.abs(q).toFixed(6)}`;

class BotRunner {
  private series: ManagedSeries | null = null;
  private releaseSeries: (() => void) | null = null;
  private unsub: (() => void) | null = null;
  private sec = new Map<string, { series: ManagedSeries; release: () => void }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private closed = false;
  private cancelStep: (() => void) | null = null;
  private tf!: Timeframe;
  private transient = 0;
  private lateWaits = 0;
  phase: BotView['phase'] = 'loading';
  phaseText = 'Loading market data…';
  nextStepAt: number | null = null;
  lastStepAt: number | null = null;
  stepMs = 0;
  bars = 0;
  last: BotStepResult | null = null;
  lastPlan: BotView['lastPlan'] = null;

  constructor(
    private svc: BotService,
    readonly accountId: string,
  ) {}

  private get rt() {
    return this.svc.engine.get(this.accountId);
  }

  private get bot(): BotConfig {
    return this.rt.config.bot!;
  }

  private setPhase(p: BotView['phase'], text: string): void {
    this.phase = p;
    this.phaseText = text;
    this.svc.changed(this.accountId);
  }

  async start(): Promise<void> {
    const b = this.bot;
    const tf = parseTimeframe(b.tf);
    if (!tf) throw new Error(`Invalid timeframe ${b.tf}`);
    this.tf = tf;
    const st = b.state!;
    const tfMs = tfDurationMs(tf);
    const warm = b.warmupBars ?? DEFAULT_WARMUP;
    const need = Math.min(MAX_BARS, warm + Math.ceil(Math.max(0, Date.now() - st.simFrom) / tfMs) + 10);
    const spec: SeriesSpec = { symbol: b.symbol, market: this.rt.config.market, tf: b.tf, chartType: b.chartType };
    const { series, release } = this.svc.core.series.acquire(spec, { bars: Math.max(need, 500) });
    this.series = series;
    this.releaseSeries = release;
    this.setPhase('loading', 'Loading market data…');
    await series.ready;
    if (this.closed) return;
    if (series.status === 'error') throw new Error(series.info.error || 'Market data unavailable');
    // a series shared with a chart may hold less history than the bot needs
    for (let guard = 0; guard < 20 && series.out.length < need && series.hasMore; guard++) {
      const firstT = series.out.length ? series.out.t[0] : Infinity;
      if (firstT <= st.simFrom - warm * tfMs) break;
      const more = await series.loadMore(Math.min(20000, need - series.out.length + 50));
      if (!more || this.closed) break;
    }
    this.unsub = series.subscribe((u) => {
      if (this.closed) return;
      if (u.reset || (this.bot.chartType === 'renko' && u.length !== this.bars)) this.schedule(800);
    });
    this.schedule(0);
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancelStep?.();
    this.unsub?.();
    this.releaseSeries?.();
    for (const s of this.sec.values()) s.release();
    this.sec.clear();
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextStepAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step();
    }, Math.max(0, delay));
  }

  /** Next evaluation: just after the forming bar closes (time-based charts). */
  private scheduleNext(): void {
    if (this.closed) return;
    if (this.bot.chartType === 'renko') {
      this.nextStepAt = null;
      return;
    }
    // bars close on Binance's clock
    const now = this.svc.core.hub.clock.now();
    const end = bucketEnd(this.tf, bucketStart(this.tf, now));
    const settle = tfDurationMs(this.tf) < 60000 ? 400 : 1200;
    this.schedule(Math.min(3600000, end - now + settle));
  }

  /** Evaluate the strategy on the closed bars and align the account. */
  async step(force = false): Promise<void> {
    if (this.closed) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    const b = this.bot;
    if (b.status !== 'running') return;
    const s = this.series;
    if (!s) return;
    if (s.status === 'error') {
      this.setPhase('waitingData', `Market data error: ${s.info.error || 'unavailable'} — retrying`);
      this.svc.restartLater(this.accountId);
      return;
    }
    if (s.status !== 'live' && s.status !== 'degraded') {
      this.setPhase('waitingData', 'Waiting for the live feed to resynchronise…');
      this.schedule(5000);
      return;
    }
    const closed = s.closedLength(this.svc.core.hub.clock.now());
    const st = b.state!;
    const out = s.out;
    if (!closed) {
      this.scheduleNext();
      return;
    }
    const lastT = out.t[closed - 1];
    // a minute (or longer) bar of a major pair without any trade is practically impossible: the
    // data is late (reconnect, slow network) — wait for it instead of evaluating stale bars
    if (b.chartType !== 'renko' && tfDurationMs(this.tf) >= 60000 && !force) {
      const justClosed = bucketStart(this.tf, this.svc.core.hub.clock.now()) - 1;
      const expected = bucketStart(this.tf, justClosed);
      if (lastT < expected && this.lateWaits < 10) {
        this.lateWaits++;
        this.setPhase('waitingData', 'Waiting for the closing bar to arrive…');
        this.schedule(1000);
        return;
      }
    }
    this.lateWaits = 0;
    if (lastT <= st.lastBarTime && !force && this.last) {
      this.setPhase('waiting', 'Waiting for the next bar to close');
      this.scheduleNext();
      return;
    }
    const doc = this.svc.scripts.library.get(b.scriptId);
    if (!doc) {
      this.svc.fail(this.accountId, `Script "${b.scriptName || b.scriptId}" no longer exists`);
      return;
    }
    this.busy = true;
    this.setPhase('evaluating', 'Running the strategy…');
    const t0 = Date.now();
    try {
      const warm = b.warmupBars ?? DEFAULT_WARMUP;
      const fromIdx = lowerBound(out.t, closed, st.simFrom);
      const startIdx = Math.max(0, fromIdx - warm, closed - MAX_BARS);
      const packed = out.pack(startIdx, closed);
      this.bars = closed - startIdx;
      const ctx = runContext({ symbol: b.symbol, market: this.rt.config.market, tf: b.tf, chartType: b.chartType });
      const broker = this.brokerConfig(fromIdx - startIdx);
      if (b.chartType === 'heikinashi') broker.fillData = fromPacked(s.source().pack(startIdx, closed), b.tf, 'candles') as unknown as BrokerConfig['fillData'];
      let res: BotStepResult | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const h = this.svc.scripts.pool.botStep({ lang: doc.language, code: doc.code, ctx, inputs: b.params || {}, strategy: broker, data: packed, security: this.packSecurity(), since: st.simFrom, maxMs: 90000 });
        this.cancelStep = h.cancel;
        res = await h.promise;
        this.cancelStep = null;
        if (this.closed) return;
        if (!res.need.length) break;
        await this.loadSecurity(res.need, out.t[startIdx]);
      }
      if (!res || this.closed) return;
      this.stepMs = Date.now() - t0;
      this.lastStepAt = Date.now();
      this.last = res;
      if (res.need.length) throw new Error(`Missing data: ${res.need.join(', ')}`);
      if (!res.ok) {
        this.svc.fail(this.accountId, `${res.errorLine ? `Line ${res.errorLine}: ` : ''}${res.error || 'Script error'}`, true);
        return;
      }
      this.transient = 0;
      if (this.bot.status !== 'running') return;
      this.reconcile(res);
      st.lastBarTime = lastT;
      st.steps++;
      this.svc.engine.persist(this.accountId);
      this.setPhase('waiting', 'Waiting for the next bar to close');
    } catch (e) {
      const msg = (e as Error).message;
      if (this.closed) return;
      // worker crashes and data hiccups are retried; repeated failures pause the bot
      this.transient++;
      if (this.transient >= MAX_FAILURES) this.svc.fail(this.accountId, msg);
      else {
        this.setPhase('waitingData', `Retrying after an error: ${msg}`);
        this.schedule(5000 * this.transient);
        return;
      }
    } finally {
      this.busy = false;
      this.cancelStep = null;
    }
    if (this.closed || this.bot.status !== 'running') return;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else this.scheduleNext();
  }

  private brokerConfig(tradeFrom: number): Partial<BrokerConfig> {
    const rt = this.rt;
    const acct = rt.config;
    const b = this.bot;
    const f = SYMBOL_SPECS[b.symbol][acct.market];
    const c = acct.costs;
    return {
      market: acct.market,
      initialCapital: b.state!.capital,
      leverage: acct.market === 'futures' ? rt.leverageFor(b.symbol) : 1,
      marginMode: acct.market === 'futures' ? rt.marginModeFor(b.symbol) : 'cross',
      makerFee: c.makerFee,
      takerFee: c.takerFee,
      flatFee: c.flatFee,
      perContractFee: 0,
      slippageTicks: 0,
      slippageBps: c.slippage.model === 'fixedBps' ? c.slippage.bps : 0,
      step: f.stepSize,
      minQty: f.minQty,
      limitFill: acct.execution.limitFill,
      throughTicks: acct.execution.throughTicks,
      partialFills: false,
      allowShortSpot: false,
      liquidationFeeRate: acct.market === 'futures' ? SYMBOL_SPECS[b.symbol].futures.liquidationFeeRate : 0.0125,
      tradeFrom,
    };
  }

  private packSecurity(): Record<string, Float64Array> {
    const r: Record<string, Float64Array> = {};
    const now = this.svc.core.hub.clock.now();
    for (const [k, s] of this.sec) if (s.series.status !== 'error') r[k] = s.series.out.pack(0, s.series.closedLength(now));
    return r;
  }

  private async loadSecurity(keys: string[], fromT: number): Promise<void> {
    for (const key of keys) {
      if (this.sec.has(key)) continue;
      const [market, symbol, tf, chartType] = key.split(':');
      const ptf = parseTimeframe(tf);
      if (!isSymbol(symbol) || !ptf) throw new Error(`Unsupported data request ${key}`);
      const bars = Math.min(20000, Math.max(500, Math.ceil((Date.now() - fromT) / tfDurationMs(ptf)) + 50));
      const spec: SeriesSpec = { symbol, market: market === 'futures' ? 'futures' : 'spot', tf, chartType: chartType === 'heikinashi' ? 'heikinashi' : 'candles' };
      const h = this.svc.core.series.acquire(spec, { bars });
      this.sec.set(key, h);
      await h.series.ready;
      if (h.series.status === 'error') throw new Error(`${key}: ${h.series.info.error || 'data unavailable'}`);
    }
  }

  // ------------------------------------------------------------------ account alignment

  private reconcile(res: BotStepResult): void {
    const eng = this.svc.engine;
    const rt = this.rt;
    const b = this.bot;
    const st = b.state!;
    const ctx = eng.ctx;
    const market = rt.config.market;
    const f = SYMBOL_SPECS[b.symbol][market];
    const price = ctx.last(market, b.symbol) || res.lastClose;
    const snap = rt.snapshot(ctx);
    const actual = rt.ledger.signedQty(b.symbol);
    const orders = rt.orders.filter((o) => o.source === 'bot' && o.symbol === b.symbol);
    const plan = planBot({
      market,
      symbol: b.symbol,
      filters: f,
      price,
      priceBand: market === 'futures' ? { up: SYMBOL_SPECS[b.symbol].futures.priceBandUp, down: SYMBOL_SPECS[b.symbol].futures.priceBandDown } : undefined,
      equity: snap.equity,
      leverage: market === 'futures' ? rt.leverageFor(b.symbol) : 1,
      sizing: b.sizing,
      scale: st.scale,
      hold: st.hold,
      sim: { position: res.position, pending: res.pending },
      prevSimPos: st.prevSimPos,
      prevTarget: st.prevTarget,
      actual,
      orders: orders.map((o) => ({ id: o.id, tag: o.tag, type: o.type, side: o.side, qty: o.qty, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition })),
    });
    const now = ctx.now();
    const actions: string[] = [];
    const signals = this.describeSignals(res, res.lastBarTime);
    for (const n of plan.notes) rt.event('bot', n, { bot: true }, now);
    for (const c of plan.cancel) {
      if (rt.cancelOrder(c.id, now, `bot: ${c.why}`)) actions.push(`Canceled order (${c.why})`);
    }
    let failed: string | null = null;
    const place = (req: BotPlan['place'][number] | NonNullable<BotPlan['market']>, why: string) => {
      try {
        const { why: _w, key: _k, ...order } = req as BotPlan['place'][number];
        const o = eng.place(this.accountId, { ...order, source: 'bot' });
        const base = SYMBOL_SPECS[b.symbol].base;
        const text = o.type === 'market' ? `${o.side === 'buy' ? 'Bought' : 'Sold'} ${fmtQ(o.filledQty || o.qty)} ${base} at market${o.avgFillPrice ? ` @ ${o.avgFillPrice.toFixed(2)}` : ''}` : `Placed ${o.side} ${o.type} ${fmtQ(o.qty)} ${base}${o.price ? ` @ ${o.price}` : ''}${o.stopPrice ? ` trigger ${o.stopPrice}` : ''}`;
        actions.push(`${text} — ${why}`);
        if (o.status === 'rejected') failed = o.rejectReason || 'order rejected';
      } catch (e) {
        failed = (e as Error).message.replace(/^Validation: /, '');
        actions.push(`Could not place ${req.side} ${req.type}: ${failed}`);
      }
    };
    if (plan.market) {
      const why =
        signals ||
        (plan.market.why === 'close'
          ? 'the strategy is flat'
          : st.prevTarget === null
            ? b.startMode === 'join'
              ? "joining the strategy's current position"
              : 'aligning with the strategy'
            : `aligning with the strategy (target ${plan.target >= 0 ? '' : '−'}${fmtQ(plan.target)})`);
      place(plan.market, why);
    }
    for (const p of plan.place) place(p, p.why);
    for (const a of actions) rt.event('bot', a, { bot: true }, now);
    if (!actions.length && signals) rt.event('bot', `Strategy: ${signals} (no account change needed)`, { bot: true }, now);
    st.scale = plan.scale;
    st.hold = plan.hold;
    st.prevSimPos = res.position;
    st.prevTarget = plan.target;
    this.lastPlan = { t: now, target: plan.target, actual, actions, notes: plan.notes, simPosition: res.position, scale: plan.scale?.k ?? null, holding: !!plan.hold };
    if (failed) {
      st.failures = (st.failures || 0) + 1;
      rt.event('error', `Bot order failed (${st.failures}/${MAX_FAILURES}): ${failed}`, { bot: true }, now);
      if (st.failures >= MAX_FAILURES) this.svc.fail(this.accountId, `Orders keep failing: ${failed}`);
    } else st.failures = 0;
  }

  /**
   * What the strategy did on the newest bar, in words. Market orders appear twice across steps —
   * filled at the bar close when the signal happens, then at the next bar's open in the following
   * run, both stamped with the same time — so fills are reported once per (time, order, side).
   */
  private describeSignals(res: BotStepResult, lastBarT: number): string {
    const base = SYMBOL_SPECS[this.bot.symbol].base;
    const parts: string[] = [];
    for (const fl of res.fills) {
      if (fl.t < lastBarT) continue;
      const key = `${fl.t}|${fl.id}|${fl.side}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      const kind = fl.kind === 'entry' ? 'entry' : fl.kind === 'exit' ? 'exit' : fl.kind === 'close' ? 'close' : fl.kind === 'liquidation' ? 'liquidation' : 'order';
      parts.push(`${fl.side} ${fmtQ(fl.qty)} ${base} (${kind} "${fl.id}")`);
    }
    if (this.reported.size > 500) this.reported = new Set([...this.reported].slice(-200));
    return parts.length ? `strategy signal: ${parts.slice(-4).join(', ')}` : '';
  }

  private reported = new Set<string>();
}

/**
 * Risk guards of a running bot on its current equity: updates the peak and the day's starting
 * equity in `st` and returns why the bot must stop, or null.
 */
export function evaluateGuards(g: BotGuards, st: BotRunState, eq: number, trades: ClosedTrade[], symbol: SymbolId, from: number, now: number): string | null {
  if (!(eq > 0)) return null;
  st.peakEquity = Math.max(st.peakEquity ?? st.capital, eq);
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.dayKey !== day) {
    st.dayKey = day;
    st.dayStartEquity = eq;
  }
  const dd = ((st.peakEquity - eq) / st.peakEquity) * 100;
  const dayLoss = st.dayStartEquity ? ((st.dayStartEquity - eq) / st.dayStartEquity) * 100 : 0;
  let losses = 0;
  for (let k = trades.length - 1; k >= 0; k--) {
    const t = trades[k];
    if (t.symbol !== symbol) continue;
    if (t.closedAt < from) break;
    if (t.pnl < 0) losses++;
    else break;
  }
  if (g.maxDrawdownPct && dd >= g.maxDrawdownPct) return `drawdown of ${dd.toFixed(1)}% from the peak reached the limit of ${g.maxDrawdownPct}%`;
  if (g.maxDailyLossPct && dayLoss >= g.maxDailyLossPct) return `today's loss of ${dayLoss.toFixed(1)}% reached the limit of ${g.maxDailyLossPct}%`;
  if (g.maxConsecutiveLosses && losses >= g.maxConsecutiveLosses) return `${losses} losing trades in a row reached the limit of ${g.maxConsecutiveLosses}`;
  return null;
}

export class BotService {
  private runners = new Map<string, BotRunner>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(id: string) => void>();

  constructor(
    readonly core: AppCore,
    readonly engine: TradingEngine,
    readonly scripts: ScriptService,
  ) {}

  changed(id: string): void {
    for (const l of this.listeners) l(id);
  }

  /** Resume bots after an app start (autostart) and watch account events. */
  start(): void {
    for (const rt of this.engine.accounts.values()) {
      const b = rt.config.bot;
      if (!b || rt.config.archived) continue;
      if (b.status === 'running') {
        if (b.autostart && b.state) {
          rt.event('bot', 'Bot resumed after the app started', { bot: true });
          this.launch(rt.config.id);
        } else {
          b.status = 'paused';
          b.lastError = 'Paused because the app restarted (autostart is off)';
          rt.event('bot', b.lastError, { bot: true });
          this.engine.persist(rt.config.id);
        }
      }
    }
    this.engine.eventListeners.add((id, e) => this.onAccountEvent(id, e));
    setInterval(() => this.checkGuards(), 1000).unref?.();
    this.engine.beforeRemove.add((id) => this.halt(id));
    this.core.pauseAllBots = () => {
      for (const id of this.runners.keys()) this.pause(id, 'Paused from the tray');
    };
    this.updateWarm();
  }

  private onAccountEvent(id: string, e: AccountEvent): void {
    const rt = this.engine.accounts.get(id);
    const b = rt?.config.bot;
    if (!b || b.status !== 'running') return;
    if (e.kind === 'liquidation') this.fail(id, 'The position was liquidated — bot paused');
    else if (e.kind === 'rule' && /breach/i.test(e.message)) this.fail(id, `Prop rule breached — bot paused (${e.message})`);
  }

  /** Risk guards of running bots, checked every second on live equity. */
  private checkGuards(): void {
    const ctx = this.engine.ctx;
    for (const id of this.runners.keys()) {
      const rt = this.engine.accounts.get(id);
      const b = rt?.config.bot;
      const st = b?.state;
      const g = b?.guards;
      if (!rt || !b || !st || b.status !== 'running' || !g) continue;
      const reason = evaluateGuards(g, st, rt.ledger.equity(rt.marks(ctx)), rt.trades, b.symbol, st.guardsFrom ?? b.startedAt ?? 0, ctx.now());
      if (reason) this.trip(id, reason);
    }
  }

  /** A risk guard tripped: cancel the bot's orders, close its position and pause it. */
  private trip(id: string, reason: string): void {
    const rt = this.engine.accounts.get(id);
    const b = rt?.config.bot;
    if (!rt || !b) return;
    this.halt(id);
    const ctx = this.engine.ctx;
    const now = ctx.now();
    for (const o of rt.orders.filter((x) => x.symbol === b.symbol)) rt.cancelOrder(o.id, now, 'risk guard');
    if (rt.ledger.position(b.symbol)) {
      try {
        rt.closePosition(b.symbol, ctx, undefined, 'bot', 'risk guard');
      } catch (e) {
        rt.event('error', `Could not close the position: ${(e as Error).message}`, { bot: true }, now);
      }
    }
    b.status = 'paused';
    b.lastError = `Risk guard: ${reason}. Position closed, bot paused.`;
    rt.event('rule', `Bot risk guard: ${reason} — position closed, bot paused`, { bot: true }, now);
    this.core.notify(rt.config.name, `Bot paused by its risk guard: ${reason}`);
    this.core.router.broadcast('toast', { title: `${rt.config.name}: risk guard`, body: `${reason}. Position closed, bot paused.`, kind: 'warn' });
    this.engine.persist(id);
    this.engine.recalc();
    this.changed(id);
  }

  private updateWarm(): void {
    this.scripts.pool.keepWarm = this.runners.size;
    this.core.router.broadcast('bots:changed', {});
  }

  private launch(id: string): void {
    this.halt(id);
    const r = new BotRunner(this, id);
    this.runners.set(id, r);
    this.updateWarm();
    r.start().catch((e) => {
      if (this.runners.get(id) !== r) return;
      this.engine.get(id).event('error', `Bot could not start: ${(e as Error).message}`, { bot: true });
      this.restartLater(id);
    });
    this.engine.recalc();
    this.changed(id);
  }

  /** Retry a bot whose data could not be loaded (network). */
  restartLater(id: string): void {
    if (this.restartTimers.has(id)) return;
    this.restartTimers.set(
      id,
      setTimeout(() => {
        this.restartTimers.delete(id);
        const b = this.engine.accounts.get(id)?.config.bot;
        if (b?.status === 'running') this.launch(id);
      }, 30000),
    );
  }

  private halt(id: string): void {
    const t = this.restartTimers.get(id);
    if (t) clearTimeout(t);
    this.restartTimers.delete(id);
    this.runners.get(id)?.stop();
    if (this.runners.delete(id)) this.updateWarm();
  }

  private botOf(id: string): BotConfig {
    const b = this.engine.get(id).config.bot;
    if (!b) throw new Error('Validation: not a bot account');
    return b;
  }

  /** Pause the bot with an error (script error, repeated order failures, liquidation). */
  fail(id: string, message: string, scriptError = false): void {
    const rt = this.engine.accounts.get(id);
    const b = rt?.config.bot;
    if (!rt || !b) return;
    this.halt(id);
    b.status = 'error';
    b.lastError = message;
    // resting entries could open new positions while nobody watches; exits keep protecting the position
    for (const o of rt.orders.filter((x) => x.source === 'bot' && !x.reduceOnly)) rt.cancelOrder(o.id, Date.now(), 'bot paused after an error');
    rt.event('error', `${scriptError ? 'Strategy error' : 'Bot error'}: ${message}`, { bot: true });
    this.core.notify(rt.config.name, `Bot paused: ${message}`);
    this.core.router.broadcast('toast', { title: `${rt.config.name}: bot paused`, body: message, kind: 'error' });
    this.engine.persist(id);
    this.engine.recalc();
    this.changed(id);
  }

  configure(id: string, patch: Partial<BotConfig>): BotConfig {
    const rt = this.engine.get(id);
    if (rt.config.kind !== 'bot') throw new Error('Validation: not a bot account');
    const cur = rt.config.bot;
    const running = cur && (cur.status === 'running' || cur.status === 'paused');
    const structural: (keyof BotConfig)[] = ['scriptId', 'params', 'symbol', 'tf', 'chartType', 'sizing', 'startMode', 'warmupBars', 'language'];
    if (patch.guards) {
      const g = patch.guards;
      const pos = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
      patch = { ...patch, guards: { maxDrawdownPct: pos(g.maxDrawdownPct), maxDailyLossPct: pos(g.maxDailyLossPct), maxConsecutiveLosses: pos(g.maxConsecutiveLosses) ? Math.round(Number(g.maxConsecutiveLosses)) : undefined } };
    }
    if (patch.paramTitles) patch = { ...patch, paramTitles: Object.fromEntries(Object.entries(patch.paramTitles).map(([k, v]) => [String(k), String(v).slice(0, 80)])) };
    if (running && structural.some((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(cur![k]))) throw new Error('Validation: stop the bot before changing its strategy, instrument or sizing');
    const base: BotConfig = cur || { scriptId: '', language: 'pine', params: {}, symbol: 'BTCUSDT', market: rt.config.market, tf: '15m', chartType: 'candles', status: 'stopped', sizing: { mode: 'percentEquity', value: 10 }, autostart: true };
    const next: BotConfig = { ...base, ...patch, market: rt.config.market, status: base.status, state: base.state };
    if (!isSymbol(next.symbol)) throw new Error('Validation: unsupported symbol');
    if (!parseTimeframe(next.tf)) throw new Error('Validation: invalid timeframe');
    if (next.scriptId) {
      const doc = this.scripts.library.get(next.scriptId);
      if (!doc) throw new Error('Validation: script not found');
      next.language = doc.language;
      next.scriptName = doc.name;
    }
    if (!['percentEquity', 'fixedUsd', 'fixedQty', 'strategy'].includes(next.sizing?.mode) || !(+next.sizing.value > 0)) throw new Error('Validation: sizing value must be positive');
    next.warmupBars = Math.max(0, Math.min(20000, Math.round(next.warmupBars ?? DEFAULT_WARMUP)));
    rt.config.bot = next;
    rt.event('bot', 'Bot settings updated', { bot: true });
    this.engine.persist(id);
    this.changed(id);
    return next;
  }

  startBot(id: string, opts: { mode?: 'next' | 'join' } = {}): BotConfig {
    const rt = this.engine.get(id);
    const b = this.botOf(id);
    if (!b.scriptId) throw new Error('Validation: choose a strategy first');
    if (b.status === 'running') return b;
    const doc = this.scripts.library.get(b.scriptId);
    if (!doc) throw new Error('Validation: the strategy script no longer exists');
    if (doc.language === 'python' && !this.scripts.pool.pythonAvailable) throw new Error('Validation: Python is not available in this build');
    const resume = b.status === 'paused' || (b.status === 'error' && !!b.state);
    const ctx = this.engine.ctx;
    if (!resume || !b.state) {
      const tf = parseTimeframe(b.tf)!;
      const mode = opts.mode || b.startMode || 'next';
      const now = ctx.now();
      const cur = b.chartType === 'renko' ? now : bucketStart(tf, now);
      const simFrom = mode === 'join' ? cur - JOIN_BARS * tfDurationMs(tf) : cur;
      const equity = rt.snapshot(ctx).equity;
      if (!(equity > 0)) throw new Error('Validation: the account has no equity');
      b.state = { simFrom, capital: equity, scale: null, hold: null, prevSimPos: null, prevTarget: null, lastBarTime: 0, steps: 0, failures: 0 } satisfies BotRunState;
      b.startMode = mode;
      b.startedAt = now;
      rt.event('bot', `Bot started: ${b.scriptName || doc.name} on ${b.symbol} ${b.tf}${b.chartType !== 'candles' ? ` (${b.chartType})` : ''} — ${mode === 'join' ? "joins the strategy's current position" : 'acts on signals after the start'}`, { bot: true });
    } else {
      b.state.failures = 0;
      // a fresh start for the risk guards: the drawdown peak and the losing streak restart now
      b.state.peakEquity = undefined;
      b.state.guardsFrom = ctx.now();
      rt.event('bot', 'Bot resumed', { bot: true });
    }
    b.status = 'running';
    b.lastError = undefined;
    this.engine.persist(id);
    this.launch(id);
    return b;
  }

  pause(id: string, reason = 'Bot paused'): BotConfig {
    const b = this.botOf(id);
    if (b.status !== 'running') return b;
    this.halt(id);
    b.status = 'paused';
    b.lastError = undefined;
    this.engine.get(id).event('bot', `${reason} — orders and positions stay as they are`, { bot: true });
    this.engine.persist(id);
    this.engine.recalc();
    this.changed(id);
    return b;
  }

  stopBot(id: string, opts: { close?: boolean } = {}): BotConfig {
    const rt = this.engine.get(id);
    const b = this.botOf(id);
    this.halt(id);
    const now = this.engine.ctx.now();
    for (const o of rt.orders.filter((x) => x.source === 'bot')) rt.cancelOrder(o.id, now, 'bot stopped');
    if (opts.close && rt.ledger.position(b.symbol)) {
      try {
        rt.closePosition(b.symbol, this.engine.ctx, undefined, 'bot', 'bot stopped');
      } catch (e) {
        rt.event('error', `Could not close the position: ${(e as Error).message}`, { bot: true }, now);
      }
    }
    b.status = 'stopped';
    b.lastError = undefined;
    b.state = undefined;
    rt.event('bot', `Bot stopped${opts.close ? ' and position closed' : ''}`, { bot: true }, now);
    this.engine.persist(id);
    this.engine.recalc();
    this.changed(id);
    return b;
  }

  async stepNow(id: string): Promise<boolean> {
    const r = this.runners.get(id);
    if (!r) throw new Error('Validation: the bot is not running');
    await r.step(true);
    return true;
  }

  view(id: string, full = false): BotView | null {
    const rt = this.engine.accounts.get(id);
    const b = rt?.config.bot;
    if (!rt || !b) return null;
    const r = this.runners.get(id);
    const ctx = this.engine.ctx;
    const snap = rt.snapshot(ctx);
    const pos = snap.positions.find((p) => p.symbol === b.symbol);
    const phase: BotView['phase'] = b.status === 'running' ? r?.phase || 'loading' : b.status === 'error' ? 'error' : b.status;
    const phaseText = b.status === 'running' ? r?.phaseText || 'Starting…' : b.status === 'error' ? b.lastError || 'Error' : b.status === 'paused' ? 'Paused — orders and positions are kept' : 'Stopped';
    const last = r?.last || this.lastResults.get(id) || null;
    if (r?.last) this.lastResults.set(id, r.last);
    return {
      accountId: id,
      name: rt.config.name,
      color: rt.config.color,
      market: rt.config.market,
      config: b,
      phase,
      phaseText,
      nextStepAt: r?.nextStepAt ?? null,
      lastStepAt: r?.lastStepAt ?? null,
      stepMs: r?.stepMs ?? 0,
      bars: r?.bars ?? 0,
      account: {
        equity: snap.equity,
        initial: rt.config.initialBalance,
        startEquity: b.state?.capital ?? null,
        realized: snap.realizedPnl,
        unrealized: snap.unrealizedPnl,
        fees: snap.feesPaid,
        position: pos ? pos.side * pos.qty : 0,
        entry: pos?.entry ?? null,
        mark: pos?.mark ?? (ctx.last(rt.config.market, b.symbol) || null),
        liqPrice: pos?.liqPrice ?? null,
        openOrders: snap.orders.filter((o) => o.symbol === b.symbol).length,
        status: snap.status,
        trades: rt.trades.filter((t) => t.symbol === b.symbol && (!b.startedAt || t.closedAt >= b.startedAt)).length,
      },
      sim: last
        ? full
          ? last
          : { ...last, trades: last.trades.slice(-5), fills: last.fills.slice(-5), logs: last.logs.slice(-5), alerts: [], pending: last.pending, values: last.values.slice(0, 6) }
        : null,
      lastPlan: r?.lastPlan ?? null,
    };
  }

  private lastResults = new Map<string, BotStepResult>();

  list(): BotView[] {
    const out: BotView[] = [];
    for (const rt of this.engine.accounts.values()) {
      if (rt.config.kind !== 'bot' || rt.config.archived || rt.config.replay) continue;
      const v = this.view(rt.config.id);
      if (v) out.push(v);
      else
        out.push({
          accountId: rt.config.id,
          name: rt.config.name,
          color: rt.config.color,
          market: rt.config.market,
          config: null,
          phase: 'stopped',
          phaseText: 'Not configured',
          nextStepAt: null,
          lastStepAt: null,
          stepMs: 0,
          bars: 0,
          account: { equity: rt.snapshot(this.engine.ctx).equity, initial: rt.config.initialBalance, startEquity: null, realized: 0, unrealized: 0, fees: 0, position: 0, entry: null, mark: null, liqPrice: null, openOrders: rt.orders.length, status: 'active', trades: 0 },
          sim: null,
          lastPlan: null,
        } as BotView);
    }
    return out;
  }

  onChange(l: (id: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  shutdown(): void {
    for (const id of [...this.runners.keys()]) this.runners.get(id)?.stop();
    this.runners.clear();
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
  }
}

export function registerBots(core: AppCore, engine: TradingEngine, scripts: ScriptService): BotService {
  const svc = new BotService(core, engine, scripts);
  const r = core.router;
  r.handle('bots:list', () => svc.list());
  r.handle('bots:get', ([id]) => svc.view(String(id), true));
  r.handle('bots:configure', ([id, patch]) => svc.configure(String(id), patch || {}));
  r.handle('bots:start', ([id, opts]) => svc.startBot(String(id), opts || {}));
  r.handle('bots:pause', ([id]) => svc.pause(String(id)));
  r.handle('bots:stop', ([id, opts]) => svc.stopBot(String(id), opts || {}));
  r.handle('bots:stepNow', ([id]) => svc.stepNow(String(id)));
  r.handle('bots:pauseAll', () => {
    core.pauseAllBots();
    return true;
  });
  r.topic('bots', (_p, push) => {
    push(svc.list());
    let dirty = false;
    const off = svc.onChange(() => (dirty = true));
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (dirty || n % 4 === 0) {
        dirty = false;
        push(svc.list());
      }
    }, 500);
    return () => {
      clearInterval(timer);
      off();
    };
  });
  r.topic('bot', (p: { id: string }, push) => {
    const send = () => push(svc.view(p.id, true));
    send();
    let dirty = false;
    const off = svc.onChange((id) => id === p.id && (dirty = true));
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (dirty || n % 4 === 0) {
        dirty = false;
        send();
      }
    }, 500);
    return () => {
      clearInterval(timer);
      off();
    };
  });
  core.onShutdown(() => svc.shutdown());
  svc.start();
  return svc;
}
