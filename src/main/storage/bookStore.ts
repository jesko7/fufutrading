/**
 * Recorded order-book snapshots: one append-only file per instrument and UTC day,
 * data/books/<market>/<SYMBOL>/<YYYY-MM-DD>.fbk, holding records of
 *   [time: float64 LE][length: uint32 LE][frame bytes (shared/bookFrame)].
 * Readers walk the record headers and load only the frames they pick, so a 4-hour chart over
 * months reads one snapshot per bar instead of every minute.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Market } from '../../shared/symbols';

const DAY = 86_400_000;
const HEAD = 12;

export interface BookIndexEntry {
  t: number;
  file: string;
  pos: number;
  len: number;
}

export interface BookStoreStat {
  market: Market;
  symbol: string;
  days: number;
  bytes: number;
  first: number;
  last: number;
}

const dayName = (t: number) => new Date(Math.floor(t / DAY) * DAY).toISOString().slice(0, 10);

export class BookStore {
  constructor(readonly dir: string) {}

  private folder(market: Market, symbol: string): string {
    return path.join(this.dir, market, symbol);
  }

  append(market: Market, symbol: string, t: number, frame: Uint8Array): void {
    const dir = this.folder(market, symbol);
    fs.mkdirSync(dir, { recursive: true });
    const rec = Buffer.allocUnsafe(HEAD + frame.length);
    rec.writeDoubleLE(t, 0);
    rec.writeUInt32LE(frame.length, 8);
    rec.set(frame, HEAD);
    fs.appendFileSync(path.join(dir, `${dayName(t)}.fbk`), rec);
  }

  /** Record headers with from ≤ t < to, oldest first. A torn last record (crash mid-write) is skipped. */
  index(market: Market, symbol: string, from: number, to: number): BookIndexEntry[] {
    const out: BookIndexEntry[] = [];
    const dir = this.folder(market, symbol);
    if (!fs.existsSync(dir) || !(to > from)) return out;
    const days = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.fbk')));
    const head = Buffer.alloc(HEAD);
    for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
      const name = `${dayName(d)}.fbk`;
      if (!days.has(name)) continue;
      const file = path.join(dir, name);
      let fd: number;
      try {
        fd = fs.openSync(file, 'r');
      } catch {
        continue;
      }
      try {
        const size = fs.fstatSync(fd).size;
        let pos = 0;
        while (pos + HEAD <= size) {
          fs.readSync(fd, head, 0, HEAD, pos);
          const t = head.readDoubleLE(0);
          const len = head.readUInt32LE(8);
          if (pos + HEAD + len > size) break;
          if (t >= from && t < to) out.push({ t, file, pos: pos + HEAD, len });
          pos += HEAD + len;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return out;
  }

  /** The frame bytes of index entries (in the same order). */
  load(entries: BookIndexEntry[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    let fd = -1;
    let open = '';
    try {
      for (const e of entries) {
        if (e.file !== open) {
          if (fd >= 0) fs.closeSync(fd);
          fd = fs.openSync(e.file, 'r');
          open = e.file;
        }
        const b = new Uint8Array(e.len);
        fs.readSync(fd, b, 0, e.len, e.pos);
        out.push(b);
      }
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
    return out;
  }

  stats(): BookStoreStat[] {
    const out: BookStoreStat[] = [];
    for (const market of ['spot', 'futures'] as Market[]) {
      const md = path.join(this.dir, market);
      if (!fs.existsSync(md)) continue;
      for (const symbol of fs.readdirSync(md)) {
        const files = fs.readdirSync(path.join(md, symbol)).filter((f) => f.endsWith('.fbk')).sort();
        if (!files.length) continue;
        let bytes = 0;
        for (const f of files) bytes += fs.statSync(path.join(md, symbol, f)).size;
        const first = this.index(market, symbol, Date.parse(files[0].slice(0, 10)), Date.parse(files[0].slice(0, 10)) + DAY)[0]?.t ?? Date.parse(files[0].slice(0, 10));
        const lastDay = Date.parse(files[files.length - 1].slice(0, 10));
        const lastIdx = this.index(market, symbol, lastDay, lastDay + DAY);
        out.push({ market, symbol, days: files.length, bytes, first, last: lastIdx.length ? lastIdx[lastIdx.length - 1].t : lastDay });
      }
    }
    return out;
  }

  clear(market: Market, symbol: string): void {
    fs.rmSync(this.folder(market, symbol), { recursive: true, force: true });
  }

  /** Delete days that ended more than `keepDays` days before `now`. */
  prune(keepDays: number, now: number): void {
    if (!(keepDays > 0)) return;
    const cut = dayName(now - keepDays * DAY);
    for (const market of ['spot', 'futures'] as Market[]) {
      const md = path.join(this.dir, market);
      if (!fs.existsSync(md)) continue;
      for (const symbol of fs.readdirSync(md))
        for (const f of fs.readdirSync(path.join(md, symbol))) if (f.endsWith('.fbk') && f.slice(0, 10) < cut) fs.rmSync(path.join(md, symbol, f), { force: true });
    }
  }
}
