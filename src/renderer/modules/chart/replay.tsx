/**
 * Bar replay for charts (TradingView-style): pick a bar, then play the market forward from there
 * at an adjustable speed, step bar by bar and paper-trade on the replayed prices. All charts of the
 * window follow the same replay clock. The data comes from the main-process replay session, which
 * never reveals anything beyond the replay point — to the chart, its indicators or replay trading.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { bus } from '../../lib/bus';
import { Icon } from '../../components/Icon';
import { Menu, usePopover, NumberField, Popover } from '../../components/ui';
import { clsx, fmtSignedUsd, fmtUsd, fmtNum } from '../../lib/format';
import { useAccount } from '../trading/accounts';
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { ChartEngine } from '../../chart/engine';
import type { BarStore } from '../../chart/barStore';
import type { SeriesInfo, SeriesStatus } from '../../../shared/marketTypes';
import { parseTimeframe, bucketEnd, isFixedDuration } from '../../../shared/timeframes';
import { SYMBOL_SPECS } from '../../../shared/symbols';

export interface ReplayView {
  id: string;
  windowId: string;
  start: number;
  cursor: number;
  playing: boolean;
  speed: number;
  resolution: string;
  interval: string;
  intervals: string[];
  epoch: number;
  end: number;
  status: 'loading' | 'ready' | 'ended';
  message?: string;
  owner?: string;
  accounts: Partial<Record<'spot' | 'futures', string>>;
  prices: Record<string, number>;
}

export interface ChartReplay {
  active: boolean;
  /** Changes whenever the replay restarts (series must be re-fetched). */
  sessionId: string | null;
  ref: { session: string; epoch: number } | null;
  accountId?: string | null;
  picking: boolean;
  attach(eng: ChartEngine, store: BarStore, cb: (s: SeriesStatus, info?: SeriesInfo) => void): () => void;
  onPickBar(time: number): void;
  toggle?(): void;
  overlay: ReactNode;
}

// ------------------------------------------------------------------ window replay state (one subscription)

let current: ReplayView | null = null;
const listeners = new Set<() => void>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  api.sub<ReplayView | null>('replay', { windowId: api.windowId }, (v) => {
    current = v && (v as any).__error ? null : v;
    (window as any).__replayActive = !!current;
    for (const l of listeners) l();
  });
}

