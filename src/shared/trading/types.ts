/** Paper-trading domain types (shared by the live engine, backtester and UI). */
import type { Market, SymbolId } from '../symbols';

export type AccountKind = 'manual' | 'bot';
export type MarginMode = 'cross' | 'isolated';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stopLimit' | 'takeProfit' | 'trailingStop';
export type TriggerSource = 'last' | 'mark';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'new' | 'partiallyFilled' | 'filled' | 'canceled' | 'rejected' | 'expired';
export type OrderSource = 'manual' | 'bot' | 'bracket' | 'liquidation' | 'rule' | 'replay';

export interface CostModel {
  preset: string;
  /** Fractions (0.001 = 0.1 %). */
  makerFee: number;
  takerFee: number;
  /** Flat fee per fill in USDT (converted from the preset currency at account creation). */
  flatFee: number;
  flatFeeNote?: string;
  slippage: { model: 'none' | 'fixedBps' | 'book'; bps: number };
  /** Futures funding payments. */
  funding: boolean;
}

export interface ExecutionModel {
  /** Limit orders fill when the market trades at ('touch') or beyond ('through') the limit. */
  limitFill: 'touch' | 'through';
  /** Extra ticks the market must trade through (with 'through'). */
  throughTicks: number;
  /** Allow partial fills limited by traded volume at/through the price. */
  partialFills: boolean;
  /** Max share of traded volume the order may take when partial fills are on. */
  participation: number;
  /** Trigger price for SL/TP and stop orders on futures. */
  stopTrigger: TriggerSource;
}

export interface RiskLimits {
  maxLeverage: number;
  /** 0 = unlimited */
  maxPositionNotional: number;
  maxOpenPositions: number;
  /** Block new risk once today's loss exceeds this % of start-of-day equity (0 = off). */
  maxDailyLossPct: number;
  /** Default risk per trade used by the sizing helper (% of equity). */
  riskPerTradePct: number;
}

export interface FuturesSettings {
  marginMode: MarginMode;
  defaultLeverage: number;
  /** Per-symbol leverage / margin mode overrides. */
  leverage: Partial<Record<SymbolId, number>>;
  marginModes: Partial<Record<SymbolId, MarginMode>>;
  /** Margin ratio (MM / margin balance) at which a margin-call warning is raised. */
  marginCallRatio: number;
}

export interface BotConfig {
  scriptId: string;
  language: 'pine' | 'python';
  params: Record<string, unknown>;
  symbol: SymbolId;
  market: Market;
  tf: string;
  chartType: 'candles' | 'heikinashi' | 'renko';
  status: 'running' | 'paused' | 'stopped' | 'error';
  startedAt?: number;
  lastError?: string;
  /** Position sizing applied when the strategy does not specify a quantity. */
  sizing: { mode: 'percentEquity' | 'fixedUsd' | 'fixedQty' | 'strategy'; value: number };
  /** Bars processed / last bar time (for resume diagnostics). */
  lastBarTime?: number;
  autostart: boolean;
  /** Script name when the bot was configured (display). */
  scriptName?: string;
  /** Input titles by key (display). */
  paramTitles?: Record<string, string>;
  /** 'next': start flat and act on the first signal after the start; 'join': adopt the strategy's current position. */
  startMode?: 'next' | 'join';
  /** Bars before the start that warm up the strategy's indicators. */
  warmupBars?: number;
  /** Run state that survives restarts (cleared when the bot stops). */
  state?: BotRunState;
  /** Risk guards: close the position and pause the bot when one trips (0 / undefined = off). */
  guards?: BotGuards;
  /** Notifications and toasts about this bot (its event log keeps everything); default on. */
  notify?: boolean;
}

export interface BotGuards {
  /** Drawdown of account equity from its peak since the bot started (or resumed), %. */
  maxDrawdownPct?: number;
  /** Loss since the start of the UTC day, % of that day's starting equity. */
  maxDailyLossPct?: number;
  /** Losing trades in a row (since the start or resume). */
  maxConsecutiveLosses?: number;
}

export interface BotRunState {
  /** Bar time from which the strategy may trade (0 = whole loaded history, "join" mode). */
  simFrom: number;
  /** Simulation capital: account equity when the bot started. */
  capital: number;
  scale: { k: number; dir: 1 | -1 } | null;
  hold: { simPos: number } | null;
  prevSimPos: number | null;
  prevTarget: number | null;
  /** Open time of the last processed closed bar. */
  lastBarTime: number;
  steps: number;
  failures: number;
  /** Risk guards: peak equity, the UTC day and its starting equity, and when counting restarted. */
  peakEquity?: number;
  dayKey?: string;
  dayStartEquity?: number;
  guardsFrom?: number;
}

