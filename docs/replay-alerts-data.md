# Replay, alerts, market data and the AI assistant

## Market replay

Practise on history as if it were live, like TradingView's bar replay.

1. Click **Replay** on a chart (or press Shift+R), then click the bar to start from. The start
   menu in the replay bar also offers a date or a random point.
2. **Play / pause** (Space), **step one bar** (Shift+→), choose a **speed**: 0.5×, real time
   (1×), 3×, 10×, or 1 minute up to 1 day per second.
3. Trade with the replay bar's Buy / Sell / Close buttons, the Trade panel or the chart
   (right-click, drag orders and brackets). Replay accounts are separate paper accounts per
   window and market.

Details:

- All charts in the window follow the same replay clock. Indicators, strategies and
  `request.security` run on the replayed data only. Nothing beyond the replay point is loaded.
- Replay uses real data at its real resolution: 1-second klines on spot and 1-minute klines on
  futures at the finest. The update interval adapts to the speed (or is chosen), always nesting
  in every replayed timeframe. No ticks are invented.
- Replay fills follow the replayed klines. Futures replay accounts use Binance mark-price
  klines for liquidations and historical funding rates.
- Order books, depth, heatmap and time & sales show live data during a replay and say so.
  Historical order books aren't available.
- Positions close when you restart the replay elsewhere or exit it.
- **Session report:** the report button in the replay bar, or leaving a replay you traded in,
  shows how the session went:
  - result, win rate, profit factor, drawdown on closed trades and holding times
  - buy & hold over the same period
  - with at least three trades in one instrument, how your entries compare with 1,000
    random twins (same sizes, holding times and costs at random times)

  This shows whether your practice entries had an edge or were luck.

## Alerts

Create alerts in the Alerts module, by right-clicking a chart ("Add alert at …"), or from an
indicator's menu ("Add alert…"):

- **Price level:** crosses (above/below/either), is above/below, enters/exits a channel.
  Price alerts are drawn on charts. Drag the line to move the level.
- **Trendline:** right-click a trend line, ray or extended line and choose "Add alert on this
  line…" (or a horizontal line for a price level). The level follows the line over time,
  straight in log space when it was drawn on a log chart. An alert on a segment ends at the
  segment's last point.
- **Price move:** up/down/either X% within N minutes.
- **Indicator:** a plot crosses or is above/below a value, the price or another plot,
  evaluated on bar close or intrabar.
- **Script / strategy:** an `alertcondition()`, any `alert()` call, or a strategy's order
  fills.
- **Order book:** bid/ask imbalance, bid or ask liquidity within a range, spread, or a large
  resting order appearing, optionally held for N seconds.
- **Futures data:** liquidations within N minutes (longs, shorts or both), an open interest
  rise or fall of X% within N minutes, the funding rate above or below a level, or the
  long/short ratio above or below a level.
- **Options:** Binance's options on the coin. Alert on 30-day implied volatility above or below
  a level (spikes come with fear and big moves), the 25-delta skew (strongly negative: demand
  for downside protection), put/call open interest, or the index crossing (or being above or
  below) the gamma flip, max pain or the call or put wall.

Each alert has a frequency (once, once per bar, at most once a minute, every time with a
pause), optional expiry, a message template (`{{symbol}} {{price}} {{value}} {{name}}
{{time}}`), desktop notification and sound. Triggers are kept in the alert log. Alerts run in
the background on the shared live data and don't slow down charts.

**Webhooks:** like TradingView, an alert can POST its message to a URL when it fires. The
message is sent as JSON when it is valid JSON, otherwise as text. Use it to drive your own bot,
Discord or a Telegram relay. "Send test" checks the URL. The result of every delivery is shown
in the alert log. Requests time out after 5 seconds, and at most one request per second is sent
per alert.

## Market data

- **Live:** Binance WebSocket streams (aggregate trades, klines, depth, mark price, tickers),
  resynchronised automatically after reconnects. Gaps are back-filled from REST.
- **History:** klines from the local cache. Missing ranges come from REST or Binance's data
  archive and are cached for reuse. The Data Manager shows coverage, gaps and disk use,
  prefetches ranges for offline backtests and replays, and cleans up.
- **Futures statistics** (open interest, long/short ratios) are Binance's 5-minute samples
  since September 2020: from its API for the last 30 days, from its daily archives before
  that, cached like candles. Scripts use them as `BINANCE:BTCUSDT.P_OI` and so on (see the
  Pine guide). A sample counts from the next 5-minute mark, because Binance publishes it 2–3
  minutes after measuring it. Backtests, replays and bots therefore see what a live trader
  saw. The Data Manager can prefetch them. Funding rates work the same way
  (`BINANCE:BTCUSDT.P_FUNDING`), one value per settlement.
