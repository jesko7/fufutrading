import { DOCS, openDoc } from './help';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../state/store';
import { api } from '../api';
import { bus } from '../lib/bus';
import { Icon } from '../components/Icon';
import { Modal, openModal } from '../components/ui';
import { MODULE_INFO, type ModuleType, newId, defaultModuleConfig, findStackOf } from '../../shared/workspace';
import { SYMBOLS, SYMBOL_SPECS, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfToString, STANDARD_TIMEFRAMES, tfLongLabel } from '../../shared/timeframes';
import { clsx } from '../lib/format';
import { SettingsModal } from './Settings';

export interface Action {
  id: string;
  label: string;
  group: string;
  keys?: string;
  icon?: string;
  run: () => void;
  /** Only valid when a chart is focused etc. */
  enabled?: () => boolean;
  /** Extra search terms. */
  terms?: string;
}

const isMac = api.platform === 'darwin';

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (e.code.startsWith('Digit')) k = e.code.slice(5);
  if (k === ' ') k = 'space';
  if (k === '?') k = '/';
  parts.push(k);
  return parts.join('+');
}

export function prettyKeys(keys: string): string[] {
  return keys.split('+').map((k) => (k === 'mod' ? (isMac ? '⌘' : 'Ctrl') : k === 'alt' ? (isMac ? '⌥' : 'Alt') : k === 'shift' ? '⇧' : k === 'arrowright' ? '→' : k === 'arrowleft' ? '←' : k === 'space' ? 'Space' : k === 'escape' ? 'Esc' : k.length === 1 ? k.toUpperCase() : k));
}

function focusedModule() {
  const st = useApp.getState();
  const id = st.focusedModule;
  return id && st.workspace?.modules[id] ? st.workspace.modules[id] : null;
}

function focusedChart() {
  const m = focusedModule();
  if (m?.type === 'chart') return m;
  const st = useApp.getState();
  const last = (window as any).__lastChartModule as string | undefined;
  if (last && st.workspace?.modules[last]) return st.workspace.modules[last];
  return Object.values(st.workspace?.modules || {}).find((x) => x.type === 'chart') || null;
}

function chartCmd(cmd: string, arg?: unknown) {
  const c = focusedChart();
  if (c) bus.emit('chart:cmd', { moduleId: c.id, cmd, arg }, false);
}

function setChart(patch: Record<string, unknown>) {
  const c = focusedChart();
  if (c) useApp.getState().setModuleConfig(c.id, patch);
}

async function addModule(type: ModuleType) {
  const near = focusedModule();
  const st = useApp.getState();
  const ws = st.workspace;
  const win = ws?.windows.find((w) => w.id === st.windowId);
  let stackId: string | null = null;
  const find = (n: any): void => {
    if (!n || stackId) return;
    if (n.type === 'stack' && near && n.modules.includes(near.id)) stackId = n.id;
    else if (n.children) n.children.forEach(find);
  };
  find(win?.root);
  const sym = (near?.config.symbol as SymbolId) || 'BTCUSDT';
  await st.addModule({ id: newId('m'), type, config: defaultModuleConfig(type, sym, near?.config.market || 'spot'), link: null }, stackId, 'auto');
}

