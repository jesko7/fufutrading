/**
 * Versioned prop-firm rule profiles. Values were transcribed from the firms' official pages on
 * 2026-10-12 (see `sources`). Every profile lists what is implemented, what is not, and known
 * ambiguities. Re-verify against the sources before relying on them — firms change rules.
 */
import type { RuleProfile, Rule, Amount } from './types';

const VERIFIED = '2026-10-12';

const FTMO_SOURCES = ['https://ftmo.com/en/trading-objectives/', 'https://ftmo.com/en/2-step-challenge/', 'https://ftmo.com/en/1-step-challenge/', 'https://ftmo.com/en/faq/what-are-the-account-specifications/', 'https://ftmo.com/en/blog/ftmo-enhances-crypto-trading-new-instruments-and-better-spreads/'];

const FTMO_SESSION = { tz: 'Europe/Prague', resetHour: 0, resetMinute: 0, label: 'midnight CE(S)T (Europe/Prague)' };

const FTMO_SIM_NOTE =
  'Rule simulation. FTMO trades crypto as CFDs on its own price feed (MetaTrader/cTrader). FuFu applies FTMO’s account rules to Binance prices — spreads, swaps, contract sizes and FTMO’s execution are not reproduced, so results will differ from a real FTMO account.';

const FTMO_LEVERAGE = { default: 3, max: 3.3, note: 'Crypto leverage 1:3.3 per FTMO blog (Normal/Standard account, 2024). Current per-asset crypto leverage is not stated on the pages checked — verify in your platform. Editable.' };

const FTMO_COMMON_NOT_IMPLEMENTED = [
  'Funded Standard account restrictions on news trading, overnight and weekend holding',
  'FTMO price feed, spreads and swap (overnight financing) rates',
  'Maximum volume per trade (e.g. 5 lots BTCUSD) and FTMO contract sizes',
  'Inactivity rules, rewards/payout schedule, scaling plan',
];

const pct = (p: number): Amount => ({ pct: p });
const by = (o: Record<number, number>): Amount => ({ bySize: Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), v])) });

function ftmo(id: string, program: string, phase: string, rules: Rule[], next: string | undefined, implemented: string[], extra: Partial<RuleProfile> = {}): RuleProfile {
  return {
    id,
    firm: 'FTMO',
    program,
    phase,
    version: VERIFIED,
    verifiedAt: VERIFIED,
    sources: FTMO_SOURCES,
    sizes: [10000, 25000, 50000, 100000, 200000],
    sizesVerified: false,
    session: FTMO_SESSION,
    rules,
    next,
    costPreset: 'ftmo-crypto',
    leverage: FTMO_LEVERAGE,
    simulationNote: FTMO_SIM_NOTE,
    implemented,
    notImplemented: FTMO_COMMON_NOT_IMPLEMENTED,
    ambiguities: ['Account sizes offered are not listed on the pages checked; common sizes are provided and any size can be entered.'],
    ...extra,
  };
}

const LUCID_SOURCES = (slug: string) => [
  'https://support.lucidtrading.com/en/collections/12931279-rules-and-guidelines',
  'https://support.lucidtrading.com/en/articles/11404729-allowed-trading-times',
  'https://support.lucidtrading.com/en/articles/11508978-approved-products-and-commissions',
  slug,
];

const LUCID_SESSION = { tz: 'America/New_York', resetHour: 17, resetMinute: 0, label: '17:00 ET (CME session close)' };

const LUCID_SIM_NOTE =
  'Rule simulation only. Lucid Trading funds CME futures traders; its list of approved products (checked 2026-10-12) contains no crypto futures. FuFu applies Lucid’s dollar-based account rules to BTC/ETH/SOL on Binance. Contract-size limits are mapped to crypto via CME micro contract sizes (an assumption), and Lucid commissions do not exist for crypto (Binance futures fees are used instead, editable).';

const LUCID_HOURS: Rule = { kind: 'tradingHours', tz: 'America/New_York', flatBy: '16:45', reopen: '18:00', closedDays: [6], autoFlatten: true };

const LUCID_CONTRACT_MAP = {
  note: 'Size limits are given in CME mini/micro contracts. FuFu maps 1 micro = 0.1 BTC (CME Micro Bitcoin), 0.1 ETH (CME Micro Ether) or 25 SOL (CME Micro Solana), and 1 mini = 10 micros (Lucid’s “2 mini or 20 micros” ratio).',
  microQty: { BTCUSDT: 0.1, ETHUSDT: 0.1, SOLUSDT: 25 },
};

