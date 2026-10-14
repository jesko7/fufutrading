/**
 * AlertService — evaluates alerts on live data in the main process.
 *  - price / move alerts: on every aggregate trade of the shared live tape (cheap comparisons),
 *  - indicator / script alerts: on a live script instance (the same engine charts use) — plot
 *    conditions, alertcondition() signals, alert() calls and strategy orders, intrabar or on bar close,
 *  - order-book alerts: twice a second on the shared local book (imbalance, liquidity within a
 *    range, spread, large resting orders), optionally sustained for N seconds.
 * Triggers notify on the desktop and in the app (toast + sound) and are kept in an alert log.
 * Evaluators exist only for enabled alerts and share market data with everything else.
 */
import path from 'node:path';
import type { AppCore } from './core';
import type { ScriptService } from './scripts/service';
import { LiveScript } from './scripts/service';
import { DocStore, uid, readJson, writeJsonAtomic } from './storage/jsonStore';
import { applyPatch } from '../engine/patch';
import type { ScriptResult } from '../engine/types';
import type { TradeTick } from '../shared/live';
import { alertTitle, describeAlert, instrumentLabel, renderMessage, type Alert, type AlertEvent, type BookAlert, type IndicatorAlert, type MoveAlert, type PriceAlert, type ScriptAlert } from '../shared/alerts';
import { isSymbol, type Market, type SymbolId } from '../shared/symbols';
import { parseTimeframe } from '../shared/timeframes';

const MAX_LOG = 1000;

interface Evaluator {
  stop(): void;
}

function fmtPrice(p: number): string {
  return isFinite(p) ? p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 2 : 4 }) : '—';
}

export class AlertService {
  private store: DocStore<Alert>;
  private logFile: string;
  log: AlertEvent[];
  private evaluators = new Map<string, { hash: string; ev: Evaluator }>();
  /** Shared per-instrument trade listeners for price/move alerts. */
  private tapes = new Map<string, { release: () => void; unlisten: () => void; alerts: Set<string>; prev: number; samples: { t: number; p: number }[] }>();
  private listeners = new Set<() => void>();
  private expiryTimer: NodeJS.Timeout;
  private logDirty = false;

  constructor(
    readonly core: AppCore,
    readonly scripts: ScriptService,
  ) {
    this.store = new DocStore<Alert>(path.join(core.paths.userData, 'alerts'));
    this.logFile = path.join(core.paths.userData, 'alert-log.json');
    this.log = readJson<AlertEvent[]>(this.logFile, []);
    this.expiryTimer = setInterval(() => this.housekeeping(), 15000);
    this.expiryTimer.unref?.();
    core.onShutdown(() => this.shutdown());
  }

  list(): Alert[] {
    return this.store.loadAll().sort((a, b) => b.created - a.created);
  }

  get(id: string): Alert | undefined {
    return this.store.get(id);
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
    this.core.router.broadcast('alerts:changed', {});
  }

  // ------------------------------------------------------------------ CRUD

  save(input: Partial<Alert> & { kind: Alert['kind'] }): Alert {
    const cur = input.id ? this.store.get(input.id) : undefined;
    const now = Date.now();
    const a = { ...(cur || {}), ...input } as Alert;
    a.id = cur?.id || uid('al');
    a.created = cur?.created || now;
    a.updated = now;
    a.triggerCount = cur?.triggerCount || 0;
    a.lastTriggered = cur?.lastTriggered;
    this.validate(a);
    if (a.enabled) {
      a.status = 'active';
      a.error = undefined;
    } else if (a.status === 'active') a.status = 'disabled';
    a.name = String(a.name || '').slice(0, 120);
    a.message = String(a.message || '').slice(0, 1000);
    this.store.put(a, true);
    this.reconcile();
    this.changed();
    return a;
  }

