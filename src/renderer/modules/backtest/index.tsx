import { registerModule } from '../registry';
import { StrategyTesterModule } from './StrategyTesterModule';
import { OptimizerModule } from './OptimizerModule';

registerModule('backtest', StrategyTesterModule);
registerModule('optimizer', OptimizerModule);
