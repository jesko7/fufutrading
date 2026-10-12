/**
 * ScriptLibrary — the user's Pine/Python scripts (one JSON document each under
 * userData/scripts) plus the read-only built-in library shipped with the app. Favorites and
 * pinned flags apply to both. Built-ins are edited by saving a copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DocStore, JsonFile, uid } from '../storage/jsonStore';
import type { ScriptLanguage } from '../../engine/types';

export type ScriptKind = 'indicator' | 'strategy' | 'library' | 'unknown';

export interface ScriptMeta {
  id: string;
  name: string;
  language: ScriptLanguage;
  kind: ScriptKind;
  overlay?: boolean;
  description?: string;
  category?: string;
  builtin: boolean;
  favorite: boolean;
  pinned: boolean;
  created: number;
  updated: number;
  /** For built-ins: file name; for imports: original path. */
  origin?: string;
  /** Script this one was copied from. */
  from?: string;
}

export interface ScriptDoc extends ScriptMeta {
  code: string;
}

interface StoredScript {
  id: string;
  name: string;
  language: ScriptLanguage;
  code: string;
  description?: string;
  created: number;
  updated: number;
  origin?: string;
  from?: string;
}

interface Prefs {
  favorites: string[];
  pinned: string[];
}

/** Read `// @key value` (Pine) or `# @key value` (Python) header tags. */
export function headerTags(code: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const line of code.split(/\r?\n/).slice(0, 25)) {
    const m = /^\s*(?:\/\/|#)\s*@(name|category|description)\s+(.+?)\s*$/.exec(line);
    if (m) tags[m[1]] = m[2];
  }
  return tags;
}

