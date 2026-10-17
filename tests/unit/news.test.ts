import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openExternal: () => {} } }));
import { parseFeed, coinsOf, decodeEntities, sentimentPrompt, parseSentiment } from '../../src/main/news';

const RSS = `<?xml version="1.0"?><rss><channel><title>X</title>
<item><title><![CDATA[Bitcoin tops $100K as ETF inflows surge]]></title><link>https://example.com/a</link>
<pubDate>Tue, 14 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;BTC rallied &amp;amp; ETH followed&lt;/p&gt;</description></item>
<item><title>Solana upgrade ships</title><link>https://example.com/b</link><pubDate>Tue, 14 Oct 2026 09:30:00 +0000</pubDate>
<content:encoded><![CDATA[<p>The <b>SOL</b> network …</p>]]></content:encoded></item>
<item><title>No link here</title></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Ether &amp; L2s</title>
<link rel="alternate" href="https://example.org/x"/><updated>2026-10-13T12:00:00Z</updated><summary>Rollups &#8211; fees fall</summary></entry></feed>`;

describe('news feed parsing', () => {
  it('parses RSS with CDATA, encoded HTML and dates; skips items without links', () => {
    const items = parseFeed(RSS, { id: 'f', name: 'Feed' });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'Bitcoin tops $100K as ETF inflows surge', link: 'https://example.com/a', source: 'Feed', t: Date.UTC(2026, 9, 14, 8), summary: 'BTC rallied & ETH followed', coins: ['BTC', 'ETH'] });
    expect(items[1].summary).toBe('The SOL network …');
    expect(items[1].coins).toEqual(['SOL']);
  });

  it('parses Atom entries with href links', () => {
    const [it0] = parseFeed(ATOM, { id: 'a', name: 'Atom' });
    expect(it0).toMatchObject({ title: 'Ether & L2s', link: 'https://example.org/x', summary: 'Rollups – fees fall', coins: ['ETH'] });
  });

  it('tags coins conservatively', () => {
    expect(coinsOf('sol-gel chemistry and solar power')).toEqual([]);
    expect(coinsOf('Ethereum and Bitcoin')).toEqual(['BTC', 'ETH']);
    expect(decodeEntities('&#x27;a&#39; &hellip;')).toBe("'a' …");
  });
});

describe('news sentiment (Claude)', () => {
  it('asks for one rating per headline by id', () => {
    const p = sentimentPrompt([
      { id: 'a1', title: 'Bitcoin ETF sees record inflows', summary: 'Funds bought  12,000 BTC.' },
      { id: 'b2', title: 'Exchange hacked', summary: '' },
    ]);
    expect(p).toContain('[a1] Bitcoin ETF sees record inflows — Funds bought 12,000 BTC.');
    expect(p).toContain('[b2] Exchange hacked');
    expect(p).toMatch(/JSON array only/);
  });

  it('reads the ratings from the answer, fenced or not, and drops anything else', () => {
    const ids = new Set(['a1', 'b2', 'c3']);
    const text = 'Here you go:\n```json\n[{"id":"a1","s":"Bullish","why":"record inflows"},{"id":"b2","s":"bearish","why":"funds stolen"},{"id":"zz","s":"bullish"},{"id":"c3","s":"maybe"}]\n```';
    expect(parseSentiment(text, ids)).toEqual({ a1: { s: 'bullish', why: 'record inflows' }, b2: { s: 'bearish', why: 'funds stolen' } });
    expect(parseSentiment('no idea', ids)).toEqual({});
    expect(parseSentiment('[not json]', ids)).toEqual({});
  });
});
