"""
fufu — FuFu Trading's Python scripting API.

Indicators are plain functions decorated with @indicator; they receive the chart data as numpy
arrays and call plot()/hline()/fill()/... . Strategies subclass Strategy: `init()` precomputes
(vectorised), `next()` runs once per bar close and places orders. Inside next(), every data
array and every series registered with self.I() is truncated at the current bar, so indexing
can never read future values ([-1] is the current bar, [-2] the previous one).

Technical-analysis functions (fufu.ta) run the exact same implementations as the Pine Script
engine, so the same indicator gives the same numbers in both languages.
"""
from __future__ import annotations

import math as _math
import numpy as np

try:  # provided by the host (JavaScript) when running inside FuFu
    import fufu_js as _js  # type: ignore
except Exception:  # pragma: no cover - allows import outside the app for linting
    _js = None

__all__ = [
    'indicator', 'strategy', 'Strategy', 'input', 'ta', 'plot', 'plotshape', 'plotchar', 'hline', 'fill',
    'bgcolor', 'barcolor', 'alertcondition', 'color', 'log', 'na', 'nz', 'crossover', 'crossunder', 'cross',
    'long', 'short', 'np',
]

long = 1
short = -1
na = float('nan')


def nz(x, replacement=0.0):
    """Replace NaN with `replacement` (works on scalars and arrays)."""
    if isinstance(x, np.ndarray):
        return np.where(np.isnan(x), replacement, x)
    try:
        return replacement if x is None or _math.isnan(x) else x
    except TypeError:
        return x


# ------------------------------------------------------------------ declarations


class _Decl:
    kind = 'indicator'
    title = 'Script'
    short_title = None
    overlay = False
    precision = None
    scale = None
    options: dict = {}
    target = None


_declared: list[_Decl] = []


def indicator(title='Indicator', short_title=None, overlay=False, precision=None, scale=None):
    """Decorate the indicator's main function: `def main(data, length=input.int(14)): ...`."""

    def wrap(fn):
        d = _Decl()
        d.kind = 'indicator'
        d.title = title
        d.short_title = short_title or title
        d.overlay = overlay
        d.precision = precision
        d.scale = scale
        d.target = fn
        _declared.append(d)
        return fn

    return wrap


def strategy(title='Strategy', short_title=None, overlay=True, initial_capital=10000.0, default_qty_type='percent_of_equity', default_qty_value=100.0, pyramiding=0, commission=None, slippage_ticks=0, process_orders_on_close=False, precision=None):
    """Decorate a Strategy subclass. `commission` is a fraction per side (0.001 = 0.1 %)."""

    def wrap(cls):
        d = _Decl()
        d.kind = 'strategy'
        d.title = title
        d.short_title = short_title or title
        d.overlay = overlay
        d.precision = precision
        d.options = dict(initial_capital=initial_capital, default_qty_type=default_qty_type, default_qty_value=default_qty_value, pyramiding=pyramiding, commission=commission, slippage_ticks=slippage_ticks, process_orders_on_close=process_orders_on_close)
        d.target = cls
        _declared.append(d)
        return cls

    return wrap


# ------------------------------------------------------------------ inputs


class _Input:
    _seq = 0

    def __init__(self, type_, defval, title=None, min=None, max=None, step=None, options=None, tooltip=None, group=None):
        _Input._seq += 1
        self.order = _Input._seq
        self.type = type_
        self.defval = defval
        self.title = title
        self.min = min
        self.max = max
        self.step = step
        self.options = options
        self.tooltip = tooltip
        self.group = group

    def describe(self, key):
        return dict(key=key, type=self.type, title=self.title or key, defval=self.defval, min=self.min, max=self.max, step=self.step, options=self.options, tooltip=self.tooltip, group=self.group)

    def coerce(self, v):
        if v is None:
            return self.defval
        if self.type == 'int':
            return int(round(float(v)))
        if self.type == 'float':
            return float(v)
        if self.type == 'bool':
            return v in (True, 'true', 1, '1')
        return v


