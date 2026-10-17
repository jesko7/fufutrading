/**
 * Options: what Binance's options market prices for BTC, ETH and SOL — the chain with prices,
 * implied volatilities and the Greeks (Δ Γ Θ ν), the volatility smile and term structure with
 * skew, open interest and dealer gamma exposure by strike (max pain, gamma flip), and a
 * position builder that nets the Greeks of several legs and draws their payoff.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp, toast } from '../../state/store';
import { useSize, useTopicValue } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { Spinner, SymbolPicker, Segmented, Tabs, Empty } from '../../components/ui';
import { clsx, fmtNum, fmtCompact, fmtSigned, fmtTime } from '../../lib/format';
import { fmtExpiry, fmtDte, pctIV, fmtPremium } from './fmt';
import type { SymbolId } from '../../../shared/symbols';
import { byStrike, constantMaturityVol, exposureByStrike, expirySummaries, forwardOf, gammaFlip, marketFigures, maxPain, smile, yearsTo, type ExpirySummary, type OptionLeg, type OptionRow, type OptionsSnapshot } from '../../../shared/options';
import { XYLines, StrikeBars, Legend, type LineSeries } from './charts';
import { Builder } from './builder';
import './options.css';

export type OptTab = 'chain' | 'smile' | 'exposure' | 'builder';

export interface OptionsCfg {
  symbol?: SymbolId;
  tab?: OptTab;
  /** Selected expiry (ms). */
  expiry?: number | null;
  cols?: 'prices' | 'greeks' | 'activity';
  /** Strike range around the index for charts, in %. */
  range?: number;
  /** Exposure over the selected expiry or all of them. */
  scope?: 'expiry' | 'all';
  /** Smile: expiries switched off in the legend. */
  hidden?: number[];
  /** Position builder legs per underlying. */
  legs?: Partial<Record<SymbolId, OptionLeg[]>>;
  /** Builder scenario: days forward and volatility shift (points). */
  days?: number;
  dIv?: number;
}

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
const DAY = 86400000;

