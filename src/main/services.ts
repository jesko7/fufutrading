/**
 * Feature services registered after the core (market data, windows) is up.
 */
import type { AppCore } from './core';
import { registerTrading, type TradingEngine } from './trading/engine';
import { registerScripts, type ScriptService } from './scripts/service';
import { registerBacktests, type BacktestService } from './backtest/service';
import { registerOptimizer, type OptimizerService } from './backtest/optimizer';
import { registerExperiments, type ExperimentService } from './backtest/experiments';
import { registerBots, type BotService } from './trading/bots';
import { registerReplay, type ReplayService } from './market/replay';

export interface Services {
  trading: TradingEngine;
  scripts: ScriptService;
  backtests: BacktestService;
  optimizer: OptimizerService;
  experiments: ExperimentService;
  bots: BotService;
  replay: ReplayService;
}

export async function registerServices(core: AppCore): Promise<Services> {
  const trading = registerTrading(core);
  await trading.start();
  const scripts = registerScripts(core);
  const backtests = registerBacktests(core, scripts);
  const optimizer = registerOptimizer(core, scripts, backtests);
  const experiments = registerExperiments(core);
  const bots = registerBots(core, trading, scripts);
  const replay = registerReplay(core, trading);
  const services: Services = { trading, scripts, backtests, optimizer, experiments, bots, replay };
  (core as any).services = services;
  return services;
}
