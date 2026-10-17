import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon, CoinIcon } from './Icon';
import { useApp } from '../state/store';
import { clsx } from '../lib/format';
import { SYMBOLS, SYMBOL_SPECS, type Market, type SymbolId } from '../../shared/symbols';
import { parseTimeframe, tfToString, tfLongLabel, QUICK_TIMEFRAMES, STANDARD_TIMEFRAMES } from '../../shared/timeframes';

// ------------------------------------------------------------------------- popover / menu

export interface Anchor {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export function anchorOf(el: Element | null): Anchor {
  if (!el) return { x: 100, y: 100 };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Open popovers, oldest first: a click inside one opened later (a menu from a popover's row) keeps the earlier ones open. */
const popoverStack: HTMLElement[] = [];

export function Popover({ anchor, onClose, children, align = 'start', width, className, style }: { anchor: Anchor; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    popoverStack.push(el);
    return () => {
      const k = popoverStack.indexOf(el);
      if (k >= 0) popoverStack.splice(k, 1);
    };
  }, []);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y + (anchor.h || 0) + 4 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === 'end' ? anchor.x + (anchor.w || 0) - r.width : anchor.x;
    let top = anchor.y + (anchor.h || 0) + 4;
    if (left + r.width > window.innerWidth - 6) left = window.innerWidth - r.width - 6;
    if (left < 6) left = 6;
    if (top + r.height > window.innerHeight - 6) top = Math.max(6, anchor.y - r.height - 4);
    setPos({ left, top });
  }, [anchor.x, anchor.y, anchor.w, anchor.h, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el || el.contains(e.target as Node)) return;
      const above = popoverStack.slice(popoverStack.indexOf(el) + 1);
      if (above.some((p) => p.contains(e.target as Node))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onDown, true), 0);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={clsx('popover', className)} style={{ left: pos.left, top: pos.top, width, ...style }} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemSpec {
  label?: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onClick?: () => void;
  sep?: boolean;
  title?: string;
}

export function Menu({ anchor, items, onClose, align, width }: { anchor: Anchor; items: MenuItemSpec[]; onClose: () => void; align?: 'start' | 'end'; width?: number }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} width={width}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : it.title ? (
          <div key={i} className="menu-title">
            {it.title}
          </div>
        ) : (
          <div
            key={i}
            className={clsx('menu-item', it.danger && 'danger', it.disabled && 'disabled')}
            aria-disabled={it.disabled || undefined}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick?.();
            }}
          >
            {it.checked !== undefined ? <Icon name="check" size={14} style={{ opacity: it.checked ? 1 : 0 }} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}
            <span>{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </div>
        ),
      )}
    </Popover>
  );
}

/** Hook: [open, anchor, toggle(el), close] */
export function usePopover(): { anchor: Anchor | null; open: (el: Element | null) => void; close: () => void; toggle: (el: Element | null) => void } {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return {
    anchor,
    open: (el) => setAnchor(anchorOf(el)),
    close: () => setAnchor(null),
    toggle: (el) => setAnchor((a) => (a ? null : anchorOf(el))),
  };
}

// ------------------------------------------------------------------------- modal

export function Modal({ title, onClose, children, footer, width, icon }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; icon?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined} role="dialog">
        <div className="modal-head">
          {icon && <Icon name={icon} size={18} />}
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function openModal(id: string, render: (close: () => void) => ReactNode): void {
  useApp.getState().openModal({ id, render });
}