/** A bot as shown in the Bots module. */
export interface BotView {
  accountId: string;
  name: string;
  color: string;
  market: Market;
  config: BotConfig | null;
  phase: 'loading' | 'waiting' | 'evaluating' | 'waitingData' | 'error' | 'paused' | 'stopped' | 'running';
  phaseText: string;
  nextStepAt: number | null;
  lastStepAt: number | null;
  stepMs: number;
  bars: number;
  account: {
    equity: number;
    initial: number;
    startEquity: number | null;
    realized: number;
    unrealized: number;
    fees: number;
    /** Signed position on the bot's symbol. */
    position: number;
    entry: number | null;
    mark: number | null;
    liqPrice: number | null;
    openOrders: number;
    status: AccountSnapshot['status'];
    trades: number;
  };
  /** Latest strategy evaluation. */
  sim: import('../../engine/host').BotStepResult | null;
  lastPlan: { t: number; target: number; actual: number; actions: string[]; notes: string[]; simPosition: number; scale: number | null; holding: boolean } | null;
}

export interface AccountConfig {
  id: string;
  name: string;
  kind: AccountKind;
  market: Market;
  initialBalance: number;
  color: string;
  costs: CostModel;
  execution: ExecutionModel;
  risk: RiskLimits;
  futures: FuturesSettings;
  prop?: PropAccountConfig;
  bot?: BotConfig;
  createdAt: number;
  /** Replay accounts trade only on historical replay data. */
  replay?: boolean;
  archived?: boolean;
}

export interface PropAccountConfig {
  profileId: string;
  profileVersion: string;
  firm: string;
  program: string;
  phase: string;
  size: number;
  options: Record<string, unknown>;
}

export interface Position {
  id: string;
  symbol: SymbolId;
  market: Market;
  /** 1 = long, -1 = short (spot is always long). */
  side: 1 | -1;
  qty: number;
  entry: number;
  leverage: number;
  marginMode: MarginMode;
  /** Isolated wallet balance (margin) for isolated positions. */
  isolatedMargin: number;
  openedAt: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  /** Highest/lowest price seen (for MAE/MFE). */
  maxPrice: number;
  minPrice: number;
}

export interface Order {
  id: string;
  accountId: string;
  symbol: SymbolId;
  market: Market;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly: boolean;
  /** Close the whole position when triggered (TP/SL brackets). */
  closePosition?: boolean;
  postOnly?: boolean;
  tif: TimeInForce;
  trigger: TriggerSource;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  createdAt: number;
  updatedAt: number;
  source: OrderSource;
  /** For brackets: 'sl' | 'tp' of the position on this symbol. */
  bracket?: 'sl' | 'tp';
  triggered?: boolean;
  reason?: string;
  rejectReason?: string;
  tag?: string;
  /** Trailing stop: callback rate (fraction), activation price, and the best price since activation. */
  callbackRate?: number;
  activationPrice?: number;
  trailExtreme?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: SymbolId;
  market: Market;
  side: OrderSide;
  qty: number;
  price: number;
  fee: number;
  liquidity: 'maker' | 'taker';
  t: number;
  realizedPnl: number;
  source: OrderSource;
  reason?: string;
}

export interface ClosedTrade {
  id: string;
  symbol: SymbolId;
  market: Market;
  side: 1 | -1;
  qty: number;
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  fees: number;
  funding: number;
  returnPct: number;
  mae: number;
  mfe: number;
  exitReason?: string;
  leverage: number;
}

export type AccountEventKind = 'info' | 'fill' | 'order' | 'cancel' | 'reject' | 'marginCall' | 'liquidation' | 'funding' | 'rule' | 'bot' | 'error' | 'reset';

export interface AccountEvent {
  t: number;
  kind: AccountEventKind;
  message: string;
  data?: Record<string, unknown>;
}

export interface PlaceOrderRequest {
  symbol: SymbolId;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  tif?: TimeInForce;
  trigger?: TriggerSource;
  closePosition?: boolean;
  bracket?: 'sl' | 'tp';
  source?: OrderSource;
  reason?: string;
  tag?: string;
  /** Attach brackets to the resulting position. */
  sl?: number;
  tp?: number;
  /** Trailing stop: distance from the best price since activation, as a fraction (0.01 = 1%). */
  callbackRate?: number;
  /** Trailing stop: start trailing once the price reaches this level (default: right away). */
  activationPrice?: number;
}

/** Snapshot of an account for the UI. */
export interface AccountSnapshot {
  config: AccountConfig;
  wallet: number;
  equity: number;
  available: number;
  unrealizedPnl: number;
  realizedPnl: number;
  feesPaid: number;
  fundingPaid: number;
  marginUsed: number;
  maintenanceMargin: number;
  marginRatio: number;
  exposure: number;
  /** maxRemoveMargin: how much isolated margin can be removed now (isolated positions only). */
  positions: (Position & { mark: number; uPnl: number; uPnlPct: number; notional: number; liqPrice: number; maintMargin: number; sl?: number; tp?: number; maxRemoveMargin?: number })[];
  orders: Order[];
  holdings: { symbol: SymbolId; qty: number; avgCost: number; value: number; uPnl: number }[];
  dayStartEquity: number;
  dayPnl: number;
  status: 'active' | 'restricted' | 'breached' | 'passed' | 'liquidated';
  statusReason?: string;
  rules?: import('../propfirm/types').RuleStatus;
  t: number;
}
