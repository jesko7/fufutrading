import { describe, it, expect } from 'vitest';
import { runPine, analyzePine, PineInstance, mapSecurity, securityRequests, compileCached } from '../../src/engine/pine';
import type { BarSeries, RunContext } from '../../src/engine/types';

const MIN = 60000;
function bars(n: number, f = (i: number) => 100 + Math.sin(i / 7) * 10 + i * 0.05, start = Date.UTC(2026, 0, 1), step = MIN): BarSeries {
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const tc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = start + i * step;
    tc[i] = t[i] + step;
    o[i] = f(i);
    c[i] = f(i + 1);
    h[i] = Math.max(o[i], c[i]) + 0.5 + (i % 3) * 0.1;
    l[i] = Math.min(o[i], c[i]) - 0.5 - (i % 5) * 0.1;
    v[i] = 10 + (i % 7);
  }
  return { t, o, h, l, c, v, tc, length: n };
}

const ctx: RunContext = { symbol: 'BTCUSDT', market: 'spot', tf: '1m', chartType: 'candles', mintick: 0.01, base: 'BTC', quote: 'USDT' };

function run(code: string, data = bars(300), extra: Partial<Parameters<typeof runPine>[1]> = {}) {
  const r = runPine(code, { data, ctx, inputs: {}, ...extra });
  if (r.error) throw new Error(`${r.error.kind}: ${r.error.message} (line ${r.error.line})`);
  return r;
}

function plot(r: ReturnType<typeof run>, title: string): Float64Array {
  const p = r.plots.find((x) => x.title === title);
  if (!p) throw new Error(`no plot ${title}: ${r.plots.map((x) => x.title)}`);
  return p.values;
}

describe('Pine: moving averages and oscillators', () => {
  const d = bars(200);
  it('ta.sma matches a direct computation', () => {
    const r = run(`//@version=5\nindicator("t")\nplot(ta.sma(close, 14), "s")`, d);
    const s = plot(r, 's');
    for (let i = 0; i < 13; i++) expect(s[i]).toBeNaN();
    for (const i of [13, 50, 199]) {
      let sum = 0;
      for (let k = i - 13; k <= i; k++) sum += d.c[k];
      expect(s[i]).toBeCloseTo(sum / 14, 9);
    }
  });
  it('ta.ema is seeded with the SMA of the first length values', () => {
    const r = run(`//@version=5\nindicator("t")\nplot(ta.ema(close, 10), "e")`, d);
    const e = plot(r, 'e');
    let sum = 0;
    for (let k = 0; k < 10; k++) sum += d.c[k];
    expect(e[8]).toBeNaN();
    expect(e[9]).toBeCloseTo(sum / 10, 9);
    const a = 2 / 11;
    expect(e[10]).toBeCloseTo(a * d.c[10] + (1 - a) * e[9], 9);
  });
  it('ta.rsi follows the Wilder (RMA) definition', () => {
    const r = run(`//@version=5\nindicator("t")\nplot(ta.rsi(close, 14), "r")`, d);
    const rs = plot(r, 'r');
    // reference
    let up = 0;
    let dn = 0;
    const ref: number[] = [];
    let ru = NaN;
    let rd = NaN;
    for (let i = 1; i < d.length; i++) {
      const ch = d.c[i] - d.c[i - 1];
      const u = Math.max(ch, 0);
      const dd = Math.max(-ch, 0);
      if (i <= 14) {
        up += u;
        dn += dd;
        if (i === 14) {
          ru = up / 14;
          rd = dn / 14;
        }
      } else {
        ru = (ru * 13 + u) / 14;
        rd = (rd * 13 + dd) / 14;
      }
      ref[i] = i < 14 ? NaN : 100 - 100 / (1 + ru / rd);
    }
    expect(rs[13]).toBeNaN();
    for (const i of [14, 40, 199]) expect(rs[i]).toBeCloseTo(ref[i], 8);
  });
  it('MACD tuple, crossover and highest/lowest short forms', () => {
    const r = run(
      `//@version=5
indicator("t")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(m, "m")
plot(h, "h")
plot(ta.highest(5), "hh")
plot(ta.crossover(m, s) ? 1 : 0, "x")`,
      d,
    );
    const m = plot(r, 'm');
    const h = plot(r, 'h');
    expect(isFinite(m[40])).toBe(true);
    expect(isFinite(h[60])).toBe(true);
    const hh = plot(r, 'hh');
    expect(hh[10]).toBe(Math.max(...Array.from(d.h.slice(6, 11))));
    expect(plot(r, 'x').some((v) => v === 1)).toBe(true);
  });
});

