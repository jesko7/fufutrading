import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { useTopicValue } from '../../lib/hooks';
import type { AccountConfig, AccountSnapshot, AccountEvent, BotConfig } from '../../../shared/trading/types';
import type { CostPreset, AccountPreset } from '../../../shared/trading/presets';
import type { RuleProfile } from '../../../shared/propfirm/types';
import { Modal, Segmented, Field, NumberField, Select, Toggle, Popover, usePopover, openModal } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { clsx, fmtUsd } from '../../lib/format';
import type { Market } from '../../../shared/symbols';

export interface Presets {
  costPresets: CostPreset[];
  accountPresets: AccountPreset[];
  profiles: RuleProfile[];
  brackets: { verifiedAt: string; source: string };
}

let presetsCache: Presets | null = null;
export function usePresets(): Presets | null {
  const [p, setP] = useState<Presets | null>(presetsCache);
  useEffect(() => {
    if (!presetsCache)
      void api.call<Presets>('trading:presets').then((x) => {
        presetsCache = x;
        setP(x);
      });
  }, []);
  return p;
}

export function useAccounts(): AccountSnapshot[] {
  return useTopicValue<AccountSnapshot[]>('accounts', {}) || [];
}

export function useAccount(id: string | null | undefined, onEvent?: (e: AccountEvent) => void): AccountSnapshot | null {
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  useEffect(() => {
    setSnap(null);
    if (!id) return;
    let raf = 0;
    let pending: AccountSnapshot | null = null;
    return api.sub<{ snapshot?: AccountSnapshot; event?: AccountEvent; missing?: boolean }>('account', { id }, (m) => {
      if (m.event) onEvent?.(m.event);
      if (m.missing) setSnap(null);
      if (m.snapshot) {
        pending = m.snapshot;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            setSnap(pending);
          });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return snap;
}

/** Resolve which account a module should use. */
export function resolveAccountId(preferred: string | null | undefined, accounts: AccountSnapshot[], market?: Market): string | null {
  if (preferred && accounts.some((a) => a.config.id === preferred)) return preferred;
  const def = useApp.getState().settings.trading.defaultAccountId;
  const usable = accounts.filter((a) => !a.config.archived && (!market || a.config.market === market));
  if (def && usable.some((a) => a.config.id === def)) return def;
  return usable[0]?.config.id || accounts.find((a) => !a.config.archived)?.config.id || null;
}

export function statusBadge(s: AccountSnapshot) {
  const map: Record<string, string> = { active: 'ok', restricted: 'warn', breached: 'danger', passed: 'accent', liquidated: 'danger' };
  return <span className={clsx('badge', map[s.status])}>{s.status === 'active' ? (s.config.prop ? 'Compliant' : 'Active') : s.status[0].toUpperCase() + s.status.slice(1)}</span>;
}

export function AccountSelect({ value, onChange, market, compact }: { value: string | null; onChange: (id: string) => void; market?: Market; compact?: boolean }) {
  const accounts = useAccounts();
  const pop = usePopover();
  const cur = accounts.find((a) => a.config.id === value);
  return (
    <>
      <button className="sym-btn" onClick={(e) => pop.toggle(e.currentTarget)} data-tip="Paper account">
        <span className="dot" style={{ background: cur?.config.color || 'var(--text-3)' }} />
        <span className="ellipsis" style={{ maxWidth: compact ? 110 : 170 }}>
          {cur ? cur.config.name : 'No account'}
        </span>
        {cur?.config.kind === 'bot' && <span className="badge info">BOT</span>}
        <Icon name="chevDown" size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={300}>
          {accounts.filter((a) => !a.config.archived).length === 0 && <div className="faint" style={{ padding: 9 }}>No paper accounts yet.</div>}
          {accounts
            .filter((a) => !a.config.archived)
            .map((a) => (
              <div
                key={a.config.id}
                className={clsx('menu-item', a.config.id === value && 'hl')}
                style={{ height: 'auto', padding: '6px 9px', opacity: market && a.config.market !== market ? 0.55 : 1 }}
                onClick={() => {
                  pop.close();
                  onChange(a.config.id);
                }}
              >
                <span className="dot" style={{ background: a.config.color }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b className="ellipsis">{a.config.name}</b>
                    {a.config.kind === 'bot' && <span className="badge info">BOT</span>}
                    {a.config.prop && <span className="badge accent">{a.config.prop.firm === 'FTMO' ? 'FTMO' : 'LUCID'}</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {a.config.market === 'spot' ? 'Spot' : 'Futures'} · {fmtUsd(a.equity)}
                  </div>
                </div>
                {statusBadge(a)}
              </div>
            ))}
          <div className="menu-sep" />
          <div
            className="menu-item"
            onClick={() => {
              pop.close();
              openCreateAccount((id) => onChange(id));
            }}
          >
            <Icon name="plus" size={15} /> New paper account…
          </div>
        </Popover>
      )}
    </>
  );
}

/** Defaults for the new-account dialog; `bot` prefills a bot (strategy, inputs, instrument) to review and start. */
export interface CreateAccountDefaults {
  kind?: 'manual' | 'bot';
  template?: 'generic' | 'prop';
  market?: Market;
  name?: string;
  bot?: Partial<BotConfig>;
}

export function openCreateAccount(onCreated?: (id: string) => void, defaults?: CreateAccountDefaults): void {
  openModal('create-account', (close) => <CreateAccountModal onClose={close} onCreated={onCreated} defaults={defaults} />);
}

function CreateAccountModal({ onClose, onCreated, defaults }: { onClose: () => void; onCreated?: (id: string) => void; defaults?: CreateAccountDefaults }) {
  const presets = usePresets();
  const [kind, setKind] = useState<'manual' | 'bot'>(defaults?.kind || 'manual');
  const [template, setTemplate] = useState<'generic' | 'prop'>(defaults?.template || 'generic');
  const [presetId, setPresetId] = useState((defaults?.market || defaults?.bot?.market) === 'spot' ? 'spot-10k' : 'perp-10k');
  const [name, setName] = useState(defaults?.name || '');
  const [market, setMarket] = useState<Market>('futures');
  const [balance, setBalance] = useState(10000);
  const [costPreset, setCostPreset] = useState('binance-futures');
  const [leverage, setLeverage] = useState(10);
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [advanced, setAdvanced] = useState(false);
  const [limitFill, setLimitFill] = useState<'touch' | 'through'>('through');
  const [partial, setPartial] = useState(false);
  const [stopTrigger, setStopTrigger] = useState<'last' | 'mark'>('last');
  const [maxDailyLoss, setMaxDailyLoss] = useState(0);
  const [firm, setFirm] = useState<'FTMO' | 'Lucid Trading'>('FTMO');
  const [profileId, setProfileId] = useState('ftmo-2step-challenge');
  const [size, setSize] = useState(100000);
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  const profile = presets?.profiles.find((p) => p.id === profileId);
  const firmProfiles = useMemo(() => presets?.profiles.filter((p) => p.firm === firm) || [], [presets, firm]);
  useEffect(() => {
    const ap = presets?.accountPresets.find((p) => p.id === presetId);
    if (!ap) return;
    setMarket(ap.market);
    setBalance(ap.initialBalance);
    setCostPreset(ap.costPreset);
    if (ap.futures?.defaultLeverage) setLeverage(ap.futures.defaultLeverage);
    if (ap.futures?.marginMode) setMarginMode(ap.futures.marginMode);
    if (ap.risk?.maxDailyLossPct !== undefined) setMaxDailyLoss(ap.risk.maxDailyLossPct);
  }, [presetId, presets]);
  useEffect(() => {
    if (!profile) return;
    if (!profile.sizes.includes(size)) setSize(profile.sizes[Math.min(2, profile.sizes.length - 1)]);
    setLeverage(profile.leverage.default);
    setCostPreset(profile.costPreset);
    const o: Record<string, unknown> = {};
    for (const op of profile.options || []) o[op.key] = op.default;
    setOptions(o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);
  useEffect(() => {
    const first = firmProfiles[0];
    if (first && !firmProfiles.some((p) => p.id === profileId)) setProfileId(first.id);
  }, [firm, firmProfiles, profileId]);

  if (!presets) return null;
  const cp = presets.costPresets.find((c) => c.id === costPreset);

  const create = async () => {
    setBusy(true);
    try {
      const req: any = {
        name: name.trim() || (template === 'prop' && profile ? `${profile.firm} ${profile.program} · ${profile.phase}` : `${market === 'spot' ? 'Spot' : 'Futures'} ${kind === 'bot' ? 'bot' : 'account'}`),
        kind,
        market: template === 'prop' ? 'futures' : market,
        initialBalance: template === 'prop' ? size : balance,
        costPreset,
        futures: { defaultLeverage: leverage, marginMode },
        risk: { maxDailyLossPct: maxDailyLoss, ...(template === 'prop' ? {} : { maxLeverage: market === 'spot' ? 1 : Math.max(leverage, 20) }) },
        execution: { limitFill, partialFills: partial, stopTrigger },
      };
      if (template === 'prop' && profile) req.prop = { profileId: profile.id, size, options };
      if (kind === 'bot') req.bot = { scriptId: '', language: 'pine', params: {}, symbol: 'BTCUSDT', tf: '15m', chartType: 'candles', sizing: { mode: 'percentEquity', value: 10 }, autostart: true, ...(defaults?.bot || {}), market: req.market, status: 'stopped' };
      const cfg = await api.call<AccountConfig>('trading:create', req);
      toast({ title: 'Account created', body: cfg.name, kind: 'ok' });
      if (!useApp.getState().settings.trading.defaultAccountId) void useApp.getState().updateSettings({ trading: { ...useApp.getState().settings.trading, defaultAccountId: cfg.id } });
      onCreated?.(cfg.id);
      onClose();
    } catch (e) {
      toast({ title: 'Could not create account', body: errorMessage(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New paper account"
      icon="wallet"
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="hint grow">All trading is simulated. No real orders are sent.</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
          {(['manual', 'bot'] as const).map((k) => (
            <div key={k} className={clsx('card', 'grow')} style={{ cursor: 'pointer', borderColor: kind === k ? 'var(--accent)' : undefined, flex: 1 }} onClick={() => setKind(k)}>
              <div className="row" style={{ fontWeight: 650 }}>
                <Icon name={k === 'manual' ? 'user' : 'bot'} /> {k === 'manual' ? 'Manual account' : 'Bot account'}
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {k === 'manual' ? 'You place and manage orders from the chart, order book, trade panel and shortcuts.' : 'A Pine Script or Python strategy trades automatically. Runs in the background when enabled.'}
              </div>
            </div>
          ))}
        </div>
        <Segmented value={template} onChange={setTemplate} options={[{ value: 'generic', label: 'Standard account' }, { value: 'prop', label: 'Prop-firm rules (FTMO / Lucid)' }]} />
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
        </Field>
        {template === 'generic' ? (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {presets.accountPresets.map((p) => (
                <button key={p.id} className={clsx('btn small', presetId === p.id && 'primary')} onClick={() => setPresetId(p.id)} data-tip={p.description}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
              <Field label="Market" style={{ width: 230 }}>
                <Segmented
                  value={market}
                  onChange={(m) => {
                    setMarket(m);
                    setCostPreset(m === 'spot' ? 'binance-spot' : 'binance-futures');
                  }}
                  options={[{ value: 'spot', label: 'Spot' }, { value: 'futures', label: 'USDⓈ-M Perpetual' }]}
                />
              </Field>
              <Field label="Initial balance (USDT)" style={{ width: 180 }}>
                <NumberField value={balance} min={10} step={1000} onChange={setBalance} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Firm" style={{ width: 200 }}>
                <Segmented value={firm} onChange={setFirm} options={[{ value: 'FTMO', label: 'FTMO' }, { value: 'Lucid Trading', label: 'Lucid Trading' }]} />
              </Field>
              <Field label="Program & phase" style={{ minWidth: 260 }}>
                <Select value={profileId} onChange={setProfileId} options={firmProfiles.map((p) => ({ value: p.id, label: `${p.program} — ${p.phase}` }))} />
              </Field>
              <Field label="Account size (USD)" style={{ width: 170 }}>
                <Select value={String(size)} onChange={(v) => setSize(+v)} options={(profile?.sizes || []).map((s) => ({ value: String(s), label: `$${s.toLocaleString()}` }))} />
              </Field>
            </div>
            {profile && (
              <>
                {(profile.options || []).map((op) => (
                  <div key={op.key} className="row">
                    <span className="grow">{op.label}</span>
                    {op.type === 'bool' ? (
                      <Toggle value={!!options[op.key]} onChange={(v) => setOptions({ ...options, [op.key]: v })} />
                    ) : (
                      <Select value={String(options[op.key] ?? op.default)} onChange={(v) => setOptions({ ...options, [op.key]: v })} options={op.values || []} />
                    )}
                  </div>
                ))}
                <ProfileSummary profile={profile} />
              </>
            )}
          </>
        )}
        <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Trading costs" style={{ minWidth: 260 }} hint={cp?.description}>
            <Select value={costPreset} onChange={setCostPreset} options={presets.costPresets.map((c) => ({ value: c.id, label: c.label }))} />
          </Field>
          {(template === 'prop' || market === 'futures') && (
            <>
              <Field label={`Default leverage${template === 'prop' && profile ? ` (max ${profile.leverage.max}x)` : ''}`} style={{ width: 150 }}>
                <NumberField value={leverage} min={1} max={template === 'prop' && profile ? profile.leverage.max : 125} step={1} onChange={setLeverage} suffix="x" />
              </Field>
              <Field label="Margin mode" style={{ width: 170 }}>
                <Segmented value={marginMode} onChange={setMarginMode} options={[{ value: 'cross', label: 'Cross' }, { value: 'isolated', label: 'Isolated' }]} />
              </Field>
            </>
          )}
        </div>
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? 'chevDown' : 'chevRight'} size={13} /> Execution & risk settings
        </button>
        {advanced && (
          <div className="card col" style={{ gap: 10 }}>
            <div className="row">
              <span className="grow">
                Limit order fills
                <div className="hint">“Through” only fills when the market trades beyond your price (conservative, models queue position). “Touch” fills at the first print at your price.</div>
              </span>
              <Segmented value={limitFill} onChange={setLimitFill} options={[{ value: 'through', label: 'Through' }, { value: 'touch', label: 'Touch' }]} />
            </div>
            <div className="row">
              <span className="grow">
                Partial fills
                <div className="hint">When touching, fill at most 25% of the volume traded at your price.</div>
              </span>
              <Toggle value={partial} onChange={setPartial} />
            </div>
            {(template === 'prop' || market === 'futures') && (
              <div className="row">
                <span className="grow">
                  SL/TP trigger price
                  <div className="hint">Binance lets you trigger stops on the last price or the mark price.</div>
                </span>
                <Segmented value={stopTrigger} onChange={setStopTrigger} options={[{ value: 'last', label: 'Last' }, { value: 'mark', label: 'Mark' }]} />
              </div>
            )}
            <div className="row">
              <span className="grow">
                Daily loss stop (% of start-of-day equity)
                <div className="hint">0 = off. Blocks new risk once reached (closing is always allowed).</div>
              </span>
              <NumberField value={maxDailyLoss} min={0} max={100} step={0.5} onChange={setMaxDailyLoss} style={{ width: 100 }} suffix="%" />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ProfileSummary({ profile }: { profile: RuleProfile }) {
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row">
        <b>
          {profile.firm} · {profile.program} · {profile.phase}
        </b>
        <span className="badge">rules v{profile.version}</span>
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 11 }}>
          Verified {profile.verifiedAt}
        </span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        {profile.implemented.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div className="callout warn">
        <Icon name="alert" size={16} />
        <div>{profile.simulationNote}</div>
      </div>
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>
          Not simulated, ambiguities & sources
        </summary>
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          <div className="hint">Not simulated: {profile.notImplemented.join(' · ')}</div>
          {profile.ambiguities.length > 0 && <div className="hint">Ambiguities: {profile.ambiguities.join(' · ')}</div>}
          <div className="hint">Leverage: {profile.leverage.note}</div>
          <div className="hint">Day boundary: {profile.session.label}</div>
          {profile.sources.map((s) => (
            <a key={s} className="hint selectable" href={s} onClick={(e) => (e.preventDefault(), api.call('shell:openExternal', s))}>
              {s}
            </a>
          ))}
        </div>
      </details>
    </div>
  );
}
