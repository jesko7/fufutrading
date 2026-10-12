import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { Ticker } from '../../shared/marketTypes';
import type { Market, SymbolId } from '../../shared/symbols';

/** Subscribe to a main-process topic for the lifetime of the component. */
export function useTopic<T>(topic: string | null, params: unknown, onData: (d: T) => void, deps: unknown[] = []): void {
  const cb = useRef(onData);
  cb.current = onData;
  useEffect(() => {
    if (!topic) return;
    return api.sub<T>(topic, params, (d) => cb.current(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, JSON.stringify(params), ...deps]);
}

/** Latest value of a topic as state (throttled to animation frames). */
export function useTopicValue<T>(topic: string | null, params: unknown, deps: unknown[] = []): T | null {
  const [v, setV] = useState<T | null>(null);
  const pending = useRef<T | null>(null);
  const raf = useRef(0);
  useTopic<T>(
    topic,
    params,
    (d) => {
      pending.current = d;
      if (!raf.current)
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          setV(pending.current);
        });
    },
    deps,
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return v;
}

// shared ticker cache so many components can use the same subscription
const tickerStore = new Map<string, { value: Ticker | null; listeners: Set<() => void>; unsub: (() => void) | null; refs: number }>();

function tickerEntry(symbol: SymbolId, market: Market) {
  const k = `${market}:${symbol}`;
  let e = tickerStore.get(k);
  if (!e) {
    e = { value: null, listeners: new Set(), unsub: null, refs: 0 };
    tickerStore.set(k, e);
  }
  return e;
}

export function useTicker(symbol: SymbolId, market: Market): Ticker | null {
  const e = tickerEntry(symbol, market);
  const subscribe = useCallback(
    (l: () => void) => {
      const ent = tickerEntry(symbol, market);
      ent.listeners.add(l);
      ent.refs++;
      if (!ent.unsub) {
        ent.unsub = api.sub<Ticker>('ticker', { symbol, market }, (t) => {
          ent.value = t;
          for (const x of ent.listeners) x();
        });
      }
      return () => {
        ent.listeners.delete(l);
        ent.refs--;
        if (ent.refs <= 0 && ent.unsub) {
          const u = ent.unsub;
          ent.unsub = null;
          setTimeout(() => {
            if (ent.refs <= 0) u();
            else ent.unsub = u;
          }, 3000);
        }
      };
    },
    [symbol, market],
  );
  return useSyncExternalStore(subscribe, () => e.value);
}

export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

/** Observe element size. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (s.width === Math.round(r.width) && s.height === Math.round(r.height) ? s : { width: Math.round(r.width), height: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`fufu:${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(`fufu:${key}`, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
