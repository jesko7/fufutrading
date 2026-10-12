import { useRef, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useTopic, useInterval } from '../../lib/hooks';
import type { TradePrint } from '../../../shared/marketTypes';
import { priceDecimals, qtyDecimals, type Market, type SymbolId } from '../../../shared/symbols';
import { SymbolPicker, Select } from '../../components/ui';
import { clsx, fmtNum, fmtTime, fmtCompact } from '../../lib/format';
import './market.css';

export function TradesModule({ module }: ModuleProps) {
  const cfg = module.config as { symbol: SymbolId; market: Market; minNotional: number };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const buf = useRef<TradePrint[]>([]);
  const [list, setList] = useState<TradePrint[]>([]);
  const [stats, setStats] = useState({ buy: 0, sell: 0 });
  const dirty = useRef(false);
  const min = cfg.minNotional || 0;
  useTopic<{ trades: TradePrint[]; initial?: boolean }>('trades', { symbol: cfg.symbol, market: cfg.market }, (d) => {
    if (d.initial) buf.current = [];
    buf.current.push(...d.trades);
    if (buf.current.length > 4000) buf.current.splice(0, buf.current.length - 4000);
    dirty.current = true;
  });
  useInterval(() => {
    if (!dirty.current) return;
    dirty.current = false;
    const f = buf.current.filter((t) => t.p * t.q >= min);
    setList(f.slice(-150).reverse());
    const now = Date.now();
    let b = 0;
    let s = 0;
    for (let i = buf.current.length - 1; i >= 0; i--) {
      const t = buf.current[i];
      if (now - t.t > 60000) break;
      if (t.m) s += t.q * t.p;
      else b += t.q * t.p;
    }
    setStats({ buy: b, sell: s });
  }, 120);
  const pd = priceDecimals(cfg.symbol, cfg.market);
  const qd = Math.min(4, qtyDecimals(cfg.symbol, cfg.market));
  const big = min > 0 ? min * 10 : 100000;
  return (
    <div className="mod-scroll" style={{ display: 'flex', flexDirection: 'column' }}>
      <HeadControls>
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={(s, m) => set({ symbol: s, market: m })} />
        <div className="spacer" />
        <Select value={String(min)} onChange={(v) => set({ minNotional: +v })} options={[0, 1000, 10000, 50000, 100000, 500000].map((v) => ({ value: String(v), label: v ? `≥ $${fmtCompact(v)}` : 'All sizes' }))} style={{ height: 24, fontSize: 12 }} />
      </HeadControls>
      <div className="row" style={{ padding: '6px 10px', fontSize: 11.5, borderBottom: '1px solid var(--border)' }}>
        <span className="faint">Last 60s</span>
        <span className="up num">Buy ${fmtCompact(stats.buy)}</span>
        <span className="down num">Sell ${fmtCompact(stats.sell)}</span>
        <div className="spacer" />
        <span className={clsx('num', stats.buy >= stats.sell ? 'up' : 'down')}>Δ ${fmtCompact(stats.buy - stats.sell)}</span>
      </div>
      <div className="tape-row faint" style={{ fontSize: 11 }}>
        <span>Time</span>
        <span>Price</span>
        <span>Size</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {list.map((t) => (
          <div key={t.id} className={clsx('tape-row', t.p * t.q >= big && 'big')} style={t.p * t.q >= big ? { background: `color-mix(in srgb, var(--${t.m ? 'down' : 'up'}) 12%, transparent)` } : undefined}>
            <span className="faint">{fmtTime(t.t, true)}</span>
            <span className={t.m ? 'down' : 'up'}>{fmtNum(t.p, pd)}</span>
            <span>{fmtNum(t.q, qd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
