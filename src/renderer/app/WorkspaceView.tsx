import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../state/store';
import { api, errorMessage } from '../api';
import { MODULE_INFO, type LayoutNode, type ModuleState, type DropPos, type ModuleType, setSizes, setActiveInStack, newId, defaultModuleConfig } from '../../shared/workspace';
import { Icon } from '../components/Icon';
import { Menu, usePopover, anchorOf } from '../components/ui';
import { clsx } from '../lib/format';
import { MODULES, moduleTitle } from '../modules/registry';
import { SYMBOL_SPECS, isSymbol } from '../../shared/symbols';

/** Modules portal their header controls into this element. */
export const HeadSlot = createContext<HTMLElement | null>(null);
export function HeadControls({ children }: { children: ReactNode }) {
  const slot = useContext(HeadSlot);
  return slot ? createPortal(children, slot) : null;
}

export interface ModuleProps {
  module: ModuleState;
  active: boolean;
}

const LINK_COLORS: Record<string, string> = { A: '#3b82f6', B: '#f59e0b', C: '#10b981', D: '#ec4899' };

export function WorkspaceView() {
  const ws = useApp((s) => s.workspace);
  const windowId = useApp((s) => s.windowId);
  const win = ws?.windows.find((w) => w.id === windowId);
  if (!ws || !win) return null;
  if (!win.root) return <EmptyWorkspace />;
  return (
    <div className="workspace">
      <NodeView node={win.root} />
    </div>
  );
}

function NodeView({ node }: { node: LayoutNode }) {
  if (node.type === 'stack') return <StackView node={node} />;
  return <SplitView node={node} />;
}