describe('Pine: language semantics', () => {
  it('var persists, x[n] reads previous bars', () => {
    const r = run(`//@version=5\nindicator("t")\nvar c = 0\nc := c + 1\nplot(c, "c")\nplot(c[1], "p")\nplot(close[2], "c2")`, bars(20));
    expect(Array.from(plot(r, 'c').slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(plot(r, 'p')[0]).toBeNaN();
    expect(plot(r, 'p')[5]).toBe(5);
    const d = bars(20);
    expect(plot(r, 'c2')[5]).toBe(d.c[3]);
  });

  it('user functions keep separate state per call site', () => {
    const r = run(
      `//@version=5
indicator("t")
f(x) =>
    s = ta.sma(x, 3)
    s
a = f(close)
b = f(open)
plot(a, "a")
plot(b, "b")
plot(ta.sma(open, 3), "ref")`,
    );
    expect(plot(r, 'b')[50]).toBeCloseTo(plot(r, 'ref')[50], 10);
    expect(plot(r, 'a')[50]).not.toBeCloseTo(plot(r, 'b')[50], 3);
  });

  it('if/else and switch expressions, loops, tuples', () => {
    const r = run(
      `//@version=5
indicator("t")
x = if close > open
    1
else
    -1
y = switch
    close > open => "up"
    => "down"
s = 0.0
for k = 1 to 5
    s += k
w = 0
while w < 3
    w += 1
t(a) => [a, a * 2]
[p, q] = t(close)
plot(x, "x")
plot(y == "up" ? 1 : 0, "y")
plot(s, "s")
plot(w, "w")
plot(q - 2 * p, "q")`,
    );
    const d = bars(300);
    expect(plot(r, 'x')[10]).toBe(d.c[10] > d.o[10] ? 1 : -1);
    expect(plot(r, 'y')[10]).toBe(d.c[10] > d.o[10] ? 1 : 0);
    expect(plot(r, 's')[0]).toBe(15);
    expect(plot(r, 'w')[0]).toBe(3);
    expect(plot(r, 'q')[100]).toBeCloseTo(0, 9);
  });

  it('arrays, maps, strings and math', () => {
    const r = run(
      `//@version=5
indicator("t")
var a = array.new_float()
array.push(a, close)
if array.size(a) > 5
    array.shift(a)
m = map.new<string, float>()
m.put("k", 2.5)
txt = str.format("{0}-{1}", "a", 3)
plot(array.avg(a), "avg")
plot(array.size(a), "n")
plot(m.get("k"), "m")
plot(str.length(txt), "len")
plot(math.max(1, 5, 3), "mx")
plot(nz(na, 7), "nz")`,
      bars(50),
    );
    const d = bars(50);
    const avg = (d.c[45] + d.c[46] + d.c[47] + d.c[48] + d.c[49]) / 5;
    expect(plot(r, 'avg')[49]).toBeCloseTo(avg, 9);
    expect(plot(r, 'n')[49]).toBe(5);
    expect(plot(r, 'm')[0]).toBe(2.5);
    expect(plot(r, 'len')[0]).toBe(3);
    expect(plot(r, 'mx')[0]).toBe(5);
    expect(plot(r, 'nz')[0]).toBe(7);
  });

  it('inputs are exposed and honoured', () => {
    const code = `//@version=5\nindicator("t", overlay=true)\nlen = input.int(14, "Length", minval=1)\nsrc = input.source(close, "Source")\nplot(ta.sma(src, len), "s")`;
    const a = analyzePine(code);
    expect(a.ok).toBe(true);
    expect(a.inputs!.map((i) => [i.title, i.type, i.defval])).toEqual([
      ['Length', 'int', 14],
      ['Source', 'source', 'close'],
    ]);
    expect(a.meta!.overlay).toBe(true);
    const d = bars(60);
    const r = runPine(code, { data: d, ctx, inputs: { in0: 3, in1: 'open' } });
    expect(r.plots[0].values[10]).toBeCloseTo((d.o[8] + d.o[9] + d.o[10]) / 3, 9);
  });

  it('plots, fills, hlines and dynamic colors', () => {
    const r = run(
      `//@version=5
indicator("t")
p1 = plot(close, "c", color=close > open ? color.green : color.red)
p2 = plot(open, "o")
fill(p1, p2, color=color.new(color.blue, 80))
hline(50, "mid")
bgcolor(close > open ? color.new(color.teal, 90) : na)`,
      bars(30),
    );
    expect(r.plots[0].colors![5]).toMatch(/rgb/);
    expect(r.fills[0]).toMatchObject({ a: 'plot0', b: 'plot1' });
    expect(r.hlines[0].price).toBe(50);
    expect(r.bgcolors!.some((x) => x !== null)).toBe(true);
  });

  it('v5 evaluates both operands of and/or, v6 short-circuits', () => {
    const body = `indicator("t")\nvar n = 0\ncount() =>\n    n2 = 1\n    n2\ncond = false and ta.change(close) > 0\nc2 = ta.barssince(true)\nplot(c2, "b")`;
    expect(run(`//@version=5\n${body}`, bars(10)).ok).toBe(true);
    expect(run(`//@version=6\n${body}`, bars(10)).ok).toBe(true);
  });
});

describe('Pine: errors', () => {
  it('reports undeclared identifiers with line numbers', () => {
    const a = analyzePine(`//@version=5\nindicator("t")\nplot(foo)`);
    expect(a.ok).toBe(false);
    expect(a.error!.message).toMatch(/foo/);
    expect(a.error!.line).toBe(3);
  });
  it('reports unsupported features clearly', () => {
    const a = analyzePine(`//@version=5\nimport TradingView/ta/7 as tv\nindicator("t")\nplot(close)`);
    expect(a.ok).toBe(false);
    expect(a.error!.kind).toBe('unsupported');
    const b = analyzePine(`//@version=5\nindicator("t")\nx = request.financial("NASDAQ:AAPL", "EPS", "FQ")\nplot(x)`);
    expect(b.error!.kind).toBe('unsupported');
  });
  it('rejects future references', () => {
    const a = analyzePine(`//@version=5\nindicator("t")\nplot(close[-1])`);
    expect(a.ok).toBe(false);
  });
  it('reports syntax errors', () => {
    const a = analyzePine(`//@version=5\nindicator("t")\nx = (close + \nplot(x)`);
    expect(a.ok).toBe(false);
  });
});

describe('Pine: request.security', () => {
  it('maps higher-timeframe values without lookahead', () => {
    const chart = bars(240); // 1m
    // 15m context bars built from the 1m bars
    const n = 16;
    const H = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), tc: new Float64Array(n), length: n };
    for (let k = 0; k < n; k++) {
      H.t[k] = chart.t[k * 15];
      H.tc[k] = H.t[k] + 15 * MIN;
      H.o[k] = chart.o[k * 15];
      H.c[k] = chart.c[k * 15 + 14];
      H.h[k] = Math.max(...Array.from(chart.h.slice(k * 15, k * 15 + 15)));
      H.l[k] = Math.min(...Array.from(chart.l.slice(k * 15, k * 15 + 15)));
    }
    const code = `//@version=5\nindicator("t")\nplot(request.security(syminfo.tickerid, "15", close), "h")`;
    const c = compileCached(code);
    const reqs = securityRequests(c, {}, ctx);
    expect(reqs[0]).toMatchObject({ symbol: 'BTCUSDT', market: 'spot', tf: '15m' });
    const r = runPine(code, { data: chart, ctx, inputs: {}, security: { [reqs[0].key]: H } });
    expect(r.error).toBeUndefined();
    const v = r.plots[0].values;
    // within the first 15 minutes no completed HTF bar exists yet
    expect(v[5]).toBeNaN();
    // on the last 1m bar of the first 15m bar, the completed HTF close is available
    expect(v[14]).toBe(H.c[0]);
    // during the second 15m bar the previous closed value is held (no lookahead)
    expect(v[20]).toBe(H.c[0]);
    expect(v[29]).toBe(H.c[1]);
    expect(r.warnings.some((w) => w.kind === 'repaint')).toBe(true);
  });
  it('lookahead_on leaks the future and is flagged', () => {
    const a = analyzePine(`//@version=5\nindicator("t")\nplot(request.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on))`);
    expect(a.warnings!.some((w) => w.kind === 'lookahead')).toBe(true);
    const b = analyzePine(`//@version=5\nindicator("t")\nplot(request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_on))`);
    expect(b.warnings!.some((w) => w.kind === 'lookahead')).toBe(false);
  });
  it('mapSecurity gaps_on only on closing bars', () => {
    const chart = bars(30);
    const ctxBars = { t: Float64Array.from([chart.t[0], chart.t[10], chart.t[20]]), tc: Float64Array.from([chart.t[10], chart.t[20], chart.t[29] + MIN]), o: new Float64Array(3), h: new Float64Array(3), l: new Float64Array(3), c: new Float64Array(3), v: new Float64Array(3), length: 3 };
    const m = mapSecurity(chart, ctxBars, [1, 2, 3], { lookahead: false, gaps: true, lowerTf: false, realtime: false });
    expect(m[9]).toBe(1);
    expect(m[10]).toBeNaN();
    expect(m[19]).toBe(2);
  });
});

