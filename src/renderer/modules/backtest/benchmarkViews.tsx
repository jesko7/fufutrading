/** Strategy Tester views: the strategy against its random counterparts, and its Greeks. */
import { LineChart } from '../../components/LineChart';
import { Icon } from '../../components/Icon';
import { clsx, fmtPct } from '../../lib/format';
import type { Greeks, RandomBenchmark, RandomModel, RandomStats } from '../../../engine/backtest/benchmarks';
import type { BacktestRecord } from '../../../main/backtest/service';
import { SYMBOL_SPECS } from '../../../shared/symbols';

const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
const signCls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export const VERDICT_CLS: Record<RandomBenchmark['verdict']['level'], string> = { strong: 'ok', likely: 'ok', weak: 'warn', none: '', worse: 'danger' };

const ROWS: { key: keyof RandomStats; label: string; fmt: (v: number) => string; lowerBetter?: boolean; p?: 'pReturn' | 'pSharpe' }[] = [
  { key: 'returnPct', label: 'Return', fmt: (v) => fmtPct(v, 1), p: 'pReturn' },
  { key: 'sharpe', label: 'Sharpe', fmt: (v) => v.toFixed(2), p: 'pSharpe' },
  { key: 'maxDrawdownPct', label: 'Max drawdown', fmt: (v) => fmtPct(-v, 1), lowerBetter: true },
  { key: 'profitFactor', label: 'Profit factor', fmt: pf },
  { key: 'winRate', label: 'Win rate', fmt: (v) => fmtPct(v, 1, false) },
];

function Beats({ v }: { v: number }) {
  const cls = v >= 95 ? 'up' : v < 50 ? 'down' : '';
  return (
    <span className="beats">
      <span className="beats-bar">
        <span className={clsx('beats-fill', cls)} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </span>
      <b className={cls}>{v >= 99.5 && v < 100 ? '>99' : v.toFixed(0)}%</b>
    </span>
  );
}