function SplitView({ node }: { node: Extract<LayoutNode, { type: 'split' }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setLocalSizes] = useState(node.sizes);
  const [dragging, setDragging] = useState(-1);
  useEffect(() => setLocalSizes(node.sizes), [node.sizes]);
  const onGutterDown = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    const total = node.dir === 'row' ? rect.width : rect.height;
    const start = node.dir === 'row' ? e.clientX : e.clientY;
    const s0 = sizes.slice();
    setDragging(i);
    let latest = s0;
    const move = (ev: MouseEvent) => {
      const cur = node.dir === 'row' ? ev.clientX : ev.clientY;
      const d = (cur - start) / total;
      const min = 0.05;
      const a = Math.max(min, Math.min(s0[i] + s0[i + 1] - min, s0[i] + d));
      const next = s0.slice();
      next[i] = a;
      next[i + 1] = s0[i] + s0[i + 1] - a;
      latest = next;
      setLocalSizes(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragging(-1);
      const st = useApp.getState();
      const w = st.workspace?.windows.find((x) => x.id === st.windowId);
      if (w) st.setRootLocal(setSizes(w.root, node.id, latest));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div ref={ref} className={clsx('split', node.dir === 'row' ? 'dir-row' : 'dir-col')}>
      {node.children.map((c, i) => (
        <SplitChild key={c.type === 'stack' ? c.id : c.id} size={sizes[i]} dir={node.dir} last={i === node.children.length - 1} gutter={i < node.children.length - 1 ? <div className={clsx('gutter', dragging === i && 'dragging')} onMouseDown={(e) => onGutterDown(i, e)} /> : null}>
          <NodeView node={c} />
        </SplitChild>
      ))}
    </div>
  );
}

function SplitChild({ size, children, gutter, dir }: { size: number; dir: 'row' | 'col'; last: boolean; children: ReactNode; gutter: ReactNode }) {
  return (
    <>
      <div className="pane" style={{ flex: `${size} 1 0`, [dir === 'row' ? 'minWidth' : 'minHeight']: 60 }}>
        {children}
      </div>
      {gutter}
    </>
  );
}

function StackView({ node }: { node: Extract<LayoutNode, { type: 'stack' }> }) {
  const ws = useApp((s) => s.workspace)!;
  const focused = useApp((s) => s.focusedModule);
  const dragModule = useApp((s) => s.dragModule);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = Math.min(node.active, node.modules.length - 1);
  const activeId = node.modules[active];
  const mod = ws.modules[activeId];
  const menu = usePopover();
  const addMenu = usePopover();
  const isFocused = node.modules.includes(focused || '');
  // maximized: the stack covers the workspace (the others stay mounted underneath, so nothing reloads)
  const maximized = useApp((s) => s.maximizedStack) === node.id;
  const toggleMax = () => useApp.getState().setMaximizedStack(maximized ? null : node.id);
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!maximized) {
      setBox(null);
      return;
    }
    const measure = () => {
      const w = document.querySelector('.workspace');
      if (w) setBox(w.getBoundingClientRect());
    };
    measure();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape' && !e.defaultPrevented && !typing && !useApp.getState().modals.length) useApp.getState().setMaximizedStack(null);
    };
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [maximized]);

  const setActive = (i: number) => {
    const st = useApp.getState();
    const w = st.workspace?.windows.find((x) => x.id === st.windowId);
    if (w) st.setRootLocal(setActiveInStack(w.root, node.id, i));
    st.setFocused(node.modules[i]);
  };

  const zoneFor = (e: React.DragEvent): DropPos => {
    const r = bodyRef.current!.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const edge = 0.25;
    if (fx < edge && fx <= fy && fx <= 1 - fy) return 'left';
    if (fx > 1 - edge && 1 - fx <= fy && 1 - fx <= 1 - fy) return 'right';
    if (fy < edge) return 'top';
    if (fy > 1 - edge) return 'bottom';
    return 'center';
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/x-fufu-module');
    const pos = zoneFor(e);
    setDropPos(null);
    useApp.getState().setDragModule(null);
    if (!id) return;
    if (node.modules.length === 1 && node.modules[0] === id) return;
    try {
      await api.call('ws:op', { kind: 'moveModule', moduleId: id, windowId: useApp.getState().windowId, targetStack: node.id, pos });
    } catch (err) {
      useApp.getState().toast({ title: 'Could not move module', body: errorMessage(err), kind: 'error' });
    }
  };

  if (!mod) return <div className="stack" />;
  const Comp = MODULES[mod.type]?.component;
  const link = mod.link;

  const moduleMenu = [
    { label: 'Duplicate', icon: 'copy', hint: 'Ctrl+Shift+D', onClick: () => api.call('ws:op', { kind: 'duplicateModule', moduleId: mod.id }) },
    { label: 'Open in new window', icon: 'detach', onClick: () => api.call('ws:detach', mod.id) },
    ...(useApp.getState().windowId !== 'main' ? [{ label: 'Move to main window', icon: 'attach', onClick: () => api.call('ws:op', { kind: 'moveModule', moduleId: mod.id, windowId: 'main', targetStack: null, pos: 'right' }) }] : []),
    { sep: true },
    { title: 'Symbol link' },
    ...[null, 'A', 'B', 'C', 'D'].map((g) => ({ label: g ? `Group ${g}` : 'Not linked', checked: (link || null) === g, onClick: () => api.call('ws:op', { kind: 'setModuleLink', moduleId: mod.id, link: g }) })),
    { sep: true },
    { label: 'Close', icon: 'x', danger: true, hint: 'Ctrl+W', onClick: () => api.call('ws:op', { kind: 'removeModule', moduleId: mod.id }) },
  ];

  return (
    <div
      className={clsx('stack', isFocused && 'focused', maximized && 'maximized')}
      style={maximized && box ? { position: 'fixed', left: box.left + 4, top: box.top + 4, width: box.width - 8, height: box.height - 8, zIndex: 40 } : undefined}
      data-stack-id={node.id}
      onMouseDownCapture={() => useApp.getState().setFocused(activeId)}
    >
      <div className="stack-head" onDoubleClick={(e) => (e.target as HTMLElement).closest('.stack-tabs') && toggleMax()}>
        <div className="stack-tabs">
          {node.modules.map((mid, i) => {
            const m = ws.modules[mid];
            if (!m) return null;
            return (
              <div
                key={mid}
                className={clsx('stack-tab', i === active && 'on', node.modules.length === 1 && 'only')}
                draggable
                onClick={() => setActive(i)}
                onAuxClick={(e) => e.button === 1 && api.call('ws:op', { kind: 'removeModule', moduleId: mid })}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-fufu-module', mid);
                  e.dataTransfer.effectAllowed = 'move';
                  useApp.getState().setDragModule(mid);
                }}
                onDragEnd={(e) => {
                  useApp.getState().setDragModule(null);
                  const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
                  if (e.dataTransfer.dropEffect === 'none' && outside) {
                    void api.call('ws:detach', mid, { x: e.screenX - 80, y: e.screenY - 18, width: 760, height: 520 });
                  }
                }}
                data-tip={node.modules.length > 1 ? undefined : 'Drag to rearrange · drag outside to detach'}
              >
                {m.link && <span className="link-dot" style={{ background: LINK_COLORS[m.link] }} />}
                <Icon name={MODULE_INFO[m.type]?.icon || 'grid'} size={14} />
                <span className="ellipsis">{moduleTitle(m)}</span>
              </div>
            );
          })}
        </div>
        <div className="head-controls" ref={setSlot} />
        <button className="icon-btn small" onClick={(e) => addMenu.toggle(e.currentTarget)} data-tip="Add module here">
          <Icon name="plus" size={15} />
        </button>
        <button className={clsx('icon-btn small', maximized && 'active')} onClick={toggleMax} data-tip={maximized ? 'Restore (Esc)' : 'Maximize (double-click the tab)'}>
          <Icon name={maximized ? 'restore' : 'max'} size={14} />
        </button>
        <button className="icon-btn small" onClick={(e) => menu.toggle(e.currentTarget)} data-tip="Module options">
          <Icon name="more" size={16} />
        </button>
        {menu.anchor && <Menu anchor={menu.anchor} items={moduleMenu} onClose={menu.close} align="end" width={220} />}
        {addMenu.anchor && <AddModuleMenu anchor={addMenu.anchor} onClose={addMenu.close} targetStack={node.id} near={mod} />}
      </div>
      <div
        className="stack-body"
        ref={bodyRef}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-fufu-module')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const z = zoneFor(e);
          if (z !== dropPos) setDropPos(z);
        }}
        onDragLeave={(e) => {
          if (!bodyRef.current?.contains(e.relatedTarget as Node)) setDropPos(null);
        }}
        onDrop={onDrop}
      >
        <HeadSlot.Provider value={slot}>{Comp ? <Comp key={mod.id} module={mod} active={true} /> : <div className="empty">Unknown module</div>}</HeadSlot.Provider>
        {(dropPos || dragModule) && dropPos && (
          <div className="drop-overlay">
            <div className="drop-zone" style={zoneStyle(dropPos)} />
          </div>
        )}
      </div>
    </div>
  );
}