class input:  # noqa: N801 - mirrors Pine's namespace
    @staticmethod
    def int(defval, title=None, min=None, max=None, step=None, options=None, tooltip=None, group=None):
        return _Input('int', int(defval), title, min, max, step, options, tooltip, group)

    @staticmethod
    def float(defval, title=None, min=None, max=None, step=None, options=None, tooltip=None, group=None):
        return _Input('float', float(defval), title, min, max, step, options, tooltip, group)

    @staticmethod
    def bool(defval, title=None, tooltip=None, group=None):
        return _Input('bool', bool(defval), title, tooltip=tooltip, group=group)

    @staticmethod
    def string(defval, title=None, options=None, tooltip=None, group=None):
        return _Input('string', str(defval), title, options=options, tooltip=tooltip, group=group)

    @staticmethod
    def source(defval='close', title=None, tooltip=None, group=None):
        return _Input('source', defval, title, tooltip=tooltip, group=group)

    @staticmethod
    def color(defval, title=None, group=None):
        return _Input('color', defval, title, group=group)

    @staticmethod
    def timeframe(defval='', title=None, group=None):
        return _Input('timeframe', defval, title, group=group)


# ------------------------------------------------------------------ data


class _Ctx:
    """Execution context shared with the host."""

    i = -1  # current bar in strategy next(); -1 = full arrays (indicator / init)
    n = 0
    outputs: dict = {}
    data = None
    need: set = set()  # data keys requested but not loaded yet (the host loads them and re-runs)


_ctx = _Ctx()


class SeriesView:
    """A numpy-like view of a series truncated at the current bar during Strategy.next()."""

    __slots__ = ('_arr', 'name')

    def __init__(self, arr, name=''):
        self._arr = np.asarray(arr, dtype=np.float64)
        self.name = name

    def _cur(self):
        return self._arr if _ctx.i < 0 else self._arr[: _ctx.i + 1]

    def __array__(self, dtype=None, copy=None):
        a = self._cur()
        return a.astype(dtype) if dtype else a

    def __len__(self):
        return len(self._cur())

    def __getitem__(self, k):
        return self._cur()[k]

    def __iter__(self):
        return iter(self._cur())

    def __float__(self):
        return float(self._cur()[-1])

    @property
    def last(self):
        a = self._cur()
        return float(a[-1]) if len(a) else na

    @property
    def prev(self):
        a = self._cur()
        return float(a[-2]) if len(a) > 1 else na

    def __repr__(self):
        a = self._cur()
        return f'SeriesView({self.name}, n={len(a)}, last={a[-1] if len(a) else "na"})'

    # arithmetic delegates to the truncated array
    def _op(self, other, f):
        o = other._cur() if isinstance(other, SeriesView) else other
        return f(self._cur(), o)

    def __add__(self, o):
        return self._op(o, np.add)

    def __radd__(self, o):
        return self._op(o, lambda a, b: np.add(b, a))

    def __sub__(self, o):
        return self._op(o, np.subtract)

    def __rsub__(self, o):
        return self._op(o, lambda a, b: np.subtract(b, a))

    def __mul__(self, o):
        return self._op(o, np.multiply)

    def __rmul__(self, o):
        return self._op(o, np.multiply)

    def __truediv__(self, o):
        return self._op(o, np.divide)

    def __rtruediv__(self, o):
        return self._op(o, lambda a, b: np.divide(b, a))

    def __gt__(self, o):
        return self._op(o, np.greater)

    def __lt__(self, o):
        return self._op(o, np.less)

    def __ge__(self, o):
        return self._op(o, np.greater_equal)

    def __le__(self, o):
        return self._op(o, np.less_equal)

    def __neg__(self):
        return -self._cur()



# futures statistics ticker suffixes (longest first), see shared/metrics.ts
_METRIC_SUFFIXES = [('_OI_USD', 'oiusd'), ('_TOP_LSR', 'toplsr'), ('_TOP_POS', 'toppos'), ('_FUNDING', 'funding'), ('_LSR', 'lsr'), ('_OI', 'oi')]


