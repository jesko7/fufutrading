/**
 * Feature services registered after the core (market data, windows) is up.
 */
import type { AppCore } from './core';
import { registerTrading, type TradingEngine } from './trading/engine';
import { registerScripts, type ScriptService } from './scripts/service';
import { registerBacktests, type BacktestService } from './backtest/service';
import { registerOptimizer, type OptimizerService } from './backtest/optimizer';
import { registerExperiments, type ExperimentService } from './backtest/experiments';

export interface Services {
  trading: TradingEngine;
  scripts: ScriptService;
  backtests: BacktestService;
  optimizer: OptimizerService;
  experiments: ExperimentService;
}

export async function registerServices(core: AppCore): Promise<Services> {
  const trading = registerTrading(core);
  await trading.start();
  const scripts = registerScripts(core);
  const backtests = registerBacktests(core, scripts);
  const optimizer = registerOptimizer(core, scripts, backtests);
  const experiments = registerExperiments(core);
  const services: Services = { trading, scripts, backtests, optimizer, experiments };
  (core as any).services = services;
  return services;
}
