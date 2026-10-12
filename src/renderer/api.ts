/** Thin client over the preload bridge (window.fufu). */

interface Bridge {
  windowId: string;
  platform: string;
  invoke(method: string, ...args: unknown[]): Promise<any>;
  subscribe(topic: string, params: unknown, cb: (data: any) => void): () => void;
  on(name: string, cb: (data: any) => void): () => void;
}

declare global {
  interface Window {
    fufu: Bridge;
  }
}

const bridge: Bridge =
  typeof window !== 'undefined' && window.fufu
    ? window.fufu
    : {
        windowId: 'main',
        platform: 'unknown',
        invoke: async () => {
          throw new Error('Not running inside FuFu Trading');
        },
        subscribe: () => () => {},
        on: () => () => {},
      };

export const api = {
  windowId: bridge.windowId,
  platform: bridge.platform,
  call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    return bridge.invoke(method, ...args) as Promise<T>;
  },
  sub<T = any>(topic: string, params: unknown, cb: (data: T) => void): () => void {
    return bridge.subscribe(topic, params, cb as (d: any) => void);
  },
  on<T = any>(event: string, cb: (data: T) => void): () => void {
    return bridge.on(event, cb as (d: any) => void);
  },
};

export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // strip Electron's "Error invoking remote method 'rpc': Error: " prefix
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