describe('Pine: strategies', () => {
  it('SMA crossover strategy produces consistent trades and equity', () => {
    const d = bars(500);
    const r = run(
      `//@version=5
strategy("x", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
f = ta.sma(close, 5)
s = ta.sma(close, 20)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")`,
      d,
    );
    const st = r.strategy!;
    expect(st.trades.length).toBeGreaterThan(3);
    for (const t of st.trades) {
      // market orders fill at the next bar's open
      expect(t.entryPrice).toBe(d.o[t.entryBar]);
      expect(t.exitPrice).toBe(d.o[t.exitBar]);
      expect(t.profit).toBeCloseTo((t.exitPrice - t.entryPrice) * t.qty, 9);
    }
    const net = st.trades.reduce((a, t) => a + t.profit, 0);
    const lastEq = st.equity[d.length - 1];
    const open = st.openTrades.reduce((a, t) => a + (d.c[d.length - 1] - t.entryPrice) * t.qty * t.dir, 0);
    expect(lastEq).toBeCloseTo(10000 + net + open, 6);
  });

  it('strategy.exit fills exactly at the profit/loss tick levels', () => {
    const d = bars(400);
    const r = run(
      `//@version=5
strategy("x", initial_capital=100000, default_qty_value=2)
if bar_index % 50 == 0 and strategy.position_size == 0
    strategy.entry("L", strategy.long)
strategy.exit("xl", "L", profit=200, loss=150)`,
      d,
    );
    const st = r.strategy!;
    const exits = st.trades.filter((t) => t.exitId.includes('xl'));
    expect(exits.length).toBeGreaterThan(2);
    for (const t of exits) {
      const tp = t.entryPrice + 200 * 0.01;
      const sl = t.entryPrice - 150 * 0.01;
      const gapOpen = d.o[t.exitBar];
      expect([tp, sl, gapOpen].some((x) => Math.abs(x - t.exitPrice) < 1e-6)).toBe(true);
    }
  });

  it('an opposite entry reverses the position', () => {
    const d = bars(400);
    const r = run(
      `//@version=5
strategy("x", initial_capital=100000, default_qty_value=2)
if bar_index % 50 == 0
    strategy.entry("L", strategy.long)
if bar_index % 50 == 25
    strategy.entry("S", strategy.short)`,
      d,
      { strategy: { market: 'futures', leverage: 1, makerFee: 0, takerFee: 0 } },
    );
    const st = r.strategy!;
    const rev = st.trades.find((t) => t.dir === 1 && t.exitId === 'S');
    expect(rev).toBeTruthy();
    // the short opened on the same fill with the entry quantity
    expect(st.trades.some((t) => t.dir === -1 && t.entryBar === rev!.exitBar && t.qty === 2)).toBe(true);
  });

  it('applies percent commission from the strategy() declaration', () => {
    const d = bars(200);
    const r = run(
      `//@version=5
strategy("x", initial_capital=10000, default_qty_value=1, commission_type=strategy.commission.percent, commission_value=0.1)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 20
    strategy.close("L")`,
      d,
    );
    const t = r.strategy!.trades[0];
    const comm = 0.001 * (t.entryPrice + t.exitPrice);
    expect(t.commission).toBeCloseTo(comm, 9);
    expect(t.profit).toBeCloseTo(t.exitPrice - t.entryPrice - comm, 9);
  });
});

