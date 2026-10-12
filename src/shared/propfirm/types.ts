/** Prop-firm rule profiles (versioned, data-driven) and rule-engine state types. */

/** Amount as % of account size or a per-size table (USD). */
export interface Amount {
  pct?: number;
  bySize?: Record<string, number>;
}

export type Rule =
  | { kind: 'profitTarget'; amount: Amount; requireFlat: boolean }
  | { kind: 'dailyLoss'; amount: Amount; reference: 'balanceAtReset' | 'equityAtReset'; severity: 'hard' | 'soft'; optional?: string; scaling?: { pctOfPeakEodProfit: number; afterBalance: Amount } }
  | { kind: 'maxLoss'; amount: Amount; mode: 'static' | 'eodTrailing' | 'intradayTrailing'; measure: 'equity' | 'balance'; lockTrigger?: Amount; lockLevel?: Amount; optionKey?: string }
  | { kind: 'minTradingDays'; days: number; definition: 'positionOpened' }
  | { kind: 'consistency'; maxShare: number; basis: 'totalProfit' | 'positiveDaysProfit'; effect: 'pass' | 'payout'; note?: string }
  | { kind: 'maxSize'; micros: Amount; scaling?: { profitFloor: number; micros: Record<string, number> }[] }
  | { kind: 'tradingHours'; tz: string; flatBy: string; reopen: string; closedDays: number[]; autoFlatten: boolean };

export interface OptionSpec {
  key: string;
  label: string;
  type: 'bool' | 'select';
  values?: { value: string; label: string }[];
  default: unknown;
  help?: string;
}

export interface RuleProfile {
  id: string;
  firm: 'FTMO' | 'Lucid Trading';
  program: string;
  phase: string;
  version: string;
  verifiedAt: string;
  sources: string[];
  sizes: number[];
  sizesVerified: boolean;
  /** Day/session definition used for daily limits, EOD trailing and trading days. */
  session: { tz: string; resetHour: number; resetMinute: number; label: string };
  rules: Rule[];
  next?: string;
  costPreset: string;
  leverage: { default: number; max: number; note: string };
  options?: OptionSpec[];
  /** Why this is a rule simulation and what differs from the firm's real environment. */
  simulationNote: string;
  implemented: string[];
  notImplemented: string[];
  ambiguities: string[];
  /** Micro-contract equivalence (for firms that limit size in contracts). */
  contractMap?: { note: string; microQty: Record<string, number> };
}

export interface PropState {
  profileId: string;
  size: number;
  options: Record<string, unknown>;
  initial: number;
  dayKey: string;
  dayStartBalance: number;
  dayStartEquity: number;
  /** Highest end-of-day (session close) balance. */
  highestEodBalance: number;
  /** Highest intraday equity/balance (for intraday trailing). */
  highestIntraday: number;
  maxLossFloor: number;
  locked: boolean;
  tradingDays: string[];
  /** Closed P&L per session key. */
  dailyPnl: Record<string, number>;
  status: 'active' | 'restricted' | 'breached' | 'passed';
  reason?: string;
  breachedAt?: number;
  passedAt?: number;
  restrictedDay?: string;
  lastBalance: number;
}

export interface RuleCheck {
  id: string;
  label: string;
  /** Value shown to the user (e.g. remaining allowance). */
  value: string;
  progress?: number;
  ok: boolean;
  severity: 'info' | 'warn' | 'breach' | 'pass';
  detail?: string;
}

export interface RuleStatus {
  profileId: string;
  firm: string;
  program: string;
  phase: string;
  status: PropState['status'];
  reason?: string;
  equity: number;
  balance: number;
  dailyLossRemaining: number | null;
  maxLossRemaining: number | null;
  maxLossFloor: number;
  dailyFloor: number | null;
  profitTargetProgress: number | null;
  tradingDays: number;
  minTradingDays: number | null;
  consistency: { share: number; limit: number; ok: boolean; effect: string } | null;
  maxMicros: number | null;
  checks: RuleCheck[];
  simulationNote: string;
  next?: string;
}
