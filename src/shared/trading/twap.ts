/**
 * Binance's TWAP order: a total quantity executed as equal market orders at regular intervals
 * over a duration (5 minutes to 24 hours).
 */
import { decimalsOf, floorToStep } from '../symbols';

export const TWAP_MIN_MS = 5 * 60000;
export const TWAP_MAX_MS = 24 * 3600000;

export interface TwapPlan {
  slices: number;
  intervalMs: number;
  /** Quantity of each order; the last one takes the rest. */
  sliceQty: number;
  lastQty: number;
}

/**
 * How to split `qty` over `durationMs`: an order every 10 s or more (at most 120 orders), fewer
 * when the orders would fall below the instrument's minimum value or quantity.
 */
export function twapPlan(qty: number, durationMs: number, price: number, spec: { stepSize: number; minQty: number; minNotional: number }): TwapPlan | { error: string } {
  if (!(durationMs >= TWAP_MIN_MS - 1 && durationMs <= TWAP_MAX_MS + 1)) return { error: 'The duration must be between 5 minutes and 24 hours' };
  const total = floorToStep(qty, spec.stepSize);
  if (!(total > 0) || !(price > 0)) return { error: 'Enter a size' };
  let slices = Math.max(2, Math.round(durationMs / Math.max(10000, durationMs / 120)));
  // every order must meet the minimum quantity and value
  const byValue = Math.floor((total * price) / Math.max(spec.minNotional, 1e-9));
  const byQty = Math.floor(total / Math.max(spec.minQty, spec.stepSize) + 1e-9);
  slices = Math.min(slices, byValue, byQty);
  if (slices < 2) return { error: `Too small for a TWAP: each of at least 2 orders must be worth ${spec.minNotional} USDT` };
  const sliceQty = floorToStep(total / slices, spec.stepSize);
  const lastQty = +(total - sliceQty * (slices - 1)).toFixed(decimalsOf(spec.stepSize));
  return { slices, intervalMs: durationMs / slices, sliceQty, lastQty };
}