  private validate(a: Alert): void {
    if (!isSymbol(a.symbol) || (a.market !== 'spot' && a.market !== 'futures')) throw new Error('Validation: choose BTC, ETH or SOL on spot or futures');
    if (!['once', 'perBar', 'perMinute', 'every'].includes(a.frequency)) a.frequency = 'once';
    a.cooldownSec = Math.max(0, Math.min(86400, Math.round(+a.cooldownSec || 0)));
    switch (a.kind) {
      case 'price':
        if (!(a.level > 0)) throw new Error('Validation: enter a price level');
        if ((a.condition === 'enterChannel' || a.condition === 'exitChannel') && !(a.level2 && a.level2 > a.level)) throw new Error('Validation: the channel needs an upper level above the lower one');
        break;
      case 'move':
        if (!(a.pct > 0) || !(a.minutes > 0)) throw new Error('Validation: percentage and window must be positive');
        a.minutes = Math.min(1440, a.minutes);
        break;
      case 'indicator':
      case 'script':
        if (!a.scriptId || !this.scripts.library.get(a.scriptId)) throw new Error('Validation: choose a script');
        if (!parseTimeframe(a.tf)) throw new Error('Validation: invalid timeframe');
        a.scriptName = this.scripts.library.get(a.scriptId)!.name;
        if (a.kind === 'indicator' && !a.plot) throw new Error('Validation: choose a plot');
        break;
      case 'book':
        if (!(a.rangePct > 0) || a.rangePct > 10) throw new Error('Validation: range must be between 0 and 10%');
        a.sustainSec = Math.max(0, Math.min(3600, Math.round(+a.sustainSec || 0)));
        break;
    }
  }

  setEnabled(id: string, on: boolean): Alert {
    const a = this.store.get(id);
    if (!a) throw new Error('Alert not found');
    a.enabled = on;
    a.status = on ? 'active' : 'disabled';
    a.error = undefined;
    if (on && a.expiresAt && a.expiresAt < Date.now()) a.expiresAt = null;
    a.updated = Date.now();
    this.store.put(a, true);
    this.reconcile();
    this.changed();
    return a;
  }

  remove(id: string): void {
    this.store.delete(id);
    this.reconcile();
    this.changed();
  }

  clearLog(): void {
    this.log = [];
    this.logDirty = true;
    this.flushLog();
    this.changed();
  }

  // ------------------------------------------------------------------ evaluators

  /** Start evaluators for enabled alerts, stop the rest. */
  reconcile(): void {
    const want = new Map<string, Alert>();
    for (const a of this.store.loadAll()) if (a.enabled && a.status !== 'expired') want.set(a.id, a);
    // price / move alerts share one trade listener per instrument
    const tapeAlerts = new Map<string, Set<string>>();
    for (const a of want.values()) {
      if (a.kind !== 'price' && a.kind !== 'move') continue;
      const key = `${a.market}:${a.symbol}`;
      if (!tapeAlerts.has(key)) tapeAlerts.set(key, new Set());
      tapeAlerts.get(key)!.add(a.id);
    }
    for (const [key, ids] of tapeAlerts) {
      let e = this.tapes.get(key);
      if (!e) {
        const [market, symbol] = key.split(':') as [Market, SymbolId];
        const { tape, release } = this.core.hub.acquireTape(market, symbol);
        const entry = { release, unlisten: () => {}, alerts: ids, prev: tape.lastPrice, samples: [] as { t: number; p: number }[] };
        entry.unlisten = tape.addListener({ onTrade: (tr) => this.onTrade(key, tr) });
        this.tapes.set(key, entry);
        e = entry;
      }
      e.alerts = ids;
    }
    for (const [key, e] of this.tapes) {
      if (tapeAlerts.has(key)) continue;
      e.unlisten();
      e.release();
      this.tapes.delete(key);
    }
    // script and book alerts have their own evaluators
    for (const [id, cur] of this.evaluators) {
      const a = want.get(id);
      if (!a || cur.hash !== this.hashOf(a)) {
        cur.ev.stop();
        this.evaluators.delete(id);
      }
    }
    for (const a of want.values()) {
      if (this.evaluators.has(a.id)) continue;
      if (a.kind === 'indicator' || a.kind === 'script') this.evaluators.set(a.id, { hash: this.hashOf(a), ev: this.scriptEvaluator(a) });
      else if (a.kind === 'book') this.evaluators.set(a.id, { hash: this.hashOf(a), ev: this.bookEvaluator(a) });
    }
  }

  private hashOf(a: Alert): string {
    const { lastTriggered: _l, triggerCount: _c, status: _s, updated: _u, error: _e, ...rest } = a as Alert & Record<string, unknown>;
    return JSON.stringify(rest);
  }

