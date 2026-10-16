# Pine Script in FuFu Trading

FuFu runs Pine Script (versions 4, 5 and 6) with its own compiler and runtime. Scripts run on
Binance data for BTC, ETH and SOL (spot and USDⓈ-M perpetuals). The goal is TradingView-identical
results for the supported subset. Anything the engine can't reproduce faithfully is a compile
error with a clear reason. It is never silently ignored.

The complete, always up-to-date list of supported built-in functions and variables comes from
the engine. Open it in the app (Script Editor → Help → Pine reference) or ask the AI assistant.

## Language

Supported:

- `//@version=3|4|5|6`; `indicator()` / `study()`, `strategy()`.
- Older scripts run unchanged:
  - **v4:** built-ins without namespaces (`sma`, `rsi`, `atr`, `max`, `security`, `tostring` …),
    `iff()`, `offset()`, `study(resolution=…)` and `input(type=input.integer …)`.
  - **v4 plots:** `transp` on plots, shapes, fills and backgrounds.
  - **v4 strategies:** `when` conditions on strategy calls (also accepted in v5).
  - **v4 variables:** `tr`, `obv`, `vwap` and the other bare variables.
  - **v3:** bare colours (`lime`), plot styles (`style=histogram`), input types
    (`type=integer`), and `tickerid`, `period`, `interval`, `n`.
- Types `int float bool string color`, `na`, series/simple/const qualifiers (type annotations are
  accepted; values are checked at runtime).
- Variables: `=`, `:=`, compound assignment, `var`, `varip`, tuples `[a, b] = f()`.
- Control flow: `if / else if / else`, `switch` (with and without subject), `for i = a to b by s`,
  `for x in array`, `for [i, x] in array`, `while`, `break`, `continue`, ternary `?:`.
- Functions: single-line `=>` and block functions, default parameters, named arguments.
- User-defined types (`type`), methods (`method`), enums (`enum`), `export` (ignored outside libraries).
- History referencing `x[n]` on any series expression, including function results.
- Version semantics: v6 evaluates `and` / `or` lazily, earlier versions evaluate both sides.
- Collections: `array.*`, `map.*` and `matrix.*`. Matrices cover products, powers,
  determinant, inverse, pseudo-inverse, rank, eigenvalues and eigenvectors, and Kronecker
  products. `for row in m` iterates over the rows.
- Drawings: `label.*`, `line.*`, `box.*`, `table.*` (all setters and getters, as functions or
  methods), `linefill.*`, `polyline.*` and `chart.point.*` (including the point forms of
  `line.new`, `label.new` and `box.new`), with `max_labels_count` etc.
- Output: `plot`, `plotshape`, `plotchar`, `plotarrow`, `plotcandle`, `plotbar`, `hline`, `fill`,
  `bgcolor`, `barcolor`, `alertcondition`, `alert()`, `log.info/warning/error`.
- `request.security()` and `request.security_lower_tf()` for BTC/ETH/SOL on any timeframe and
  market (`"BINANCE:ETHUSDT"`, `"ETHUSDT.P"` for the perpetual), with `lookahead` and `gaps`.
