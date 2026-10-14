import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { bus } from '../../lib/bus';
import { Icon } from '../../components/Icon';
import { Select, Segmented, Spinner, Toggle, usePopover, Menu, confirmDialog, promptDialog } from '../../components/ui';
import { clsx, fmtAgo, fmtPct } from '../../lib/format';
import { useSize } from '../../lib/hooks';
import { openScriptInEditor } from '../scripts/client';
import { openModule } from '../../app/moduleOps';
import { isSymbol } from '../../../shared/symbols';
import { Markdown } from './markdown';
import { onAIRequest } from './requests';
import './ai.css';

// ------------------------------------------------------------------ types (mirror of main/ai/service)

type Mode = 'build' | 'plan' | 'ask';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
interface Settings {
  model: string;
  mode: Mode;
  effort: Effort;
  thinking: boolean;
}
interface Card {
  kind: string;
  title: string;
  data: Record<string, any>;
}
type Part = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool'; id: string; name: string; input: any; status: 'running' | 'ok' | 'error'; result?: string; card?: Card };
interface Context {
  script?: { id: string; name: string; language: string };
  chart?: { symbol: string; market: string; tf: string };
  error?: string;
  selection?: string;
}
interface Message {
  id: string;
  role: 'user' | 'assistant';
  t: number;
  text?: string;
  context?: Context;
  parts?: Part[];
  done?: boolean;
  error?: string;
  cost?: number;
  ms?: number;
  settings?: Settings;
}
interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  settings: Settings;
  messages: Message[];
  cost: number;
  running?: boolean;
  preview?: string;
}

const DEFAULT: Settings = { model: 'sonnet', mode: 'build', effort: 'medium', thinking: true };

const MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'fable', label: 'Fable' },
  { value: 'haiku', label: 'Haiku' },
];
const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'Extra-high effort' },
  { value: 'max', label: 'Max effort' },
];
const MODE_TIP: Record<Mode, string> = {
  build: 'Build: Claude writes, checks, runs, backtests and saves scripts, iterating until the results hold up.',
  plan: 'Plan: Claude researches and tests drafts, then proposes a plan — nothing is saved.',
  ask: 'Ask: explanations and answers; tools only to look things up and verify.',
};

const SUGGESTIONS = [
  { icon: 'flask', text: 'Build a mean-reversion strategy for ETH on 15m, backtest it over the last year and compare it with buy & hold.' },
  { icon: 'code', text: 'Write a Python indicator that highlights volume spikes above 3× the 20-bar average.' },
  { icon: 'target', text: 'Find robust parameters for the MA Crossover strategy on BTC 4h — check out-of-sample results.' },
  { icon: 'info', text: 'Explain how the Supertrend strategy in the library works and when it tends to fail.' },
];