class Bars:
    """Chart data. Arrays are float64 numpy arrays (time in ms since epoch)."""

    def __init__(self, cols: dict, meta: dict):
        self._cols = {k: np.asarray(v, dtype=np.float64) for k, v in cols.items()}
        self.symbol = meta.get('symbol')
        self.market = meta.get('market')
        self.tf = meta.get('tf')
        self.mintick = meta.get('mintick', 0.01)
        self._htf = meta.get('htf', {})
        self._book_on = bool(meta.get('book'))
        self._book_key = meta.get('book_key')
        self._book = None

    def __len__(self):
        n = len(self._cols['close'])
        return n if _ctx.i < 0 else min(n, _ctx.i + 1)

    def _get(self, k):
        a = self._cols[k]
        return a if _ctx.i < 0 else a[: _ctx.i + 1]

    def __getitem__(self, k):
        if k in ('hl2', 'hlc3', 'ohlc4', 'hlcc4'):
            return getattr(self, k)
        return self._get(k)

    open = property(lambda s: s._get('open'))
    high = property(lambda s: s._get('high'))
    low = property(lambda s: s._get('low'))
    close = property(lambda s: s._get('close'))
    volume = property(lambda s: s._get('volume'))
    time = property(lambda s: s._get('time'))
    taker_buy_volume = property(lambda s: s._get('tbv'))
    hl2 = property(lambda s: (s.high + s.low) / 2)
    hlc3 = property(lambda s: (s.high + s.low + s.close) / 3)
    ohlc4 = property(lambda s: (s.open + s.high + s.low + s.close) / 4)
    hlcc4 = property(lambda s: (s.high + s.low + 2 * s.close) / 4)

    @property
    def bar_index(self):
        return np.arange(len(self), dtype=np.float64)

    @property
    def book(self) -> 'Book':
        """The chart symbol's order book per bar (see Book)."""
        if self._book is None:
            self._book = Book(self)
        return self._book

    def security(self, symbol=None, tf=None, field='close', lookahead=False, market=None):
        """Another symbol / timeframe aligned to the chart bars.

        Without lookahead a chart bar only sees values of bars that had *closed* by the chart
        bar's close (exactly like Pine's request.security with lookahead_off on closed bars).
        `symbol` is 'BTCUSDT', 'ETHUSDT' or 'SOLUSDT' (add '.P' for the perpetual); `market`
        'spot' or 'futures'. Futures statistics take a suffix, like TradingView's open interest
        symbols: 'BTCUSDT.P_OI' (open interest, contracts), '_OI_USD' (its value), '_LSR'
        (long/short account ratio), '_TOP_LSR' / '_TOP_POS' (top traders' accounts / positions),
        '_FUNDING' (funding rate in % per funding interval, at each settlement).
        """
        sym = (symbol or self.symbol or '').upper().replace('/', '').replace('BINANCE:', '')
        metric = None
        for suffix, kind in _METRIC_SUFFIXES:
            if sym.endswith(suffix):
                sym, metric = sym[: -len(suffix)], kind
                break
        if sym.endswith('.P'):
            sym, market = sym[:-2], 'futures'
        if metric:
            market = 'futures'
        mk = market or self.market
        tfx = tf or self.tf
        key = f'{mk}:{sym}:{tfx}:{metric or "candles"}'
        n = len(self._cols['close'])
        if key not in self._htf:
            _ctx.need.add(key)
            out = np.full(n, np.nan)
            return out if _ctx.i < 0 else out[: _ctx.i + 1]
        h = self._htf[key]
        names = {'open': 'o', 'high': 'h', 'low': 'l', 'close': 'c', 'volume': 'v', 'time': 't'}
        col = names.get(field, field)
        if col in ('hl2', 'hlc3', 'ohlc4'):
            o, hh, ll, c = (np.asarray(h[k], dtype=np.float64) for k in ('o', 'h', 'l', 'c'))
            vals = (hh + ll) / 2 if col == 'hl2' else (hh + ll + c) / 3 if col == 'hlc3' else (o + hh + ll + c) / 4
        else:
            if col not in h:
                raise ValueError(f'Unknown field "{field}" (use open, high, low, close, volume, time, hl2, hlc3, ohlc4)')
            vals = np.asarray(h[col], dtype=np.float64)
        mapped = _js.map_htf(self._cols['time'], self._cols['tc'], np.asarray(h['t'], dtype=np.float64), np.asarray(h['tc'], dtype=np.float64), np.ascontiguousarray(vals), bool(lookahead)) if _js else vals
        out = _from_js(mapped) if _js else np.asarray(mapped, dtype=np.float64)
        return out if _ctx.i < 0 else out[: _ctx.i + 1]

    def htf(self, tf: str, field='close', lookahead=False):
        """Higher-timeframe series of this symbol aligned to the chart bars (no lookahead by default)."""
        return self.security(None, tf, field, lookahead)


# ------------------------------------------------------------------ order book


