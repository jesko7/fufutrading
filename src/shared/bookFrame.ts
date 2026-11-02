/**
 * Order-book snapshots ("frames"): every price level of both sides at one moment, packed into a
 * few bytes per level, and the measures scripts compute on them.
 *
 * Binance publishes market-by-price data only: one aggregated quantity per price level (up to
 * 5000 levels a side on spot, 1000 on USDⓈ-M futures in a snapshot, kept current by the diff
 * stream). Individual orders (market-by-order) are not published, so a frame is the full
 * level list the local book holds.
 *
 * Layout (all integers LEB128 varints; signed ones zig-zag encoded):
 *   version, price decimals, qty decimals, bid count, ask count, bid section length (bytes)
 *   bids, best first: price, qty, then (previous price − price, qty) per level
 *   asks, best first: (price − best bid) or price without bids, qty, then (price − previous, qty)
 * Prices and quantities are whole multiples of 10^−decimals. The bid section length lets a
 * reader start at the asks without walking the bids.
 */

export interface BookLevels {
  /** Snapshot time (ms). */
  t: number;
  /** Bids, best (highest) first. */
  bp: ArrayLike<number>;
  bq: ArrayLike<number>;
  /** Asks, best (lowest) first. */
  ap: ArrayLike<number>;
  aq: ArrayLike<number>;
}

const VERSION = 1;

/** Data key scripts ask for when they read the order book: "book:<market>:<SYMBOL>". */
export function bookKey(market: string, symbol: string): string {
  return `book:${market}:${symbol}`;
}

export function isBookKey(key: string): boolean {
  return key.startsWith('book:');
}

export function bookKeyParts(key: string): { market: 'spot' | 'futures'; symbol: string } {
  const [, market, symbol] = key.split(':');
  return { market: market === 'futures' ? 'futures' : 'spot', symbol };
}

function unitDecimals(unit: number): number {
  for (let d = 0; d <= 10; d++) if (Math.abs(unit * 10 ** d - Math.round(unit * 10 ** d)) < 1e-9) return d;
  return 10;
}

/** Smallest decimals ≥ `from` at which every value is a whole number of units. */
function fitDecimals(values: ArrayLike<number>[], from: number): number {
  for (let d = from; d <= 10; d++) {
    const m = 10 ** d;
    let ok = true;
    for (const a of values)
      for (let k = 0; k < a.length && ok; k++) {
        const x = a[k] * m;
        if (Math.abs(x - Math.round(x)) > 1e-7 + Math.abs(x) * 1e-15) ok = false;
      }
    if (ok) return d;
  }
  return 10;
}

class Writer {
  buf = new Uint8Array(256);
  n = 0;
  private room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u(x: number): void {
    this.room(10);
    while (x >= 128) {
      this.buf[this.n++] = (x % 128) | 128;
      x = Math.floor(x / 128);
    }
    this.buf[this.n++] = x;
  }
  s(x: number): void {
    this.u(x < 0 ? -2 * x - 1 : 2 * x);
  }
  bytes(other: Writer): void {
    this.room(other.n);
    this.buf.set(other.buf.subarray(0, other.n), this.n);
    this.n += other.n;
  }
}

/** Encode one snapshot. `tick`/`step` are the instrument's price and quantity increments. */
export function encodeBook(bp: ArrayLike<number>, bq: ArrayLike<number>, ap: ArrayLike<number>, aq: ArrayLike<number>, tick: number, step: number): Uint8Array {
  const pd = fitDecimals([bp, ap], unitDecimals(tick));
  const qd = fitDecimals([bq, aq], unitDecimals(step));
  const pm = 10 ** pd;
  const qm = 10 ** qd;
  const P = (x: number) => Math.round(x * pm);
  const Q = (x: number) => Math.max(0, Math.round(x * qm));
  const bids = new Writer();
  let prev = 0;
  for (let k = 0; k < bp.length; k++) {
    const p = P(bp[k]);
    if (k === 0) bids.u(p);
    else bids.s(prev - p);
    bids.u(Q(bq[k]));
    prev = p;
  }
  const best = bp.length ? P(bp[0]) : 0;
  const asks = new Writer();
  for (let k = 0; k < ap.length; k++) {
    const p = P(ap[k]);
    if (k === 0) {
      if (bp.length) asks.s(p - best);
      else asks.u(p);
    } else asks.s(p - prev);
    asks.u(Q(aq[k]));
    prev = p;
  }
  const out = new Writer();
  out.u(VERSION);
  out.u(pd);
  out.u(qd);
  out.u(bp.length);
  out.u(ap.length);
  out.u(bids.n);
  out.bytes(bids);
  out.bytes(asks);
  return out.buf.slice(0, out.n);
}

