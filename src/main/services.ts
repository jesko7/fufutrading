/**
 * Registers the higher-level services (trading, scripting, backtesting, bots, alerts, replay,
 * AI, news). Kept separate from AppCore so each service can be developed and tested in
 * isolation; each `register*` function wires one service into the router.
 */
import type { AppCore } from './core';

export async function registerServices(core: AppCore): Promise<void> {
  void core;
}