describe('Pine: live instance', () => {
  it('re-executing the realtime bar matches a full rerun', () => {
    const code = `//@version=5\nindicator("t")\nvar cnt = 0\ncnt := cnt + 1\nplot(ta.ema(close, 9), "e")\nplot(cnt, "n")\nplot(ta.rsi(close, 14), "r")`;
    const d = bars(120);
    const inst = new PineInstance(code, { data: d, ctx, inputs: {}, realtime: true });
    inst.run();
    // tick on the last bar
    d.c[119] += 3;
    d.h[119] = Math.max(d.h[119], d.c[119]);
    let r = inst.update(d);
    const full = runPine(code, { data: d, ctx, inputs: {}, realtime: true });
    expect(r.plots[0].values[119]).toBeCloseTo(full.plots[0].values[119], 9);
    expect(r.plots[1].values[119]).toBe(full.plots[1].values[119]);
    expect(r.plots[2].values[119]).toBeCloseTo(full.plots[2].values[119], 9);
    // append a new bar
    const d2 = bars(121);
    for (let k = 0; k < 120; k++) {
      d2.c[k] = d.c[k];
      d2.h[k] = d.h[k];
    }
    r = inst.update(d2);
    const full2 = runPine(code, { data: d2, ctx, inputs: {}, realtime: true });
    expect(r.plots[0].values[120]).toBeCloseTo(full2.plots[0].values[120], 9);
    expect(r.plots[1].values[120]).toBe(121);
    expect(r.plots[0].values[119]).toBeCloseTo(full2.plots[0].values[119], 9);
  });
});

