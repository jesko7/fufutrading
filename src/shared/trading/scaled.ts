/**
 * Binance's scaled order: several limit orders spread evenly from a start price to an end price,
 * with the total quantity split equally, or growing or shrinking from the first order to the last.
 */
import { decimalsOf, roundToTick } from '../symbols';

export type ScaledDistribution = 'flat' | 'increasing' | 'decreasing';

/** Binance allows 2 to 100 orders in one scaled order. */
export const SCALED_MIN_ORDERS = 2;
export const SCALED_MAX_ORDERS = 100;

export interface ScaledSpec {
  from: number;
  to: number;
  /** Total quantity (base asset). */
  qty: number;
  count: number;
  distribution: ScaledDistribution;
  tickSize: number;
  stepSize: number;
}

/** The orders from the start price to the end price; quantities are whole lot steps that add up to the total (rounded down to the step). */
export function scaledOrders(s: ScaledSpec): { price: number; qty: number }[] {
  const n = Math.max(SCALED_MIN_ORDERS, Math.min(SCALED_MAX_ORDERS, Math.round(s.count)));
  if (!(s.from > 0) || !(s.to > 0) || !(s.qty > 0) || !(s.stepSize > 0)) return [];
  const w = Array.from({ length: n }, (_, k) => (s.distribution === 'increasing' ? k + 1 : s.distribution === 'decreasing' ? n - k : 1));
  const W = w.reduce((a, b) => a + b, 0);
  // work in whole lot steps so the parts add up exactly
  const total = Math.floor(s.qty / s.stepSize + 1e-9);
  const steps = w.map((x) => Math.floor((total * x) / W));
  // the steps lost to rounding go to the largest orders first (the first ones among equals)
  const byWeight = w.map((_, k) => k).sort((a, b) => w[b] - w[a] || a - b);
  for (let rest = total - steps.reduce((a, b) => a + b, 0), j = 0; rest > 0; rest--, j = (j + 1) % n) steps[byWeight[j]]++;
  const qd = decimalsOf(s.stepSize);
  return steps.map((k, i) => ({
    price: roundToTick(s.from + ((s.to - s.from) * i) / (n - 1), s.tickSize),
    qty: +(k * s.stepSize).toFixed(qd),
  }));
}