- **Options** (the **Options** module): Binance's USDT-margined European options on BTC, ETH and
  SOL, with the Greeks as Binance publishes them.
  - **Chain:** strikes of one expiry with calls and puts side by side. Choose **Prices** (mark
    implied volatility, bid, mark, ask), **Greeks** (Δ delta, Γ gamma, Θ theta per day, ν vega
    per volatility point) or **Activity** (open interest, 24-hour volume and change). In-the-money
    cells are tinted, and the index sits between the strikes.
  - **Smile & term:** implied volatility by strike per expiry (with the bid/ask band), the
    volatility surface (expiries × strike as a share of the forward, as a heatmap), the term
    structure of at-the-money volatility, the 25-delta risk reversal per expiry (below zero: puts
    are richer) and a table with the expected move to each expiry, butterfly and max pain.
  - **Exposure:** open interest by strike (calls above, puts below) and dealer gamma by strike,
    in USDT per 1% move. This assumes dealers are long the calls and short the puts others trade,
    the usual convention. Positive gamma damps moves, negative gamma amplifies them, and the
    gamma flip is the index level where the sign changes.
  - **Builder:** click a bid, mark or ask in the chain, or pick a strategy (straddle, strangle,
    spreads, iron condor, covered call, protective put), to combine legs, including the coin
    itself. It shows the position's net Greeks, the premium, break-evens, maximum profit and
    loss, the chance of profit at the first expiry (if the index moves as the options price it,
    lognormal with that expiry's ATM volatility), the payoff at the first expiry and on any
    date with a volatility shift, and a scenario table of the profit or loss for index moves of
    −15% to +15% today, halfway and at the first expiry. Values use
    Black-Scholes with each option's mark volatility and Binance's rate. That is the model
    Binance prices with, so the Greeks match the exchange's. The builder is for planning only;
    paper trading covers spot and perpetuals.

  The summary shows 30-day implied volatility, interpolated in total variance like a volatility
  index, with the expected move it implies. It also shows the 25-delta skew, the put/call
  open-interest ratio, max pain and dealer gamma.

  **On the chart:** the **Options levels** switch in a chart's overlay menu draws live levels as
  labelled lines:
  - the call and put walls: the strikes with the most open interest among the expiries of the
    next 45 days
  - the gamma flip
  - max pain of the next expiry
  - the ±1σ expected move to the next weekly expiry, as a shaded band

  Binance keeps no history of these values, so they show the current state and are off during
  replays.
- **Footprints** use Binance aggregate trades with their aggressor side (from the maker flag).
  They are cached per day and only the newest days are kept.
- **Time:** bar closes follow Binance's server clock. The app measures its offset, so a
  computer clock that is off doesn't affect bars, bots or the cache.

## AI assistant (AI Studio)

The AI Studio runs your local **Claude Code** CLI with your Claude subscription. Install it
from claude.com/claude-code and run `claude` once in a terminal to sign in.

- Choose the **model**, **mode**, **effort** and whether Claude should **think** before
  answering. The modes are:
  - **Build:** writes, tests and saves scripts.
  - **Plan:** researches and proposes, without saving anything.
  - **Ask:** explains and answers.
- Claude works through the app's own tools instead of guessing:
  - the docs (including a Pine reference generated from the engine) and the script library
  - compile checks with lookahead and repainting warnings
  - runs on real Binance data
  - backtests with realistic costs against buy & hold, the Greeks and 1,000 random twins
  - robustness tests on the other coins, neighbouring timeframes and separate periods
  - signal quality of indicators: forward returns after signals and the information
    coefficient of plots
  - optimization with an out-of-sample holdout or walk-forward
  - market statistics, futures positioning and the options market (implied volatility, skew,
    expected moves, max pain, dealer gamma)
  - a repaint check that replays recent bars as if live
  - alerts it sets up for you (price levels, moves, futures and options data, script
    signals), in build mode
  - "show in app" (open in the editor, add to a chart, open a backtest)

  So a typical turn is hypothesis → write → check → run → backtest → robustness → refine, and
  ends with a report card and an honest verdict. Results appear as cards in the conversation
  and in the Strategy Tester / Optimizer history.
- Claude has no shell or file access on your computer. It only uses the app's tools.
- From the Script Editor, the **AI** menu can fix a compile error, explain a script, assess a
  strategy, check an indicator on real data or improve it. The Strategy Builder can hand its
  strategy to Claude for a review.
