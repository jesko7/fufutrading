/** Helpers to locate, focus and open modules in the current window's layout. */
import { useApp } from '../state/store';
import { api } from '../api';
import { newId, defaultModuleConfig, type LayoutNode, type ModuleState, type ModuleType } from '../../shared/workspace';

function currentRoot(): LayoutNode | null {
  const st = useApp.getState();
  return st.workspace?.windows.find((w) => w.id === st.windowId)?.root || null;
}

function mapStacks(n: LayoutNode, fn: (s: Extract<LayoutNode, { type: 'stack' }>) => LayoutNode): LayoutNode {
  if (n.type === 'stack') return fn(n);
  return { ...n, children: n.children.map((c) => mapStacks(c, fn)) } as LayoutNode;
}

function stacksOf(n: LayoutNode | null, out: Extract<LayoutNode, { type: 'stack' }>[] = []): Extract<LayoutNode, { type: 'stack' }>[] {
  if (!n) return out;
  if (n.type === 'stack') out.push(n);
  else for (const c of n.children) stacksOf(c, out);
  return out;
}

/** Modules of a type that are visible in this window's layout. */
export function modulesInWindow(type: ModuleType): ModuleState[] {
  const st = useApp.getState();
  const ws = st.workspace;
  if (!ws) return [];
  const ids = new Set(stacksOf(currentRoot()).flatMap((s) => s.modules));
  return Object.values(ws.modules).filter((m) => m.type === type && ids.has(m.id));
}

/** Make a module the active tab of its stack and focus it. */
export function activateModule(moduleId: string): void {
  const st = useApp.getState();
  const root = currentRoot();
  if (!root) return;
  let changed = false;
  const next = mapStacks(root, (s) => {
    const k = s.modules.indexOf(moduleId);
    if (k >= 0 && s.active !== k) {
      changed = true;
      return { ...s, active: k };
    }
    return s;
  });
  if (changed) {
    st.setRootLocal(next);
    void api.call('ws:op', { kind: 'setRoot', windowId: st.windowId, root: next });
  }
  st.setFocused(moduleId);
}

/** Focus an existing module of `type` (applying `config`), or add one next to the focused module. */
export async function openModule(type: ModuleType, config: Record<string, unknown> = {}, opts: { reuse?: boolean } = {}): Promise<string> {
  const st = useApp.getState();
  if (opts.reuse !== false) {
    const existing = modulesInWindow(type)[0];
    if (existing) {
      if (Object.keys(config).length) st.setModuleConfig(existing.id, config);
      activateModule(existing.id);
      return existing.id;
    }
  }
  const root = currentRoot();
  const focused = st.focusedModule;
  const stack = stacksOf(root).find((s) => focused && s.modules.includes(focused)) || null;
  const id = newId('m');
  await st.addModule({ id, type, config: { ...defaultModuleConfig(type), ...config }, link: null }, stack?.id || null, 'auto');
  return id;
}