class BookFrame:
    """One order-book snapshot: `bids` and `asks` are (n, 2) arrays of [price, qty], best first."""

    __slots__ = ('time', 'bids', 'asks')

    def __init__(self, time, bids, asks):
        self.time = time
        self.bids = bids
        self.asks = asks

    @property
    def best_bid(self):
        return float(self.bids[0, 0]) if len(self.bids) else na

    @property
    def best_ask(self):
        return float(self.asks[0, 0]) if len(self.asks) else na

    @property
    def mid(self):
        b, a = self.best_bid, self.best_ask
        return (b + a) / 2 if not (_math.isnan(b) or _math.isnan(a)) else (a if _math.isnan(b) else b)

    @property
    def spread(self):
        return self.best_ask - self.best_bid

    def _side(self, side):
        return self.asks if side == 'ask' else self.bids

    def depth(self, side='bid', pct=None, notional=False):
        """Resting quantity on one side within `pct` % of the mid (all levels without pct)."""
        lv = self._side(side)
        if pct is not None and pct > 0 and len(lv):
            m = self.mid
            lv = lv[lv[:, 0] >= m * (1 - pct / 100)] if side == 'bid' else lv[lv[:, 0] <= m * (1 + pct / 100)]
        return float((lv[:, 0] * lv[:, 1]).sum() if notional else lv[:, 1].sum())

    def imbalance(self, levels=10):
        """(bid qty - ask qty) / (bid qty + ask qty) over the best `levels` levels a side: -1 ... +1."""
        b = self.bids[:levels, 1].sum() if levels else self.bids[:, 1].sum()
        a = self.asks[:levels, 1].sum() if levels else self.asks[:, 1].sum()
        return float((b - a) / (b + a)) if b + a > 0 else na

    def wall(self, side='bid', pct=None):
        """The largest level on one side within `pct` % of the mid: (price, qty)."""
        lv = self._side(side)
        if pct is not None and pct > 0 and len(lv):
            m = self.mid
            lv = lv[lv[:, 0] >= m * (1 - pct / 100)] if side == 'bid' else lv[lv[:, 0] <= m * (1 + pct / 100)]
        if not len(lv):
            return na, na
        k = int(np.argmax(lv[:, 1]))
        return float(lv[k, 0]), float(lv[k, 1])

    def __repr__(self):
        return f'BookFrame(time={self.time:.0f}, bids={len(self.bids)}, asks={len(self.asks)}, best={self.best_bid}/{self.best_ask})'


class Book:
    """The chart symbol's order book per bar.

    Every bar carries the last snapshot taken while it formed: recorded history (Settings ->
    Data -> Order-book recording, once a minute) and the live book on the forming bar. Bars
    without one are na. Binance publishes price levels, not individual orders: a snapshot is
    every level of both sides (up to 5000 a side on spot, 1000 on futures, plus levels the diff
    stream added since).

    `data.book[-1]` is the current bar's BookFrame (None without a book); the series methods
    return one value per bar and, inside Strategy.next(), end at the current bar.
    """

    def __init__(self, bars: 'Bars'):
        self._bars = bars
        self._cache = {}

    def _n(self):
        return len(self._bars._cols['close'])

    def _cut(self, a):
        return a if _ctx.i < 0 else a[: _ctx.i + 1]

    def _series(self, kind, *params):
        key = (kind,) + params
        a = self._cache.get(key)
        if a is None:
            if not self._bars._book_on:
                _ctx.need.add(self._bars._book_key)
                a = np.full(self._n(), np.nan)
            else:
                a = _from_js(_js.book_series(kind, [na if p is None else float(p) for p in params]))
            self._cache[key] = a
        return self._cut(a)

    def __len__(self):
        return len(self._bars)

    def __getitem__(self, k) -> 'BookFrame | None':
        cur = self._n() - 1 if _ctx.i < 0 else _ctx.i
        i = cur + 1 + k if k < 0 else k
        if i < 0 or i > cur:
            raise IndexError(f'book index {k} out of range (bars 0 ... {cur})')
        if not self._bars._book_on:
            _ctx.need.add(self._bars._book_key)
            return None
        r = _js.book_frame(int(i))
        if r is None:
            return None
        t, bp, bq, ap, aq = _from_js(r)
        return BookFrame(float(t[0]), np.column_stack((bp, bq)), np.column_stack((ap, aq)))

    @property
    def available(self):
        """True on bars that have a book."""
        return self._series('available') == 1

    time = property(lambda s: s._series('time'))
    best_bid = property(lambda s: s._series('best_bid'))
    best_ask = property(lambda s: s._series('best_ask'))
    mid = property(lambda s: s._series('mid'))
    spread = property(lambda s: s._series('spread'))

    @staticmethod
    def _sd(side):
        if side not in ('bid', 'ask'):
            raise ValueError('side must be "bid" or "ask"')
        return 1 if side == 'ask' else 0

    def levels(self, side='bid'):
        """Number of price levels on one side."""
        return self._series('levels', self._sd(side))

    def price(self, side='bid', level=0):
        """Price of a level (0 = best)."""
        return self._series('price', self._sd(side), level)

    def qty(self, side='bid', level=0):
        """Quantity resting at a level (0 = best)."""
        return self._series('qty', self._sd(side), level)

    def depth(self, side='bid', pct=None):
        """Resting quantity (base asset) on one side within `pct` % of the mid (all levels without pct)."""
        return self._series('depth', self._sd(side), pct)

    def notional(self, side='bid', pct=None):
        """Like depth(), in the quote currency (price x qty)."""
        return self._series('notional', self._sd(side), pct)

    def imbalance(self, levels=10):
        """(bid qty - ask qty) / (bid qty + ask qty) over the best `levels` levels a side: -1 ... +1."""
        return self._series('imbalance', levels)

    def depth_imbalance(self, pct=1.0):
        """Imbalance of the quantity within `pct` % of the mid."""
        return self._series('depth_imbalance', pct)

    def wall(self, side='bid', pct=None):
        """The largest level on one side within `pct` % of the mid: (prices, qtys) per bar."""
        return self._series('wall_price', self._sd(side), pct), self._series('wall_qty', self._sd(side), pct)

    def qty_at(self, price):
        """Quantity resting at exactly `price` (0 where no level)."""
        return self._series('qty_at', price)

    def fill_price(self, qty):
        """Average fill price of a market order walked through the book: qty > 0 buys, < 0 sells."""
        return self._series('fill_price', qty)


