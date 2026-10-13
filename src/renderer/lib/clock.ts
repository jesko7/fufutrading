/**
 * Binance server time in the renderer: local time plus the offset the main process measured.
 * Bar countdowns and live time axes use it so they match exchange timestamps even when the
 * computer's clock is off.
 */
import { api } from '../api';

let offset = 0;
let started = false;

export function serverNow(): number {
  return Date.now() + offset;
}

export function startClockSync(): void {
  if (started) return;
  started = true;
  const sync = () =>
    api
      .call<{ offset: number }>('market:clock')
      .then((c) => {
        if (Number.isFinite(c?.offset)) offset = c.offset;
      })
      .catch(() => {});
  void sync();
  setTimeout(sync, 5000);
  setInterval(sync, 60000);
}