  private onTrade(key: string, tr: TradeTick): void {
    const e = this.tapes.get(key);
    if (!e) return;
    const prev = e.prev > 0 ? e.prev : tr.p;
    e.prev = tr.p;
    const p = tr.p;
    // one price sample per second for move alerts
    const last = e.samples[e.samples.length - 1];
    if (!last || tr.t - last.t >= 1000) e.samples.push({ t: tr.t, p });
    else last.p = p;
    const keepMs = 1441 * 60000;
    while (e.samples.length && tr.t - e.samples[0].t > keepMs) e.samples.shift();
    for (const id of e.alerts) {
      const a = this.store.get(id);
      if (!a || !a.enabled) continue;
      if (a.kind === 'price') this.evalPrice(a, prev, p);
      else if (a.kind === 'move') this.evalMove(a, e.samples, p, tr.t);
    }
  }

  private evalPrice(a: PriceAlert, prev: number, p: number): void {
    const L = a.level;
    let hit = false;
    switch (a.condition) {
      case 'crossesAbove':
        hit = prev < L && p >= L;
        break;
      case 'crossesBelow':
        hit = prev > L && p <= L;
        break;
      case 'crosses':
        hit = (prev < L && p >= L) || (prev > L && p <= L);
        break;
      case 'above':
        hit = p > L;
        break;
      case 'below':
        hit = p < L;
        break;
      case 'enterChannel': {
        const H = a.level2 ?? L;
        hit = !(prev >= L && prev <= H) && p >= L && p <= H;
        break;
      }
      case 'exitChannel': {
        const H = a.level2 ?? L;
        hit = prev >= L && prev <= H && (p < L || p > H);
        break;
      }
    }
    if (hit) this.fire(a, `${instrumentLabel(a.symbol, a.market)} ${describeAlert(a).split(' ').slice(1).join(' ')} — now ${fmtPrice(p)}`, { price: p, value: p });
  }

  private evalMove(a: MoveAlert, samples: { t: number; p: number }[], p: number, t: number): void {
    const from = t - a.minutes * 60000;
    // the window restarts after a trigger so one move fires once (exchange time, like the samples)
    const since = Math.max(from, this.moveReset.get(a.id) ?? 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = samples.length - 1; i >= 0 && samples[i].t >= since; i--) {
      if (samples[i].p < lo) lo = samples[i].p;
      if (samples[i].p > hi) hi = samples[i].p;
    }
    if (!isFinite(lo)) return;
    const up = ((p - lo) / lo) * 100;
    const down = ((hi - p) / hi) * 100;
    const ins = instrumentLabel(a.symbol, a.market);
    let fired = false;
    if ((a.direction === 'up' || a.direction === 'either') && up >= a.pct) fired = this.fire(a, `${ins} rose ${up.toFixed(2)}% within ${a.minutes} min — now ${fmtPrice(p)}`, { price: p, value: up });
    else if ((a.direction === 'down' || a.direction === 'either') && down >= a.pct) fired = this.fire(a, `${ins} fell ${down.toFixed(2)}% within ${a.minutes} min — now ${fmtPrice(p)}`, { price: p, value: -down });
    if (fired) this.moveReset.set(a.id, t);
  }

