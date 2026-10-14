import { useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { useApp } from '../../state/store';
import { Icon } from '../../components/Icon';
import { Tabs, Empty, Spinner } from '../../components/ui';
import { clsx, fmtUsd, fmtSignedUsd, fmtPct } from '../../lib/format';
import { openModule } from '../../app/moduleOps';
import { useAccounts, useAccount, usePresets, openCreateAccount, ProfileSummary } from './accounts';
import { RulesDetail } from './AccountModule';
import type { AccountSnapshot } from '../../../shared/trading/types';
import './trading.css';

type Tab = 'challenges' | 'programs';

const SEV: Record<string, string> = { breach: 'var(--danger)', warn: 'var(--warn)', pass: 'var(--ok)', info: 'var(--accent)' };

function statusPill(s: AccountSnapshot) {
  const st = s.rules?.status || s.status;
  const label = st === 'passed' ? 'Passed' : st === 'breached' ? 'Breached' : st === 'restricted' ? 'Restricted' : 'Active';
  return <span className={clsx('status-pill', st === 'passed' ? 'promising' : st === 'breached' ? 'rejected' : st === 'restricted' ? 'testing' : 'live')}>{label}</span>;
}

/** Prop-firm challenges at a glance, with all rules and the supported programs. */
export function PropModule({ module }: ModuleProps) {
  const cfg = module.config as { tab?: Tab; accountId?: string | null };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const accounts = useAccounts();
  const presets = usePresets();
  const props = accounts.filter((a) => a.config.prop && !a.config.archived);
  const tab: Tab = cfg.tab || 'challenges';
  const selected = props.find((a) => a.config.id === cfg.accountId) || null;
  return (
    <div className="prop-mod">
      <HeadControls>
        <button className="btn small primary" onClick={() => openCreateAccount((id) => set({ accountId: id, tab: 'challenges' }), { template: 'prop' })}>
          <Icon name="plus" size={13} /> New challenge
        </button>
      </HeadControls>
      <div className="row" style={{ padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
        <Tabs
          value={tab}
          onChange={(t) => set({ tab: t })}
          tabs={[
            { value: 'challenges', label: 'My challenges', badge: props.length || undefined },
            { value: 'programs', label: 'Programs' },
          ]}
        />
      </div>
      <div className="mod-scroll">
        {tab === 'challenges' &&
          (!props.length ? (
            <Empty icon="shield" title="No prop challenges yet">
              <div className="col" style={{ alignItems: 'center', gap: 10 }}>
                <span>Practise an FTMO or Lucid Trading evaluation with its rules — profit target, daily and maximum loss, trading days, consistency — enforced live on a paper account. Trade it by hand or with a bot.</span>
                <button className="btn primary" onClick={() => openCreateAccount((id) => set({ accountId: id }), { template: 'prop' })}>
                  <Icon name="plus" size={14} /> Start a challenge
                </button>
              </div>
            </Empty>
          ) : (
            <div className="prop-body">
              <div className="prop-grid">
                {props.map((a) => (
                  <ChallengeCard key={a.config.id} a={a} on={selected?.config.id === a.config.id} onClick={() => set({ accountId: selected?.config.id === a.config.id ? null : a.config.id })} />
                ))}
              </div>
              {selected && <ChallengeDetail id={selected.config.id} />}
            </div>
          ))}
        {tab === 'programs' &&
          (!presets ? (
            <div className="empty">
              <Spinner />
            </div>
          ) : (
            <div className="prop-programs">
              {presets.profiles.map((p) => (
                <ProfileSummary key={p.id} profile={p} />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function ChallengeCard({ a, on, onClick }: { a: AccountSnapshot; on: boolean; onClick: () => void }) {
  const r = a.rules;
  const pnl = a.equity - a.config.initialBalance;
  return (
    <div className={clsx('prop-card', on && 'on')} onClick={onClick}>
      <div className="row" style={{ gap: 6 }}>
        <span className="badge accent">{r?.firm === 'FTMO' ? 'FTMO' : 'LUCID'}</span>
        <b className="ellipsis grow">{a.config.name}</b>
        {statusPill(a)}
      </div>
      <div className="faint small">
        {r?.program} · {r?.phase} · {fmtUsd(a.config.initialBalance, 0)}
        {a.config.kind === 'bot' ? ' · bot' : ''}
      </div>
      <div className="row" style={{ gap: 12 }}>
        <span className="num" style={{ fontSize: 16, fontWeight: 650 }}>
          {fmtUsd(a.equity)}
        </span>
        <span className={clsx('num', pnl >= 0 ? 'up' : 'down')}>
          {fmtSignedUsd(pnl)} ({fmtPct((pnl / a.config.initialBalance) * 100)})
        </span>
      </div>
      <div className="prop-checks">
        {(r?.checks || [])
          .filter((c) => c.progress !== undefined)
          .slice(0, 4)
          .map((c) => (
            <div key={c.id} className="prop-check">
              <div className="row" style={{ gap: 6 }}>
                <span className="faint ellipsis grow">{c.label.replace(/ \(.*\)$/, '')}</span>
                <span className="num small">{c.value}</span>
              </div>
              <div className="progress thin">
                <div style={{ width: `${Math.max(0, Math.min(100, (c.progress || 0) * 100)).toFixed(1)}%`, background: SEV[c.severity] }} />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function ChallengeDetail({ id }: { id: string }) {
  const a = useAccount(id);
  if (!a || !a.rules)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  return (
    <div className="prop-detail">
      <div className="row" style={{ gap: 8, padding: '10px 12px 0' }}>
        <b>{a.config.name}</b>
        {statusPill(a)}
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => void openModule('account', { accountId: id, tab: 'rules' })}>
          <Icon name="wallet" size={13} /> Open account
        </button>
        <button className="btn small" onClick={() => void openModule('orderEntry', { accountId: id })}>
          <Icon name="trade" size={13} /> Trade
        </button>
      </div>
      <RulesDetail a={a} />
    </div>
  );
}