const signedPts = (v: number, d = 1): string => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(d)}` : '—');
const fmtStrike = (v: number): string => (v >= 10000 ? `${fmtNum(v / 1000, v % 1000 ? 1 : 0)}K` : fmtNum(v, v % 1 ? 1 : 0));
const fmtGreek = (v: number, kind: 'delta' | 'gamma' | 'theta' | 'vega'): string => {
  if (!Number.isFinite(v)) return '—';
  if (kind === 'delta') return v.toFixed(2);
  if (kind === 'gamma') return v === 0 ? '0' : Math.abs(v) >= 0.01 ? v.toFixed(3) : String(+v.toPrecision(2));
  return fmtNum(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 1 : 2);
};

/** Days to an expiry from the data's time. */
const dteOf = (s: OptionsSnapshot, e: number) => (e - s.t) / DAY;

function Tile({ label, value, sub, tip }: { label: string; value: ReactNode; sub?: ReactNode; tip?: string }) {
  return (
    <div className="ot-tile" data-tip={tip}>
      <div className="ot-label">{label}</div>
      <div className="ot-value">{value}</div>
      {sub && <div className="ot-sub">{sub}</div>}
    </div>
  );
}

function Summary({ s, sums, expiry, compact }: { s: OptionsSnapshot; sums: ExpirySummary[]; expiry: number; compact?: boolean }) {
  const { iv30, skew30: rr30, callOI: calls, putOI: puts } = marketFigures(s, sums);
  const ex = useMemo(() => exposureByStrike(s.rows, s.index), [s]);
  const gex = ex.reduce((a, e) => a + (Number.isFinite(e.gex) ? e.gex : 0), 0);
  const flip = useMemo(() => gammaFlip(s.rows, s.index, s.rf, s.t), [s]);
  const sel = sums.find((e) => e.expiry === expiry);
  return (
    <div className={clsx('ot-tiles', compact && 'compact')}>
      <Tile label="Index" value={fmtNum(s.index, s.index >= 1000 ? 0 : 2)} sub={`${s.base} options settle against it`} tip="Binance's options index (a basket of spot prices); prices and Greeks are computed on it" />
      <Tile label="IV 30 days" value={pctIV(iv30)} sub={Number.isFinite(iv30) ? `±${(iv30 * Math.sqrt(30 / 365) * 100).toFixed(1)}% expected move` : undefined} tip="At-the-money implied volatility for 30 days, interpolated in total variance between the expiries around it (like a volatility index). The expected move is one standard deviation." />
      <Tile label="Skew 25Δ" value={Number.isFinite(rr30) ? `${signedPts(rr30)} pts` : '—'} sub={Number.isFinite(rr30) ? (rr30 < -0.005 ? 'puts richer' : rr30 > 0.005 ? 'calls richer' : 'balanced') : undefined} tip="25-delta risk reversal at 30 days: implied volatility of the 25-delta call minus that of the 25-delta put. Below zero, downside protection is in demand; above zero, upside calls are." />
      <Tile label="Put / call OI" value={Number.isFinite(puts / calls) ? (puts / calls).toFixed(2) : '—'} sub={`$${fmtCompact((calls + puts) * s.index)} open interest`} tip="Open interest of all puts divided by that of all calls (contracts)" />
      <Tile label="Max pain" value={sel && Number.isFinite(sel.maxPain) ? fmtNum(sel.maxPain, 0) : '—'} sub={sel ? `${fmtExpiry(sel.expiry)} · ${fmtDte(sel.t * 365)}` : undefined} tip="Settlement price at which the options of the selected expiry pay their holders the least" />
      <Tile
        label="Dealer gamma"
        value={`${gex >= 0 ? '+' : '−'}$${fmtCompact(Math.abs(gex))}`}
        sub={Number.isFinite(flip) ? `per 1% · flips at ${fmtNum(flip, 0)}` : 'per 1% move'}
        tip="Gamma exposure of option dealers in USDT per 1% move, assuming they are long the calls and short the puts others trade. Positive: their hedging damps moves; negative: it amplifies them. The flip is the index level where it changes sign."
      />
    </div>
  );
}

function ExpiryChips({ s, sums, value, onChange, extra, hidden, onToggle }: { s: OptionsSnapshot; sums: ExpirySummary[]; value: number | null; onChange: (e: number) => void; extra?: ReactNode; hidden?: Set<number>; onToggle?: (e: number) => void }) {
  return (
    <div className="ot-chips" role="tablist">
      {extra}
      {sums.map((e) => {
        const d = dteOf(s, e.expiry);
        return (
          <button
            key={e.expiry}
            className={clsx('ot-chip', value === e.expiry && 'on', hidden?.has(e.expiry) && 'off')}
            onClick={() => (onToggle ? onToggle(e.expiry) : onChange(e.expiry))}
            data-tip={`ATM IV ${pctIV(e.atm)} · expected move ±${Number.isFinite(e.atm) ? (e.atm * Math.sqrt(e.t) * 100).toFixed(1) : '—'}% · ${fmtCompact(e.callOI + e.putOI)} ${s.base} open interest`}
          >
            <span>{fmtExpiry(e.expiry)}</span>
            <span className="faint">{fmtDte(d)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ chain

type Col = { key: string; label: string; tip: string; cell: (r: OptionRow | undefined, side: 'C' | 'P') => ReactNode; act?: 'buy' | 'sell' | 'mark' };

function columns(mode: 'prices' | 'greeks' | 'activity'): Col[] {
  const v = (r: OptionRow | undefined, f: (r: OptionRow) => ReactNode) => (r ? f(r) : '');
  if (mode === 'greeks')
    return [
      { key: 'delta', label: 'Δ', tip: 'Delta: change of the option price per 1 USDT move of the index (per contract of 1 coin)', cell: (r) => v(r, (x) => fmtGreek(x.delta, 'delta')) },
      { key: 'gamma', label: 'Γ', tip: 'Gamma: change of delta per 1 USDT move of the index', cell: (r) => v(r, (x) => fmtGreek(x.gamma, 'gamma')) },
      { key: 'theta', label: 'Θ', tip: 'Theta: change of the option price per day (time decay, USDT)', cell: (r) => v(r, (x) => fmtGreek(x.theta, 'theta')) },
      { key: 'vega', label: 'ν', tip: 'Vega: change of the option price per volatility point (USDT)', cell: (r) => v(r, (x) => fmtGreek(x.vega, 'vega')) },
    ];
  if (mode === 'activity')
    return [
      { key: 'oi', label: 'OI', tip: 'Open interest (contracts)', cell: (r) => v(r, (x) => (Number.isFinite(x.oi) ? fmtNum(x.oi, 2) : '—')) },
      { key: 'vol', label: 'Volume', tip: 'Contracts traded in 24 hours', cell: (r) => v(r, (x) => (x.volume ? fmtNum(x.volume, 2) : '')) },
      { key: 'chg', label: '24h', tip: 'Price change over 24 hours (of the last trade)', cell: (r) => v(r, (x) => (Number.isFinite(x.changePct) && x.volume ? <span className={x.changePct >= 0 ? 'up' : 'down'}>{`${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}%`}</span> : '')) },
    ];
  return [
    { key: 'iv', label: 'IV', tip: 'Mark implied volatility (bid / ask volatility on hover)', cell: (r) => v(r, (x) => <span data-tip={`bid ${pctIV(x.bidIV)} · ask ${pctIV(x.askIV)}`}>{pctIV(x.markIV)}</span>) },
    { key: 'bid', label: 'Bid', tip: 'Best bid (click: sell one contract in the position builder)', cell: (r) => v(r, (x) => fmtPremium(x.bid)), act: 'sell' },
    { key: 'mark', label: 'Mark', tip: "Binance's mark price (click: buy one contract at the mark)", cell: (r) => v(r, (x) => fmtPremium(x.mark)), act: 'mark' },
    { key: 'ask', label: 'Ask', tip: 'Best ask (click: buy one contract in the position builder)', cell: (r) => v(r, (x) => fmtPremium(x.ask)), act: 'buy' },
  ];
}

function Chain({ s, expiry, mode, onAdd }: { s: OptionsSnapshot; expiry: number; mode: 'prices' | 'greeks' | 'activity'; onAdd: (r: OptionRow, act: 'buy' | 'sell' | 'mark') => void }) {
  const rows = useMemo(() => s.rows.filter((r) => r.expiry === expiry), [s, expiry]);
  const strikes = useMemo(() => byStrike(rows), [rows]);
  const cols = columns(mode);
  const S = s.index;
  const wrap = useRef<HTMLDivElement>(null);
  const atm = strikes.length ? strikes.reduce((a, b) => (Math.abs(b.strike - S) < Math.abs(a.strike - S) ? b : a)).strike : NaN;
  // keep the money in view when the expiry changes
  useEffect(() => {
    const el = wrap.current?.querySelector('.oc-index');
    if (el && wrap.current) wrap.current.scrollTop = Math.max(0, (el as HTMLElement).offsetTop - wrap.current.clientHeight / 2);
  }, [expiry, mode]);
  const cell = (c: Col, r: OptionRow | undefined, side: 'C' | 'P', itm: boolean) => {
    const content = c.cell(r, side);
    const click = c.act && r && (c.act === 'mark' ? r.mark > 0 : c.act === 'buy' ? r.ask > 0 : r.bid > 0);
    return (
      <td key={`${side}${c.key}`} className={clsx('num', itm && 'itm', click && 'act', c.act)} onClick={click ? () => onAdd(r!, c.act!) : undefined}>
        {content}
      </td>
    );
  };
  let indexShown = false;
  return (
    <div className="oc-wrap" ref={wrap}>
      <table className="oc-table">
        <thead>
          <tr className="oc-sides">
            <th colSpan={cols.length} className="calls">
              Calls
            </th>
            <th />
            <th colSpan={cols.length} className="puts">
              Puts
            </th>
          </tr>
          <tr>
            {[...cols].reverse().map((c) => (
              <th key={`hc${c.key}`} data-tip={c.tip}>
                {c.label}
              </th>
            ))}
            <th className="oc-strike">Strike</th>
            {cols.map((c) => (
              <th key={`hp${c.key}`} data-tip={c.tip}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strikes.map((e) => {
            const sep = !indexShown && e.strike > S;
            if (sep) indexShown = true;
            return [
              sep ? (
                <tr key="index" className="oc-index">
                  <td colSpan={cols.length * 2 + 1}>
                    <span>
                      {s.base} {fmtNum(S, S >= 1000 ? 0 : 2)}
                    </span>
                  </td>
                </tr>
              ) : null,
              <tr key={e.strike} className={clsx(e.strike === atm && 'atm')}>
                {[...cols].reverse().map((c) => cell(c, e.C, 'C', e.strike < S))}
                <td className="oc-strike">{fmtNum(e.strike, e.strike % 1 ? 1 : 0)}</td>
                {cols.map((c) => cell(c, e.P, 'P', e.strike > S))}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ smile & term structure

/** One-hue sequential ramp (blue 100 → 700); dark mode anchors low values at the dark end. */
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const rampColor = (t: number, dark: boolean): string => {
  const k = Math.round(Math.max(0, Math.min(1, t)) * (RAMP.length - 1));
  return RAMP[dark ? RAMP.length - 1 - k : k];
};
/** Ink or white, whichever reads on the cell. */
const inkOn = (hex: string): string => {
  const c = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5) > 0.36 ? '#0b0b0b' : '#ffffff';
};
const MONEYNESS = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3];

/** Implied volatility by moneyness (strike ÷ forward) and expiry, interpolated along each smile. */
function VolSurface({ s, sums }: { s: OptionsSnapshot; sums: ExpirySummary[] }) {
  const dark = document.documentElement.dataset.theme !== 'light';
  const rows = sums
    .filter((e) => e.t * 365 >= 0.5)
    .slice(0, 10)
    .map((e) => {
      const sm = smile(
        s.rows.filter((r) => r.expiry === e.expiry),
        s.index,
        s.rf,
        s.t,
      );
      const F = forwardOf(s.index, s.rf, e.t);
      const at = (K: number) => {
        if (sm.length < 2 || K < sm[0].strike || K > sm[sm.length - 1].strike) return NaN;
        for (let k = 1; k < sm.length; k++) if (K <= sm[k].strike) return sm[k - 1].iv + ((sm[k].iv - sm[k - 1].iv) * (K - sm[k - 1].strike)) / (sm[k].strike - sm[k - 1].strike);
        return NaN;
      };
      return { e, F, cells: MONEYNESS.map((m) => at(F * m)) };
    });
  const vals = rows.flatMap((r) => r.cells).filter(Number.isFinite);
  if (!vals.length) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return (
    <div className="ot-card">
      <div className="ot-card-head">
        <b>Volatility surface</b>
        <span className="faint">
          Implied volatility by strike as a share of the forward price (columns) and expiry (rows); darker is {dark ? 'lower' : 'higher'}. Range {pctIV(lo, 0)} – {pctIV(hi, 0)}.
        </span>
      </div>
      <div className="ot-scroll-x">
        <table className="ot-surface">
          <thead>
            <tr>
              <th />
              {MONEYNESS.map((m) => (
                <th key={m} className={clsx(m === 1 && 'atm')}>
                  {m === 1 ? 'ATM' : `${Math.round(m * 100)}%`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.e.expiry}>
                <th>
                  {fmtExpiry(r.e.expiry)} <span className="faint">{fmtDte(r.e.t * 365)}</span>
                </th>
                {r.cells.map((v, k) => {
                  if (!Number.isFinite(v)) return <td key={k} className="blank" />;
                  const bg = rampColor(hi > lo ? (v - lo) / (hi - lo) : 0.5, dark);
                  return (
                    <td key={k} style={{ background: bg, color: inkOn(bg) }} data-tip={`${fmtExpiry(r.e.expiry)} · strike ${fmtNum(r.F * MONEYNESS[k], 0)} (${Math.round(MONEYNESS[k] * 100)}% of the forward) · IV ${pctIV(v)}`}>
                      {(v * 100).toFixed(0)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SmileView({ s, sums, expiry, range, hidden, setHidden }: { s: OptionsSnapshot; sums: ExpirySummary[]; expiry: number; range: number; hidden: Set<number>; setHidden: (h: number[]) => void }) {
  // the nearest expiries with more than a day left, the selected one always
  const shown = sums.filter((e) => e.t * 365 >= 1 || e.expiry === expiry).slice(0, SERIES.length);
  if (!shown.some((e) => e.expiry === expiry)) {
    const sel = sums.find((e) => e.expiry === expiry);
    if (sel) shown.splice(shown.length - 1, 1, sel);
  }
  const color = (e: number) => SERIES[shown.findIndex((x) => x.expiry === e) % SERIES.length];
  const series: LineSeries[] = shown
    .filter((e) => !hidden.has(e.expiry))
    .map((e) => {
      const sm = smile(
        s.rows.filter((r) => r.expiry === e.expiry),
        s.index,
        s.rf,
        s.t,
      );
      return {
        id: String(e.expiry),
        label: `${fmtExpiry(e.expiry)} · ${fmtDte(e.t * 365)}`,
        color: color(e.expiry),
        points: sm.map((p) => [p.strike, p.iv] as [number, number]),
        band: e.expiry === expiry ? sm.map((p) => [p.strike, p.bid, p.ask] as [number, number, number]) : undefined,
      };
    });
  const lo = s.index * (1 - range / 100);
  const hi = s.index * (1 + range / 100);
  const term: LineSeries[] = [{ id: 'atm', label: 'ATM volatility', color: 'var(--s1)', dots: true, points: sums.filter((e) => e.t * 365 >= 0.5).map((e) => [e.t * 365, e.atm] as [number, number]) }];
  const iv30 = constantMaturityVol(sums.map((e) => ({ t: e.t, iv: e.atm })), 30);
  const legendItems = shown.map((e) => ({ id: String(e.expiry), label: `${fmtExpiry(e.expiry)} · ${fmtDte(e.t * 365)}`, color: color(e.expiry) }));
  const toggle = (id: string) => {
    const e = +id;
    setHidden(hidden.has(e) ? [...hidden].filter((x) => x !== e) : [...hidden, e]);
  };
  return (
    <div className="ot-section">
      <div className="ot-card">
        <div className="ot-card-head">
          <b>Volatility smile</b>
          <span className="faint">Mark implied volatility by strike (out-of-the-money options); the band is bid / ask volatility of {fmtExpiry(expiry)}</span>
        </div>
        <Legend items={legendItems} onToggle={toggle} off={new Set([...hidden].map(String))} />
        <XYLines label="Implied volatility by strike per expiry" series={series} height={240} xDomain={[lo, hi]} xFmt={fmtStrike} yFmt={(v) => `${(v * 100).toFixed(0)}%`} vlines={[{ x: s.index, label: 'Index', strong: true }]} emptyText="No volatility data for these expiries" />
      </div>
      <VolSurface s={s} sums={sums} />
      <div className="ot-grid2">
        <div className="ot-card">
          <div className="ot-card-head">
            <b>Term structure</b>
            <span className="faint">ATM volatility by days to expiry · 30 days: {pctIV(iv30)}</span>
          </div>
          <XYLines label="At-the-money implied volatility by days to expiry" series={term} height={190} xFmt={(d) => `${Math.round(d)}d`} yFmt={(v) => `${(v * 100).toFixed(0)}%`} vlines={Number.isFinite(iv30) ? [{ x: 30, label: '30 days' }] : []} />
        </div>
        <div className="ot-card">
          <div className="ot-card-head">
            <b>Skew</b>
            <span className="faint">25Δ risk reversal per expiry: above 0 calls are richer, below puts</span>
          </div>
          <StrikeBars
            label="25-delta risk reversal per expiry"
            mode="diverging"
            bars={sums.filter((e) => Number.isFinite(e.rr25)).map((e) => ({ x: e.expiry, value: e.rr25 * 100 }))}
            colors={{ pos: 'var(--s1)', neg: 'var(--s8)' }}
            height={190}
            xFmt={fmtExpiry}
            yFmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
            tip={(b) => (
              <div className="ox-tip-row">
                <b>{`${fmtSigned(b.value || 0, 2)} pts`}</b>
                <span className="muted">{(b.value || 0) >= 0 ? 'calls richer' : 'puts richer'}</span>
              </div>
            )}
          />
        </div>
      </div>
      <div className="ot-card">
        <div className="ot-card-head">
          <b>By expiry</b>
        </div>
        <table className="ot-table">
          <thead>
            <tr>
              <th>Expiry</th>
              <th className="num">Days</th>
              <th className="num" data-tip="At-the-money implied volatility">
                ATM IV
              </th>
              <th className="num" data-tip="One standard deviation to expiry">
                Expected move
              </th>
              <th className="num" data-tip="25-delta call minus put volatility">
                25Δ RR
              </th>
              <th className="num" data-tip="Average of the 25-delta call and put volatility over ATM (smile curvature)">
                25Δ fly
              </th>
              <th className="num">Max pain</th>
              <th className="num">Call OI</th>
              <th className="num">Put OI</th>
            </tr>
          </thead>
          <tbody>
            {sums.map((e) => (
              <tr key={e.expiry} className={clsx(e.expiry === expiry && 'sel')}>
                <td>{fmtExpiry(e.expiry)}</td>
                <td className="num">{fmtDte(e.t * 365)}</td>
                <td className="num">{pctIV(e.atm)}</td>
                <td className="num">{Number.isFinite(e.atm) ? `±${(e.atm * Math.sqrt(e.t) * 100).toFixed(1)}%` : '—'}</td>
                <td className="num">{signedPts(e.rr25)}</td>
                <td className="num">{signedPts(e.bf25)}</td>
                <td className="num">{Number.isFinite(e.maxPain) ? fmtNum(e.maxPain, 0) : '—'}</td>
                <td className="num">{fmtNum(e.callOI, 1)}</td>
                <td className="num">{fmtNum(e.putOI, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ exposure

function ExposureView({ s, expiry, scope, range }: { s: OptionsSnapshot; expiry: number; scope: 'expiry' | 'all'; range: number }) {
  const rows = useMemo(() => (scope === 'all' ? s.rows : s.rows.filter((r) => r.expiry === expiry)), [s, scope, expiry]);
  const ex = useMemo(() => exposureByStrike(rows, s.index), [rows, s.index]);
  const mp = useMemo(() => maxPain(rows).strike, [rows]);
  const flip = useMemo(() => gammaFlip(rows, s.index, s.rf, s.t), [rows, s]);
  const lo = s.index * (1 - range / 100);
  const hi = s.index * (1 + range / 100);
  const vis = ex.filter((e) => e.strike >= lo && e.strike <= hi);
  const calls = rows.reduce((a, r) => a + (r.side === 'C' && Number.isFinite(r.oi) ? r.oi : 0), 0);
  const puts = rows.reduce((a, r) => a + (r.side === 'P' && Number.isFinite(r.oi) ? r.oi : 0), 0);
  const gex = ex.reduce((a, e) => a + (Number.isFinite(e.gex) ? e.gex : 0), 0);
  const vl = [{ x: s.index, label: 'Index', strong: true }, ...(Number.isFinite(mp) ? [{ x: mp, label: `Max pain ${fmtStrike(mp)}` }] : [])];
  return (
    <div className="ot-section">
      <div className="ot-tiles small">
        <Tile label="Call open interest" value={`${fmtNum(calls, 1)} ${s.base}`} sub={`$${fmtCompact(calls * s.index)}`} />
        <Tile label="Put open interest" value={`${fmtNum(puts, 1)} ${s.base}`} sub={`$${fmtCompact(puts * s.index)}`} />
        <Tile label="Put / call" value={calls > 0 ? (puts / calls).toFixed(2) : '—'} />
        <Tile label="Max pain" value={Number.isFinite(mp) ? fmtNum(mp, 0) : '—'} sub={scope === 'all' ? 'all expiries together' : fmtExpiry(expiry)} />
        <Tile label="Dealer gamma" value={`${gex >= 0 ? '+' : '−'}$${fmtCompact(Math.abs(gex))}`} sub={Number.isFinite(flip) ? `per 1% · flips at ${fmtNum(flip, 0)}` : 'per 1% move'} />
      </div>
      <div className="ot-card">
        <div className="ot-card-head">
          <b>Open interest by strike</b>
          <span className="faint">Calls above the line, puts below (contracts)</span>
        </div>
        <Legend
          items={[
            { id: 'c', label: 'Calls', color: 'var(--up)' },
            { id: 'p', label: 'Puts', color: 'var(--down)' },
          ]}
        />
        <StrikeBars
          label="Open interest of calls and puts by strike"
          mode="mirror"
          bars={vis.map((e) => ({ x: e.strike, up: e.callOI, down: e.putOI }))}
          colors={{ pos: 'var(--up)', neg: 'var(--down)' }}
          height={220}
          xFmt={fmtStrike}
          yFmt={(v) => fmtCompact(Math.abs(v))}
          vlines={vl}
          tip={(b) => (
            <>
              <div className="ox-tip-row">
                <span className="ox-line" style={{ background: 'var(--up)' }} />
                <b>{fmtNum(b.up || 0, 2)}</b>
                <span className="muted">calls · ${fmtCompact((b.up || 0) * s.index)}</span>
              </div>
              <div className="ox-tip-row">
                <span className="ox-line" style={{ background: 'var(--down)' }} />
                <b>{fmtNum(b.down || 0, 2)}</b>
                <span className="muted">puts · ${fmtCompact((b.down || 0) * s.index)}</span>
              </div>
            </>
          )}
        />
      </div>
      <div className="ot-card">
        <div className="ot-card-head">
          <b>Dealer gamma by strike</b>
          <span className="faint">USDT per 1% move, assuming dealers are long calls and short puts{Number.isFinite(flip) ? ` · gamma flips at ${fmtNum(flip, 0)}` : ''}</span>
        </div>
        <StrikeBars
          label="Dealer gamma exposure by strike"
          mode="diverging"
          bars={vis.map((e) => ({ x: e.strike, value: e.gex }))}
          colors={{ pos: 'var(--s1)', neg: 'var(--s8)' }}
          height={200}
          xFmt={fmtStrike}
          yFmt={(v) => `${v < 0 ? '−' : ''}${fmtCompact(Math.abs(v))}`}
          vlines={[{ x: s.index, label: 'Index', strong: true }, ...(Number.isFinite(flip) ? [{ x: flip, label: 'Flip' }] : [])]}
          tip={(b) => (
            <div className="ox-tip-row">
              <b>{`${(b.value || 0) >= 0 ? '+' : '−'}$${fmtCompact(Math.abs(b.value || 0))}`}</b>
              <span className="muted">{(b.value || 0) >= 0 ? 'damping' : 'amplifying'} per 1%</span>
            </div>
          )}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ module

export function OptionsModule({ module }: ModuleProps) {
  const cfg = module.config as OptionsCfg;
  const symbol: SymbolId = cfg.symbol || 'BTCUSDT';
  const tab: OptTab = cfg.tab || 'chain';
  const set = (p: Partial<OptionsCfg>) => useApp.getState().setModuleConfig(module.id, p);
  const s = useTopicValue<OptionsSnapshot>('options', { underlying: symbol }, [symbol]);
  // short panes: the summary becomes one row so the chain stays in view
  const [rootRef, size] = useSize<HTMLDivElement>();
  const compact = size.height > 0 && size.height < 560;
  const sums = useMemo(() => (s && s.rows.length ? expirySummaries(s) : []), [s]);
  // default: the first expiry with at least a day left
  const expiry = s && cfg.expiry && s.expiries.includes(cfg.expiry) ? cfg.expiry : (sums.find((e) => e.t * 365 >= 1) || sums[0])?.expiry ?? null;
  const legs = cfg.legs?.[symbol] || [];
  const setLegs = (l: OptionLeg[]) => set({ legs: { ...(cfg.legs || {}), [symbol]: l } });
  const range = cfg.range || 30;
  const add = (r: OptionRow, act: 'buy' | 'sell' | 'mark') => {
    const price = act === 'buy' ? r.ask : act === 'sell' ? r.bid : r.mark;
    const leg: OptionLeg = { id: `${r.symbol}-${Date.now()}`, kind: 'option', symbol: r.symbol, side: r.side, strike: r.strike, expiry: r.expiry, qty: act === 'sell' ? -1 : 1, price, iv: r.markIV };
    setLegs([...legs, leg]);
    toast({ title: `${act === 'sell' ? 'Sell' : 'Buy'} 1 ${r.symbol}`, body: `at ${fmtPremium(price)} USDT — added to the position builder (${legs.length + 1} leg${legs.length ? 's' : ''})`, kind: 'ok' });
  };
  return (
    <div className="opt-mod" ref={rootRef}>
      <HeadControls>
        <SymbolPicker symbol={symbol} market="spot" showMarket={false} markets={['spot']} onChange={(x) => set({ symbol: x, expiry: null })} />
        <button className="icon-btn" onClick={() => void import('../alerts/editor').then((m) => m.openAlertEditor({ kind: 'options', symbol, market: 'spot' }))} data-tip="New options alert: implied volatility, skew, put/call or the index crossing the gamma flip, max pain or a wall">
          <Icon name="bell" size={15} />
        </button>
        <div className="spacer" />
        {s && !s.error && <span className="faint small">{`Binance options · ${fmtTime(s.t, true)}`}</span>}
      </HeadControls>
      {!s ? (
        <div className="empty">
          <Spinner /> Loading options…
        </div>
      ) : !s.rows.length ? (
        s.error ? (
          <Empty icon="alert" title="Options data unavailable">
            {s.error}
          </Empty>
        ) : (
          <div className="empty">
            <Spinner /> Loading the {s.base} option chain…
          </div>
        )
      ) : (
        <div className="opt-body">
          {s.error && <div className="callout warn">{s.error} — showing the last data.</div>}
          <Summary s={s} sums={sums} expiry={expiry!} compact={compact} />
          <Tabs
            value={tab}
            onChange={(t) => set({ tab: t })}
            tabs={[
              { value: 'chain', label: 'Chain' },
              { value: 'smile', label: 'Smile & term' },
              { value: 'exposure', label: 'Exposure' },
              { value: 'builder', label: 'Builder', badge: legs.length ? <span className="badge">{legs.length}</span> : undefined },
            ]}
          />
          <div className="ot-filters">
            {tab === 'exposure' ? (
              <ExpiryChips
                s={s}
                sums={sums}
                value={cfg.scope === 'all' ? null : expiry}
                onChange={(e) => set({ expiry: e, scope: 'expiry' })}
                extra={
                  <button className={clsx('ot-chip', cfg.scope === 'all' && 'on')} onClick={() => set({ scope: 'all' })}>
                    <span>All</span>
                    <span className="faint">expiries</span>
                  </button>
                }
              />
            ) : (
              <ExpiryChips s={s} sums={sums} value={expiry} onChange={(e) => set({ expiry: e })} />
            )}
            <div className="ot-filter-row">
              {tab === 'chain' && (
                <Segmented
                  size="sm"
                  value={cfg.cols || 'prices'}
                  onChange={(v) => set({ cols: v })}
                  options={[
                    { value: 'prices', label: 'Prices' },
                    { value: 'greeks', label: 'Greeks' },
                    { value: 'activity', label: 'Activity' },
                  ]}
                />
              )}
              {(tab === 'smile' || tab === 'exposure') && (
                <Segmented size="sm" value={range} onChange={(v) => set({ range: v })} options={[10, 20, 30, 50].map((v) => ({ value: v, label: `±${v}%`, title: `Strikes within ${v}% of the index` }))} />
              )}
              {tab === 'chain' && (
                <span className="faint small">
                  <Icon name="info" size={12} /> Click a bid, mark or ask to add the option to the builder
                </span>
              )}
            </div>
          </div>
          {expiry !== null && tab === 'chain' && <Chain s={s} expiry={expiry} mode={cfg.cols || 'prices'} onAdd={add} />}
          {expiry !== null && tab === 'smile' && <SmileView s={s} sums={sums} expiry={expiry} range={range} hidden={new Set(cfg.hidden || [])} setHidden={(h) => set({ hidden: h })} />}
          {expiry !== null && tab === 'exposure' && <ExposureView s={s} expiry={expiry} scope={cfg.scope || 'expiry'} range={range} />}
          {expiry !== null && tab === 'builder' && <Builder s={s} expiry={expiry} legs={legs} setLegs={setLegs} days={cfg.days ?? 0} dIv={cfg.dIv ?? 0} setScenario={(p) => set(p)} />}
          <div className="faint small ot-foot">{`${s.rows.length} ${s.base} options · ${s.expiries.length} expiries · rate ${(s.rf * 100).toFixed(1)}% · ${yearsTo(s.expiries[s.expiries.length - 1], s.t) > 0 ? `to ${fmtExpiry(s.expiries[s.expiries.length - 1])}` : ''}`}</div>
        </div>
      )}
    </div>
  );
}
