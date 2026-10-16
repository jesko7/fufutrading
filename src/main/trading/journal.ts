/**
 * Trade journal: notes, setup tags and a rating per closed trade of a paper account, so traders
 * can review their decisions and see which setups work (statistics per tag in the Account module).
 */
import path from 'node:path';
import type { AppCore } from '../core';
import { readJson, writeJsonAtomic } from '../storage/jsonStore';

export interface JournalEntry {
  note: string;
  tags: string[];
  /** 1–5, how well the trade followed the plan. */
  rating?: number;
  updated: number;
}

/** Journal entries of one account by trade key (`<trade id>:<close time>`). */
export type Journal = Record<string, JournalEntry>;

export class JournalService {
  private file: string;
  private data: Record<string, Journal>;
  private timer: NodeJS.Timeout | null = null;

  constructor(private core: AppCore) {
    this.file = path.join(core.paths.userData, 'journal.json');
    this.data = readJson<Record<string, Journal>>(this.file, {});
    core.onShutdown(() => this.flush());
  }

  get(accountId: string): Journal {
    return this.data[accountId] || {};
  }

  set(accountId: string, key: string, entry: Partial<JournalEntry> | null): Journal {
    const j = (this.data[accountId] ||= {});
    const note = String(entry?.note ?? '').slice(0, 4000);
    const tags = [...new Set((entry?.tags || []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 12);
    const rating = entry?.rating && entry.rating >= 1 && entry.rating <= 5 ? Math.round(entry.rating) : undefined;
    if (!entry || (!note.trim() && !tags.length && !rating)) delete j[key];
    else j[key] = { note, tags, rating, updated: Date.now() };
    this.schedule();
    this.core.router.broadcast('journal:changed', { accountId });
    return j;
  }

  /** Every tag in use, most used first (suggestions). */
  tags(): string[] {
    const n = new Map<string, number>();
    for (const j of Object.values(this.data)) for (const e of Object.values(j)) for (const t of e.tags) n.set(t, (n.get(t) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }

  remove(accountId: string): void {
    if (!this.data[accountId]) return;
    delete this.data[accountId];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeJsonAtomic(this.file, this.data);
  }
}

export function registerJournal(core: AppCore): JournalService {
  const svc = new JournalService(core);
  const r = core.router;
  r.handle('journal:get', ([accountId]) => svc.get(String(accountId)));
  r.handle('journal:set', ([accountId, key, entry]) => svc.set(String(accountId), String(key), entry ?? null));
  r.handle('journal:tags', () => svc.tags());
  return svc;
}
