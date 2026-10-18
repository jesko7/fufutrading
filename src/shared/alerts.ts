/** Alert definitions shared by the alert engine (main) and the Alerts UI. */
import type { Market, SymbolId } from './symbols';
import { SYMBOL_SPECS } from './symbols';

export type AlertKind = 'price' | 'move' | 'indicator' | 'script' | 'book' | 'futures' | 'options' | 'news';
export type AlertFrequency = 'once' | 'perBar' | 'perMinute' | 'every';
export type CrossCondition = 'crossesAbove' | 'crossesBelow' | 'crosses' | 'above' | 'below';

interface AlertBase {
  id: string;
  /** Optional user label; the description is used when empty. */
  name: string;
  kind: AlertKind;
  symbol: SymbolId;
  market: Market;
  enabled: boolean;
  frequency: AlertFrequency;
  /** Minimum seconds between two triggers ('every'). */
  cooldownSec: number;
  expiresAt?: number | null;
  /** Message template: {{symbol}} {{price}} {{value}} {{name}} {{time}} {{message}}. */
  message?: string;
  /** webhook: POST the message to this http(s) URL when the alert fires (like TradingView's webhook URL). */
  notify: { desktop: boolean; sound: boolean; webhook?: string };
  created: number;
  updated: number;
  lastTriggered?: number;
  triggerCount: number;
  status: 'active' | 'triggered' | 'expired' | 'error' | 'disabled';
  error?: string;
}

/**
 * A trendline the alert level follows (alerts on chart drawings, like TradingView's): two points
 * (time, price), straight in log space when drawn on a log chart. `extend: 'none'` ends at the
 * later point (a segment), 'right' continues into the future (rays, extended lines).
 */
export interface AlertLine {
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  log?: boolean;
  extend: 'right' | 'none';
}

export interface PriceAlert extends AlertBase {
  kind: 'price';
  condition: CrossCondition | 'enterChannel' | 'exitChannel';
  /** The level (for a trendline: its price when the alert was saved). */
  level: number;
  /** Upper bound for channel conditions. */
  level2?: number;
  /** Follow a trendline instead of a fixed level. */
  line?: AlertLine;
}

/** The alert level at time `t`: the fixed level, or the trendline's price (null when the segment has ended). */
export function priceLevelAt(a: Pick<PriceAlert, 'level' | 'line'>, t: number): number | null {
  const L = a.line;
  if (!L) return a.level;
  if (L.extend === 'none' && t > Math.max(L.t1, L.t2)) return null;
  if (L.t2 === L.t1) return L.p2;
  const f = (t - L.t1) / (L.t2 - L.t1);
  return L.log && L.p1 > 0 && L.p2 > 0 ? L.p1 * Math.pow(L.p2 / L.p1, f) : L.p1 + (L.p2 - L.p1) * f;
}

export interface MoveAlert extends AlertBase {
  kind: 'move';
  direction: 'up' | 'down' | 'either';
  pct: number;
  minutes: number;
}

interface ScriptRef {
  scriptId: string;
  scriptName?: string;
  inputs: Record<string, unknown>;
  tf: string;
  chartType: 'candles' | 'heikinashi';
  /** Evaluate on closed bars only (no intrabar signals). */
  onBarClose: boolean;
}

export interface IndicatorAlert extends AlertBase, ScriptRef {
  kind: 'indicator';
  /** Plot id (or title). */
  plot: string;
  plotTitle?: string;
  condition: CrossCondition;
  target: { type: 'value'; value: number } | { type: 'plot'; plot: string; title?: string } | { type: 'price' };
}

export interface ScriptAlert extends AlertBase, ScriptRef {
  kind: 'script';
  trigger: { type: 'alertcondition'; title: string } | { type: 'alert' } | { type: 'orders' };
}

export type BookMetric = 'imbalance' | 'bidDepth' | 'askDepth' | 'spreadBps' | 'largeOrder';

