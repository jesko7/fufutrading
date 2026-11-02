import { describe, it, expect } from 'vitest';
import { buildPrompt, captionText, looksLikeCaptions, wordCount } from '../../src/shared/transcript';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Today I show you my <i>EMA</i> strategy

2
00:00:03,500 --> 00:00:06,000
Today I show you my EMA strategy
we buy when the 9 EMA crosses the 21

3
00:00:06,000 --> 00:00:09,000
and the stop goes below the last swing low`;

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
<c>RSI below 30</c> means oversold

00:00:02.000 --> 00:00:04.000
take profit at two R`;

const YT = `0:00
so this setup works on the four hour chart
0:05
wait for a break of the range high
1:02:10
then enter on the retest`;

describe('strategy from a transcript', () => {
  it('turns captions into plain text without numbers, timestamps, tags or repeats', () => {
    expect(looksLikeCaptions(SRT)).toBe(true);
    expect(captionText(SRT)).toBe('Today I show you my EMA strategy we buy when the 9 EMA crosses the 21 and the stop goes below the last swing low');
    expect(captionText(VTT)).toBe('RSI below 30 means oversold take profit at two R');
    expect(looksLikeCaptions(YT)).toBe(true);
    expect(captionText(YT)).toBe('so this setup works on the four hour chart wait for a break of the range high then enter on the retest');
  });

  it('leaves ordinary text alone', () => {
    const t = 'The strategy buys breakouts.\nIt sells at 12:30 every day — no, that is a joke.\nStops are 2 ATR.';
    expect(looksLikeCaptions(t)).toBe(false);
    expect(wordCount(t)).toBe(20);
  });

  it('asks the chat model to build what Sonnet summarized', () => {
    const p = buildPrompt('**Long entry**: 9 EMA crosses above 21 EMA', { source: 'ema.srt', words: 12345, notes: 'BTC 4h' });
    expect(p).toContain('Sonnet 5.5 summarized it from a transcript (ema.srt) of 12,345 words');
    expect(p).toContain('**Long entry**: 9 EMA crosses above 21 EMA');
    expect(p.trim().endsWith('My notes: BTC 4h')).toBe(true);
  });
});
