import type { Order } from '../../../shared/trading/types';
import { SYMBOL_SPECS } from '../../../shared/symbols';

export function describeOrderUi(o: Order): string {
  const base = SYMBOL_SPECS[o.symbol].base;
  if (o.bracket) return `${o.bracket === 'sl' ? 'Stop loss' : 'Take profit'} @ ${o.stopPrice} (${base})`;
  const side = o.side === 'buy' ? 'Buy' : 'Sell';
  const q = `${+o.qty.toFixed(6)} ${base}`;
  switch (o.type) {
    case 'limit':
      return `${side} ${q} limit ${o.price}${o.postOnly ? ' post-only' : ''}${o.tif && o.tif !== 'GTC' ? ` ${o.tif}` : ''}`;
    case 'stop':
      return `${side} ${q} stop ${o.stopPrice}`;
    case 'stopLimit':
      return `${side} ${q} stop ${o.stopPrice} → ${o.price}${o.triggered ? ' (triggered)' : ''}`;
    case 'takeProfit':
      return `${side} ${q} take-profit ${o.stopPrice}`;
    case 'trailingStop':
      return `${side} ${q} trailing ${+((o.callbackRate || 0) * 100).toFixed(2)}%${o.trailExtreme === undefined ? (o.activationPrice ? `, activates at ${o.activationPrice}` : '') : `, stop ${o.stopPrice}`}`;
    default:
      return `${side} ${q} market`;
  }
}
