import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { ScriptHost } from '../../src/engine/host';
import { repaintCheck, cutSeries, withFormingBar, type RepaintSpec } from '../../src/engine/repaint';
import { initPython, type PyInitOptions } from '../../src/engine/python/host';
import type { BarSeries } from '../../src/engine/types';
import { bars, aggregateBars, ctx } from '../helpers/bars';

const root = path.resolve(__dirname, '../..');
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};

beforeAll(async () => {
  await initPython(PY);
}, 120000);

// a random walk with trends so strategies trade
function walk(n: number): BarSeries {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    p *= 1 + rnd() * 0.01 + Math.sin(i / 90) * 0.001;
    pts.push(p);
  }
  return bars(n, (i) => pts[i]);
}

const data = walk(1200);
const htf = aggregateBars(data, 5);
const host = new ScriptHost(PY);

async function check(code: string, extra: Partial<RepaintSpec> = {}) {
  const lang = extra.lang || 'pine';
  let security: Record<string, BarSeries> = {};
  for (let round = 0; round < 3; round++) {
    const r = await repaintCheck(host, { lang, code, ctx, inputs: {}, data, security, window: 120, maxChecks: 60, budgetMs: 60000, ...extra });
    if (!r.need.length) return r;
    security = { ...security };
    for (const k of r.need) security[k] = htf;
  }
  throw new Error('data keys not resolved');
}

describe('repaint check', () => {
  it('finds nothing in a plain indicator', async () => {
    const r = await check(`//@version=6
indicator("ema")
plot(ta.ema(close, 20), "EMA")
plotshape(ta.crossover(close, ta.ema(close, 20)), "Cross")
alertcondition(ta.crossover(close, ta.sma(close, 10)), "Up")`);
    expect(r.ok, r.error).toBe(true);
    expect(r.checked).toBe(60);
    expect(r.diffs).toEqual([]);
    expect(r.isStrategy).toBe(false);
  });

  it('catches request.security with lookahead_on (future higher-timeframe values)', async () => {
    const r = await check(`//@version=6
indicator("htf")
plot(request.security(syminfo.tickerid, "5", close, lookahead = barmerge.lookahead_on), "HTF close")`);
    expect(r.ok, r.error).toBe(true);
    const d = r.diffs.find((x) => x.title === 'HTF close');
    expect(d, JSON.stringify(r.diffs)).toBeTruthy();
    // four of every five 1-minute bars sit inside a 5-minute bar that had not closed yet
    expect(d!.count).toBeGreaterThan(r.checked * 0.6);
    expect(r.badTimes.length).toBe(d!.count);
  });

  it('accepts the non-repainting idioms', async () => {
    const r = await check(`//@version=6
indicator("htf ok")
plot(request.security(syminfo.tickerid, "5", close[1], lookahead = barmerge.lookahead_on), "a")
plot(request.security(syminfo.tickerid, "5", ta.sma(close, 3)), "b")`);
    expect(r.ok, r.error).toBe(true);
    expect(r.diffs).toEqual([]);
  });

  it('catches plots shifted into the past (negative offset)', async () => {
    const r = await check(`//@version=6
indicator("centered")
plot(ta.sma(close, 9), "Centered", offset = -4)`);
    expect(r.diffs.map((d) => d.title)).toEqual(['Centered']);
    expect(r.diffs[0].example.live).toBe('no value');
  });

  it('compares a strategy with what a bot had at each bar close', async () => {
    const clean = await check(`//@version=6
strategy("cross", default_qty_type = strategy.percent_of_equity, default_qty_value = 50)
f = ta.ema(close, 8)
s = ta.ema(close, 21)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")
    strategy.entry("S", strategy.short, stop = low - 0.5)
strategy.exit("XS", "S", profit = 150, loss = 100)`);
    expect(clean.ok, clean.error).toBe(true);
    expect(clean.isStrategy).toBe(true);
    expect(clean.diffs).toEqual([]);

    const leak = await check(`//@version=6
strategy("future")
h = request.security(syminfo.tickerid, "5", close, lookahead = barmerge.lookahead_on)
if close < h
    strategy.entry("L", strategy.long)
if close > h
    strategy.close("L")`);
    const d = leak.diffs.find((x) => x.kind === 'strategy');
    expect(d, JSON.stringify(leak.diffs)).toBeTruthy();
    expect(d!.title).toBe('Position and orders');
    expect(d!.example.live).not.toBe(d!.example.history);
  });

  it('catches strategies that act on the newest bar only', async () => {
    const r = await check(`//@version=6
strategy("last")
if barstate.islast
    strategy.entry("L", strategy.long)`);
    const d = r.diffs.find((x) => x.kind === 'strategy');
    expect(d?.count).toBe(r.checked);
    expect(d?.example.live).toMatch(/buy at market "L"/);
    expect(d?.example.history).toBe('flat');
  });

  it('catches Python lookahead (negative shift)', async () => {
    const r = await check(
      `from fufu import *


@indicator("leak", overlay=True)
def main(data):
    c = np.asarray(data.close, dtype=float)
    plot(np.append(c[1:], np.nan), "Next close")
    plot(c * 2, "Double")
`,
      { lang: 'python', window: 40, maxChecks: 12 },
    );
    expect(r.ok, r.error).toBe(true);
    expect(r.diffs.map((d) => d.title)).toEqual(['Next close']);
    expect(r.diffs[0].count).toBe(12);
  }, 120000);
});

describe('repaint check data cuts', () => {
  it('rebuilds the forming higher-timeframe bar from chart bars', () => {
    // cut after the 3rd minute of the second 5-minute bar
    const cut = data.tc[7];
    const s = cutSeries(htf, cut, data);
    expect(s.length).toBe(2);
    expect(s.o[1]).toBe(data.o[5]);
    expect(s.c[1]).toBe(data.c[7]);
    expect(s.h[1]).toBe(Math.max(data.h[5], data.h[6], data.h[7]));
    expect(s.v[1]).toBe(data.v[5] + data.v[6] + data.v[7]);
    // without chart bars the forming bar is left out; on a boundary every bar is closed
    expect(cutSeries(htf, cut, null).length).toBe(1);
    expect(cutSeries(htf, data.tc[9], data).length).toBe(2);
    expect(cutSeries(htf, data.tc[9], data).c[1]).toBe(htf.c[1]);
  });

  it('adds the first tick of the next bar as the forming bar', () => {
    const f = withFormingBar(data, 10);
    expect(f.length).toBe(12);
    expect(f.c[10]).toBe(data.c[10]);
    expect([f.o[11], f.h[11], f.l[11], f.c[11]]).toEqual([data.o[11], data.o[11], data.o[11], data.o[11]]);
    expect(f.v[11]).toBe(0);
  });
});
