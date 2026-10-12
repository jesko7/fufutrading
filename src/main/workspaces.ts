/**
 * WorkspaceService — source of truth for the active workspace (all windows, layouts and module
 * configs). Renderers send operations; the service applies them, autosaves, and broadcasts the
 * new state. Saved workspaces and user presets live in userData/workspaces.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  type Workspace,
  type ModuleState,
  type LayoutNode,
  type DropPos,
  type Rect,
  presetWorkspaces,
  emptyWorkspace,
  insertModule,
  removeModule,
  collectModules,
  pruneModules,
  cloneWorkspace,
  newId,
  stack,
} from '../shared/workspace';
import { DocStore, JsonFile } from './storage/jsonStore';

export type WorkspaceOp =
  | { kind: 'setRoot'; windowId: string; root: LayoutNode | null }
  | { kind: 'setModuleConfig'; moduleId: string; config: Record<string, any>; merge?: boolean }
  | { kind: 'setModuleLink'; moduleId: string; link: string | null }
  | { kind: 'addModule'; windowId: string; module: ModuleState; targetStack: string | null; pos: DropPos }
  | { kind: 'removeModule'; moduleId: string }
  | { kind: 'moveModule'; moduleId: string; windowId: string; targetStack: string | null; pos: DropPos }
  | { kind: 'duplicateModule'; moduleId: string }
  | { kind: 'rename'; name: string };

export interface WorkspaceListItem {
  id: string;
  name: string;
  description?: string;
  preset: boolean;
  builtin: boolean;
  updatedAt: number;
  modules: number;
  windows: number;
}

export class WorkspaceService extends EventEmitter {
  current: Workspace;
  rev = 0;
  private saved: DocStore<Workspace>;
  private currentFile: JsonFile<{ workspace: Workspace | null; sourceId: string | null }>;
  sourceId: string | null = null;
  private builtins = presetWorkspaces();

  constructor(dir: string) {
    super();
    this.saved = new DocStore<Workspace>(path.join(dir, 'workspaces'));
    this.currentFile = new JsonFile(path.join(dir, 'current-workspace.json'), { workspace: null, sourceId: null }, 800);
    const cur = this.currentFile.get();
    this.current = cur.workspace && cur.workspace.windows ? cur.workspace : emptyWorkspace();
    this.sourceId = cur.sourceId;
  }

  get hasSession(): boolean {
    return !!this.currentFile.get().workspace;
  }

  private commit(): void {
    this.current.updatedAt = Date.now();
    this.rev++;
    this.currentFile.set({ workspace: this.current, sourceId: this.sourceId });
    this.emit('changed', this.current, this.rev);
  }

  list(): WorkspaceListItem[] {
    const toItem = (w: Workspace, builtin: boolean): WorkspaceListItem => ({
      id: w.id,
      name: w.name,
      description: w.description,
      preset: !!w.preset,
      builtin,
      updatedAt: w.updatedAt,
      modules: Object.keys(w.modules).length,
      windows: w.windows.length,
    });
    return [...this.builtins.map((w) => toItem(w, true)), ...this.saved.loadAll().map((w) => toItem(w, false)).sort((a, b) => b.updatedAt - a.updatedAt)];
  }

  /** Load a builtin preset, saved workspace or 'empty'. A fresh copy becomes current. */
  load(id: string): Workspace {
    let src: Workspace | undefined;
    if (id === 'empty') src = emptyWorkspace();
    else src = this.builtins.find((w) => w.id === id) || this.saved.get(id);
    if (!src) throw new Error('Workspace not found');
    const isSaved = !!this.saved.get(id);
    this.current = isSaved ? JSON.parse(JSON.stringify(src)) : { ...cloneWorkspace(src, src.name), preset: false };
    this.sourceId = isSaved ? id : null;
    this.commit();
    this.emit('reload', this.current);
    return this.current;
  }

  loadByName(name: string): Workspace {
    const b = this.builtins.find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (!b) throw new Error(`Unknown preset ${name}`);
    return this.load(b.id);
  }

  /** Save current workspace (overwrite its saved source or create new). */
  save(name?: string, asPreset = false, asNew = false): WorkspaceListItem {
    let ws: Workspace;
    if (!asNew && this.sourceId && this.saved.get(this.sourceId)) {
      ws = { ...JSON.parse(JSON.stringify(this.current)), id: this.sourceId, name: name || this.current.name, preset: asPreset || !!this.saved.get(this.sourceId)?.preset };
    } else {
      ws = { ...JSON.parse(JSON.stringify(this.current)), id: newId('ws'), name: name || this.current.name, preset: asPreset };
      this.sourceId = ws.id;
    }
    ws.updatedAt = Date.now();
    this.current.name = ws.name;
    this.saved.put(ws, true);
    this.commit();
    return this.list().find((x) => x.id === ws.id)!;
  }

  delete(id: string): void {
    this.saved.delete(id);
    if (this.sourceId === id) this.sourceId = null;
  }

  rename(id: string, name: string): void {
    const w = this.saved.get(id);
    if (w) this.saved.put({ ...w, name }, true);
    if (this.sourceId === id) {
      this.current.name = name;
      this.commit();
    }
  }

  apply(op: WorkspaceOp): Workspace {
    const ws = this.current;
    switch (op.kind) {
      case 'setRoot': {
        const w = ws.windows.find((x) => x.id === op.windowId);
        if (!w) throw new Error('Unknown window');
        w.root = op.root;
        break;
      }
      case 'setModuleConfig': {
        const m = ws.modules[op.moduleId];
        if (!m) return ws;
        m.config = op.merge === false ? op.config : { ...m.config, ...op.config };
        // propagate instrument to linked modules
        if (m.link && (op.config.symbol || op.config.market)) {
          for (const other of Object.values(ws.modules)) {
            if (other.id === m.id || other.link !== m.link) continue;
            if ('symbol' in other.config) other.config = { ...other.config, symbol: m.config.symbol, market: m.config.market ?? other.config.market };
          }
        }
        break;
      }
      case 'setModuleLink': {
        const m = ws.modules[op.moduleId];
        if (m) m.link = op.link;
        break;
      }
      case 'addModule': {
        ws.modules[op.module.id] = op.module;
        const w = ws.windows.find((x) => x.id === op.windowId) || ws.windows[0];
        w.root = insertModule(w.root, op.module.id, op.targetStack, op.pos);
        break;
      }
      case 'removeModule': {
        for (const w of ws.windows) w.root = removeModule(w.root, op.moduleId);
        delete ws.modules[op.moduleId];
        // close detached windows that became empty
        const empty = ws.windows.filter((w) => !w.main && !w.root);
        if (empty.length) {
          ws.windows = ws.windows.filter((w) => w.main || w.root);
          for (const w of empty) this.emit('closeWindow', w.id);
        }
        break;
      }
      case 'moveModule': {
        for (const w of ws.windows) w.root = removeModule(w.root, op.moduleId);
        const w = ws.windows.find((x) => x.id === op.windowId) || ws.windows[0];
        w.root = insertModule(w.root, op.moduleId, op.targetStack, op.pos);
        const empty = ws.windows.filter((x) => !x.main && !x.root);
        if (empty.length) {
          ws.windows = ws.windows.filter((x) => x.main || x.root);
          for (const e of empty) this.emit('closeWindow', e.id);
        }
        break;
      }
      case 'duplicateModule': {
        const m = ws.modules[op.moduleId];
        if (!m) return ws;
        const copy: ModuleState = JSON.parse(JSON.stringify(m));
        copy.id = newId('m');
        if (Array.isArray(copy.config.drawings)) copy.config.drawings = copy.config.drawings.map((d: any) => ({ ...d, id: newId('d') }));
        ws.modules[copy.id] = copy;
        const w = ws.windows.find((x) => collectModules(x.root).includes(op.moduleId)) || ws.windows[0];
        const stackNode = findStackId(w.root, op.moduleId);
        w.root = insertModule(w.root, copy.id, stackNode, 'right');
        break;
      }
      case 'rename':
        ws.name = op.name;
        break;
    }
    this.current = pruneModules(ws);
    this.commit();
    return this.current;
  }

  /** Move a module into a new detached window. Returns the new window id. */
  detach(moduleId: string, bounds?: Rect): string {
    const ws = this.current;
    if (!ws.modules[moduleId]) throw new Error('Unknown module');
    for (const w of ws.windows) w.root = removeModule(w.root, moduleId);
    const id = newId('w');
    ws.windows.push({ id, main: false, root: stack([moduleId]), bounds });
    const empty = ws.windows.filter((x) => !x.main && !x.root);
    ws.windows = ws.windows.filter((x) => x.main || x.root);
    for (const e of empty) this.emit('closeWindow', e.id);
    this.commit();
    this.emit('openWindow', id);
    return id;
  }

  /** Dock all modules of a detached window back into the main window. */
  reattachWindow(windowId: string): void {
    const ws = this.current;
    const w = ws.windows.find((x) => x.id === windowId);
    const main = ws.windows.find((x) => x.main)!;
    if (!w || w.main) return;
    for (const m of collectModules(w.root)) main.root = insertModule(main.root, m, null, 'right');
    ws.windows = ws.windows.filter((x) => x.id !== windowId);
    this.commit();
    this.emit('closeWindow', windowId);
  }

  /** A detached window was closed by the user: its modules are removed. */
  windowClosed(windowId: string): void {
    const ws = this.current;
    const w = ws.windows.find((x) => x.id === windowId);
    if (!w || w.main) return;
    ws.windows = ws.windows.filter((x) => x.id !== windowId);
    this.current = pruneModules(ws);
    this.commit();
  }

  setBounds(windowId: string, bounds: Rect, maximized: boolean): void {
    const w = this.current.windows.find((x) => x.id === windowId);
    if (!w) return;
    w.bounds = bounds;
    w.maximized = maximized;
    this.currentFile.set({ workspace: this.current, sourceId: this.sourceId });
  }

  flush(): void {
    this.currentFile.flush();
    this.saved.flush();
  }
}

function findStackId(root: LayoutNode | null, moduleId: string): string | null {
  if (!root) return null;
  if (root.type === 'stack') return root.modules.includes(moduleId) ? root.id : null;
  for (const c of root.children) {
    const r = findStackId(c, moduleId);
    if (r) return r;
  }
  return null;
}
