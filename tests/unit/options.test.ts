import { describe, it, expect } from 'vitest';
import {
  normCdf,
  blackScholes,
  impliedVol,
  parseOptionSymbol,
  expiryCode,
  maxPain,
  atmVol,
  skew25,
  exposureByStrike,
  gammaFlip,
  constantMaturityVol,
  positionPnl,
  positionGreeks,
  breakEvens,
  yearsTo,
  optionLevels,
  type OptionRow,
  type OptionLeg,
} from '../../src/shared/options';

const DAY = 86400000;

function row(p: Partial<OptionRow> & { strike: number; side: 'C' | 'P' }): OptionRow {
  return { symbol: `X-${p.strike}-${p.side}`, expiry: 0, mark: NaN, bid: NaN, ask: NaN, bidIV: NaN, askIV: NaN, markIV: NaN, delta: NaN, gamma: NaN, theta: NaN, vega: NaN, oi: 0, volume: 0, last: NaN, changePct: NaN, ...p };
}

/** A synthetic chain priced with Black-Scholes on a smile (puts richer than calls). */
function chain(S: number, now: number, expiry: number, r = 0.05): OptionRow[] {
  const out: OptionRow[] = [];
  const T = yearsTo(expiry, now);
  for (let K = S * 0.6; K <= S * 1.4 + 1e-9; K += S * 0.05) {
    const k = Math.log(K / S);
    const vol = 0.5 - 0.25 * k + 0.4 * k * k;
    for (const side of ['C', 'P'] as const) {
      const g = blackScholes(side, S, K, T, vol, r);
      out.push(row({ strike: Math.round(K), side, expiry, mark: g.price, markIV: vol, bidIV: vol - 0.01, askIV: vol + 0.01, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, oi: side === 'P' ? (K < S ? 30 : 5) : K > S ? 25 : 4 }));
    }
  }
  return out;
}

describe('normal distribution', () => {
  it('matches reference values to double precision', () => {
    expect(normCdf(0)).toBe(0.5);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 14);
    expect(normCdf(-8) / 6.22096057427178e-16).toBeCloseTo(1, 7);
    for (const x of [0.3, 1.1, 2.7, 5.5]) expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 15);
  });
});

describe('Black-Scholes', () => {
  it('prices the textbook example and satisfies put-call parity', () => {
    const c = blackScholes('C', 100, 100, 1, 0.2, 0.05);
    const p = blackScholes('P', 100, 100, 1, 0.2, 0.05);
    expect(c.price).toBeCloseTo(10.450583572185565, 10);
    expect(p.price).toBeCloseTo(5.573526022256971, 10);
    expect(c.delta).toBeCloseTo(0.6368306511756191, 12);
    expect(c.gamma).toBeCloseTo(0.018762017345846895, 12);
    expect(c.vega).toBeCloseTo(0.3752403469169379, 12);
    expect(c.theta * 365).toBeCloseTo(-6.414027546438197, 10);
    expect(c.price - p.price).toBeCloseTo(100 - 100 * Math.exp(-0.05), 12);
  });

  it('has Greeks equal to finite differences of the price', () => {
    const cases: [('C' | 'P'), number, number, number, number, number][] = [
      ['C', 81561, 85000, 0.19, 0.36, 0.053],
      ['P', 81561, 70000, 0.05, 0.55, 0.053],
      ['C', 2430, 2600, 0.6, 0.7, 0.03],
      ['P', 104, 110, 0.02, 0.9, 0.0],
    ];
    for (const [side, S, K, T, v, r] of cases) {
      const g = blackScholes(side, S, K, T, v, r);
      const px = (s = S, t = T, vol = v, rr = r) => blackScholes(side, s, K, t, vol, rr).price;
      const h = S * 1e-4;
      expect(g.delta).toBeCloseTo((px(S + h) - px(S - h)) / (2 * h), 6);
      expect(g.gamma / ((px(S + h) - 2 * px(S) + px(S - h)) / (h * h))).toBeCloseTo(1, 3);
      expect(g.vega / ((px(S, T, v + 1e-5) - px(S, T, v - 1e-5)) / 2e-5 / 100)).toBeCloseTo(1, 5);
      expect(g.theta / (-(px(S, T + 1e-6) - px(S, T - 1e-6)) / 2e-6 / 365)).toBeCloseTo(1, 4);
      expect(g.rho / ((px(S, T, v, r + 1e-6) - px(S, T, v, r - 1e-6)) / 2e-6 / 100)).toBeCloseTo(1, 4);
    }
  });

  it("reproduces Binance's published Greeks for a BTC option", () => {
    // BTC-261225-85000-C: mark IV 0.359, rate 0.053, index 81,561 (Binance: delta 0.4511, gamma 3.091e-5, vega 140.2)
    const T = (1798185600000 - 1792240513104) / (365 * DAY);
    const g = blackScholes('C', 81561.13, 85000, T, 0.359, 0.053);
    expect(g.delta).toBeCloseTo(0.4511, 2);
    expect(g.gamma / 3.091e-5).toBeCloseTo(1, 1);
    expect(g.vega / 140.215).toBeCloseTo(1, 1);
    expect(g.price / 3953.881).toBeCloseTo(1, 1);
  });

  it('values expired options at intrinsic value', () => {
    expect(blackScholes('C', 110, 100, 0, 0.5, 0.05)).toMatchObject({ price: 10, delta: 1, gamma: 0 });
    expect(blackScholes('P', 110, 100, 0, 0.5, 0.05)).toMatchObject({ price: 0, delta: 0 });
  });

  it('recovers the volatility from a price', () => {
    for (const [side, K, v] of [['C', 90, 0.3], ['P', 120, 0.85], ['C', 150, 1.4], ['P', 60, 0.45]] as const) {
      const p = blackScholes(side, 100, K, 0.25, v, 0.04).price;
      expect(impliedVol(side, p, 100, K, 0.25, 0.04)).toBeCloseTo(v, 8);
    }
    expect(impliedVol('C', 0.5, 100, 50, 0.25, 0.04)).toBeNaN(); // below intrinsic
    expect(impliedVol('C', 101, 100, 50, 0.25, 0.04)).toBeNaN(); // above the underlying
  });
});

