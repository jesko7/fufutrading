import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptHost, keyParts } from '../../src/engine/host';
import { repaintCheck } from '../../src/engine/repaint';
import { initPython, type PyInitOptions } from '../../src/engine/python/host';
import { parseTimeframe, tfDurationMs } from '../../src/shared/timeframes';
import { bars, aggregateBars, ctx, MIN } from '../helpers/bars';
import type { BarSeries } from '../../src/engine/types';
import { isBookKey } from '../../src/shared/bookFrame';
import type { BookWire } from '../../src/engine/book';
import { syntheticBook } from '../helpers/book';

const root = path.resolve(__dirname, '../..');
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};
const LIB = path.join(root, 'src/engine/library');
const files = fs.readdirSync(LIB).filter((f) => /\.(pine|py)$/.test(f));

beforeAll(async () => {
  await initPython(PY);
}, 120000);

// realistic random walk with trends so strategies actually trade
function walk(n: number): BarSeries {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const path: number[] = [];
  for (let i = 0; i <= n; i++) {
    p *= 1 + rnd() * 0.012 + Math.sin(i / 300) * 0.0008;
    path.push(p);
  }
  return bars(n, (i) => path[i]);
}

describe('built-in script library', () => {
  it('has metadata headers on every script', () => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(LIB, f), 'utf8');
      expect(code, f).toMatch(/@name .+/);
      expect(code, f).toMatch(/@category .+/);
      expect(code, f).toMatch(/@description .+/);
    }
    expect(files.length).toBeGreaterThan(30);
  });

  for (const f of files) {
    it(`runs ${f} without errors`, async () => {
      const code = fs.readFileSync(path.join(LIB, f), 'utf8');
      const lang = f.endsWith('.py') ? 'python' : 'pine';
      const data = walk(f.includes('mtf') ? 20000 : 3000);
      const host = new ScriptHost(PY);
      let r = await host.run({ lang, code, ctx, inputs: {}, data });
      if (r.need.length) {
        const security: Record<string, BarSeries> = {};
        let book: BookWire | undefined;
        for (const k of r.need) {
          if (isBookKey(k)) {
            book = syntheticBook(data, 3);
            continue;
          }
          const tf = parseTimeframe(keyParts(k).tf)!;
          security[k] = aggregateBars(data, Math.round(tfDurationMs(tf) / MIN));
        }
        r = await host.run({ lang, code, ctx, inputs: {}, data, security, book });
      }
      const res = r.result;
      if (!res.ok) throw new Error(`${f}: ${res.error?.kind} ${res.error?.message} (line ${res.error?.line})\n${res.error?.traceback || ''}`);
      expect(r.need).toEqual([]);
      const anyOutput = res.plots.some((p) => p.values.some((v) => Number.isFinite(v))) || res.labels.length > 0;
      expect(anyOutput, `${f} produced no output`).toBe(true);
      if (res.meta.type === 'strategy') {
        expect(res.strategy, f).toBeTruthy();
        expect(res.strategy!.trades.length + res.strategy!.openTrades.length, `${f} never traded`).toBeGreaterThan(0);
      }
      // Ichimoku's lagging span is drawn 25 bars back by definition (display only)
      const lookahead = res.warnings.filter((w) => w.kind === 'lookahead' && !(f === 'ichimoku.pine' && /offset -25/.test(w.message)));
      expect(lookahead, `${f} has lookahead warnings: ${JSON.stringify(lookahead)}`).toEqual([]);
    });
  }

  for (const f of files) {
    it(`${f} replays live exactly as its history shows`, async () => {
      const code = fs.readFileSync(path.join(LIB, f), 'utf8');
      const lang = f.endsWith('.py') ? 'python' : 'pine';
      const data = walk(f.includes('mtf') ? 6000 : 1500);
      const host = new ScriptHost(PY);
      let security: Record<string, BarSeries> = {};
      let book: BookWire | undefined;
      let r;
      for (let round = 0; round < 4; round++) {
        r = await repaintCheck(host, { lang, code, ctx, inputs: {}, data, security, book, window: 80, maxChecks: lang === 'python' ? 4 : 16, budgetMs: 60000 });
        if (!r.need.length) break;
        security = { ...security };
        for (const k of r.need) {
          if (isBookKey(k)) book = syntheticBook(data, 3);
          else security[k] = aggregateBars(data, Math.round(tfDurationMs(parseTimeframe(keyParts(k).tf)!) / MIN));
        }
      }
      expect(r!.ok, r!.error).toBe(true);
      const diffs = r!.diffs.map((d) => d.title);
      expect(diffs, `${f}: ${JSON.stringify(r!.diffs)}`).toEqual(f === 'ichimoku.pine' ? ['Lagging Span'] : []);
    });
  }
});