export interface BookAlert extends AlertBase {
  kind: 'book';
  metric: BookMetric;
  condition: 'above' | 'below';
  /** imbalance in % (−100…100), depth in USDT, spread in basis points, large order in USDT. */
  value: number;
  /** Price range around the mid (in %) the metric looks at. */
  rangePct: number;
  /** The condition must hold this long before the alert fires. */
  sustainSec: number;
}

export type FuturesMetric = 'funding' | 'oiChange' | 'liquidations' | 'longShortRatio';

/** Alerts on Binance futures data: funding, open interest changes, liquidations, long/short ratio. */
export interface FuturesAlert extends AlertBase {
  kind: 'futures';
  metric: FuturesMetric;
  /** funding and ratio: above/below; open interest: up/down/either; liquidations: longs/shorts/either. */
  condition: 'above' | 'below' | 'up' | 'down' | 'either' | 'longs' | 'shorts';
  /** Funding in % per period, the ratio, the open interest change in %, liquidations in USDT. */
  value: number;
  /** Window for open interest changes and liquidations, minutes. */
  minutes: number;
}

export type OptionsMetric = 'iv30' | 'skew' | 'putCall' | 'level';
export type OptionsLevel = 'flip' | 'maxPain' | 'callWall' | 'putWall';

/** Alerts on Binance's options on the coin: 30-day implied volatility, skew, put/call open interest, the index against an options level. */
export interface OptionsAlert extends AlertBase {
  kind: 'options';
  metric: OptionsMetric;
  /** Figures: above/below the value. Levels: the index crosses (or is above/below) the level. */
  condition: 'above' | 'below' | 'crosses';
  /** 30-day IV in %, 25-delta risk reversal at 30 days in volatility points, the put/call ratio. */
  value: number;
  level?: OptionsLevel;
}

/** Which headlines about the coin: those Claude rates bullish or bearish (or either), or any new one. */
export type NewsMood = 'bullish' | 'bearish' | 'either' | 'any';

/** New headlines about the coin, by Claude's rating in the News module, optionally with keywords. */
export interface NewsAlert extends AlertBase {
  kind: 'news';
  mood: NewsMood;
  /** Comma-separated words; a headline (or its summary) must mention one of them. */
  keywords?: string;
}

export type Alert = PriceAlert | MoveAlert | IndicatorAlert | ScriptAlert | BookAlert | FuturesAlert | OptionsAlert | NewsAlert;

/** Whether a headline is one a news alert asks for (`mood`: Claude's rating, if any). */
export function newsMatches(a: Pick<NewsAlert, 'symbol' | 'mood' | 'keywords'>, it: { title: string; summary: string; coins: string[] }, mood?: 'bullish' | 'bearish' | 'neutral'): boolean {
  if (!it.coins.includes(SYMBOL_SPECS[a.symbol].base)) return false;
  const words = (a.keywords || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (words.length) {
    const text = `${it.title} ${it.summary}`.toLowerCase();
    if (!words.some((w) => text.includes(w))) return false;
  }
  if (a.mood === 'any') return true;
  if (a.mood === 'either') return mood === 'bullish' || mood === 'bearish';
  return mood === a.mood;
}

export const OPTIONS_LEVEL_LABEL: Record<OptionsLevel, string> = { flip: 'the gamma flip', maxPain: 'max pain', callWall: 'the call wall', putWall: 'the put wall' };

export interface AlertEvent {
  id: string;
  alertId: string;
  name: string;
  kind: AlertKind;
  symbol: SymbolId;
  market: Market;
  t: number;
  message: string;
  price?: number;
  value?: number;
  /** Delivery to the webhook URL, when one is set. */
  webhook?: { ok: boolean; status?: number; error?: string; ms?: number };
}

/** Why a webhook URL can't be used (null = fine). */
export function webhookUrlError(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return 'Use an http:// or https:// URL';
    return null;
  } catch {
    return 'Not a valid URL';
  }
}