# ------------------------------------------------------------------ technical analysis (shared JS implementations)


def _arr(x, n=None):
    if isinstance(x, SeriesView):
        x = x._arr
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 0:
        a = np.full(n or (len(_ctx.data) if _ctx.data is not None else 1), float(a))
    return a


def _from_js(x):
    """Convert a JS Float64Array (or array of them) into numpy arrays (memcpy, no per-element work)."""
    if hasattr(x, 'to_py'):
        x = x.to_py()
    if isinstance(x, (list, tuple)):
        return tuple(_from_js(v) for v in x)
    if isinstance(x, memoryview):
        return np.frombuffer(x, dtype=np.float64).copy()
    return np.asarray(x, dtype=np.float64)


def _call(name, arrays, params=()):
    if _js is None:
        raise RuntimeError('fufu.ta is only available inside FuFu Trading')
    n = len(arrays[0]) if arrays else len(_ctx.data._cols['close'])
    full = _ctx.i
    _ctx.i = -1  # indicators are always computed over the full arrays (init)
    try:
        ins = [np.ascontiguousarray(_arr(a, n), dtype=np.float64) for a in arrays]
    finally:
        _ctx.i = full
    return _from_js(_js.vec_ta(name, ins, list(params)))


class ta:  # noqa: N801
    """Indicators computed by the same engine as Pine's ta.* (identical results)."""

    sma = staticmethod(lambda src, length: _call('sma', [src], [length]))
    ema = staticmethod(lambda src, length: _call('ema', [src], [length]))
    rma = staticmethod(lambda src, length: _call('rma', [src], [length]))
    wma = staticmethod(lambda src, length: _call('wma', [src], [length]))
    hma = staticmethod(lambda src, length: _call('hma', [src], [length]))
    vwma = staticmethod(lambda src, length: _call('vwma', [src], [length]))
    alma = staticmethod(lambda src, length, offset=0.85, sigma=6.0: _call('alma', [src], [length, offset, sigma]))
    linreg = staticmethod(lambda src, length, offset=0: _call('linreg', [src], [length, offset]))
    stdev = staticmethod(lambda src, length, biased=True: _call('stdev', [src], [length, biased]))
    variance = staticmethod(lambda src, length, biased=True: _call('variance', [src], [length, biased]))
    highest = staticmethod(lambda src, length: _call('highest', [src], [length]))
    lowest = staticmethod(lambda src, length: _call('lowest', [src], [length]))
    change = staticmethod(lambda src, length=1: _call('change', [src], [length]))
    roc = staticmethod(lambda src, length: _call('roc', [src], [length]))
    mom = staticmethod(lambda src, length: _call('change', [src], [length]))
    rsi = staticmethod(lambda src, length: _call('rsi', [src], [length]))
    cci = staticmethod(lambda src, length: _call('cci', [src], [length]))
    cmo = staticmethod(lambda src, length: _call('cmo', [src], [length]))
    mfi = staticmethod(lambda src, length: _call('mfi', [src], [length]))
    tsi = staticmethod(lambda src, short_length, long_length: _call('tsi', [src], [short_length, long_length]))
    median = staticmethod(lambda src, length: _call('median', [src], [length]))
    percentrank = staticmethod(lambda src, length: _call('percentrank', [src], [length]))
    correlation = staticmethod(lambda a, b, length: _call('correlation', [a, b], [length]))
    cum = staticmethod(lambda src: _call('cum', [src]))
    atr = staticmethod(lambda length: _call('atr', [], [length]))
    tr = staticmethod(lambda handle_na=True: _call('tr', [], [handle_na]))
    wpr = staticmethod(lambda length: _call('wpr', [], [length]))
    sar = staticmethod(lambda start=0.02, inc=0.02, maximum=0.2: _call('sar', [], [start, inc, maximum]))
    vwap = staticmethod(lambda src=None: _call('vwap', [src if src is not None else _ctx.data.hlc3], []))
    macd = staticmethod(lambda src, fast=12, slow=26, signal=9: _call('macd', [src], [fast, slow, signal]))
    bb = staticmethod(lambda src, length=20, mult=2.0: _call('bb', [src], [length, mult]))
    kc = staticmethod(lambda src, length=20, mult=1.5: _call('kc', [src], [length, mult]))
    supertrend = staticmethod(lambda factor=3.0, atr_period=10: _call('supertrend', [], [factor, atr_period]))
    dmi = staticmethod(lambda di_length=14, adx_smoothing=14: _call('dmi', [], [di_length, adx_smoothing]))
    stoch = staticmethod(lambda src, high, low, length: _call('stoch', [src, high, low], [length]))
    pivothigh = staticmethod(lambda src, left, right: _call('pivothigh', [src], [left, right]))
    pivotlow = staticmethod(lambda src, left, right: _call('pivotlow', [src], [left, right]))
    barssince = staticmethod(lambda cond: _call('barssince', [np.asarray(cond, dtype=np.float64)]))
    valuewhen = staticmethod(lambda cond, src, occurrence=0: _call('valuewhen', [np.asarray(cond, dtype=np.float64), src], [occurrence]))

    @staticmethod
    def crossover(a, b):
        a = _arr(a)
        b = _arr(b, len(a))
        out = np.zeros(len(a), dtype=bool)
        out[1:] = (a[1:] > b[1:]) & (a[:-1] <= b[:-1])
        return out

    @staticmethod
    def crossunder(a, b):
        a = _arr(a)
        b = _arr(b, len(a))
        out = np.zeros(len(a), dtype=bool)
        out[1:] = (a[1:] < b[1:]) & (a[:-1] >= b[:-1])
        return out

    @staticmethod
    def obv():
        return _call('obv', [])


