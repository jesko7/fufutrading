import { createRoot } from 'react-dom/client';
import { api } from './api';
import { useApp } from './state/store';
import { App } from './app/App';
import type { AppSettings } from '../shared/settings';
import type { Workspace } from '../shared/workspace';
import './styles/base.css';
import './styles/app.css';
import './features';

async function boot(): Promise<void> {
  const [settings, wsInfo] = await Promise.all([api.call<AppSettings>('settings:get'), api.call<{ workspace: Workspace; rev: number; hasSession: boolean }>('ws:get')]);
  const st = useApp.getState();
  st.setSettings(settings);
  st.setWorkspace(wsInfo.workspace, wsInfo.rev);
  api.on<{ workspace: Workspace; rev: number }>('workspace', (m) => useApp.getState().setWorkspace(m.workspace, m.rev));
  api.on<AppSettings>('settings', (s) => useApp.getState().setSettings(s));
  // Start screen: on a fresh launch of the main window when the user asked for it,
  // or when there is no saved session yet.
  const firstLoad = !sessionStorage.getItem('fufu.started');
  sessionStorage.setItem('fufu.started', '1');
  if (api.windowId === 'main' && firstLoad && (settings.startup.mode === 'ask' || !wsInfo.hasSession)) st.setShowStart(true);
  // remember the last focused chart (for watchlist / shortcuts routing)
  useApp.subscribe((s, prev) => {
    if (s.focusedModule !== prev.focusedModule && s.focusedModule && s.workspace?.modules[s.focusedModule]?.type === 'chart') (window as any).__lastChartModule = s.focusedModule;
  });
  createRoot(document.getElementById('root')!).render(<App />);
}

boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#e66">Failed to start: ${String(e?.message || e)}</div>`;
});
