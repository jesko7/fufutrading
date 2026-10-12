import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPython, analyzePython, initPython, type PyInitOptions } from '../../src/engine/python/host';
import { runPine } from '../../src/engine/pine';
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

function expectClose(a: Float64Array, b: Float64Array, label: string) {
  expect(a.length, label).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Number.isNaN(x) || Number.isNaN(y)) {
      expect(Number.isNaN(x) && Number.isNaN(y), `${label}[${i}] ${x} vs ${y}`).toBe(true);
    } else expect(Math.abs(x - y), `${label}[${i}] ${x} vs ${y}`).toBeLessThan(1e-9 * Math.max(1, Math.abs(y)));
  }
}

async function py(code: string, data = bars(400), extra: Record<string, unknown> = {}) {
  const r = await runPython(PY, { code, data, ctx, inputs: {}, ...extra });
  if (r.result.error) throw new Error(`${r.result.error.kind}: ${r.result.error.message} (line ${r.result.error.line})\n${r.result.error.traceback || ''}`);
  return r;
}

function pine(code: string, data = bars(400), extra: Record<string, unknown> = {}) {
  const r = runPine(code, { data, ctx, inputs: {}, ...extra });
  if (r.error) throw new Error(`${r.error.kind}: ${r.error.message} (line ${r.error.line})`);
  return r;
}

const plotOf = (r: { plots: { title: string; values: Float64Array }[] }, title: string) => {
  const p = r.plots.find((x) => x.title === title);
  if (!p) throw new Error(`no plot ${title}`);
  return p.values;
};