const LUCID_MLL = by({ 25000: 1000, 50000: 2000, 100000: 3000, 150000: 4500 });
const LUCID_TRAIL = by({ 25000: 26100, 50000: 52100, 100000: 103100, 150000: 154600 });
const LUCID_LOCK = by({ 25000: 25100, 50000: 50100, 100000: 100100, 150000: 150100 });
const LUCID_TARGET = by({ 25000: 1250, 50000: 3000, 100000: 6000, 150000: 9000 });
const LUCID_MICROS = by({ 25000: 20, 50000: 40, 100000: 60, 150000: 100 });

const LUCID_COMMON_NOT_IMPLEMENTED = [
  'CME instruments, contract specifications and commissions (no crypto products are approved by Lucid)',
  'Prohibited strategies (microscalping, hedging, HFT) — not detectable here; follow Lucid’s rules yourself',
  'Payout requests, payout buffers and profit split',
  'Holiday early closes',
];

function lucid(id: string, program: string, phase: string, slug: string, rules: Rule[], implemented: string[], extra: Partial<RuleProfile> = {}): RuleProfile {
  return {
    id,
    firm: 'Lucid Trading',
    program,
    phase,
    version: VERIFIED,
    verifiedAt: VERIFIED,
    sources: LUCID_SOURCES(slug),
    sizes: [25000, 50000, 100000, 150000],
    sizesVerified: true,
    session: LUCID_SESSION,
    rules: [...rules, LUCID_HOURS],
    costPreset: 'binance-futures',
    leverage: { default: 10, max: 20, note: 'Lucid limits size in contracts, not leverage. Leverage here only sets the simulated margin on Binance-style perpetuals.' },
    simulationNote: LUCID_SIM_NOTE,
    implemented: [...implemented, 'Flat by 16:45 ET Mon–Fri (positions auto-closed), trading reopens 18:00 ET Sun–Thu'],
    notImplemented: LUCID_COMMON_NOT_IMPLEMENTED,
    ambiguities: [
      'The exact end-of-day snapshot time is not stated; FuFu uses the 17:00 ET CME session close.',
      'Whether the Max Loss Limit is checked against balance or equity intraday is not stated; FuFu checks equity (open P&L included), which is stricter.',
    ],
    contractMap: LUCID_CONTRACT_MAP,
    ...extra,
  };
}

const EOD_LOCK_MLL: Rule = { kind: 'maxLoss', amount: LUCID_MLL, mode: 'eodTrailing', measure: 'equity', lockTrigger: LUCID_TRAIL, lockLevel: LUCID_LOCK };

