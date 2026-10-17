/**
 * Position builder: option legs (and the underlying) with live marks, the position's net Greeks
 * and its payoff at the first expiry and on a chosen date with a volatility shift.
 */
import { useMemo } from 'react';
import { Icon } from '../../components/Icon';
import { Menu, NumberField, usePopover } from '../../components/ui';
import { clsx, fmtNum, fmtCompact } from '../../lib/format';
import { atmVol, breakEvens, positionGreeks, positionPnl, probabilityOfProfit, type OptionLeg, type OptionRow, type OptionsSnapshot } from '../../../shared/options';
import { XYLines, Legend, type LineSeries } from './charts';
import { fmtExpiry, fmtDte, fmtPremium, pctIV } from './fmt';

const DAY = 86400000;

type Preset = { id: string; label: string; hint: string; build: (rows: OptionRow[], S: number) => { row?: OptionRow; qty: number; under?: boolean }[] | null };

/** The listed strike closest to `x` that has both a call and a put (or either). */
function near(rows: OptionRow[], x: number, side: 'C' | 'P'): OptionRow | undefined {
  let best: OptionRow | undefined;
  for (const r of rows) if (r.side === side && r.mark > 0 && (!best || Math.abs(r.strike - x) < Math.abs(best.strike - x))) best = r;
  return best;
}

const PRESETS: Preset[] = [
  { id: 'call', label: 'Long call', hint: 'buy the ATM call', build: (r, S) => [{ row: near(r, S, 'C'), qty: 1 }] },
  { id: 'put', label: 'Long put', hint: 'buy the ATM put', build: (r, S) => [{ row: near(r, S, 'P'), qty: 1 }] },
  { id: 'straddle', label: 'Long straddle', hint: 'buy the ATM call and put: a bet on a big move', build: (r, S) => [{ row: near(r, S, 'C'), qty: 1 }, { row: near(r, S, 'P'), qty: 1 }] },
  { id: 'strangle', label: 'Short strangle', hint: 'sell a call 7% above and a put 7% below: earns time decay while the price stays in the range', build: (r, S) => [{ row: near(r, S * 1.07, 'C'), qty: -1 }, { row: near(r, S * 0.93, 'P'), qty: -1 }] },
  { id: 'bullcall', label: 'Bull call spread', hint: 'buy the ATM call, sell one 8% higher', build: (r, S) => [{ row: near(r, S, 'C'), qty: 1 }, { row: near(r, S * 1.08, 'C'), qty: -1 }] },
  { id: 'bearput', label: 'Bear put spread', hint: 'buy the ATM put, sell one 8% lower', build: (r, S) => [{ row: near(r, S, 'P'), qty: 1 }, { row: near(r, S * 0.92, 'P'), qty: -1 }] },
  {
    id: 'condor',
    label: 'Iron condor',
    hint: 'sell a strangle at ±6%, buy wings at ±12%: capped risk',
    build: (r, S) => [
      { row: near(r, S * 0.88, 'P'), qty: 1 },
      { row: near(r, S * 0.94, 'P'), qty: -1 },
      { row: near(r, S * 1.06, 'C'), qty: -1 },
      { row: near(r, S * 1.12, 'C'), qty: 1 },
    ],
  },
  { id: 'covered', label: 'Covered call', hint: 'hold the coin and sell a call 8% above', build: (r, S) => [{ qty: 1, under: true }, { row: near(r, S * 1.08, 'C'), qty: -1 }] },
  { id: 'protective', label: 'Protective put', hint: 'hold the coin and buy a put 5% below', build: (r, S) => [{ qty: 1, under: true }, { row: near(r, S * 0.95, 'P'), qty: 1 }] },
];

function Stat({ label, value, sub, tip, tone }: { label: string; value: string; sub?: string; tip?: string; tone?: number }) {
  return (
    <div className="ot-tile" data-tip={tip}>
      <div className="ot-label">{label}</div>
      <div className={clsx('ot-value', tone !== undefined && Number.isFinite(tone) && (tone > 0 ? 'up' : tone < 0 ? 'down' : ''))}>{value}</div>
      {sub && <div className="ot-sub">{sub}</div>}
    </div>
  );
}

