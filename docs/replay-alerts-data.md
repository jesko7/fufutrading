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

## Alerts

Create alerts in the Alerts module, by right-clicking a chart ("Add alert at …"), or from an
indicator's menu ("Add alert…"):

- **Price level:** crosses (above/below/either), is above/below, enters/exits a channel.
  Price alerts are drawn on charts. Drag the line to move the level.
- **Price move:** up/down/either X% within N minutes.
- **Indicator:** a plot crosses or is above/below a value, the price or another plot,
  evaluated on bar close or intrabar.
- **Script / strategy:** an `alertcondition()`, any `alert()` call, or a strategy's order
  fills.
- **Order book:** bid/ask imbalance, bid or ask liquidity within a range, spread, or a large
  resting order appearing, optionally held for N seconds.

Each alert has a frequency (once, once per bar, at most once a minute, every time with a
pause), optional expiry, a message template (`{{symbol}} {{price}} {{value}} {{name}}
{{time}}`), desktop notification and sound. Triggers are kept in the alert log. Alerts run in
the background on the shared live data and don't slow down charts.

## Market data

- **Live:** Binance WebSocket streams (aggregate trades, klines, depth, mark price, tickers),
  resynchronised automatically after reconnects. Gaps are back-filled from REST.
- **History:** klines from the local cache. Missing ranges come from REST or Binance's data
  archive and are cached for reuse. The Data Manager shows coverage, gaps and disk use,
  prefetches ranges for offline backtests and replays, and cleans up.
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
  - market statistics
  - "show in app" (open in the editor, add to a chart, open a backtest)

  So a typical turn is hypothesis → write → check → run → backtest → robustness → refine, and
  ends with a report card and an honest verdict. Results appear as cards in the conversation
  and in the Strategy Tester / Optimizer history.
- Claude has no shell or file access on your computer. It only uses the app's tools.
- From the Script Editor, the **AI** menu can fix a compile error, explain a script, assess a
  strategy, check an indicator on real data or improve it. The Strategy Builder can hand its
  strategy to Claude for a review.
