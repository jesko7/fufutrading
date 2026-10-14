import { useEffect, useRef, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { useSize } from '../../lib/hooks';
import { Tabs, Menu, usePopover, confirmDialog, promptDialog, NumberField, Empty } from '../../components/ui';
import { Icon, CoinIcon } from '../../components/Icon';
import { AccountSelect, useAccounts, useAccount, resolveAccountId, statusBadge, openCreateAccount, usePresets, ProfileSummary } from './accounts';
import type { AccountSnapshot, ClosedTrade, Fill, AccountEvent } from '../../../shared/trading/types';
import { SYMBOL_SPECS, priceDecimals, qtyDecimals } from '../../../shared/symbols';
import { clsx, fmtNum, fmtUsd, fmtSignedUsd, fmtPct, fmtDateTime, fmtDuration, fmtTime } from '../../lib/format';
import { describeOrderUi } from './util';
import { useReplayView } from '../chart/replay';
import './trading.css';

type Tab = 'positions' | 'orders' | 'trades' | 'events' | 'equity' | 'rules';

export function AccountModule({ module }: ModuleProps) {
  const cfg = module.config as { accountId: string | null; tab?: Tab };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const accounts = useAccounts();
  // while the window replays, the replay accounts can be inspected here as well
  const replay = useReplayView();
  const replayAccts = replay ? (Object.entries(replay.accounts).filter(([, v]) => !!v) as [string, string][]) : [];
  const [replayPick, setReplayPick] = useState<string | null>(null);
  const showReplay = !!replay && replayPick !== null && replayAccts.some(([, v]) => v === replayPick);
  const id = showReplay ? replayPick : resolveAccountId(cfg.accountId, accounts);
  const a = useAccount(id);
  const tab: Tab = cfg.tab || 'positions';
  const menu = usePopover();
  const [history, setHistory] = useState<{ fills: Fill[]; trades: ClosedTrade[]; events: AccountEvent[]; equity: [number, number, number][] } | null>(null);
  useEffect(() => {
    if (!id || (tab !== 'trades' && tab !== 'events' && tab !== 'equity')) return;
    let alive = true;
    const load = () => api.call('trading:history', id).then((h) => alive && setHistory(h));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, tab]);

  const replayStrip = replayAccts.length ? (
    <div className="replay-notice" style={{ gap: 8 }}>
      <Icon name="replay" size={13} />
      <span>Replay running</span>
      <span className="spacer" />
      <button className={clsx('btn small ghost', !showReplay && 'on')} onClick={() => setReplayPick(null)}>
        Live accounts
      </button>
      {replayAccts.map(([m, v]) => (
        <button key={v} className={clsx('btn small ghost', showReplay && replayPick === v && 'on')} onClick={() => setReplayPick(v)}>
          Replay {m}
        </button>
      ))}
    </div>
  ) : null;

  if (!accounts.length && !showReplay)
    return (
      <>
      {replayStrip}
      <Empty icon="wallet" title="No paper accounts">
        <div className="col" style={{ alignItems: 'center' }}>
          Create a manual or bot account — standard, or with FTMO / Lucid prop-firm rules.
          <button className="btn primary" onClick={() => openCreateAccount((nid) => set({ accountId: nid }))}>
            <Icon name="plus" size={14} /> New paper account
          </button>
        </div>
      </Empty>
      </>
    );
  if (!a) return <div className="empty"><span className="spinner" /></div>;

  const isFut = a.config.market === 'futures';
  const ret = (a.equity / a.config.initialBalance - 1) * 100;
  const menuItems = [
    { label: 'New account…', icon: 'plus', onClick: () => openCreateAccount((nid) => set({ accountId: nid })) },
    {
      label: 'Rename…',
      icon: 'edit',
      onClick: async () => {
        const n = await promptDialog({ title: 'Rename account', initial: a.config.name });
        if (n) await api.call('trading:update', a.config.id, { name: n });
      },
    },
    { label: 'Make default for quick trading', icon: 'star', onClick: () => useApp.getState().updateSettings({ trading: { ...useApp.getState().settings.trading, defaultAccountId: a.config.id } }) },
    { sep: true },
    { label: 'Close all positions & orders', icon: 'x', onClick: () => api.call('trading:flatten', a.config.id) },
    {
      label: 'Reset account…',
      icon: 'refresh',
      onClick: async () => {
        if (await confirmDialog({ title: 'Reset account?', body: 'All positions, orders and history are cleared and the balance returns to its initial value.', confirm: 'Reset', danger: true })) await api.call('trading:reset', a.config.id);
      },
    },
    { label: 'Archive', icon: 'folder', onClick: () => api.call('trading:update', a.config.id, { archived: true }) },
    {
      label: 'Delete…',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: 'Delete account?', body: `“${a.config.name}” and its history will be deleted permanently.`, confirm: 'Delete', danger: true })) await api.call('trading:delete', a.config.id);
      },
    },
  ];

  return (
    <div className="acct">
      {replayStrip}
      <HeadControls>
        {showReplay ? <span className="badge warn">{a.config.name}</span> : <AccountSelect value={id} onChange={(nid) => set({ accountId: nid })} />}
        {statusBadge(a)}
        <div className="spacer" />
        <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)}>
          <Icon name="sliders" />
        </button>
        {menu.anchor && <Menu anchor={menu.anchor} items={menuItems} onClose={menu.close} align="end" width={250} />}
      </HeadControls>
      <div className="acct-stats">
        <Stat k="Equity" v={fmtUsd(a.equity)} sub={<span className={ret >= 0 ? 'up' : 'down'}>{fmtPct(ret)}</span>} />
        <Stat k="Available" v={fmtUsd(a.available)} />
        <Stat k="Unrealized" v={<span className={a.unrealizedPnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(a.unrealizedPnl)}</span>} />
        <Stat k="Realized" v={<span className={a.realizedPnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(a.realizedPnl)}</span>} />
        <Stat k="Today" v={<span className={a.dayPnl >= 0 ? 'up' : 'down'}>{fmtSignedUsd(a.dayPnl)}</span>} />
        <Stat k="Fees" v={fmtUsd(a.feesPaid)} />
        {isFut && <Stat k="Funding" v={fmtSignedUsd(-a.fundingPaid)} />}
        {isFut && <Stat k="Margin ratio" v={<span className={a.marginRatio >= a.config.futures.marginCallRatio ? 'down' : ''}>{isFinite(a.marginRatio) ? `${(a.marginRatio * 100).toFixed(1)}%` : '∞'}</span>} sub={<span className="faint">liq. at 100%</span>} />}
        <Stat k="Exposure" v={fmtUsd(a.exposure)} />
      </div>
      {a.rules && <RulesStrip a={a} onDetails={() => set({ tab: 'rules' })} />}
      <div className="row" style={{ padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
        <Tabs
          value={tab}
          onChange={(t) => set({ tab: t })}
          tabs={[
            { value: 'positions', label: 'Positions', badge: a.positions.length || undefined },
            { value: 'orders', label: 'Orders', badge: a.orders.length || undefined },
            { value: 'trades', label: 'Trades' },
            { value: 'equity', label: 'Equity' },
            { value: 'events', label: 'Log' },
            ...(a.rules ? [{ value: 'rules' as Tab, label: 'Rules' }] : []),
          ]}
        />
      </div>
      <div className="mod-scroll">
        {tab === 'positions' && <Positions a={a} />}
        {tab === 'orders' && <Orders a={a} />}
        {tab === 'trades' && <Trades trades={history?.trades || []} />}
        {tab === 'equity' && <EquityChart points={history?.equity || []} initial={a.config.initialBalance} />}
        {tab === 'events' && <Events events={history?.events || []} />}
        {tab === 'rules' && a.rules && <RulesDetail a={a} />}
      </div>
    </div>
  );
}

