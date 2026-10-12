import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { ScriptHost, applyPatch, type InstanceReply } from '../../src/engine/host';
import { runPine } from '../../src/engine/pine';
import { initPython, type PyInitOptions } from '../../src/engine/python/host';
import type { BarSeries, ScriptResult } from '../../src/engine/types';
import { STRIDE } from '../../src/shared/candles';
import { bars, aggregateBars, ctx } from '../helpers/bars';

const root = path.resolve(__dirname, '../..');
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};

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

function sub(b: BarSeries, n: number): BarSeries {
  return { t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n), tc: b.tc.slice(0, n), length: n };
}

function expectSame(a: Float64Array, b: Float64Array, label: string) {
  expect(a.length, `${label} length`).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) throw new Error(`${label}[${i}]: ${x} vs ${y}`);
  }
}

class Client {
  result: ScriptResult | null = null;
  apply(r: InstanceReply): InstanceReply {
    if (r.kind === 'full') this.result = r.result;
    else if (r.kind === 'patch') this.result = applyPatch(this.result!, r.patch);
    return r;
  }
}

const IND = `//@version=6
indicator("x")
plot(ta.sma(close, 5), "sma")
plot(ta.rsi(close, 14), "rsi", color = close > open ? color.green : color.red)
bgcolor(close > ta.sma(close, 20) ? color.new(color.green, 90) : na)`;

beforeAll(async () => {
  await initPython(PY);
}, 120000);

describe('ScriptHost live instances (Pine)', () => {
  it('patches the forming bar and new bars incrementally, matching a fresh run', async () => {
    const all = bars(260);
    const host = new ScriptHost(PY);
    const cl = new Client();
    const r0 = cl.apply(await host.open('a', { lang: 'pine', code: IND, ctx, inputs: {}, bars: pack(all, 0, 200), realtime: true }));
    expect(r0.kind).toBe('full');
    // the forming bar changes
    const live = sub(all, 200);
    live.c[199] += 0.7;
    live.h[199] = Math.max(live.h[199], live.c[199]);
    const r1 = cl.apply(await host.update('a', { bars: { index: 199, packed: pack(live, 199, 200), length: 200 } }));
    expect(r1.kind).toBe('patch');
    if (r1.kind === 'patch') expect(r1.patch.from).toBe(199);
    let fresh = runPine(IND, { data: live, ctx, inputs: {}, realtime: true });
    expectSame(cl.result!.plots[0].values, fresh.plots[0].values, 'sma');
    expectSame(cl.result!.plots[1].values, fresh.plots[1].values, 'rsi');
    expect(cl.result!.plots[1].colors).toEqual(fresh.plots[1].colors);
    expect(cl.result!.bgcolors).toEqual(fresh.bgcolors);
    // bar 199 closes with its final values and bar 200 opens
    const next = sub(all, 201);
    const r2 = cl.apply(await host.update('a', { bars: { index: 199, packed: pack(next, 199, 201), length: 201 } }));
    expect(r2.kind).toBe('patch');
    fresh = runPine(IND, { data: next, ctx, inputs: {}, realtime: true });
    expectSame(cl.result!.plots[0].values, fresh.plots[0].values, 'sma');
    expectSame(cl.result!.plots[1].values, fresh.plots[1].values, 'rsi');
    // a correction of an older bar forces a rebuild but still yields a minimal patch
    next.c[190] += 1;
    const r3 = cl.apply(await host.update('a', { bars: { index: 190, packed: pack(next, 190, 201), length: 201 } }));
    expect(r3.kind).toBe('patch');
    if (r3.kind === 'patch') expect(r3.patch.from).toBeLessThanOrEqual(190);
    fresh = runPine(IND, { data: next, ctx, inputs: {}, realtime: true });
    expectSame(cl.result!.plots[1].values, fresh.plots[1].values, 'rsi');
  });

  it('runs strategies on closed bars only and re-runs when a bar closes', async () => {
    const all = bars(320);
    const code = `//@version=6
strategy("s", initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
if ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))
    strategy.close("L")`;
    const host = new ScriptHost(PY);
    const cl = new Client();
    cl.apply(await host.open('s', { lang: 'pine', code, ctx, inputs: {}, bars: pack(all, 0, 300), realtime: true }));
    expect(cl.result!.stats.bars).toBe(299);
    const live = sub(all, 300);
    live.c[299] += 0.3;
    const r1 = await host.update('s', { bars: { index: 299, packed: pack(live, 299, 300), length: 300 } });
    expect(r1.kind).toBe('none');
    const r2 = cl.apply(await host.update('s', { bars: { index: 299, packed: pack(all, 299, 301), length: 301 } }));
    expect(r2.kind === 'patch' || r2.kind === 'full').toBe(true);
    const fresh = runPine(code, { data: sub(all, 300), ctx, inputs: {} });
    expect(cl.result!.strategy!.trades.map((t) => [t.entryBar, t.exitBar, t.profit])).toEqual(fresh.strategy!.trades.map((t) => [t.entryBar, t.exitBar, t.profit]));
  });

  it('asks for request.security data, then maps it', async () => {
    const all = bars(200);
    const code = `//@version=6
indicator("h")
plot(request.security(syminfo.tickerid, "5", close), "h5")`;
    const host = new ScriptHost(PY);
    const cl = new Client();
    const r0 = cl.apply(await host.open('h', { lang: 'pine', code, ctx, inputs: {}, bars: pack(all), realtime: false }));
    expect(r0.need).toEqual(['spot:BTCUSDT:5m:candles']);
    const h5 = aggregateBars(all, 5);
    const r1 = cl.apply(await host.update('h', { securityFull: { 'spot:BTCUSDT:5m:candles': pack(h5) } }));
    expect(r1.need).toEqual([]);
    const v = cl.result!.plots[0].values;
    expect(Number.isNaN(v[3])).toBe(true);
    expect(v[4]).toBe(h5.c[0]);
    expect(v[9]).toBe(h5.c[1]);
  });

  it('reports compile errors as a full result', async () => {
    const host = new ScriptHost(PY);
    const r = await host.open('e', { lang: 'pine', code: '//@version=6\nindicator("x")\nplot(foo)', ctx, inputs: {}, bars: pack(bars(20)), realtime: true });
    expect(r.kind).toBe('full');
    if (r.kind === 'full') {
      expect(r.result.ok).toBe(false);
      expect(r.result.error!.line).toBe(3);
    }
  });
});

