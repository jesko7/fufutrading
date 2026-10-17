/**
 * Repainting & lookahead: the patterns found in a script's code (static warnings, with links to
 * the lines) and a live replay of its recent bars that compares what it showed at each bar close
 * — and, for strategies, the position and orders a bot had — with what its history shows now.
 */
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { Modal, openModal, Spinner } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { clsx, fmtDateTime } from '../../lib/format';
import { openScriptInEditor } from './client';
import type { AnalyzeResult } from '../../../engine/host';
import type { RepaintReport } from '../../../engine/repaint';
import type { ScriptLanguage, ScriptWarning } from '../../../engine/types';
import type { BrokerConfig } from '../../../engine/backtest/broker';
import type { SymbolId } from '../../../shared/symbols';

export interface RepaintTarget {
  /** A saved script (the main process reads its code)… */
  scriptId?: string;
  /** …or unsaved code from the editor. */
  code?: string;
  language?: ScriptLanguage;
  name: string;
  inputs?: Record<string, unknown>;
  spec: { symbol: SymbolId; market: 'spot' | 'futures'; tf: string; chartType: string };
  /** Strategy broker settings (null: a strategy's plots only). */
  strategy?: Partial<BrokerConfig> | null;
  /** Warnings already known (otherwise the code is analysed here). */
  warnings?: ScriptWarning[];
  /** Jump to a line (the editor passes its own; otherwise the script opens in the editor). */
  onJump?: (line: number) => void;
}

export function openRepaintCheck(t: RepaintTarget): void {
  openModal(`repaint-${Date.now()}`, (close) => <RepaintDialog target={t} onClose={close} />);
}

const KIND: Record<string, { label: string; cls: string }> = {
  lookahead: { label: 'Lookahead', cls: 'danger' },
  repaint: { label: 'Repainting', cls: 'warn' },
  runtime: { label: 'Run', cls: '' },
  compat: { label: 'Compatibility', cls: 'info' },
  info: { label: 'Note', cls: 'info' },
};

/** Messages carry their kind as a prefix ("Lookahead: …"): the badge shows it already. */
const bare = (m: string) => m.replace(/^(Lookahead|Repainting|Repaint)\s*:\s*/i, '');

export function warningKinds(ws: ScriptWarning[] | undefined): { lookahead: number; repaint: number } {
  const l = ws || [];
  return { lookahead: l.filter((w) => w.kind === 'lookahead').length, repaint: l.filter((w) => w.kind === 'repaint').length };
}