  private scriptEvaluator(a: IndicatorAlert | ScriptAlert): Evaluator {
    let result: ScriptResult | null = null;
    let lastBar = -1;
    let lastT = NaN;
    let prevVal = NaN;
    let prevTgt = NaN;
    let primed = false;
    const evaluate = () => {
      const r = result;
      if (!r || !r.ok) return;
      const n = r.stats.bars;
      if (n < 3) return;
      // realtime: the forming bar; bar close: the last closed bar
      const i = a.onBarClose ? n - 2 : n - 1;
      const newBar = i !== lastBar;
      if (a.kind === 'indicator') {
        const plot = r.plots.find((p) => p.id === a.plot) || r.plots.find((p) => p.title === a.plot);
        if (!plot) {
          this.setError(a.id, `Plot “${a.plotTitle || a.plot}” not found in the script`);
          return;
        }
        const tgtAt = (k: number) => (a.target.type === 'value' ? a.target.value : a.target.type === 'price' ? NaN : (r.plots.find((p) => p.id === (a.target as { plot: string }).plot || p.title === (a.target as { plot: string }).plot)?.values[k] ?? NaN));
        const v = plot.values[i];
        const tgt = a.target.type === 'price' ? this.lastPrice(a.market, a.symbol) : tgtAt(i);
        // previous value: the bar before on bar close; the previous evaluation intrabar
        let pv = prevVal;
        let pt = prevTgt;
        if (a.onBarClose || newBar) {
          pv = plot.values[i - 1];
          pt = a.target.type === 'price' ? pt : tgtAt(i - 1);
        }
        prevVal = v;
        prevTgt = tgt;
        lastBar = i;
        if (!primed) {
          primed = true;
          if (a.onBarClose) return;
        }
        if (!(isFinite(v) && isFinite(tgt))) return;
        let hit = false;
        switch (a.condition) {
          case 'crossesAbove':
            hit = isFinite(pv) && isFinite(pt) && pv < pt && v >= tgt;
            break;
          case 'crossesBelow':
            hit = isFinite(pv) && isFinite(pt) && pv > pt && v <= tgt;
            break;
          case 'crosses':
            hit = isFinite(pv) && isFinite(pt) && ((pv < pt && v >= tgt) || (pv > pt && v <= tgt));
            break;
          case 'above':
            hit = v > tgt;
            break;
          case 'below':
            hit = v < tgt;
            break;
        }
        if (hit && (!a.onBarClose || newBar)) this.fire(a, `${alertTitle(a)} — ${a.plotTitle || plot.title}: ${fmtPrice(v)}`, { value: v, price: this.lastPrice(a.market, a.symbol), bar: i });
        return;
      }
      // script alerts
      if (a.trigger.type === 'alertcondition') {
        const title = a.trigger.title;
        const ac = r.alerts.find((x) => x.title === title);
        if (!ac) {
          this.setError(a.id, `alertcondition “${title}” not found in the script`);
          return;
        }
        if (!primed) {
          primed = true;
          lastBar = i;
          if (a.onBarClose) return;
        }
        if (ac.values[i] && (newBar || !a.onBarClose)) {
          lastBar = i;
          this.fire(a, `${a.scriptName}: ${ac.message || title}`, { price: this.lastPrice(a.market, a.symbol), bar: i });
        }
        lastBar = i;
        return;
      }
      if (a.trigger.type === 'alert') {
        const evs = r.alertEvents;
        if (!primed) {
          primed = true;
          lastT = evs.length ? evs[evs.length - 1].time : NaN;
          return;
        }
        const fresh = evs.filter((e) => !(e.time <= lastT)).filter((e) => !a.onBarClose || e.bar <= n - 2);
        if (fresh.length) {
          lastT = fresh[fresh.length - 1].time;
          for (const e of fresh.slice(-3)) this.fire(a, `${a.scriptName}: ${e.message}`, { price: this.lastPrice(a.market, a.symbol), bar: e.bar });
        }
        return;
      }
      // strategy orders
      const fills = r.strategy?.fills || [];
      if (!primed) {
        primed = true;
        lastT = fills.length ? fills[fills.length - 1].t : NaN;
        return;
      }
      const fresh = fills.filter((f) => !(f.t <= lastT));
      if (fresh.length) {
        lastT = fresh[fresh.length - 1].t;
        for (const f of fresh.slice(-3)) this.fire(a, `${a.scriptName}: ${f.side === 'buy' ? 'BUY' : 'SELL'} ${+f.qty.toFixed(6)} @ ${fmtPrice(f.price)} (${f.kind} “${f.id}”)`, { price: f.price, bar: f.bar });
      }
    };
    const live = new LiveScript(this.scripts, { scriptId: a.scriptId, inputs: a.inputs || {}, spec: { symbol: a.symbol, market: a.market, tf: a.tf, chartType: a.chartType === 'heikinashi' ? 'heikinashi' : 'candles' }, bars: 1500 }, (m: any) => {
      try {
        if (m.type === 'full') result = m.result;
        else if (m.type === 'patch' && result) result = applyPatch(result, m.patch);
        else if (m.type === 'error') {
          this.setError(a.id, String(m.message));
          return;
        } else return;
        if (result && !result.ok) {
          this.setError(a.id, `${result.error?.line ? `Line ${result.error.line}: ` : ''}${result.error?.message || 'Script error'}`);
          return;
        }
        this.clearError(a.id);
        evaluate();
      } catch (e) {
        this.core.log('warn', `alert ${a.id}: ${(e as Error).message}`);
      }
    });
    live.start().catch((e) => this.setError(a.id, (e as Error).message));
    return { stop: () => live.stop() };
  }

