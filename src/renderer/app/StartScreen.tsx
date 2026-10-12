import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useApp } from '../state/store';
import { Icon } from '../components/Icon';
import { Toggle, confirmDialog, promptDialog } from '../components/ui';
import type { LayoutNode, Workspace } from '../../shared/workspace';
import { presetWorkspaces } from '../../shared/workspace';
import { fmtAgo } from '../lib/format';

interface ListItem {
  id: string;
  name: string;
  description?: string;
  preset: boolean;
  builtin: boolean;
  updatedAt: number;
  modules: number;
  windows: number;
}

function Thumb({ ws }: { ws?: Workspace }) {
  const boxes: { x: number; y: number; w: number; h: number; chart: boolean }[] = [];
  const walk = (n: LayoutNode | null, x: number, y: number, w: number, h: number) => {
    if (!n) return;
    if (n.type === 'stack') {
      const m = ws?.modules[n.modules[n.active] || n.modules[0]];
      boxes.push({ x, y, w, h, chart: m?.type === 'chart' || m?.type === 'heatmap' });
      return;
    }
    let off = 0;
    n.children.forEach((c, i) => {
      const s = n.sizes[i];
      if (n.dir === 'row') walk(c, x + off * w, y, w * s, h);
      else walk(c, x, y + off * h, w, h * s);
      off += s;
    });
  };
  walk(ws?.windows[0]?.root || null, 0, 0, 100, 100);
  return (
    <div className="thumb">
      {boxes.map((b, i) => (
        <div key={i} className={`thumb-box${b.chart ? ' chart' : ''}`} style={{ left: `calc(${b.x}% + 3px)`, top: `calc(${b.y}% + 3px)`, width: `calc(${b.w}% - 6px)`, height: `calc(${b.h}% - 6px)` }} />
      ))}
      {!boxes.length && (
        <div className="empty" style={{ padding: 0 }}>
          <Icon name="plus" size={22} />
        </div>
      )}
    </div>
  );
}

export function StartScreen() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [saved, setSaved] = useState<Record<string, Workspace>>({});
  const settings = useApp((s) => s.settings);
  const builtins = presetWorkspaces();
  const refresh = async () => {
    const list = await api.call<ListItem[]>('ws:list');
    setItems(list);
  };
  useEffect(() => {
    void refresh();
  }, []);
  void saved;
  void setSaved;

  const load = async (id: string) => {
    try {
      await api.call('ws:load', id);
      useApp.getState().setShowStart(false);
    } catch (e) {
      useApp.getState().toast({ title: 'Could not load workspace', body: errorMessage(e), kind: 'error' });
    }
  };

  const builtinItems = items.filter((i) => i.builtin);
  const userItems = items.filter((i) => !i.builtin);
  const hasCurrent = !!useApp.getState().workspace;

  return (
    <div className="start">
      <div className="start-inner">
        <h1>Choose a workspace</h1>
        <div className="sub">Start from a preset, from scratch, or from one of your saved layouts. Everything can be rearranged later.</div>
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="section-title">Presets</span>
          <div className="spacer" />
          {hasCurrent && (
            <button className="btn small" onClick={() => useApp.getState().setShowStart(false)}>
              Continue current session <Icon name="chevRight" size={13} />
            </button>
          )}
        </div>
        <div className="preset-grid">
          <div className="preset" onClick={() => load('empty')}>
            <Thumb />
            <div>
              <div className="p-name">Empty</div>
              <div className="p-desc">A blank canvas. Add only the modules you want.</div>
            </div>
          </div>
          {builtinItems.map((it) => (
            <div key={it.id} className="preset" onClick={() => load(it.id)}>
              <Thumb ws={builtins.find((b) => b.name === it.name)} />
              <div>
                <div className="p-name">{it.name}</div>
                <div className="p-desc">{it.description}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="row" style={{ margin: '28px 0 12px' }}>
          <span className="section-title">Your workspaces & presets</span>
        </div>
        {userItems.length === 0 ? (
          <div className="card muted">Nothing saved yet. Use the workspace menu (top left) → “Save as…” or “Save as preset…”.</div>
        ) : (
          <div className="preset-grid">
            {userItems.map((it) => (
              <div key={it.id} className="preset" onClick={() => load(it.id)}>
                <div className="row">
                  <Icon name={it.preset ? 'star' : 'layout'} size={16} />
                  <div className="p-name grow ellipsis">{it.name}</div>
                  <button
                    className="icon-btn small"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const n = await promptDialog({ title: 'Rename', initial: it.name });
                      if (n) {
                        await api.call('ws:rename', it.id, n);
                        void refresh();
                      }
                    }}
                    data-tip="Rename"
                  >
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    className="icon-btn small"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirmDialog({ title: 'Delete workspace?', body: `“${it.name}” will be removed.`, confirm: 'Delete', danger: true })) {
                        await api.call('ws:delete', it.id);
                        void refresh();
                      }
                    }}
                    data-tip="Delete"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                <div className="p-desc">
                  {it.preset ? 'Preset · ' : ''}
                  {it.modules} modules{it.windows > 1 ? ` · ${it.windows} windows` : ''} · {fmtAgo(it.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 28 }}>
          <Toggle value={settings.startup.mode === 'ask'} onChange={(v) => useApp.getState().updateSettings({ startup: { ...settings.startup, mode: v ? 'ask' : 'last' } })} />
          <span className="muted">Show this screen when the app starts (otherwise the last session is restored)</span>
        </div>
      </div>
    </div>
  );
}