export function buildActions(): Action[] {
  const st = useApp.getState;
  const list: Action[] = [
    { id: 'palette', label: 'Command palette', group: 'General', keys: 'mod+k', icon: 'search', run: () => st().setPalette(true) },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'General', keys: 'shift+/', icon: 'keyboard', run: () => openModal('shortcuts', (c) => <ShortcutsModal onClose={c} />) },
    { id: 'settings', label: 'Settings', group: 'General', keys: 'mod+,', icon: 'gear', run: () => openModal('settings', (c) => <SettingsModal onClose={c} />) },
    { id: 'theme', label: 'Toggle light / dark theme', group: 'General', keys: 'alt+shift+t', icon: 'sun', run: () => void st().updateSettings({ theme: st().settings.theme === 'light' ? 'dark' : 'light' }) },
    { id: 'ws.save', label: 'Save workspace', group: 'Workspace', keys: 'mod+s', icon: 'save', run: () => void api.call('ws:save').then(() => st().toast({ title: 'Workspace saved', kind: 'ok' })) },
    { id: 'ws.switch', label: 'Workspaces & presets…', group: 'Workspace', icon: 'grid', run: () => st().setShowStart(true) },
    { id: 'module.close', label: 'Close focused module', group: 'Workspace', keys: 'mod+w', icon: 'x', run: () => focusedModule() && api.call('ws:op', { kind: 'removeModule', moduleId: focusedModule()!.id }) },
    { id: 'module.duplicate', label: 'Duplicate focused module', group: 'Workspace', keys: 'mod+shift+d', icon: 'copy', run: () => focusedModule() && api.call('ws:op', { kind: 'duplicateModule', moduleId: focusedModule()!.id }) },
    { id: 'module.detach', label: 'Open focused module in new window', group: 'Workspace', keys: 'mod+shift+n', icon: 'detach', run: () => focusedModule() && api.call('ws:detach', focusedModule()!.id) },
    {
      id: 'module.maximize',
      label: 'Maximize / restore focused panel',
      group: 'Workspace',
      keys: 'alt+enter',
      icon: 'max',
      run: () => {
        const m = focusedModule();
        const win = st().workspace?.windows.find((w) => w.id === st().windowId);
        const stack = m && win ? findStackOf(win.root, m.id) : null;
        if (stack) st().setMaximizedStack(st().maximizedStack === stack.id ? null : stack.id);
      },
    },
    { id: 'sym.btc', label: 'Chart: Bitcoin', group: 'Chart', keys: 'alt+1', icon: 'chart', run: () => setChart({ symbol: 'BTCUSDT' }) },
    { id: 'sym.eth', label: 'Chart: Ethereum', group: 'Chart', keys: 'alt+2', icon: 'chart', run: () => setChart({ symbol: 'ETHUSDT' }) },
    { id: 'sym.sol', label: 'Chart: Solana', group: 'Chart', keys: 'alt+3', icon: 'chart', run: () => setChart({ symbol: 'SOLUSDT' }) },
    { id: 'market.toggle', label: 'Chart: toggle Spot / Perp', group: 'Chart', keys: 'alt+p', icon: 'refresh', run: () => setChart({ market: focusedChart()?.config.market === 'futures' ? 'spot' : 'futures' }) },
    { id: 'tf.up', label: 'Chart: next timeframe', group: 'Chart', keys: 'alt+]', icon: 'chevUp', run: () => stepTf(1) },
    { id: 'tf.down', label: 'Chart: previous timeframe', group: 'Chart', keys: 'alt+[', icon: 'chevDown', run: () => stepTf(-1) },
    { id: 'chart.indicators', label: 'Chart: add indicator / strategy', group: 'Chart', keys: '/', icon: 'flow', run: () => chartCmd('indicators') },
    { id: 'chart.patterns', label: 'Chart: candlestick patterns (choose which to detect)', group: 'Chart', icon: 'candles', run: () => chartCmd('addScript', 'builtin:candlestick_patterns') },
    { id: 'chart.reset', label: 'Chart: reset view', group: 'Chart', keys: 'alt+r', icon: 'refresh', run: () => chartCmd('reset') },
    { id: 'chart.log', label: 'Chart: toggle log scale', group: 'Chart', keys: 'alt+l', icon: 'log', run: () => setChart({ scale: focusedChart()?.config.scale === 'log' ? 'linear' : 'log' }) },
    { id: 'chart.pct', label: 'Chart: toggle percentage scale', group: 'Chart', keys: 'alt+5', icon: 'percent', run: () => setChart({ scale: focusedChart()?.config.scale === 'percent' ? 'linear' : 'percent' }) },
    { id: 'chart.snapshot', label: 'Chart: copy snapshot', group: 'Chart', keys: 'alt+s', icon: 'camera', run: () => chartCmd('snapshot') },
    { id: 'draw.trend', label: 'Draw trend line', group: 'Drawing', keys: 'alt+t', icon: 'trend', run: () => chartCmd('tool', 'trend') },
    { id: 'draw.hline', label: 'Draw horizontal line', group: 'Drawing', keys: 'alt+h', icon: 'hline', run: () => chartCmd('tool', 'hline') },
    { id: 'draw.vline', label: 'Draw vertical line', group: 'Drawing', keys: 'alt+v', icon: 'vline', run: () => chartCmd('tool', 'vline') },
    { id: 'draw.fib', label: 'Draw Fibonacci retracement', group: 'Drawing', keys: 'alt+f', icon: 'fib', run: () => chartCmd('tool', 'fib') },
    { id: 'draw.channel', label: 'Draw parallel channel', group: 'Drawing', keys: 'alt+c', icon: 'channel', run: () => chartCmd('tool', 'channel') },
    { id: 'draw.measure', label: 'Measure', group: 'Drawing', keys: 'alt+m', icon: 'measure', run: () => chartCmd('tool', 'measure') },
    { id: 'trade.buy', label: 'Quick buy (market) — focused instrument', group: 'Trading', keys: 'shift+b', icon: 'arrowUp', run: () => bus.emit('trade:quick', { side: 'buy', chart: focusedChart()?.id }, false) },
    { id: 'trade.sell', label: 'Quick sell (market) — focused instrument', group: 'Trading', keys: 'shift+s', icon: 'arrowDown', run: () => bus.emit('trade:quick', { side: 'sell', chart: focusedChart()?.id }, false) },
    { id: 'trade.flatten', label: 'Close position — focused instrument', group: 'Trading', keys: 'shift+f', icon: 'x', run: () => bus.emit('trade:quick', { side: 'flatten', chart: focusedChart()?.id }, false) },
    { id: 'trade.cancel', label: 'Cancel all orders — focused instrument', group: 'Trading', keys: 'shift+c', icon: 'trash', run: () => bus.emit('trade:quick', { side: 'cancel', chart: focusedChart()?.id }, false) },
    { id: 'replay.toggle', label: 'Bar replay: start / exit', group: 'Replay', keys: 'shift+r', icon: 'replay', run: () => chartCmd('replay') },
    { id: 'replay.play', label: 'Bar replay: play / pause', group: 'Replay', keys: 'space', icon: 'play', run: () => bus.emit('replay:cmd', 'toggle', false), enabled: () => !!(window as any).__replayActive },
    { id: 'replay.step', label: 'Bar replay: step forward', group: 'Replay', keys: 'shift+arrowright', icon: 'step', run: () => bus.emit('replay:cmd', 'step', false), enabled: () => !!(window as any).__replayActive },
  ];
  for (const d of DOCS) list.push({ id: `help.${d.id}`, label: `Help: ${d.title}`, group: 'Help', icon: 'notebook', run: () => openDoc(d.id) });
  for (const t of Object.keys(MODULE_INFO) as ModuleType[]) list.push({ id: `add.${t}`, label: `Add ${MODULE_INFO[t].title}`, group: 'Modules', icon: MODULE_INFO[t].icon, run: () => void addModule(t), terms: MODULE_INFO[t].description });
  for (const s of SYMBOLS) for (const m of ['spot', 'futures'] as const) list.push({ id: `go.${s}.${m}`, label: `${SYMBOL_SPECS[s].base}${m === 'futures' ? ' Perp' : ''} — ${SYMBOL_SPECS[s].name}`, group: 'Instruments', icon: 'chart', run: () => setChart({ symbol: s, market: m }), terms: s });
  for (const tf of STANDARD_TIMEFRAMES) list.push({ id: `tf.${tf}`, label: `Timeframe ${tf} (${tfLongLabel(tf)})`, group: 'Timeframes', icon: 'history', run: () => setChart({ tf }) });
  return list;
}

