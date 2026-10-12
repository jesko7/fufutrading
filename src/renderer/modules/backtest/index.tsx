import { registerModule } from '../registry';
import { StrategyTesterModule } from './StrategyTesterModule';

registerModule('backtest', StrategyTesterModule);