function zoneStyle(p: DropPos): React.CSSProperties {
  const m = 6;
  switch (p) {
    case 'left':
      return { left: m, top: m, bottom: m, width: '45%' };
    case 'right':
      return { right: m, top: m, bottom: m, width: '45%' };
    case 'top':
      return { left: m, right: m, top: m, height: '45%' };
    case 'bottom':
      return { left: m, right: m, bottom: m, height: '45%' };
    default:
      return { left: m, right: m, top: m, bottom: m };
  }
}

export function AddModuleMenu({ anchor, onClose, targetStack, near }: { anchor: { x: number; y: number; w?: number; h?: number }; onClose: () => void; targetStack: string | null; near?: ModuleState }) {
  const add = useCallback(
    async (type: ModuleType, pos: DropPos | 'auto') => {
      onClose();
      const sym = near && isSymbol(near.config.symbol) ? near.config.symbol : 'BTCUSDT';
      const market = near && (near.config.market === 'futures' || near.config.market === 'spot') ? near.config.market : 'spot';
      const m: ModuleState = { id: newId('m'), type, config: defaultModuleConfig(type, sym, market), link: null };
      try {
        await useApp.getState().addModule(m, targetStack, pos);
      } catch (e) {
        useApp.getState().toast({ title: 'Could not add module', body: errorMessage(e), kind: 'error' });
      }
    },
    [targetStack, near, onClose],
  );
  const [pos, setPos] = useState<DropPos | 'auto'>('auto');
  return (
    <ModuleGridPopover anchor={anchor} onClose={onClose} onPick={(t) => add(t, pos)} header={targetStack ? <PosPicker pos={pos} setPos={setPos} /> : null} />
  );
}

function PosPicker({ pos, setPos }: { pos: DropPos | 'auto'; setPos: (p: DropPos | 'auto') => void }) {
  const opts: { v: DropPos | 'auto'; label: string }[] = [
    { v: 'auto', label: 'Auto' },
    { v: 'right', label: 'Split right' },
    { v: 'bottom', label: 'Split below' },
    { v: 'center', label: 'As tab' },
  ];
  return (
    <div className="seg" style={{ margin: '2px 4px 6px' }}>
      {opts.map((o) => (
        <button key={o.v} className={clsx(o.v === pos && 'on')} onClick={() => setPos(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModuleGridPopover({ anchor, onClose, onPick, header }: { anchor: { x: number; y: number; w?: number; h?: number }; onClose: () => void; onPick: (t: ModuleType) => void; header?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, top] = useMemo(() => {
    const w = 460;
    let x = anchor.x + (anchor.w || 0) - w;
    if (x < 8) x = 8;
    return [x, anchor.y + (anchor.h || 0) + 4];
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('mousedown', onDown, true), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="popover" style={{ left, top, width: 460, maxHeight: '80vh' }}>
      {header}
      <div className="module-grid" style={{ marginTop: 0, padding: 2 }}>
        {(Object.keys(MODULE_INFO) as ModuleType[]).map((t) => (
          <div key={t} className="module-card" onClick={() => onPick(t)}>
            <div className="mc-title">
              <Icon name={MODULE_INFO[t].icon} size={15} />
              {MODULE_INFO[t].title}
            </div>
            <div className="mc-desc">{MODULE_INFO[t].description}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function EmptyWorkspace() {
  const add = async (type: ModuleType) => {
    const m: ModuleState = { id: newId('m'), type, config: defaultModuleConfig(type), link: null };
    await useApp.getState().addModule(m, null, 'right');
  };
  return (
    <div className="empty-workspace">
      <div className="inner">
        <h3>Your workspace is empty</h3>
        <div className="muted">Add only what you need. Modules can be resized, rearranged by dragging their tab, opened in separate windows, and saved as presets.</div>
        <div className="module-grid">
          {(Object.keys(MODULE_INFO) as ModuleType[]).map((t) => (
            <div key={t} className="module-card" onClick={() => add(t)}>
              <div className="mc-title">
                <Icon name={MODULE_INFO[t].icon} size={15} />
                {MODULE_INFO[t].title}
              </div>
              <div className="mc-desc">{MODULE_INFO[t].description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { anchorOf, SYMBOL_SPECS };