/** Body and content type of a webhook request: JSON when the message is valid JSON, else plain text. */
export function webhookBody(message: string): { body: string; contentType: string } {
  const m = message.trim();
  if ((m.startsWith('{') && m.endsWith('}')) || (m.startsWith('[') && m.endsWith(']'))) {
    try {
      JSON.parse(m);
      return { body: m, contentType: 'application/json' };
    } catch {
      /* not JSON */
    }
  }
  return { body: message, contentType: 'text/plain; charset=utf-8' };
}

const COND: Record<string, string> = {
  crossesAbove: 'crosses above',
  crossesBelow: 'crosses below',
  crosses: 'crosses',
  above: 'is above',
  below: 'is below',
  enterChannel: 'enters',
  exitChannel: 'exits',
};

function num(v: number): string {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 2 : a >= 1 ? 4 : 6 });
}

export function instrumentLabel(symbol: SymbolId, market: Market): string {
  const s = SYMBOL_SPECS[symbol];
  return `${s.base}/${s.quote}${market === 'futures' ? ' Perp' : ''}`;
}

/** One-line human description of an alert's condition. */
export function describeAlert(a: Alert): string {
  const ins = instrumentLabel(a.symbol, a.market);
  switch (a.kind) {
    case 'price':
      if (a.line) return `${ins} ${COND[a.condition]} the trendline ${num(a.line.p1)} → ${num(a.line.p2)}${a.line.extend === 'right' ? ' (extended)' : ''}`;
      if (a.condition === 'enterChannel' || a.condition === 'exitChannel') return `${ins} ${COND[a.condition]} ${num(a.level)} – ${num(a.level2 ?? a.level)}`;
      return `${ins} ${COND[a.condition]} ${num(a.level)}`;
    case 'move':
      return `${ins} moves ${a.direction === 'up' ? 'up' : a.direction === 'down' ? 'down' : ''} ${a.pct}% within ${a.minutes} min`.replace('  ', ' ');
    case 'indicator': {
      const tgt = a.target.type === 'value' ? num(a.target.value) : a.target.type === 'price' ? 'price' : a.target.title || a.target.plot;
      return `${a.scriptName || 'Indicator'} · ${a.plotTitle || a.plot} ${COND[a.condition]} ${tgt} (${ins} ${a.tf}${a.onBarClose ? ', bar close' : ''})`;
    }
    case 'script': {
      const what = a.trigger.type === 'alertcondition' ? `“${a.trigger.title}”` : a.trigger.type === 'alert' ? 'alert() messages' : 'strategy orders';
      return `${a.scriptName || 'Script'} · ${what} (${ins} ${a.tf}${a.onBarClose ? ', bar close' : ''})`;
    }
    case 'futures': {
      const p = `${SYMBOL_SPECS[a.symbol].base} perp`;
      switch (a.metric) {
        case 'funding':
          return `${p} funding is ${a.condition === 'below' ? 'below' : 'above'} ${a.value}%`;
        case 'longShortRatio':
          return `${p} long/short ratio is ${a.condition === 'below' ? 'below' : 'above'} ${a.value}`;
        case 'oiChange':
          return `${p} open interest ${a.condition === 'up' ? 'rises' : a.condition === 'down' ? 'falls' : 'moves'} ${a.value}% within ${a.minutes} min`;
        case 'liquidations':
          return `${p} ${a.condition === 'longs' ? 'long' : a.condition === 'shorts' ? 'short' : ''} liquidations reach $${num(a.value)} within ${a.minutes} min`.replace('  ', ' ');
      }
      return p;
    }
    case 'options': {
      const b = `${SYMBOL_SPECS[a.symbol].base} options`;
      const cmp = a.condition === 'below' ? 'below' : 'above';
      switch (a.metric) {
        case 'iv30':
          return `${b}: 30-day implied volatility is ${cmp} ${a.value}%`;
        case 'skew':
          return `${b}: 25Δ skew (30 days) is ${cmp} ${a.value > 0 ? '+' : ''}${a.value} pts`;
        case 'putCall':
          return `${b}: put/call open interest is ${cmp} ${a.value}`;
        case 'level':
          return `${SYMBOL_SPECS[a.symbol].base} index ${a.condition === 'crosses' ? 'crosses' : `is ${cmp}`} ${OPTIONS_LEVEL_LABEL[a.level || 'flip']}`;
      }
      return b;
    }
    case 'news': {
      const what = a.mood === 'any' ? 'a new headline' : a.mood === 'either' ? 'a bullish or bearish headline' : `a ${a.mood} headline`;
      const kw = (a.keywords || '').trim();
      return `${SYMBOL_SPECS[a.symbol].base} news: ${what}${kw ? ` mentioning ${kw.split(',').map((w) => `“${w.trim()}”`).filter((w) => w !== '“”').join(' or ')}` : ''}`;
    }
    case 'book': {
      const unit = a.metric === 'imbalance' ? '%' : a.metric === 'spreadBps' ? ' bps' : ' USDT';
      const m = a.metric === 'imbalance' ? `order-book imbalance (±${a.rangePct}%)` : a.metric === 'bidDepth' ? `bid liquidity within ${a.rangePct}%` : a.metric === 'askDepth' ? `ask liquidity within ${a.rangePct}%` : a.metric === 'spreadBps' ? 'spread' : `a resting order within ${a.rangePct}%`;
      if (a.metric === 'largeOrder') return `${ins} ${m} ≥ ${num(a.value)} USDT`;
      return `${ins} ${m} ${a.condition === 'above' ? '>' : '<'} ${num(a.value)}${unit}${a.sustainSec ? ` for ${a.sustainSec}s` : ''}`;
    }
  }
}

