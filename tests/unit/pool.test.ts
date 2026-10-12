import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import { ScriptPool } from '../../src/main/scripts/pool';
import type { PyInitOptions } from '../../src/engine/python/host';
import { STRIDE } from '../../src/shared/candles';
import { bars, ctx } from '../helpers/bars';
import type { BarSeries } from '../../src/engine/types';

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-pool-'));
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};
let pool: ScriptPool;
const logs: string[] = [];

function pack(b: BarSeries, from = 0, to = b.length): Float64Array {
  const out = new Float64Array((to - from) * STRIDE);
  for (let i = from, p = 0; i < to; i++, p += STRIDE) {
    out[p] = b.t[i];
    out[p + 1] = b.o[i];
    out[p + 2] = b.h[i];
    out[p + 3] = b.l[i];
    out[p + 4] = b.c[i];
    out[p + 5] = b.v[i];
  }
  return out;
}

beforeAll(async () => {
  await esbuild.build({ entryPoints: [path.join(root, 'src/workers/scriptWorker.ts')], outfile: path.join(tmp, 'scriptWorker.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['pyodide'], logLevel: 'error' });
  pool = new ScriptPool(path.join(tmp, 'scriptWorker.js'), PY, (l, m) => logs.push(`${l}: ${m}`));
}, 60000);

afterAll(async () => {
  await pool?.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ScriptPool (real worker threads)', () => {
  it('analyzes Pine on a live worker', async () => {
    const a = await pool.analyze('pine', '//@version=6\nindicator("A", overlay=true)\nlen = input.int(5)\nplot(ta.sma(close, len))', ctx);
    expect(a.ok).toBe(true);
    expect(a.meta!.title).toBe('A');
    expect(a.inputs[0].defval).toBe(5);
  });

  it('opens live instances and ships patches', async () => {
    const all = bars(120);
    const r0 = await pool.open('i1', { lang: 'pine', code: '//@version=6\nindicator("x")\nplot(ta.ema(close, 10))', ctx, inputs: {}, bars: pack(all, 0, 100), realtime: true });
    expect(r0.kind).toBe('full');
    const r1 = await pool.update('i1', { bars: { index: 99, packed: pack(all, 99, 101), length: 101 } });
    expect(r1.kind).toBe('patch');
    if (r1.kind === 'patch') {
      expect(r1.patch.from).toBe(99);
      expect(r1.patch.plots[0].values.length).toBe(2);
    }
    pool.close('i1');
    await expect(pool.update('i1', {})).rejects.toThrow(/lost/);
  });

  it('interrupts a Python script stuck in an infinite loop and keeps the worker usable', async () => {
    const h = pool.run({ lang: 'python', code: '@indicator("loop")\ndef main(data):\n    while True:\n        pass\n', ctx, inputs: {}, data: pack(bars(50)) }, { timeoutMs: 2500 });
    const { result } = await h.promise;
    expect(result.ok).toBe(false);
    expect(result.error!.message).toMatch(/KeyboardInterrupt/);
    const again = pool.run({ lang: 'python', code: '@indicator("ok")\ndef main(data):\n    plot(data.close)\n', ctx, inputs: {}, data: pack(bars(50)) });
    const r2 = await again.promise;
    expect(r2.result.ok).toBe(true);
    expect(r2.result.plots[0].values.length).toBe(50);
  }, 240000);

  it('cancels a long Pine run', async () => {
    const code = '//@version=6\nindicator("slow")\nx = 0.0\nfor k = 0 to 2000\n    x += math.sin(k + bar_index)\nplot(x)';
    const h = pool.run({ lang: 'pine', code, ctx, inputs: {}, data: pack(bars(60000)) });
    setTimeout(() => h.cancel(), 200);
    const { result } = await h.promise;
    expect(result.ok).toBe(false);
    expect(result.error!.message).toMatch(/Cancelled/);
  }, 60000);
});
