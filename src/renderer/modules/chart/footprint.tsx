/**
 * Footprint data for charts in footprint mode: buyer/seller-initiated volume per price level,
 * streamed from the main process (Binance aggregate trades: cached history + live tape).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { ChartEngine } from '../../chart/engine';
import type { BarStore } from '../../chart/barStore';
import type { FootprintBar } from '../../chart/types';
import { parseTimeframe, tfDurationMs, isFixedDuration } from '../../../shared/timeframes';

interface Wire {
  t: number;
  step: number;
  prices: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
}

type Status = { phase: 'off' | 'loading' | 'ready' | 'error'; done?: number; total?: number; trades?: number; message?: string; source?: string };

/** Bars of footprint history to load for a timeframe (bounded to a few days of trades). */
function barsFor(tfMs: number): number {
  return Math.max(12, Math.min(240, Math.floor((tfMs <= 60000 ? 6 : tfMs <= 900000 ? 36 : 72) * 3600000 / tfMs)));
}

export function useFootprint(cfg: ChartModuleConfig, _store: { current: BarStore }, _v: number, _eng: ChartEngine | null, replay: boolean): { bars: Map<number, unknown> | null; version: number; overlay: ReactNode } {
  const active = cfg.chartType === 'footprint';
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Status>({ phase: 'off' });
  const bars = useRef(new Map<number, FootprintBar>());
  const raf = useRef(0);
  const bump = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setVersion((x) => x + 1);
    });
  };
  useEffect(() => {
    bars.current = new Map();
    bump();
    if (!active || replay) {
      setStatus({ phase: 'off' });
      return;
    }
    const tf = parseTimeframe(cfg.tf);
    if (!tf || !isFixedDuration(tf)) {
      setStatus({ phase: 'error', message: 'Footprints need a fixed-length timeframe (seconds to days).' });
      return;
    }
    setStatus({ phase: 'loading', done: 0, total: 1 });
    const unsub = api.sub<any>('footprint', { symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, bars: barsFor(tfDurationMs(tf)) }, (m) => {
      if (m.__error) {
        setStatus({ phase: 'error', message: String(m.__error).replace(/^Validation: /, '') });
        return;
      }
      if (m.type === 'progress') setStatus({ phase: 'loading', done: m.done, total: m.total, trades: m.trades });
      else if (m.type === 'error') setStatus({ phase: 'error', message: m.message });
      else if (m.type === 'snapshot' || m.type === 'update') {
        const map = m.type === 'snapshot' ? new Map<number, FootprintBar>() : bars.current;
        for (const w of m.bars as Wire[]) map.set(w.t, { t: w.t, step: w.step, prices: w.prices, buy: w.buy, sell: w.sell });
        bars.current = map;
        if (m.type === 'snapshot') setStatus({ phase: 'ready', trades: m.trades, source: m.source });
        bump();
      }
    });
    return () => {
      unsub();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, replay, cfg.symbol, cfg.market, cfg.tf]);

  let overlay: ReactNode = null;
  if (active && replay) overlay = <div className="fp-status">Footprints use live trade data and are not part of the replay.</div>;
  else if (active && status.phase === 'loading') {
    const pct = status.total ? Math.round(((status.done || 0) / status.total) * 100) : 0;
    overlay = (
      <div className="fp-status">
        <span className="spinner" style={{ width: 10, height: 10 }} /> Loading trades for the footprint… {pct}%{status.trades ? ` · ${status.trades.toLocaleString('en-US')} trades` : ''}
      </div>
    );
  } else if (active && status.phase === 'error') overlay = <div className="fp-status err">Footprint: {status.message}</div>;
  return { bars: active && !replay ? bars.current : null, version, overlay };
}
