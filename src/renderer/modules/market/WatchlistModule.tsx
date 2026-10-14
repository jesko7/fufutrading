import { ReplayLiveNotice } from '../chart/replay';
import { useEffect, useRef, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useTicker, useTopicValue, useNow } from '../../lib/hooks';
import { api } from '../../api';
import { SYMBOLS, SYMBOL_SPECS, priceDecimals, type Market, type SymbolId } from '../../../shared/symbols';
import { CoinIcon } from '../../components/Icon';
import { Segmented } from '../../components/ui';
import { clsx, fmtNum, fmtPct, fmtCompact, fmtDuration } from '../../lib/format';
import { BarStore } from '../../chart/barStore';
import { subscribeBars } from '../chart/ChartModule';
import './market.css';

export function WatchlistModule({ module }: ModuleProps) {
  const filter = (module.config.filter as 'all' | 'spot' | 'futures') || 'all';
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const rows: { symbol: SymbolId; market: Market }[] = [];
  for (const m of ['spot', 'futures'] as Market[]) {
    if (filter !== 'all' && filter !== m) continue;
    for (const s of SYMBOLS) rows.push({ symbol: s, market: m });
  }
  return (
    <div className="mod-scroll">
      <ReplayLiveNotice what="current prices" />
      <HeadControls>
        <div className="spacer" />
        <Segmented size="sm" value={filter} onChange={(v) => set({ filter: v })} options={[{ value: 'all', label: 'All' }, { value: 'spot', label: 'Spot' }, { value: 'futures', label: 'Perp' }]} />
      </HeadControls>
      <div className="watch-list">
        {rows.map((r) => (
          <WatchRow key={`${r.market}${r.symbol}`} {...r} moduleId={module.id} />
        ))}
      </div>
    </div>
  );
}

function selectInstrument(moduleId: string, symbol: SymbolId, market: Market): void {
  const st = useApp.getState();
  const ws = st.workspace;
  if (!ws) return;
  const me = ws.modules[moduleId];
  if (me?.link) {
    // linked: change the group's instrument (main propagates to all members)
    for (const m of Object.values(ws.modules)) if (m.link === me.link && m.id !== moduleId && 'symbol' in m.config) st.setModuleConfig(m.id, { symbol, market });
    return;
  }
  const target = st.focusedModule && ws.modules[st.focusedModule]?.type === 'chart' ? st.focusedModule : lastChart(ws.modules);
  if (target) st.setModuleConfig(target, { symbol, market });
}

function lastChart(mods: Record<string, { id: string; type: string }>): string | null {
  const charts = Object.values(mods).filter((m) => m.type === 'chart');
  const focused = (window as any).__lastChartModule as string | undefined;
  if (focused && charts.some((c) => c.id === focused)) return focused;
  return charts[0]?.id || null;
}

function WatchRow({ symbol, market, moduleId }: { symbol: SymbolId; market: Market; moduleId: string }) {
  const t = useTicker(symbol, market);
  const mark = useTopicValue<{ mark: number; fundingRate: number; nextFundingTime: number }>(market === 'futures' ? 'mark' : null, { symbol });
  const now = useNow(1000);
  const prev = useRef<number>(NaN);
  const [flash, setFlash] = useState<'' | 'up' | 'down'>('');
  useEffect(() => {
    if (!t) return;
    if (isFinite(prev.current) && t.last !== prev.current) {
      setFlash(t.last > prev.current ? 'up' : 'down');
      const id = setTimeout(() => setFlash(''), 350);
      prev.current = t.last;
      return () => clearTimeout(id);
    }
    prev.current = t.last;
  }, [t?.last]);
  const d = priceDecimals(symbol, market);
  const pct = t?.changePct24h ?? NaN;
  return (
    <div className="watch-row" onClick={() => selectInstrument(moduleId, symbol, market)}>
      <div className="w-sym">
        <CoinIcon symbol={symbol} size={20} />
        <div>
          <div className="w-name">
            {SYMBOL_SPECS[symbol].base}
            {market === 'futures' && <span className="badge accent" style={{ marginLeft: 6 }}>PERP</span>}
          </div>
          <div className="w-sub">{market === 'futures' && mark ? `Fund ${fmtPct(mark.fundingRate * 100, 4)} · ${fmtDuration(mark.nextFundingTime - now)}` : SYMBOL_SPECS[symbol].name}</div>
        </div>
      </div>
      <Sparkline symbol={symbol} market={market} up={pct >= 0} />
      <div className="w-price">
        <div className={clsx('num', 'w-last', flash && `flash-${flash}`)}>{t ? fmtNum(t.last, d) : '—'}</div>
        <div className={clsx('num', pct >= 0 ? 'up' : 'down')} style={{ fontSize: 11.5 }}>
          {fmtPct(pct)} <span className="faint">· {t ? fmtCompact(t.quoteVolume24h) : '—'}</span>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ symbol, market, up }: { symbol: SymbolId; market: Market; up: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const store = new BarStore();
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = 64;
      const h = 26;
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = Math.min(96, store.length);
      if (n < 2) return;
      const from = store.length - n;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < store.length; i++) {
        lo = Math.min(lo, store.c[i]);
        hi = Math.max(hi, store.c[i]);
      }
      const col = store.c[store.length - 1] >= store.c[from] ? getComputedStyle(document.documentElement).getPropertyValue('--up') : getComputedStyle(document.documentElement).getPropertyValue('--down');
      ctx.strokeStyle = col.trim();
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = from; i < store.length; i++) {
        const x = ((i - from) / (n - 1)) * (w - 2) + 1;
        const y = h - 2 - ((store.c[i] - lo) / (hi - lo || 1)) * (h - 4);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    return subscribeBars({ symbol, market, tf: '15m' }, store, draw);
  }, [symbol, market]);
  void up;
  return <canvas ref={ref} style={{ width: 64, height: 26 }} />;
}

export { api };
