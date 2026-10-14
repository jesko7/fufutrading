/**
 * Script Editor: Pine Script and Python with highlighting, completion, live diagnostics,
 * outline and go-to-definition, a script browser (built-ins, favorites, import/export),
 * one-click "add to chart" / "Strategy Tester", the bar inspector (per-bar values of variables,
 * synced with the chart crosshair) and the Python step debugger.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { linter, type Diagnostic, forceLinting } from '@codemirror/lint';
import { python } from '@codemirror/lang-python';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { Icon } from '../../components/Icon';
import { Menu, usePopover, confirmDialog, promptDialog, Spinner, Empty, Tabs, Toggle } from '../../components/ui';
import { clsx, fmtNum, autoDecimals, fmtDateTime } from '../../lib/format';
import { useSize } from '../../lib/hooks';
import { bus } from '../../lib/bus';
import { newId, type ChartModuleConfig, type IndicatorInstance } from '../../../shared/workspace';
import { pine, fufuPythonComplete } from './pineLang';
import { baseExtensions, breakpointGutter, breakpointLines, setBreakpoints, setDebugLine, flashLine } from './editorSetup';
import { TEMPLATES } from './templates';
import { useScripts, loadScripts, type ScriptDoc, type ScriptMeta, type AnalyzeResult } from './client';
import { openModule, activateModule } from '../../app/moduleOps';
import { lastChartId } from './focus';
import './scripts.css';

type Lang = 'pine' | 'python';
type Panel = 'problems' | 'outline' | 'inspector' | 'debugger' | 'console';

interface EditorCfg {
  scriptId: string | null;
  title?: string;
  browser?: boolean;
  panel?: Panel | null;
}

function draftKey(moduleId: string): string {
  return `fufu.scriptDraft.${moduleId}`;
}

function readDraft(moduleId: string): { scriptId: string | null; language: Lang; code: string; base: string } | null {
  try {
    const raw = localStorage.getItem(draftKey(moduleId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(moduleId: string, d: { scriptId: string | null; language: Lang; code: string; base: string } | null): void {
  try {
    if (d) localStorage.setItem(draftKey(moduleId), JSON.stringify(d));
    else localStorage.removeItem(draftKey(moduleId));
  } catch {
    /* storage unavailable */
  }
}

/** Chart the editor targets (last focused chart in this window, else the first one). */
function targetChart(): { id: string; cfg: ChartModuleConfig } | null {
  const st = useApp.getState();
  const ws = st.workspace;
  if (!ws) return null;
  const last = lastChartId();
  const m = (last && ws.modules[last]) || Object.values(ws.modules).find((x) => x.type === 'chart');
  return m && m.type === 'chart' ? { id: m.id, cfg: m.config as ChartModuleConfig } : null;
}

