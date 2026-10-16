import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPine, analyzePine, securityRequests, compileCached } from '../../src/engine/pine';
import { runPython, initPython, type PyInitOptions } from '../../src/engine/python/host';
import { TEMPLATES, PATTERN_LABEL, condText, generate, validate, defaultInd, type BuilderModel, type IndKind, type PatternId } from '../../src/shared/builder';
import type { BarSeries } from '../../src/engine/types';
import { bars, aggregateBars, ctx } from '../helpers/bars';

const root = path.resolve(__dirname, '../..');
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};

// a noisy trending series so every template trades
const data: BarSeries = bars(3000, (i) => 100 + Math.sin(i / 23) * 9 + Math.sin(i / 7) * 3 + Math.sin(i / 131) * 15 + i * 0.004);
const htf = aggregateBars(data, 240);
// a random walk with real-looking candles (bodies and wicks of varying size) for the pattern conditions
const real: BarSeries = (() => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const b = bars(3000);
  let p = 100;
  for (let i = 0; i < b.length; i++) {
    const o = p;
    const c = o * (1 + rnd() * 0.02);
    b.o[i] = o;
    b.c[i] = c;
    b.h[i] = Math.max(o, c) * (1 + Math.abs(rnd()) * 0.01);
    b.l[i] = Math.min(o, c) * (1 - Math.abs(rnd()) * 0.01);
    p = c;
  }
  return b;
})();

/** Futures statistics keys get a chart-timeframe series that moves; higher timeframes the 4h bars. */
const isStat = (key: string) => /:(oi|oiusd|lsr|toplsr|toppos|funding)$/.test(key);

function securityFor(code: string): Record<string, BarSeries> {
  const out: Record<string, BarSeries> = {};
  for (const r of securityRequests(compileCached(code), {}, ctx)) out[r.key] = isStat(r.key) ? data : htf;
  return out;
}

/** What a generated Python strategy requests (its futures statistics on the chart timeframe). */
function pySecurity(code: string, filterTf?: string): Record<string, BarSeries> {
  const sec: Record<string, BarSeries> = filterTf ? { [`spot:BTCUSDT:${filterTf}:candles`]: htf } : {};
  for (const [suffix, kind] of [['.P_OI"', 'oi'], ['.P_LSR"', 'lsr'], ['.P_TOP_POS"', 'toppos'], ['.P_FUNDING"', 'funding']]) if (code.includes(suffix)) sec[`futures:BTCUSDT:${ctx.tf}:${kind}`] = data;
  return sec;
}

beforeAll(async () => {
  await initPython(PY);
}, 240000);

