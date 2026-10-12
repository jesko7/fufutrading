import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptHost, keyParts } from '../../src/engine/host';
import { initPython, type PyInitOptions } from '../../src/engine/python/host';
import { parseTimeframe, tfDurationMs } from '../../src/shared/timeframes';
import { bars, aggregateBars, ctx, MIN } from '../helpers/bars';
import type { BarSeries } from '../../src/engine/types';

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
        for (const k of r.need) {
          const tf = parseTimeframe(keyParts(k).tf)!;
          security[k] = aggregateBars(data, Math.round(tfDurationMs(tf) / MIN));
        }
        r = await host.run({ lang, code, ctx, inputs: {}, data, security });
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
      const lookahead = res.warnings.filter((w) => w.kind === 'lookahead');
      expect(lookahead, `${f} has lookahead warnings: ${JSON.stringify(lookahead)}`).toEqual([]);
    });
  }
});