function targetSpec() {
  const c = targetChart()?.cfg;
  if (!c) return { symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' };
  return { symbol: c.symbol, market: c.market, tf: c.tf, chartType: c.chartType === 'heikinashi' || c.chartType === 'renko' ? c.chartType : 'candles', renko: c.chartType === 'renko' ? c.renko || { atrLength: 14 } : undefined };
}

function pythonOutline(code: string): { functions: { name: string; line: number; params: string[] }[]; variables: { name: string; line: number }[] } {
  const functions: { name: string; line: number; params: string[] }[] = [];
  const variables: { name: string; line: number }[] = [];
  code.split(/\r?\n/).forEach((l, k) => {
    let m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/.exec(l);
    if (m) functions.push({ name: m[1], line: k + 1, params: m[2].split(',').map((x) => x.trim().split(/[=:]/)[0]).filter(Boolean) });
    m = /^\s*class\s+([A-Za-z_]\w*)/.exec(l);
    if (m) functions.push({ name: `class ${m[1]}`, line: k + 1, params: [] });
    m = /^(?:\s{4})?([A-Za-z_]\w*)\s*=\s*(?!=)/.exec(l);
    if (m && !/^(if|for|while|return)$/.test(m[1])) variables.push({ name: m[1], line: k + 1 });
  });
  return { functions, variables };
}

export function ScriptEditorModule({ module }: ModuleProps) {
  const cfg = module.config as EditorCfg;
  const setCfg = useCallback((patch: Partial<EditorCfg>) => useApp.getState().setModuleConfig(module.id, patch), [module.id]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const [doc, setDoc] = useState<ScriptDoc | null>(null);
  const docRef = useRef<ScriptDoc | null>(null);
  docRef.current = doc;
  const [lang, setLang] = useState<Lang>('pine');
  const langRef = useRef<Lang>('pine');
  langRef.current = lang;
  const baseRef = useRef('');
  const [dirty, setDirty] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [saving, setSaving] = useState(false);
  const bpRef = useRef<number[]>([]);
  const menu = usePopover();
  const newMenu = usePopover();
  const aiMenu = usePopover();
  const panel = cfg.panel === undefined ? 'problems' : cfg.panel;
  const [rootRef, size] = useSize<HTMLDivElement>();
  const narrow = size.width > 0 && size.width < 720;
  // the library sidebar follows the explicit choice; by default it is shown only when there is room
  const showBrowser = cfg.browser === undefined ? !narrow : cfg.browser;

  // ------------------------------------------------------------------ editor construction

  const lintSource = useCallback(async (view: EditorView): Promise<Diagnostic[]> => {
    const code = view.state.doc.toString();
    const language = langRef.current;
    if (!code.trim()) {
      setAnalysis(null);
      return [];
    }
    setAnalyzing(true);
    try {
      const a = await api.call<AnalyzeResult>('scripts:analyze', language, code, targetSpec());
      if (view.state.doc.toString() !== code) return [];
      setAnalysis(a);
      const diags: Diagnostic[] = [];
      const lineRange = (line: number | undefined, col?: number) => {
        const n = Math.max(1, Math.min(view.state.doc.lines, line || 1));
        const l = view.state.doc.line(n);
        const from = col && col > 0 ? Math.min(l.to, l.from + col - 1) : l.from + (l.text.length - l.text.trimStart().length);
        return { from, to: Math.max(from + 1, Math.min(l.to, from + 1) === from + 1 && l.to > from ? l.to : from + 1) };
      };
      if (!a.ok && a.error) {
        const r = lineRange(a.error.line, a.error.col);
        diags.push({ ...r, to: Math.min(r.to, view.state.doc.length), severity: 'error', message: a.error.message, source: a.error.kind });
      }
      for (const w of a.warnings || []) {
        if (!w.line) continue;
        const r = lineRange(w.line);
        diags.push({ ...r, to: Math.min(r.to, view.state.doc.length), severity: w.kind === 'lookahead' || w.kind === 'repaint' ? 'warning' : 'info', message: w.message, source: w.kind });
      }
      return diags;
    } catch (e) {
      setAnalysis({ ok: false, language, error: { message: errorMessage(e), kind: 'compile' }, inputs: [], warnings: [], security: [] });
      return [];
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const languageExt = (l: Lang): Extension => (l === 'python' ? [python(), EditorState.languageData.of(() => [{ autocomplete: fufuPythonComplete }]), breakpointGutter((lines) => (bpRef.current = lines))] : pine());

  const makeState = useCallback(
    (code: string, l: Lang) =>
      EditorState.create({
        doc: code,
        extensions: [
          ...baseExtensions(),
          langComp.current.of(languageExt(l)),
          linter(lintSource, { delay: 650 }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
            { key: 'Mod-Enter', preventDefault: true, run: () => (void addToChart(), true) },
            { key: 'F12', run: (v) => goToDefinition(v) },
            { key: 'F5', run: () => (debugCmd('continue'), true) },
            { key: 'F10', run: () => (debugCmd('over'), true) },
            { key: 'F11', run: () => (debugCmd('step'), true) },
            { key: 'Shift-F11', run: () => (debugCmd('out'), true) },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const code2 = u.state.doc.toString();
              const d = code2 !== baseRef.current;
              setDirty(d);
              writeDraft(module.id, d ? { scriptId: docRef.current?.id || null, language: langRef.current, code: code2, base: baseRef.current } : null);
            }
            if (u.selectionSet || u.docChanged) {
              const pos = u.state.selection.main.head;
              const line = u.state.doc.lineAt(pos);
              setCursor({ line: line.number, col: pos - line.from + 1 });
            }
          }),
          EditorView.domEventHandlers({
            mousedown: (e, v) => {
              if (!(e.ctrlKey || e.metaKey)) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos === null) return false;
              v.dispatch({ selection: { anchor: pos } });
              return goToDefinition(v);
            },
          }),
        ],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lintSource],
  );

  useEffect(() => {
    const view = new EditorView({ state: makeState('', 'pine'), parent: hostRef.current! });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [makeState]);

  const loadIntoEditor = useCallback(
    (code: string, l: Lang, base: string) => {
      const view = viewRef.current;
      if (!view) return;
      setLang(l);
      langRef.current = l;
      baseRef.current = base;
      view.setState(makeState(code, l));
      setDirty(code !== base);
      setAnalysis(null);
      bpRef.current = [];
      forceLinting(view);
    },
    [makeState],
  );

  // ------------------------------------------------------------------ loading scripts

  const openScript = useCallback(
    async (id: string | null, opts: { line?: number; force?: boolean; draft?: { language: Lang; code: string } } = {}) => {
      if (dirty && !opts.force && !(await confirmDialog({ title: 'Discard unsaved changes?', body: `${docRef.current?.name || 'This script'} has unsaved changes.`, confirm: 'Discard', danger: true }))) return;
      writeDraft(module.id, null);
      if (!id) {
        const t = opts.draft || TEMPLATES[0];
        setDoc(null);
        loadIntoEditor(t.code, t.language, '');
        setCfg({ scriptId: null });
        return;
      }
      try {
        const d = await api.call<ScriptDoc>('scripts:get', id);
        setDoc(d);
        loadIntoEditor(d.code, d.language, d.code);
        if (cfg.scriptId !== id) setCfg({ scriptId: id });
        if (opts.line) setTimeout(() => jumpTo(opts.line!), 30);
      } catch (e) {
        toast({ title: 'Could not open script', body: errorMessage(e), kind: 'error' });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, loadIntoEditor, module.id, cfg.scriptId],
  );

  // initial load: restore a draft for this module, else the configured script, else a template
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !viewRef.current) return;
    loaded.current = true;
    const draft = readDraft(module.id);
    if (draft && (draft.scriptId || null) === (cfg.scriptId || null)) {
      if (draft.scriptId) {
        void api
          .call<ScriptDoc>('scripts:get', draft.scriptId)
          .then((d) => {
            setDoc(d);
            loadIntoEditor(draft.code, d.language, d.code);
          })
          .catch(() => loadIntoEditor(draft.code, draft.language, draft.base));
      } else loadIntoEditor(draft.code, draft.language, draft.base);
      return;
    }
    void openScript(cfg.scriptId || null, { force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // open requests from elsewhere (legend "source code", picker, AI)
  useEffect(
    () =>
      bus.on('scripts:open', (d: { moduleId: string; scriptId: string | null; line?: number; draft?: { language: Lang; code: string } }) => {
        if (d.moduleId !== module.id) return;
        if (d.scriptId && d.scriptId === docRef.current?.id) {
          if (d.line) jumpTo(d.line);
          return;
        }
        void openScript(d.scriptId, { line: d.line, draft: d.draft });
      }),
    [module.id, openScript],
  );

  // keep the doc meta fresh (rename / favorite from other places)
  useEffect(
    () =>
      api.on<{ id: string }>('scripts:changed', (e) => {
        const cur = docRef.current;
        if (!cur || e.id !== cur.id) return;
        void api
          .call<ScriptDoc>('scripts:get', cur.id)
          .then((d) => {
            setDoc(d);
            // saved elsewhere while we have no local edits: take the new code
            const view = viewRef.current;
            if (view && !dirtyRef.current && d.code !== view.state.doc.toString()) loadIntoEditor(d.code, d.language, d.code);
            else baseRef.current = d.code;
          })
          .catch(() => setDoc(null));
      }),
    [loadIntoEditor],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ------------------------------------------------------------------ actions

  function code(): string {
    return viewRef.current?.state.doc.toString() || '';
  }

  function jumpTo(line: number): void {
    const view = viewRef.current;
    if (!view) return;
    const n = Math.max(1, Math.min(view.state.doc.lines, line));
    const l = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: l.from }, effects: [EditorView.scrollIntoView(l.from, { y: 'center' }), flashLine.of(n)] });
    view.focus();
    setTimeout(() => view.dispatch({ effects: flashLine.of(null) }), 900);
  }

  function goToDefinition(view: EditorView): boolean {
    const pos = view.state.selection.main.head;
    const word = view.state.wordAt(pos);
    if (!word) return false;
    const name = view.state.sliceDoc(word.from, word.to);
    const text = view.state.doc.toString();
    const lines = text.split(/\r?\n/);
    const patterns = langRef.current === 'python' ? [new RegExp(`^\\s*(def|class)\\s+${name}\\b`), new RegExp(`^\\s*(self\\.)?${name}\\s*=(?!=)`)] : [new RegExp(`^\\s*${name}\\s*\\([^)]*\\)\\s*=>`), new RegExp(`^\\s*(var\\s+|varip\\s+)?([A-Za-z_]+\\s+)?${name}\\s*(:?=)(?!=)`), new RegExp(`^\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]\\s*=`), new RegExp(`^\\s*(type|enum)\\s+${name}\\b`)];
    for (const re of patterns) {
      const k = lines.findIndex((l) => re.test(l));
      if (k >= 0) {
        jumpTo(k + 1);
        return true;
      }
    }
    return false;
  }

  async function save(asCopy = false): Promise<ScriptDoc | null> {
    const c = code();
    const cur = docRef.current;
    setSaving(true);
    try {
      const saved = await api.call<ScriptDoc>('scripts:save', { id: asCopy ? null : cur?.id || null, language: langRef.current, code: c, name: asCopy && cur ? `${cur.name} (copy)` : undefined });
      baseRef.current = c;
      setDirty(false);
      writeDraft(module.id, null);
      setDoc(saved);
      if (saved.id !== cfg.scriptId) setCfg({ scriptId: saved.id });
      if (cur?.builtin && !asCopy) toast({ title: 'Saved as your own copy', body: 'Built-in scripts are read-only.', kind: 'info' });
      void loadScripts(true);
      return saved;
    } catch (e) {
      toast({ title: 'Save failed', body: errorMessage(e), kind: 'error' });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function ensureSaved(): Promise<ScriptDoc | null> {
    if (!dirtyRef.current && docRef.current) return docRef.current;
    return save();
  }

  async function addToChart(): Promise<void> {
    const d = await ensureSaved();
    if (!d) return;
    let chart = targetChart();
    if (!chart) {
      const id = await openModule('chart', {}, { reuse: false });
      await new Promise((r) => setTimeout(r, 300));
      const m = useApp.getState().workspace?.modules[id];
      chart = m ? { id, cfg: m.config as ChartModuleConfig } : null;
    }
    if (!chart) return;
    const inds = (chart.cfg.indicators || []) as IndicatorInstance[];
    if (inds.some((i) => i.scriptId === d.id)) {
      toast({ title: `${d.name} is already on the chart`, body: 'Saved changes update it automatically.', kind: 'info' });
      activateModule(chart.id);
      return;
    }
    useApp.getState().setModuleConfig(chart.id, { indicators: [...inds, { id: newId('i'), scriptId: d.id, inputs: {}, visible: true }] });
    toast({ title: `Added ${d.name}`, body: `${chart.cfg.symbol} ${chart.cfg.tf}`, kind: 'ok' });
  }

  async function openTester(): Promise<void> {
    const d = await ensureSaved();
    if (!d) return;
    const c = targetChart()?.cfg;
    await openModule('backtest', { scriptId: d.id, symbol: c?.symbol || 'BTCUSDT', market: c?.market || 'spot', tf: c?.tf || '1h', inputs: {}, autorun: Date.now() });
  }

  async function rename(): Promise<void> {
    const cur = docRef.current;
    if (!cur) {
      await save();
      return;
    }
    if (cur.builtin) {
      toast({ title: 'Built-in scripts are read-only', body: 'Save a copy to rename it.', kind: 'info' });
      return;
    }
    const name = await promptDialog({ title: 'Rename script', initial: cur.name, confirm: 'Rename' });
    if (!name) return;
    try {
      setDoc(await api.call<ScriptDoc>('scripts:rename', cur.id, name));
    } catch (e) {
      toast({ title: 'Rename failed', body: errorMessage(e), kind: 'error' });
    }
  }

  async function remove(): Promise<void> {
    const cur = docRef.current;
    if (!cur || cur.builtin) return;
    if (!(await confirmDialog({ title: `Delete ${cur.name}?`, body: 'The script is removed from your library. Charts using it will show an error.', confirm: 'Delete', danger: true }))) return;
    await api.call('scripts:delete', cur.id);
    void loadScripts(true);
    await openScript(null, { force: true });
  }

  // ------------------------------------------------------------------ inspector & debugger

  const [inspect, setInspect] = useState<{ times: Float64Array; vars: Record<string, Float64Array>; error?: string; logs: { bar: number; msg: string; level: string }[] } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [bar, setBar] = useState(-1);
  const runInspector = async () => {
    setInspecting(true);
    setCfg({ panel: 'inspector' });
    try {
      const r = await api.call<any>('scripts:inspect', { language: langRef.current, code: code(), spec: targetSpec() });
      setInspect({ times: r.times, vars: r.vars, error: r.ok ? undefined : `${r.error?.line ? `Line ${r.error.line}: ` : ''}${r.error?.message}`, logs: r.logs || [] });
      setBar(r.times.length - 1);
    } catch (e) {
      setInspect({ times: new Float64Array(0), vars: {}, error: errorMessage(e), logs: [] });
    } finally {
      setInspecting(false);
    }
  };
  useEffect(() => {
    if (!inspect || bar < 0 || bar >= inspect.times.length) return;
    bus.emit('crosshair', { time: inspect.times[bar], from: module.id });
  }, [bar, inspect, module.id]);

  const [dbg, setDbg] = useState<{ id: string; state: 'starting' | 'running' | 'paused' | 'done'; snapshot?: any; reason?: string; error?: string; logs?: { bar: number; msg: string; level: string }[] } | null>(null);
  const dbgRef = useRef(dbg);
  dbgRef.current = dbg;
  useEffect(
    () =>
      api.on<any>('scripts:debug', (e) => {
        const cur = dbgRef.current;
        if (!cur || e.id !== cur.id) return;
        if (e.kind === 'pause') {
          setDbg({ ...cur, state: 'paused', snapshot: e.snapshot, reason: e.reason });
          viewRef.current?.dispatch({ effects: setDebugLine.of(e.snapshot?.line ?? null) });
          if (e.snapshot?.line) jumpTo(e.snapshot.line);
          if (e.snapshot?.bar >= 0 && inspect?.times[e.snapshot.bar]) bus.emit('crosshair', { time: inspect.times[e.snapshot.bar], from: module.id });
        } else if (e.kind === 'done') {
          setDbg({ ...cur, state: 'done', error: e.ok ? undefined : `${e.error?.line ? `Line ${e.error.line}: ` : ''}${e.error?.message}`, logs: e.logs });
          viewRef.current?.dispatch({ effects: setDebugLine.of(null) });
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inspect, module.id],
  );
  const [breakOnNext, setBreakOnNext] = useState(true);
  const startDebug = async () => {
    if (langRef.current !== 'python') return;
    setCfg({ panel: 'debugger' });
    try {
      const view = viewRef.current;
      const bps = view ? breakpointLines(view.state) : [];
      setDbg({ id: '', state: 'starting' });
      const r = await api.call<{ id: string }>('scripts:debugStart', { language: 'python', code: code(), spec: targetSpec(), breakpoints: bps, breakOnNext });
      setDbg({ id: r.id, state: 'running' });
    } catch (e) {
      setDbg({ id: '', state: 'done', error: errorMessage(e) });
    }
  };
  function debugCmd(cmd: 'continue' | 'step' | 'over' | 'out' | 'stop'): void {
    const cur = dbgRef.current;
    if (!cur || !cur.id || (cur.state !== 'paused' && cmd !== 'stop')) return;
    const view = viewRef.current;
    void api.call('scripts:debugCmd', cur.id, cmd, view ? breakpointLines(view.state) : []);
    setDbg({ ...cur, state: cmd === 'stop' ? 'done' : 'running' });
    view?.dispatch({ effects: setDebugLine.of(null) });
  }

  // module tab shows the script name
  useEffect(() => {
    const t = doc?.name || 'Script Editor';
    if ((module.config as Record<string, unknown>).title !== t) setCfg({ title: t } as Partial<EditorCfg>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.name]);

  // reset debugger/inspector when switching scripts
  useEffect(() => {
    setInspect(null);
    setDbg(null);
    viewRef.current?.dispatch({ effects: [setDebugLine.of(null), setBreakpoints.of([])] });
  }, [doc?.id, lang]);

  // ------------------------------------------------------------------ render

  const scripts = useScripts();
  const meta = doc ? scripts?.find((s) => s.id === doc.id) : undefined;
  const title = doc?.name || (analysis?.meta?.title ? `${analysis.meta.title}` : 'Untitled');
  const kind = analysis?.meta?.type || doc?.kind;
  const errCount = analysis && !analysis.ok ? 1 : 0;
  const warnCount = (analysis?.warnings || []).filter((w) => w.kind === 'lookahead' || w.kind === 'repaint').length;
  const outline = useMemo(() => (lang === 'python' ? pythonOutline(code()) : { functions: analysis?.functions || [], variables: analysis?.variables || [] }), [analysis, lang]);

  return (
    <div className={clsx('script-editor', narrow && 'narrow')} ref={rootRef}>
      <HeadControls>
        <button className={clsx('icon-btn', showBrowser && 'active')} onClick={() => setCfg({ browser: !showBrowser })} data-tip="Script library">
          <Icon name="folder" />
        </button>
        <button className="se-title" onClick={() => void rename()} data-tip={doc?.builtin ? 'Built-in (read-only) — save a copy to edit' : 'Rename'}>
          <span className={clsx('lang-badge', lang)}>{lang === 'python' ? 'Py' : 'Pine'}</span>
          <span className="ellipsis">{title}</span>
          {doc?.builtin && <span className="tag">built-in</span>}
          {dirty && <span className="dirty-dot" data-tip="Unsaved changes" />}
        </button>
        {doc && !narrow && (
          <button className={clsx('icon-btn', meta?.favorite && 'fav')} onClick={() => void api.call('scripts:setFlag', doc.id, 'favorite', !meta?.favorite).then(() => loadScripts(true))} data-tip={meta?.favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <Icon name="star" size={15} />
          </button>
        )}
        <div className="spacer" />
        <button className="btn small" onClick={() => void save()} disabled={saving || (!dirty && !!doc)} data-tip="Save (Ctrl+S)">
          {saving ? <Spinner size={12} /> : <Icon name="save" size={14} />}
          {!narrow && ' Save'}
        </button>
        <button className="btn small primary" onClick={() => void addToChart()} data-tip="Add to chart (Ctrl+Enter)">
          <Icon name="chart" size={14} />
          {!narrow && ' Add to chart'}
        </button>
        {kind === 'strategy' && (
          <button className="btn small" onClick={() => void openTester()} data-tip="Backtest in the Strategy Tester">
            <Icon name="flask" size={14} />
            {!narrow && ' Test'}
          </button>
        )}
        <button className="icon-btn" onClick={() => void runInspector()} data-tip="Bar inspector: values of every variable on each bar">
          {inspecting ? <Spinner size={13} /> : <Icon name="layers" size={15} />}
        </button>
        {lang === 'python' && (
          <button className="icon-btn" onClick={() => void startDebug()} data-tip="Debug (step through next())">
            <Icon name="bug" size={15} />
          </button>
        )}
        <button className="btn small ghost ai-btn" onClick={(e) => aiMenu.toggle(e.currentTarget)} data-tip="Ask Claude about this script">
          <Icon name="spark" size={14} />
          {!narrow && ' AI'}
        </button>
        <button className="icon-btn" onClick={(e) => newMenu.toggle(e.currentTarget)} data-tip="New script">
          <Icon name="plus" />
        </button>
        {aiMenu.anchor && (
          <Menu
            anchor={aiMenu.anchor}
            onClose={aiMenu.close}
            align="end"
            width={280}
            items={(() => {
              const script = doc ? { id: doc.id, name: doc.name, language: lang } : { id: 'unsaved', name: title, language: lang };
              // unsaved changes travel with the request; saved scripts are read by id
              const base = { script, ...(dirty || !doc ? { selection: code() } : {}) };
              const err = analysis && !analysis.ok && analysis.error ? `${analysis.error.line ? `line ${analysis.error.line}: ` : ''}${analysis.error.message}` : undefined;
              const ask = (prompt: string, mode: 'build' | 'plan' | 'ask', send: boolean, extra: Record<string, unknown> = {}) => bus.emit('ai:open', { prompt, mode, send, context: { ...base, ...extra } }, false);
              return [
                { title: 'Claude' },
                ...(err ? [{ label: 'Fix the error', icon: 'bug', hint: 'build', onClick: () => ask("This script doesn't compile. Find the cause, fix it, verify with check_script (and a run on real data), then save the fixed version and explain the fix briefly.", 'build', true, { error: err }) }] : []),
                { label: 'Explain this script', icon: 'info', hint: 'ask', onClick: () => ask('Explain what this script does: the logic, how its signals or values are computed, what each input changes, and its main weaknesses or failure modes.', 'ask', true) },
                ...(kind === 'strategy'
                  ? [{ label: 'Assess this strategy', icon: 'flask', hint: 'plan', onClick: () => ask('Backtest this strategy on BTC, ETH and SOL over the last year with realistic costs, compare with buy & hold, check robustness (out-of-sample, parameter stability) and tell me honestly how good it is and what could improve it.', 'plan', true) }]
                  : [{ label: 'Check it on real data', icon: 'play', hint: 'ask', onClick: () => ask('Run this indicator on recent BTC data and check that the values behave as intended (warm-up, ranges, signals). Report anything suspicious.', 'ask', true) }]),
                { label: 'Improve it…', icon: 'spark', hint: 'build', onClick: () => ask('', 'build', false) },
                { sep: true },
                { label: 'New script with Claude…', icon: 'plus', onClick: () => bus.emit('ai:open', { prompt: '', mode: 'build', send: false }, false) },
              ];
            })()}
          />
        )}
        <button className="icon-btn" onClick={(e) => menu.toggle(e.currentTarget)} data-tip="More">
          <Icon name="more" />
        </button>
        {newMenu.anchor && <Menu anchor={newMenu.anchor} onClose={newMenu.close} align="end" width={270} items={[{ title: 'New script' }, ...TEMPLATES.map((t) => ({ label: t.label, hint: t.language === 'python' ? 'Python' : 'Pine', icon: 'code', onClick: () => void openScript(null, { draft: t }) }))]} />}
        {menu.anchor && (
          <Menu
            anchor={menu.anchor}
            onClose={menu.close}
            align="end"
            width={250}
            items={[
              { label: 'Save as copy', icon: 'copy', onClick: () => void save(true) },
              { label: 'Rename…', icon: 'edit', disabled: !doc || doc.builtin, onClick: () => void rename() },
              { sep: true },
              { label: 'Import .pine / .py…', icon: 'upload', onClick: () => void api.call<ScriptMeta[]>('scripts:import').then((l) => {
                    if (l.length) void openScript(l[0].id);
                  }).catch((e) => toast({ title: 'Import failed', body: errorMessage(e), kind: 'error' })) },
              { label: 'Export to file…', icon: 'download', disabled: !doc, onClick: () => doc && void ensureSaved().then(() => api.call('scripts:export', doc.id)).then((p) => p && toast({ title: 'Exported', body: String(p), kind: 'ok' })) },
              { label: 'Copy code', icon: 'copy', onClick: () => void api.call('clipboard:text', code()).then(() => toast({ title: 'Code copied', kind: 'ok' })) },
              { sep: true },
              { label: 'Delete', icon: 'trash', danger: true, disabled: !doc || doc.builtin, onClick: () => void remove() },
            ]}
          />
        )}
      </HeadControls>
      <div className="se-body">
        {showBrowser && <ScriptBrowser current={doc?.id || null} onOpen={(id) => void openScript(id)} />}
        <div className="se-main">
          <div className="se-editor" ref={hostRef} />
          <div className="se-status">
            <span className={clsx(errCount ? 'err' : 'ok')}>{analyzing ? <Spinner size={10} /> : errCount ? <Icon name="alert" size={12} /> : <Icon name="check" size={12} />}</span>
            <span>{analyzing && lang === 'python' && !analysis ? 'Starting Python…' : analysis ? (analysis.ok ? `${kind === 'strategy' ? 'Strategy' : 'Indicator'} · ${analysis.inputs.length} input${analysis.inputs.length === 1 ? '' : 's'}` : 'Error') : '—'}</span>
            {warnCount > 0 && <span className="warn">{warnCount} warning{warnCount > 1 ? 's' : ''}</span>}
            <div className="spacer" />
            <span className="muted">{dirty ? 'Unsaved' : doc ? 'Saved' : 'Not saved'}</span>
            <span className="muted">
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span className="muted">{lang === 'python' ? 'Python 3 · fufu' : 'Pine Script v5/v6'}</span>
          </div>
          {panel && (
            <div className="se-panel">
              <div className="se-panel-head">
                <Tabs
                  value={panel}
                  onChange={(p) => setCfg({ panel: p })}
                  tabs={[
                    { value: 'problems', label: 'Problems', badge: errCount + (analysis?.warnings.length || 0) ? <span className="badge">{errCount + (analysis?.warnings.length || 0)}</span> : undefined },
                    { value: 'outline', label: 'Outline' },
                    { value: 'inspector', label: 'Inspector' },
                    ...(lang === 'python' ? [{ value: 'debugger' as Panel, label: 'Debugger' }] : []),
                    { value: 'console', label: 'Console' },
                  ]}
                />
                <div className="spacer" />
                <button className="icon-btn small" onClick={() => setCfg({ panel: null })} data-tip="Hide panel">
                  <Icon name="chevDown" size={14} />
                </button>
              </div>
              <div className="se-panel-body">
                {panel === 'problems' && <Problems analysis={analysis} onJump={jumpTo} />}
                {panel === 'outline' && <Outline outline={outline} inputs={analysis?.inputs || []} onJump={jumpTo} />}
                {panel === 'inspector' && <Inspector data={inspect} running={inspecting} bar={bar} setBar={setBar} onRun={() => void runInspector()} lang={lang} />}
                {panel === 'debugger' && <Debugger dbg={dbg} breakOnNext={breakOnNext} setBreakOnNext={setBreakOnNext} onStart={() => void startDebug()} onCmd={debugCmd} onJump={jumpTo} />}
                {panel === 'console' && <Console logs={[...(inspect?.logs || []), ...(dbg?.logs || [])]} times={inspect?.times} />}
              </div>
            </div>
          )}
          {!panel && (
            <button className="se-panel-open" onClick={() => setCfg({ panel: 'problems' })}>
              <Icon name="chevUp" size={13} /> Panels
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ panels

function Problems({ analysis, onJump }: { analysis: AnalyzeResult | null; onJump: (line: number) => void }) {
  if (!analysis) return <div className="muted pad">Type to analyze…</div>;
  const items = [...(!analysis.ok && analysis.error ? [{ sev: 'error', line: analysis.error.line, msg: analysis.error.message, kind: analysis.error.kind }] : []), ...analysis.warnings.map((w) => ({ sev: w.kind === 'lookahead' || w.kind === 'repaint' ? 'warning' : 'info', line: w.line, msg: w.message, kind: w.kind }))];
  if (!items.length)
    return (
      <div className="muted pad">
        <Icon name="check" size={13} /> No problems. {analysis.meta && `${analysis.meta.type === 'strategy' ? 'Strategy' : 'Indicator'} "${analysis.meta.title}"`}
        {analysis.security.length > 0 && <span> · uses {analysis.security.map((k) => k.split(':').slice(1, 3).join(' ')).join(', ')}</span>}
      </div>
    );
  return (
    <div className="problems">
      {items.map((p, k) => (
        <button key={k} className={clsx('problem', p.sev)} onClick={() => p.line && onJump(p.line)}>
          <Icon name={p.sev === 'error' ? 'alert' : p.sev === 'warning' ? 'alert' : 'info'} size={13} />
          <span className="problem-msg">{p.msg}</span>
          <span className="muted">
            {p.kind}
            {p.line ? ` · line ${p.line}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

function Outline({ outline, inputs, onJump }: { outline: { functions: { name: string; line: number; params: string[] }[]; variables: { name: string; line: number }[] }; inputs: AnalyzeResult['inputs']; onJump: (line: number) => void }) {
  return (
    <div className="outline">
      <div className="outline-col">
        <div className="set-group-title">Functions</div>
        {!outline.functions.length && <div className="muted">—</div>}
        {outline.functions.map((f) => (
          <button key={`${f.name}${f.line}`} className="outline-item" onClick={() => onJump(f.line)}>
            <span className="mono">
              {f.name}
              {f.params.length || !f.name.startsWith('class') ? `(${f.params.join(', ')})` : ''}
            </span>
            <span className="muted">{f.line}</span>
          </button>
        ))}
      </div>
      <div className="outline-col">
        <div className="set-group-title">Variables</div>
        {!outline.variables.length && <div className="muted">—</div>}
        {outline.variables.map((v) => (
          <button key={`${v.name}${v.line}`} className="outline-item" onClick={() => onJump(v.line)}>
            <span className="mono">{v.name}</span>
            <span className="muted">{v.line}</span>
          </button>
        ))}
      </div>
      <div className="outline-col">
        <div className="set-group-title">Inputs</div>
        {!inputs.length && <div className="muted">—</div>}
        {inputs.map((i) => (
          <div key={i.key} className="outline-item static">
            <span>{i.title}</span>
            <span className="muted mono">
              {i.type} = {String(i.defval)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Inspector({ data, running, bar, setBar, onRun, lang }: { data: { times: Float64Array; vars: Record<string, Float64Array>; error?: string } | null; running: boolean; bar: number; setBar: (b: number) => void; onRun: () => void; lang: Lang }) {
  if (!data)
    return (
      <div className="pad">
        <button className="btn small" onClick={onRun} disabled={running}>
          {running ? <Spinner size={12} /> : <Icon name="play" size={13} />} Run inspector on the chart's data
        </button>
        <span className="muted" style={{ marginLeft: 10 }}>
          {lang === 'pine' ? 'Records every top-level variable on every bar. Step through bars — the chart crosshair follows.' : 'Records every plotted series per bar (use the debugger for locals in next()).'}
        </span>
      </div>
    );
  if (data.error) return <div className="pad err-text">{data.error}</div>;
  const n = data.times.length;
  const names = Object.keys(data.vars);
  const b = Math.max(0, Math.min(n - 1, bar));
  return (
    <div className="inspector">
      <div className="insp-bar">
        <button className="icon-btn small" onClick={() => setBar(0)} data-tip="First bar">
          <Icon name="chevLeft" size={13} />
          <Icon name="chevLeft" size={13} />
        </button>
        <button className="icon-btn small" onClick={() => setBar(Math.max(0, b - 1))} data-tip="Previous bar">
          <Icon name="chevLeft" size={14} />
        </button>
        <input type="range" min={0} max={Math.max(0, n - 1)} value={b} onChange={(e) => setBar(+e.target.value)} className="insp-range" />
        <button className="icon-btn small" onClick={() => setBar(Math.min(n - 1, b + 1))} data-tip="Next bar">
          <Icon name="chevRight" size={14} />
        </button>
        <span className="mono small">
          bar {b} · {n ? fmtDateTime(data.times[b]) : ''}
        </span>
        <div className="spacer" />
        <button className="btn small ghost" onClick={onRun} disabled={running}>
          {running ? <Spinner size={12} /> : <Icon name="refresh" size={13} />} Re-run
        </button>
      </div>
      <div className="insp-table">
        <table className="table">
          <thead>
            <tr>
              <th>Variable</th>
              <th className="num">bar {b}</th>
              <th className="num">bar {b - 1}</th>
              <th className="num">Δ</th>
            </tr>
          </thead>
          <tbody>
            {names.map((k) => {
              const a = data.vars[k];
              const v = a[b];
              const p = b > 0 ? a[b - 1] : NaN;
              const fmt = (x: number) => (Number.isFinite(x) ? fmtNum(x, autoDecimals(x)) : 'na');
              return (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="num mono">{fmt(v)}</td>
                  <td className="num mono muted">{fmt(p)}</td>
                  <td className={clsx('num mono', v > p ? 'up' : v < p ? 'down' : 'muted')}>{Number.isFinite(v) && Number.isFinite(p) ? fmt(v - p) : ''}</td>
                </tr>
              );
            })}
            {!names.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No top-level variables to record.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Debugger({ dbg, breakOnNext, setBreakOnNext, onStart, onCmd, onJump }: { dbg: { state: string; snapshot?: any; reason?: string; error?: string } | null; breakOnNext: boolean; setBreakOnNext: (v: boolean) => void; onStart: () => void; onCmd: (c: 'continue' | 'step' | 'over' | 'out' | 'stop') => void; onJump: (l: number) => void }) {
  const paused = dbg?.state === 'paused';
  const running = dbg && (dbg.state === 'running' || dbg.state === 'starting');
  const snap = dbg?.snapshot;
  return (
    <div className="debugger">
      <div className="insp-bar">
        {!paused && !running && (
          <button className="btn small primary" onClick={onStart}>
            <Icon name="bug" size={13} /> Start debugging
          </button>
        )}
        <button className="icon-btn small" disabled={!paused} onClick={() => onCmd('continue')} data-tip="Continue (F5)">
          <Icon name="play" size={14} />
        </button>
        <button className="icon-btn small" disabled={!paused} onClick={() => onCmd('over')} data-tip="Step over (F10)">
          <Icon name="stepOver" size={14} />
        </button>
        <button className="icon-btn small" disabled={!paused} onClick={() => onCmd('step')} data-tip="Step into (F11)">
          <Icon name="stepInto" size={14} />
        </button>
        <button className="icon-btn small" disabled={!paused} onClick={() => onCmd('out')} data-tip="Step out (Shift+F11)">
          <Icon name="chevUp" size={14} />
        </button>
        <button className="icon-btn small" disabled={!paused && !running} onClick={() => onCmd('stop')} data-tip="Stop">
          <Icon name="stop" size={14} />
        </button>
        <label className="row small muted" style={{ gap: 6, marginLeft: 8 }}>
          <Toggle value={breakOnNext} onChange={setBreakOnNext} /> Pause at the first next()
        </label>
        <div className="spacer" />
        <span className="small muted">{dbg ? (dbg.state === 'starting' ? 'Starting Python…' : dbg.state === 'running' ? 'Running…' : dbg.state === 'paused' ? `Paused (${dbg.reason}) · line ${snap?.line} · bar ${snap?.bar}` : 'Finished') : 'Click the gutter to set breakpoints'}</span>
      </div>
      {dbg?.error && <div className="pad err-text">{dbg.error}</div>}
      {paused && snap && (
        <div className="dbg-cols">
          <div className="insp-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(snap.locals || {}).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="mono ellipsis" style={{ maxWidth: 420 }} data-tip={String(v)}>
                      {String(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dbg-stack">
            <div className="set-group-title">Call stack</div>
            {(snap.stack || []).map((f: { fn: string; line: number }, k: number) => (
              <button key={k} className="outline-item" onClick={() => onJump(f.line)}>
                <span className="mono">{f.fn}</span>
                <span className="muted">{f.line}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!dbg && <Empty icon="bug" title="Python debugger">Runs the strategy on the focused chart's closed bars. Breakpoints pause inside next(); inspect locals, step line by line.</Empty>}
    </div>
  );
}

function Console({ logs, times }: { logs: { bar: number; msg: string; level: string }[]; times?: Float64Array }) {
  if (!logs.length) return <div className="muted pad">Script output (log.info / print / runtime messages) appears here after an inspector or debugger run.</div>;
  return (
    <div className="console">
      {logs.map((l, k) => (
        <div key={k} className={clsx('console-line', l.level)}>
          <span className="muted mono">{times && times[l.bar] ? fmtDateTime(times[l.bar]) : `bar ${l.bar}`}</span>
          <span className="mono">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ script browser

function ScriptBrowser({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
  const scripts = useScripts();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (scripts || []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.category || '').toLowerCase().includes(needle));
    const fav = list.filter((s) => s.favorite || s.pinned);
    const mine = list.filter((s) => !s.builtin);
    const builtin = list.filter((s) => s.builtin);
    return [
      { title: 'Favorites', items: fav },
      { title: 'My scripts', items: mine },
      { title: 'Built-in', items: builtin },
    ].filter((g) => g.items.length);
  }, [scripts, q]);
  return (
    <div className="se-browser">
      <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="se-browser-list">
        {!scripts && <Spinner />}
        {groups.map((g) => (
          <div key={g.title}>
            <div className="set-group-title">{g.title}</div>
            {g.items.map((s) => (
              <button key={`${g.title}${s.id}`} className={clsx('se-item', s.id === current && 'on')} onClick={() => onOpen(s.id)} data-tip={s.description}>
                <span className={clsx('lang-dot', s.language)} />
                <span className="ellipsis">{s.name}</span>
                {s.kind === 'strategy' && <Icon name="flask" size={11} />}
              </button>
            ))}
          </div>
        ))}
        {scripts && !groups.length && <div className="muted small">No scripts match.</div>}
      </div>
    </div>
  );
}
