/**
 * Registers the higher-level services (trading, scripting, backtesting, bots, alerts, replay,
 * AI, news). Each `register*` function wires one service into the router and returns its
 * instance, which is kept on `core.services` for cross-service use.
 */
import type { AppCore } from './core';
import { registerTrading, type TradingEngine } from './trading/engine';

export interface Services {
  trading: TradingEngine;
}

export async function registerServices(core: AppCore): Promise<Services> {
  const trading = registerTrading(core);
  await trading.start();
  const services: Services = { trading };
  (core as any).services = services;
  return services;
}
