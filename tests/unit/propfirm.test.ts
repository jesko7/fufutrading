import { describe, it, expect } from 'vitest';
import { PropRules, sessionKey } from '../../src/shared/propfirm/engine';
import { profileById, PROFILES } from '../../src/shared/propfirm/profiles';

const P = (id: string) => profileById(id)!;
// 2026-10-12 is a Monday. Prague is UTC+2 (CEST), New York UTC-4 (EDT) on that date.
const T = (iso: string) => Date.parse(iso);

function make(id: string, size: number, t: number, options: Record<string, unknown> = {}) {
  const prof = P(id);
  return new PropRules(prof, PropRules.init(prof, size, options, t));
}

describe('sessions', () => {
  it('uses the firm time zone and reset time', () => {
    expect(sessionKey(T('2026-10-12T21:30:00Z'), P('ftmo-2step-challenge').session)).toBe('2026-10-12');
    expect(sessionKey(T('2026-10-12T22:30:00Z'), P('ftmo-2step-challenge').session)).toBe('2026-10-13');
    expect(sessionKey(T('2026-10-12T20:30:00Z'), P('lucid-flex-eval').session)).toBe('2026-10-12');
    expect(sessionKey(T('2026-10-12T21:30:00Z'), P('lucid-flex-eval').session)).toBe('2026-10-13');
  });
  it('every profile has sources, a verification date and a simulation note', () => {
    for (const p of PROFILES) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.simulationNote.length).toBeGreaterThan(50);
      expect(p.implemented.length).toBeGreaterThan(0);
    }
  });
});

describe('FTMO', () => {
  it('2-Step: hard daily loss from the balance at midnight CE(S)T', () => {
    const t0 = T('2026-10-12T08:00:00Z');
    const r = make('ftmo-2step-challenge', 100000, t0);
    expect(r.dailyFloor()).toBe(95000);
    let fx = r.update({ t: t0 + 1000, balance: 100000, equity: 95001, openPositions: 1 });
    expect(r.state.status).toBe('active');
    fx = r.update({ t: t0 + 2000, balance: 100000, equity: 94999, openPositions: 1 });
    expect(r.state.status).toBe('breached');
    expect(fx.flatten).toBe(true);
  });

  it('2-Step: daily floor resets from the new day’s starting balance', () => {
    const t0 = T('2026-10-12T08:00:00Z');
    const r = make('ftmo-2step-challenge', 100000, t0);
    r.update({ t: t0, balance: 103000, equity: 103000, openPositions: 0 });
    r.update({ t: T('2026-10-12T22:05:00Z'), balance: 103000, equity: 103000, openPositions: 0 });
    expect(r.state.dayKey).toBe('2026-10-13');
    expect(r.dailyFloor()).toBe(98000);
    // static max loss stays at 90k
    expect(r.state.maxLossFloor).toBe(90000);
  });

  it('2-Step: profit target needs flat positions and 4 trading days', () => {
    const t0 = T('2026-10-12T08:00:00Z');
    const r = make('ftmo-2step-challenge', 100000, t0);
    r.update({ t: t0, balance: 110500, equity: 110500, openPositions: 1 });
    expect(r.state.status).toBe('active');
    r.update({ t: t0 + 1, balance: 110500, equity: 110500, openPositions: 0 });
    expect(r.state.status).toBe('active'); // only 0 trading days
    for (const d of ['2026-10-12T09:00:00Z', '2026-10-13T09:00:00Z', '2026-10-14T09:00:00Z', '2026-10-15T09:00:00Z']) r.onPositionOpened(T(d));
    r.update({ t: T('2026-10-15T10:00:00Z'), balance: 110500, equity: 110500, openPositions: 0 });
    expect(r.state.status).toBe('passed');
  });

  it('1-Step: max loss trails the end-of-day balance and never decreases', () => {
    const t0 = T('2026-10-12T08:00:00Z');
    const r = make('ftmo-1step-challenge', 100000, t0);
    expect(r.state.maxLossFloor).toBe(90000);
    r.update({ t: t0, balance: 105000, equity: 105000, openPositions: 0 });
    r.update({ t: T('2026-10-12T22:10:00Z'), balance: 105000, equity: 105000, openPositions: 0 });
    expect(r.state.maxLossFloor).toBe(95000);
    // a 2.5k drop stays inside the 3% daily limit (a 5k drop would breach it)
    r.update({ t: T('2026-10-13T12:00:00Z'), balance: 102500, equity: 102500, openPositions: 0 });
    r.update({ t: T('2026-10-13T22:10:00Z'), balance: 102500, equity: 102500, openPositions: 0 });
    expect(r.state.status).toBe('active');
    expect(r.state.maxLossFloor).toBe(95000);
    expect(r.dailyFloor()).toBe(99500);
  });

  it('1-Step: consistency blocks passing until best day ≤ 50% of total profit', () => {
    const t0 = T('2026-10-12T08:00:00Z');
    const r = make('ftmo-1step-challenge', 100000, t0);
    r.onRealized(T('2026-10-12T09:00:00Z'), 8000);
    r.onRealized(T('2026-10-13T09:00:00Z'), 2500);
    r.update({ t: T('2026-10-13T10:00:00Z'), balance: 110500, equity: 110500, openPositions: 0 });
    expect(r.consistency()!.ok).toBe(false);
    expect(r.state.status).toBe('active');
    r.onRealized(T('2026-10-14T09:00:00Z'), 6000);
    r.update({ t: T('2026-10-14T10:00:00Z'), balance: 116500, equity: 116500, openPositions: 0 });
    expect(r.consistency()!.ok).toBe(true);
    expect(r.state.status).toBe('passed');
  });
});