describe('Pine: request.security static resolution', () => {
  const code = `//@version=6
indicator("x")
tf = input.timeframe("60", "TF")
sym = input.symbol("BINANCE:ETHUSDT", "Symbol")
plot(request.security(sym, tf, ta.ema(close[1], 5), lookahead=barmerge.lookahead_on))
type = 3
plot(type)`;

  it('resolves inputs passed through variables and follows input changes', () => {
    const c = compileCached(code);
    expect(c.inputs.length).toBe(2);
    expect(securityRequests(c, {}, ctx).map((r) => r.key)).toEqual(['spot:ETHUSDT:1h:candles']);
    expect(securityRequests(c, { in0: '240', in1: 'BINANCE:SOLUSDT.P' }, ctx).map((r) => r.key)).toEqual(['futures:SOLUSDT:4h:candles']);
    // expression fully offset by [1] with lookahead_on is the non-repainting idiom: no lookahead warning
    expect(c.warnings.filter((w) => w.kind === 'lookahead')).toEqual([]);
  });

  it('flags lookahead_on without an offset', () => {
    const c = compileCached('//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid, "60", ta.ema(close, 5), lookahead=barmerge.lookahead_on))');
    expect(c.warnings.some((w) => w.kind === 'lookahead')).toBe(true);
  });

  it('rejects a reassigned timeframe variable', () => {
    expect(() => compileCached('//@version=6\nindicator("x")\ntf = "60"\ntf := "240"\nplot(request.security(syminfo.tickerid, tf, close))')).toThrow(/reassigned/);
  });
});

describe('Pine: bar inspector trace', () => {
  it('records per-bar values of top-level variables (incl. var, tuples, bools)', () => {
    const data = bars(50);
    const r = run(
      `//@version=6
indicator("t")
fast = ta.sma(close, 3)
var count = 0
count += 1
[m, s, h] = ta.macd(close, 3, 6, 2)
up = close > open
plot(fast)`,
      data,
      { trace: true },
    );
    expect(Object.keys(r.trace!).sort()).toEqual(['count', 'fast', 'h', 'm', 's', 'up'].sort());
    expect(r.trace!.count[0]).toBe(1);
    expect(r.trace!.count[49]).toBe(50);
    expect(r.trace!.fast[10]).toBeCloseTo((data.c[8] + data.c[9] + data.c[10]) / 3, 9);
    expect(r.trace!.up[5]).toBe(data.c[5] > data.o[5] ? 1 : 0);
    expect(Number.isNaN(r.trace!.fast[0])).toBe(true);
  });
});

describe('repaint and lookahead warnings', () => {
  it('flags varip, timenow, barstate.isrealtime and negative plot offsets', async () => {
    const { analyzePine } = await import('../../src/engine/pine');
    const a = analyzePine(`//@version=5
indicator("w")
varip int ticks = 0
ticks += 1
t = timenow
live = barstate.isrealtime
plot(close, offset=-2)
`);
    const msgs = (a.warnings || []).map((w: { kind: string; message: string }) => `${w.kind}: ${w.message}`);
    expect(msgs.some((m) => /^repaint: .*varip/.test(m))).toBe(true);
    expect(msgs.some((m) => /^repaint: .*timenow/.test(m))).toBe(true);
    expect(msgs.some((m) => /^repaint: .*barstate\.isrealtime/.test(m))).toBe(true);
    expect(msgs.some((m) => /^lookahead: .*offset=-2/.test(m))).toBe(true);
  });
});