describe('Python scripting', () => {
  it('analyzes metadata and inputs (function defaults and input.*)', async () => {
    const a = await analyzePython(
      PY,
      `
@indicator("My RSI", short_title="RSI+", overlay=False, scale=(0, 100))
def main(data, length=input.int(14, "Length", min=1), src=input.source("close"), smooth=3, show=True):
    plot(ta.rsi(src, length), "RSI")
`,
    );
    expect(a.ok).toBe(true);
    expect(a.meta!.title).toBe('My RSI');
    expect(a.meta!.overlay).toBe(false);
    expect(a.inputs!.map((i) => [i.key, i.type, i.defval])).toEqual([
      ['length', 'int', 14],
      ['src', 'source', 'close'],
      ['smooth', 'int', 3],
      ['show', 'bool', true],
    ]);
    expect(a.inputs![0].title).toBe('Length');
    expect(a.inputs![0].min).toBe(1);
  });

  it('reports syntax errors with line numbers', async () => {
    const a = await analyzePython(PY, '@indicator("x")\ndef main(data):\n    plot(data.close\n');
    expect(a.ok).toBe(false);
    expect(a.error!.kind).toBe('syntax');
    expect(a.error!.line).toBeGreaterThanOrEqual(3);
  });

  it('reports runtime errors with the script line and a readable traceback', async () => {
    const r = await runPython(PY, { code: '@indicator("x")\ndef main(data):\n    x = 1\n    y = x / 0\n    plot(data.close)\n', data: bars(50), ctx, inputs: {} });
    expect(r.result.ok).toBe(false);
    expect(r.result.error!.line).toBe(4);
    expect(r.result.error!.message).toContain('ZeroDivisionError');
    expect(r.result.error!.traceback).toContain('<script>');
  });

  it('computes ta.* exactly like Pine (shared implementation)', async () => {
    const data = bars(500);
    const p = pine(
      `//@version=6
indicator("x")
plot(ta.sma(close, 14), "sma")
plot(ta.ema(close, 20), "ema")
plot(ta.rsi(close, 14), "rsi")
plot(ta.atr(14), "atr")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(m, "macd")
plot(h, "hist")
[mid, up, lo] = ta.bb(close, 20, 2)
plot(up, "bbu")
plot(ta.stdev(close, 10), "sd")
plot(ta.highest(high, 10), "hh")
plot(ta.vwma(close, 10), "vwma")
plot(ta.cci(hlc3, 20), "cci")
[st, dir] = ta.supertrend(3, 10)
plot(st, "st")
plot(ta.change(close, 3), "chg")
plot(ta.stoch(close, high, low, 14), "stoch")
plot(ta.obv, "obv")`,
      data,
    );
    const r = await py(
      `
@indicator("x")
def main(data):
    c = data.close
    plot(ta.sma(c, 14), "sma")
    plot(ta.ema(c, 20), "ema")
    plot(ta.rsi(c, 14), "rsi")
    plot(ta.atr(14), "atr")
    m, s, h = ta.macd(c, 12, 26, 9)
    plot(m, "macd")
    plot(h, "hist")
    mid, up, lo = ta.bb(c, 20, 2)
    plot(up, "bbu")
    plot(ta.stdev(c, 10), "sd")
    plot(ta.highest(data.high, 10), "hh")
    plot(ta.vwma(c, 10), "vwma")
    plot(ta.cci(data.hlc3, 20), "cci")
    st, d = ta.supertrend(3, 10)
    plot(st, "st")
    plot(ta.change(c, 3), "chg")
    plot(ta.stoch(c, data.high, data.low, 14), "stoch")
    plot(ta.obv(), "obv")
`,
      data,
    );
    for (const k of ['sma', 'ema', 'rsi', 'atr', 'macd', 'hist', 'bbu', 'sd', 'hh', 'vwma', 'cci', 'st', 'chg', 'stoch', 'obv']) expectClose(plotOf(r.result, k), plotOf(p, k), k);
  });

  it('supports numpy math, per-bar colors, shapes, hlines and alerts', async () => {
    const r = await py(`
@indicator("z", overlay=False)
def main(data, n=input.int(20)):
    c = data.close
    mean = ta.sma(c, n)
    sd = ta.stdev(c, n)
    z = (c - mean) / sd
    cols = [color.green if v > 0 else color.red for v in np.nan_to_num(z)]
    plot(z, "z", color=cols, style="histogram")
    hline(2, "upper")
    plotshape(z > 2, "hi", location="top")
    alertcondition(ta.crossover(z, 2), "z>2", "z crossed above 2")
`);
    const z = plotOf(r.result, 'z');
    expect(Number.isNaN(z[0])).toBe(true);
    expect(Number.isFinite(z[399])).toBe(true);
    const zp = r.result.plots[0];
    expect(zp.colors!.length).toBe(400);
    expect(zp.colors![399]).toMatch(/^rgb/);
    expect(r.result.hlines[0].price).toBe(2);
    expect(r.result.plots[1].kind).toBe('shape');
    expect(r.result.alerts[0].values.length).toBe(400);
  });

  it('runs strategies with the same broker semantics as Pine (identical trades)', async () => {
    const data = bars(600);
    const p = pine(
      `//@version=6
strategy("x", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
f = ta.sma(close, 10)
s = ta.sma(close, 30)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")`,
      data,
    );
    const r = await py(
      `
@strategy("x", initial_capital=10000, default_qty_type="fixed", default_qty_value=1)
class Cross(Strategy):
    fast = input.int(10)
    slow = input.int(30)

    def init(self):
        self.f = self.I(ta.sma(self.data.close, self.fast), "fast")
        self.s = self.I(ta.sma(self.data.close, self.slow), "slow")

    def next(self):
        if crossover(self.f, self.s):
            self.entry("L", long)
        if crossunder(self.f, self.s):
            self.close("L")
`,
      data,
    );
    const a = p.strategy!.trades;
    const b = r.result.strategy!.trades;
    expect(a.length).toBeGreaterThan(3);
    expect(b.map((t) => [t.entryBar, t.exitBar, t.entryPrice, t.exitPrice, +t.profit.toFixed(8)])).toEqual(a.map((t) => [t.entryBar, t.exitBar, t.entryPrice, t.exitPrice, +t.profit.toFixed(8)]));
    expect(r.result.plots.map((x) => x.title)).toEqual(['fast', 'slow']);
  });

  it('never exposes future bars inside next()', async () => {
    const r = await py(`
@strategy("x")
class Peek(Strategy):
    def init(self):
        self.seen = []
    def next(self):
        assert len(self.data.close) == self.bar + 1, (len(self.data.close), self.bar)
        assert self.data.close[-1] == self.data._cols['close'][self.bar]
        assert len(self.data.time) == self.bar + 1
`, bars(120));
    expect(r.result.ok).toBe(true);
  });

  it('reports positions, equity and supports brackets (sl/tp)', async () => {
    const r = await py(`
@strategy("x", initial_capital=100000, default_qty_type="fixed", default_qty_value=2, commission=0)
class B(Strategy):
    def next(self):
        if self.bar % 50 == 0 and not self.position:
            c = self.data.close[-1]
            self.buy(sl=c - 1.5, tp=c + 2.0)
`, bars(400));
    const st = r.result.strategy!;
    expect(st.trades.length).toBeGreaterThan(3);
    for (const t of st.trades) {
      const d = t.exitPrice - t.entryPrice;
      // bracket prices relative to the signal bar close; fills at next open, exits at tick levels
      expect(Math.abs(t.profit - d * 2)).toBeLessThan(1e-9);
    }
  });

  it('requests other timeframes on demand and maps them without lookahead', async () => {
    const data = bars(240);
    const code = `
@indicator("htf")
def main(data):
    plot(data.htf("5m", "close"), "h")
`;
    const first = await runPython(PY, { code, data, ctx, inputs: {} });
    expect(first.need).toEqual(['spot:BTCUSDT:5m:candles']);
    const h5 = aggregateBars(data, 5);
    const second = await runPython(PY, { code, data, ctx, inputs: {}, security: { 'spot:BTCUSDT:5m:candles': h5 } });
    expect(second.need).toEqual([]);
    const v = plotOf(second.result, 'h');
    // bar 4 (minute 4) closes together with the first 5m bar -> sees its close; bar 3 does not
    expect(Number.isNaN(v[3])).toBe(true);
    expect(v[4]).toBe(h5.c[0]);
    expect(v[8]).toBe(h5.c[0]);
    expect(v[9]).toBe(h5.c[1]);
  });
});