- Futures statistics of the perpetuals, through TradingView's open interest tickers. See
  [Open interest and long/short ratios](#open-interest-and-longshort-ratios) below.
- Inputs: all `input.*` kinds, `group`, `inline`, `tooltip`, `options`, `minval/maxval/step`.

Not supported (compile error with the reason):

- `import` of TradingView libraries (the library repository is not available). Paste the
  functions into your script instead.
- `request.financial/economic/quandl/dividends/splits/earnings/seed/currency_rate`.
- `request.footprint`: use the native footprint chart mode.
- Other symbols than BTC, ETH and SOL.

Accepted but different:

- `strategy.risk.*` rules are ignored, with a warning.
- The `timeframe` parameter of `indicator()` is ignored, with a warning. Use `request.security`.
- `syminfo.*` describe Binance instruments (`syminfo.mintick` is the exchange tick size).
  `syminfo.ticker` is `BTCUSDT` on spot and `BTCUSDT.P` on the perpetual, like TradingView.

## Open interest and long/short ratios

Binance's futures statistics of the perpetuals work as symbols with a suffix, like
TradingView's open interest tickers:

| Ticker | Value |
| --- | --- |
| `BINANCE:BTCUSDT.P_OI` | open interest in contracts (BTC) |
| `BINANCE:BTCUSDT.P_OI_USD` | open interest value in USDT |
| `BINANCE:BTCUSDT.P_LSR` | long/short account ratio, all accounts |
| `BINANCE:BTCUSDT.P_TOP_LSR` | long/short account ratio, top traders |
| `BINANCE:BTCUSDT.P_TOP_POS` | long/short position ratio, top traders |

```pine
oi = request.security(syminfo.prefix + ":" + syminfo.ticker + "_OI", timeframe.period, close)
[o, h, l, c] = request.security("BINANCE:ETHUSDT.P_OI", "240", [open, high, low, close])
```

- The suffix always means the perpetual, also on a spot chart (`BTCUSDT_OI` works too).
- Binance measures these values every 5 minutes, since September 2020. Bars of any timeframe
  are built from the samples: open = the previous bar's close, close = the last sample,
  high/low = the extremes of the samples. Volume is 0. Below 5 minutes, use `"5"` as the
  timeframe (or plot the value as a line).
- No lookahead: Binance publishes a sample 2–3 minutes after measuring it, so every sample
  counts from the next 5-minute mark. A value measured at 12:00 closes the bar that ends at
  12:05. Backtests, replays and live bots see the same values at the same times.
- History comes from Binance's API for the last 30 days and from its daily archives before
  that. Both are cached. The first load of years of history takes a while, so charts show the
  last two months first and add the rest in the background.
- Built-in scripts: **Open Interest** (candles, like TradingView's), **Open Interest Delta**
  (the change per bar, colored by new longs, new shorts, short covering and long closing),
  **Long/Short Ratio** and the **OI Breakout Strategy**.

## Strategies

`strategy.entry`, `strategy.order`, `strategy.exit` (profit/loss/trail in ticks, limit/stop
prices, `qty_percent`, `from_entry`, OCA), `strategy.close`, `strategy.close_all`,
`strategy.cancel`, `strategy.cancel_all` and all `strategy.*` state variables follow
TradingView's broker emulator:

- Orders created on a bar fill from the next bar's open, or at the bar close with
  `process_orders_on_close=true`.
- `entry` reverses an opposite position and respects `pyramiding`.
- Intrabar fills follow the bar path open → nearer extreme → other extreme → close, unless
  trade-level data is available for the bar.
- The Strategy Tester can override the declared capital, commission and slippage with real
  Binance costs, leverage, funding (futures) and margin rules.

## Lookahead and repainting

The compiler warns (it doesn't block) about:

- **Lookahead**: `request.security(..., lookahead=barmerge.lookahead_on)` on expressions that
  aren't offset by `[1]` or more (they read the higher-timeframe bar before it closed), and
  negative plot offsets (values drawn on bars before they were known).
- **Repainting**: `request.security` values on the realtime bar, `varip`, `timenow`,
  `barstate.isrealtime` and `barstate.isnew`. These behave differently live than on historical
  bars, so backtests can't reproduce them.

History references with negative offsets (`close[-1]`) are rejected outright. Warnings show in the
editor gutter, the indicator legend and the Strategy Tester's assumptions.

## Data available to scripts

`open high low close volume time time_close` plus derived sources. On Binance, kline volume
contains taker-buy volume, which the native footprint and the Python API expose; Pine's
built-in variables don't include it. Order-book data is not available to scripts. Use
order-book alerts and the order-book modules instead.
