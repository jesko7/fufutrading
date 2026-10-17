# Backtesting and optimization

Strategies written in Pine Script or Python run on the same engine in the Strategy Tester, in
optimizer trials, on charts, in bots and in the replay. All of them share one broker emulator and
one accounting ledger.

## Data

- Binance klines for BTC, ETH and SOL, spot and USDⓈ-M perpetuals, from the local cache. Missing
  ranges are downloaded on demand from the REST API and the public data archive.
- There is no bar limit. Long tests aggregate the largest native interval that fits (e.g. 1h
  klines for a 4h chart). The report states the source and how bars were built.
- Warm-up: bars before the test start only feed indicators (default 500, adjustable). Orders
  are ignored until the test range begins.
- Futures: historical funding rates are applied at their real times. Liquidations are checked
  against Binance mark-price klines.
- Other data a script requests (other coins and timeframes with `request.security`, open
  interest, long/short ratios and funding through `BINANCE:BTCUSDT.P_OI` and similar tickers)
  is loaded for the same range and listed under "Other data" in the report's assumptions. Open
  interest and the ratios exist since September 2020, funding since 2019.

## Fills

| Order | Fill |
|---|---|
| Market (`strategy.entry` without price) | Next bar's open (or this bar's close with `process_orders_on_close`), plus slippage |
| Limit | When the price trades **through** the limit (default) or **touches** it (setting); gaps fill at the better open price |
| Stop / stop-limit | When the trigger is reached; gaps fill at the open; stop-limits become limits after the trigger |
| Exit brackets | Take-profit as a limit, stop-loss and trailing stops as stops; OCA-reduce like TradingView |

**Intrabar path.** Inside a bar the price is assumed to move open → nearer extreme → other
extreme → close. With **intrabar precision** (bar magnifier, on by default) orders fill along
the real lower-timeframe klines inside each bar instead: 1s on spot, else 1m, 5m, 15m or 1h,
the finest that stays practical for the range. The assumption then only applies inside one
sub-kline. The report states which interval was used and how many bars it covered.

**Partial fills** (optional) limit fills to a share of the traded volume at the limit price.
They only apply where trade-level volume is available.

**Heikin-Ashi** signals fill on the real OHLC prices of the same bars by default. **Renko**
fills at brick prices are optimistic and flagged as such.

## Costs

Cost presets: Binance spot (0.10% maker/taker), Binance USDⓈ-M futures (0.02% / 0.05%),
TradingView-style €1 per fill, FTMO crypto commission, no costs, or the script's own
`strategy()` settings. Slippage is in basis points per fill.

- Futures: funding payments, cross or isolated margin, Binance maintenance-margin tiers,
  liquidation with the clearance fee.
- Spot can't short. With "Allow shorting" enabled, spot shorts pay a borrow rate you set
  (an assumption, stated in the report). Spot, margin and futures costs are never mixed.

## Report

- **Performance:** net profit, CAGR, max drawdown (amount, %, duration), run-up, Sharpe,
  Sortino and Calmar from daily equity, volatility, exposure, fees, funding, borrow costs,
  liquidations.
- **Trades:** count, win rate, profit factor, average trade, expectancy, largest win/loss,
  streaks, bars in trade, MAE/MFE. All of these are split long/short.
- **Benchmarks:** buy & hold of the same instrument and a cash (risk-free) benchmark, both over
  exactly the same period.
- **Breakdowns:** monthly and yearly returns next to buy & hold, and **regimes** (trend
  up/down/sideways by moving average, high/low volatility) with the strategy's and buy &
  hold's return in each.
- **Fee sensitivity:** five reruns with fees from 0 to 0.2% per side.
- **Assumptions:** data source, fill model and coverage, costs, funding and mark-price use,
  and every warning (lookahead, repainting, size reductions, Renko/HA caveats).

## Random counterparts

Is the result skill or luck? Every backtest is compared with 1,000 random twins (tab **vs
Random**):

