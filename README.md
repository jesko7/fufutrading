# FuFu Trading

A fast, modular desktop trading platform for **BTC, ETH and SOL** on Binance (spot and USDⓈ-M
perpetuals). It has live charts and order-flow tools, Pine Script and Python strategies,
backtesting and optimization, TradingView-style replay, paper trading with Binance-exact
futures margin rules, FTMO / Lucid prop-challenge simulation, strategy bots, alerts, news, and
an AI assistant that builds and tests strategies inside the app.

> Paper trading only. FuFu never places real orders and needs no exchange keys. Nothing here
> is financial advice; backtests and simulations don't predict future results.

## Highlights

- **Charts:**
  - candles, hollow, bars, line, area, Heikin-Ashi, Renko and footprint (buyer/seller volume
    per price level from real aggregate trades)
  - any timeframe, including custom ones like 30s, 7m or 90m
  - drawings (with trendline alerts, Ctrl+Z / Ctrl+Y and Ctrl+C / Ctrl+V), volume profile,
    compare and multi-timeframe overlays, options levels (walls, gamma flip, max pain, expected
    move), synced crosshairs, candlestick pattern detection (choose the patterns)
  - log and percentage scales; drag to pan (a flick glides briefly, also up and down; it can be
    turned off), wheel or pinch to zoom, a "+" at the crosshair price for orders, alerts and
    lines, and one click back to the latest bar
  - chart images with the instrument, timeframe and OHLC (Alt+S copies, right-click saves)
- **Order flow:** live order book with grouping, imbalance and your own resting orders marked,
  depth chart, liquidity heatmap with large-order tracking, time & sales.
- **Workspaces:** dockable, multi-window layouts and presets. Panels move by their tab or header
  (drop on an edge to split, on a tab strip to join or reorder, outside the window to detach), and
  any panel can be maximized over the workspace (double-click its tab or Alt+Enter, Esc
  restores). A command palette (Ctrl+K) and keyboard shortcuts that never fire while you type,
  light and dark themes.
