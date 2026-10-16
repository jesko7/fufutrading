/**
 * Positioning history for the Derivatives module: price against open interest (both as % change
 * over the range), the long/short ratios and funding — from the same futures data series scripts
 * use (BINANCE:<symbol>.P_OI, _LSR, _TOP_POS, _FUNDING), so the picture matches backtests.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { BarStore } from '../../chart/barStore';
import { LineChart } from '../../components/LineChart';
import { Icon } from '../../components/Icon';
import { Segmented, Spinner } from '../../components/ui';
import type { MetricKind } from '../../../shared/metrics';
import type { SymbolId } from '../../../shared/symbols';

const C = { price: '#8b93a3', oi: '#3b82f6', lsr: '#06b6d4', top: '#f59e0b', funding: '#a855f7' };

function Key({ color, children }: { color: string; children: string }) {
  return (
    <span className="dh-key">
      <span className="dh-dot" style={{ background: color }} />
      {children}
    </span>
  );
}

const RANGES = [
  { value: '7d', label: '7D', tf: '1h', bars: 7 * 24 },
  { value: '30d', label: '30D', tf: '4h', bars: 30 * 6 },
  { value: '90d', label: '90D', tf: '12h', bars: 90 * 2 },
  { value: '1y', label: '1Y', tf: '1D', bars: 365 },
] as const;
type RangeId = (typeof RANGES)[number]['value'];

interface Closes {
  t: Float64Array;
  c: Float64Array;
}

/** Bar times and closes of a perpetual's series (klines, or a futures data series), live. */
function useCloses(symbol: SymbolId, tf: string, bars: number, metric?: MetricKind): Closes | null {
  const [v, setV] = useState<Closes | null>(null);
  useEffect(() => {
    const store = new BarStore();
    let raf = 0;
    setV(null);
    const unsub = api.sub<any>('series', { symbol, market: 'futures', tf, chartType: 'candles', metric, bars: bars + 10 }, (msg) => {
      if (msg.__error) return;
      if (msg.type === 'snapshot') store.setPacked(msg.packed);
      else store.apply(msg.index, msg.packed, msg.length);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setV({ t: store.t.slice(0, store.length), c: store.c.slice(0, store.length) });
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [symbol, tf, bars, metric]);
  return v;
}

/** Values of `s` at the times `t` (the last value at or before each time; NaN before the first). */
function alignTo(t: Float64Array, s: Closes | null): Float64Array {
  const out = new Float64Array(t.length).fill(NaN);
  if (!s) return out;
  let j = -1;
  for (let i = 0; i < t.length; i++) {
    while (j + 1 < s.t.length && s.t[j + 1] <= t[i]) j++;
    if (j >= 0) out[i] = s.c[j];
  }
  return out;
}

/** % change from the first finite value. */
function changePct(a: Float64Array): Float64Array {
  let base = NaN;
  for (const x of a)
    if (Number.isFinite(x) && x !== 0) {
      base = x;
      break;
    }
  return a.map((x) => (Number.isFinite(base) ? (x / base - 1) * 100 : NaN));
}

export function PositioningHistory({ symbol, range, onRange }: { symbol: SymbolId; range: RangeId; onRange: (r: RangeId) => void }) {
  const r = RANGES.find((x) => x.value === range) || RANGES[1];
  const price = useCloses(symbol, r.tf, r.bars);
  const oi = useCloses(symbol, r.tf, r.bars, 'oiusd');
  const lsr = useCloses(symbol, r.tf, r.bars, 'lsr');
  const top = useCloses(symbol, r.tf, r.bars, 'toppos');
  const funding = useCloses(symbol, r.tf, r.bars, 'funding');
  const view = useMemo(() => {
    if (!price || !price.t.length) return null;
    const k = Math.max(0, price.t.length - r.bars);
    const t = price.t.slice(k);
    return {
      t,
      price: changePct(price.c.slice(k)),
      oi: changePct(alignTo(t, oi)),
      lsr: alignTo(t, lsr),
      top: alignTo(t, top),
      funding: alignTo(t, funding),
    };
  }, [price, oi, lsr, top, funding, r.bars]);
  return (
    <div className="deriv-card deriv-history" data-loaded={Object.entries({ price, oi, lsr, top, funding }).filter(([, v]) => v && v.t.length).map(([k]) => k).join(' ')}>
      <div className="dc-head">
        <Icon name="chart" size={13} /> Positioning history
        <span className="spacer" />
        <Segmented size="sm" value={range} onChange={onRange} options={RANGES.map((x) => ({ value: x.value, label: x.label }))} />
      </div>
      {!view ? (
        <div className="empty" style={{ height: 160 }}>
          <Spinner /> Loading history…
        </div>
      ) : (
        <>
          <div className="dh-label">
            <Key color={C.price}>Price</Key>
            <Key color={C.oi}>Open interest value</Key>
            <span>% change over the range</span>
          </div>
          <LineChart
            t={view.t}
            height={150}
            zeroLine
            format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
            series={[
              { values: view.price, color: C.price, label: 'Price' },
              { values: view.oi, color: C.oi, label: 'Open interest', width: 1.6 },
            ]}
          />
          <div className="dh-label">
            <Key color={C.lsr}>All accounts</Key>
            <Key color={C.top}>Top traders' positions</Key>
            <span>long/short ratio</span>
          </div>
          <LineChart
            t={view.t}
            height={84}
            format={(v) => v.toFixed(2)}
            series={[
              { values: view.lsr, color: C.lsr, label: 'All accounts' },
              { values: view.top, color: C.top, label: 'Top traders (positions)' },
            ]}
          />
          <div className="dh-label">
            <Key color={C.funding}>Funding</Key>
            <span>% per 8 hours, positive: longs pay shorts</span>
          </div>
          <LineChart t={view.t} height={64} zeroLine format={(v) => `${v.toFixed(4)}%`} series={[{ values: view.funding, color: C.funding, label: 'Funding' }]} />
          <div className="faint small">The same data scripts use: BINANCE:{symbol}.P_OI_USD, _LSR, _TOP_POS and _FUNDING. Open interest and the ratios are 5-minute samples since September 2020.</div>
        </>
      )}
    </div>
  );
}

export type { RangeId };