export function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {sub && <span style={{ fontSize: 11 }}>{sub}</span>}
    </div>
  );
}

export function Positions({ a, readOnly }: { a: AccountSnapshot; readOnly?: boolean }) {
  if (!a.positions.length) return <Empty icon="wallet" title="No open positions" />;
  const isFut = a.config.market === 'futures';
  const act = (p: Promise<unknown>, what: string) => p.catch((e) => toast({ title: `${what} failed`, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' }));
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="r">Size</th>
          <th className="r">Entry</th>
          <th className="r">Mark</th>
          {isFut && <th className="r">Liq. price</th>}
          {isFut && <th className="r">Margin</th>}
          <th className="r">P&L</th>
          <th>TP / SL</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {a.positions.map((p) => {
          const pd = priceDecimals(p.symbol, a.config.market);
          return (
            <tr key={p.symbol}>
              <td>
                <div className="row" style={{ gap: 6 }}>
                  <CoinIcon symbol={p.symbol} size={14} />
                  <b>{SYMBOL_SPECS[p.symbol].base}</b>
                  <span className={clsx('badge', p.side === 1 ? 'ok' : 'danger')}>{isFut ? `${p.side === 1 ? 'Long' : 'Short'} ${p.leverage}x` : 'Long'}</span>
                  {isFut && <span className="faint" style={{ fontSize: 11 }}>{p.marginMode}</span>}
                </div>
              </td>
              <td className="r">{fmtNum(p.qty, qtyDecimals(p.symbol, a.config.market))}</td>
              <td className="r">{fmtNum(p.entry, pd)}</td>
              <td className="r">{fmtNum(p.mark, pd)}</td>
              {isFut && <td className="r" style={{ color: 'var(--warn)' }}>{p.liqPrice > 0 ? fmtNum(p.liqPrice, pd) : '—'}</td>}
              {isFut && (
                <td className="r">
                  {p.marginMode === 'isolated' ? fmtUsd(p.isolatedMargin) : fmtUsd(p.notional / p.leverage)}
                  {p.marginMode === 'isolated' && (
                    <button
                      className="icon-btn small"
                      data-tip="Add / remove isolated margin"
                      onClick={async () => {
                        const v = await promptDialog({ title: 'Adjust isolated margin', label: 'USDT (negative to remove)', initial: '100' });
                        if (v && isFinite(+v)) void act(api.call('trading:adjustMargin', a.config.id, p.symbol, +v), 'Margin change');
                      }}
                    >
                      <Icon name="plus" size={12} />
                    </button>
                  )}
                </td>
              )}
              <td className={clsx('r', p.uPnl >= 0 ? 'up' : 'down')}>
                {fmtSignedUsd(p.uPnl)} <span style={{ fontSize: 11 }}>({fmtPct(p.uPnlPct, 1)})</span>
              </td>
              <td>
                {readOnly ? (
                  <span className="row" style={{ gap: 4 }}>
                    <span className="up num">{p.tp ? fmtNum(p.tp, pd) : '—'}</span>/<span className="down num">{p.sl ? fmtNum(p.sl, pd) : '—'}</span>
                  </span>
                ) : (
                  <BracketCell a={a} symbol={p.symbol} tp={p.tp} sl={p.sl} pd={pd} />
                )}
              </td>
              <td className="r">
                {!readOnly && (
                  <>
                    <button className="btn small" onClick={() => act(api.call('trading:close', a.config.id, p.symbol, +(p.qty / 2).toFixed(8)), 'Close')} data-tip="Close half at market">
                      ½
                    </button>{' '}
                    <button className="btn small" onClick={() => act(api.call('trading:close', a.config.id, p.symbol), 'Close')}>
                      Close
                    </button>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BracketCell({ a, symbol, tp, sl, pd }: { a: AccountSnapshot; symbol: string; tp?: number; sl?: number; pd: number }) {
  const [edit, setEdit] = useState(false);
  const [tpV, setTp] = useState<number | null>(tp ?? null);
  const [slV, setSl] = useState<number | null>(sl ?? null);
  if (!edit)
    return (
      <span className="row" style={{ gap: 4, cursor: 'pointer' }} onClick={() => (setTp(tp ?? null), setSl(sl ?? null), setEdit(true))} data-tip="Edit (or drag the lines on the chart)">
        <span className="up num">{tp ? fmtNum(tp, pd) : '—'}</span>/<span className="down num">{sl ? fmtNum(sl, pd) : '—'}</span>
        <Icon name="edit" size={12} />
      </span>
    );
  return (
    <span className="row" style={{ gap: 4 }}>
      <NumberField value={tpV} onChange={setTp} style={{ width: 90 }} placeholder="TP" />
      <NumberField value={slV} onChange={setSl} style={{ width: 90 }} placeholder="SL" />
      <button
        className="icon-btn small"
        onClick={async () => {
          try {
            await api.call('trading:setBrackets', a.config.id, symbol, { tp: tpV || null, sl: slV || null });
            setEdit(false);
          } catch (e) {
            toast({ title: 'TP/SL not set', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });
          }
        }}
      >
        <Icon name="check" size={14} />
      </button>
      <button className="icon-btn small" onClick={() => setEdit(false)}>
        <Icon name="x" size={14} />
      </button>
    </span>
  );
}

export function Orders({ a, readOnly }: { a: AccountSnapshot; readOnly?: boolean }) {
  if (!a.orders.length) return <Empty icon="list" title="No open orders" />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Order</th>
          <th className="r">Filled</th>
          <th>Source</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {a.orders.map((o) => (
          <tr key={o.id}>
            <td className="faint">{fmtTime(o.createdAt, true)}</td>
            <td>
              <span className={o.side === 'buy' ? 'up' : 'down'}>{describeOrderUi(o)}</span>
              {o.reason && o.source === 'bot' && <span className="faint" style={{ marginLeft: 6 }}>{o.reason}</span>}
              {o.reduceOnly && <span className="badge" style={{ marginLeft: 6 }}>reduce</span>}
              {o.trigger === 'mark' && o.stopPrice && <span className="badge" style={{ marginLeft: 6 }}>mark</span>}
            </td>
            <td className="r">{o.filledQty ? fmtNum(o.filledQty, 4) : '—'}</td>
            <td className="faint">{o.source}</td>
            <td className="r">
              {!readOnly && (
                <button className="btn small" onClick={() => api.call('trading:cancel', a.config.id, o.id).catch((e) => toast({ title: 'Cancel failed', body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' }))}>
                  Cancel
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Trades({ trades }: { trades: ClosedTrade[] }) {
  if (!trades.length) return <Empty icon="history" title="No closed trades yet" />;
  const list = trades.slice().reverse();
  const wins = trades.filter((t) => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return (
    <>
      <div className="row" style={{ padding: '6px 10px', fontSize: 12 }}>
        <span className="faint">{trades.length} trades</span>
        <span>Win rate {((wins / trades.length) * 100).toFixed(1)}%</span>
        <span className={total >= 0 ? 'up' : 'down'}>Net {fmtSignedUsd(total)}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th className="r">Size</th>
            <th className="r">Entry → Exit</th>
            <th className="r">Net P&L</th>
            <th className="r">Fees</th>
            <th>Duration</th>
            <th>Exit</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id + t.closedAt}>
              <td className="faint">{fmtDateTime(t.closedAt)}</td>
              <td>
                <span className={t.side === 1 ? 'up' : 'down'}>{t.side === 1 ? 'Long' : 'Short'}</span> {SYMBOL_SPECS[t.symbol].base}
              </td>
              <td className="r">{fmtNum(t.qty, 4)}</td>
              <td className="r">
                {fmtNum(t.entry, 2)} → {fmtNum(t.exit, 2)}
              </td>
              <td className={clsx('r', t.pnl >= 0 ? 'up' : 'down')}>{fmtSignedUsd(t.pnl)}</td>
              <td className="r faint">{fmtUsd(t.fees)}</td>
              <td className="faint">{fmtDuration(t.closedAt - t.openedAt)}</td>
              <td className="faint">{t.exitReason || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Events({ events }: { events: AccountEvent[] }) {
  if (!events.length) return <Empty icon="list" title="No activity yet" />;
  const color: Record<string, string> = { liquidation: 'var(--danger)', marginCall: 'var(--warn)', rule: 'var(--warn)', error: 'var(--danger)', fill: 'var(--ok)', funding: 'var(--info)' };
  return (
    <div style={{ padding: '4px 10px' }}>
      {events
        .slice()
        .reverse()
        .map((e, i) => (
          <div key={i} className="row selectable" style={{ alignItems: 'flex-start', padding: '3px 0', fontSize: 12 }}>
            <span className="faint num" style={{ width: 130, flex: 'none' }}>
              {fmtDateTime(e.t, true)}
            </span>
            <span className="dot" style={{ background: color[e.kind] || 'var(--text-3)', marginTop: 5 }} />
            <span style={{ lineHeight: 1.45 }}>{e.message}</span>
          </div>
        ))}
    </div>
  );
}

export function EquityChart({ points, initial }: { points: [number, number, number][]; initial: number }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c || !size.width || points.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.width * dpr;
    c.height = size.height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const W = size.width;
    const H = size.height;
    const pad = 28;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      lo = Math.min(lo, p[1], initial);
      hi = Math.max(hi, p[1], initial);
    }
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const X = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - pad * 2);
    const Y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - pad * 2);
    ctx.strokeStyle = css.getPropertyValue('--border').trim();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, Y(initial));
    ctx.lineTo(W - pad, Y(initial));
    ctx.stroke();
    ctx.setLineDash([]);
    const up = points[points.length - 1][1] >= initial;
    const col = css.getPropertyValue(up ? '--up' : '--down').trim();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.stroke();
    ctx.lineTo(X(t1), H - pad);
    ctx.lineTo(X(t0), H - pad);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = col;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = css.getPropertyValue('--text-3').trim();
    ctx.font = '11px system-ui';
    ctx.fillText(fmtUsd(hi), 4, Y(hi) - 4);
    ctx.fillText(fmtUsd(lo), 4, Y(lo) + 12);
    ctx.fillText(fmtDateTime(t0), pad, H - 8);
    ctx.textAlign = 'right';
    ctx.fillText(fmtDateTime(t1), W - pad, H - 8);
    ctx.textAlign = 'left';
  }, [points, size.width, size.height, initial]);
  if (points.length < 2) return <Empty icon="chart" title="Equity curve">Equity is sampled every minute while positions are open.</Empty>;
  return (
    <div ref={ref} style={{ height: '100%', minHeight: 160, position: 'relative' }}>
      <canvas ref={cv} style={{ position: 'absolute', inset: 0, width: size.width, height: size.height }} />
    </div>
  );
}

function RulesStrip({ a, onDetails }: { a: AccountSnapshot; onDetails: () => void }) {
  const r = a.rules!;
  return (
    <div className="rules-strip" onClick={onDetails} data-tip="Click for all rules">
      <span className="badge accent">{r.firm === 'FTMO' ? 'FTMO' : 'LUCID'}</span>
      <span className="muted">
        {r.program} · {r.phase}
      </span>
      {r.checks
        .filter((c) => c.id !== 'size')
        .map((c) => (
          <span key={c.id} className="rule-chip" title={c.detail}>
            <span className={clsx('dot')} style={{ background: c.severity === 'breach' ? 'var(--danger)' : c.severity === 'warn' ? 'var(--warn)' : c.severity === 'pass' ? 'var(--ok)' : 'var(--text-3)' }} />
            {c.label.replace(/ \(.*\)$/, '')}: <b className="num">{c.value}</b>
          </span>
        ))}
    </div>
  );
}

function RulesDetail({ a }: { a: AccountSnapshot }) {
  const presets = usePresets();
  const r = a.rules!;
  const profile = presets?.profiles.find((p) => p.id === r.profileId);
  return (
    <div className="col" style={{ padding: 12, gap: 10 }}>
      {r.status !== 'active' && <div className={clsx('callout', r.status === 'breached' ? 'danger' : r.status === 'passed' ? '' : 'warn')}>{r.reason}</div>}
      {r.status === 'passed' && r.next && (
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => api.call('trading:nextPhase', a.config.id).then(() => toast({ title: 'Next phase created', kind: 'ok' }))}>
          Start next phase
        </button>
      )}
      {r.checks.map((c) => (
        <div key={c.id} className="col" style={{ gap: 4 }}>
          <div className="row">
            <span style={{ fontWeight: 600 }}>{c.label}</span>
            <div className="spacer" />
            <span className="num">{c.value}</span>
          </div>
          {c.progress !== undefined && (
            <div className="progress">
              <div style={{ width: `${(c.progress * 100).toFixed(1)}%`, background: c.severity === 'breach' ? 'var(--danger)' : c.severity === 'warn' ? 'var(--warn)' : c.severity === 'pass' ? 'var(--ok)' : 'var(--accent)' }} />
            </div>
          )}
          {c.detail && <div className="hint">{c.detail}</div>}
        </div>
      ))}
      {profile && <ProfileSummary profile={profile} />}
    </div>
  );
}

export { fmtDateTime };