  private bookEvaluator(a: BookAlert): Evaluator {
    const { book, release } = this.core.hub.acquireBook(a.market, a.symbol);
    let since: number | null = null;
    const seenLarge = new Set<string>();
    let primed = false;
    const timer = setInterval(() => {
      try {
        if (book.status !== 'live') return;
        const b = book.book;
        const mid = b.mid();
        if (!isFinite(mid)) return;
        const now = Date.now();
        if (a.metric === 'largeOrder') {
          const lo = mid * (1 - a.rangePct / 100);
          const hi = mid * (1 + a.rangePct / 100);
          const big: { side: string; price: number; notional: number }[] = [];
          for (const p of b.bidPrices()) {
            if (p < lo) break;
            const n = b.bids.get(p)! * p;
            if (n >= a.value) big.push({ side: 'bid', price: p, notional: n });
          }
          for (const p of b.askPrices()) {
            if (p > hi) break;
            const n = b.asks.get(p)! * p;
            if (n >= a.value) big.push({ side: 'ask', price: p, notional: n });
          }
          const keys = new Set(big.map((x) => `${x.side}@${x.price}`));
          if (!primed) {
            primed = true;
            for (const k of keys) seenLarge.add(k);
            return;
          }
          for (const x of big) {
            const k = `${x.side}@${x.price}`;
            if (seenLarge.has(k)) continue;
            this.fire(a, `${instrumentLabel(a.symbol, a.market)}: ${x.side === 'bid' ? 'bid' : 'ask'} of ${Math.round(x.notional).toLocaleString('en-US')} USDT at ${fmtPrice(x.price)}`, { price: mid, value: x.notional });
          }
          for (const k of [...seenLarge]) if (!keys.has(k)) seenLarge.delete(k);
          for (const k of keys) seenLarge.add(k);
          return;
        }
        let v: number;
        if (a.metric === 'spreadBps') v = ((b.bestAsk() - b.bestBid()) / mid) * 10000;
        else {
          const lo = mid * (1 - a.rangePct / 100);
          const hi = mid * (1 + a.rangePct / 100);
          let bid = 0;
          let ask = 0;
          for (const p of b.bidPrices()) {
            if (p < lo) break;
            bid += b.bids.get(p)! * p;
          }
          for (const p of b.askPrices()) {
            if (p > hi) break;
            ask += b.asks.get(p)! * p;
          }
          v = a.metric === 'imbalance' ? (bid + ask > 0 ? ((bid - ask) / (bid + ask)) * 100 : 0) : a.metric === 'bidDepth' ? bid : ask;
        }
        const ok = a.condition === 'above' ? v > a.value : v < a.value;
        if (!ok) {
          since = null;
          return;
        }
        if (since === null) since = now;
        if (now - since < a.sustainSec * 1000) return;
        const unit = a.metric === 'imbalance' ? '%' : a.metric === 'spreadBps' ? ' bps' : ' USDT';
        if (this.fire(a, `${describeAlert(a)} — now ${a.metric === 'imbalance' ? v.toFixed(1) : a.metric === 'spreadBps' ? v.toFixed(v < 0.1 ? 4 : 2) : Math.round(v).toLocaleString('en-US')}${unit}`, { price: mid, value: v })) since = null;
      } catch (e) {
        this.core.log('warn', `book alert ${a.id}: ${(e as Error).message}`);
      }
    }, 500);
    return {
      stop: () => {
        clearInterval(timer);
        release();
      },
    };
  }

  private lastPrice(market: Market, symbol: SymbolId): number {
    return this.core.hub.lastPrice(market, symbol);
  }

  private setError(id: string, msg: string): void {
    const a = this.store.get(id);
    if (!a || a.error === msg) return;
    a.status = 'error';
    a.error = msg.slice(0, 300);
    this.store.put(a, true);
    this.changed();
  }

