import type { Order } from '../../../shared/trading/types';
import { SYMBOL_SPECS } from '../../../shared/symbols';

export function describeOrderUi(o: Order): string {
  const base = SYMBOL_SPECS[o.symbol].base;
  if (o.bracket) return `${o.bracket === 'sl' ? 'Stop loss' : 'Take profit'} @ ${o.stopPrice} (${base})`;
  const side = o.side === 'buy' ? 'Buy' : 'Sell';
  const q = `${+o.qty.toFixed(6)} ${base}`;
  switch (o.type) {
    case 'limit':
      return `${side} ${q} limit ${o.price}`;
    case 'stop':
      return `${side} ${q} stop ${o.stopPrice}`;
    case 'stopLimit':
      return `${side} ${q} stop ${o.stopPrice} → ${o.price}${o.triggered ? ' (triggered)' : ''}`;
    case 'takeProfit':
      return `${side} ${q} take-profit ${o.stopPrice}`;
    default:
      return `${side} ${q} market`;
  }
}
