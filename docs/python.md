# Python scripting API (`fufu`)

Python scripts run in an embedded CPython (Pyodide, Python 3.14 with NumPy). They run in a
sandboxed worker without network or file access. Every script starts with `from fufu import *`,
which brings in `indicator`, `strategy`, `Strategy`, `input`, `ta`, `plot`, `np` and the rest.
`fufu.ta` uses the same implementations as Pine's `ta.*`, so an indicator gives identical numbers
in both languages.

## Indicators

An indicator is a function decorated with `@indicator`. It receives the chart data and its
inputs, computes **vectorised** NumPy arrays and calls `plot()` and the other output functions.

```python
from fufu import *

@indicator("RSI with bands", overlay=False, precision=2)
def main(data, length=input.int(14, "Length", min=1), src=input.source("close")):
    r = ta.rsi(src, length)
    plot(r, "RSI", color=color.purple)
    hline(70, "Overbought")
    hline(30, "Oversold")
    alertcondition(ta.crossover(r, 70), "RSI above 70", "RSI crossed above 70")
```

`indicator(title, short_title=None, overlay=False, precision=None, scale=None)`.

In an indicator, `data` arrays cover all bars. A value at index `i` must only depend on bars
`<= i`. Don't use centred windows or shift values backwards; the editor warns about
`np.roll(x, -k)`, `.shift(-k)` and similar future references.

## Strategies

A strategy subclasses `Strategy`, decorated with `@strategy(...)`. `init()` runs once and
precomputes indicators (vectorised). `next()` runs on every bar close and places orders.
Inside `next()`, all data arrays and every series registered with `self.I()` are **truncated at
the current bar**: `[-1]` is the current bar, `[-2]` the previous one. They can't read the
future.

```python
from fufu import *

@strategy("SMA cross", initial_capital=10000, default_qty_type="percent_of_equity",
          default_qty_value=100, commission=0.001)
class SmaCross(Strategy):
    fast = input.int(10, "Fast", min=1)
    slow = input.int(30, "Slow", min=2)

    def init(self):
        c = self.data.close
        self.f = self.I(ta.sma(c, self.fast), "Fast", color=color.teal)
        self.s = self.I(ta.sma(c, self.slow), "Slow", color=color.orange)

    def next(self):
        if crossover(self.f, self.s):
            self.entry("Long", long, sl=self.data.close[-1] * 0.97)
        elif crossunder(self.f, self.s):
            self.close("Long")
```

`strategy(title, overlay=True, initial_capital=10000, default_qty_type='percent_of_equity'
| 'fixed' | 'cash', default_qty_value=100, pyramiding=0, commission=None (fraction per side),
slippage_ticks=0, process_orders_on_close=False)`.

Inputs are class attributes (`fast = input.int(...)`) and read as `self.fast`.

### Orders (same semantics as Pine `strategy.*`)

| Method | Meaning |
|---|---|
| `entry(id, long\|short, qty=None, limit=None, stop=None, comment=None, sl=None, tp=None)` | Open a position; reverses an opposite one. `sl`/`tp` attach a bracket at absolute prices. |
| `buy(...)`, `sell(...)` | Shortcuts for `entry("Long", long, ...)` / `entry("Short", short, ...)`. |
| `order(id, direction, qty, limit, stop)` | Plain order (no reversal logic). |
| `exit(id, from_entry=None, qty=None, qty_percent=None, profit=None, loss=None, limit=None, stop=None, trail_points=None, trail_offset=None)` | Bracket exit. `profit`/`loss`/`trail_*` are in **ticks**; `limit`/`stop` are prices. |
| `close(id=None, qty=None, qty_percent=None, immediately=False)` | Close the position (of entry `id`, or all) at market. |
| `close_all()`, `cancel(id)`, `cancel_all()` | As in Pine. |
| `log(*args)` | Message in the script log. |

Orders created in `next()` fill from the next bar's open. Limit and stop orders fill along the
bar path. With `process_orders_on_close=True`, market orders fill at the bar close.

### State

`self.position` (`.size` signed, `.avg_price`, `.open_profit`, `.is_long`, `.is_short`),
`self.equity`, `self.net_profit`, `self.closed_trades`, `self.bar` (index), `self.time` (ms),
`self.params` (dict of inputs).

### Indicators inside strategies