export const PROFILES: RuleProfile[] = [
  // ------------------------------------------------------------------ FTMO 2-Step
  ftmo(
    'ftmo-2step-challenge',
    '2-Step',
    'FTMO Challenge',
    [
      { kind: 'profitTarget', amount: pct(0.1), requireFlat: true },
      { kind: 'dailyLoss', amount: pct(0.05), reference: 'balanceAtReset', severity: 'hard' },
      { kind: 'maxLoss', amount: pct(0.1), mode: 'static', measure: 'equity' },
      { kind: 'minTradingDays', days: 4, definition: 'positionOpened' },
    ],
    'ftmo-2step-verification',
    ['Profit target 10% (balance, all positions closed)', 'Max daily loss 5% of initial capital from the balance at midnight CE(S)T, equity-tested', 'Max loss 10% static, equity-tested', 'Min 4 trading days (days a position was opened)'],
  ),
  ftmo(
    'ftmo-2step-verification',
    '2-Step',
    'Verification',
    [
      { kind: 'profitTarget', amount: pct(0.05), requireFlat: true },
      { kind: 'dailyLoss', amount: pct(0.05), reference: 'balanceAtReset', severity: 'hard' },
      { kind: 'maxLoss', amount: pct(0.1), mode: 'static', measure: 'equity' },
      { kind: 'minTradingDays', days: 4, definition: 'positionOpened' },
    ],
    'ftmo-2step-account',
    ['Profit target 5%', 'Max daily loss 5%', 'Max loss 10% static', 'Min 4 trading days'],
  ),
  ftmo(
    'ftmo-2step-account',
    '2-Step',
    'FTMO Account',
    [
      { kind: 'dailyLoss', amount: pct(0.05), reference: 'balanceAtReset', severity: 'hard' },
      { kind: 'maxLoss', amount: pct(0.1), mode: 'static', measure: 'equity' },
    ],
    undefined,
    ['Max daily loss 5%', 'Max loss 10% static', 'No profit target, no minimum trading days'],
  ),
  // ------------------------------------------------------------------ FTMO 1-Step
  ftmo(
    'ftmo-1step-challenge',
    '1-Step',
    'FTMO Challenge',
    [
      { kind: 'profitTarget', amount: pct(0.1), requireFlat: true },
      { kind: 'dailyLoss', amount: pct(0.03), reference: 'balanceAtReset', severity: 'hard' },
      { kind: 'maxLoss', amount: pct(0.1), mode: 'eodTrailing', measure: 'equity' },
      { kind: 'consistency', maxShare: 0.5, basis: 'totalProfit', effect: 'pass', note: 'Best day ≤ 50% of total (cumulative closed) profit — rule for accounts ordered on/after 12 Oct 2026. Not a breach: keep trading until satisfied.' },
    ],
    'ftmo-1step-account',
    ['Profit target 10%', 'Max daily loss 3% from the balance at midnight CE(S)T', 'Max loss 10% end-of-day trailing on balance (only increases), equity-tested', 'Consistency: best day ≤ 50% of total profit'],
    {
      options: [
        {
          key: 'consistencyBasis',
          label: 'Consistency rule version',
          type: 'select',
          values: [
            { value: 'totalProfit', label: 'Current (orders from 12 Oct 2026): % of total profit' },
            { value: 'positiveDaysProfit', label: 'Legacy Best Day Rule: % of positive days’ profit' },
          ],
          default: 'totalProfit',
        },
      ],
    },
  ),
  ftmo(
    'ftmo-1step-account',
    '1-Step',
    'FTMO Account',
    [
      { kind: 'dailyLoss', amount: pct(0.03), reference: 'balanceAtReset', severity: 'hard' },
      { kind: 'maxLoss', amount: pct(0.1), mode: 'eodTrailing', measure: 'equity' },
      { kind: 'consistency', maxShare: 0.5, basis: 'totalProfit', effect: 'payout', note: 'Applies to reward eligibility on the FTMO Account (1-Step).' },
    ],
    undefined,
    ['Max daily loss 3%', 'Max loss 10% EOD trailing (resets to 90% of capital after a reward withdrawal — not simulated)', 'Consistency for reward eligibility'],
  ),
  // ------------------------------------------------------------------ Lucid
  lucid(
    'lucid-flex-eval',
    'LucidFlex',
    'Evaluation',
    'https://support.lucidtrading.com/en/collections/16914631-lucidflex',
    [
      { kind: 'profitTarget', amount: LUCID_TARGET, requireFlat: false },
      EOD_LOCK_MLL,
      { kind: 'consistency', maxShare: 0.5, basis: 'totalProfit', effect: 'pass', note: 'Largest single-day profit / account profit must be ≤ 50% to upgrade.' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Profit target ($1,250 / $3,000 / $6,000 / $9,000)', 'Max loss limit EOD trailing, locks at initial balance + $100 once the initial trail balance is exceeded', 'Consistency ≤ 50% to pass', 'Max size 2/4/6/10 minis (20/40/60/100 micros)'],
    { next: 'lucid-flex-funded', notImplemented: [...LUCID_COMMON_NOT_IMPLEMENTED, 'Optional daily loss limit (amount not specified for LucidFlex)'] },
  ),
  lucid(
    'lucid-flex-funded',
    'LucidFlex',
    'Funded',
    'https://support.lucidtrading.com/en/articles/12945795-lucidflex-funded-account',
    [
      EOD_LOCK_MLL,
      {
        kind: 'maxSize',
        micros: LUCID_MICROS,
        scaling: [
          { profitFloor: 0, micros: { '25000': 10, '50000': 20, '100000': 30, '150000': 40 } },
          { profitFloor: 1000, micros: { '25000': 20, '50000': 30, '100000': 40, '150000': 50 } },
          { profitFloor: 2000, micros: { '25000': 20, '50000': 40, '100000': 50, '150000': 60 } },
          { profitFloor: 3000, micros: { '25000': 20, '50000': 40, '100000': 60, '150000': 80 } },
          { profitFloor: 4500, micros: { '25000': 20, '50000': 40, '100000': 60, '150000': 100 } },
        ],
      },
    ],
    ['Max loss limit EOD trailing with lock', 'Scaling plan (max contracts by simulated profit, updated at session end)', 'No consistency rule on funded accounts'],
    { notImplemented: [...LUCID_COMMON_NOT_IMPLEMENTED, 'Optional daily loss limit (amount not specified)'] },
  ),
  lucid(
    'lucid-pro-eval',
    'LucidPro',
    'Evaluation',
    'https://support.lucidtrading.com/en/articles/12890029-lucidpro-evaluation-account',
    [
      { kind: 'profitTarget', amount: LUCID_TARGET, requireFlat: false },
      EOD_LOCK_MLL,
      { kind: 'dailyLoss', amount: by({ 50000: 1200, 100000: 1800, 150000: 2700 }), reference: 'balanceAtReset', severity: 'soft' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Profit target', 'Max loss limit EOD trailing with lock', 'Daily loss limit (soft: trading restricted until next session; none on 25K)', 'Max size'],
    { next: 'lucid-pro-funded' },
  ),
  lucid(
    'lucid-pro-funded',
    'LucidPro',
    'Funded',
    'https://support.lucidtrading.com/en/articles/12890069-lucidpro-funded-account',
    [
      EOD_LOCK_MLL,
      { kind: 'dailyLoss', amount: by({ 25000: 600, 50000: 1200, 100000: 1800, 150000: 2700 }), reference: 'balanceAtReset', severity: 'soft', optional: 'dll', scaling: { pctOfPeakEodProfit: 0.6, afterBalance: LUCID_TRAIL } },
      { kind: 'consistency', maxShare: 0.4, basis: 'totalProfit', effect: 'payout', note: '40% for accounts purchased/reset on or after 28 Nov 2025 (35% before). Resets after each payout.' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Max loss limit EOD trailing with lock', 'Optional fixed DLL, replaced by the LucidScale DLL (60% of highest EOD profit) after closing above the initial trail balance', 'Consistency 40% for payout eligibility', 'Max size'],
    { options: [{ key: 'dll', label: 'Daily loss limit (chosen at purchase)', type: 'bool', default: true }] },
  ),
  lucid(
    'lucid-direct-funded',
    'LucidDirect',
    'Funded (straight to funded)',
    'https://support.lucidtrading.com/en/articles/12890148-luciddirect-funded-account',
    [
      { kind: 'maxLoss', amount: by({ 25000: 1000, 50000: 2000, 100000: 3500, 150000: 5000 }), mode: 'eodTrailing', measure: 'equity', lockTrigger: by({ 25000: 26100, 50000: 52100, 100000: 103600, 150000: 155100 }), lockLevel: LUCID_LOCK },
      { kind: 'dailyLoss', amount: by({ 50000: 1200, 100000: 2100, 150000: 3000 }), reference: 'balanceAtReset', severity: 'soft', scaling: { pctOfPeakEodProfit: 0.6, afterBalance: by({ 25000: 26100, 50000: 52100, 100000: 103600, 150000: 155100 }) } },
      { kind: 'consistency', maxShare: 0.2, basis: 'totalProfit', effect: 'payout', note: '20% for payout eligibility; resets after each payout.' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Max loss limit EOD trailing with lock ($1,000/$2,000/$3,500/$5,000)', 'Soft DLL then LucidScale DLL (60% of highest EOD profit)', 'Consistency 20% for payouts', 'Max size'],
  ),
  lucid(
    'lucid-daily-eval',
    'LucidDaily',
    'Evaluation',
    'https://support.lucidtrading.com/en/articles/15996664-luciddaily-evaluation',
    [
      { kind: 'profitTarget', amount: LUCID_TARGET, requireFlat: false },
      { ...EOD_LOCK_MLL, optionKey: 'drawdown' } as Rule,
      { kind: 'dailyLoss', amount: by({ 25000: 600, 50000: 1200, 100000: 1800, 150000: 2700 }), reference: 'balanceAtReset', severity: 'soft', optional: 'dll' },
      { kind: 'consistency', maxShare: 0.5, basis: 'totalProfit', effect: 'pass' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Profit target', 'Max loss limit: end-of-day or intraday trailing (chosen at checkout), lock at initial + $100', 'Optional fixed DLL (soft)', 'Consistency ≤ 50% to pass', 'Max size'],
    {
      next: 'lucid-daily-funded',
      options: [
        { key: 'drawdown', label: 'Drawdown type (chosen at checkout)', type: 'select', values: [{ value: 'eod', label: 'End of day' }, { value: 'intraday', label: 'Intraday' }], default: 'eod' },
        { key: 'dll', label: 'Daily loss limit (chosen at checkout)', type: 'bool', default: false },
      ],
    },
  ),
  lucid(
    'lucid-daily-funded',
    'LucidDaily',
    'Funded',
    'https://support.lucidtrading.com/en/articles/15997244-luciddaily-funded-account',
    [
      { kind: 'maxLoss', amount: LUCID_MLL, mode: 'intradayTrailing', measure: 'equity', lockTrigger: LUCID_TRAIL, lockLevel: LUCID_LOCK },
      { kind: 'dailyLoss', amount: by({ 25000: 600, 50000: 1200, 100000: 1800, 150000: 2700 }), reference: 'balanceAtReset', severity: 'soft', optional: 'dll' },
      { kind: 'maxSize', micros: LUCID_MICROS },
    ],
    ['Max loss limit intraday trailing (real-time) with lock', 'Optional fixed DLL', 'No consistency on funded'],
    {
      options: [{ key: 'dll', label: 'Daily loss limit (chosen at checkout)', type: 'bool', default: false }],
      notImplemented: [...LUCID_COMMON_NOT_IMPLEMENTED, 'High-impact USD news rule (flat ±1 minute around “red folder” events) — no economic calendar data'],
    },
  ),
  lucid(
    'lucid-maxx-step1',
    'LucidMaxx (invite only)',
    'Step 1',
    'https://support.lucidtrading.com/en/articles/17327076-new-lucidmaxx-program',
    [
      { kind: 'profitTarget', amount: LUCID_TARGET, requireFlat: false },
      { kind: 'maxLoss', amount: LUCID_MLL, mode: 'eodTrailing', measure: 'equity' },
      { kind: 'consistency', maxShare: 0.4, basis: 'totalProfit', effect: 'pass' },
    ],
    ['Profit target', 'EOD max drawdown', 'Consistency 40%', 'No daily loss limit'],
    { next: 'lucid-maxx-step2', ambiguities: ['No lock mechanism is described for LucidMaxx; FuFu trails without a lock.', 'Max contract size is not stated.'] },
  ),
  lucid(
    'lucid-maxx-step2',
    'LucidMaxx (invite only)',
    'Step 2 (Pre-Live)',
    'https://support.lucidtrading.com/en/articles/17327076-new-lucidmaxx-program',
    [
      { kind: 'profitTarget', amount: by({ 25000: 1000, 50000: 2000, 100000: 3000, 150000: 4500 }), requireFlat: false },
      { kind: 'maxLoss', amount: LUCID_MLL, mode: 'eodTrailing', measure: 'equity' },
    ],
    ['Profit target', 'EOD max drawdown', 'No consistency, no DLL'],
    { ambiguities: ['No lock mechanism is described; FuFu trails without a lock.', 'The Live stage (static $100 MLL on real capital) is out of scope.'] },
  ),
];

export function profileById(id: string): RuleProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}

export function firms(): string[] {
  return [...new Set(PROFILES.map((p) => p.firm))];
}

/**
 * Resolve an amount for an account size. A standard size that is missing from a per-size table
 * means "no limit" (e.g. LucidPro 25K has no DLL); custom sizes are scaled from the nearest size.
 */
export function amountFor(a: Amount | undefined, size: number, standardSizes: number[] = []): number | null {
  if (!a) return null;
  if (a.pct !== undefined) return a.pct * size;
  const v = a.bySize?.[String(size)];
  if (v !== undefined) return v;
  if (standardSizes.includes(size)) return null;
  // custom size: scale linearly from the closest defined size
  const sizes = Object.keys(a.bySize || {}).map(Number);
  if (!sizes.length) return null;
  const nearest = sizes.reduce((b, s) => (Math.abs(s - size) < Math.abs(b - size) ? s : b), sizes[0]);
  return (a.bySize![String(nearest)] / nearest) * size;
}
