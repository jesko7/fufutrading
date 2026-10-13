/**
 * Binance server clock. Bars open and close on Binance's clock, so every "has this bar closed?"
 * decision must use server time: a local clock running ahead would treat forming klines as closed
 * (and discard the rest of their trades), one running behind delays bar closes.
 * The offset is measured with /api/v3/time, keeping the sample with the shortest round trip and
 * assuming symmetric network latency; it is refreshed every 10 minutes.
 */
import type { BinanceRest } from './rest';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export class ServerClock {
  /** serverTime − localTime in ms. */
  offset = 0;
  rtt = NaN;
  syncedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(
    private rest: BinanceRest,
    private log: Logger,
  ) {}

  now(): number {
    return Date.now() + this.offset;
  }

  async sync(samples = 3): Promise<void> {
    let best: { offset: number; rtt: number } | null = null;
    for (let k = 0; k < samples; k++) {
      const t0 = Date.now();
      const st = await this.rest.serverTime('spot');
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { offset: st - (t0 + t1) / 2, rtt };
    }
    if (!best) return;
    this.offset = Math.round(best.offset);
    this.rtt = best.rtt;
    this.syncedAt = Date.now();
    if (Math.abs(this.offset) > 400 && !this.warned) {
      this.warned = true;
      this.log('warn', `system clock is ${Math.abs(this.offset)} ms ${this.offset < 0 ? 'ahead of' : 'behind'} Binance — using Binance time for bar closes`);
    }
  }

  start(): void {
    if (this.timer) return;
    const run = () => this.sync().catch((e) => this.log('warn', `server time sync failed: ${(e as Error).message}`));
    void run();
    this.timer = setInterval(run, 10 * 60000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