def _last2(x):
    a = np.asarray(x._cur() if isinstance(x, SeriesView) else x, dtype=np.float64)
    if a.ndim == 0:
        return float(a), float(a)
    if len(a) < 2:
        return na, na
    return float(a[-2]), float(a[-1])


def crossover(a, b) -> bool:
    """True if `a` crossed above `b` on the current bar (for use in Strategy.next)."""
    a0, a1 = _last2(a)
    b0, b1 = _last2(b)
    return a1 > b1 and a0 <= b0


def crossunder(a, b) -> bool:
    a0, a1 = _last2(a)
    b0, b1 = _last2(b)
    return a1 < b1 and a0 >= b0


def cross(a, b) -> bool:
    return crossover(a, b) or crossunder(a, b)


# ------------------------------------------------------------------ outputs


class color:  # noqa: N801
    red = '#F23645'
    green = '#089981'
    blue = '#2196F3'
    orange = '#FF9800'
    purple = '#9C27B0'
    teal = '#089981'
    yellow = '#FFEB3B'
    gray = '#787B86'
    white = '#FFFFFF'
    black = '#363A45'
    aqua = '#00BCD4'
    lime = '#00E676'
    fuchsia = '#E040FB'

    @staticmethod
    def new(c, transp=0):
        a = max(0, min(100, transp))
        return c[:7] + format(int(round((1 - a / 100) * 255)), '02x')

    @staticmethod
    def rgb(r, g, b, transp=0):
        return '#%02x%02x%02x%02x' % (int(r), int(g), int(b), int(round((1 - transp / 100) * 255)))


