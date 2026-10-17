import { ReplayLiveNotice } from '../chart/replay';
import { useMemo, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useTopicValue } from '../../lib/hooks';
import type { BookSnapshot, ImbalanceMethod } from '../../../shared/marketTypes';
import { SYMBOL_SPECS, priceDecimals, qtyDecimals, type Market, type SymbolId } from '../../../shared/symbols';
import { SymbolPicker, Select, Popover, usePopover, Segmented, NumberField } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtNum, fmtCompact, fmtUsd } from '../../lib/format';
import { bus } from '../../lib/bus';
import './market.css';

export const GROUPS: Record<SymbolId, number[]> = {
  BTCUSDT: [0, 0.1, 1, 5, 10, 50, 100],
  ETHUSDT: [0, 0.1, 0.5, 1, 5, 10],
  SOLUSDT: [0, 0.01, 0.05, 0.1, 0.5, 1],
};

export const IMB_LABEL: Record<ImbalanceMethod, string> = { levels: 'Top N levels', depthPct: 'Within % of mid', weighted: 'Distance-weighted' };

export function ImbalanceSettings({ method, param, onChange }: { method: ImbalanceMethod; param: number; onChange: (m: ImbalanceMethod, p: number) => void }) {
  const pop = usePopover();
  return (
    <>
      <button className="icon-btn" onClick={(e) => pop.toggle(e.currentTarget)} data-tip="Imbalance calculation">
        <Icon name="sliders" />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={290} align="end">
          <div className="col" style={{ padding: 8 }}>
            <div className="section-title">Order-book imbalance</div>
            <Segmented value={method} onChange={(m) => onChange(m, m === 'levels' ? 10 : m === 'depthPct' ? 0.5 : 10)} options={[{ value: 'levels', label: 'Levels' }, { value: 'depthPct', label: '% depth' }, { value: 'weighted', label: 'Weighted' }]} />
            <div className="field">
              <label>{method === 'levels' ? 'Number of levels per side' : method === 'depthPct' ? 'Depth around mid (%)' : 'Half-life (basis points from mid)'}</label>
              <NumberField value={param} step={method === 'depthPct' ? 0.1 : 1} min={method === 'depthPct' ? 0.01 : 1} onChange={(v) => onChange(method, v)} />
            </div>
            <div className="hint">
              (bid notional − ask notional) / (bid + ask). Positive = more resting bids. This measures displayed liquidity only — resting orders can be pulled at any time and are not executed volume.
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

export function OrderBookModule({ module }: ModuleProps) {
  const cfg = module.config as { symbol: SymbolId; market: Market; group: number; levels: number; imbalance: { method: ImbalanceMethod; param: number } };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const imb = cfg.imbalance || { method: 'depthPct', param: 0.5 };
  const [mode, setMode] = useState<'amount' | 'total'>('total');
  const levels = Math.max(5, Math.min(60, cfg.levels || 18));
  const snap = useTopicValue<BookSnapshot>('book', { symbol: cfg.symbol, market: cfg.market, group: cfg.group || 0, levels, imbalance: imb });
  const large = useTopicValue<{ threshold: number }>('largeOrders', { symbol: cfg.symbol, market: cfg.market });
  const pd = cfg.group && cfg.group >= 1 ? 0 : priceDecimals(cfg.symbol, cfg.market);
  const qd = Math.min(4, qtyDecimals(cfg.symbol, cfg.market));
  const spec = SYMBOL_SPECS[cfg.symbol];
  const rows = useMemo(() => {
    if (!snap || !snap.metrics) return null;
    const cum = (arr: [number, number][]) => {
      let c = 0;
      return arr.map(([p, q]) => {
        c += q;
        return { p, q, c };
      });
    };
    const bids = cum(snap.bids);
    const asks = cum(snap.asks);
    const maxC = Math.max(bids[bids.length - 1]?.c || 0, asks[asks.length - 1]?.c || 0);
    const maxQ = Math.max(...snap.bids.map((x) => x[1]), ...snap.asks.map((x) => x[1]), 0);
    return { bids, asks: asks.slice().reverse(), maxC, maxQ };
  }, [snap]);
  const thrQty = large ? large.threshold / (snap?.metrics?.mid || 1) : Infinity;
  const pick = (p: number) => bus.emit('price:pick', { symbol: cfg.symbol, market: cfg.market, price: p }, false);
  const m = snap?.metrics;
  return (
    <div className="ob">
      <HeadControls>
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, mk) => set({ symbol: s, market: mk, group: 0 })} />
        <div className="spacer" />
        <Select
          value={String(cfg.group || 0)}
          onChange={(v) => set({ group: +v })}
          options={GROUPS[cfg.symbol].map((g) => ({ value: String(g), label: g === 0 ? String(SYMBOL_SPECS[cfg.symbol][cfg.market].tickSize) : String(g) }))}
          style={{ height: 24, fontSize: 12, minWidth: 64 }}
          title="Price grouping (the first is the tick size), as on Binance"
        />
        <ImbalanceSettings method={imb.method} param={imb.param} onChange={(mm, p) => set({ imbalance: { method: mm, param: p } })} />
      </HeadControls>
      <ReplayLiveNotice what="order books aren't recorded historically" />
      <div className="ob-head">
        <span>Price ({spec.quote})</span>
        <span>Size ({spec.base})</span>
        <span style={{ cursor: 'pointer' }} onClick={() => setMode(mode === 'total' ? 'amount' : 'total')}>
          {mode === 'total' ? 'Total' : 'Notional'} ⇅
        </span>
      </div>
      {!rows ? (
        <div className="empty">
          <span className="spinner" />
          <span>{snap?.status === 'resyncing' ? 'Resynchronising order book…' : 'Syncing order book…'}</span>
        </div>
      ) : (
        <>
          <div className="ob-side asks">
            {rows.asks.map((r) => (
              <div key={r.p} className={`ob-row${r.q >= thrQty ? ' large' : ''}`} onClick={() => pick(r.p)} data-tip={r.q >= thrQty ? 'Large resting order (displayed liquidity — may be pulled)' : undefined}>
                <div className="bar" style={{ width: `${((mode === 'total' ? r.c / rows.maxC : r.q / rows.maxQ) * 100).toFixed(1)}%`, background: 'color-mix(in srgb, var(--down) 15%, transparent)' }} />
                <span className="down">{fmtNum(r.p, pd)}</span>
                <span>{fmtNum(r.q, qd)}</span>
                <span className="muted">{mode === 'total' ? fmtNum(r.c, qd) : fmtCompact(r.q * r.p)}</span>
              </div>
            ))}
          </div>
          <div className="ob-mid">
            <span className="mid-price num">{m ? fmtNum(m.mid, priceDecimals(cfg.symbol, cfg.market)) : '—'}</span>
            <span className="faint num">spread {m ? fmtNum(m.spread, priceDecimals(cfg.symbol, cfg.market)) : '—'}</span>
            <div className="spacer" />
            <span className="faint">bid/ask ±1%</span>
            <span className="num up">{m ? fmtCompact(m.bidDepth1pct) : ''}</span>
            <span className="num down">{m ? fmtCompact(m.askDepth1pct) : ''}</span>
          </div>
          <div className="ob-side">
            {rows.bids.map((r) => (
              <div key={r.p} className={`ob-row${r.q >= thrQty ? ' large' : ''}`} onClick={() => pick(r.p)}>
                <div className="bar" style={{ width: `${((mode === 'total' ? r.c / rows.maxC : r.q / rows.maxQ) * 100).toFixed(1)}%`, background: 'color-mix(in srgb, var(--up) 15%, transparent)' }} />
                <span className="up">{fmtNum(r.p, pd)}</span>
                <span>{fmtNum(r.q, qd)}</span>
                <span className="muted">{mode === 'total' ? fmtNum(r.c, qd) : fmtCompact(r.q * r.p)}</span>
              </div>
            ))}
          </div>
          {m && (
            <div className="imb" data-tip={`${IMB_LABEL[m.imbalanceMethod]} (${m.imbalanceParam})\nDisplayed liquidity only; not executed trades.`}>
              <div className="row" style={{ fontSize: 11.5 }}>
                <span className="muted">Imbalance</span>
                <span className="faint">{IMB_LABEL[m.imbalanceMethod]}</span>
                <div className="spacer" />
                <b className={m.imbalance >= 0 ? 'up num' : 'down num'}>{(m.imbalance * 100).toFixed(1)}%</b>
              </div>
              <div className="imb-bar">
                <div className="b" style={{ width: `${((m.imbalance + 1) / 2) * 100}%` }} />
                <div className="a" style={{ flex: 1 }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export { fmtUsd };