/**
 * A decoded view of one frame. Levels are decoded on first use and only as deep as asked
 * (most measures stop near the top of the book).
 */
export class BookView implements BookLevels {
  readonly bidCount: number;
  readonly askCount: number;
  private pm: number;
  private qm: number;
  private pos: [number, number];
  private got: [number, number] = [0, 0];
  private px: [Float64Array, Float64Array];
  private qx: [Float64Array, Float64Array];
  private last: [number, number] = [0, 0];
  private bestBidUnits = 0;

  constructor(
    private b: Uint8Array,
    readonly t: number,
  ) {
    let i = 0;
    const u = () => {
      let x = 0;
      let m = 1;
      for (;;) {
        const c = b[i++];
        x += (c & 127) * m;
        if (c < 128) return x;
        m *= 128;
      }
    };
    const v = u();
    if (v !== VERSION) throw new Error(`Unknown order-book frame version ${v}`);
    this.pm = 10 ** u();
    this.qm = 10 ** u();
    this.bidCount = u();
    this.askCount = u();
    const bidLen = u();
    this.pos = [i, i + bidLen];
    this.px = [new Float64Array(this.bidCount), new Float64Array(this.askCount)];
    this.qx = [new Float64Array(this.bidCount), new Float64Array(this.askCount)];
    if (this.bidCount) {
      // the first ask is stored relative to the best bid
      let j = i;
      let x = 0;
      let m = 1;
      for (;;) {
        const c = b[j++];
        x += (c & 127) * m;
        if (c < 128) break;
        m *= 128;
      }
      this.bestBidUnits = x;
    }
  }

  /** Decode side `s` (0 bids, 1 asks) down to level `k` (inclusive). */
  private fill(s: 0 | 1, k: number): void {
    const count = s ? this.askCount : this.bidCount;
    const want = Math.min(k + 1, count);
    if (this.got[s] >= want) return;
    const b = this.b;
    let i = this.pos[s];
    const u = () => {
      let x = 0;
      let m = 1;
      for (;;) {
        const c = b[i++];
        x += (c & 127) * m;
        if (c < 128) return x;
        m *= 128;
      }
    };
    const z = () => {
      const x = u();
      return x % 2 ? -(x + 1) / 2 : x / 2;
    };
    let p = this.last[s];
    for (let n = this.got[s]; n < want; n++) {
      if (n === 0) p = s === 0 ? u() : this.bidCount ? this.bestBidUnits + z() : u();
      else p = s === 0 ? p - z() : p + z();
      this.px[s][n] = p / this.pm;
      this.qx[s][n] = u() / this.qm;
    }
    this.last[s] = p;
    this.pos[s] = i;
    this.got[s] = want;
  }

  count(side: 'bid' | 'ask'): number {
    return side === 'bid' ? this.bidCount : this.askCount;
  }

  price(side: 'bid' | 'ask', k: number): number {
    const s = side === 'bid' ? 0 : 1;
    if (!(k >= 0) || k >= (s ? this.askCount : this.bidCount)) return NaN;
    this.fill(s, Math.floor(k));
    return this.px[s][Math.floor(k)];
  }

  qty(side: 'bid' | 'ask', k: number): number {
    const s = side === 'bid' ? 0 : 1;
    if (!(k >= 0) || k >= (s ? this.askCount : this.bidCount)) return NaN;
    this.fill(s, Math.floor(k));
    return this.qx[s][Math.floor(k)];
  }

  private all(s: 0 | 1): void {
    this.fill(s, (s ? this.askCount : this.bidCount) - 1);
  }

  get bp(): Float64Array {
    this.all(0);
    return this.px[0];
  }
  get bq(): Float64Array {
    this.all(0);
    return this.qx[0];
  }
  get ap(): Float64Array {
    this.all(1);
    return this.px[1];
  }
  get aq(): Float64Array {
    this.all(1);
    return this.qx[1];
  }
}