export function WarningList({ warnings, onJump }: { warnings: ScriptWarning[]; onJump?: (line: number) => void }) {
  const sorted = [...warnings].sort((a, b) => (a.kind === b.kind ? (a.line ?? 0) - (b.line ?? 0) : a.kind === 'lookahead' ? -1 : b.kind === 'lookahead' ? 1 : a.kind === 'repaint' ? -1 : b.kind === 'repaint' ? 1 : 0));
  return (
    <div className="rp-warnings">
      {sorted.map((w, k) => {
        const kd = KIND[w.kind] || KIND.info;
        return (
          <div key={k} className="rp-warning">
            <span className={clsx('badge', kd.cls)}>{kd.label}</span>
            <span className="rp-msg">{bare(w.message)}</span>
            {w.line && onJump ? (
              <button className="link-btn rp-line" onClick={() => onJump(w.line!)} data-tip="Show in the script editor">
                line {w.line}
              </button>
            ) : w.line ? (
              <span className="muted rp-line">line {w.line}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RepaintDialog({ target, onClose }: { target: RepaintTarget; onClose: () => void }) {
  const [warnings, setWarnings] = useState<ScriptWarning[] | null>(target.warnings ?? null);
  const [report, setReport] = useState<RepaintReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { symbol, market, tf } = target.spec;
  const where = `${symbol}${market === 'futures' ? '.P' : ''} ${tf}`;
  const jump = target.onJump
    ? (line: number) => {
        onClose();
        target.onJump!(line);
      }
    : target.scriptId
      ? (line: number) => {
          onClose();
          void openScriptInEditor(target.scriptId!, { line });
        }
      : undefined;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await api.call<RepaintReport>('scripts:repaintCheck', { scriptId: target.scriptId, code: target.code, language: target.language, inputs: target.inputs || {}, spec: target.spec, strategy: target.strategy }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void run();
    if (warnings) return;
    // the code's own warnings for this chart (request.security warnings depend on its timeframe)
    const doc = target.code !== undefined ? Promise.resolve({ code: target.code, language: target.language || 'pine' }) : api.call<{ code: string; language: ScriptLanguage }>('scripts:get', target.scriptId);
    doc
      .then((d) => api.call<AnalyzeResult>('scripts:analyze', d.language, d.code, target.spec))
      .then((a) => setWarnings(a.warnings || []))
      .catch(() => setWarnings([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const relevant = (warnings || []).filter((w) => w.kind === 'lookahead' || w.kind === 'repaint');
  const other = (warnings || []).filter((w) => w.kind === 'runtime');
  const r = report;
  const bad = r?.badTimes.length ?? 0;
  return (
    <Modal
      title={`Repainting & lookahead — ${target.name}`}
      icon="replay"
      onClose={onClose}
      width={660}
      footer={
        <>
          <button className="btn" onClick={() => void run()} disabled={running}>
            <Icon name="refresh" size={14} /> Check again
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="repaint-dlg">
        <section>
          <h3>Live replay on {where}</h3>
          {running && !r && (
            <div className="rp-running">
              <Spinner size={14} /> Replaying the most recent bars as if each had just closed…
            </div>
          )}
          {error && (
            <div className="callout warn">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          )}
          {r && !r.ok && (
            <div className="callout warn">
              <Icon name="alert" size={14} />
              <span>{r.error || 'The check could not run.'}</span>
            </div>
          )}
          {r && r.ok && !r.diffs.length && (
            <div className="callout ok">
              <Icon name="check" size={14} />
              <span>
                <b>No differences.</b> {r.checked} of the last {r.window} bars ({fmtDateTime(r.from)} – {fmtDateTime(r.to)}) were replayed as if live: what the script showed at each bar close{r.isStrategy ? ', and the position and orders a bot had,' : ''} match its history exactly.
              </span>
            </div>
          )}
          {r && r.ok && r.diffs.length > 0 && (
            <>
              <div className="callout danger">
                <Icon name="alert" size={14} />
                <span>
                  <b>
                    {r.isStrategy && r.diffs.some((d) => d.kind === 'strategy') ? 'A bot would have traded differently than the backtest.' : 'The history shows values that were not known at the time.'}
                  </b>{' '}
                  At {bad} of {r.checked} replayed bars the live result differs from the history — {r.isStrategy ? 'backtest results of this strategy are not reproducible live.' : 'signals and values on past bars look better than they were in real time.'}
                </span>
              </div>
              <table className="rp-diffs">
                <thead>
                  <tr>
                    <th>Output</th>
                    <th>Differs</th>
                    <th>Most recent example</th>
                  </tr>
                </thead>
                <tbody>
                  {r.diffs.map((d, k) => (
                    <tr key={k}>
                      <td>
                        <span className="rp-out">{d.title}</span>
                        <span className="faint"> {d.kind === 'strategy' ? 'strategy' : d.kind === 'alert' ? 'alert condition' : d.kind === 'error' ? '' : 'plot'}</span>
                      </td>
                      <td className="num">
                        {d.count} / {r.checked}
                      </td>
                      <td>
                        <div className="faint">{fmtDateTime(d.example.time)}</div>
                        <div>
                          <span className="rp-label">{d.kind === 'strategy' ? 'Bot:' : 'Live:'}</span> {d.example.live}
                        </div>
                        <div>
                          <span className="rp-label">{d.kind === 'strategy' ? 'Backtest:' : 'History:'}</span> {d.example.history}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {r?.notes.map((n, k) => (
            <div key={k} className="muted rp-note">
              {n}
            </div>
          ))}
          <p className="muted rp-explain">
            Each replayed bar runs the script on the bars up to that moment only{r?.isStrategy === false ? ' (with the next bar just opened, as a chart keeps it)' : ''}, with other timeframes and symbols cut at the same time, and compares the result with the run over all bars. {r?.isStrategy ? 'A strategy is compared by its position and working orders after each bar close — exactly what a bot acts on.' : ''}
          </p>
        </section>
        <section>
          <h3>In the code</h3>
          {warnings === null ? (
            <div className="muted">
              <Spinner size={12} /> Analysing…
            </div>
          ) : relevant.length ? (
            <WarningList warnings={relevant} onJump={jump} />
          ) : (
            <div className="muted">
              <Icon name="check" size={12} /> No lookahead or repainting patterns found in the code.
            </div>
          )}
          {other.length > 0 && (
            <>
              <h4>While running</h4>
              <WarningList warnings={other} onJump={jump} />
            </>
          )}
          <p className="muted rp-explain">
            <b>Lookahead</b> uses data that did not exist yet at that bar (future values), so historical signals and backtests look better than anything achievable live. <b>Repainting</b> means values on the live bar differ from what the same bar shows later, after the bar closed or the chart reloaded.
          </p>
        </section>
      </div>
    </Modal>
  );
}