describe('ScriptHost live instances (Python)', () => {
  it('re-runs vectorised indicators and ships only changed tails', async () => {
    const code = `
@indicator("p")
def main(data, n=input.int(10)):
    plot(ta.ema(data.close, n), "ema")
`;
    const all = bars(150);
    const host = new ScriptHost(PY);
    const cl = new Client();
    const r0 = cl.apply(await host.open('p', { lang: 'python', code, ctx, inputs: {}, bars: pack(all, 0, 120), realtime: true }));
    expect(r0.kind).toBe('full');
    const live = sub(all, 120);
    live.c[119] += 2;
    const r1 = cl.apply(await host.update('p', { bars: { index: 119, packed: pack(live, 119, 120), length: 120 } }));
    expect(r1.kind).toBe('patch');
    if (r1.kind === 'patch') expect(r1.patch.from).toBe(119);
    const fresh = runPine('//@version=6\nindicator("x")\nplot(ta.ema(close, 10))', { data: live, ctx, inputs: {} });
    expectSame(cl.result!.plots[0].values, fresh.plots[0].values, 'ema');
    const r2 = cl.apply(await host.update('p', { inputs: { n: 20 } }));
    expect(r2.kind === 'patch' || r2.kind === 'full').toBe(true);
    const fresh20 = runPine('//@version=6\nindicator("x")\nplot(ta.ema(close, 20))', { data: live, ctx, inputs: {} });
    expectSame(cl.result!.plots[0].values, fresh20.plots[0].values, 'ema20');
  });
});
