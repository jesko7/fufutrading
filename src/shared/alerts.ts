/** Alert definitions shared by the alert engine (main) and the Alerts UI. */
import type { Market, SymbolId } from './symbols';
import { SYMBOL_SPECS } from './symbols';

export type AlertKind = 'price' | 'move' | 'indicator' | 'script' | 'book';
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

export interface PriceAlert extends AlertBase {
  kind: 'price';
  condition: CrossCondition | 'enterChannel' | 'exitChannel';
  level: number;
  /** Upper bound for channel conditions. */
  level2?: number;
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

export type Alert = PriceAlert | MoveAlert | IndicatorAlert | ScriptAlert | BookAlert;

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
  }
}

/** Fill a message template. */
export function renderMessage(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}