- **Scripting:**
  - Pine Script v3–v6 (including v4's un-namespaced built-ins, drawings with linefills,
    polylines and chart points, maps, matrices; honest about what isn't supported) and Python
    (Pyodide with NumPy), with identical indicator math in both languages
  - built-in library, favorites, import/export
  - editor with autocomplete, diagnostics and lookahead/repaint warnings, plus a repaint check
    that replays recent bars as if live and compares them with the history (for strategies: what
    a bot would have done against the backtest)
  - bar inspector, Python debugger
  - a flowchart **Strategy Builder** that generates editable code (indicators, price,
    candlestick patterns and futures positioning as conditions)
- **Backtesting:**
  - no bar limit, on cached Binance history
  - realistic Binance costs, funding and mark-price liquidations
  - intrabar precision from lower-timeframe klines (bar magnifier)
  - benchmarks, regimes, fee sensitivity and a full trade analysis
  - every strategy against 1,000 random twins (same trades at random times), the Greeks
    (alpha, beta, correlation, Omega, VaR …) and a trade-order Monte Carlo
- **Optimization:**
  - grid, random, Bayesian and genetic search with constraints and multi-objective ranking
    (including alpha as an objective)
  - holdout, walk-forward and purged cross-validation
  - overfitting diagnostics (robustness, bootstrap, deflated Sharpe, PBO …), heatmaps and 3-D
    landscapes
  - an experiment tracker and parameter sets
- **Paper trading:**
  - multiple accounts with cost presets (Binance ≈0.2% round trip, TradingView-style €1 per
    fill …)
  - market, limit, stop, stop-limit, trailing-stop, scaled and TWAP orders, GTC/IOC/FOK, post-only,
    drag-and-drop SL/TP
  - Binance's order rules (filters refreshed from Binance, price bands, size limits), leverage
    brackets and leverage changes on open positions, maintenance-margin tiers, liquidation
    formula, margin calls and funding
  - Binance's position figures: break-even price (also as a chart line), margin ratio, ROI;
    close at market or with a limit order
  - a trade journal with notes, setup tags and statistics per setup
- **Prop challenges:** FTMO and Lucid Trading rule simulation (targets, daily/max loss,
  trailing, consistency, trading days) for manual or bot accounts.
- **Bots:** strategies trade their own accounts on every bar close, mirror their stops and
  targets, explain every action, pause themselves on errors or risk guards (drawdown, daily
  loss, losing streak), and keep running in the tray. Each bot compares its live trades with
  its strategy's (slippage, missed trades) and its equity with buy & hold.
- **Options:** Binance's BTC, ETH and SOL options. The chain has prices, implied volatilities and
  the Greeks (Δ Γ Θ ν). Charts show the volatility smile, term structure and skew, open interest
  and dealer gamma by strike, max pain and the gamma flip, and the volatility surface. A position
  builder nets the Greeks of several legs, gives the chance of profit and a scenario table, and
  draws the payoff on any date with a volatility shift.
- **Derivatives data:** open interest, funding history, long/short ratios, taker flow, a live
  liquidation feed and a positioning history (price against open interest, ratios and funding
  over 7 days to a year). Open interest, the long/short ratios and funding rates also work as
  script data, through TradingView-style tickers (`BINANCE:BTCUSDT.P_OI`, `…_FUNDING`), without
  lookahead, in backtests, replays, bots and the strategy builder. Exact volume delta (CVD) comes
  from Binance's taker volume.
- **Replay:** bar replay with adjustable speed, stepping and replay trading. Strictly no future
  data, at real data resolution. A session report compares your replay trades with buy & hold
  and random entries.
- **Alerts:** price, moves, indicators, script conditions, order-book conditions, futures
  data (liquidations, open interest, funding), options (implied volatility, skew, put/call,
  the gamma flip and other levels) and news (headlines Claude rates bullish or bearish), with
  desktop notifications and webhooks.
- **News:** headlines from crypto news feeds, filtered by coin, with Claude's read of each one
  (green for likely bullish, red for likely bearish; model, effort and thinking chosen in the
  module).
- **AI Studio:** Claude Code (your subscription) with model, mode, effort and thinking settings.
  It researches like a quant through the app's own tools:
  - writes, compiles and runs scripts, measuring their predictive value
  - backtests against random twins and the Greeks, tests robustness on other coins,
    timeframes and periods
  - optimizes out-of-sample and reports an honest verdict
  - reviews your own trades and journal, and can prepare a paper bot

## Requirements

- Windows 10/11 or Linux (x64). macOS builds should work with Electron's standard tooling but are
  not tested.
- Internet access to Binance's public APIs. If `api.binance.com` is blocked where you are, the
  app automatically tries Binance's alternative spot hosts.
- To build from source: **Node.js 22+** and npm.
- Optional, for the AI Studio: the **Claude Code** CLI (`claude`), signed in once in a
  terminal.

## Run from source

```bash
npm install          # also downloads Electron and Pyodide
npm start            # build and launch
npm run dev          # rebuild on change, restart on main-process changes
npm run shortcut     # create desktop / start-menu shortcuts that launch this checkout
```

If downloading Electron fails behind a proxy or firewall, set a mirror before installing, e.g.
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`.

The NumPy wheel for Python scripts is fetched at build time (or on the first Python run) and
verified by checksum.

## Installers

```bash
npm run dist:win     # NSIS installer + portable build in release/
npm run dist:linux   # AppImage + .deb in release/
```

The Windows installer offers a desktop shortcut. Settings → Background can start FuFu at login
so bots resume automatically.

## Tests

```bash
npm test             # unit tests (engine, trading, bots, replay, alerts, optimizer, …)
npm run typecheck
npm run test:live    # against the real Binance API and the Claude CLI
npm run e2e -- smoke presets perf charts drawings trading scripts editor backtest optimizer experiments bots botlive replay alerts ai aitools footprint news derivatives options repaint prop builder help light layout settings
```

The end-to-end runner drives the real app with Playwright on an isolated profile and saves
screenshots to `tests/e2e/screenshots`.

## Documentation

- [Pine Script support](docs/pine.md)
- [Python API](docs/python.md)
- [Backtesting and optimization](docs/backtesting.md)
- [Paper trading, futures, prop challenges and bots](docs/trading.md)
- [Replay, alerts, market data and the AI assistant](docs/replay-alerts-data.md)

## Architecture

- **Main process** (`src/main`):
  - Binance REST/WebSocket clients and the server clock
  - the market hub: shared trade tapes, order books, series, replay sessions
  - the candle and trade caches
  - the paper-trading engine, bots, alerts, backtest and optimizer services
  - the AI tool server
  - window and workspace management
- **Script workers** (`src/workers`): Pine and Python run in worker threads with time limits,
  so a runaway script never blocks the UI or live data.
- **Engine** (`src/engine`): the Pine compiler and runtime, the Python host, the broker
  emulator, metrics and the optimizer. Pure TypeScript, shared by charts, backtests, bots and
  replay.
- **Renderer** (`src/renderer`): React modules in a dockable layout, with a canvas chart engine.

User data (accounts, scripts, settings, caches) lives in the Electron user-data folder.
Market-data caches can be inspected and cleaned in the Data Manager.