describe('contracts', () => {
  it('parses Binance option symbols and expiry codes', () => {
    const c = parseOptionSymbol('BTC-261225-85000-C')!;
    expect(c).toEqual({ base: 'BTC', expiry: Date.UTC(2026, 11, 25, 8), strike: 85000, side: 'C' });
    expect(parseOptionSymbol('ETH-261030-2450.5-P')!.strike).toBe(2450.5);
    expect(parseOptionSymbol('BTCUSDT')).toBeNull();
    expect(expiryCode(Date.UTC(2026, 0, 9, 8))).toBe('260109');
  });
});

describe('chain analytics', () => {
  const now = Date.UTC(2026, 9, 1);
  const expiry = now + 30 * DAY;
  const rows = chain(100, now, expiry);

  it('reads the ATM volatility and the skew off the smile', () => {
    // the smile is 0.5 at the money (log-moneyness 0), puts richer than calls
    const F = 100 * Math.exp(0.05 * yearsTo(expiry, now));
    const k = Math.log(F / 100);
    expect(atmVol(rows, 100, 0.05, now)).toBeCloseTo(0.5 - 0.25 * k + 0.4 * k * k, 2);
    const s = skew25(rows, 100, 0.05, now);
    expect(s.rr).toBeLessThan(0);
    expect(s.put).toBeGreaterThan(s.call);
    expect(s.bf).toBeGreaterThan(0);
  });

  it('finds max pain by brute force', () => {
    const toy = [row({ strike: 80, side: 'P', oi: 6 }), row({ strike: 90, side: 'P', oi: 9 }), row({ strike: 100, side: 'P', oi: 4 }), row({ strike: 100, side: 'C', oi: 5 }), row({ strike: 110, side: 'C', oi: 8 }), row({ strike: 120, side: 'C', oi: 3 })];
    const pay = (X: number) => toy.reduce((s, r) => s + r.oi * Math.max(0, r.side === 'C' ? X - r.strike : r.strike - X), 0);
    const best = [80, 90, 100, 110, 120].reduce((a, b) => (pay(b) < pay(a) ? b : a));
    const mp = maxPain(toy);
    expect(mp.strike).toBe(best);
    expect(mp.payout.find(([x]) => x === best)![1]).toBe(pay(best));
  });

  it('measures gamma exposure by strike and finds the flip between put and call walls', () => {
    const ex = exposureByStrike(rows, 100);
    const below = ex.filter((e) => e.strike < 95).reduce((s, e) => s + e.gex, 0);
    const above = ex.filter((e) => e.strike > 105).reduce((s, e) => s + e.gex, 0);
    expect(below).toBeLessThan(0);
    expect(above).toBeGreaterThan(0);
    expect(ex.reduce((s, e) => s + e.callOI + e.putOI, 0)).toBe(rows.reduce((s, r) => s + r.oi, 0));
    const flip = gammaFlip(rows, 100, 0.05, now);
    expect(flip).toBeGreaterThan(85);
    expect(flip).toBeLessThan(115);
  });

  it('interpolates 30-day volatility in total variance', () => {
    const term = [
      { t: 7 / 365, iv: 0.6 },
      { t: 60 / 365, iv: 0.45 },
    ];
    const w = 0.36 * (7 / 365) + ((0.45 * 0.45 * (60 / 365) - 0.36 * (7 / 365)) * (23 / 365)) / (53 / 365);
    expect(constantMaturityVol(term, 30)).toBeCloseTo(Math.sqrt(w / (30 / 365)), 12);
    expect(constantMaturityVol(term, 3)).toBe(0.6);
    expect(constantMaturityVol(term, 90)).toBe(0.45);
  });
});

