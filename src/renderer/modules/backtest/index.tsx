import { registerModule } from '../registry';
import { StrategyTesterModule } from './StrategyTesterModule';
import { OptimizerModule } from './OptimizerModule';
import { ExperimentsModule } from './ExperimentsModule';

registerModule('backtest', StrategyTesterModule);
registerModule('optimizer', OptimizerModule);
registerModule('experiments', ExperimentsModule);