`self.I(values, title=None, plot=True, color=None, overlay=None)` registers a precomputed array
and returns a `SeriesView`. Use `.last`, `.prev`, `[-1]`, `[-2]` or NumPy operations on it.
Registered series are plotted on the chart unless `plot=False`.

## Data (`data` / `self.data`)

`open high low close volume time` (ms), `taker_buy_volume`, `hl2 hlc3 ohlc4 hlcc4`,
`bar_index`, `symbol`, `market`, `tf`, `mintick`; `len(data)`.

- `data.htf(tf, field='close', lookahead=False)` gives the same symbol on another timeframe,
  aligned to the chart bars. Without lookahead a chart bar only sees higher-timeframe bars that
  had closed by then.
- `data.security(symbol=None, tf=None, field='close', lookahead=False, market=None)`: another
  symbol (`'ETHUSDT'`, `'SOLUSDT'`, `'BTCUSDT.P'` for the perpetual) and/or timeframe.
  Futures statistics take TradingView's suffixes: `'BTCUSDT.P_OI'` (open interest, contracts),
  `'_OI_USD'` (its value in USDT), `'_LSR'` (long/short account ratio), `'_TOP_LSR'` and
  `'_TOP_POS'` (top traders' accounts and positions). They are 5-minute samples since
  September 2020, and each one counts from the next 5-minute mark (no lookahead).
  `'_FUNDING'` gives the funding rate in % per funding interval at each settlement. See the
  Pine guide for details. Example: `oi = data.security('BTCUSDT.P_OI', '1h')`.

## Inputs

`input.int(defval, title, min, max, step, options, tooltip, group)`, `input.float(...)`,
`input.bool(defval, title)`, `input.string(defval, title, options)`,
`input.source('close'|'open'|'high'|'low'|'hl2'|'hlc3'|'ohlc4'|'volume', title)` (passed as the array),
`input.color(defval, title)`, `input.timeframe(defval, title)`.

## Outputs

`plot(series, title, color, width=1, style='line'|'stepline'|'histogram'|'columns'|'circles'|'cross'|'area', offset=0, display=True, histbase=0)`.
Returns a handle for `fill()`. `color` may be one color or a per-bar list.

`plotshape(condition, title, style='triangleup'|'triangledown'|'circle'|'cross'|'xcross'|'diamond'|'square'|'flag'|'arrowup'|'arrowdown'|'labelup'|'labeldown', location='belowbar'|'abovebar'|'top'|'bottom'|'absolute', color, text, size)`,
`plotchar(condition, title, char, location, color, size)`, `hline(price, title, color, style, width)`,
`fill(a, b, color)`, `bgcolor(color, where=None)`, `barcolor(color, where=None)`,
`alertcondition(condition, title, message)`, `log.info/warning/error(msg)`.

Colors: `color.red`, `color.green`, `color.blue`, `color.orange`, `color.purple`, `color.teal`,
`color.gray`, `color.white`, `color.black`, `color.yellow`, ...; `color.new(c, transp)`,
`color.rgb(r, g, b, transp)`, or any CSS color string.

## Technical analysis (`ta`)

All return NumPy float arrays over the full data (NaN during warm-up):

`sma ema rma wma hma vwma alma(src, length, offset=0.85, sigma=6) linreg stdev variance
highest lowest change roc mom rsi cci cmo mfi tsi(src, short, long) median percentrank
correlation(a, b, length) cum atr(length) tr wpr(length) sar(start, inc, max) vwap(src=hlc3)
macd(src, fast=12, slow=26, signal=9) -> (macd, signal, hist) bb(src, length=20, mult=2) ->
(mid, upper, lower) kc(src, length=20, mult=1.5) supertrend(factor=3, atr_period=10) ->
(line, direction) dmi(di_length=14, adx_smoothing=14) -> (plus, minus, adx) stoch(src, high,
low, length) pivothigh/pivotlow(src, left, right) barssince(cond) valuewhen(cond, src,
occurrence=0) crossover(a, b) crossunder(a, b) obv()`.

Helpers: `crossover(a, b)`, `crossunder(a, b)` and `cross(a, b)` return a bool for the current
bar inside `next()`. `na`, `nz(x, replacement=0)`, `np` (NumPy).

## Debugging

The Script Editor runs Python strategies under a debugger: breakpoints, step into/over/out,
local variables, and the chart bar being processed.
