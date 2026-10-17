import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertService } from '../../src/main/alerts';
import { LocalBook } from '../../src/main/market/orderbook';
import { newAlert, describeAlert, priceLevelAt, type Alert, type AlertEvent, type PriceAlert } from '../../src/shared/alerts';
import type { TapeListener } from '../../src/main/market/tape';

let dir = '';
let tapeListeners: TapeListener[] = [];
let fired: AlertEvent[] = [];
let notified: string[] = [];
let book: LocalBook;
let tradeId = 1;

function fakeCore() {
  book = new LocalBook();
  return {
    paths: { userData: dir },
    router: {
      broadcast: (ev: string, d: any) => ev === 'alert:fired' && fired.push(d.event),
      handle: () => {},
      topic: () => {},
    },
    hub: {
      acquireTape: () => ({
        tape: { lastPrice: NaN, addListener: (l: TapeListener) => (tapeListeners.push(l), () => (tapeListeners = tapeListeners.filter((x) => x !== l))) },
        release: () => {},
      }),
      acquireBook: () => ({ book: { status: 'live', book }, release: () => {} }),
      lastPrice: () => 100,
    },
    notify: (t: string) => notified.push(t),
    log: () => {},
    onShutdown: () => {},
  };
}

function trade(p: number, t = Date.now()) {
  for (const l of tapeListeners) l.onTrade?.({ id: tradeId++, t, p, q: 1, m: false });
}

function mk(kind: Alert['kind'], patch: Partial<Alert>): Alert {
  return { ...newAlert(kind, 'BTCUSDT', 'spot'), ...patch } as Alert;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-alerts-'));
  tapeListeners = [];
  fired = [];
  notified = [];
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('alert engine', () => {
  it('fires price crossings once and switches the alert off', () => {
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    const a = svc.save(mk('price', { condition: 'crossesAbove', level: 105, frequency: 'once' }));
    expect(describeAlert(a)).toBe('BTC/USDT crosses above 105');
    trade(100);
    trade(104.9);
    expect(fired).toHaveLength(0);
    trade(105.2);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toMatch(/crosses above 105 — now 105\.2/);
    expect(notified).toHaveLength(1);
    const after = svc.get(a.id)!;
    expect(after.enabled).toBe(false);
    expect(after.status).toBe('triggered');
    trade(104);
    trade(106);
    expect(fired).toHaveLength(1);
    svc.shutdown();
  });

  it('honours cooldowns, channels and custom messages', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ['Date'] });
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    svc.save(mk('price', { condition: 'enterChannel', level: 100, level2: 110, frequency: 'every', cooldownSec: 60, message: '{{symbol}} in range at {{price}}' }));
    trade(95);
    trade(101);
    expect(fired.map((e) => e.message)).toEqual(['BTC/USDT in range at 101']);
    trade(115);
    trade(102);
    expect(fired).toHaveLength(1); // cooldown
    vi.setSystemTime(Date.now() + 61000);
    trade(120);
    trade(108);
    expect(fired).toHaveLength(2);
    svc.shutdown();
  });

  it('detects fast moves within the window', () => {
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    svc.save(mk('move', { direction: 'down', pct: 2, minutes: 5, frequency: 'every', cooldownSec: 0 }));
    const t0 = Date.now();
    trade(100, t0);
    trade(99.5, t0 + 60000);
    trade(98.4, t0 + 120000);
    expect(fired).toHaveLength(0);
    trade(97.9, t0 + 180000);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toMatch(/fell 2\.10% within 5 min/);
    // the window restarts after a trigger: a further small dip does not fire again
    trade(97.5, t0 + 190000);
    expect(fired).toHaveLength(1);
    svc.shutdown();
  });

  it('evaluates order-book imbalance with a sustain time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    svc.save(mk('book', { metric: 'imbalance', condition: 'above', value: 50, rangePct: 1, sustainSec: 2, frequency: 'every', cooldownSec: 0 }));
    // balanced book
    book.setSnapshot([['99.9', '10']], [['100.1', '10']], 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fired).toHaveLength(0);
    // bids dominate: (30 - 10) / 40 = +50%... just at the threshold; make it +80%
    book.setSnapshot([['99.9', '90']], [['100.1', '10']], 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toHaveLength(0); // not sustained yet
    await vi.advanceTimersByTimeAsync(2500);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toMatch(/imbalance.*now 80\.0%/);
    svc.shutdown();
  });

  it('follows a trendline: the level moves with time, linear or in log space', () => {
    const H = 3_600_000;
    const now = Date.now();
    // a rising line: 100 one hour ago, 110 one hour from now → 105 now
    const line = { t1: now - H, p1: 100, t2: now + H, p2: 110, extend: 'right' as const };
    expect(priceLevelAt({ level: 0, line }, now)).toBeCloseTo(105, 9);
    expect(priceLevelAt({ level: 0, line }, now + 3 * H)).toBeCloseTo(120, 9);
    // on a log chart the line is straight in log space: the geometric mean in the middle
    expect(priceLevelAt({ level: 0, line: { ...line, log: true } }, now)).toBeCloseTo(Math.sqrt(100 * 110), 9);
    // a segment ends at its later point
    expect(priceLevelAt({ level: 0, line: { ...line, extend: 'none' } }, now + 2 * H)).toBeNull();
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    const a = svc.save(mk('price', { condition: 'crossesAbove', level: 0, line, frequency: 'once' }));
    expect(describeAlert(a)).toBe('BTC/USDT crosses above the trendline 100 → 110 (extended)');
    expect((a as PriceAlert).level).toBeCloseTo(105, 1);
    // 104 is below the line now, 106 above it; an hour later the line is at 110, so 106 is below
    trade(104, now);
    trade(106, now + 1000);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toMatch(/trendline 100 → 110 \(extended\) at 105(\.\d+)? — now 106/);
    const b = svc.save(mk('price', { condition: 'crossesAbove', level: 0, line, frequency: 'once' }));
    trade(106, now + H);
    trade(109.5, now + H + 1000);
    expect(fired).toHaveLength(1);
    trade(110.5, now + H + 2000);
    expect(fired).toHaveLength(2);
    expect(fired[1].alertId).toBe(b.id);
    // a segment that already ended can't be watched; channels don't apply to lines
    expect(() => svc.save(mk('price', { line: { t1: now - 2 * H, p1: 100, t2: now - H, p2: 101, extend: 'none' } }))).toThrow(/ends in the past/);
    expect(() => svc.save(mk('price', { condition: 'enterChannel', line }))).toThrow(/crosses or is above\/below/);
    svc.shutdown();
  });

  it('rejects incomplete alerts with clear messages', () => {
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    expect(() => svc.save(mk('price', { level: 0 }))).toThrow(/enter a price level/);
    expect(() => svc.save(mk('price', { condition: 'enterChannel', level: 100, level2: 90 }))).toThrow(/upper level/);
    expect(() => svc.save(mk('indicator', { scriptId: 'nope' }))).toThrow(/choose a script/);
    svc.shutdown();
  });
});