export function decodeBook(bytes: Uint8Array, t: number): BookView {
  return new BookView(bytes, t);
}

// ---------------------------------------------------------------- measures

export function bestBid(b: BookView): number {
  return b.price('bid', 0);
}

export function bestAsk(b: BookView): number {
  return b.price('ask', 0);
}

/** Mid price; the best price of the only side when the other is empty. */
export function bookMid(b: BookView): number {
  const bb = bestBid(b);
  const ba = bestAsk(b);
  return bb === bb && ba === ba ? (bb + ba) / 2 : bb === bb ? bb : ba;
}

/**
 * Resting quantity on one side within `pct` % of the mid (all levels when pct is na or ≤ 0);
 * `notional` sums price × quantity (quote currency) instead.
 */
export function bookDepth(b: BookView, side: 'bid' | 'ask', pct: number, notional = false): number {
  const n = b.count(side);
  const lim = pct > 0 ? bookMid(b) * (side === 'bid' ? 1 - pct / 100 : 1 + pct / 100) : NaN;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const p = b.price(side, k);
    if (lim === lim && (side === 'bid' ? p < lim : p > lim)) break;
    const q = b.qty(side, k);
    sum += notional ? p * q : q;
  }
  return sum;
}

/** (bid qty − ask qty) / (bid qty + ask qty) over the best `levels` levels a side (all when na or ≤ 0): −1 … +1. */
export function bookImbalance(b: BookView, levels: number): number {
  let bid = 0;
  let ask = 0;
  const nb = levels > 0 ? Math.min(b.bidCount, Math.floor(levels)) : b.bidCount;
  const na = levels > 0 ? Math.min(b.askCount, Math.floor(levels)) : b.askCount;
  for (let k = 0; k < nb; k++) bid += b.qty('bid', k);
  for (let k = 0; k < na; k++) ask += b.qty('ask', k);
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : NaN;
}

/** Like bookImbalance, but over the quantity within `pct` % of the mid. */
export function bookDepthImbalance(b: BookView, pct: number): number {
  const bid = bookDepth(b, 'bid', pct);
  const ask = bookDepth(b, 'ask', pct);
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : NaN;
}

/** The largest level on one side within `pct` % of the mid (all levels when na or ≤ 0): [price, qty]. */
export function bookWall(b: BookView, side: 'bid' | 'ask', pct: number): [number, number] {
  const n = b.count(side);
  const lim = pct > 0 ? bookMid(b) * (side === 'bid' ? 1 - pct / 100 : 1 + pct / 100) : NaN;
  let bp = NaN;
  let bq = 0;
  for (let k = 0; k < n; k++) {
    const p = b.price(side, k);
    if (lim === lim && (side === 'bid' ? p < lim : p > lim)) break;
    const q = b.qty(side, k);
    if (q > bq) {
      bq = q;
      bp = p;
    }
  }
  return [bp, bp === bp ? bq : NaN];
}

/** Quantity resting at exactly `price` (either side; 0 when no level there). */
export function bookQtyAt(b: BookView, price: number): number {
  const eps = Math.abs(price) * 1e-12;
  for (const side of ['bid', 'ask'] as const) {
    const n = b.count(side);
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = b.price(side, mid);
      if (Math.abs(p - price) <= eps) return b.qty(side, mid);
      if (side === 'bid' ? p > price : p < price) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  return 0;
}

/**
 * Average fill price of a market order for |qty| walked through the book: a positive quantity
 * buys from the asks, a negative one sells into the bids. na when the book is not deep enough.
 */
export function bookFillPrice(b: BookView, qty: number): number {
  const side = qty > 0 ? 'ask' : 'bid';
  let rem = Math.abs(qty);
  if (!(rem > 0)) return NaN;
  let cost = 0;
  const n = b.count(side);
  for (let k = 0; k < n && rem > 1e-12; k++) {
    const take = Math.min(rem, b.qty(side, k));
    cost += take * b.price(side, k);
    rem -= take;
  }
  return rem > 1e-9 * Math.abs(qty) ? NaN : cost / Math.abs(qty);
}