function stepTf(dir: number) {
  const c = focusedChart();
  if (!c) return;
  const i = STANDARD_TIMEFRAMES.indexOf(c.config.tf);
  const ni = Math.max(0, Math.min(STANDARD_TIMEFRAMES.length - 1, (i < 0 ? 6 : i) + dir));
  setChart({ tf: STANDARD_TIMEFRAMES[ni] });
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.closest?.('.cm-editor')) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function useGlobalShortcuts(): void {
  const [tfBuf, setTfBuf] = useState<string | null>(null);
  void tfBuf;
  useEffect(() => {
    const actions = buildActions();
    const overrides = useApp.getState().settings.shortcuts || {};
    const map = new Map<string, Action>();
    for (const a of actions) {
      const k = overrides[a.id] || a.keys;
      if (k) map.set(k, a);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const combo = comboOf(e);
      const typing = isTyping(e);
      if (typing && combo !== 'mod+k' && combo !== 'mod+s') return;
      if (useApp.getState().modals.length && combo !== 'mod+k') return;
      // TradingView-style: type a number to change the focused chart's timeframe
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key) && focusedChart()) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('fufu-tfinput', { detail: e.key }));
        return;
      }
      const a = map.get(combo);
      if (!a) return;
      if (a.enabled && !a.enabled()) return;
      e.preventDefault();
      a.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  void setTfBuf;
}

/** Small overlay for typed timeframes ("5" → 5m, "4h", "30s", "1D"). */
export function TimeframeInput() {
  const [buf, setBuf] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setBuf((e as CustomEvent).detail as string);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener('fufu-tfinput', on);
    return () => window.removeEventListener('fufu-tfinput', on);
  }, []);
  if (buf === null) return null;
  const tf = parseTimeframe(buf);
  const apply = () => {
    if (tf) setChart({ tf: tfToString(tf) });
    setBuf(null);
  };
  return createPortal(
    <div className="palette" style={{ width: 280, top: '30vh' }}>
      <input
        ref={inputRef}
        value={buf}
        onChange={(e) => setBuf(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
          if (e.key === 'Escape') setBuf(null);
        }}
        onBlur={() => setBuf(null)}
        placeholder="Timeframe"
      />
      <div style={{ padding: '8px 16px', color: 'var(--text-2)' }}>{tf ? `→ ${tfLongLabel(tf)}  (Enter)` : 'e.g. 5, 30s, 4h, 1D, 7m'}</div>
    </div>,
    document.body,
  );
}