export function alertTitle(a: Alert): string {
  return a.name?.trim() || describeAlert(a);
}

/** Defaults for a new alert of a kind. */
export function newAlert(kind: AlertKind, symbol: SymbolId, market: Market, extra: Partial<Alert> = {}): Alert {
  const base = { id: '', name: '', symbol, market, enabled: true, frequency: 'once' as AlertFrequency, cooldownSec: 60, expiresAt: null, message: '', notify: { desktop: true, sound: true }, created: 0, updated: 0, triggerCount: 0, status: 'active' as const };
  switch (kind) {
    case 'price':
      return { ...base, kind, condition: 'crosses', level: 0, ...extra } as PriceAlert;
    case 'move':
      return { ...base, kind, direction: 'either', pct: 2, minutes: 15, frequency: 'every', cooldownSec: 900, ...extra } as MoveAlert;
    case 'indicator':
      return { ...base, kind, scriptId: '', inputs: {}, tf: '15m', chartType: 'candles', onBarClose: true, plot: '', condition: 'crossesAbove', target: { type: 'value', value: 0 }, frequency: 'perBar', ...extra } as IndicatorAlert;
    case 'script':
      return { ...base, kind, scriptId: '', inputs: {}, tf: '15m', chartType: 'candles', onBarClose: true, trigger: { type: 'alert' }, frequency: 'every', cooldownSec: 0, ...extra } as ScriptAlert;
    case 'book':
      return { ...base, kind, metric: 'imbalance', condition: 'above', value: 40, rangePct: 0.5, sustainSec: 10, frequency: 'every', cooldownSec: 300, ...extra } as BookAlert;
    case 'futures':
      return { ...base, kind, market: 'futures', metric: 'liquidations', condition: 'either', value: 1000000, minutes: 5, frequency: 'every', cooldownSec: 300, ...extra } as FuturesAlert;
    case 'options':
      return { ...base, kind, market: 'spot', metric: 'iv30', condition: 'above', value: 60, level: 'flip', frequency: 'every', cooldownSec: 3600, ...extra } as OptionsAlert;
    case 'news':
      return { ...base, kind, market: 'spot', mood: 'bearish', keywords: '', frequency: 'every', cooldownSec: 0, ...extra } as NewsAlert;
  }
}

/** Fill a message template. */
export function renderMessage(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}
