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
  - drawings, volume profile, compare and multi-timeframe overlays, synced crosshairs
  - log and percentage scales
- **Order flow:** live order book with grouping and imbalance, depth chart, liquidity heatmap
  with large-order tracking, time & sales.
- **Workspaces:** dockable, multi-window layouts and presets, a command palette (Ctrl+K) and
  keyboard shortcuts that never fire while you type, light and dark themes.
- **Scripting:**
  - Pine Script (v4–v6 subset, honest about what isn't supported) and Python (Pyodide with
    NumPy), with identical indicator math in both languages
  - built-in library, favorites, import/export
  - editor with autocomplete, diagnostics and lookahead/repaint warnings
  - bar inspector, Python debugger
  - a flowchart **Strategy Builder** that generates editable code
- **Backtesting:**
  - no bar limit, on cached Binance history
  - realistic Binance costs, funding and mark-price liquidations
  - intrabar precision from lower-timeframe klines (bar magnifier)
  - benchmarks, regimes, fee sensitivity and a full trade analysis
- **Optimization:**
  - grid, random, Bayesian and genetic search with constraints and multi-objective ranking
  - holdout, walk-forward and purged cross-validation
  - overfitting diagnostics (robustness, bootstrap, deflated Sharpe, PBO …), heatmaps and 3-D
    landscapes
  - an experiment tracker and parameter sets
- **Paper trading:**
  - multiple accounts with cost presets (Binance ≈0.2% round trip, TradingView-style €1 per
    fill …)
  - market, limit and stop orders with drag-and-drop SL/TP
  - Binance leverage brackets, maintenance-margin tiers, liquidation formula, margin calls and
    funding
- **Prop challenges:** FTMO and Lucid Trading rule simulation (targets, daily/max loss,
  trailing, consistency, trading days) for manual or bot accounts.
- **Bots:** strategies trade their own accounts on every bar close, mirror their stops and
  targets, explain every action, pause themselves on errors, and keep running in the tray.
- **Replay:** bar replay with adjustable speed, stepping and replay trading. Strictly no future
  data, at real data resolution.
- **Alerts:** price, moves, indicators, script conditions and order-book conditions, with
  desktop notifications.
- **AI Studio:** Claude Code (your subscription) with model, mode, effort and thinking settings.
  It writes, compiles, runs, backtests and optimizes scripts through the app's own tools and
  iterates on real results.

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
npm run e2e -- smoke charts trading scripts backtest optimizer bots replay alerts ai builder
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