describe('Lucid', () => {
  it('Flex: EOD trailing MLL locks at initial + $100 after exceeding the trail balance', () => {
    const t0 = T('2026-10-12T14:00:00Z');
    const r = make('lucid-flex-eval', 50000, t0);
    expect(r.state.maxLossFloor).toBe(48000);
    r.update({ t: t0, balance: 51000, equity: 51000, openPositions: 0 });
    r.update({ t: T('2026-10-12T21:05:00Z'), balance: 51000, equity: 51000, openPositions: 0 });
    expect(r.state.maxLossFloor).toBe(49000);
    r.update({ t: T('2026-10-13T15:00:00Z'), balance: 52200, equity: 52200, openPositions: 0 });
    r.update({ t: T('2026-10-13T21:05:00Z'), balance: 52200, equity: 52200, openPositions: 0 });
    expect(r.state.locked).toBe(true);
    expect(r.state.maxLossFloor).toBe(50100);
  });

  it('Pro eval: soft daily loss restricts until the next session; 25K has no DLL', () => {
    const t0 = T('2026-10-12T14:00:00Z');
    const r = make('lucid-pro-eval', 50000, t0);
    const fx = r.update({ t: t0 + 1000, balance: 50000, equity: 48790, openPositions: 1 });
    expect(r.state.status).toBe('restricted');
    expect(fx.flatten).toBe(true);
    expect(r.canTrade(t0 + 2000).ok).toBe(false);
    r.update({ t: T('2026-10-12T21:05:00Z'), balance: 48790, equity: 48790, openPositions: 0 });
    expect(r.state.status).toBe('active');
    expect(make('lucid-pro-eval', 25000, t0).dailyLimit()).toBeNull();
  });

  it('enforces trading hours (flat by 16:45 ET, reopen 18:00 ET, weekend closed)', () => {
    const r = make('lucid-flex-eval', 50000, T('2026-10-12T14:00:00Z'));
    expect(r.canTrade(T('2026-10-12T16:00:00Z')).ok).toBe(true); // Mon 12:00 ET
    expect(r.canTrade(T('2026-10-12T20:50:00Z')).ok).toBe(false); // Mon 16:50 ET
    expect(r.canTrade(T('2026-10-12T22:05:00Z')).ok).toBe(true); // Mon 18:05 ET
    expect(r.canTrade(T('2026-10-17T15:00:00Z')).ok).toBe(false); // Saturday
    expect(r.canTrade(T('2026-10-18T21:00:00Z')).ok).toBe(false); // Sun 17:00 ET
    expect(r.canTrade(T('2026-10-18T22:30:00Z')).ok).toBe(true); // Sun 18:30 ET
  });

  it('maps contract limits to crypto quantities and applies the scaling plan', () => {
    const r = make('lucid-flex-funded', 50000, T('2026-10-12T14:00:00Z'));
    expect(r.maxMicros()).toBe(20);
    expect(r.maxQty('BTCUSDT')).toBeCloseTo(2, 9);
    r.state.highestEodBalance = 52500;
    expect(r.maxMicros()).toBe(40);
  });

  it('Pro funded: LucidScale DLL after closing above the trail balance', () => {
    const r = make('lucid-pro-funded', 50000, T('2026-10-12T14:00:00Z'), { dll: true });
    expect(r.dailyLimit()).toBe(1200);
    r.state.highestEodBalance = 54000;
    expect(r.dailyLimit()).toBeCloseTo(2400, 9);
  });
});
