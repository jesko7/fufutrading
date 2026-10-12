/** Cross-module / cross-window event bus (local dispatch + relay through the main process). */
import { api } from '../api';

type Handler = (data: any, origin: string) => void;
const handlers = new Map<string, Set<Handler>>();
const origin = `${api.windowId}:${Math.random().toString(36).slice(2, 7)}`;

function dispatch(name: string, data: unknown, from: string): void {
  const set = handlers.get(name);
  if (set) for (const h of set) h(data, from);
}

api.on<{ name: string; data: unknown; origin: string }>('bus', (m) => {
  if (m.origin === origin) return;
  dispatch(m.name, m.data, m.origin);
});

let pending: { name: string; data: unknown } | null = null;
let raf = 0;

export const bus = {
  origin,
  emit(name: string, data: unknown, crossWindow = true): void {
    dispatch(name, data, origin);
    if (!crossWindow) return;
    // coalesce high-frequency events (e.g. crosshair) per animation frame
    if (name === 'crosshair') {
      pending = { name, data };
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending) void api.call('bus:emit', pending.name, pending.data, origin).catch(() => {});
          pending = null;
        });
      return;
    }
    void api.call('bus:emit', name, data, origin).catch(() => {});
  },
  on(name: string, h: Handler): () => void {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(h);
    return () => set!.delete(h);
  },
};
