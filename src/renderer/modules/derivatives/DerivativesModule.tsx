/**
 * Derivatives: what the futures market is doing around a coin — open interest, funding (now,
 * history, annualised), long/short ratios, taker buy/sell pressure and live liquidations.
 */
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { useNow, useTopicValue } from '../../lib/hooks';
import { serverNow } from '../../lib/clock';
import { Icon, CoinIcon } from '../../components/Icon';
import { Spinner, SymbolPicker } from '../../components/ui';
import { clsx, fmtCompact, fmtNum, fmtPct, fmtTime, fmtDuration } from '../../lib/format';
import { SYMBOL_SPECS, priceDecimals, type SymbolId } from '../../../shared/symbols';
import type { DerivativesSnapshot } from '../../../shared/derivatives';
import './derivatives.css';

function Spark({ points, color = 'var(--accent)', height = 34, zero }: { points: [number, number][]; color?: string; height?: number; zero?: number }) {
  if (points.length < 2) return <div className="spark" style={{ height }} />;
  const W = 200;
  const ys = points.map((p) => p[1]).filter(Number.isFinite);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (zero !== undefined) {
    lo = Math.min(lo, zero);
    hi = Math.max(hi, zero);
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0] || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
  const d = points.filter((p) => Number.isFinite(p[1])).map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }}>
      {zero !== undefined && <line x1={0} x2={W} y1={y(zero)} y2={y(zero)} className="spark-zero" />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FundingBars({ history }: { history: { t: number; rate: number }[] }) {
  const last = history.slice(-21);
  if (!last.length) return null;
  const max = Math.max(...last.map((h) => Math.abs(h.rate)), 1e-6);
  return (
    <div className="funding-bars" data-tip="Funding of the last 21 periods (7 days). Positive: longs pay shorts.">
      {last.map((h) => (
        <span key={h.t} className={clsx('fb', h.rate >= 0 ? 'pos' : 'neg')} style={{ height: `${Math.max(4, (Math.abs(h.rate) / max) * 100)}%` }} title={`${fmtTime(h.t)} ${(h.rate * 100).toFixed(4)}%`} />
      ))}
    </div>
  );
}

function SplitBar({ a, b, la, lb }: { a: number; b: number; la: string; lb: string }) {
  const total = a + b;
  const pa = total > 0 ? (a / total) * 100 : 50;
  return (
    <div className="split">
      <div className={clsx('split-bar', !(total > 0) && 'empty')}>
        <span className="up-bg" style={{ width: `${pa}%` }} />
        <span className="down-bg" style={{ width: `${100 - pa}%` }} />
      </div>
      <div className="split-legend">
        <span className="up">{la}</span>
        <span className="down">{lb}</span>
      </div>
    </div>
  );
}

const pctStr = (v: number, d = 2) => (Number.isFinite(v) ? fmtPct(v, d) : '—');

export function DerivativesModule({ module }: ModuleProps) {
  const cfg = module.config as { symbol?: SymbolId };
  const symbol: SymbolId = cfg.symbol || 'BTCUSDT';
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const d = useTopicValue<DerivativesSnapshot>('derivatives', { symbol }, [symbol]);
  useNow(1000);
  const base = SYMBOL_SPECS[symbol].base;
  const pd = priceDecimals(symbol, 'futures');
  return (
    <div className="mod-scroll deriv">
      <HeadControls>
        <SymbolPicker symbol={symbol} market="futures" onChange={(s) => set({ symbol: s })} />
        <div className="spacer" />
        <span className="faint small">Binance USDⓈ-M perpetual</span>
      </HeadControls>
      {!d ? (
        <div className="empty">
          <Spinner /> Loading futures data…
        </div>
      ) : (
        <>
          <div className="deriv-grid">
            <div className="deriv-card">
              <div className="dc-head">
                <Icon name="layers" size={13} /> Open interest
              </div>
              {d.openInterest ? (
                <>
                  <div className="dc-value">${fmtCompact(d.openInterest.value)}</div>
                  <div className="dc-sub">
                    {fmtNum(d.openInterest.qty, 0)} {base} · <span className={clsx(d.openInterest.change1hPct >= 0 ? 'up' : 'down')}>{pctStr(d.openInterest.change1hPct)} 1h</span> · <span className={clsx(d.openInterest.change24hPct >= 0 ? 'up' : 'down')}>{pctStr(d.openInterest.change24hPct)} 24h</span>
                  </div>
                  <Spark points={d.openInterest.history} />
                </>
              ) : (
                <Spinner />
              )}
            </div>
            <div className="deriv-card">
              <div className="dc-head">
                <Icon name="history" size={13} /> Funding
              </div>
              {d.funding ? (
                <>
                  <div className={clsx('dc-value', d.funding.rate > 0 ? 'down' : d.funding.rate < 0 ? 'up' : '')}>{(d.funding.rate * 100).toFixed(4)}%</div>
                  <div className="dc-sub">
                    next in {fmtDuration(Math.max(0, d.funding.next - serverNow()))} · 7-day avg {Number.isFinite(d.funding7dAnnualPct) ? `${d.funding7dAnnualPct.toFixed(1)}% / yr` : '—'}
                  </div>
                  <FundingBars history={d.fundingHistory} />
                </>
              ) : (
                <Spinner />
              )}
            </div>
            <div className="deriv-card">
              <div className="dc-head">
                <Icon name="user" size={13} /> Long / short accounts
              </div>
              {d.longShort ? (
                <>
                  <div className="dc-value">{d.longShort.ratio.toFixed(2)}</div>
                  <SplitBar a={d.longShort.long} b={d.longShort.short} la={`${(d.longShort.long * 100).toFixed(1)}% long`} lb={`${(d.longShort.short * 100).toFixed(1)}% short`} />
                  <div className="dc-sub">Top traders' positions: {Number.isFinite(d.longShort.topLong) ? `${(d.longShort.topLong * 100).toFixed(1)}% long (ratio ${d.longShort.topRatio.toFixed(2)})` : '—'}</div>
                  <Spark points={d.longShort.history} color="var(--text-3)" height={26} zero={1} />
                </>
              ) : (
                <Spinner />
              )}
            </div>
            <div className="deriv-card">
              <div className="dc-head">
                <Icon name="trend" size={13} /> Taker buy / sell
              </div>
              {d.taker ? (
                <>
                  <div className={clsx('dc-value', d.taker.ratio >= 1 ? 'up' : 'down')}>{d.taker.ratio.toFixed(2)}</div>
                  <SplitBar a={d.taker.buy1h} b={d.taker.sell1h} la={`buy ${fmtCompact(d.taker.buy1h)} ${base}`} lb={`sell ${fmtCompact(d.taker.sell1h)} ${base}`} />
                  <div className="dc-sub">Market orders over the last hour; ratio of the last 5 minutes</div>
                  <Spark points={d.taker.history} color="var(--text-3)" height={26} zero={1} />
                </>
              ) : (
                <Spinner />
              )}
            </div>
          </div>
          <div className="deriv-card liq">
            <div className="dc-head">
              <Icon name="zap" size={13} /> Liquidations
              <span className="spacer" />
              <span className="faint small" data-tip="Binance streams at most one liquidation per symbol and second (the largest), so totals are lower bounds">
                since {fmtTime(d.liquidations.since)}
              </span>
            </div>
            <div className="liq-totals">
              <div>
                <span className="faint small">Last hour</span>
                <SplitBar a={d.liquidations.long1h} b={d.liquidations.short1h} la={`longs $${fmtCompact(d.liquidations.long1h)}`} lb={`shorts $${fmtCompact(d.liquidations.short1h)}`} />
              </div>
              <div>
                <span className="faint small">24 hours</span>
                <SplitBar a={d.liquidations.long24h} b={d.liquidations.short24h} la={`longs $${fmtCompact(d.liquidations.long24h)}`} lb={`shorts $${fmtCompact(d.liquidations.short24h)}`} />
              </div>
            </div>
            <div className="liq-list">
              {!d.liquidations.recent.length && <div className="faint small" style={{ padding: '6px 2px' }}>No liquidations yet. They appear here as they happen.</div>}
              {d.liquidations.recent.map((e, k) => (
                <div key={`${e.t}-${k}`} className={clsx('liq-row', e.notional >= 250000 && 'big')}>
                  <span className="faint num">{fmtTime(e.t, true)}</span>
                  <CoinIcon symbol={symbol} size={12} />
                  <span className={e.side === 'long' ? 'down' : 'up'}>{e.side === 'long' ? 'Long liquidated' : 'Short liquidated'}</span>
                  <span className="num">{fmtNum(e.price, pd)}</span>
                  <b className="num">${fmtCompact(e.notional)}</b>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
