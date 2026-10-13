import { describe, it, expect } from 'vitest';
import { ServerClock } from '../../src/main/binance/clock';
import type { BinanceRest } from '../../src/main/binance/rest';

describe('ServerClock', () => {
  it('measures the offset to Binance from the fastest round trip', async () => {
    // the exchange clock is 850 ms behind; replies take 40–200 ms
    const delays = [200, 40, 120];
    let k = 0;
    const rest = {
      serverTime: async () => {
        const d = delays[k++ % delays.length];
        await new Promise((r) => setTimeout(r, d / 2));
        const st = Date.now() - 850;
        await new Promise((r) => setTimeout(r, d / 2));
        return st;
      },
    } as unknown as BinanceRest;
    const warnings: string[] = [];
    const c = new ServerClock(rest, (lvl, msg) => lvl === 'warn' && warnings.push(msg));
    await c.sync(3);
    expect(c.offset).toBeGreaterThan(-850 - 30);
    expect(c.offset).toBeLessThan(-850 + 30);
    expect(c.rtt).toBeLessThan(120);
    expect(Math.abs(c.now() - (Date.now() - 850))).toBeLessThan(40);
    expect(warnings[0]).toMatch(/ahead of Binance/);
  });
});
