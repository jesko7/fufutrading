import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { encodeBook, decodeBook, bookDepth, bookImbalance, bookDepthImbalance, bookWall, bookQtyAt, bookFillPrice, bookMid, bookKey } from '../../src/shared/bookFrame';
import { BookFrames, alignBook, packBook, type BookWire } from '../../src/engine/book';
import { runPine } from '../../src/engine/pine';
import { ScriptHost } from '../../src/engine/host';
import { runPython, initPython, type PyInitOptions } from '../../src/engine/python/host';
import { STRIDE } from '../../src/shared/candles';
import type { BarSeries } from '../../src/engine/types';
import { bars, aggregateBars, ctx } from '../helpers/bars';
import { makeBook, syntheticBook } from '../helpers/book';

const root = path.resolve(__dirname, '../..');
const PY: PyInitOptions = {
  pyodideDir: path.join(root, 'node_modules/pyodide'),
  cacheDir: path.join(root, '.cache/pyodide'),
  pythonDir: path.join(root, 'src/engine/python'),
  bundledWheels: path.join(root, 'resources/wheels'),
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const wireFor = (data: BarSeries, every = 1): BookWire => syntheticBook(data, every);

function pack(b: BarSeries): Float64Array {
  const out = new Float64Array(b.length * STRIDE);
  for (let i = 0, p = 0; i < b.length; i++, p += STRIDE) {
    out[p] = b.t[i];
    out[p + 1] = b.o[i];
    out[p + 2] = b.h[i];
    out[p + 3] = b.l[i];
    out[p + 4] = b.c[i];
    out[p + 5] = b.v[i];
  }
  return out;
}

describe('order-book frames', () => {
  it('round-trip every level exactly, decoding only as deep as asked', () => {
    const b = makeBook(77472.675, 5000);
    const bytes = encodeBook(b.bp, b.bq, b.ap, b.aq, 0.01, 0.00001);
    expect(bytes.length).toBeLessThan(10000 * 5);
    const v = decodeBook(bytes, 123);
    expect(v.t).toBe(123);
    expect([v.bidCount, v.askCount]).toEqual([5000, 5000]);
    expect(v.price('ask', 0)).toBe(b.ap[0]);
    expect(v.qty('bid', 7)).toBe(25);
    expect(Array.from(v.bp)).toEqual(b.bp);
    expect(Array.from(v.bq)).toEqual(b.bq);
    expect(Array.from(v.ap)).toEqual(b.ap);
    expect(Array.from(v.aq)).toEqual(b.aq);
    expect(v.price('bid', 5000)).toBeNaN();
    expect(v.qty('ask', -1)).toBeNaN();
  });

  it('keep prices and quantities that are finer than the instrument filters', () => {
    const v = decodeBook(encodeBook([100.123, 100.1], [0.3, 1.000001], [100.2], [2], 0.01, 0.001), 0);
    expect(Array.from(v.bp)).toEqual([100.123, 100.1]);
    expect(Array.from(v.bq)).toEqual([0.3, 1.000001]);
    expect(Array.from(v.ap)).toEqual([100.2]);
  });

  it('handle one-sided and empty books', () => {
    const asks = decodeBook(encodeBook([], [], [10, 10.5], [1, 2], 0.01, 0.01), 0);
    expect([asks.bidCount, asks.askCount, asks.price('ask', 1), bookMid(asks)]).toEqual([0, 2, 10.5, 10]);
    const none = decodeBook(encodeBook([], [], [], [], 0.01, 0.01), 0);
    expect(bookImbalance(none, 10)).toBeNaN();
    expect(bookMid(none)).toBeNaN();
  });

  it('measure depth, imbalance, walls, levels and fills', () => {
    const v = decodeBook(encodeBook([100, 99.5, 99, 95], [1, 4, 2, 10], [100.5, 101, 106], [2, 1, 8], 0.5, 1), 0);
    expect(bookMid(v)).toBe(100.25);
    expect(bookDepth(v, 'bid', 1)).toBe(5); // 100 and 99.5 are within 1 % of 100.25, 99 is not
    expect(bookDepth(v, 'bid', 0)).toBe(17);
    expect(bookDepth(v, 'ask', 1, true)).toBe(2 * 100.5 + 101);
    expect(bookImbalance(v, 2)).toBeCloseTo((5 - 3) / 8, 12);
    expect(bookDepthImbalance(v, 1)).toBeCloseTo((5 - 3) / 8, 12);
    expect(bookWall(v, 'bid', 1)).toEqual([99.5, 4]);
    expect(bookWall(v, 'bid', NaN)).toEqual([95, 10]);
    expect(bookQtyAt(v, 99)).toBe(2);
    expect(bookQtyAt(v, 101)).toBe(1);
    expect(bookQtyAt(v, 102)).toBe(0);
    expect(bookFillPrice(v, 2.5)).toBeCloseTo((2 * 100.5 + 0.5 * 101) / 2.5, 12);
    expect(bookFillPrice(v, -2)).toBeCloseTo((100 + 99.5) / 2, 12);
    expect(bookFillPrice(v, 50)).toBeNaN();
  });

  it('give each bar the last snapshot taken while it formed', () => {
    const t = [0, 60, 120, 180];
    const tc = [60, 120, 180, 240];
    const f = (x: number) => Uint8Array.of(x);
    const times = [10, 59, 60, 200];
    const pick = alignBook(t, tc, 4, times);
    expect(pick).toEqual([1, 2, -1, 3]);
    const fr = BookFrames.from(packBook(pick.map((k) => (k >= 0 ? times[k] : NaN)), pick.map((k) => (k >= 0 ? f(k + 1) : null))));
    expect([fr.length, fr.count(), fr.time(2), fr.time(3)]).toEqual([4, 3, NaN, 200]);
    fr.apply({ index: 3, length: 5, t: [210, 250], frames: [f(5), f(6)] });
    expect([fr.length, fr.time(3), fr.time(4)]).toEqual([5, 210, 250]);
    fr.apply({ index: 6, length: 7, t: [400], frames: [f(7)] });
    expect([fr.length, fr.time(5), fr.time(6)]).toEqual([7, NaN, 400]);
    fr.apply({ index: 7, length: 2, t: [], frames: [] });
    expect(fr.length).toBe(2);
  });
});

describe('book.* in Pine', () => {
  const data = bars(60);
  const wire = wireFor(data, 3);
  const frames = BookFrames.from(wire);

  it('reads the book of each bar, and na where there is none', () => {
    const r = runPine(
      `//@version=6
indicator("Book")
plot(book.best_bid(), "bb")
plot(book.imbalance(10), "imb")
plot(book.bid_depth(0.05), "depth")
[wp, wq] = book.bid_wall(1)
plot(wp, "wall")
plot(book.bid_qty(0)[1], "prev")
plot(book.available() ? 1 : 0, "on")
plot(array.size(book.ask_prices()), "asks")
plot(request.security(syminfo.tickerid, "5", book.mid()), "sec")`,
      { data, ctx, inputs: {}, book: frames, security: { 'spot:BTCUSDT:5m:candles': aggregateBars(data, 5) } },
    );
    expect(r.error).toBeUndefined();
    const p = (t: string) => r.plots.find((x) => x.title === t)!.values;
    for (let i = 0; i < data.length; i++) {
      const v = frames.at(i);
      if (!v) {
        expect(p('bb')[i]).toBeNaN();
        expect(p('on')[i]).toBe(0);
        expect(p('asks')[i]).toBe(0);
        continue;
      }
      expect(p('bb')[i]).toBe(v.price('bid', 0));
      expect(p('imb')[i]).toBe(bookImbalance(v, 10));
      expect(p('depth')[i]).toBe(bookDepth(v, 'bid', 0.05));
      expect(p('wall')[i]).toBe(bookWall(v, 'bid', 1)[0]);
      expect(p('asks')[i]).toBe(40);
      expect(p('on')[i]).toBe(1);
    }
    expect(p('prev')[4]).toBe(frames.at(3)!.qty('bid', 0)); // [1] is the previous bar's value
    expect(p('prev')[5]).toBeNaN();
    expect(p('sec').every((x) => x !== x)).toBe(true);
  });

  it('runs without frames: na everywhere', () => {
    const r = runPine('//@version=6\nindicator("x")\nplot(book.mid())', { data, ctx, inputs: {} });
    expect(r.error).toBeUndefined();
    expect(r.plots[0].values.every((x) => x !== x)).toBe(true);
  });

  it('live instances ask for the book, then follow its updates', async () => {
    const host = new ScriptHost(null);
    const code = '//@version=6\nindicator("x")\nplot(book.best_ask())';
    const first = await host.open('i', { lang: 'pine', code, ctx, inputs: {}, bars: pack(data), realtime: true });
    expect(first.need).toEqual([bookKey('spot', 'BTCUSDT')]);
    const full = await host.update('i', { bookFull: wireFor(data, 1) });
    expect(full.kind).toBe('full');
    const vals = full.kind === 'full' ? full.result.plots[0].values : new Float64Array();
    expect(vals[59]).toBe(r2(Math.floor(data.c[59] * 100) / 100 + 0.01));
    const nb = makeBook(1000);
    const up = await host.update('i', { book: { index: 59, length: 60, t: [data.t[59] + 59_500], frames: [encodeBook(nb.bp, nb.bq, nb.ap, nb.aq, 0.01, 0.00001)] } });
    expect(up.kind).toBe('patch');
    if (up.kind === 'patch') {
      expect(up.patch.from).toBeLessThanOrEqual(59);
      const pv = up.patch.plots[0].values;
      expect(pv[pv.length - 1]).toBe(nb.ap[0]);
    }
  });
});

describe('data.book in Python', () => {
  beforeAll(async () => {
    await initPython(PY);
  }, 120000);

  const data = bars(60);
  const frames = BookFrames.from(wireFor(data, 3));

  it('asks for the book when it is not loaded', async () => {
    const r = await runPython(PY, { code: '@indicator("x")\ndef main(data):\n    plot(data.book.mid)\n', data, ctx, inputs: {} });
    expect(r.need).toEqual(['book:spot:BTCUSDT']);
  });

  it('matches Pine, per bar and inside Strategy.next()', async () => {
    const code = `
@indicator("Book")
def main(data):
    b = data.book
    plot(b.imbalance(10), "imb")
    plot(b.depth('bid', 0.05), "depth")
    wp, wq = b.wall('bid', 1)
    plot(wp, "wall")
    f = b[-3]
    plot([f.best_ask if f is not None else na] * len(data), "lastask")
    plot(b.available * 1.0, "on")
    plot(b.fill_price(-3), "fill")
`;
    const r = await runPython(PY, { code, data, ctx, inputs: {}, book: frames });
    if (r.result.error) throw new Error(r.result.error.message + '\n' + (r.result.error.traceback || ''));
    const p = (t: string) => r.result.plots.find((x) => x.title === t)!.values;
    for (let i = 0; i < data.length; i++) {
      const v = frames.at(i);
      if (!v) {
        expect(p('imb')[i]).toBeNaN();
        expect(p('on')[i]).toBe(0);
        continue;
      }
      expect(p('imb')[i]).toBe(bookImbalance(v, 10));
      expect(p('depth')[i]).toBe(bookDepth(v, 'bid', 0.05));
      expect(p('wall')[i]).toBe(bookWall(v, 'bid', 1)[0]);
      expect(p('fill')[i]).toBe(bookFillPrice(v, -3));
    }
    expect(p('lastask')[0]).toBe(frames.at(57)!.price('ask', 0));

    const strat = `
@strategy("Book strat", initial_capital=1000, default_qty_type='fixed', default_qty_value=1)
class S(Strategy):
    def next(self):
        f = self.data.book[-1]
        if f is not None:
            log.info(f"{len(self.data.book.imbalance(5))} {f.bids[0][0]} {f.imbalance(5):.6f}")
`;
    const s = await runPython(PY, { code: strat, data, ctx, inputs: {}, book: frames });
    if (s.result.error) throw new Error(s.result.error.message + '\n' + (s.result.error.traceback || ''));
    const logs = s.result.logs.map((l) => l.msg);
    expect(logs.length).toBe(20);
    const v3 = frames.at(3)!;
    expect(logs[1]).toBe(`4 ${v3.price('bid', 0)} ${bookImbalance(v3, 5).toFixed(6)}`);
  });
});

describe('recorded order books', () => {
  it('store frames per day, index them, survive a torn write and prune old days', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { BookStore } = await import('../../src/main/storage/bookStore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-books-'));
    try {
      const st = new BookStore(dir);
      const day = Date.UTC(2026, 9, 1);
      const b = makeBook(100);
      const frame = encodeBook(b.bp, b.bq, b.ap, b.aq, 0.01, 0.00001);
      for (let k = 0; k < 5; k++) st.append('futures', 'BTCUSDT', day + k * 60_000 + 59_750, frame);
      st.append('futures', 'BTCUSDT', day + 86_400_000 + 59_750, frame);
      // a crash in the middle of a write leaves half a record
      const f1 = path.join(dir, 'futures', 'BTCUSDT', '2026-10-01.fbk');
      fs.appendFileSync(f1, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
      const idx = st.index('futures', 'BTCUSDT', day, day + 2 * 86_400_000);
      expect(idx.map((e) => e.t - day)).toEqual([59_750, 119_750, 179_750, 239_750, 299_750, 86_459_750]);
      const [bytes] = st.load([idx[2]]);
      expect(Array.from(decodeBook(bytes, 0).ap)).toEqual(b.ap);
      expect(st.index('futures', 'BTCUSDT', day + 100_000, day + 200_000).length).toBe(2);
      const stats = st.stats();
      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({ market: 'futures', symbol: 'BTCUSDT', days: 2, first: day + 59_750, last: day + 86_459_750 });
      st.prune(1, day + 2 * 86_400_000 + 1000);
      expect(st.index('futures', 'BTCUSDT', day, day + 2 * 86_400_000).length).toBe(1);
      st.clear('futures', 'BTCUSDT');
      expect(st.stats()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('give bars the recorded frame taken while they formed', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { BookRecorder } = await import('../../src/main/market/bookRecorder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-books-'));
    try {
      const day = Date.UTC(2026, 9, 1);
      const hub = { clock: { now: () => day + 86_400_000 } } as never;
      const rec = new BookRecorder(hub, dir, () => {});
      const frames = [100, 101, 102].map((m) => {
        const b = makeBook(m);
        return encodeBook(b.bp, b.bq, b.ap, b.aq, 0.01, 0.00001);
      });
      // minute snapshots at :59.75 of minutes 0, 1 and 3
      rec.store.append('spot', 'BTCUSDT', day + 59_750, frames[0]);
      rec.store.append('spot', 'BTCUSDT', day + 119_750, frames[1]);
      rec.store.append('spot', 'BTCUSDT', day + 239_750, frames[2]);
      // 1-minute bars: each gets its own minute's frame, minute 2 none
      const t = [0, 1, 2, 3].map((k) => day + k * 60_000);
      const tc = t.map((x) => x + 60_000);
      const f = rec.framesFor('spot', 'BTCUSDT', t, tc, 4);
      expect(f.t.map((x) => (x === x ? x - day : null))).toEqual([59_750, 119_750, null, 239_750]);
      expect(f.count).toBe(3);
      // a 5-minute bar gets the last frame inside it
      const five = rec.framesFor('spot', 'BTCUSDT', [day], [day + 300_000], 1);
      expect(five.t[0] - day).toBe(239_750);
      // the replay clock hides what comes after it
      const replay = rec.framesFor('spot', 'BTCUSDT', [day], [day + 300_000], 1, day + 200_000);
      expect(replay.t[0] - day).toBe(119_750);
      const w = rec.wireFor('spot', 'BTCUSDT', t, tc, 4);
      expect(BookFrames.from(w).at(1)!.price('bid', 0)).toBe(makeBook(101).bp[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
