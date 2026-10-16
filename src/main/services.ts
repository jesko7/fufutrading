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
import { registerAlerts, type AlertService } from './alerts';
import { registerAI, type AIService } from './ai/service';
import { registerFootprint } from './market/footprint';
import { registerDataManager } from './dataManager';
import { registerNews } from './news';
import { registerJournal } from './trading/journal';
import { registerDerivatives } from './market/derivatives';
import type { TradeStore } from './storage/tradeStore';

export interface Services {
  trading: TradingEngine;
  scripts: ScriptService;
  backtests: BacktestService;
  optimizer: OptimizerService;
  experiments: ExperimentService;
  bots: BotService;
  replay: ReplayService;
  alerts: AlertService;
  ai: AIService;
  trades: TradeStore;
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
  const derivatives = registerDerivatives(core);
  const alerts = registerAlerts(core, scripts, derivatives);
  const journal = registerJournal(core);
  trading.beforeRemove.add((id) => journal.remove(id));
  const ai = registerAI(core, { scripts, backtests, optimizer, derivatives, trading, journal });
  const trades = registerFootprint(core);
  registerDataManager(core, trades);
  registerNews(core);
  const services: Services = { trading, scripts, backtests, optimizer, experiments, bots, replay, alerts, ai, trades };
  (core as any).services = services;
  return services;
}
