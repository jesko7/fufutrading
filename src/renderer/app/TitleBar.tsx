import { useRef, useState } from 'react';
import { useApp } from '../state/store';
import { api, errorMessage } from '../api';
import { Icon } from '../components/Icon';
import { Menu, usePopover, promptDialog, openModal } from '../components/ui';
import { useTopicValue } from '../lib/hooks';
import type { ConnectionInfo } from '../../shared/marketTypes';
import { AddModuleMenu } from './WorkspaceView';
import { SettingsModal } from './Settings';
import { ShortcutsModal } from './shortcuts';
import { DOCS, openDoc } from './help';
import { clsx } from '../lib/format';

export function TitleBar() {
  const ws = useApp((s) => s.workspace);
  const windowId = useApp((s) => s.windowId);
  const settings = useApp((s) => s.settings);
  const wsMenu = usePopover();
  const helpMenu = usePopover();
  const addMenu = usePopover();
  const addRef = useRef<HTMLButtonElement>(null);
  const conn = useTopicValue<ConnectionInfo>('conn', {});
  const isMain = windowId === 'main';
  const platform = api.platform;
  const states = conn ? Object.values(conn.conns).filter((c) => c.state !== 'idle' && c.state !== 'closed') : [];
  const allOpen = states.length > 0 && states.every((c) => c.state === 'open');
  const anyReconnecting = states.some((c) => c.state === 'reconnecting' || c.state === 'connecting');
  const degraded = conn?.tapes.some((t) => t.status === 'degraded' || t.status === 'reconnecting');
  const [saving, setSaving] = useState(false);

  const save = async (asNew: boolean, asPreset = false) => {
    let name = ws?.name;
    if (asNew || asPreset) {
      const n = await promptDialog({ title: asPreset ? 'Save as preset' : 'Save workspace as', label: 'Name', initial: ws?.name === 'Empty' ? 'My workspace' : ws?.name, confirm: 'Save' });
      if (!n) return;
      name = n;
    }
    setSaving(true);
    try {
      await api.call('ws:save', name, asPreset, asNew || asPreset);
      useApp.getState().toast({ title: asPreset ? 'Preset saved' : 'Workspace saved', body: name, kind: 'ok' });
    } catch (e) {
      useApp.getState().toast({ title: 'Save failed', body: errorMessage(e), kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const toggleTheme = () => {
    void useApp.getState().updateSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' });
  };

  return (
    <div className={clsx('titlebar', platform === 'darwin' ? 'mac' : 'win')}>
      <div className="brand">
        <div className="brand-mark">
          <i style={{ height: 6 }} />
          <i style={{ height: 10 }} />
          <i style={{ height: 8 }} />
        </div>
        {isMain ? 'FuFu' : ''}
      </div>
      {isMain && ws && (
        <>
          <button className="ws-name no-drag" onClick={(e) => wsMenu.toggle(e.currentTarget)} data-tip="Workspace">
            <Icon name="layout" size={14} />
            <span>{ws.name}</span>
            <Icon name="chevDown" size={12} />
          </button>
          {wsMenu.anchor && (
            <Menu
              anchor={wsMenu.anchor}
              onClose={wsMenu.close}
              width={250}
              items={[
                { label: 'Save', icon: 'save', hint: 'Ctrl+S', onClick: () => save(false) },
                { label: 'Save as…', icon: 'copy', onClick: () => save(true) },
                { label: 'Save as preset…', icon: 'star', onClick: () => save(true, true) },
                {
                  label: 'Rename…',
                  icon: 'edit',
                  onClick: async () => {
                    const n = await promptDialog({ title: 'Rename workspace', initial: ws.name });
                    if (n) await api.call('ws:op', { kind: 'rename', name: n });
                  },
                },
                { sep: true },
                { label: 'Workspaces & presets…', icon: 'grid', onClick: () => useApp.getState().setShowStart(true) },
              ]}
            />
          )}
        </>
      )}
      {!isMain && (
        <button className="btn ghost small no-drag" onClick={() => api.call('ws:reattach', windowId)} data-tip="Move this window's modules back into the main window">
          <Icon name="attach" size={14} /> Dock to main window
        </button>
      )}
      <button ref={addRef} className="btn ghost small no-drag" onClick={() => addMenu.toggle(addRef.current)} data-tip="Add a module">
        <Icon name="plus" size={14} /> Add
      </button>
      {addMenu.anchor && <AddModuleMenu anchor={addMenu.anchor} onClose={addMenu.close} targetStack={null} />}
      <div className="spacer" />
      <span className="conn-pill" data-tip={conn ? Object.entries(conn.conns).map(([k, v]) => `${k}: ${v.state}`).join('\n') : 'Connecting…'}>
        <span className="dot" style={{ background: !conn || !states.length ? 'var(--text-3)' : allOpen && !degraded ? 'var(--ok)' : anyReconnecting ? 'var(--warn)' : 'var(--warn)' }} />
        {!conn || !states.length ? 'Idle' : allOpen && !degraded ? 'Binance live' : 'Reconnecting'}
      </span>
      <button className="icon-btn no-drag" onClick={() => useApp.getState().setPalette(true)} data-tip="Command palette (Ctrl+K)">
        <Icon name="search" />
      </button>
      <button className="icon-btn no-drag" onClick={(e) => helpMenu.toggle(e.currentTarget)} data-tip="Help: documentation and keyboard shortcuts">
        <Icon name="info" />
      </button>
      {helpMenu.anchor && (
        <Menu
          anchor={helpMenu.anchor}
          onClose={helpMenu.close}
          align="end"
          width={330}
          items={[
            { title: 'Documentation' },
            ...DOCS.map((d) => ({ label: d.title, icon: 'notebook', onClick: () => openDoc(d.id) })),
            { sep: true },
            { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', onClick: () => openModal('shortcuts', (close) => <ShortcutsModal onClose={close} />) },
          ]}
        />
      )}
      <button className="icon-btn no-drag" onClick={toggleTheme} data-tip="Toggle light / dark">
        <Icon name={settings.theme === 'light' ? 'moon' : 'sun'} />
      </button>
      <button className="icon-btn no-drag" onClick={() => openModal('settings', (close) => <SettingsModal onClose={close} />)} data-tip="Settings">
        <Icon name="gear" />
      </button>
      {saving && <span className="spinner" />}
    </div>
  );
}
