/**
 * CodeMirror setup shared by the script editor: theme driven by the app's CSS variables
 * (follows dark/light instantly), syntax colors, debugger line/breakpoint decorations.
 */
import { EditorView, Decoration, type DecorationSet, gutter, GutterMarker, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, keymap } from '@codemirror/view';
import { EditorState, StateField, StateEffect, RangeSet, type Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

export const editorTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--chart-bg)', height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important' },
  '.cm-gutters': { backgroundColor: 'var(--chart-bg)', color: 'var(--text-3)', border: 'none', paddingRight: '4px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-3)', border: 'none', color: 'var(--text-2)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 16%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '8px', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionInfo': { padding: '6px 9px', maxWidth: '360px', fontFamily: 'var(--font)' },
  '.cm-diagnostic': { padding: '5px 9px', fontFamily: 'var(--font)' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-search input, .cm-search button': { fontFamily: 'var(--font)' },
  '.cm-debug-line': { backgroundColor: 'color-mix(in srgb, var(--warn) 22%, transparent)' },
  '.cm-breakpoint-gutter': { width: '14px' },
  '.cm-breakpoint': { color: 'var(--danger)', fontSize: '11px', lineHeight: '1.55', cursor: 'pointer', textAlign: 'center' },
  '.cm-flash-line': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
});

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-kw)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--syn-meta)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syn-number)' },
  { tag: [t.atom, t.bool, t.null, t.constant(t.variableName)], color: 'var(--syn-atom)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.standard(t.variableName), t.special(t.variableName)], color: 'var(--syn-builtin)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: [t.propertyName], color: 'var(--syn-prop)' },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator], color: 'var(--syn-op)' },
  { tag: t.definition(t.variableName), color: 'var(--syn-def)' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

// ------------------------------------------------------------------ debugger decorations

export const setDebugLine = StateEffect.define<number | null>();

export const debugLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDebugLine)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none;
        else deco = Decoration.set([Decoration.line({ class: 'cm-debug-line' }).range(tr.state.doc.line(e.value).from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const flashLine = StateEffect.define<number | null>();
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) deco = e.value === null || e.value < 1 || e.value > tr.state.doc.lines ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(tr.state.doc.line(e.value).from)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const toggleBreakpoint = StateEffect.define<{ pos: number; on: boolean }>();
export const setBreakpoints = StateEffect.define<number[]>();

class BreakpointMarker extends GutterMarker {
  override toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-breakpoint';
    el.textContent = '●';
    return el;
  }
}
const bpMarker = new BreakpointMarker();

export const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleBreakpoint)) {
        if (e.value.on) set = set.update({ add: [bpMarker.range(e.value.pos)] });
        else set = set.update({ filter: (from) => from !== e.value.pos });
      } else if (e.is(setBreakpoints)) {
        const lines = e.value.filter((l) => l >= 1 && l <= tr.state.doc.lines).sort((a, b) => a - b);
        set = RangeSet.of(lines.map((l) => bpMarker.range(tr.state.doc.line(l).from)));
      }
    }
    return set;
  },
});

export function breakpointLines(state: EditorState): number[] {
  const out: number[] = [];
  const it = state.field(breakpointField).iter();
  while (it.value) {
    out.push(state.doc.lineAt(it.from).number);
    it.next();
  }
  return out;
}

export function breakpointGutter(onChange: (lines: number[]) => void): Extension {
  return [
    breakpointField,
    gutter({
      class: 'cm-breakpoint-gutter',
      markers: (v) => v.state.field(breakpointField),
      initialSpacer: () => bpMarker,
      domEventHandlers: {
        mousedown(view, line) {
          const has = (() => {
            let found = false;
            view.state.field(breakpointField).between(line.from, line.from, () => {
              found = true;
            });
            return found;
          })();
          view.dispatch({ effects: toggleBreakpoint.of({ pos: line.from, on: !has }) });
          onChange(breakpointLines(view.state));
          return true;
        },
      },
    }),
  ];
}

/** Basic editing extensions (like basicSetup, minus the bits we customise). */
export function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    editorTheme,
    debugLineField,
    flashField,
  ];
}
