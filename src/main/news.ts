/**
 * News: headlines from crypto news RSS/Atom feeds, fetched in the main process (no CORS, no
 * tracking scripts), tagged with the coins they mention, cached, refreshed every few minutes
 * while a news window is open. Articles open in the user's browser.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { AppCore } from './core';
import { readJson, writeJsonAtomic } from './storage/jsonStore';

export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  builtin?: boolean;
}

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  feedId: string;
  t: number;
  summary: string;
  coins: ('BTC' | 'ETH' | 'SOL')[];
}

export const DEFAULT_FEEDS: NewsFeed[] = [
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', enabled: true, builtin: true },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', enabled: true, builtin: true },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', enabled: true, builtin: true },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', enabled: true, builtin: true },
  { id: 'bitcoinmagazine', name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', enabled: true, builtin: true },
  { id: 'cryptoslate', name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', enabled: false, builtin: true },
];

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function text(s: string | undefined): string {
  if (!s) return '';
  let x = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  x = decodeEntities(x); // entity-encoded HTML first, then strip tags
  x = x.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(x).replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : undefined;
}

function attr(block: string, name: string, a: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["'][^>]*>`, 'i').exec(block);
  return m ? m[1] : undefined;
}

export function coinsOf(s: string): NewsItem['coins'] {
  const out: NewsItem['coins'] = [];
  if (/\b(bitcoin|btc)\b/i.test(s)) out.push('BTC');
  if (/\b(ethereum|ether|eth)\b/i.test(s)) out.push('ETH');
  if (/\bsolana\b|\bSOL\b/.test(s)) out.push('SOL');
  return out;
}

/** Parse RSS 2.0 or Atom into items (tolerant regex parser — feeds are simple and often sloppy). */
export function parseFeed(xml: string, feed: Pick<NewsFeed, 'id' | 'name'>): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = text(tag(b, 'title'));
    let link = text(tag(b, 'link'));
    if (!/^https?:\/\//.test(link)) link = attr(b, 'link', 'href') || text(tag(b, 'guid')) || '';
    if (!title || !/^https?:\/\//.test(link)) continue;
    const date = text(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(date);
    const summary = text(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')).slice(0, 320);
    items.push({
      id: crypto.createHash('sha1').update(link).digest('hex').slice(0, 16),
      title,
      link,
      source: feed.name,
      feedId: feed.id,
      t: Number.isFinite(t) ? t : 0,
      summary,
      coins: coinsOf(`${title} ${summary}`),
    });
  }
  return items;
}

export class NewsService {
  private file: string;
  private cacheFile: string;
  feeds: NewsFeed[];
  items: NewsItem[];
  status: Record<string, { ok: boolean; at: number; error?: string; count: number }> = {};
  private timer: NodeJS.Timeout | null = null;
  private subs = 0;
  private listeners = new Set<() => void>();
  private fetching: Promise<void> | null = null;
  lastFetch = 0;

  constructor(private core: AppCore) {
    this.file = path.join(core.paths.userData, 'news-feeds.json');
    this.cacheFile = path.join(core.paths.userData, 'news-cache.json');
    const saved = readJson<NewsFeed[] | null>(this.file, null);
    // keep user choices for built-in feeds, add new built-ins, keep custom feeds
    this.feeds = DEFAULT_FEEDS.map((d) => ({ ...d, enabled: saved?.find((f) => f.id === d.id)?.enabled ?? d.enabled })).concat((saved || []).filter((f) => !f.builtin));
    this.items = readJson<NewsItem[]>(this.cacheFile, []);
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** Called when a news window subscribes / unsubscribes: refresh only while someone looks. */
  retain(): () => void {
    this.subs++;
    if (Date.now() - this.lastFetch > 120000) void this.refresh();
    if (!this.timer) this.timer = setInterval(() => void this.refresh(), 5 * 60000);
    return () => {
      this.subs--;
      if (this.subs <= 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  refresh(): Promise<void> {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const results = await Promise.all(
        this.feeds
          .filter((f) => f.enabled)
          .map(async (f) => {
            try {
              const res = await fetch(f.url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'FuFuTrading/1.0 (+news reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const xml = await res.text();
              const items = parseFeed(xml, f);
              if (!items.length) throw new Error('no items (not an RSS/Atom feed?)');
              this.status[f.id] = { ok: true, at: Date.now(), count: items.length };
              return items;
            } catch (e) {
              this.status[f.id] = { ok: false, at: Date.now(), error: (e as Error).message, count: 0 };
              return [] as NewsItem[];
            }
          }),
      );
      const byId = new Map<string, NewsItem>();
      for (const it of this.items) byId.set(it.id, it);
      for (const list of results) for (const it of list) byId.set(it.id, it);
      const enabled = new Set(this.feeds.filter((f) => f.enabled).map((f) => f.id));
      const cutoff = Date.now() - 14 * 86400000;
      this.items = [...byId.values()]
        .filter((x) => enabled.has(x.feedId) && (x.t === 0 || x.t > cutoff))
        .sort((a, b) => b.t - a.t)
        .slice(0, 600);
      this.lastFetch = Date.now();
      writeJsonAtomic(this.cacheFile, this.items);
      this.changed();
    })().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  setFeeds(feeds: NewsFeed[]): NewsFeed[] {
    const clean = feeds
      .filter((f) => f && /^https?:\/\//.test(String(f.url)))
      .map((f) => ({ id: String(f.id || crypto.createHash('sha1').update(String(f.url)).digest('hex').slice(0, 10)), name: String(f.name || new URL(String(f.url)).hostname).slice(0, 60), url: String(f.url), enabled: f.enabled !== false, builtin: DEFAULT_FEEDS.some((d) => d.id === f.id) }));
    this.feeds = clean;
    writeJsonAtomic(this.file, this.feeds);
    void this.refresh();
    this.changed();
    return this.feeds;
  }
}

export function registerNews(core: AppCore): NewsService {
  const svc = new NewsService(core);
  const r = core.router;
  r.topic('news', (_p, push) => {
    const send = () => push({ items: svc.items, feeds: svc.feeds, status: svc.status, updated: svc.lastFetch });
    send();
    const off = svc.onChange(send);
    const rel = svc.retain();
    return () => {
      off();
      rel();
    };
  });
  r.handle('news:refresh', () => svc.refresh().then(() => true));
  r.handle('news:feeds', ([feeds]) => (Array.isArray(feeds) ? svc.setFeeds(feeds) : svc.feeds));
  r.handle('news:open', ([url]) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Validation: invalid link');
    return shell.openExternal(url);
  });
  return svc;
}