def _out():
    return _ctx.outputs


def _series(x):
    n = _ctx.n
    if isinstance(x, SeriesView):
        x = x._arr
    a = np.asarray(x)
    if a.ndim == 0:
        a = np.full(n, float(a) if a.dtype != bool else float(bool(a)))
    a = a.astype(np.float64)
    if len(a) < n:
        a = np.concatenate([np.full(n - len(a), np.nan), a])
    return a[:n]


def _colors(c):
    if c is None or isinstance(c, str):
        return c, None
    arr = list(c)
    return None, [x if isinstance(x, str) else None for x in arr]


def plot(series, title=None, color=None, width=1, style='line', offset=0, display=True, histbase=0.0):
    """Plot a series. `color` may be a single color or a per-bar list. Returns a handle for fill()."""
    o = _out()
    idx = len(o.setdefault('plots', []))
    c, cs = _colors(color)
    o['plots'].append(dict(id=f'plot{idx}', title=title or f'Plot {idx + 1}', kind='plot', style=style, color=c or '#2196F3', colors=cs, values=_series(series), width=width, offset=offset, display=display, histbase=histbase))
    return f'plot{idx}'


def plotshape(condition, title=None, style='triangleup', location='belowbar', color=None, text=None, size='small', offset=0):
    o = _out()
    idx = len(o.setdefault('plots', []))
    c, cs = _colors(color)
    vals = _series(np.asarray(condition, dtype=np.float64) if not isinstance(condition, SeriesView) else condition)
    o['plots'].append(dict(id=f'plot{idx}', title=title or f'Shape {idx + 1}', kind='shape', style=style, location=location, color=c or '#2196F3', colors=cs, values=vals, text=text, size=size, offset=offset, width=1, display=True, histbase=0.0))
    return f'plot{idx}'


def plotchar(condition, title=None, char='•', location='abovebar', color=None, size='small'):
    return plotshape(condition, title, 'char', location, color, None, size) if char is None else _plotchar(condition, title, char, location, color, size)


def _plotchar(condition, title, char, location, color, size):
    h = plotshape(condition, title, 'char', location, color, None, size)
    _out()['plots'][-1]['char'] = char
    return h


def hline(price, title=None, color='#787B86', style='dashed', width=1):
    o = _out()
    idx = len(o.setdefault('hlines', []))
    o['hlines'].append(dict(id=f'hline{idx}', title=title or f'Line {idx + 1}', price=float(price), color=color, style=style, width=width, display=True))
    return f'hline{idx}'


def fill(a, b, color='#2196F333'):
    c, cs = _colors(color)
    _out().setdefault('fills', []).append(dict(a=a, b=b, color=c or '#2196F333', colors=cs))


def bgcolor(color, where=None):
    n = _ctx.n
    c, cs = _colors(color)
    arr = cs if cs is not None else [c] * n
    if where is not None:
        w = np.asarray(where, dtype=bool)
        arr = [arr[k] if k < len(w) and w[k] else None for k in range(n)]
    _out()['bgcolors'] = arr[:n]


def barcolor(color, where=None):
    n = _ctx.n
    c, cs = _colors(color)
    arr = cs if cs is not None else [c] * n
    if where is not None:
        w = np.asarray(where, dtype=bool)
        arr = [arr[k] if k < len(w) and w[k] else None for k in range(n)]
    _out()['barcolors'] = arr[:n]


def alertcondition(condition, title='Alert', message=''):
    _out().setdefault('alerts', []).append(dict(title=title, message=message, values=_series(np.asarray(condition, dtype=np.float64))))


class log:  # noqa: N801
    @staticmethod
    def _add(level, msg):
        o = _out()
        bar = _ctx.i if _ctx.i >= 0 else max(0, _ctx.n - 1)
        o.setdefault('logs', []).append(dict(bar=bar, level=level, msg=str(msg)))

    info = staticmethod(lambda msg: log._add('info', msg))
    warning = staticmethod(lambda msg: log._add('warning', msg))
    error = staticmethod(lambda msg: log._add('error', msg))


# ------------------------------------------------------------------ strategies