  private clearError(id: string): void {
    const a = this.store.get(id);
    if (!a || a.status !== 'error') return;
    a.status = 'active';
    a.error = undefined;
    this.store.put(a, true);
    this.changed();
  }

  // ------------------------------------------------------------------ triggering

  private barOfTrigger = new Map<string, number>();
  private moveReset = new Map<string, number>();

  /** Fire an alert if its frequency allows; returns whether it fired. */
  private fire(a: Alert, text: string, extra: { price?: number; value?: number; bar?: number } = {}): boolean {
    const now = Date.now();
    const cur = this.store.get(a.id);
    if (!cur || !cur.enabled) return false;
    if (cur.expiresAt && cur.expiresAt < now) return false;
    const last = cur.lastTriggered || 0;
    switch (cur.frequency) {
      case 'perMinute':
        if (now - last < 60000) return false;
        break;
      case 'perBar':
        if (extra.bar !== undefined) {
          if (this.barOfTrigger.get(cur.id) === extra.bar) return false;
          this.barOfTrigger.set(cur.id, extra.bar);
        } else if (now - last < 60000) return false;
        break;
      case 'every':
        if (now - last < cur.cooldownSec * 1000) return false;
        break;
    }
    const vars = { symbol: instrumentLabel(cur.symbol, cur.market), price: fmtPrice(extra.price ?? NaN), value: extra.value !== undefined ? fmtPrice(extra.value) : '', name: alertTitle(cur), time: new Date(now).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', message: text };
    const message = cur.message?.trim() ? renderMessage(cur.message, vars) : text;
    const ev: AlertEvent = { id: uid('ae'), alertId: cur.id, name: alertTitle(cur), kind: cur.kind, symbol: cur.symbol, market: cur.market, t: now, message, price: extra.price, value: extra.value };
    this.log.push(ev);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.logDirty = true;
    cur.lastTriggered = now;
    cur.triggerCount = (cur.triggerCount || 0) + 1;
    if (cur.frequency === 'once') {
      cur.enabled = false;
      cur.status = 'triggered';
    }
    this.store.put(cur, true);
    if (cur.notify?.desktop !== false) this.core.notify(`🔔 ${ev.name}`, message);
    this.core.router.broadcast('alert:fired', { event: ev, sound: cur.notify?.sound !== false });
    if (cur.frequency === 'once') this.reconcile();
    this.changed();
    return true;
  }

  private housekeeping(): void {
    const now = Date.now();
    let any = false;
    for (const a of this.store.loadAll()) {
      if (a.enabled && a.expiresAt && a.expiresAt < now) {
        a.enabled = false;
        a.status = 'expired';
        this.store.put(a, true);
        any = true;
      }
    }
    if (any) {
      this.reconcile();
      this.changed();
    }
    this.flushLog();
  }

  private flushLog(): void {
    if (!this.logDirty) return;
    this.logDirty = false;
    writeJsonAtomic(this.logFile, this.log);
  }

  shutdown(): void {
    clearInterval(this.expiryTimer);
    for (const e of this.evaluators.values()) e.ev.stop();
    this.evaluators.clear();
    for (const e of this.tapes.values()) {
      e.unlisten();
      e.release();
    }
    this.tapes.clear();
    this.store.flush();
    this.flushLog();
  }
}

export function registerAlerts(core: AppCore, scripts: ScriptService): AlertService {
  const svc = new AlertService(core, scripts);
  const r = core.router;
  r.handle('alerts:list', () => svc.list());
  r.handle('alerts:save', ([a]) => svc.save(a));
  r.handle('alerts:enable', ([id, on]) => svc.setEnabled(String(id), !!on));
  r.handle('alerts:delete', ([id]) => {
    svc.remove(String(id));
    return true;
  });
  r.handle('alerts:log', () => svc.log.slice(-500));
  r.handle('alerts:clearLog', () => {
    svc.clearLog();
    return true;
  });
  r.topic('alerts', (_p, push) => {
    const send = () => push({ alerts: svc.list(), log: svc.log.slice(-300) });
    send();
    let t: NodeJS.Timeout | null = null;
    const off = svc.onChange(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        send();
      }, 150);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  });
  // evaluate after the market hub is up
  setTimeout(() => svc.reconcile(), 1500);
  return svc;
}