const fail = (title: string) => (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

/** Context from the app: the focused chart and the most recent script editor. */
function detectContext(): Context {
  const st = useApp.getState();
  const ws = st.workspace;
  const ctx: Context = {};
  const chartId = (window as any).__lastChartModule || Object.values(ws?.modules || {}).find((m) => m.type === 'chart')?.id;
  const ch = chartId ? ws?.modules[chartId] : null;
  if (ch && isSymbol(ch.config.symbol)) ctx.chart = { symbol: ch.config.symbol, market: ch.config.market, tf: ch.config.tf };
  return ctx;
}

// ------------------------------------------------------------------ module

export function AIStudioModule({ module }: ModuleProps) {
  const cfg = module.config as { chatId?: string | null };
  const setCfg = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const [status, setStatus] = useState<{ available: boolean; version?: string; error?: string } | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  // the chat list is a sidebar when there is room, an overlay in narrow layouts
  const [rootRef, size] = useSize<HTMLDivElement>();
  const narrow = size.width > 0 && size.width < 640;
  const [sideOverride, setSideOverride] = useState<boolean | null>(null);
  const sideOpen = sideOverride ?? !narrow;
  const setSideOpen = (v: boolean) => setSideOverride(v);
  useEffect(() => setSideOverride(null), [narrow]);
  useEffect(() => {
    void api.call('ai:status').then(setStatus).catch(() => setStatus({ available: false, error: 'Could not check the Claude CLI.' }));
    return api.sub<Chat[]>('ai:chats', {}, setChats);
  }, []);
  const chatId = cfg.chatId && chats?.some((c) => c.id === cfg.chatId) ? cfg.chatId : null;

  // requests from other modules ("Explain with AI", "Fix with AI")
  const [pending, setPending] = useState<{ prompt: string; context?: Context; mode?: Mode; send?: boolean } | null>(null);
  useEffect(
    () =>
      onAIRequest((d) => {
        setCfg({ chatId: null });
        setPending(d as { prompt: string; context?: Context; mode?: Mode; send?: boolean });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className={clsx('ai-studio', narrow && 'narrow')} ref={rootRef}>
      <HeadControls>
        <button className={clsx('icon-btn', sideOpen && 'active')} onClick={() => setSideOpen(!sideOpen)} data-tip="Chats">
          <Icon name="list" />
        </button>
        <button
          className="btn small primary"
          onClick={() => {
            setCfg({ chatId: null });
            if (narrow) setSideOpen(false);
          }}
          data-tip="Start a new conversation"
        >
          <Icon name="plus" size={13} /> New chat
        </button>
        <span className="spacer" />
        {status?.available && !narrow && <span className="faint small">Claude Code {status.version}</span>}
      </HeadControls>
      {status && !status.available && (
        <div className="ai-missing">
          <Icon name="alert" size={16} />
          <div className="col" style={{ gap: 4 }}>
            <b>Claude Code is not available</b>
            <span>{status.error}</span>
            <span className="faint small">The AI assistant runs your local Claude Code CLI with your own Claude subscription. After installing, run “claude” once in a terminal to sign in.</span>
          </div>
          <button className="btn small" onClick={() => void api.call('ai:status', true).then(setStatus)}>
            Check again
          </button>
        </div>
      )}
      <div className="ai-body">
        {sideOpen && (
          <div className="ai-side">
            {!chats && <Spinner />}
            {chats?.length === 0 && <div className="faint small" style={{ padding: 10 }}>No conversations yet.</div>}
            {chats?.map((c) => (
              <ChatItem
                key={c.id}
                c={c}
                on={c.id === chatId}
                onOpen={() => {
                  setCfg({ chatId: c.id });
                  if (narrow) setSideOpen(false);
                }}
                onDeleted={() => c.id === chatId && setCfg({ chatId: null })}
              />
            ))}
          </div>
        )}
        <div className="ai-main">
          {chatId ? (
            <ChatView key={chatId} id={chatId} available={!!status?.available} />
          ) : (
            <NewChat
              available={!!status?.available}
              pending={pending}
              onPendingUsed={() => setPending(null)}
              onStarted={(id) => {
                setCfg({ chatId: id });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ChatItem({ c, on, onOpen, onDeleted }: { c: Chat; on: boolean; onOpen: () => void; onDeleted: () => void }) {
  const menu = usePopover();
  return (
    <div className={clsx('ai-item', on && 'on')} onClick={onOpen}>
      <div className="row" style={{ gap: 6, minWidth: 0 }}>
        {c.running ? <Spinner size={11} /> : <Icon name="spark" size={12} />}
        <b className="ellipsis grow">{c.title}</b>
        <button
          className="icon-btn tiny"
          onClick={(e) => {
            e.stopPropagation();
            menu.toggle(e.currentTarget);
          }}
        >
          <Icon name="more" size={13} />
        </button>
      </div>
      <div className="faint small ellipsis">{fmtAgo(c.updated)}{c.cost ? ` · $${c.cost.toFixed(2)}` : ''}</div>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          width={180}
          items={[
            {
              label: 'Rename…',
              icon: 'edit',
              onClick: async () => {
                const t = await promptDialog({ title: 'Rename chat', initial: c.title });
                if (t) await api.call('ai:rename', c.id, t);
              },
            },
            {
              label: 'Delete',
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (await confirmDialog({ title: 'Delete this conversation?', body: c.title, confirm: 'Delete', danger: true })) {
                  await api.call('ai:delete', c.id);
                  onDeleted();
                }
              },
            },
          ]}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ new chat

function NewChat({ available, pending, onPendingUsed, onStarted }: { available: boolean; pending: { prompt: string; context?: Context; mode?: Mode; send?: boolean } | null; onPendingUsed: () => void; onStarted: (id: string) => void }) {
  const [settings, setSettings] = useState<Settings>(() => loadDefaults());
  const [text, setText] = useState('');
  const [ctx, setCtx] = useState<Context>(() => detectContext());
  const [busy, setBusy] = useState(false);
  const send = async (t = text, c = ctx, s = settings) => {
    if (!t.trim() || busy) return;
    setBusy(true);
    try {
      saveDefaults(s);
      const id = await api.call<string>('ai:send', null, t, s, c);
      onStarted(id);
    } catch (e) {
      fail('Claude could not start')(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!pending) return;
    const c = { ...detectContext(), ...(pending.context || {}) };
    const s = pending.mode ? { ...settings, mode: pending.mode } : settings;
    setCtx(c);
    setSettings(s);
    setText(pending.prompt);
    onPendingUsed();
    if (pending.send && available) void send(pending.prompt, c, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  return (
    <div className="ai-new">
      <div className="ai-hero">
        <div className="ai-hero-icon">
          <Icon name="spark" size={26} />
        </div>
        <div className="ai-hero-title">What should we build?</div>
        <div className="faint">Claude writes Pine Script or Python, then checks, runs and backtests it on real Binance data — and iterates until the results hold up.</div>
      </div>
      <div className="ai-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.text} className="ai-suggestion" onClick={() => setText(s.text)} disabled={!available}>
            <Icon name={s.icon} size={14} />
            <span>{s.text}</span>
          </button>
        ))}
      </div>
      <Composer text={text} setText={setText} settings={settings} setSettings={setSettings} ctx={ctx} setCtx={setCtx} onSend={() => void send()} running={false} disabled={!available || busy} autoFocus />
    </div>
  );
}

function loadDefaults(): Settings {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem('fufu.ai.settings') || '{}') };
  } catch {
    return DEFAULT;
  }
}
function saveDefaults(s: Settings): void {
  try {
    localStorage.setItem('fufu.ai.settings', JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ conversation

function ChatView({ id, available }: { id: string; available: boolean }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [ctx, setCtx] = useState<Context>(() => detectContext());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(
    () =>
      api.sub<{ full?: Chat | null; delta?: Message }>('ai:chat', { id }, (m) => {
        if (m.full !== undefined) setChat(m.full);
        else if (m.delta)
          setChat((c) => {
            if (!c) return c;
            const msgs = c.messages.slice();
            const k = msgs.findIndex((x) => x.id === m.delta!.id);
            if (k >= 0) msgs[k] = m.delta!;
            else msgs.push(m.delta!);
            return { ...c, messages: msgs };
          });
      }),
    [id],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  if (!chat)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  const settings = chat.settings;
  const setSettings = (s: Settings) => void api.call('ai:settings', id, s).catch(fail('Settings not saved'));
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    saveDefaults(settings);
    void api.call('ai:send', id, t, settings, ctx).catch((e) => {
      setText(t);
      fail('Claude could not start')(e);
    });
  };
  const last = chat.messages[chat.messages.length - 1];
  return (
    <div className="ai-chat">
      <div
        className="ai-transcript"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {chat.messages.map((m) => (m.role === 'user' ? <UserMsg key={m.id} m={m} /> : <AssistantMsg key={m.id} m={m} running={!!chat.running && m.id === last?.id} />))}
      </div>
      <Composer text={text} setText={setText} settings={settings} setSettings={setSettings} ctx={ctx} setCtx={setCtx} onSend={send} running={!!chat.running} onStop={() => void api.call('ai:stop', id)} disabled={!available} cost={chat.cost} />
    </div>
  );
}

function ContextChips({ ctx }: { ctx?: Context }) {
  if (!ctx) return null;
  return (
    <div className="ai-chips">
      {ctx.script && (
        <span className="ai-chip">
          <Icon name="code" size={11} /> {ctx.script.name}
        </span>
      )}
      {ctx.chart && (
        <span className="ai-chip">
          <Icon name="chart" size={11} /> {ctx.chart.symbol.replace('USDT', '')}
          {ctx.chart.market === 'futures' ? '.P' : ''} {ctx.chart.tf}
        </span>
      )}
      {ctx.error && (
        <span className="ai-chip err">
          <Icon name="alert" size={11} /> error attached
        </span>
      )}
      {ctx.selection && (
        <span className="ai-chip">
          <Icon name="copy" size={11} /> code attached
        </span>
      )}
    </div>
  );
}

function UserMsg({ m }: { m: Message }) {
  return (
    <div className="ai-msg user">
      <div className="ai-bubble">
        <div className="ai-user-text">{m.text}</div>
        <ContextChips ctx={m.context} />
      </div>
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  get_docs: 'Reading the docs',
  list_scripts: 'Browsing the script library',
  read_script: 'Reading a script',
  check_script: 'Checking the code',
  save_script: 'Saving the script',
  run_script: 'Running on market data',
  backtest: 'Backtesting',
  optimize: 'Optimizing parameters',
  market_snapshot: 'Looking at the market',
  show_in_app: 'Showing it in the app',
};

const TOOL_ICON: Record<string, string> = { get_docs: 'notebook', list_scripts: 'folder', read_script: 'code', check_script: 'check', save_script: 'save', run_script: 'play', backtest: 'flask', optimize: 'target', market_snapshot: 'chart', show_in_app: 'external' };

function AssistantMsg({ m, running }: { m: Message; running: boolean }) {
  const parts = m.parts || [];
  const lastIdx = parts.length - 1;
  return (
    <div className="ai-msg assistant">
      <div className="ai-avatar">
        <Icon name="spark" size={14} />
      </div>
      <div className="ai-parts">
        {parts.map((p, k) => {
          if (p.type === 'text') return p.text.trim() ? <Markdown key={k} text={p.text} /> : null;
          if (p.type === 'thinking') return <Thinking key={k} text={p.text} live={running && k === lastIdx} />;
          return <ToolPart key={p.id} p={p} />;
        })}
        {running && (!parts.length || parts[lastIdx]?.type === 'tool') && (
          <div className="ai-working">
            <Spinner size={12} /> {parts.length ? 'Working…' : 'Starting Claude…'}
          </div>
        )}
        {m.error && (
          <div className="ai-error">
            <Icon name="alert" size={13} /> {m.error}
          </div>
        )}
        {m.done && !running && (
          <div className="ai-meta faint small">
            {m.settings ? `${m.settings.model} · ${m.settings.mode} · ${m.settings.effort}${m.settings.thinking ? ' · thinking' : ''}` : ''}
            {m.ms ? ` · ${Math.round(m.ms / 1000)} s` : ''}
            {m.cost ? ` · $${m.cost.toFixed(3)}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  const tail = text.trim().split('\n').slice(-2).join(' ');
  return (
    <div className={clsx('ai-thinking', open && 'open')}>
      <button className="ai-thinking-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={12} /> {live ? 'Thinking…' : 'Thought process'}
      </button>
      {open ? <div className="ai-thinking-body">{text}</div> : live ? <div className="ai-thinking-tail ellipsis">{tail}</div> : null}
    </div>
  );
}

function shortName(name: string): string {
  return name.replace(/^mcp__fufu__/, '');
}

function ToolPart({ p }: { p: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const name = shortName(p.name);
  const title = p.card?.title || TOOL_LABEL[name] || name;
  return (
    <div className={clsx('ai-tool', p.status)}>
      <button className="ai-tool-head" onClick={() => setOpen(!open)}>
        <span className="ai-tool-ic">{p.status === 'running' ? <Spinner size={11} /> : <Icon name={p.status === 'error' ? 'alert' : TOOL_ICON[name] || 'zap'} size={12} />}</span>
        <span className="ellipsis grow">{p.status === 'running' && !p.card ? `${TOOL_LABEL[name] || name}…` : title}</span>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={12} />
      </button>
      {p.card && <CardBody card={p.card} />}
      {open && (
        <div className="ai-tool-detail">
          <div className="faint small">Input</div>
          <pre>{JSON.stringify(p.input, null, 1).slice(0, 6000)}</pre>
          {p.result && (
            <>
              <div className="faint small">Result</div>
              <pre>{p.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ k, v, tone }: { k: string; v: ReactNode; tone?: 'up' | 'down' | '' }) {
  return (
    <div className="ai-kpi">
      <span className="faint">{k}</span>
      <b className={tone || ''}>{v}</b>
    </div>
  );
}

const tone = (x: number | null | undefined) => (x === null || x === undefined ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '');
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : fmtPct(x));

function addScriptToChart(id: string, inputs: Record<string, unknown> = {}, symbol?: string, market?: string, tf?: string): void {
  bus.emit('ai:addToChart', { id, inputs, symbol, market, tf }, false);
}

function CardBody({ card }: { card: Card }) {
  const d = card.data || {};
  switch (card.kind) {
    case 'script':
      if (d.read || !d.id) return null;
      return (
        <div className="ai-card">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className={clsx('lang-badge', d.language)}>{d.language === 'python' ? 'Py' : 'Pine'}</span>
            <b className="ellipsis">{d.name}</b>
            {d.kind && <span className="faint small">{d.kind}</span>}
            {d.compiles === false && <span className="danger-text small">does not compile: {d.error}</span>}
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => void openScriptInEditor(String(d.id))}>
              <Icon name="code" size={12} /> Open
            </button>
            <button className="btn small" onClick={() => addScriptToChart(String(d.id))}>
              <Icon name="chart" size={12} /> Add to chart
            </button>
          </div>
        </div>
      );
    case 'check':
      if (d.ok && !(d.warnings || []).length) return null;
      return (
        <div className="ai-card small">
          {d.error && <div className="danger-text">{d.error}</div>}
          {(d.warnings || []).slice(0, 4).map((w: string, k: number) => (
            <div key={k} className="warn-text">
              {w}
            </div>
          ))}
        </div>
      );
    case 'backtest': {
      const m = d.metrics;
      if (!d.ok || !m) return null;
      return (
        <div className="ai-card">
          <div className="ai-kpis">
            <Kpi k="Net profit" v={pct(m.netProfitPct)} tone={tone(m.netProfitPct)} />
            <Kpi k="Buy & hold" v={pct(m.buyAndHold?.returnPct)} tone={tone(m.buyAndHold?.returnPct)} />
            <Kpi k="Max drawdown" v={pct(-Math.abs(m.maxDrawdownPct ?? 0))} tone="down" />
            <Kpi k="Sharpe" v={m.sharpe ?? '—'} />
            <Kpi k="Trades" v={m.trades} />
            <Kpi k="Win rate" v={m.winRatePct !== null ? `${m.winRatePct}%` : '—'} />
            <Kpi k="Profit factor" v={m.profitFactor ?? '—'} />
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="faint small ellipsis grow">
              {m.period} · {d.costs}
            </span>
            <button className="btn small ghost" onClick={() => void openModule('backtest', { runId: d.recordId })}>
              <Icon name="flask" size={12} /> Strategy Tester
            </button>
          </div>
        </div>
      );
    }
    case 'optimization':
      if (!d.recordId) return null;
      return (
        <div className="ai-card">
          <div className="small">
            Best: <b>{Object.entries(d.bestParams || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</b>
          </div>
          <div className="ai-kpis">
            <Kpi k="In-sample net" v={pct(d.inSample?.netProfitPct)} tone={tone(d.inSample?.netProfitPct)} />
            <Kpi k="Out-of-sample net" v={pct(d.outOfSample?.netProfitPct)} tone={tone(d.outOfSample?.netProfitPct)} />
            <Kpi k="IS Sharpe" v={d.inSample?.sharpe ?? '—'} />
            <Kpi k="OOS Sharpe" v={d.outOfSample?.sharpe ?? '—'} />
            {d.robustness && <Kpi k="Neighbourhood" v={d.robustness.narrowPeak ? 'narrow peak' : 'stable'} tone={d.robustness.narrowPeak ? 'down' : 'up'} />}
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => void openModule('optimizer', { runId: d.recordId })}>
              <Icon name="target" size={12} /> Optimizer
            </button>
          </div>
        </div>
      );
    case 'run':
      if (!d.ok) return d.error ? <div className="ai-card small danger-text">{d.error}</div> : null;
      return (
        <div className="ai-card small">
          {(d.plots || [])
            .filter((p: any) => p.last)
            .slice(0, 4)
            .map((p: any) => (
              <div key={p.title} className="row" style={{ gap: 8 }}>
                <span className="faint grow ellipsis">{p.title}</span>
                <span className="num">{p.last?.[p.last.length - 1] ?? '—'}</span>
                <span className="faint">
                  [{p.min} … {p.max}]
                </span>
              </div>
            ))}
          {d.strategy && (
            <div className="faint">
              {d.strategy.trades} trades · net {d.strategy.netProfit}
            </div>
          )}
        </div>
      );
    case 'market':
      return (
        <div className="ai-card small">
          <div className="ai-kpis">
            <Kpi k="Last" v={d.last} />
            <Kpi k="Change" v={pct(d.changePct)} tone={tone(d.changePct)} />
            <Kpi k="ATR" v={`${d.atr14Pct}%`} />
            <Kpi k="Volatility" v={`${d.annualVolatilityPct}% / yr`} />
            <Kpi k="Trend" v={d.trend} />
          </div>
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ composer

function Composer({ text, setText, settings, setSettings, ctx, setCtx, onSend, running, onStop, disabled, autoFocus, cost }: { text: string; setText: (t: string) => void; settings: Settings; setSettings: (s: Settings) => void; ctx: Context; setCtx: (c: Context) => void; onSend: () => void; running: boolean; onStop?: () => void; disabled?: boolean; autoFocus?: boolean; cost?: number }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(44, el.scrollHeight))}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus]);
  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const chips = useMemo(() => ctx, [ctx]);
  return (
    <div className={clsx('ai-composer', disabled && 'disabled')}>
      {(chips.script || chips.chart || chips.error || chips.selection) && (
        <div className="ai-chips editable">
          {chips.script && (
            <span className="ai-chip">
              <Icon name="code" size={11} /> {chips.script.name}
              <button className="chip-x" onClick={() => setCtx({ ...ctx, script: undefined, selection: undefined, error: undefined })}>
                ×
              </button>
            </span>
          )}
          {chips.chart && (
            <span className="ai-chip" data-tip="Claude knows which chart you are looking at">
              <Icon name="chart" size={11} /> {chips.chart.symbol.replace('USDT', '')}
              {chips.chart.market === 'futures' ? '.P' : ''} {chips.chart.tf}
              <button className="chip-x" onClick={() => setCtx({ ...ctx, chart: undefined })}>
                ×
              </button>
            </span>
          )}
          {chips.error && (
            <span className="ai-chip err">
              <Icon name="alert" size={11} /> error
              <button className="chip-x" onClick={() => setCtx({ ...ctx, error: undefined })}>
                ×
              </button>
            </span>
          )}
        </div>
      )}
      <textarea
        ref={ta}
        className="ai-input"
        placeholder={running ? 'Claude is working — you can write the next message meanwhile…' : 'Ask Claude to build, explain, debug or improve a strategy or indicator…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!running && !disabled) onSend();
          }
        }}
      />
      <div className="ai-controls">
        <Segmented
          size="sm"
          value={settings.mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { value: 'build', label: 'Build', title: MODE_TIP.build },
            { value: 'plan', label: 'Plan', title: MODE_TIP.plan },
            { value: 'ask', label: 'Ask', title: MODE_TIP.ask },
          ]}
        />
        <Select value={settings.model} onChange={(m) => set({ model: m })} options={MODELS} title="Model" />
        <Select value={settings.effort} onChange={(v) => set({ effort: v })} options={EFFORTS} title="How much effort Claude spends (more effort is slower and uses more of your plan)" />
        <label className="row ai-think" data-tip="Extended thinking before answering">
          <Toggle value={settings.thinking} onChange={(v) => set({ thinking: v })} /> Think
        </label>
        <span className="spacer" />
        {cost ? <span className="faint small">${cost.toFixed(2)}</span> : null}
        {running ? (
          <button className="btn small" onClick={onStop} data-tip="Stop Claude">
            <Icon name="stop" size={13} /> Stop
          </button>
        ) : (
          <button className="btn small primary" onClick={onSend} disabled={disabled || !text.trim()} data-tip="Send (Enter) — Shift+Enter for a new line">
            <Icon name="send" size={13} /> Send
          </button>
        )}
      </div>
    </div>
  );
}
