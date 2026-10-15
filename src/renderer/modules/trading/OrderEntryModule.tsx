import { useEffect, useMemo, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { useTicker } from '../../lib/hooks';
import { bus } from '../../lib/bus';
import { SymbolPicker, Segmented, NumberField, Toggle, Tabs, confirmDialog } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { AccountSelect, useAccounts, useAccount, resolveAccountId, statusBadge, openCreateAccount } from './accounts';
import { SYMBOL_SPECS, floorToStep, priceDecimals, qtyDecimals, roundToTick, type Market, type SymbolId } from '../../../shared/symbols';
import { liquidationPrice, maxLeverageFor } from '../../../shared/trading/brackets';
import type { OrderType, PlaceOrderRequest, TimeInForce } from '../../../shared/trading/types';
import { clsx, fmtNum, fmtUsd } from '../../lib/format';
import { useReplayView } from '../chart/replay';
import './trading.css';

type SizeUnit = 'base' | 'quote' | 'pct';

export function OrderEntryModule({ module }: ModuleProps) {
  const cfg = module.config as { accountId: string | null; symbol: SymbolId; market: Market };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const accounts = useAccounts();
  // during a replay this panel trades the window's replay account at replay prices
  const replay = useReplayView();
  const replayId = replay ? replay.accounts[cfg.market] || null : null;
  useEffect(() => {
    if (replay && !replayId) void api.call('replay:account', cfg.market).catch(() => {});
  }, [replay?.id, replayId, cfg.market]);
  const accountId = replay ? replayId : resolveAccountId(cfg.accountId, accounts);
  const acct = useAccount(accountId);
  const market: Market = replay ? cfg.market : acct?.config.market || cfg.market;
  const symbol = cfg.symbol;
  const ticker = useTicker(symbol, market);
  const last = replay ? (replay.prices[`${market}:${symbol}`] ?? NaN) : ticker?.last || NaN;
  const spec = SYMBOL_SPECS[symbol][market];
  const pd = priceDecimals(symbol, market);
  const qd = qtyDecimals(symbol, market);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [price, setPrice] = useState<number | null>(null);
  const [stop, setStop] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [unit, setUnit] = useState<SizeUnit>('quote');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [withBrackets, setWithBrackets] = useState(false);
  const [tp, setTp] = useState<number | null>(null);
  const [sl, setSl] = useState<number | null>(null);
  const [riskPct, setRiskPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [postOnly, setPostOnly] = useState(false);
  const [callback, setCallback] = useState<number | null>(1);
  const [activation, setActivation] = useState<number | null>(null);

  // price picked from order book / chart
  useEffect(
    () =>
      bus.on('price:pick', (d: { symbol: SymbolId; price: number }) => {
        if (d.symbol !== symbol) return;
        if (type === 'market') setType('limit');
        if (type === 'stop') setStop(d.price);
        else setPrice(d.price);
      }),
    [symbol, type],
  );
  useEffect(() => {
    setPrice(null);
    setStop(null);
  }, [symbol]);

  const lev = acct ? (market === 'futures' ? acct.config.futures.leverage[symbol] || acct.config.futures.defaultLeverage : 1) : 1;
  // the slider moves freely and the leverage is applied when it is released
  const [levDraft, setLevDraft] = useState<number | null>(null);
  const mode = acct ? acct.config.futures.marginModes[symbol] || acct.config.futures.marginMode : 'cross';
  const pos = acct?.positions.find((p) => p.symbol === symbol);
  const refPrice = type === 'limit' || type === 'stopLimit' ? price || last : type === 'stop' ? stop || last : type === 'trailingStop' ? activation || last : last;

  const qty = useMemo(() => {
    if (!size || !(refPrice > 0) || !acct) return 0;
    let q = 0;
    if (unit === 'base') q = size;
    else if (unit === 'quote') q = size / refPrice;
    else {
      if (market === 'spot' && side === 'sell') q = ((pos?.qty || 0) * size) / 100;
      else q = ((acct.available * (market === 'futures' ? lev : 1)) * size) / 100 / refPrice / (1 + (market === 'spot' ? acct.config.costs.takerFee : 0));
    }
    return floorToStep(q, spec.stepSize);
  }, [size, unit, refPrice, acct, lev, side, market, pos, spec.stepSize]);

  // risk-based sizing: qty such that SL hit loses riskPct of equity
  useEffect(() => {
    if (!riskPct || !sl || !acct || !(refPrice > 0)) return;
    const dist = Math.abs(refPrice - sl);
    if (!(dist > 0)) return;
    const q = floorToStep((acct.equity * riskPct) / 100 / dist, spec.stepSize);
    setUnit('base');
    setSize(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskPct, sl, refPrice]);

  const notional = qty * (refPrice || 0);
  const feeRate = acct ? (type === 'limit' ? acct.config.costs.makerFee : acct.config.costs.takerFee) : 0;
  const fee = notional * feeRate + (acct?.config.costs.flatFee || 0);
  // reduce-only orders free margin instead of using it
  const margin = market === 'futures' ? (reduceOnly ? 0 : notional / lev) : notional + fee;
  const estLiq = useMemo(() => {
    if (market !== 'futures' || !acct || !(qty > 0) || !(refPrice > 0)) return NaN;
    const dir = side === 'buy' ? 1 : -1;
    const signed = (pos ? pos.side * pos.qty : 0) + dir * qty;
    if (signed === 0) return NaN;
    const entry = pos && pos.side === dir ? (pos.entry * pos.qty + refPrice * qty) / (pos.qty + qty) : refPrice;
    const wallet = mode === 'isolated' ? (Math.abs(signed) * entry) / lev : acct.wallet;
    return liquidationPrice({ symbol, side: signed > 0 ? 1 : -1, qty: Math.abs(signed), entry, wallet });
  }, [market, acct, qty, refPrice, side, pos, mode, lev, symbol]);

  const canSubmit = !!acct && qty >= spec.minQty && !busy && (type === 'market' || (type === 'limit' && price) || (type === 'stop' && stop) || (type === 'stopLimit' && stop && price) || (type === 'trailingStop' && !!callback && callback > 0));

  const submit = async () => {
    if (!acct) return;
    const req: PlaceOrderRequest = { symbol, side, type, qty, reduceOnly: reduceOnly || undefined, source: 'manual' };
    if (type === 'limit' || type === 'stopLimit') req.price = price!;
    if (type === 'stop' || type === 'stopLimit') req.stopPrice = stop!;
    if (type === 'limit') {
      req.tif = tif;
      if (postOnly) req.postOnly = true;
    }
    if (type === 'trailingStop') {
      req.callbackRate = (callback || 0) / 100;
      if (activation) req.activationPrice = activation;
    }
    if (withBrackets && !reduceOnly) {
      if (sl) req.sl = sl;
      if (tp) req.tp = tp;
    }
    if (type === 'market' && useApp.getState().settings.trading.confirmMarketOrders) {
      const ok = await confirmDialog({
        title: `${side === 'buy' ? 'Buy' : 'Sell'} ${SYMBOL_SPECS[symbol].base} at market?`,
        body: `${acct.config.name} · ${fmtNum(qty, qd)} ${SYMBOL_SPECS[symbol].base} ≈ ${fmtUsd(notional)}${market === 'futures' ? ` · ${lev}x ${mode}` : ''}`,
        confirm: side === 'buy' ? 'Buy' : 'Sell',
        danger: side === 'sell',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const o = await api.call('trading:place', acct.config.id, req);
      toast({ title: o.status === 'filled' ? 'Order filled' : o.status === 'rejected' ? 'Order rejected' : 'Order placed', body: `${side === 'buy' ? 'Buy' : 'Sell'} ${fmtNum(o.qty, qd)} ${SYMBOL_SPECS[symbol].base}${o.avgFillPrice ? ` @ ${fmtNum(o.avgFillPrice, pd)}` : ''}${o.rejectReason ? ` — ${o.rejectReason}` : ''}`, kind: o.status === 'rejected' ? 'warn' : 'ok' });
    } catch (e) {
      toast({ title: 'Order not accepted', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const setLeverage = async (L: number) => {
    if (!acct) return;
    try {
      if (L !== lev) await api.call('trading:setLeverage', acct.config.id, symbol, L);
    } catch (e) {
      toast({ title: 'Leverage not changed', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'warn' });
    } finally {
      setLevDraft(null);
    }
  };
  const commitLeverage = () => {
    if (levDraft !== null) void setLeverage(levDraft);
  };

  if (!accounts.length && !replay)
    return (
      <div className="empty">
        <Icon name="wallet" size={26} />
        <div className="empty-title">No paper account yet</div>
        <button className="btn primary" onClick={() => openCreateAccount((id) => set({ accountId: id }))}>
          Create paper account
        </button>
      </div>
    );

  // Binance: the leverage bracket of the current position size caps the leverage
  const maxLev = market === 'futures' ? Math.min(acct?.config.risk.maxLeverage || 20, maxLeverageFor(symbol, pos ? pos.notional : 0)) : 1;
  const levTip = !pos
    ? undefined
    : pos.marginMode === 'isolated'
      ? 'Open isolated position: leverage can only be raised (Binance). Add margin to lower the risk instead.'
      : 'Open cross position: lowering the leverage needs enough available balance for the larger margin (Binance).';
  return (
    <div className="mod-scroll trade-panel">
      <HeadControls>
        {replay ? (
          <span className="badge warn" data-tip="Orders go to this window's replay account and fill on replayed prices">
            <Icon name="replay" size={11} /> Replay account
          </span>
        ) : (
          <AccountSelect value={accountId} onChange={(id) => set({ accountId: id })} compact />
        )}
        <SymbolPicker symbol={symbol} market={market} onChange={(s, m) => set(replay ? { symbol: s, market: m } : { symbol: s })} showMarket={!!replay} />
        <div className="spacer" />
        {acct && statusBadge(acct)}
      </HeadControls>
      {acct?.rules && acct.status !== 'active' && <div className={clsx('callout', acct.status === 'breached' ? 'danger' : 'warn')}>{acct.statusReason}</div>}
      <div className="seg buy-sell" style={{ width: '100%', display: 'flex' }}>
        <button className={clsx('b', side === 'buy' && 'on')} style={{ flex: 1, height: 28 }} onClick={() => setSide('buy')}>
          {market === 'futures' ? 'Long' : 'Buy'}
        </button>
        <button className={clsx('s', side === 'sell' && 'on')} style={{ flex: 1, height: 28 }} onClick={() => setSide('sell')}>
          {market === 'futures' ? 'Short' : 'Sell'}
        </button>
      </div>
      <Tabs value={type} onChange={setType} tabs={[{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }, { value: 'stopLimit', label: 'Stop-limit' }, { value: 'trailingStop', label: 'Trailing' }]} />
      {market === 'futures' && acct && (
        <div className="row">
          <span className="muted" style={{ width: 70 }}>
            Leverage
          </span>
          <input
            type="range"
            min={pos && pos.marginMode === 'isolated' ? pos.leverage : 1}
            max={Math.max(maxLev, lev)}
            step={1}
            value={levDraft ?? lev}
            onChange={(e) => setLevDraft(+e.target.value)}
            onPointerUp={commitLeverage}
            onKeyUp={commitLeverage}
            onBlur={commitLeverage}
            className="grow"
            data-tip={levTip}
          />
          <b className="num" style={{ width: 38, textAlign: 'right' }}>
            {levDraft ?? lev}x
          </b>
          <Segmented size="sm" value={mode} onChange={(m) => api.call('trading:setMarginMode', acct.config.id, symbol, m).catch((e) => toast({ title: 'Margin mode not changed', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'warn' }))} options={[{ value: 'cross', label: 'Cross' }, { value: 'isolated', label: 'Iso' }]} />
        </div>
      )}
      {(type === 'stop' || type === 'stopLimit') && (
        <PriceRow label="Trigger" value={stop} onChange={setStop} last={last} pd={pd} tick={spec.tickSize} />
      )}
      {(type === 'limit' || type === 'stopLimit') && <PriceRow label="Limit" value={price} onChange={setPrice} last={last} pd={pd} tick={spec.tickSize} />}
      {type === 'limit' && (
        <div className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ width: 70 }} data-tip="GTC rests until filled or canceled. IOC fills what it can right away and cancels the rest. FOK fills completely right away or not at all.">
            Validity
          </span>
          <Segmented size="sm" value={tif} onChange={(v) => setTif(v)} options={[{ value: 'GTC', label: 'GTC' }, { value: 'IOC', label: 'IOC' }, { value: 'FOK', label: 'FOK' }]} />
          <div className="spacer" />
          <label className="row" style={{ gap: 6 }} data-tip="Only add liquidity: rejected if it would fill immediately (maker fee)">
            <Toggle value={postOnly} onChange={setPostOnly} />
            <span>Post-only</span>
          </label>
        </div>
      )}
      {type === 'trailingStop' && (
        <>
          <div className="row">
            <span className="muted" style={{ width: 70 }} data-tip={`How far the price may come back from its best level before the order triggers (${market === 'futures' ? '0.1–10%' : '0.1–20%'})`}>
              Callback
            </span>
            <NumberField value={callback} onChange={setCallback} min={0.1} max={market === 'futures' ? 10 : 20} step={0.1} suffix="%" style={{ flex: 1 }} />
            {[0.5, 1, 2, 5].map((p) => (
              <button key={p} className={clsx('btn small', callback === p && 'on')} onClick={() => setCallback(p)}>
                {p}%
              </button>
            ))}
          </div>
          <PriceRow label="Activation" value={activation} onChange={setActivation} last={last} pd={pd} tick={spec.tickSize} />
          <div className="hint">
            {side === 'sell' ? 'Follows the highest price' : 'Follows the lowest price'}
            {activation ? ` after the price reaches ${fmtNum(activation, pd)}` : ' from now'} and triggers a market order {callback || 0}% {side === 'sell' ? 'below' : 'above'} it.
          </div>
        </>
      )}
      <div className="row">
        <span className="muted" style={{ width: 70 }}>
          Size
        </span>
        <NumberField value={size} onChange={setSize} min={0} step={unit === 'quote' ? 100 : unit === 'pct' ? 5 : spec.stepSize * 10} style={{ flex: 1 }} placeholder="0" />
        <Segmented size="sm" value={unit} onChange={(u) => setUnit(u)} options={[{ value: 'quote', label: 'USDT' }, { value: 'base', label: SYMBOL_SPECS[symbol].base }, { value: 'pct', label: '%' }]} />
      </div>
      <div className="row" style={{ gap: 4 }}>
        {[10, 25, 50, 100].map((p) => (
          <button
            key={p}
            className="btn small grow"
            onClick={() => {
              setUnit('pct');
              setSize(p);
            }}
          >
            {p}%
          </button>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="row" style={{ gap: 6 }}>
          <Toggle value={withBrackets} onChange={setWithBrackets} />
          <span>TP / SL</span>
        </label>
        {market === 'futures' && (
          <label className="row" style={{ gap: 6 }}>
            <Toggle value={reduceOnly} onChange={setReduceOnly} />
            <span>Reduce-only</span>
          </label>
        )}
      </div>
      {withBrackets && !reduceOnly && (
        <div className="card col" style={{ gap: 8, padding: 10 }}>
          <PriceRow label="Take profit" value={tp} onChange={setTp} last={refPrice} pd={pd} tick={spec.tickSize} pctHint={side === 'buy' ? 1 : -1} />
          <PriceRow label="Stop loss" value={sl} onChange={setSl} last={refPrice} pd={pd} tick={spec.tickSize} pctHint={side === 'buy' ? -1 : 1} />
          <div className="row">
            <span className="muted" style={{ width: 70 }}>
              Risk
            </span>
            <NumberField value={riskPct} onChange={setRiskPct} min={0} max={100} step={0.25} placeholder="% of equity" suffix="%" style={{ flex: 1 }} />
          </div>
          <div className="hint">Setting a risk % sizes the order so that hitting the stop loses that share of equity.</div>
        </div>
      )}
      <div className="trade-summary">
        <Row k="Quantity" v={`${fmtNum(qty, qd)} ${SYMBOL_SPECS[symbol].base}`} />
        <Row k="Value" v={fmtUsd(notional)} />
        <Row k={market === 'futures' ? 'Initial margin' : 'Cost'} v={fmtUsd(margin)} />
        <Row k={`Fee (${type === 'limit' && postOnly ? 'maker' : type === 'limit' ? 'maker if resting' : 'taker'})`} v={fmtUsd(fee)} />
        {market === 'futures' && <Row k="Est. liquidation" v={isFinite(estLiq) && estLiq > 0 ? fmtNum(estLiq, pd) : '—'} />}
        <Row k="Available" v={acct ? fmtUsd(acct.available) : '—'} />
      </div>
      <button className={clsx('btn large', side === 'buy' ? 'buy' : 'sell')} disabled={!canSubmit} onClick={submit}>
        {busy ? 'Sending…' : `${reduceOnly && market === 'futures' ? (side === 'buy' ? 'Reduce short' : 'Reduce long') : side === 'buy' ? (market === 'futures' ? 'Open long' : 'Buy') : market === 'futures' ? 'Open short' : 'Sell'} ${SYMBOL_SPECS[symbol].base}${type === 'trailingStop' ? ' (trailing)' : ''}`}
      </button>
      {pos && (
        <div className="card row" style={{ padding: 8 }}>
          <span className={pos.side === 1 ? 'up' : 'down'} style={{ fontWeight: 650 }}>
            {pos.side === 1 ? 'Long' : 'Short'} {fmtNum(pos.qty, qd)}
          </span>
          <span className="faint">@ {fmtNum(pos.entry, pd)}</span>
          <div className="spacer" />
          <b className={pos.uPnl >= 0 ? 'up num' : 'down num'}>{fmtUsd(pos.uPnl)}</b>
          <button className="btn small" onClick={() => api.call('trading:close', acct!.config.id, symbol).catch((e) => toast({ title: 'Close failed', body: errorMessage(e), kind: 'error' }))}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className="faint">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

function PriceRow({ label, value, onChange, last, pd, tick, pctHint }: { label: string; value: number | null; onChange: (v: number | null) => void; last: number; pd: number; tick: number; pctHint?: number }) {
  return (
    <div className="row">
      <span className="muted" style={{ width: 70 }}>
        {label}
      </span>
      <NumberField value={value} onChange={(v) => onChange(roundToTick(v, tick))} step={tick * 10} decimals={pd} style={{ flex: 1 }} placeholder={isFinite(last) ? fmtNum(last, pd) : ''} />
      {pctHint ? (
        [0.5, 1, 2].map((p) => (
          <button key={p} className="btn small" onClick={() => onChange(roundToTick(last * (1 + (pctHint * p) / 100), tick))} data-tip={`${pctHint > 0 ? '+' : '−'}${p}% from entry`}>
            {pctHint > 0 ? '+' : '−'}
            {p}%
          </button>
        ))
      ) : (
        <button className="btn small" onClick={() => isFinite(last) && onChange(last)}>
          Last
        </button>
      )}
    </div>
  );
}
