/**
 * Preload bridge (sandboxed). Exposes a minimal, typed-at-the-edges API as window.fufu.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Listener = (data: any) => void;
const subs = new Map<number, Listener>();
const events = new Map<string, Set<Listener>>();
let nextId = 1;

ipcRenderer.on('push', (_e, batch: [number, unknown][]) => {
  for (const [id, data] of batch) {
    const cb = subs.get(id);
    if (cb) {
      try {
        cb(data);
      } catch (err) {
        console.error('subscription handler error', err);
      }
    }
  }
});

ipcRenderer.on('event', (_e, name: string, data: unknown) => {
  const set = events.get(name);
  if (set) for (const cb of set) cb(data);
});

const params = new URLSearchParams(globalThis.location?.search || '');

contextBridge.exposeInMainWorld('fufu', {
  windowId: params.get('w') || 'main',
  platform: process.platform,
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('rpc', method, args),
  subscribe: (topic: string, p: unknown, cb: Listener) => {
    const id = nextId++;
    subs.set(id, cb);
    ipcRenderer.send('sub', id, topic, p);
    return () => {
      if (!subs.has(id)) return;
      subs.delete(id);
      ipcRenderer.send('unsub', id);
    };
  },
  on: (name: string, cb: Listener) => {
    let set = events.get(name);
    if (!set) {
      set = new Set();
      events.set(name, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  },
});