export function useReplayView(): ReplayView | null {
  const [, setN] = useState(0);
  useEffect(() => {
    ensureSubscribed();
    const l = () => setN((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return current;
}

const fail = (title: string) => (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

export const REPLAY_SPEEDS: { value: number; label: string }[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1× · real time' },
  { value: 3, label: '3×' },
  { value: 10, label: '10×' },
  { value: 60, label: '1 min / s' },
  { value: 300, label: '5 min / s' },
  { value: 900, label: '15 min / s' },
  { value: 3600, label: '1 hour / s' },
  { value: 14400, label: '4 hours / s' },
  { value: 86400, label: '1 day / s' },
];

function speedLabel(x: number): string {
  return REPLAY_SPEEDS.find((s) => s.value === x)?.label.replace(' · real time', '') || `${x}×`;
}

function fmtCursor(t: number): string {
  const d = new Date(t);
  const utc = useApp.getState().settings.timezone === 'utc';
  const p = (n: number) => String(n).padStart(2, '0');
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${Y}-${p(M)}-${p(D)} ${p(h)}:${p(m)}:${p(s)}`;
}

/** Chart hook: replay state of this chart's window plus the data source and control overlay. */
export function useReplayForChart(moduleId: string, cfg: ChartModuleConfig): ChartReplay {
  const view = useReplayView();
  const [picking, setPicking] = useState(false);
  const tf = parseTimeframe(cfg.tf);
  const ws = useApp((s) => s.workspace);
  const focused = useApp((s) => s.focusedModule);
  const active = !!view;
  // the control bar lives on the chart that started the replay (or the focused chart if it is gone)
  const ownerAlive = !!(view?.owner && ws?.modules[view.owner]);
  const showBar = active && (view!.owner === moduleId || (!ownerAlive && (focused === moduleId || !focused)));

  const start = (time: number) => {
    if (!tf) return;
    const at = isFixedDuration(tf) ? bucketEnd(tf, time) : time + 1;
    const p = view ? api.call('replay:cmd', { cmd: 'jump', value: at, owner: moduleId }) : api.call('replay:start', { start: at, owner: moduleId });
    void p.catch(fail('Replay could not start'));
  };

  // keyboard: space / shift+→ act on the window's replay (handled once, by the bar's chart)
  const tfRef = useRef(cfg.tf);
  tfRef.current = cfg.tf;
  useEffect(() => {
    if (!showBar) return;
    return bus.on('replay:cmd', (cmd: string) => {
      if (cmd === 'step') void api.call('replay:cmd', { cmd: 'step', tf: tfRef.current }).catch(fail('Replay'));
      else void api.call('replay:cmd', { cmd }).catch(fail('Replay'));
    });
  }, [showBar]);

  const ref = view ? { session: view.id, epoch: view.epoch } : null;
  const accountId = view ? view.accounts[cfg.market] || null : null;
  return {
    active,
    sessionId: view ? `${view.id}:${view.epoch}` : null,
    ref,
    accountId,
    picking,
    attach: (eng, store, cb) => {
      if (!ref) return () => {};
      let first = true;
      eng.setBarCloseTime(null);
      return api.sub<any>('series', { symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: cfg.chartType === 'heikinashi' || cfg.chartType === 'renko' ? cfg.chartType : 'candles', renko: cfg.chartType === 'renko' ? cfg.renko || { atrLength: 14 } : undefined, replay: ref }, (msg) => {
        if (msg.__error) {
          cb('error', { key: '', baseInterval: null, construction: '', error: String(msg.__error).replace(/^Error: /, '') });
          return;
        }
        if (msg.type === 'snapshot') {
          store.setPacked(msg.packed);
          eng.setData(store.bars(), { keepView: !first });
          first = false;
          cb('replay', msg.info);
        } else if (msg.packed.length || msg.length !== store.length) {
          const added = store.apply(msg.index, msg.packed, msg.length);
          eng.dataUpdated(store.bars(), added);
          if (added) cb('replay');
        }
      });
    },
    onPickBar: (time) => {
      setPicking(false);
      if (!isFinite(time)) return;
      start(time);
    },
    toggle: () => {
      if (picking) setPicking(false);
      else if (view) void api.call('replay:stop').catch(fail('Replay'));
      else {
        setPicking(true);
        toast({ title: 'Bar replay', body: 'Click the bar to start the replay from (Esc cancels).', kind: 'info' });
      }
    },
    overlay: showBar && view ? <ReplayBar view={view} cfg={cfg} moduleId={moduleId} onPick={() => setPicking(true)} /> : null,
  };
}

export function ReplayButton({ replay }: { replay: ChartReplay }) {
  return (
    <button className={clsx('btn ghost small', (replay.active || replay.picking) && 'on')} onClick={() => replay.toggle?.()} data-tip={replay.active ? 'Exit replay (Shift+R)' : 'Bar replay: pick a starting bar (Shift+R)'}>
      <Icon name="replay" size={15} /> {replay.active ? 'Exit replay' : replay.picking ? 'Pick a bar…' : 'Replay'}
    </button>
  );
}

function ReplayBar({ view, cfg, moduleId, onPick }: { view: ReplayView; cfg: ChartModuleConfig; moduleId: string; onPick: () => void }) {
  const speedMenu = usePopover();
  const ivMenu = usePopover();
  const startMenu = usePopover();
  const datePop = usePopover();
  const [date, setDate] = useState('');
  const settings = useApp((s) => s.settings);
  const [qtyUsd, setQtyUsd] = useState<number>(settings.trading.quickQtyUsd || 1000);
  const accountId = view.accounts[cfg.market] || null;
  const acct = useAccount(accountId);
  const cmd = (c: Record<string, unknown>) => api.call('replay:cmd', c).catch(fail('Replay'));
  const pos = acct?.positions.find((p) => p.symbol === cfg.symbol);
  const base = SYMBOL_SPECS[cfg.symbol].base;
  const trade = async (side: 'buy' | 'sell') => {
    try {
      await api.call('replay:trade', { market: cfg.market, symbol: cfg.symbol, side, usd: qtyUsd });
    } catch (e) {
      fail('Replay order failed')(e);
    }
  };
  const close = async () => {
    if (!accountId) return;
    await api.call('trading:close', accountId, cfg.symbol).catch(fail('Close failed'));
  };
  const pnl = acct ? acct.equity - acct.config.initialBalance : 0;
  const ivLabel = (iv: string) => (iv === '1s' && cfg.market === 'futures' ? '1m (futures)' : iv);
  return (
    <div className="replay-bar" onMouseDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" onClick={(e) => startMenu.toggle(e.currentTarget)} data-tip="Choose another starting point">
        <Icon name="cursor" />
      </button>
      <button className="icon-btn primary-ic" onClick={() => void cmd({ cmd: view.playing ? 'pause' : 'play' })} data-tip={view.playing ? 'Pause (Space)' : 'Play (Space)'} disabled={view.status === 'ended'}>
        <Icon name={view.playing ? 'pause' : 'play'} />
      </button>
      <button className="icon-btn" onClick={() => void cmd({ cmd: 'step', tf: cfg.tf })} data-tip={`Forward one ${cfg.tf} bar (Shift+→)`} disabled={view.status === 'ended'}>
        <Icon name="step" />
      </button>
      <button className="btn ghost small" onClick={(e) => speedMenu.toggle(e.currentTarget)} data-tip="Playback speed (market time per second)">
        {speedLabel(view.speed)} <Icon name="chevDown" size={12} />
      </button>
      <button className="btn ghost small" onClick={(e) => ivMenu.toggle(e.currentTarget)} data-tip="Update interval: the real kline resolution the replay reveals (no invented ticks)">
        <Icon name="layers" size={13} /> {view.resolution === 'auto' ? `Auto · ${ivLabel(view.interval)}` : ivLabel(view.interval)}
      </button>
      <span className={clsx('replay-clock num', view.status === 'loading' && 'loading')} data-tip={view.message || 'Replay time'}>
        {view.status === 'loading' ? <span className="spinner" style={{ width: 10, height: 10 }} /> : null}
        {fmtCursor(view.cursor)}
      </span>
      <span className="replay-sep" />
      <NumberField value={qtyUsd} onChange={(v) => setQtyUsd(Math.max(1, v))} min={1} step={100} decimals={0} suffix="USDT" style={{ width: 112 }} />
      <button className="btn small buy" onClick={() => void trade('buy')} data-tip={`Buy ${base} at the replay price`}>
        Buy
      </button>
      <button className="btn small sell" onClick={() => void trade('sell')} data-tip={cfg.market === 'spot' ? `Sell ${base} you hold` : `Sell / short ${base} at the replay price`}>
        Sell
      </button>
      {pos && (
        <button className="btn small ghost" onClick={() => void close()} data-tip="Close the position at the replay price">
          Close
        </button>
      )}
      {acct && (
        <span className="replay-pnl num" data-tip={`Replay account · equity ${fmtUsd(acct.equity)}`}>
          {pos ? (
            <>
              {pos.side === 1 ? 'L' : 'S'} {fmtNum(pos.qty, 4)} <span className={pos.uPnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(pos.uPnl)}</span> ·{' '}
            </>
          ) : null}
          <span className={pnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(pnl)}</span>
        </span>
      )}
      <span className="replay-sep" />
      <button className="icon-btn" onClick={() => void api.call('replay:stop').catch(fail('Replay'))} data-tip="Exit replay (back to real time)">
        <Icon name="x" />
      </button>
      {speedMenu.anchor && (
        <Menu
          anchor={speedMenu.anchor}
          onClose={speedMenu.close}
          width={190}
          items={REPLAY_SPEEDS.map((s) => ({ label: s.label, icon: s.value === view.speed ? 'check' : undefined, onClick: () => void cmd({ cmd: 'speed', value: s.value }) }))}
        />
      )}
      {ivMenu.anchor && (
        <Menu
          anchor={ivMenu.anchor}
          onClose={ivMenu.close}
          width={230}
          items={[
            { label: `Auto (${ivLabel(view.interval)} at this speed)`, icon: view.resolution === 'auto' ? 'check' : undefined, onClick: () => void cmd({ cmd: 'resolution', value: 'auto' }) },
            { sep: true },
            ...view.intervals.map((iv) => ({ label: `${ivLabel(iv)} klines`, icon: view.resolution === iv ? 'check' : undefined, onClick: () => void cmd({ cmd: 'resolution', value: iv }) })),
          ]}
        />
      )}
      {startMenu.anchor && (
        <Menu
          anchor={startMenu.anchor}
          onClose={startMenu.close}
          width={230}
          items={[
            { label: 'Select a bar on the chart', icon: 'cursor', onClick: onPick },
            { label: 'Go to a date…', icon: 'history', onClick: () => datePop.open(startMenu.anchor ? document.querySelector(`[data-replay-date="${moduleId}"]`) : null) },
            {
              label: 'Random point',
              icon: 'zap',
              onClick: () => {
                const span = 2 * 365 * 86400000;
                const t = Date.now() - 86400000 * 2 - Math.random() * span;
                void cmd({ cmd: 'jump', value: t - (t % 60000), owner: moduleId });
              },
            },
          ]}
        />
      )}
      <span data-replay-date={moduleId} />
      {datePop.anchor && (
        <Popover anchor={datePop.anchor} onClose={datePop.close} width={250}>
          <div className="pop-pad">
            <div className="set-group-title">Start the replay at</div>
            <input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
            <button
              className="btn small primary"
              disabled={!date}
              onClick={() => {
                const t = new Date(date).getTime();
                if (isFinite(t)) void cmd({ cmd: 'jump', value: t, owner: moduleId });
                datePop.close();
              }}
            >
              Start here
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Strip shown on market-data modules that keep showing live data while the window replays. */
export function ReplayLiveNotice({ what }: { what: string }) {
  const view = useReplayView();
  if (!view) return null;
  return (
    <div className="replay-notice">
      <Icon name="replay" size={13} />
      <span className="ellipsis" data-tip={`Live data — ${what}. Charts, indicators and replay trading follow the replay.`}>
        Live — {what}
      </span>
    </div>
  );
}
