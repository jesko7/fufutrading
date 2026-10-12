/**
 * Small, dependency-free JSON persistence with atomic writes (write tmp + rename) and
 * debounced flushing. Used for settings, workspaces, accounts, scripts, alerts, experiments.
 */
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can transiently lock files (AV scanners); retry once via copy.
    try {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } catch {
      throw e;
    }
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    // try backup
    try {
      const raw = fs.readFileSync(`${file}.bak`, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}

export function writeJsonAtomic(file: string, value: unknown, keepBackup = false): void {
  if (keepBackup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* ignore */
    }
  }
  writeFileAtomic(file, JSON.stringify(value, null, 1));
}

/** A single JSON document with debounced persistence. */
export class JsonFile<T extends object> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    readonly file: string,
    defaults: T,
    private delayMs = 300,
  ) {
    const loaded = readJson<Partial<T> | null>(file, null);
    this.value = loaded ? ({ ...defaults, ...loaded } as T) : defaults;
  }
  get(): T {
    return this.value;
  }
  set(v: T): void {
    this.value = v;
    this.schedule();
  }
  update(fn: (v: T) => T | void): T {
    const r = fn(this.value);
    if (r) this.value = r;
    this.schedule();
    return this.value;
  }
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeJsonAtomic(this.file, this.value, true);
  }
}

/** A directory of JSON documents keyed by id (one file each). */
export class DocStore<T extends { id: string }> {
  private cache = new Map<string, T>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;
  constructor(
    readonly dir: string,
    private delayMs = 400,
  ) {
    ensureDir(dir);
  }
  private fileOf(id: string): string {
    return path.join(this.dir, `${id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }
  loadAll(): T[] {
    if (!this.loaded) {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        const doc = readJson<T | null>(path.join(this.dir, f), null);
        if (doc && doc.id) this.cache.set(doc.id, doc);
      }
      this.loaded = true;
    }
    return [...this.cache.values()];
  }
  get(id: string): T | undefined {
    if (!this.loaded) this.loadAll();
    return this.cache.get(id);
  }
  put(doc: T, immediate = false): T {
    if (!this.loaded) this.loadAll();
    this.cache.set(doc.id, doc);
    this.dirty.add(doc.id);
    if (immediate) this.flush();
    else this.schedule();
    return doc;
  }
  delete(id: string): void {
    this.cache.delete(id);
    this.dirty.delete(id);
    try {
      fs.unlinkSync(this.fileOf(id));
    } catch {
      /* ignore */
    }
  }
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const id of this.dirty) {
      const doc = this.cache.get(id);
      if (doc) writeJsonAtomic(this.fileOf(id), doc, true);
    }
    this.dirty.clear();
  }
}

export function uid(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${r}`;
}
