/** Formatting shared by the Options views. */
import { fmtNum, MONTHS } from '../../lib/format';

/** Expiry day (options expire at 08:00 UTC): "25 Dec". */
export const fmtExpiry = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** Time to expiry: hours under a day, else days. */
export const fmtDte = (days: number): string => (days < 1 ? `${Math.max(0, Math.round(days * 24))}h` : `${Math.round(days)}d`);

/** A volatility as a percentage. */
export const pctIV = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

/** An option premium in USDT with sensible decimals for BTC, ETH and SOL options. */
export const fmtPremium = (v: number): string => (Number.isFinite(v) ? fmtNum(v, Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 2 : 3) : '—');