- **Random timing:** the same number of trades with the same holding times, position sizes,
  long/short mix and costs, placed at random times. The p-value is the share of twins that
  did at least as well. Below 0.05 suggests the entries have real timing skill. Above 0.2 the
  result can't be told apart from luck.
- **Random direction:** the strategy's own entry and exit times and prices, with a coin flip
  for long or short. Tests whether it picks the right side. Only for strategies that trade
  both directions.

The tab shows the strategy's equity inside the band of random equity curves, the distribution
of random returns, and how many twins the strategy beats on return, Sharpe, drawdown, profit
factor and win rate. Random twins enter and exit at bar opens. The strategy keeps its real
limit and stop fills.

**Trade-order Monte Carlo** (same tab) replays the strategy's trades 2,000 times, each with its
profit relative to the equity before it:

- **Reordered:** the same trades in random order. The result stays the same and the path
  changes, which shows how much of the drawdown was the luck of the sequence.
- **Resampled:** trades drawn with replacement. This shows the range of returns and drawdowns
  the next run of trades could have.

It reports the chance of a loss and how often drawdowns exceed 10, 20, 30 and 50%.

## Greeks

The **Greeks** tab measures the strategy against buy & hold of the same coin, from daily
returns:

- **α alpha:** annual return that beta doesn't explain.
- **β beta:** how much it moves with the coin.
- **ρ correlation, R²:** how closely it follows the coin.
- **σ volatility, Ω omega:** volatility, and daily gains over daily losses.
- **Relative to the coin:** tracking error, information ratio, Treynor ratio, up/down capture,
  upside and downside beta.
- **Tail risk:** one-day VaR and CVaR at 95%, skewness, excess kurtosis, tail ratio.

A strategy that only re-creates buy & hold with leverage shows a high R² and no alpha.

## Optimization

Grid, random, Bayesian (TPE) and genetic (NSGA-II, multi-objective) search over integer, float,
boolean and choice inputs. Objectives: Sharpe, Sortino, Calmar, return/drawdown, net profit,
profit factor, expectancy, win rate, CAGR. Constraints: max drawdown, min trades, min profit
factor.

Validation keeps parameter choice and evaluation apart:

- **Holdout:** the last N% of the period is never used to pick parameters.
- **Walk-forward:** rolling or anchored in-sample windows, each followed by an out-of-sample
  window. The out-of-sample results are stitched into one equity curve, with walk-forward
  efficiency.
- **Purged k-fold cross-validation** with an embargo between folds.

Overfitting diagnostics:

- Neighbourhood robustness: plateaus vs narrow peaks.
- Parameter heatmaps and 3-D landscapes.
- Bootstrap confidence intervals.
- Randomized-entry Monte Carlo.
- Deflated Sharpe ratio for the number of trials.
- Holm-adjusted p-values.
- Probability of backtest overfitting (CSCV).
- Stability across market regimes.

Runs happen in background workers and never block charts or live data. Results are saved
(Optimizer history, Experiments) and the best parameters can be saved as parameter sets.

## Lookahead and repainting

Scripts only see data up to the bar being processed. Python `next()` arrays are truncated at
the current bar. Pine history references can't use negative offsets. Higher-timeframe data
without lookahead only reveals bars that had closed. The compiler and editor warn about
constructs that leak future data or behave differently live (see the Pine and Python docs).

When the code looks ahead, a red banner sits above the results: they are better than anything
achievable live.

After every backtest, a **live replay** runs in the background. It replays up to 60 of the last
150 bar closes of the instrument as a bot sees them (only the bars up to that moment, other
timeframes cut at the same time) and compares the strategy's position and working orders with
the backtest's. The overview then says **Reproducible live**. If a bot would have traded
differently, a red **Not reproducible live** banner shows the bar where it happened. This catches
future data that no static check sees, in Pine and Python alike. **Assumptions → Check with a
live replay** runs the full check on demand.
