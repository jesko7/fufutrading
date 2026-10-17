import { priceDecimals, qtyDecimals, type Market, type SymbolId } from '../../shared/symbols';

let tzMode: 'local' | 'utc' = 'local';
export function setTimezoneMode(m: 'local' | 'utc'): void {
  tzMode = m;
}
export function getTimezoneMode(): 'local' | 'utc' {
  return tzMode;
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number, compact = false): Intl.NumberFormat {
  const k = `${min}|${max}|${compact}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, ...(compact ? { notation: 'compact' } : {}) });
    nfCache.set(k, f);
  }
  return f;
}

export function fmtNum(v: number, decimals = 2, minDecimals = decimals): string {
  if (v === undefined || v === null || !isFinite(v)) return '—';
  return nf(Math.min(minDecimals, decimals), decimals).format(v);
}

export function fmtPrice(v: number, symbol?: SymbolId, market: Market = 'spot'): string {
  if (!isFinite(v)) return '—';
  const d = symbol ? priceDecimals(symbol, market) : autoDecimals(v);
  return fmtNum(v, d);
}

export function autoDecimals(v: number): number {
  const a = Math.abs(v);
  if (a >= 1000) return 2;
  if (a >= 100) return 2;
  if (a >= 1) return 3;
  if (a >= 0.01) return 4;
  if (a === 0) return 2;
  return 6;
}

export function fmtQty(v: number, symbol?: SymbolId, market: Market = 'spot'): string {
  if (!isFinite(v)) return '—';
  const d = symbol ? qtyDecimals(symbol, market) : 4;
  return fmtNum(v, d, 0);
}

/** The sign of `v` as shown with `s` (its formatted magnitude): none when it rounds to zero. */
function signOf(v: number, s: string, plus: boolean): string {
  if (!/[1-9]/.test(s)) return '';
  return v < 0 ? '−' : v > 0 && plus ? '+' : '';
}

export function fmtUsd(v: number, decimals = 2): string {
  if (!isFinite(v)) return '—';
  const s = fmtNum(Math.abs(v), decimals);
  return `${signOf(v, s, false)}$${s}`;
}

export function fmtSignedUsd(v: number, decimals = 2): string {
  if (!isFinite(v)) return '—';
  const s = fmtNum(Math.abs(v), decimals);
  return `${signOf(v, s, true)}$${s}`;
}

/** A number with its sign (+ for gains), no sign when it rounds to zero. */
export function fmtSigned(v: number, decimals = 2): string {
  if (!isFinite(v)) return '—';
  const s = fmtNum(Math.abs(v), decimals);
  return `${signOf(v, s, true)}${s}`;
}

export function fmtCompact(v: number): string {
  if (!isFinite(v)) return '—';
  return nf(0, 2, true).format(v);
}

export function fmtPct(v: number, decimals = 2, signed = true): string {
  if (!isFinite(v)) return '—';
  const s = fmtNum(Math.abs(v), decimals);
  return `${signOf(v, s, signed)}${s}%`;
}

function parts(t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const dt = new Date(t);
  if (tzMode === 'utc') return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(), wd: dt.getUTCDay() };
  return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds(), wd: dt.getDay() };
}
export { parts as timeParts };

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

export function fmtTime(t: number, withSeconds = false): string {
  const p = parts(t);
  return `${p2(p.h)}:${p2(p.mi)}${withSeconds ? `:${p2(p.s)}` : ''}`;
}

export function fmtDate(t: number): string {
  const p = parts(t);
  return `${p.d} ${MONTHS[p.mo]} ${p.y}`;
}

export function fmtDateShort(t: number): string {
  const p = parts(t);
  return `${p.d} ${MONTHS[p.mo]} '${String(p.y).slice(2)}`;
}

export function fmtDateTime(t: number, withSeconds = false): string {
  return `${fmtDate(t)} ${fmtTime(t, withSeconds)}`;
}

export function fmtIsoDate(t: number): string {
  const p = parts(t);
  return `${p.y}-${p2(p.mo + 1)}-${p2(p.d)}`;
}

export function fmtAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtDuration(ms: number): string {
  if (!isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clsx(...xs: (string | false | null | undefined | 0)[]): string {
  return xs.filter(Boolean).join(' ');
}

/** A strategy order id for people: internal ids show what they close (__close_Long → Long, __close_all → all). */
export function orderIdLabel(id: string): string {
  return id.replace(/^__\w+?_/, '');
}