function score(q: string, a: Action): number {
  const hay = `${a.label} ${a.group} ${a.terms || ''}`.toLowerCase();
  if (!q) return 1;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) {
      // subsequence fallback
      let j = 0;
      for (const ch of hay) if (ch === w[j]) j++;
      if (j < w.length) return 0;
      s += 1;
    } else s += i === 0 ? 10 : hay[i - 1] === ' ' ? 6 : 3;
  }
  return s;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const actions = useMemo(() => (open ? buildActions() : []), [open]);
  const results = useMemo(() => {
    const tf = parseTimeframe(q.trim());
    const r = actions
      .map((a) => ({ a, s: score(q, a) }))
      .filter((x) => x.s > 0 && (!x.a.enabled || x.a.enabled()))
      .sort((x, y) => y.s - x.s)
      .slice(0, 60)
      .map((x) => x.a);
    if (tf && /\d/.test(q)) r.unshift({ id: 'tf.custom', label: `Set timeframe ${tfToString(tf)} (${tfLongLabel(tf)})`, group: 'Timeframes', icon: 'history', run: () => setChart({ tf: tfToString(tf) }) });
    return r;
  }, [q, actions]);
  useEffect(() => {
    if (open) {
      setQ('');
      setHl(0);
    }
  }, [open]);
  if (!open) return null;
  const close = () => useApp.getState().setPalette(false);
  const run = (a: Action) => {
    close();
    setTimeout(() => a.run(), 0);
  };
  let lastGroup = '';
  return createPortal(
    <div className="modal-scrim" style={{ alignItems: 'flex-start', background: 'transparent' }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <input
          autoFocus
          value={q}
          placeholder="Type a command, instrument, timeframe or module…"
          onChange={(e) => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHl((h) => Math.min(results.length - 1, h + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHl((h) => Math.max(0, h - 1));
            }
            if (e.key === 'Enter' && results[hl]) run(results[hl]);
          }}
        />
        <div className="results">
          {results.map((a, i) => {
            const header = a.group !== lastGroup ? a.group : null;
            lastGroup = a.group;
            return (
              <div key={a.id}>
                {header && !q && <div className="p-group">{header}</div>}
                <div className={clsx('p-item', i === hl && 'hl')} onMouseEnter={() => setHl(i)} onClick={() => run(a)}>
                  <Icon name={a.icon || 'chevRight'} size={15} />
                  <span className="grow">{a.label}</span>
                  {a.keys && (
                    <span className="row" style={{ gap: 3 }}>
                      {prettyKeys(a.keys).map((k, j) => (
                        <kbd key={j}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!results.length && <div className="empty">No matches</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const actions = buildActions().filter((a) => a.keys);
  const groups = [...new Set(actions.map((a) => a.group))];
  return (
    <Modal title="Keyboard shortcuts" icon="keyboard" onClose={onClose} width={720}>
      <div style={{ columns: 2, columnGap: 28 }}>
        {groups.map((g) => (
          <div key={g} style={{ breakInside: 'avoid', marginBottom: 14 }}>
            <div className="section-title" style={{ marginBottom: 6 }}>
              {g}
            </div>
            {actions
              .filter((a) => a.group === g)
              .map((a) => (
                <div key={a.id} className="row" style={{ padding: '3px 0' }}>
                  <span className="grow muted">{a.label}</span>
                  <span className="row" style={{ gap: 3 }}>
                    {prettyKeys(a.keys!).map((k, j) => (
                      <kbd key={j}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
          </div>
        ))}
        <div style={{ breakInside: 'avoid' }}>
          <div className="section-title" style={{ marginBottom: 6 }}>
            Chart
          </div>
          <div className="row muted" style={{ padding: '3px 0' }}>
            <span className="grow">Type a number / timeframe (e.g. 5, 4h, 30s)</span>
            <kbd>0-9</kbd>
          </div>
          <div className="row muted" style={{ padding: '3px 0' }}>
            <span className="grow">Pan / zoom</span>
            <kbd>←</kbd>
            <kbd>→</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </div>
          <div className="row muted" style={{ padding: '3px 0' }}>
            <span className="grow">Delete selected drawing</span>
            <kbd>Del</kbd>
          </div>
        </div>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Shortcuts are disabled while typing in text fields and the script editor. Quick-trade shortcuts always act on the focused chart's instrument and the selected paper account, and ask for confirmation when enabled in settings.
      </div>
    </Modal>
  );
}
