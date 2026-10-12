import { useApp } from '../state/store';
import { TitleBar } from './TitleBar';
import { StartScreen } from './StartScreen';
import { WorkspaceView } from './WorkspaceView';
import { ModalHost, Toasts, TooltipHost } from '../components/ui';
import { CommandPalette, TimeframeInput, useGlobalShortcuts } from './shortcuts';

export function App() {
  const showStart = useApp((s) => s.showStart);
  const ws = useApp((s) => s.workspace);
  useGlobalShortcuts();
  return (
    <div className="app">
      <TitleBar />
      {showStart || !ws ? <StartScreen /> : <WorkspaceView />}
      <Toasts />
      <ModalHost />
      <TooltipHost />
      <CommandPalette />
      <TimeframeInput />
    </div>
  );
}
