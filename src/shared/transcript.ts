/** Transcript text for "Strategy from a transcript" (AI Studio): captions to plain text, and the build request. */

const TIMESTAMP = /^\(?\[?\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?\]?\)?$/;

/** Does the text look like captions (subtitle cues, or a timestamp on every few lines)? */
export function looksLikeCaptions(raw: string): boolean {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const marks = lines.filter((l) => l.includes('-->') || TIMESTAMP.test(l) || /^WEBVTT/.test(l)).length;
  return marks / lines.length > 0.2;
}

/** Plain text from captions (SRT, VTT, a copied YouTube transcript): no cue numbers, timestamps, tags or repeated lines. */
export function captionText(raw: string): string {
  const out: string[] = [];
  for (const l0 of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const l = l0.replace(/<[^>]+>/g, '').trim();
    if (!l || /^WEBVTT/.test(l) || /^\d+$/.test(l) || l.includes('-->') || TIMESTAMP.test(l) || /^(NOTE|STYLE|Kind:|Language:)/.test(l)) continue;
    // auto-generated captions repeat the previous line as the next cue starts
    if (out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function buildPrompt(summary: string, o: { source: string | null; words: number; notes: string }): string {
  return [
    `Build this trading strategy as a script, backtest it on real data and compare it with buy & hold. Sonnet 5.5 summarized it from a transcript${o.source ? ` (${o.source})` : ''} of ${o.words.toLocaleString('en-US')} words. Where it lists open points, choose sensible defaults and say which you chose; check any claimed results against the backtest.`,
    '',
    summary,
    o.notes.trim() ? `\nMy notes: ${o.notes.trim()}` : '',
  ].join('\n');
}