class Position:
    __slots__ = ('size', 'avg_price', 'open_profit')

    def __init__(self, size=0.0, avg_price=na, open_profit=0.0):
        self.size = size
        self.avg_price = avg_price
        self.open_profit = open_profit

    @property
    def is_long(self):
        return self.size > 0

    @property
    def is_short(self):
        return self.size < 0

    def __bool__(self):
        return self.size != 0

    def __repr__(self):
        return f'Position(size={self.size}, avg_price={self.avg_price})'


class Strategy:
    """Base class for strategies. Override init() and next()."""

    def __init__(self, data: Bars, params: dict, broker):
        self.data = data
        self._broker = broker
        self._indicators = []
        self.params = params
        for k, v in params.items():
            setattr(self, k, v)
        self._state = None

    # ---- lifecycle (override)
    def init(self):
        pass

    def next(self):
        pass

    # ---- indicators
    def I(self, values, title=None, plot=True, color=None, overlay=None):  # noqa: E743 N802
        """Register a precomputed series; returns a view that is truncated at the current bar in next()."""
        arr = np.asarray(values._arr if isinstance(values, SeriesView) else values, dtype=np.float64)
        v = SeriesView(arr, title or f'I{len(self._indicators)}')
        self._indicators.append((v, title, plot, color))
        return v

    # ---- state
    def _st(self):
        if self._state is None:
            s = self._broker.state()
            self._state = s.to_py() if hasattr(s, 'to_py') else s
        return self._state

    @property
    def bar(self) -> int:
        return _ctx.i

    @property
    def time(self) -> float:
        return float(self.data._cols['time'][_ctx.i])

    @property
    def position(self) -> Position:
        s = self._st()
        return Position(s['position_size'], s['position_avg_price'], s['open_profit'])

    @property
    def equity(self) -> float:
        return self._st()['equity']

    @property
    def net_profit(self) -> float:
        return self._st()['net_profit']

    @property
    def closed_trades(self) -> int:
        return int(self._st()['closed_trades'])

    # ---- orders (same semantics as Pine strategy.*)
    def entry(self, id, direction, qty=None, limit=None, stop=None, comment=None, sl=None, tp=None):
        """Enter a position (reverses an opposite position). sl/tp attach a bracket at absolute prices."""
        self._state = None
        self._broker.submit(dict(kind='entry', id=str(id), dir=int(direction), qty=qty, limit=limit, stop=stop, comment=comment))
        if sl is not None or tp is not None:
            self._broker.submit(dict(kind='exit', id=f'__bracket_{id}', fromEntry=str(id), stop=sl, limit=tp, dir=1))

    def buy(self, qty=None, limit=None, stop=None, sl=None, tp=None, id='Long', comment=None):
        self.entry(id, long, qty, limit, stop, comment, sl, tp)

    def sell(self, qty=None, limit=None, stop=None, sl=None, tp=None, id='Short', comment=None):
        self.entry(id, short, qty, limit, stop, comment, sl, tp)

    def order(self, id, direction, qty=None, limit=None, stop=None, comment=None):
        self._state = None
        self._broker.submit(dict(kind='order', id=str(id), dir=int(direction), qty=qty, limit=limit, stop=stop, comment=comment))

    def exit(self, id, from_entry=None, qty=None, qty_percent=None, profit=None, loss=None, limit=None, stop=None, trail_points=None, trail_offset=None, comment=None):
        """Bracket exit: profit/loss/trail in ticks, limit/stop as prices."""
        self._broker.submit(dict(kind='exit', id=f'__exit_{id}', fromEntry=from_entry, qty=qty, qtyPercent=qty_percent, profitTicks=profit, lossTicks=loss, limit=limit, stop=stop, trailPoints=trail_points, trailOffset=trail_offset, comment=comment, dir=1))

    def close(self, id=None, qty=None, qty_percent=None, comment=None, immediately=False):
        """Close the position from entry `id` (or everything) at market."""
        self._state = None
        self._broker.submit(dict(kind='close', id=f'__close_{id}' if id else '__close_all', fromEntry=id, qty=qty, qtyPercent=qty_percent, comment=comment, immediately=immediately, dir=1))

    def close_all(self, comment=None):
        self.close(None, comment=comment)

    def cancel(self, id):
        self._broker.cancel(str(id))

    def cancel_all(self):
        self._broker.cancel_all()

    def log(self, *args):
        log.info(' '.join(str(a) for a in args))