const usd = (v: number, d = 0) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}$${fmtNum(Math.abs(v), d)}` : '—');

/** P&L of the position for index moves (rows) on a few dates (columns): today, halfway and at the first expiry. */
function RiskMatrix({ legs, S, t0, first, r, dv }: { legs: OptionLeg[]; S: number; t0: number; first: number; r: number; dv: number }) {
  const moves = [-0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15];
  const dates: { label: string; at: number }[] = [{ label: 'Today', at: t0 }];
  if (Number.isFinite(first) && first > t0) {
    const half = t0 + (first - t0) / 2;
    if (first - t0 > 2 * DAY) dates.push({ label: `In ${fmtDte((half - t0) / DAY)}`, at: half });
    dates.push({ label: `At expiry ${fmtExpiry(first)}`, at: first });
  }
  return (
    <div className="ot-card">
      <div className="ot-card-head">
        <b>Scenarios</b>
        <span className="faint">Profit and loss (USDT) if the index moves by … on these dates{dv ? `, volatility ${dv > 0 ? '+' : ''}${Math.round(dv * 100)} pts` : ''}</span>
      </div>
      <div className="ot-scroll-x">
        <table className="ot-table">
          <thead>
            <tr>
              <th>Index</th>
              {dates.map((d) => (
                <th key={d.label} className="num">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m} className={clsx(m === 0 && 'sel')}>
                <td>
                  {m === 0 ? 'unchanged' : `${m > 0 ? '+' : '−'}${Math.abs(m * 100)}%`} <span className="faint">{fmtNum(S * (1 + m), S >= 1000 ? 0 : 2)}</span>
                </td>
                {dates.map((d) => {
                  const v = positionPnl(legs, S * (1 + m), d.at, r, dv);
                  return (
                    <td key={d.label} className={clsx('num', v > 0 ? 'up' : v < 0 ? 'down' : '')}>
                      {usd(v)}
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

export function Builder({ s, expiry, legs, setLegs, days, dIv, setScenario }: { s: OptionsSnapshot; expiry: number; legs: OptionLeg[]; setLegs: (l: OptionLeg[]) => void; days: number; dIv: number; setScenario: (p: { days?: number; dIv?: number }) => void }) {
  const menu = usePopover();
  const S = s.index;
  const bySymbol = useMemo(() => new Map(s.rows.map((r) => [r.symbol, r])), [s]);
  // legs valued with the live mark volatility of their option
  const live = legs.map((l) => (l.kind === 'option' && l.symbol && bySymbol.get(l.symbol)?.markIV ? { ...l, iv: bySymbol.get(l.symbol)!.markIV } : l));
  const optionLegs = live.filter((l) => l.kind === 'option');
  const first = optionLegs.length ? Math.min(...optionLegs.map((l) => l.expiry!)) : NaN;
  const maxDays = Number.isFinite(first) ? Math.max(0, (first - s.t) / DAY) : 0;
  const d = Math.min(days, maxDays);
  const at = s.t + d * DAY;
  const dv = dIv / 100;
  const g = positionGreeks(live, S, at, s.rf, dv);
  const cost = live.reduce((a, l) => a + l.qty * l.price, 0);
  const nowValue = positionPnl(live, S, s.t, s.rf);
  // price range: a few standard deviations to the first expiry, at least the legs' strikes
  const vol = optionLegs.length ? Math.max(...optionLegs.map((l) => l.iv || 0.5)) : 0.5;
  const T = Number.isFinite(first) ? Math.max(1 / 365, (first - s.t) / (365 * DAY)) : 30 / 365;
  const w = Math.min(0.6, Math.max(0.08, 3 * vol * Math.sqrt(T)));
  const strikes = optionLegs.map((l) => l.strike!);
  const lo = Math.min(S * (1 - w), ...strikes.map((k) => k * 0.95));
  const hi = Math.max(S * (1 + w), ...strikes.map((k) => k * 1.05));
  const curves = useMemo(() => {
    const exp: [number, number][] = [];
    const scen: [number, number][] = [];
    if (!live.length) return { exp, scen };
    const n = 160;
    for (let k = 0; k <= n; k++) {
      const x = lo + ((hi - lo) * k) / n;
      exp.push([x, Number.isFinite(first) ? positionPnl(live, x, first, s.rf, dv) : positionPnl(live, x, at, s.rf, dv)]);
      scen.push([x, positionPnl(live, x, at, s.rf, dv)]);
    }
    return { exp, scen };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(live), lo, hi, first, at, dv, s.rf]);
  const be = breakEvens(curves.exp);
  // the chance of ending in profit at the first expiry, under the distribution its ATM volatility implies
  const atmFirst = Number.isFinite(first) ? atmVol(s.rows.filter((r) => r.expiry === first), S, s.rf, s.t) : NaN;
  const pop = Number.isFinite(first) && first > s.t ? probabilityOfProfit(curves.exp, S, Math.max(0.05, atmFirst + dv), (first - s.t) / (365 * DAY), s.rf) : NaN;
  const ys = curves.exp.map((p) => p[1]);
  const maxP = ys.length ? Math.max(...ys) : NaN;
  const maxL = ys.length ? Math.min(...ys) : NaN;
  const slope = (a: [number, number], b: [number, number]) => (b[1] - a[1]) / (b[0] - a[0]);
  const n = curves.exp.length;
  const upOpen = n > 2 && slope(curves.exp[n - 2], curves.exp[n - 1]) > 1e-6;
  const upLoss = n > 2 && slope(curves.exp[n - 2], curves.exp[n - 1]) < -1e-6;
  const downOpen = n > 2 && slope(curves.exp[0], curves.exp[1]) < -1e-6;
  const downLoss = n > 2 && slope(curves.exp[0], curves.exp[1]) > 1e-6;

  const addPreset = (p: Preset) => {
    const rows = s.rows.filter((r) => r.expiry === expiry);
    const plan = p.build(rows, S);
    if (!plan || plan.some((x) => !x.under && !x.row)) return;
    const stamp = Date.now();
    const out: OptionLeg[] = plan.map((x, k) =>
      x.under
        ? { id: `u-${stamp}-${k}`, kind: 'underlying', qty: x.qty, price: S }
        : { id: `${x.row!.symbol}-${stamp}-${k}`, kind: 'option', symbol: x.row!.symbol, side: x.row!.side, strike: x.row!.strike, expiry: x.row!.expiry, qty: x.qty, price: x.qty > 0 ? x.row!.ask || x.row!.mark : x.row!.bid || x.row!.mark, iv: x.row!.markIV },
    );
    setLegs([...legs, ...out]);
  };
  const upd = (id: string, p: Partial<OptionLeg>) => setLegs(legs.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const series: LineSeries[] = live.length
    ? [
        { id: 'exp', label: Number.isFinite(first) ? `At expiry ${fmtExpiry(first)}` : 'Now', color: 'var(--s1)', points: curves.exp },
        ...(Number.isFinite(first) ? [{ id: 'scen', label: d > 0 ? `In ${fmtDte(d)}${dIv ? `, IV ${dIv > 0 ? '+' : ''}${dIv} pts` : ''}` : `Today${dIv ? `, IV ${dIv > 0 ? '+' : ''}${dIv} pts` : ''}`, color: 'var(--s2)', points: curves.scen }] : []),
      ]
    : [];
  return (
    <div className="ot-section">
      <div className="ot-card">
        <div className="ot-card-head">
          <b>Legs</b>
          <span className="faint">Quantities in {s.base}; prices in USDT per {s.base}. Options use their live mark volatility.</span>
          <span className="spacer" />
          <button className="btn small" onClick={(e) => menu.toggle(e.currentTarget)}>
            <Icon name="plus" size={13} /> Strategy
          </button>
          <button className="btn small" onClick={() => setLegs([...legs, { id: `u-${Date.now()}`, kind: 'underlying', qty: 1, price: S }])} data-tip={`Add a long ${s.base} position at the index (sell it with a negative quantity) — e.g. to hedge delta`}>
            <Icon name="plus" size={13} /> {s.base}
          </button>
          <button className="btn small ghost" disabled={!legs.length} onClick={() => setLegs([])}>
            Clear
          </button>
        </div>
        {!legs.length ? (
          <div className="muted ot-empty">Click a bid, mark or ask in the chain to add an option, or start from a strategy for {fmtExpiry(expiry)}.</div>
        ) : (
          <div className="ot-scroll-x">
          <table className="ot-table legs">
            <thead>
              <tr>
                <th>Instrument</th>
                <th className="num">Quantity</th>
                <th className="num">Entry</th>
                <th className="num">Mark</th>
                <th className="num">IV</th>
                <th className="num" data-tip="Position delta of the leg (coins)">
                  Δ
                </th>
                <th className="num">P&L now</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.map((l) => {
                const r = l.symbol ? bySymbol.get(l.symbol) : undefined;
                const expired = l.kind === 'option' && l.expiry! <= s.t;
                const mark = l.kind === 'underlying' ? S : (r?.mark ?? NaN);
                const lg = positionGreeks([l], S, s.t, s.rf);
                return (
                  <tr key={l.id} className={clsx(expired && 'expired')}>
                    <td>
                      <span className={clsx('leg-side', l.qty >= 0 ? 'buy' : 'sell')}>{l.qty >= 0 ? 'Buy' : 'Sell'}</span>{' '}
                      {l.kind === 'underlying' ? (
                        <b>{s.base}</b>
                      ) : (
                        <>
                          <b>
                            {fmtNum(l.strike!, l.strike! % 1 ? 1 : 0)} {l.side === 'C' ? 'call' : 'put'}
                          </b>{' '}
                          <span className="faint">{expired ? 'expired' : `${fmtExpiry(l.expiry!)} · ${fmtDte((l.expiry! - s.t) / DAY)}`}</span>
                        </>
                      )}
                    </td>
                    <td className="num">
                      <NumberField value={l.qty} step={0.1} decimals={2} onChange={(v) => upd(l.id, { qty: v })} style={{ width: 72, marginLeft: 'auto' }} />
                    </td>
                    <td className="num">
                      <NumberField value={l.price} step={l.kind === 'underlying' ? 10 : 1} onChange={(v) => upd(l.id, { price: Math.max(0, v) })} style={{ width: 84, marginLeft: 'auto' }} />
                    </td>
                    <td className="num">{fmtPremium(mark)}</td>
                    <td className="num">{l.kind === 'option' ? pctIV(l.iv ?? NaN) : ''}</td>
                    <td className="num">{lg.delta.toFixed(2)}</td>
                    <td className={clsx('num', positionPnl([l], S, s.t, s.rf) >= 0 ? 'up' : 'down')}>{usd(positionPnl([l], S, s.t, s.rf))}</td>
                    <td>
                      <button className="icon-btn tiny" onClick={() => setLegs(legs.filter((x) => x.id !== l.id))} data-tip="Remove">
                        <Icon name="x" size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {menu.anchor && (
          <Menu
            anchor={menu.anchor}
            onClose={menu.close}
            width={300}
            items={[{ title: `Strategies on ${fmtExpiry(expiry)}` }, ...PRESETS.map((p) => ({ label: p.label, hint: p.hint, onClick: () => addPreset(p) }))]}
          />
        )}
      </div>
      {live.length > 0 && (
        <>
          <div className="ot-tiles small">
            <Stat label={cost >= 0 ? 'Premium paid' : 'Premium received'} value={usd(Math.abs(cost))} sub={`now worth ${usd(cost + nowValue)}`} tip="What the legs cost at their entry prices (the underlying counts at its full value)" />
            <Stat label="Delta" value={`${g.delta >= 0 ? '+' : ''}${g.delta.toFixed(3)} ${s.base}`} sub={`${usd(g.delta * S)} exposure`} tip="Change of the position value per 1 USDT move of the index, in coins; × price = the equivalent spot position" tone={g.delta} />
            <Stat label="Gamma" value={`${usd(g.gamma * S * S * 0.01)}`} sub="delta change per 1% (USDT)" tip="How much the position's dollar delta changes when the index moves 1%" tone={g.gamma} />
            <Stat label="Theta" value={`${usd(g.theta, 2)}`} sub="per day" tip="Value gained or lost per day from time decay alone" tone={g.theta} />
            <Stat label="Vega" value={`${usd(g.vega, 2)}`} sub="per volatility point" tip="Value change when implied volatility rises one point" tone={g.vega} />
            <Stat label="Break-even" value={be.length ? be.map((x) => fmtNum(x, 0)).join(' · ') : '—'} sub={Number.isFinite(first) ? `at ${fmtExpiry(first)}` : undefined} />
            <Stat
              label="Chance of profit"
              value={Number.isFinite(pop) ? `${(pop * 100).toFixed(0)}%` : '—'}
              sub={Number.isFinite(first) ? `at ${fmtExpiry(first)}` : undefined}
              tip={`The probability that the position ends in profit at the first expiry if the index moves as the options price it: lognormal with that expiry's ATM volatility (${pctIV(atmFirst)}${dIv ? `, ${dIv > 0 ? '+' : ''}${dIv} pts` : ''}). Not a forecast.`}
            />
            <Stat label="Max profit" value={upOpen || downOpen ? 'unlimited' : usd(maxP)} sub="in the range shown" />
            <Stat label="Max loss" value={upLoss || downLoss ? 'unlimited' : usd(maxL)} sub="in the range shown" />
          </div>
          <div className="ot-card">
            <div className="ot-card-head">
              <b>Payoff</b>
              <span className="faint">Profit and loss by index price (USDT)</span>
            </div>
            <div className="ot-filter-row">
              <label className="ot-slider" data-tip="Value the position on a later date (Greeks above follow it)">
                <span>Date</span>
                <input type="range" min={0} max={Math.max(0, Math.floor(maxDays * 4) / 4)} step={Math.max(0.25, maxDays / 40)} value={d} onChange={(e) => setScenario({ days: +e.target.value })} disabled={!(maxDays > 0)} />
                <span className="num">{d > 0 ? `+${fmtDte(d)}` : 'today'}</span>
              </label>
              <label className="ot-slider" data-tip="Shift every leg's implied volatility">
                <span>Volatility</span>
                <input type="range" min={-30} max={30} step={1} value={dIv} onChange={(e) => setScenario({ dIv: +e.target.value })} />
                <span className="num">{`${dIv > 0 ? '+' : ''}${dIv} pts`}</span>
              </label>
              {(d > 0 || dIv !== 0) && (
                <button className="btn small ghost" onClick={() => setScenario({ days: 0, dIv: 0 })}>
                  Reset
                </button>
              )}
            </div>
            {series.length > 1 && <Legend items={series} />}
            <XYLines
              label="Profit and loss of the position by index price"
              series={series}
              height={260}
              xDomain={[lo, hi]}
              zero
              pnlFill="exp"
              xFmt={(x) => fmtNum(x, x >= 1000 ? 0 : 2)}
              yFmt={(y) => `${y < 0 ? '−' : ''}${fmtCompact(Math.abs(y))}`}
              vlines={[{ x: S, label: 'Index', strong: true }, ...be.map((x) => ({ x, label: `BE ${fmtNum(x, 0)}` }))]}
            />
          </div>
        </>
      )}
      {live.length > 0 && <RiskMatrix legs={live} S={S} t0={s.t} first={first} r={s.rf} dv={dv} />}
      <div className="faint small">
        A planning tool: values use Black-Scholes with each option's mark volatility and Binance's rate. Nothing here places orders; the app paper-trades spot and perpetuals.
      </div>
    </div>
  );
}