export function confirmDialog(opts: { title: string; body: ReactNode; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-${Date.now()}`;
    openModal(id, (close) => (
      <Modal
        title={opts.title}
        onClose={() => {
          close();
          resolve(false);
        }}
        width={420}
        footer={
          <>
            <button
              className="btn"
              onClick={() => {
                close();
                resolve(false);
              }}
            >
              Cancel
            </button>
            <button
              className={clsx('btn', opts.danger ? 'sell' : 'primary')}
              autoFocus
              onClick={() => {
                close();
                resolve(true);
              }}
            >
              {opts.confirm || 'Confirm'}
            </button>
          </>
        }
      >
        <div className="muted" style={{ lineHeight: 1.5 }}>
          {opts.body}
        </div>
      </Modal>
    ));
  });
}

export function promptDialog(opts: { title: string; label?: string; initial?: string; confirm?: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const id = `prompt-${Date.now()}`;
    function Body({ close }: { close: () => void }) {
      const [v, setV] = useState(opts.initial || '');
      const done = (val: string | null) => {
        close();
        resolve(val);
      };
      return (
        <Modal
          title={opts.title}
          onClose={() => done(null)}
          width={420}
          footer={
            <>
              <button className="btn" onClick={() => done(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => done(v.trim() || null)} disabled={!v.trim()}>
                {opts.confirm || 'OK'}
              </button>
            </>
          }
        >
          <div className="field">
            {opts.label && <label>{opts.label}</label>}
            <input className="input" autoFocus value={v} placeholder={opts.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && done(v.trim())} />
          </div>
        </Modal>
      );
    }
    openModal(id, (close) => <Body close={close} />);
  });
}

export function ModalHost() {
  const modals = useApp((s) => s.modals);
  const closeModal = useApp((s) => s.closeModal);
  return (
    <>
      {modals.map((m) => (
        <div key={m.id}>{m.render(() => closeModal(m.id))}</div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------------- controls

export function Segmented<T extends string | number>({ value, options, onChange, className, size }: { value: T; options: { value: T; label: ReactNode; title?: string; cls?: string }[]; onChange: (v: T) => void; className?: string; size?: 'sm' }) {
  return (
    <div className={clsx('seg', className)} style={size === 'sm' ? { transform: 'scale(0.96)' } : undefined}>
      {options.map((o) => (
        <button key={String(o.value)} className={clsx(o.value === value && 'on', o.cls)} onClick={() => onChange(o.value)} data-tip={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ value, onChange, title }: { value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={clsx('toggle', value && 'on')} onClick={() => onChange(!value)} role="switch" aria-checked={value} data-tip={title} />;
}

/** A drop-down; `placeholder` shows while nothing is chosen and is not itself a choice. */
export function Select<T extends string>({ value, options, onChange, style, title, placeholder }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; style?: CSSProperties; title?: string; placeholder?: string }) {
  const empty = placeholder !== undefined && !options.some((o) => o.value === value);
  return (
    <select className={clsx('select', empty && 'placeholder')} value={empty ? '' : value} onChange={(e) => onChange(e.target.value as T)} style={style} data-tip={title}>
      {placeholder !== undefined && (
        <option value="" disabled hidden>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A number input (arrow keys step); it reports on blur and Enter, or with `live` on every valid keystroke (for previews that follow the typing). */
export function NumberField({ value, onChange, step = 1, min, max, decimals, style, suffix, placeholder, disabled, live }: { value: number | null; onChange: (v: number) => void; step?: number; min?: number; max?: number; decimals?: number; style?: CSSProperties; suffix?: string; placeholder?: string; disabled?: boolean; live?: boolean }) {
  const fmt = (v: number | null) => (v === null || !isFinite(v) ? '' : decimals !== undefined ? v.toFixed(decimals) : String(v));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals]);
  const parse = (t: string): number | null => {
    let v = parseFloat(t.replace(/,/g, ''));
    if (!isFinite(v)) return null;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const commit = (t: string) => {
    const v = parse(t);
    if (v === null) {
      setText(fmt(value));
      return;
    }
    onChange(v);
    setText(fmt(v));
  };
  return (
    <div style={{ position: 'relative', display: 'flex', ...style }}>
      <input
        className="input num"
        // room for the unit: "%" or "min" as well as "USDT" or "s pause"
        style={{ width: '100%', paddingRight: suffix ? 14 + Math.ceil(suffix.length * 6.2) : undefined }}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          // the text stays as typed while focused; blur formats it
          const v = live ? parse(e.target.value) : null;
          if (v !== null && v !== value) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const cur = parseFloat(text) || 0;
            const nv = +(cur + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1)).toFixed(10);
            commit(String(nv));
          }
        }}
      />
      {suffix && <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', fontSize: 11, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{suffix}</span>}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode; badge?: ReactNode }[]; onChange: (v: T) => void }) {
  // narrow modules: the row scrolls sideways (wheel too) and keeps the active tab in view
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const on = el?.querySelector<HTMLElement>('.tab.on');
    if (el && on && el.scrollWidth > el.clientWidth) {
      if (on.offsetLeft < el.scrollLeft) el.scrollLeft = on.offsetLeft - 8;
      else if (on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = on.offsetLeft + on.offsetWidth - el.clientWidth + 8;
    }
  }, [value]);
  return (
    <div
      className="tabs"
      ref={ref}
      onWheel={(e) => {
        const el = ref.current;
        if (el && el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t) => (
        <button key={t.value} className={clsx('tab', t.value === value && 'on')} onClick={() => onChange(t.value)}>
          {t.label}
          {t.badge !== undefined && t.badge !== null && <span className="badge" style={{ marginLeft: 6 }}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, style }: { label: ReactNode; hint?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="field" style={style}>
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Empty({ icon, title, children }: { icon?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={26} stroke={1.4} />}
      <div className="empty-title">{title}</div>
      {children && <div style={{ maxWidth: 380, lineHeight: 1.5 }}>{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------- tooltips (global, via data-tip)

export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: Element | null = null;
    const over = (e: MouseEvent) => {
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (el === current) return;
      current = el;
      if (timer) clearTimeout(timer);
      setTip(null);
      if (!el) return;
      const text = el.getAttribute('data-tip');
      if (!text) return;
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ text, x: Math.min(window.innerWidth - 200, Math.max(6, r.left + r.width / 2 - 60)), y: r.bottom + 6 > window.innerHeight - 40 ? r.top - 30 : r.bottom + 6 });
      }, 450);
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      current = null;
      setTip(null);
    };
    window.addEventListener('mouseover', over);
    window.addEventListener('mousedown', hide);
    window.addEventListener('wheel', hide, { passive: true });
    return () => {
      window.removeEventListener('mouseover', over);
      window.removeEventListener('mousedown', hide);
      window.removeEventListener('wheel', hide);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div className="tip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const color = (k?: string) => (k === 'ok' ? 'var(--ok)' : k === 'warn' ? 'var(--warn)' : k === 'error' ? 'var(--danger)' : 'var(--info)');
  return createPortal(
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span className="dot" style={{ background: color(t.kind), marginTop: 5 }} />
          <div className="grow">
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
            {t.action && (
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => (t.action!.run(), dismiss(t.id))}>
                {t.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn small" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------- instrument pickers

export function SymbolPicker({ symbol, market, onChange, showMarket = true }: { symbol: SymbolId; market: Market; onChange: (s: SymbolId, m: Market) => void; showMarket?: boolean }) {
  const pop = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className="sym-btn" onClick={() => pop.toggle(ref.current)} data-tip="Change instrument (Alt+1/2/3)">
        <CoinIcon symbol={symbol} />
        <span>{SYMBOL_SPECS[symbol].base}</span>
        {showMarket && market === 'futures' && <span className="badge accent">PERP</span>}
        <Icon name="chevDown" size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={230}>
          {(['spot', 'futures'] as Market[]).map((m) => (
            <div key={m}>
              <div className="menu-title">{m === 'spot' ? 'Spot' : 'USDⓈ-M Perpetual'}</div>
              {SYMBOLS.map((s) => (
                <div
                  key={s}
                  className={clsx('menu-item', s === symbol && m === market && 'hl')}
                  onClick={() => {
                    pop.close();
                    onChange(s, m);
                  }}
                >
                  <CoinIcon symbol={s} />
                  <span style={{ fontWeight: 600 }}>{SYMBOL_SPECS[s].base}</span>
                  <span className="faint">{SYMBOL_SPECS[s].name}</span>
                  <span className="menu-hint">{m === 'futures' ? 'PERP' : 'USDT'}</span>
                </div>
              ))}
            </div>
          ))}
        </Popover>
      )}
    </>
  );
}

export function TimeframePicker({ tf, onChange, quick = QUICK_TIMEFRAMES }: { tf: string; onChange: (tf: string) => void; quick?: string[] }) {
  const pop = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  const [custom, setCustom] = useState('');
  const parsed = parseTimeframe(custom);
  const inQuick = quick.includes(tf);
  return (
    <>
      <div className="row" style={{ gap: 1 }}>
        {quick.map((q) => (
          <button key={q} className={clsx('tab', q === tf && 'on')} style={{ height: 24, padding: '0 7px', fontSize: 12 }} onClick={() => onChange(q)}>
            {q}
          </button>
        ))}
        <button ref={ref} className={clsx('tab', !inQuick && 'on')} style={{ height: 24, padding: '0 6px', fontSize: 12 }} onClick={() => pop.toggle(ref.current)} data-tip="More / custom timeframes">
          {!inQuick ? tf : ''}
          <Icon name="chevDown" size={12} />
        </button>
      </div>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240}>
          <div style={{ padding: 6 }}>
            <input
              className="input"
              autoFocus
              placeholder="Custom: 30s, 7m, 90m, 5D…"
              style={{ width: '100%' }}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && parsed) {
                  onChange(tfToString(parsed));
                  pop.close();
                }
              }}
            />
            <div className="hint" style={{ marginTop: 4, minHeight: 15 }}>
              {custom ? (parsed ? `${tfLongLabel(parsed)} — press Enter` : 'Not a valid timeframe') : 'Any multiple of s, m, h, D, W, M'}
            </div>
          </div>
          <div className="menu-sep" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, padding: 4 }}>
            {STANDARD_TIMEFRAMES.map((s) => (
              <button
                key={s}
                className={clsx('tab', s === tf && 'on')}
                style={{ fontSize: 12 }}
                onClick={() => {
                  onChange(s);
                  pop.close();
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