describe('positions', () => {
  const now = Date.UTC(2026, 9, 1);
  const expiry = now + 14 * DAY;
  const call = (K: number, qty: number, price: number): OptionLeg => ({ id: `c${K}`, kind: 'option', side: 'C', strike: K, expiry, qty, price, iv: 0.5 });

  it('pays off a bull call spread at expiry with break-even at the lower strike plus the debit', () => {
    const legs = [call(100, 1, 6), call(110, -1, 2)];
    const curve: [number, number][] = [];
    for (let x = 80; x <= 130; x += 0.5) curve.push([x, positionPnl(legs, x, expiry, 0.05)]);
    expect(positionPnl(legs, 90, expiry, 0.05)).toBeCloseTo(-4, 12);
    expect(positionPnl(legs, 125, expiry, 0.05)).toBeCloseTo(6, 12);
    expect(breakEvens(curve)).toEqual([104]);
  });

  it('nets the Greeks of the legs; a delta-hedged straddle is long gamma and vega, short theta', () => {
    const S = 100;
    const c = blackScholes('C', S, 100, yearsTo(expiry, now), 0.5, 0.05);
    const p = blackScholes('P', S, 100, yearsTo(expiry, now), 0.5, 0.05);
    const legs: OptionLeg[] = [
      { ...call(100, 1, c.price) },
      { id: 'p', kind: 'option', side: 'P', strike: 100, expiry, qty: 1, price: p.price, iv: 0.5 },
      { id: 'u', kind: 'underlying', qty: -(c.delta + p.delta), price: S },
    ];
    const g = positionGreeks(legs, S, now, 0.05);
    expect(g.delta).toBeCloseTo(0, 12);
    expect(g.gamma).toBeCloseTo(2 * c.gamma, 12);
    expect(g.vega).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(positionPnl(legs, S, now, 0.05)).toBeCloseTo(0, 9);
  });
});

describe('options levels for the chart', () => {
  it('finds the walls, the flip, max pain of the next expiry and the expected move to the weekly', () => {
    const now = Date.UTC(2026, 9, 1);
    const daily = chain(100, now, now + 2 * DAY);
    const weekly = chain(100, now, now + 7 * DAY);
    const far = chain(100, now, now + 200 * DAY).map((r) => ({ ...r, oi: r.strike === 140 && r.side === 'C' ? 10000 : r.oi }));
    // the biggest call strike near term: 110; the biggest put strike: 90
    for (const r of [...daily, ...weekly]) {
      if (r.side === 'C') r.oi = r.strike === 110 ? 500 : 20;
      else r.oi = r.strike === 90 ? 400 : 15;
    }
    const s = { underlying: 'BTCUSDT' as const, base: 'BTC', index: 100, rf: 0.05, t: now, expiries: [now + 2 * DAY, now + 7 * DAY, now + 200 * DAY], rows: [...daily, ...weekly, ...far] };
    const L = optionLevels(s);
    expect(L.callWall).toBe(110); // the far expiry's 140 wall is beyond the horizon
    expect(L.putWall).toBe(90);
    expect(L.flip).toBeGreaterThan(90);
    expect(L.flip).toBeLessThan(110);
    expect(L.maxPain!.expiry).toBe(now + 2 * DAY);
    expect(L.move!.expiry).toBe(now + 7 * DAY);
    const iv = atmVol(weekly, 100, 0.05, now);
    expect(L.move!.hi - 100).toBeCloseTo(100 * iv * Math.sqrt(7 / 365), 9);
    expect(100 - L.move!.lo).toBeCloseTo(L.move!.hi - 100, 9);
  });
});
