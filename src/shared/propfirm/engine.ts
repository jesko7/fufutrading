/**
 * Prop-firm rule engine. Evaluates a RuleProfile against account balance/equity over time:
 * session (day) boundaries in the firm's time zone, daily loss limits (hard or soft), static /
 * end-of-day trailing / intraday trailing max loss with optional lock, profit targets, minimum
 * trading days, consistency, contract-size limits and trading hours.
 *
 * Pure and deterministic: the live paper engine and the backtester feed it the same inputs.
 */
import type { PropState, RuleProfile, RuleStatus, RuleCheck, Rule } from './types';
import { amountFor } from './profiles';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(t: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; wd: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: wdMap[p.weekday] ?? 0 };
}

/** Session key: local date in the firm's time zone, shifted so the session starts at the reset time. */
export function sessionKey(t: number, session: RuleProfile['session']): string {
  const shift = session.resetHour || session.resetMinute ? (24 * 60 - (session.resetHour * 60 + session.resetMinute)) * 60000 : 0;
  const p = partsIn(t + shift, session.tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export interface RuleInput {
  t: number;
  /** Closed balance (wallet incl. realized P&L, fees, funding). */
  balance: number;
  /** Balance + unrealized P&L. */
  equity: number;
  openPositions: number;
}

export interface RuleEffects {
  events: { kind: 'breach' | 'restricted' | 'passed' | 'info' | 'resumed'; message: string }[];
  flatten: boolean;
}

export class PropRules {
  constructor(
    readonly profile: RuleProfile,
    public state: PropState,
  ) {}

  static init(profile: RuleProfile, size: number, options: Record<string, unknown>, t: number): PropState {
    const opts: Record<string, unknown> = {};
    for (const o of profile.options || []) opts[o.key] = options[o.key] ?? o.default;
    const st: PropState = {
      profileId: profile.id,
      size,
      options: opts,
      initial: size,
      dayKey: sessionKey(t, profile.session),
      dayStartBalance: size,
      dayStartEquity: size,
      highestEodBalance: size,
      highestIntraday: size,
      maxLossFloor: -Infinity,
      locked: false,
      tradingDays: [],
      dailyPnl: {},
      status: 'active',
      lastBalance: size,
    };
    const r = new PropRules(profile, st);
    st.maxLossFloor = r.initialFloor();
    return st;
  }

  private amt(a: Parameters<typeof amountFor>[0]): number | null {
    return amountFor(a, this.state.size, this.profile.sizes);
  }

  private rule<K extends Rule['kind']>(kind: K): Extract<Rule, { kind: K }> | undefined {
    return this.profile.rules.find((r) => r.kind === kind && this.ruleEnabled(r)) as Extract<Rule, { kind: K }> | undefined;
  }

  private ruleEnabled(r: Rule): boolean {
    if (r.kind === 'dailyLoss' && r.optional) return !!this.state.options[r.optional];
    return true;
  }

  private maxLossRule(): Extract<Rule, { kind: 'maxLoss' }> | undefined {
    const r = this.rule('maxLoss');
    if (!r) return undefined;
    if (r.optionKey === 'drawdown' && this.state.options.drawdown === 'intraday') return { ...r, mode: 'intradayTrailing' };
    return r;
  }

  private initialFloor(): number {
    const r = this.maxLossRule();
    if (!r) return -Infinity;
    const a = this.amt(r.amount) ?? 0;
    return this.state.initial - a;
  }

  /** Current daily loss allowance (fixed or LucidScale). */
  dailyLimit(): number | null {
    const r = this.rule('dailyLoss');
    if (!r) return null;
    if (r.scaling) {
      const after = this.amt(r.scaling.afterBalance);
      if (after !== null && this.state.highestEodBalance > after) {
        return Math.max(0, (this.state.highestEodBalance - this.state.initial) * r.scaling.pctOfPeakEodProfit);
      }
    }
    return this.amt(r.amount);
  }

  dailyFloor(): number | null {
    const lim = this.dailyLimit();
    if (lim === null) return null;
    return this.state.dayStartBalance - lim;
  }

  /** Called when a position is opened or increased. */
  onPositionOpened(t: number): void {
    const k = sessionKey(t, this.profile.session);
    if (!this.state.tradingDays.includes(k)) this.state.tradingDays.push(k);
  }

  /** Called with each realized P&L (net of fees) to track per-session results. */
  onRealized(t: number, pnl: number): void {
    const k = sessionKey(t, this.profile.session);
    this.state.dailyPnl[k] = (this.state.dailyPnl[k] || 0) + pnl;
  }

  /** Is trading allowed right now? */
  canTrade(t: number): { ok: boolean; reason?: string } {
    if (this.state.status === 'breached') return { ok: false, reason: `Account breached: ${this.state.reason}` };
    if (this.state.status === 'passed') return { ok: false, reason: 'Phase passed — start the next phase to continue trading' };
    if (this.state.status === 'restricted') return { ok: false, reason: `Trading restricted until the next session: ${this.state.reason}` };
    const hours = this.rule('tradingHours');
    if (hours && !this.inTradingHours(t, hours)) return { ok: false, reason: `Outside allowed trading hours (flat by ${hours.flatBy}, reopen ${hours.reopen} ET Sun–Thu)` };
    return { ok: true };
  }

  inTradingHours(t: number, h: Extract<Rule, { kind: 'tradingHours' }>): boolean {
    const p = partsIn(t, h.tz);
    const mins = p.h * 60 + p.mi;
    const [fh, fm] = h.flatBy.split(':').map(Number);
    const [rh, rm] = h.reopen.split(':').map(Number);
    const flat = fh * 60 + fm;
    const reopen = rh * 60 + rm;
    // closed: Saturday all day; Friday after flat-by; Sunday before reopen; weekdays between flat-by and reopen
    if (p.wd === 6) return false;
    if (p.wd === 5 && mins >= flat) return false;
    if (p.wd === 0 && mins < reopen) return false;
    if (p.wd >= 1 && p.wd <= 5 && mins >= flat && mins < reopen) return false;
    return true;
  }

  /** Max position size in micro contracts (if limited), considering the scaling plan. */
  maxMicros(): number | null {
    const r = this.rule('maxSize');
    if (!r) return null;
    let v = this.amt(r.micros);
    if (r.scaling) {
      const profit = this.state.highestEodBalance - this.state.initial;
      for (const s of r.scaling) if (profit >= s.profitFloor && s.micros[String(this.state.size)] !== undefined) v = s.micros[String(this.state.size)];
    }
    return v;
  }

  /** Max quantity for a symbol given the contract mapping. */
  maxQty(symbol: string): number | null {
    const m = this.maxMicros();
    const per = this.profile.contractMap?.microQty[symbol];
    if (m === null || !per) return null;
    return m * per;
  }

  update(inp: RuleInput): RuleEffects {
    const fx: RuleEffects = { events: [], flatten: false };
    const st = this.state;
    if (st.status === 'breached') return fx;
    const key = sessionKey(inp.t, this.profile.session);
    if (key !== st.dayKey) this.rollover(key, inp, fx);
    st.lastBalance = inp.balance;
    const ml = this.maxLossRule();
    if (ml) {
      const a = this.amt(ml.amount) ?? 0;
      const lockTrigger = this.amt(ml.lockTrigger);
      const lockLevel = this.amt(ml.lockLevel);
      if (ml.mode === 'intradayTrailing') {
        st.highestIntraday = Math.max(st.highestIntraday, inp.equity);
        if (lockTrigger !== null && lockLevel !== null && st.highestIntraday > lockTrigger) st.locked = true;
        st.maxLossFloor = st.locked && lockLevel !== null ? lockLevel : Math.max(st.maxLossFloor, st.highestIntraday - a);
      }
      const measured = ml.measure === 'equity' ? inp.equity : inp.balance;
      if (measured <= st.maxLossFloor) this.breach(inp.t, `Max loss limit reached (${measured.toFixed(2)} ≤ ${st.maxLossFloor.toFixed(2)})`, fx);
    }
    const dl = this.rule('dailyLoss');
    if (dl && (st.status as PropState['status']) !== 'breached') {
      const floor = this.dailyFloor();
      if (floor !== null && inp.equity <= floor) {
        if (dl.severity === 'hard') this.breach(inp.t, `Max daily loss reached (equity ${inp.equity.toFixed(2)} ≤ ${floor.toFixed(2)})`, fx);
        else if (st.status === 'active') {
          st.status = 'restricted';
          st.restrictedDay = st.dayKey;
          st.reason = 'Daily loss limit reached (soft): positions closed, trading paused until the next session';
          fx.events.push({ kind: 'restricted', message: st.reason });
          fx.flatten = true;
        }
      }
    }
    // trading hours: auto flatten after flat-by time
    const hours = this.rule('tradingHours');
    if (hours && hours.autoFlatten && inp.openPositions > 0 && !this.inTradingHours(inp.t, hours)) {
      fx.flatten = true;
      fx.events.push({ kind: 'info', message: `Flat-by time ${hours.flatBy} ET reached: open positions closed automatically` });
    }
    // pass check
    const pt = this.rule('profitTarget');
    if (pt && st.status === 'active') {
      const target = this.amt(pt.amount) ?? Infinity;
      const flatOk = !pt.requireFlat || inp.openPositions === 0;
      const md = this.rule('minTradingDays');
      const daysOk = !md || st.tradingDays.length >= md.days;
      const cons = this.consistency();
      const consOk = !cons || cons.effect !== 'pass' || cons.ok;
      if (inp.balance - st.initial >= target && flatOk && daysOk && consOk) {
        st.status = 'passed';
        st.passedAt = inp.t;
        st.reason = 'Profit target reached and all objectives met';
        fx.events.push({ kind: 'passed', message: `${this.profile.program} ${this.profile.phase} passed` });
      }
    }
    return fx;
  }

  private rollover(key: string, inp: RuleInput, fx: RuleEffects): void {
    const st = this.state;
    const eodBalance = st.lastBalance;
    st.highestEodBalance = Math.max(st.highestEodBalance, eodBalance);
    const ml = this.maxLossRule();
    if (ml && ml.mode === 'eodTrailing') {
      const a = this.amt(ml.amount) ?? 0;
      const lockTrigger = this.amt(ml.lockTrigger);
      const lockLevel = this.amt(ml.lockLevel);
      if (lockTrigger !== null && lockLevel !== null && st.highestEodBalance > lockTrigger) st.locked = true;
      st.maxLossFloor = st.locked && lockLevel !== null ? lockLevel : Math.max(st.maxLossFloor, Math.max(st.highestEodBalance, st.initial) - a);
    }
    st.dayKey = key;
    st.dayStartBalance = inp.balance;
    st.dayStartEquity = inp.equity;
    if (st.status === 'restricted') {
      st.status = 'active';
      st.reason = undefined;
      fx.events.push({ kind: 'resumed', message: 'New session: trading allowed again' });
    }
  }

  private breach(t: number, reason: string, fx: RuleEffects): void {
    const st = this.state;
    st.status = 'breached';
    st.reason = reason;
    st.breachedAt = t;
    fx.events.push({ kind: 'breach', message: reason });
    fx.flatten = true;
  }

  consistency(): { share: number; limit: number; ok: boolean; effect: string } | null {
    const r = this.rule('consistency');
    if (!r) return null;
    const vals = Object.values(this.state.dailyPnl);
    const best = vals.length ? Math.max(...vals) : 0;
    const basisVal = (this.state.options.consistencyBasis as string) === 'positiveDaysProfit' || r.basis === 'positiveDaysProfit' ? vals.filter((v) => v > 0).reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0);
    const share = basisVal > 0 && best > 0 ? best / basisVal : best > 0 ? 1 : 0;
    return { share, limit: r.maxShare, ok: share <= r.maxShare + 1e-9, effect: r.effect };
  }

  status(inp: RuleInput): RuleStatus {
    const st = this.state;
    const p = this.profile;
    const checks: RuleCheck[] = [];
    const ml = this.maxLossRule();
    const maxLossRemaining = ml ? (ml.measure === 'equity' ? inp.equity : inp.balance) - st.maxLossFloor : null;
    if (ml) {
      const a = this.amt(ml.amount) ?? 0;
      checks.push({
        id: 'maxLoss',
        label: `Max loss (${ml.mode === 'static' ? 'static' : ml.mode === 'eodTrailing' ? 'EOD trailing' : 'intraday trailing'}${st.locked ? ', locked' : ''})`,
        value: `${maxLossRemaining!.toFixed(2)} left`,
        progress: Math.max(0, Math.min(1, 1 - maxLossRemaining! / (a || 1))),
        ok: maxLossRemaining! > 0,
        severity: maxLossRemaining! <= 0 ? 'breach' : maxLossRemaining! < a * 0.25 ? 'warn' : 'info',
        detail: `Floor ${st.maxLossFloor.toFixed(2)} (${ml.measure})`,
      });
    }
    const dFloor = this.dailyFloor();
    const dLim = this.dailyLimit();
    const dailyRemaining = dFloor !== null ? inp.equity - dFloor : null;
    if (dFloor !== null && dLim !== null) {
      const dl = this.rule('dailyLoss')!;
      checks.push({
        id: 'dailyLoss',
        label: `Daily loss (${dl.severity === 'hard' ? 'hard' : 'soft'})`,
        value: `${dailyRemaining!.toFixed(2)} left`,
        progress: Math.max(0, Math.min(1, 1 - dailyRemaining! / (dLim || 1))),
        ok: dailyRemaining! > 0,
        severity: dailyRemaining! <= 0 ? (dl.severity === 'hard' ? 'breach' : 'warn') : dailyRemaining! < dLim * 0.25 ? 'warn' : 'info',
        detail: `Session start balance ${st.dayStartBalance.toFixed(2)} − ${dLim.toFixed(2)} (${p.session.label})`,
      });
    }
    const pt = this.rule('profitTarget');
    let targetProgress: number | null = null;
    if (pt) {
      const target = this.amt(pt.amount) ?? 0;
      targetProgress = target > 0 ? (inp.balance - st.initial) / target : null;
      checks.push({ id: 'target', label: 'Profit target', value: `${(inp.balance - st.initial).toFixed(2)} / ${target.toFixed(2)}`, progress: Math.max(0, Math.min(1, targetProgress ?? 0)), ok: (targetProgress ?? 0) >= 1, severity: (targetProgress ?? 0) >= 1 ? 'pass' : 'info', detail: pt.requireFlat ? 'Counts closed balance with all positions closed' : undefined });
    }
    const md = this.rule('minTradingDays');
    if (md) checks.push({ id: 'days', label: 'Trading days', value: `${st.tradingDays.length} / ${md.days}`, progress: Math.min(1, st.tradingDays.length / md.days), ok: st.tradingDays.length >= md.days, severity: st.tradingDays.length >= md.days ? 'pass' : 'info' });
    const cons = this.consistency();
    if (cons) checks.push({ id: 'consistency', label: `Consistency (${cons.effect === 'pass' ? 'to pass' : 'for payouts'})`, value: `${(cons.share * 100).toFixed(1)}% / ${(cons.limit * 100).toFixed(0)}%`, progress: Math.min(1, cons.share / cons.limit), ok: cons.ok, severity: cons.ok ? 'info' : 'warn', detail: 'Best session profit ÷ total profit. Exceeding it is not a breach.' });
    const mm = this.maxMicros();
    if (mm !== null) checks.push({ id: 'size', label: 'Max size', value: `${mm} micros`, ok: true, severity: 'info', detail: this.profile.contractMap?.note });
    return {
      profileId: p.id,
      firm: p.firm,
      program: p.program,
      phase: p.phase,
      status: st.status,
      reason: st.reason,
      equity: inp.equity,
      balance: inp.balance,
      dailyLossRemaining: dailyRemaining,
      maxLossRemaining,
      maxLossFloor: st.maxLossFloor,
      dailyFloor: dFloor,
      profitTargetProgress: targetProgress,
      tradingDays: st.tradingDays.length,
      minTradingDays: md ? md.days : null,
      consistency: cons,
      maxMicros: mm,
      checks,
      simulationNote: p.simulationNote,
      next: p.next,
    };
  }
}
