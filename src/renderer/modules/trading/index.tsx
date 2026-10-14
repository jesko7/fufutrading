import { registerModule } from '../registry';
import { AccountModule } from './AccountModule';
import { OrderEntryModule } from './OrderEntryModule';
import { PropModule } from './PropModule';
import { bus } from '../../lib/bus';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { confirmDialog } from '../../components/ui';
import { SYMBOL_SPECS, floorToStep, isSymbol, type Market, type SymbolId } from '../../../shared/symbols';
import type { AccountSnapshot } from '../../../shared/trading/types';
import { resolveAccountId } from './accounts';

registerModule('account', AccountModule);
registerModule('orderEntry', OrderEntryModule);
registerModule('propRules', PropModule);

/** Quick-trade shortcuts act on the focused chart's instrument and the resolved paper account. */
bus.on('trade:quick', async (d: { side: 'buy' | 'sell' | 'flatten' | 'cancel'; chart?: string }) => {
  const st = useApp.getState();
  const chart = d.chart ? st.workspace?.modules[d.chart] : null;
  const symbol: SymbolId = chart && isSymbol(chart.config.symbol) ? chart.config.symbol : 'BTCUSDT';
  const market: Market = chart?.config.market === 'futures' ? 'futures' : 'spot';
  try {
    const accounts = await api.call<AccountSnapshot[]>('trading:list');
    const id = resolveAccountId(chart?.config.accountId, accounts, market);
    const acct = accounts.find((a) => a.config.id === id);
    if (!acct) {
      toast({ title: 'No paper account', body: 'Create an account first (Account module or trade panel).', kind: 'warn' });
      return;
    }
    if (acct.config.market !== market) {
      toast({ title: 'Account/market mismatch', body: `${acct.config.name} trades ${acct.config.market}; the focused chart shows ${market}.`, kind: 'warn' });
      return;
    }
    const base = SYMBOL_SPECS[symbol].base;
    if (d.side === 'flatten') {
      await api.call('trading:close', acct.config.id, symbol);
      toast({ title: `Closed ${base} position`, body: acct.config.name, kind: 'ok' });
      return;
    }
    if (d.side === 'cancel') {
      const n = await api.call<number>('trading:cancelAll', acct.config.id, symbol);
      toast({ title: `Canceled ${n} ${base} order${n === 1 ? '' : 's'}`, body: acct.config.name, kind: 'ok' });
      return;
    }
    const last = await api.call<number>('market:lastPrice', symbol, market);
    const qty = floorToStep(st.settings.trading.quickQtyUsd / last, SYMBOL_SPECS[symbol][market].stepSize);
    if (st.settings.trading.confirmMarketOrders) {
      const ok = await confirmDialog({ title: `${d.side === 'buy' ? 'Buy' : 'Sell'} ${qty} ${base} at market?`, body: `Account: ${acct.config.name}`, confirm: d.side === 'buy' ? 'Buy' : 'Sell', danger: d.side === 'sell' });
      if (!ok) return;
    }
    const o = await api.call('trading:place', acct.config.id, { symbol, side: d.side, type: 'market', qty, source: 'manual', reason: 'quick trade' });
    toast({ title: `${d.side === 'buy' ? 'Bought' : 'Sold'} ${o.filledQty} ${base}`, body: `${acct.config.name} @ ${o.avgFillPrice?.toFixed(2)}`, kind: 'ok' });
  } catch (e) {
    toast({ title: 'Quick trade failed', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });
  }
});

// toasts pushed from the main process (fills of bots, liquidations, prop rule events)
api.on<{ title: string; body?: string; kind?: 'info' | 'ok' | 'warn' | 'error' }>('toast', (t) => toast(t));
