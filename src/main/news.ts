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
import type { AIService, AiEffort } from './ai/service';

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

/** Claude's read of a headline: its likely short-term effect on the coins it is about. */
export type Sentiment = 'bullish' | 'bearish' | 'neutral';
export interface NewsSentiment {
  s: Sentiment;
  why: string;
  model: string;
  t: number;
}
/** Headline rating by Claude (Claude Code, the user's plan). */
export interface NewsAiSettings {
  enabled: boolean;
  model: string;
  effort: AiEffort;
  thinking: boolean;
}
export const DEFAULT_NEWS_AI: NewsAiSettings = { enabled: true, model: 'haiku', effort: 'low', thinking: false };
/** Headlines per Claude call, and calls per round (the rest waits for the next refresh). */
const RATE_BATCH = 25;
const RATE_ROUNDS = 4;

/** The prompt that rates a batch of headlines (JSON answer, in order). */
export function sentimentPrompt(items: Pick<NewsItem, 'id' | 'title' | 'summary'>[]): string {
  const lines = items.map((it) => `[${it.id}] ${it.title.replace(/\s+/g, ' ')}${it.summary ? ` — ${it.summary.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`);
  return [
    'You rate crypto news headlines for traders. For each headline decide the likely short-term effect on the price of the coins it is about (BTC, ETH, SOL, or crypto in general):',
    '"bullish" (likely up), "bearish" (likely down) or "neutral" (no clear effect, mixed, or not market news).',
    'Judge what happened, not the tone of the words. Reply with a JSON array only, one object per headline:',
    '[{"id":"<the id in brackets>","s":"bullish|bearish|neutral","why":"at most 12 words"}]',
    '',
    'Headlines:',
    ...lines,
  ].join('\n');
}

/** The ratings in Claude's answer (tolerates code fences and text around the array). */
export function parseSentiment(text: string, ids: Set<string>): Record<string, { s: Sentiment; why: string }> {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return {};
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(a, b + 1));
  } catch {
    return {};
  }
  const out: Record<string, { s: Sentiment; why: string }> = {};
  if (!Array.isArray(arr)) return out;
  for (const x of arr as { id?: unknown; s?: unknown; why?: unknown }[]) {
    const id = String(x?.id ?? '');
    const s = String(x?.s ?? '').toLowerCase();
    if (!ids.has(id) || !['bullish', 'bearish', 'neutral'].includes(s)) continue;
    out[id] = { s: s as Sentiment, why: String(x?.why ?? '').slice(0, 140) };
  }
  return out;
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
  /** Claude's ratings by headline id, its settings, and how the rating goes. */
  sentiment: Record<string, NewsSentiment>;
  ai: NewsAiSettings;
  aiStatus: { running: boolean; error?: string; rated: number; cost: number } = { running: false, rated: 0, cost: 0 };
  private claude: AIService | null = null;
  private sentFile: string;
  private aiFile: string;

  constructor(core: AppCore) {
    this.file = path.join(core.paths.userData, 'news-feeds.json');
    this.cacheFile = path.join(core.paths.userData, 'news-cache.json');
    this.sentFile = path.join(core.paths.userData, 'news-sentiment.json');
    this.aiFile = path.join(core.paths.userData, 'news-ai.json');
    this.sentiment = readJson<Record<string, NewsSentiment>>(this.sentFile, {});
    this.ai = { ...DEFAULT_NEWS_AI, ...readJson<Partial<NewsAiSettings>>(this.aiFile, {}) };
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

  setClaude(ai: AIService): void {
    this.claude = ai;
  }

  setAiSettings(p: Partial<NewsAiSettings>): NewsAiSettings {
    const next = { ...this.ai };
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    if (typeof p.model === 'string' && /^[\w.\-[\]]{2,60}$/.test(p.model)) next.model = p.model;
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(String(p.effort))) next.effort = p.effort as AiEffort;
    if (typeof p.thinking === 'boolean') next.thinking = p.thinking;
    this.ai = next;
    writeJsonAtomic(this.aiFile, next);
    this.aiStatus.error = undefined;
    this.changed();
    if (next.enabled) void this.rate();
    return next;
  }

  /** Forget the ratings (to rate again with other settings). */
  clearSentiment(): void {
    this.sentiment = {};
    writeJsonAtomic(this.sentFile, this.sentiment);
    this.changed();
    void this.rate();
  }

  /** Let Claude rate the headlines that have no rating yet, newest first. */
  async rate(): Promise<void> {
    if (!this.ai.enabled || !this.claude || this.aiStatus.running) return;
    this.aiStatus = { ...this.aiStatus, running: true, error: undefined };
    this.changed();
    try {
      for (let round = 0; round < RATE_ROUNDS; round++) {
        const todo = this.items.filter((it) => !this.sentiment[it.id]).slice(0, RATE_BATCH);
        if (!todo.length || !this.ai.enabled) break;
        const s = this.ai;
        const res = await this.claude.complete(sentimentPrompt(todo), s);
        const got = parseSentiment(res.text, new Set(todo.map((x) => x.id)));
        const now = Date.now();
        for (const [id, r] of Object.entries(got)) this.sentiment[id] = { ...r, model: s.model, t: now };
        this.aiStatus.rated += Object.keys(got).length;
        this.aiStatus.cost = +(this.aiStatus.cost + res.cost).toFixed(4);
        // keep only the ratings of headlines still listed
        const listed = new Set(this.items.map((x) => x.id));
        for (const id of Object.keys(this.sentiment)) if (!listed.has(id)) delete this.sentiment[id];
        writeJsonAtomic(this.sentFile, this.sentiment);
        this.changed();
        if (!Object.keys(got).length) throw new Error('Claude did not return ratings');
      }
    } catch (e) {
      this.aiStatus.error = (e as Error).message;
    } finally {
      this.aiStatus.running = false;
      this.changed();
    }
  }

  /** Called when a news window subscribes / unsubscribes: refresh only while someone looks. */
  retain(): () => void {
    this.subs++;
    if (Date.now() - this.lastFetch > 120000) void this.refresh();
    else void this.rate();
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
      if (this.subs > 0) void this.rate();
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

export function registerNews(core: AppCore, claude?: AIService): NewsService {
  const svc = new NewsService(core);
  if (claude) svc.setClaude(claude);
  const r = core.router;
  r.topic('news', (_p, push) => {
    const send = () => push({ items: svc.items, feeds: svc.feeds, status: svc.status, updated: svc.lastFetch, sentiment: svc.sentiment, ai: svc.ai, aiStatus: svc.aiStatus });
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
  r.handle('news:ai', ([p]) => (p && typeof p === 'object' ? svc.setAiSettings(p) : svc.ai));
  r.handle('news:rerate', () => {
    svc.clearSentiment();
    return true;
  });
  r.handle('news:open', ([url]) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Validation: invalid link');
    return shell.openExternal(url);
  });
  return svc;
}