/** Cheap static detection of kind/title/overlay (no compilation). */
export function sniff(language: ScriptLanguage, code: string): { kind: ScriptKind; title?: string; overlay?: boolean } {
  if (language === 'python') {
    const m = /@(indicator|strategy)\s*\(\s*(?:title\s*=\s*)?(['"])(.*?)\2/.exec(code);
    if (!m) return { kind: /@(indicator|strategy)\b/.test(code) ? (/@strategy\b/.test(code) ? 'strategy' : 'indicator') : 'unknown' };
    const call = code.slice(m.index, code.indexOf(')', m.index) + 1);
    const ov = /overlay\s*=\s*(True|False)/.exec(call);
    return { kind: m[1] as ScriptKind, title: m[3], overlay: ov ? ov[1] === 'True' : m[1] === 'strategy' };
  }
  const m = /^\s*(indicator|strategy|study|library)\s*\(\s*(?:title\s*=\s*)?(['"])(.*?)\2/m.exec(code);
  if (!m) return { kind: 'unknown' };
  const kind = m[1] === 'study' ? 'indicator' : (m[1] as ScriptKind);
  const rest = code.slice(m.index, m.index + 600);
  const ov = /overlay\s*=\s*(true|false)/.exec(rest);
  return { kind, title: m[3], overlay: ov ? ov[1] === 'true' : false };
}

export function languageOfFile(file: string, code: string): ScriptLanguage {
  if (/\.py$/i.test(file)) return 'python';
  if (/\.(pine|pinescript)$/i.test(file)) return 'pine';
  return /^\s*(from\s+\w+\s+import|import\s+\w+|def\s+\w+\(|class\s+\w+)/m.test(code) && !/^\s*\/\/@version/m.test(code) ? 'python' : 'pine';
}

export class ScriptLibrary extends EventEmitter {
  private store: DocStore<StoredScript>;
  private prefs: JsonFile<Prefs>;
  private builtins = new Map<string, ScriptDoc>();
  private user = new Map<string, StoredScript>();

  constructor(userData: string, builtinDir: string | null) {
    super();
    this.store = new DocStore<StoredScript>(path.join(userData, 'scripts'));
    this.prefs = new JsonFile<Prefs>(path.join(userData, 'scripts-prefs.json'), { favorites: [], pinned: [] });
    for (const d of this.store.loadAll()) if (d && d.id && typeof d.code === 'string') this.user.set(d.id, d);
    if (builtinDir) this.loadBuiltins(builtinDir);
  }

  private loadBuiltins(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.(pine|py)$/.test(f)) continue;
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      const language: ScriptLanguage = f.endsWith('.py') ? 'python' : 'pine';
      const tags = headerTags(code);
      const s = sniff(language, code);
      const id = `builtin:${f.replace(/\.(pine|py)$/, '')}`;
      this.builtins.set(id, {
        id,
        name: tags.name || s.title || f,
        language,
        kind: s.kind,
        overlay: s.overlay,
        description: tags.description,
        category: tags.category || (s.kind === 'strategy' ? 'Strategies' : 'Indicators'),
        builtin: true,
        favorite: false,
        pinned: false,
        created: 0,
        updated: 0,
        origin: f,
        code,
      });
    }
  }

  private flags(id: string): { favorite: boolean; pinned: boolean } {
    const p = this.prefs.get();
    return { favorite: p.favorites.includes(id), pinned: p.pinned.includes(id) };
  }

  private userDoc(d: StoredScript): ScriptDoc {
    const s = sniff(d.language, d.code);
    const tags = headerTags(d.code);
    return {
      id: d.id,
      name: d.name,
      language: d.language,
      kind: s.kind,
      overlay: s.overlay,
      description: d.description || tags.description,
      category: tags.category || 'My scripts',
      builtin: false,
      ...this.flags(d.id),
      created: d.created,
      updated: d.updated,
      origin: d.origin,
      from: d.from,
      code: d.code,
    };
  }

  list(): ScriptMeta[] {
    const out: ScriptMeta[] = [];
    for (const d of this.user.values()) {
      const { code: _c, ...meta } = this.userDoc(d);
      void _c;
      out.push(meta);
    }
    out.sort((a, b) => b.updated - a.updated);
    for (const b of this.builtins.values()) {
      const { code: _c, ...meta } = b;
      void _c;
      out.push({ ...meta, ...this.flags(b.id) });
    }
    return out;
  }

  get(id: string): ScriptDoc | undefined {
    const b = this.builtins.get(id);
    if (b) return { ...b, ...this.flags(id) };
    const d = this.user.get(id);
    return d ? this.userDoc(d) : undefined;
  }

  /** Create or update a user script. Saving a built-in (or an unknown id) creates a copy. */
  save(input: { id?: string | null; name?: string; language: ScriptLanguage; code: string; description?: string; origin?: string }): ScriptDoc {
    if (input.language !== 'pine' && input.language !== 'python') throw new Error('Validation: language must be pine or python');
    if (typeof input.code !== 'string') throw new Error('Validation: code must be a string');
    if (input.code.length > 2_000_000) throw new Error('Validation: script is too large (2 MB max)');
    const now = Date.now();
    const existing = input.id ? this.user.get(input.id) : undefined;
    const fromBuiltin = input.id && this.builtins.has(input.id) ? input.id : undefined;
    const sn = sniff(input.language, input.code);
    const name = (input.name || existing?.name || sn.title || 'Untitled script').trim().slice(0, 120) || 'Untitled script';
    const doc: StoredScript = existing
      ? { ...existing, name, language: input.language, code: input.code, description: input.description ?? existing.description, updated: now }
      : { id: uid('s'), name: fromBuiltin && !input.name ? `${name} (copy)` : name, language: input.language, code: input.code, description: input.description, created: now, updated: now, origin: input.origin, from: fromBuiltin };
    this.user.set(doc.id, doc);
    this.store.put(doc, true);
    const full = this.userDoc(doc);
    this.emit('changed', doc.id);
    return full;
  }

  rename(id: string, name: string): ScriptDoc {
    const d = this.user.get(id);
    if (!d) throw new Error(this.builtins.has(id) ? 'Built-in scripts cannot be renamed — save a copy first' : 'Script not found');
    return this.save({ id, name, language: d.language, code: d.code });
  }

  duplicate(id: string): ScriptDoc {
    const d = this.get(id);
    if (!d) throw new Error('Script not found');
    const now = Date.now();
    const doc: StoredScript = { id: uid('s'), name: `${d.name} (copy)`, language: d.language, code: d.code, description: d.description, created: now, updated: now, from: id };
    this.user.set(doc.id, doc);
    this.store.put(doc, true);
    this.emit('changed', doc.id);
    return this.userDoc(doc);
  }

  delete(id: string): void {
    if (this.builtins.has(id)) throw new Error('Built-in scripts cannot be deleted');
    if (!this.user.has(id)) return;
    this.user.delete(id);
    this.store.delete(id);
    this.prefs.update((p) => {
      p.favorites = p.favorites.filter((x) => x !== id);
      p.pinned = p.pinned.filter((x) => x !== id);
    });
    this.emit('changed', id);
  }

  setFlag(id: string, flag: 'favorite' | 'pinned', on: boolean): void {
    if (!this.get(id)) throw new Error('Script not found');
    this.prefs.update((p) => {
      const key = flag === 'favorite' ? 'favorites' : 'pinned';
      const set = new Set(p[key]);
      if (on) set.add(id);
      else set.delete(id);
      p[key] = [...set];
    });
    this.emit('changed', id);
  }

  importFile(file: string): ScriptDoc {
    const stat = fs.statSync(file);
    if (stat.size > 2_000_000) throw new Error(`${path.basename(file)} is too large`);
    const code = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const language = languageOfFile(file, code);
    const s = sniff(language, code);
    return this.save({ name: s.title || path.basename(file).replace(/\.[^.]+$/, ''), language, code, origin: file });
  }

  exportFile(id: string, file: string): void {
    const d = this.get(id);
    if (!d) throw new Error('Script not found');
    fs.writeFileSync(file, d.code, 'utf8');
  }

  flush(): void {
    this.store.flush();
    this.prefs.flush();
  }
}