describe('strategy builder code generation', () => {
  for (const t of TEMPLATES) {
    it(`"${t.label}" compiles and trades in Pine`, () => {
      // the synthetic history holds only a few 4h bars: use a short trend-filter EMA here
      const m: BuilderModel = { ...t.model, filter: { ...t.model.filter, len: 3 }, short: { ...t.model.short, enabled: true, when: t.model.short.when.conds.length ? t.model.short.when : t.model.long.when } };
      expect(validate(m)).toEqual([]);
      const code = generate({ ...m, language: 'pine' });
      const a = analyzePine(code);
      expect(a.ok, a.error?.message).toBe(true);
      expect((a.warnings || []).filter((w) => w.kind === 'lookahead')).toEqual([]);
      const r = runPine(code, { data, ctx, inputs: {}, security: securityFor(code) });
      expect(r.ok, r.error?.message).toBe(true);
      expect(r.strategy!.trades.length).toBeGreaterThan(2);
    });

    it(`"${t.label}" runs and trades in Python`, async () => {
      const code = generate({ ...t.model, filter: { ...t.model.filter, len: 3 }, language: 'python' });
      const r = await runPython(PY, { code, data, ctx, inputs: {}, security: pySecurity(code, t.model.filter.enabled ? t.model.filter.tf : undefined) });
      expect(r.need).toEqual([]);
      expect(r.result.ok, r.result.error?.message).toBe(true);
      expect(r.result.strategy!.trades.length).toBeGreaterThan(2);
    }, 120000);
  }

  it('generates every indicator kind in both languages', async () => {
    const kinds: IndKind[] = ['sma', 'ema', 'rsi', 'macd', 'macdSignal', 'macdHist', 'bbUpper', 'bbBasis', 'bbLower', 'atr', 'stochK', 'stochD', 'highest', 'lowest', 'vwap', 'volume', 'volumeSma', 'supertrend', 'oi', 'oiSma', 'oiChange', 'lsr', 'topPos', 'funding'];
    const m: BuilderModel = {
      ...TEMPLATES[0].model,
      long: { enabled: true, when: { op: 'or', conds: kinds.map((k) => ({ left: defaultInd(k), cmp: 'above' as const, right: { kind: 'value' as const, v: 1e12 } })) } },
      risk: { stopPct: 2, takePct: 4, trailPct: 3, sizePct: 50 },
    };
    const pine = generate({ ...m, language: 'pine' });
    const a = analyzePine(pine);
    expect(a.ok, a.error?.message).toBe(true);
    // the futures statistics are declared once each, whatever uses them
    expect(pine.match(/_OI", timeframe\.period/g)?.length).toBe(1);
    expect(securityRequests(compileCached(pine), {}, ctx).map((r) => r.key).sort()).toEqual(['futures:BTCUSDT:1m:funding', 'futures:BTCUSDT:1m:lsr', 'futures:BTCUSDT:1m:oi', 'futures:BTCUSDT:1m:toppos']);
    const rp = runPine(pine, { data, ctx, inputs: {}, security: securityFor(pine) });
    expect(rp.ok, rp.error?.message).toBe(true);
    const pyCode = generate({ ...m, language: 'python' });
    const py = await runPython(PY, { code: pyCode, data, ctx, inputs: {}, security: pySecurity(pyCode) });
    expect(py.need).toEqual([]);
    expect(py.result.ok, py.result.error?.message).toBe(true);
  }, 120000);

  it('turns candlestick patterns into conditions in both languages, with the same trades', async () => {
    const patterns = Object.keys(PATTERN_LABEL) as PatternId[];
    const m: BuilderModel = {
      ...TEMPLATES[0].model,
      long: { enabled: true, when: { op: 'or', conds: patterns.map((p) => ({ left: { kind: 'pattern' as const, pattern: p }, cmp: 'occurs' as const, right: { kind: 'value' as const, v: 0 } })) } },
    };
    expect(validate(m)).toEqual([]);
    expect(condText(m.long.when.conds[0])).toBe('Bullish engulfing appears');
    const pine = generate({ ...m, language: 'pine' });
    // the candle anatomy is declared once for all patterns
    expect(pine.match(/c_body = /g)?.length).toBe(1);
    const rp = runPine(pine, { data: real, ctx, inputs: {} });
    expect(rp.ok, rp.error?.message).toBe(true);
    const py = await runPython(PY, { code: generate({ ...m, language: 'python' }), data: real, ctx, inputs: {} });
    expect(py.result.ok, py.result.error?.message).toBe(true);
    const entries = (r: typeof rp) => r.strategy!.trades.map((t) => t.entryBar);
    expect(entries(rp).length).toBeGreaterThan(2);
    expect(entries(py.result)).toEqual(entries(rp));
    // patterns belong on the left; "appears" needs one
    expect(validate({ ...m, long: { enabled: true, when: { op: 'and', conds: [{ left: { kind: 'price', field: 'close' }, cmp: 'above', right: { kind: 'pattern', pattern: 'doji' } }] } } })[0]).toMatch(/left side/);
  }, 120000);

  it('reports invalid models', () => {
    const m: BuilderModel = { ...TEMPLATES[0].model, long: { enabled: true, when: { op: 'and', conds: [] } } };
    expect(validate(m)[0]).toMatch(/long entry condition/);
  });
});
