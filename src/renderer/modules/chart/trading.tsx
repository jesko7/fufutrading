import { useEffect, useMemo, useState, useCallback } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { MenuItemSpec } from '../../components/ui';
import type { TradeLine, Execution } from '../../chart/types';
import type { Fill, Order } from '../../../shared/trading/types';
import { useAccounts, useAccount, resolveAccountId } from '../trading/accounts';
import { SYMBOL_SPECS, floorToStep, priceDecimals } from '../../../shared/symbols';
import { fmtNum, fmtSignedUsd } from '../../lib/format';

function err(title: string) {
  return (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });
}

export function useChartTrading(cfg: ChartModuleConfig, replay: { active: boolean; accountId?: string | null }) {
  const accounts = useAccounts();
  const accountId = replay.active ? replay.accountId || null : resolveAccountId(cfg.accountId || null, accounts, cfg.market);
  const [fills, setFills] = useState<Fill[]>([]);
  const refreshFills = useCallback(() => {
    if (!accountId) return;
    void api.call('trading:history', accountId).then((h) => setFills(h.fills || []));
  }, [accountId]);
  const acct = useAccount(accountId, (e) => e.kind === 'fill' && refreshFills());
  useEffect(() => {
    setFills([]);
    refreshFills();
  }, [refreshFills]);
  const matches = !!acct && acct.config.market === cfg.market;
  const css = getComputedStyle(document.documentElement);
  const up = css.getPropertyValue('--up').trim() || '#26a69a';
  const down = css.getPropertyValue('--down').trim() || '#ef5350';
  const accent = css.getPropertyValue('--accent').trim() || '#3b82f6';
  const warn = css.getPropertyValue('--warn').trim() || '#f5a524';
  const pd = priceDecimals(cfg.symbol, cfg.market);

  const lines = useMemo<TradeLine[]>(() => {
    if (!matches || !acct) return [];
    const out: TradeLine[] = [];
    const pos = acct.positions.find((p) => p.symbol === cfg.symbol);
    const base = SYMBOL_SPECS[cfg.symbol].base;
    if (pos) {
      out.push({ id: `pos:${cfg.symbol}`, kind: 'position', price: pos.entry, label: `${pos.side === 1 ? 'LONG' : 'SHORT'} ${+pos.qty.toFixed(5)} ${base}  ${fmtSignedUsd(pos.uPnl)}`, color: pos.uPnl >= 0 ? up : down, draggable: false, cancellable: true, bracket: true, pnl: pos.uPnl });
      if (pos.liqPrice > 0 && acct.config.market === 'futures') out.push({ id: `liq:${cfg.symbol}`, kind: 'liq', price: pos.liqPrice, label: `LIQ ${fmtNum(pos.liqPrice, pd)}`, color: warn, draggable: false, cancellable: false });
    }
    for (const o of acct.orders) {
      if (o.symbol !== cfg.symbol) continue;
      if (o.bracket && pos) {
        const px = o.stopPrice!;
        const pnl = (px - pos.entry) * pos.qty * pos.side;
        out.push({ id: `${o.bracket}:${o.id}`, kind: o.bracket, price: px, label: `${o.bracket === 'sl' ? 'SL' : 'TP'}  ${fmtSignedUsd(pnl)}`, color: o.bracket === 'sl' ? down : up, draggable: true, cancellable: true });
        continue;
      }
      if (o.type === 'trailingStop') {
        // the trailing stop moves with the price; before activation the line shows the activation price
        const px = o.trailExtreme === undefined ? o.activationPrice : o.stopPrice;
        if (!px) continue;
        out.push({ id: `ord:${o.id}`, kind: 'stop', price: px, label: `${o.side === 'buy' ? 'BUY' : 'SELL'} TRAIL ${+((o.callbackRate || 0) * 100).toFixed(2)}%${o.trailExtreme === undefined ? ' (activation)' : ''} ${+(o.qty - o.filledQty).toFixed(5)}`, color: o.side === 'buy' ? accent : down, draggable: false, cancellable: true, side: o.side });
        continue;
      }
      const px = o.type === 'limit' || (o.type === 'stopLimit' && o.triggered) ? o.price! : o.stopPrice!;
      const t = o.type === 'limit' ? 'LMT' : o.type === 'stop' ? 'STOP' : o.type === 'takeProfit' ? 'TP' : o.triggered ? 'LMT' : 'STP-LMT';
      out.push({ id: `ord:${o.id}`, kind: o.type === 'limit' ? 'limit' : 'stop', price: px, label: `${o.side === 'buy' ? 'BUY' : 'SELL'} ${t} ${+(o.qty - o.filledQty).toFixed(5)}`, color: o.side === 'buy' ? accent : down, draggable: true, cancellable: true, side: o.side });
    }
    return out;
  }, [acct, matches, cfg.symbol, up, down, accent, warn, pd]);

  const executions = useMemo<Execution[]>(() => (matches ? fills.filter((f) => f.symbol === cfg.symbol).map((f) => ({ t: f.t, price: f.price, side: f.side, qty: f.qty })) : []), [fills, matches, cfg.symbol]);

  const orderById = (id: string): Order | undefined => acct?.orders.find((o) => o.id === id);

  return {
    accountId,
    /** The selected account trades this chart's market. */
    matches,
    accountName: acct?.config.name,
    lines,
    executions,
    onDrag: (id: string, price: number) => {
      if (!accountId) return;
      const [kind, rest] = id.split(':');
      if (kind === 'ord') {
        const o = orderById(rest);
        if (!o) return;
        const patch = o.type === 'limit' || (o.type === 'stopLimit' && o.triggered) ? { price } : { stopPrice: price };
        void api.call('trading:modify', accountId, rest, patch).catch(err('Order not modified'));
      } else if (kind === 'sl' || kind === 'tp') void api.call('trading:setBrackets', accountId, cfg.symbol, { [kind]: price }).catch(err(`${kind.toUpperCase()} not moved`));
    },
    onCancel: (id: string) => {
      if (!accountId) return;
      const [kind, rest] = id.split(':');
      if (kind === 'ord') void api.call('trading:cancel', accountId, rest).catch(err('Cancel failed'));
      else if (kind === 'sl' || kind === 'tp') void api.call('trading:setBrackets', accountId, cfg.symbol, { [kind]: null }).catch(err('Remove failed'));
      else if (kind === 'pos') void api.call('trading:close', accountId, cfg.symbol).catch(err('Close failed'));
    },
    onBracket: (_posId: string, kind: 'sl' | 'tp', price: number) => {
      if (!accountId) return;
      void api.call('trading:setBrackets', accountId, cfg.symbol, { [kind]: price }).catch(err(`${kind === 'sl' ? 'Stop loss' : 'Take profit'} not set`));
    },
    /** Orders at `price`: limit below/stop above the market `lastPrice` for buys, the reverse for sells. */
    contextItems: (price: number, lastPrice?: number): MenuItemSpec[] => {
      if (!acct || !matches || !accountId) return [];
      const last = lastPrice && lastPrice > 0 ? lastPrice : acct.positions.find((p) => p.symbol === cfg.symbol)?.mark || price;
      const usd = useApp.getState().settings.trading.quickQtyUsd;
      const spec = SYMBOL_SPECS[cfg.symbol][cfg.market];
      const qty = floorToStep(usd / price, spec.stepSize);
      const p = fmtNum(price, pd);
      const place = (side: 'buy' | 'sell', type: 'limit' | 'stop') => api.call('trading:place', accountId, { symbol: cfg.symbol, side, type, qty, ...(type === 'limit' ? { price } : { stopPrice: price }) }).catch(err('Order not accepted'));
      const items: MenuItemSpec[] = [{ title: `Trade · ${acct.config.name}` }];
      if (price < last) items.push({ label: `Buy limit ${qty} @ ${p}`, icon: 'arrowUp', onClick: () => void place('buy', 'limit') }, { label: `Sell stop ${qty} @ ${p}`, icon: 'arrowDown', onClick: () => void place('sell', 'stop') });
      else items.push({ label: `Sell limit ${qty} @ ${p}`, icon: 'arrowDown', onClick: () => void place('sell', 'limit') }, { label: `Buy stop ${qty} @ ${p}`, icon: 'arrowUp', onClick: () => void place('buy', 'stop') });
      const pos = acct.positions.find((x) => x.symbol === cfg.symbol);
      if (pos) {
        const slOk = pos.side === 1 ? price < last : price > last;
        items.push({ label: `${slOk ? 'Stop loss' : 'Take profit'} at ${p}`, icon: 'target', onClick: () => void api.call('trading:setBrackets', accountId, cfg.symbol, { [slOk ? 'sl' : 'tp']: price }).catch(err('Not set')) });
        items.push({ label: 'Close position at market', icon: 'x', onClick: () => void api.call('trading:close', accountId, cfg.symbol).catch(err('Close failed')) });
      }
      items.push({ sep: true });
      return items;
    },
  };
}
