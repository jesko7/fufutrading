import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertService } from '../../src/main/alerts';
import { LocalBook } from '../../src/main/market/orderbook';
import { newAlert, describeAlert, type Alert, type AlertEvent } from '../../src/shared/alerts';
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
