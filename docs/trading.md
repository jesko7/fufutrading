# Paper trading, futures, prop challenges and bots

Everything in FuFu is paper trading: no exchange keys, no real orders. Live accounts use
Binance's live trades, order books and mark prices. Replay accounts use the replayed data.

## Accounts

Create as many accounts as you like (Account module → New paper account), from presets or
custom:

- **Market:** spot (long only, cash + holdings) or USDⓈ-M perpetual futures (one-way mode).
- **Costs:** Binance spot or futures fees (optionally paid in BNB: 25% / 10% off),
  TradingView-style €1 per fill (converted to USDT when the account is created), FTMO crypto
  commission, or none. Slippage comes from walking the
  live order book, or from a fixed basis-point amount.
- **Execution:** limit orders fill when the market trades through (default) or touches the
  price. Optional partial fills limited by traded volume. Stops trigger on last or mark price.
- **Risk limits:** max leverage, max position value, max open positions, daily loss limit.
- **Kind:** manual, or bot (a strategy trades it; see below).

Orders: market, limit, stop, stop-limit, take-profit and trailing stop, reduce-only and
post-only, with attached stop-loss / take-profit brackets. On charts you can place orders from
the right-click menu, and drag orders, SL/TP and position brackets.

- **Limit orders** that can fill right away take liquidity from the live order book up to the
  limit price. The rest waits in the book (GTC), is canceled (IOC), or the whole order is
  canceled unless it fills completely (FOK). Post-only orders that would fill right away are
  rejected.
- **Trailing stops** follow the best price (the high for a sell, the low for a buy) by a
  callback rate of 0.1–10% on futures and 0.1–20% on spot. They can wait for an activation
  price and trigger a market order.
- **Binance's order rules** apply:
  - Tick and lot sizes and minimum order values come from Binance at start-up, with a cached
    copy for offline use.
  - Futures limit prices must be within ±5% of the mark price.
  - A futures market order is capped at Binance's maximum quantity.
  - At most 200 orders can be open per symbol.
  - Reduce-only orders of a position that closes or reverses are canceled.
  - Bots wait with limit orders outside the price band until the price comes closer.

## Futures margin, leverage and liquidation

Futures accounts follow Binance's rules for USDⓈ-M perpetuals:

- **Leverage** per symbol, limited by Binance's leverage brackets. A larger position allows
  less leverage, exactly per the bracket table, which is refreshed from Binance at start-up
  (a bundled snapshot is the offline fallback). As on Binance, leverage can be changed with an
  open position: a cross position up or down (down only with enough available balance for the
  larger margin), an isolated position only up.
- **Cross and isolated margin.** Isolated margin can be added (up to the available balance) or
  removed (down to the position's initial margin).
- **Available balance** = wallet balance − initial margin + unrealized PNL of cross positions −
  margin of open orders. An order costs its initial margin plus the open loss when it is priced
  worse than the mark price.
- **Maintenance margin** uses Binance's tiered rates and maintenance amounts.
- **Liquidation price** uses Binance's published formula for one-way mode. This is verified
  against Binance's own worked example in the test suite. A position is liquidated when the
  **mark price** reaches it. The clearance (liquidation) fee is charged and a bankrupt
  position's loss is capped as on Binance.
- **Margin call** warning when the margin ratio reaches the account's threshold (default
  80%; liquidation happens at 100%).
- **Funding** is paid or received at Binance's funding times using the live (or, in
  backtests and replays, historical) funding rate.

## Prop-firm challenges (FTMO, Lucid Trading)

Choose a program, phase and account size when creating an account: FTMO 1-Step / 2-Step
challenges and funded accounts, and Lucid Trading programs. The rule engine enforces each
program's rules live:

- Profit targets and minimum trading days.
- Daily loss limits, in the firm's time zone and day boundary.
- Maximum loss: static, end-of-day trailing or intraday trailing, with locks.
- Consistency rules and size limits.

Breaches restrict or stop the account, as the firm would. A passed phase can start the next
phase. The **Prop Challenges** module shows every challenge's objectives at a glance.

These accounts are **rule simulations** on Binance BTC/ETH/SOL data. Each program's page lists
the sources, which rules are implemented, ambiguities, and how the firm's real instruments,
feeds and costs differ. FuFu doesn't claim to reproduce a firm's trading environment.

## Bots

A bot runs one of your strategies (Pine or Python) on its own paper account:

1. Create a bot account (Bots → New bot), choose the strategy, its parameters (or a saved
   parameter set), instrument, timeframe, chart type and position size:
   - % of equity
   - a fixed USDT amount or quantity
   - the strategy's own sizing
2. Start it. **Next signal** starts flat and acts on the first signal after the start.
   **Join current position** takes the strategy's current position right away.

When a bar closes, the bot re-runs the strategy over the bars since it started (plus a warm-up)
and aligns the account with it:

- It sends market orders when the strategy changes position.
- It mirrors the strategy's resting orders, so they fill during the bar on live trades. Limit
  and stop entries are mirrored as such. Take-profits become reduce-only limits. Stop-losses
  and trailing stops become reduce-only stops.

Every action is logged with its reason. If a position is reduced outside the strategy (an
exit filled live while the bar-based simulation didn't exit, a manual close, a prop-rule
flatten), the bot does **not** re-enter. It waits for the strategy's next signal.

- **Pause** keeps orders and positions as they are. **Resume** re-syncs.
- **Stop** cancels the bot's orders and either keeps or closes the position.
- Manual trading on a running bot's account is blocked. Pause the bot to intervene.
- Script errors, repeated order rejections, liquidations and prop-rule breaches pause the bot
  with the reason shown. Other bots and the app are not affected.
- **Autostart** resumes bots when the app starts. With "Keep bots running in the background"
  (Settings), closing the window keeps the app in the tray while bots run. "Start at login"
  launches it silently.
- The bot's view shows what drives each decision: the latest indicator values, the
  strategy's simulated position and resting orders, recent signals, the last decision, logs
  and trades.

Bar closes follow Binance's clock (the app measures the offset to Binance's server time), so a
bot never acts on a bar that is still forming on the exchange.
