/** Replay session report: how the user traded during a replay, against buy & hold and random twins. */
import { Modal, openModal } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { LineChart } from '../../components/LineChart';
import { clsx, fmtDate, fmtDateTime, fmtDuration, fmtNum, fmtPct, fmtSignedUsd, fmtUsd } from '../../lib/format';
import { SYMBOL_SPECS } from '../../../shared/symbols';
import type { ReplayReport } from '../../../main/market/replayReport';
import { VERDICT_CLS } from '../backtest/benchmarkViews';

const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');

export function openReplayReport(rep: ReplayReport): void {
  openModal('replay-report', (close) => <ReplayReportModal rep={rep} onClose={close} />);
}

function ReplayReportModal({ rep, onClose }: { rep: ReplayReport; onClose: () => void }) {
  const s = rep.summary;
  const r = rep.random;
  const ins = rep.instrument ? `${SYMBOL_SPECS[rep.instrument.symbol].base}${rep.instrument.market === 'futures' ? '.P' : ''}` : '';
  return (
    <Modal title="Replay session" icon="replay" onClose={onClose} width={760}>
      <div className="replay-report">
        <div className="muted small">
          {fmtDate(rep.from)} → {fmtDateTime(rep.to)} · {s.count} trade{s.count === 1 ? '' : 's'}
        </div>
        {!s.count ? (
          <div className="muted">No trades in this replay yet. Trade with the replay bar, the Trade panel or the chart, then open the report again.</div>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi">
                <div className="kpi-label">Result</div>
                <div className={clsx('kpi-value', s.net >= 0 ? 'up' : 'down')}>{fmtSignedUsd(s.net)}</div>
                <div className="kpi-sub">{fmtPct(s.returnPct)} of equity</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Win rate</div>
                <div className="kpi-value">{fmtPct(s.winRate * 100, 0, false)}</div>
                <div className="kpi-sub">
                  {s.wins} W / {s.count - s.wins} L
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Profit factor</div>
                <div className="kpi-value">{pf(s.profitFactor)}</div>
                <div className="kpi-sub">
                  avg win {fmtUsd(s.avgWin)} · loss {fmtUsd(Math.abs(s.avgLoss))}
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Max drawdown</div>
                <div className="kpi-value down">{fmtPct(-s.maxClosedDrawdownPct, s.maxClosedDrawdownPct < 1 ? 2 : 1)}</div>
                <div className="kpi-sub">on closed trades</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Avg holding time</div>
                <div className="kpi-value">{fmtDuration(s.avgHoldMs)}</div>
                <div className="kpi-sub">fees {fmtUsd(s.fees)}</div>
              </div>
              {rep.buyHoldPct !== null && (
                <div className="kpi">
                  <div className="kpi-label">Buy & hold {ins}</div>
                  <div className={clsx('kpi-value', rep.buyHoldPct >= 0 ? 'up' : 'down')}>{fmtPct(rep.buyHoldPct)}</div>
                  <div className="kpi-sub">over the same period</div>
                </div>
              )}
            </div>
            {r ? (
              <>
                <div className={clsx('callout', VERDICT_CLS[r.verdict.level])}>
                  <Icon name={r.verdict.level === 'strong' || r.verdict.level === 'likely' ? 'check' : r.verdict.level === 'worse' ? 'alert' : 'info'} size={14} />
                  <div>
                    <b>{r.verdict.level === 'strong' || r.verdict.level === 'likely' ? 'Your entries look better than random.' : r.verdict.level === 'worse' ? 'Random entries did better than yours.' : 'Your result is within what random entries do.'}</b> Your {ins} trades beat {r.timing.beats.returnPct.toFixed(0)}% of {r.iterations.toLocaleString('en-US')} random twins with the same sizes, holding times and costs (p = {r.timing.pReturn.toFixed(3)}).
                    {r.direction ? ` With a coin flip for the direction at your own entry times they beat ${r.direction.beats.returnPct.toFixed(0)}%.` : ''}
                  </div>
                </div>
                <div className="chart-card">
                  <div className="section-title">Your equity vs random twins</div>
                  <LineChart
                    t={r.curves.t}
                    height={180}
                    zeroLine
                    format={(v) => `${v.toFixed(1)}%`}
                    bands={[
                      { lo: r.curves.p5, hi: r.curves.p95, color: 'rgba(139,147,163,0.14)', label: 'Random 5–95%' },
                      { lo: r.curves.p25, hi: r.curves.p75, color: 'rgba(139,147,163,0.22)', label: 'Random 25–75%' },
                    ]}
                    series={[
                      { values: r.curves.p50, color: '#8b93a3', label: 'Random median', dashed: true, width: 1.3 },
                      { values: r.curves.strategy, color: '#3b82f6', label: 'You', width: 2.2 },
                    ]}
                  />
                </div>
              </>
            ) : (
              <div className="muted small">Make at least three trades in one instrument to compare them with random entries.</div>
            )}
            <div className="section-title">Trades</div>
            <div className="rr-trades">
              <table className="table">
                <thead>
                  <tr>
                    <th>Closed</th>
                    <th>Side</th>
                    <th className="num">Qty</th>
                    <th className="num">Entry</th>
                    <th className="num">Exit</th>
                    <th className="num">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.trades
                    .slice()
                    .reverse()
                    .slice(0, 100)
                    .map((t, k) => (
                      <tr key={k}>
                        <td className="num muted">{fmtDateTime(t.closedAt)}</td>
                        <td className={t.side === 'long' ? 'up' : 'down'}>
                          {t.side === 'long' ? 'Long' : 'Short'} {SYMBOL_SPECS[t.symbol].base}
                          {t.market === 'futures' ? '.P' : ''}
                        </td>
                        <td className="num">{fmtNum(t.qty, 4)}</td>
                        <td className="num">{fmtNum(t.entry, 2)}</td>
                        <td className="num">{fmtNum(t.exit, 2)}</td>
                        <td className={clsx('num', t.pnl >= 0 ? 'up' : 'down')}>{fmtSignedUsd(t.pnl)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