describe('alert webhooks', () => {
  it('validates URLs and sends JSON or text bodies', async () => {
    const { webhookUrlError, webhookBody } = await import('../../src/shared/alerts');
    const { sendWebhook } = await import('../../src/main/alerts');
    expect(webhookUrlError('https://example.com/hook')).toBeNull();
    expect(webhookUrlError('ftp://example.com')).toMatch(/http/);
    expect(webhookUrlError('not a url')).toMatch(/valid/);
    expect(webhookBody('{"side":"buy"}').contentType).toBe('application/json');
    expect(webhookBody('BTC crossed 50k').contentType).toMatch(/text\/plain/);
    const http = await import('node:http');
    const got: { type?: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        got.push({ type: req.headers['content-type'], body });
        if (req.url === '/slow') return; // never answers
        res.statusCode = req.url === '/fail' ? 500 : 200;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await sendWebhook(`http://127.0.0.1:${port}/hook`, '{"symbol":"BTCUSDT","price":50000}');
      expect(ok.ok).toBe(true);
      expect(got[0]).toEqual({ type: 'application/json', body: '{"symbol":"BTCUSDT","price":50000}' });
      const fail = await sendWebhook(`http://127.0.0.1:${port}/fail`, 'text');
      expect(fail).toMatchObject({ ok: false, status: 500 });
      expect(got[1].type).toMatch(/text\/plain/);
      const slow = await sendWebhook(`http://127.0.0.1:${port}/slow`, 'x', 300);
      expect(slow.ok).toBe(false);
      expect(slow.error).toMatch(/timed out/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('futures alerts', () => {
  it('describe themselves and find open interest at a past time', async () => {
    const { newAlert, describeAlert } = await import('../../src/shared/alerts');
    const { oiValueAt } = await import('../../src/shared/derivatives');
    const liq = newAlert('futures', 'BTCUSDT', 'spot');
    expect(liq.market).toBe('futures');
    expect(describeAlert(liq)).toMatch(/BTC perp liquidations reach \$1,000,000 within 5 min/);
    expect(describeAlert({ ...liq, metric: 'oiChange', condition: 'up', value: 3, minutes: 60 } as any)).toMatch(/open interest rises 3% within 60 min/);
    expect(describeAlert({ ...liq, metric: 'funding', condition: 'below', value: -0.01 } as any)).toMatch(/funding is below -0.01%/);
    const snap: any = { oiMinutes: [[1000, 10], [2000, 11]], openInterest: { history: [[0, 5], [600, 7]] } };
    expect(oiValueAt(snap, 1500)).toBe(10);
    expect(oiValueAt(snap, 700)).toBe(7);
    expect(oiValueAt(snap, -1)).toBeNull();
  });
});

describe('options alerts', () => {
  /** A synthetic option chain around `S` with a 50% smile, puts richer below the money. */
  async function snapshot(S: number, now = Date.UTC(2026, 9, 1)) {
    const { blackScholes } = await import('../../src/shared/options');
    const rows: any[] = [];
    for (const days of [7, 30, 60]) {
      const expiry = now + days * 86400000;
      for (let K = 70; K <= 130; K += 5) {
        const k = Math.log(K / 100);
        const vol = 0.5 - 0.2 * k + 0.3 * k * k;
        for (const side of ['C', 'P'] as const) {
          const g = blackScholes(side, S, K, days / 365, vol, 0.05);
          rows.push({ symbol: `BTC-${days}-${K}-${side}`, expiry, strike: K, side, mark: g.price, bid: NaN, ask: NaN, bidIV: NaN, askIV: NaN, markIV: vol, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, oi: side === 'P' ? (K < 100 ? 40 : 5) : K > 100 ? 30 : 5, volume: 0, last: NaN, changePct: NaN });
        }
      }
    }
    return { underlying: 'BTCUSDT', base: 'BTC', index: S, rf: 0.05, t: now, expiries: [...new Set(rows.map((r) => r.expiry))], rows };
  }

  it('fires on implied volatility and when the index crosses the gamma flip', async () => {
    const listeners: ((s: any) => void)[] = [];
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    svc.options = { watch: (_sym: string, cb: (s: any) => void) => (listeners.push(cb), () => {}) } as any;
    const iv = svc.save(mk('options', { metric: 'iv30', condition: 'above', value: 45, frequency: 'once' } as any));
    expect(describeAlert(iv)).toBe('BTC options: 30-day implied volatility is above 45%');
    const flip = svc.save(mk('options', { metric: 'level', condition: 'crosses', level: 'flip', frequency: 'every', cooldownSec: 0 } as any));
    expect(describeAlert(flip)).toBe('BTC index crosses the gamma flip');
    expect(listeners).toHaveLength(2);
    // put walls below 100, call walls above: dealer gamma flips a little above 100
    for (const l of listeners) l(await snapshot(96));
    // ATM volatility ≈ 50% > 45%: the volatility alert fires; nothing crossed yet
    expect(fired.map((e) => e.message)).toEqual([expect.stringMatching(/30-day implied volatility \d\d\.\d% is above 45%/)]);
    for (const l of listeners) l(await snapshot(99));
    expect(fired).toHaveLength(1);
    for (const l of listeners) l(await snapshot(112));
    expect(fired).toHaveLength(2);
    expect(fired[1].message).toMatch(/BTC index 112 crossed the gamma flip \(\d+\) upwards/);
    svc.shutdown();
  });

  it('rejects incomplete options alerts', () => {
    const svc = new AlertService(fakeCore() as any, { library: { get: () => undefined } } as any);
    expect(() => svc.save(mk('options', { metric: 'level', level: 'nowhere' } as any))).toThrow(/choose a level/);
    expect(() => svc.save(mk('options', { metric: 'iv30', value: -3 } as any))).toThrow(/positive/);
    const skew = svc.save(mk('options', { metric: 'skew', condition: 'below', value: -5 } as any));
    expect(describeAlert(skew)).toBe('BTC options: 25Δ skew (30 days) is below -5 pts');
    svc.shutdown();
  });
});