function ModelTable({ m, title, sub }: { m: RandomModel; title: string; sub: string }) {
  return (
    <>
      <div className="section-title">{title}</div>
      <div className="muted small" style={{ marginTop: -2, marginBottom: 4 }}>
        {sub}
      </div>
      <table className="table rb-table">
        <thead>
          <tr>
            <th />
            <th className="num">Strategy</th>
            <th className="num">Random median</th>
            <th className="num">Random 5–95%</th>
            <th>Strategy beats</th>
            <th className="num" data-tip="Probability that a random twin does at least as well (one-sided)">
              p-value
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => {
            const q = m.random[r.key];
            return (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="num">
                  <b>{r.fmt(m.strategy[r.key])}</b>
                </td>
                <td className="num">{r.fmt(q.p50)}</td>
                <td className="num muted">
                  {r.lowerBetter ? `${r.fmt(q.p5)} … ${r.fmt(q.p95)}` : `${r.fmt(q.p5)} … ${r.fmt(q.p95)}`}
                </td>
                <td>
                  <Beats v={m.beats[r.key]} />
                </td>
                <td className={clsx('num', r.p && m[r.p] < 0.05 ? 'up' : '')}>{r.p ? m[r.p].toFixed(3) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Histogram({ hist, marker }: { hist: RandomModel['hist']; marker: number }) {
  const W = 600;
  const H = 120;
  const n = hist.counts.length;
  const bw = W / n;
  const max = Math.max(1, ...hist.counts);
  const mx = Math.max(0, Math.min(W, ((marker - hist.lo) / hist.step) * bw));
  const zero = -hist.lo / hist.step;
  const ticks = [hist.lo, hist.lo + (hist.step * n) / 2, hist.lo + hist.step * n];
  return (
    <svg className="rb-hist" viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" role="img" aria-label="Distribution of random returns">
      {hist.counts.map((c, i) => {
        const h = (c / max) * (H - 8);
        const better = hist.lo + (i + 0.5) * hist.step >= marker;
        return <rect key={i} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} className={better ? 'rb-bin better' : 'rb-bin'} />;
      })}
      {zero > 0 && zero < n && <line x1={zero * bw} x2={zero * bw} y1={0} y2={H} className="rb-zero" />}
      <line x1={mx} x2={mx} y1={0} y2={H} className="rb-marker" />
      <text x={Math.min(W - 4, Math.max(4, mx + 4))} y={12} className="rb-label" textAnchor={mx > W - 90 ? 'end' : 'start'}>
        Strategy {fmtPct(marker, 1)}
      </text>
      {ticks.map((v, k) => (
        <text key={k} x={k === 0 ? 2 : k === 1 ? W / 2 : W - 2} y={H + 14} className="rb-tick" textAnchor={k === 0 ? 'start' : k === 1 ? 'middle' : 'end'}>
          {fmtPct(v, 0)}
        </text>
      ))}
    </svg>
  );
}

export function RandomView({ rec, onRerun }: { rec: BacktestRecord; onRerun: () => void }) {
  const r = rec.random;
  if (!r)
    return (
      <div className="analysis">
        <div className="muted">
          {rec.trades.length
            ? 'This run was made before random counterparts existed. Run it again to compare the strategy with 1,000 random strategies that make the same trades at random times.'
            : 'The strategy made no trades in this range, so there is nothing to compare.'}
        </div>
        {rec.trades.length > 0 && (
          <div>
            <button className="btn small" onClick={onRerun}>
              <Icon name="refresh" size={13} /> Run again
            </button>
          </div>
        )}
      </div>
    );
  const c = r.curves;
  return (
    <div className="analysis random-view">
      <div className={clsx('callout', VERDICT_CLS[r.verdict.level])}>
        <Icon name={r.verdict.level === 'strong' || r.verdict.level === 'likely' ? 'check' : r.verdict.level === 'worse' ? 'alert' : 'info'} size={14} />
        <div>
          <b>{r.verdict.title}.</b> {r.verdict.text}
        </div>
      </div>
      <div className="chart-card">
        <div className="section-title">Equity vs {r.iterations.toLocaleString('en-US')} random twins</div>
        <LineChart
          t={c.t}
          height={240}
          zeroLine
          format={(v) => `${v.toFixed(1)}%`}
          bands={[
            { lo: c.p5, hi: c.p95, color: 'rgba(139,147,163,0.14)', label: 'Random 5–95%' },
            { lo: c.p25, hi: c.p75, color: 'rgba(139,147,163,0.22)', label: 'Random 25–75%' },
          ]}
          series={[
            ...c.samples.map((v, i) => ({ values: v, color: '#8b93a3', label: `Twin ${i + 1}`, width: 0.8, alpha: 0.3, tip: false })),
            { values: c.p50, color: '#8b93a3', label: 'Random median', dashed: true, width: 1.3 },
            { values: c.strategy, color: '#3b82f6', label: 'Strategy', width: 2.2 },
          ]}
        />
      </div>
      <div className="chart-card">
        <div className="section-title">Distribution of random returns</div>
        <Histogram hist={r.timing.hist} marker={r.timing.strategy.returnPct} />
        <div className="muted small">Bars right of the line are random twins that did at least as well as the strategy; their share is the p-value.</div>
      </div>
      <ModelTable m={r.timing} title="Random timing" sub={`Same ${r.trades} trades (holding times, sizes, long/short mix, costs) at random times. Tests whether the entries are better than luck.`} />
      {r.direction && <ModelTable m={r.direction} title="Random direction" sub="The strategy's own entry and exit times and prices, with a coin flip for long or short. Tests whether the strategy picks the right side." />}
      <ul className="rb-notes muted small">
        {r.notes.map((n, k) => (
          <li key={k}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ Greeks

function fmtNumOrDash(v: number, d = 2): string {
  return Number.isFinite(v) ? v.toFixed(d) : '—';
}

function greekCards(g: Greeks, bench: string) {
  const b = g.beta;
  const corr = Math.abs(g.correlation);
  return [
    {
      sym: 'α',
      name: 'Alpha',
      value: `${fmtPct(g.alpha, 1)}/yr`,
      cls: signCls(g.alpha),
      text: g.alpha >= 0 ? `Return per year that exposure to ${bench} doesn't explain. This is the part that may be skill.` : `The strategy earns ${fmtPct(-g.alpha, 1, false)} a year less than its exposure to ${bench} would.`,
    },
    {
      sym: 'β',
      name: 'Beta',
      value: b.toFixed(2),
      cls: '',
      text: Math.abs(b) < 0.05 ? `Practically independent of ${bench}'s daily moves.` : `Moves about ${Math.abs(b).toFixed(2)}% ${b < 0 ? 'against' : 'with'} each 1% move of ${bench}.`,
    },
    {
      sym: 'ρ',
      name: 'Correlation',
      value: g.correlation.toFixed(2),
      cls: '',
      text: `${corr < 0.3 ? 'Low' : corr < 0.7 ? 'Moderate' : 'High'} ${g.correlation < 0 ? 'negative ' : ''}correlation of daily returns with ${bench}.`,
    },
    {
      sym: 'R²',
      name: 'R-squared',
      value: fmtPct(g.rSquared * 100, 0, false),
      cls: '',
      text: `Share of the daily ups and downs explained by ${bench}. Low means the result comes from somewhere else.`,
    },
    {
      sym: 'σ',
      name: 'Volatility',
      value: fmtPct(g.sigma, 1, false),
      cls: '',
      text: `Annualised volatility of daily returns; ${bench}: ${fmtPct(g.benchSigma, 1, false)}.`,
    },
    {
      sym: 'Ω',
      name: 'Omega',
      value: Number.isFinite(g.omega) ? g.omega.toFixed(2) : '∞',
      cls: g.omega > 1 ? 'up' : g.omega < 1 ? 'down' : '',
      text: `Daily gains add up to ${Number.isFinite(g.omega) ? g.omega.toFixed(2) : 'infinitely many'}× the daily losses. Above 1 is profitable.`,
    },
  ];
}

export function GreeksView({ rec }: { rec: BacktestRecord }) {
  const g = rec.metrics?.greeks;
  const base = SYMBOL_SPECS[rec.request.symbol].base;
  const bench = `${base} buy & hold`;
  if (!g)
    return (
      <div className="analysis">
        <div className="muted">The Greeks need at least five days of results. Test a longer range.</div>
      </div>
    );
  const rel: [string, string, string][] = [
    ['Tracking error', fmtPct(g.trackingError, 1, false), `Annualised volatility of the difference to ${bench}`],
    ['Information ratio', fmtNumOrDash(g.informationRatio), `Excess return over ${bench} per unit of tracking error`],
    ['Treynor ratio', Number.isFinite(g.treynor) ? `${fmtPct(g.treynor, 1)}` : '—', 'Annual excess return per unit of beta'],
    ['Up capture', Number.isFinite(g.upCapture) ? fmtPct(g.upCapture, 0, false) : '—', `Average return on ${base}'s up days relative to ${base}'s`],
    ['Down capture', Number.isFinite(g.downCapture) ? fmtPct(g.downCapture, 0, false) : '—', `Average return on ${base}'s down days relative to ${base}'s (lower is better)`],
    ['Upside β', fmtNumOrDash(g.upsideBeta), `Beta on ${base}'s up days`],
    ['Downside β', fmtNumOrDash(g.downsideBeta), `Beta on ${base}'s down days (lower protects better)`],
  ];
  const tail: [string, string, string][] = [
    ['VaR 95% (1 day)', fmtPct(-g.var95, 2), 'One day in twenty loses at least this much (historical)'],
    ['CVaR 95% (1 day)', fmtPct(-g.cvar95, 2), 'Average loss on those worst days (expected shortfall)'],
    ['Skewness', fmtNumOrDash(g.skew), g.skew < 0 ? 'Negative: occasional large losses' : 'Positive: occasional large gains'],
    ['Excess kurtosis', fmtNumOrDash(g.kurtosis), g.kurtosis > 1 ? 'Fat tails: extreme days are more common than normal' : 'Tails close to normal'],
    ['Tail ratio', fmtNumOrDash(g.tailRatio), '95th percentile gain over the 5th percentile loss'],
  ];
  return (
    <div className="analysis greeks-view">
      <div className="greek-grid">
        {greekCards(g, bench).map((c) => (
          <div key={c.name} className="greek-card">
            <div className="greek-head">
              <span className="greek-sym">{c.sym}</span>
              <span className="greek-name">{c.name}</span>
            </div>
            <div className={clsx('greek-value', c.cls)}>{c.value}</div>
            <div className="greek-text">{c.text}</div>
          </div>
        ))}
      </div>
      <div className="section-title">Relative to {bench}</div>
      <table className="table">
        <tbody>
          {rel.map(([k, v, tip]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">
                <b>{v}</b>
              </td>
              <td className="muted small">{tip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">Tail risk</div>
      <table className="table">
        <tbody>
          {tail.map(([k, v, tip]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">
                <b>{v}</b>
              </td>
              <td className="muted small">{tip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        From {g.days} daily returns of the strategy and of {bench} over the same days, annualised with 365 days{rec.request.riskFree ? ` and a ${fmtPct(rec.request.riskFree * 100, 2, false)} risk-free rate` : ''}. {g.days < 60 ? 'Fewer than 60 days: treat these figures as rough.' : ''}
      </div>
    </div>
  );
}
