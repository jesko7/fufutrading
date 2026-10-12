/**
 * IPC router: request/response RPC plus push subscriptions ("topics").
 * Push messages are batched per renderer and flushed on the next macrotask, which keeps
 * latency in the sub-millisecond range while collapsing bursts (e.g. trade storms) into one
 * IPC message.
 */
import { ipcMain, webContents, type WebContents } from 'electron';
import type { Logger } from './logger';

export interface RpcContext {
  sender: WebContents;
  windowId: string;
}

export type RpcHandler = (args: any[], ctx: RpcContext) => unknown | Promise<unknown>;
export type Push = (data: unknown) => void;
export type TopicHandler = (params: any, push: Push, ctx: RpcContext) => (() => void) | Promise<() => void>;

export class IpcRouter {
  private rpc = new Map<string, RpcHandler>();
  private topics = new Map<string, TopicHandler>();
  private subs = new Map<number, Map<number, () => void>>();
  private queues = new Map<number, { wc: WebContents; batch: [number, unknown][]; scheduled: boolean }>();
  private windowIds = new Map<number, string>();

  constructor(private log: Logger) {}

  handle(method: string, fn: RpcHandler): void {
    this.rpc.set(method, fn);
  }

  /** Register many handlers with a prefix: handleAll('series', {loadMore: ...}) => 'series:loadMore'. */
  handleAll(prefix: string, fns: Record<string, RpcHandler>): void {
    for (const [k, fn] of Object.entries(fns)) this.handle(`${prefix}:${k}`, fn);
  }

  topic(name: string, fn: TopicHandler): void {
    this.topics.set(name, fn);
  }

  setWindowId(wc: WebContents, id: string): void {
    this.windowIds.set(wc.id, id);
  }

  private ctxOf(wc: WebContents): RpcContext {
    return { sender: wc, windowId: this.windowIds.get(wc.id) || 'main' };
  }

  install(): void {
    ipcMain.handle('rpc', async (e, method: string, args: any[]) => {
      const fn = this.rpc.get(method);
      if (!fn) throw new Error(`Unknown method ${method}`);
      try {
        return await fn(args || [], this.ctxOf(e.sender));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/^(Cancelled|Validation)/.test(msg)) this.log('warn', `rpc ${method} failed: ${msg}`);
        throw err;
      }
    });
    ipcMain.on('sub', async (e, id: number, topic: string, params: unknown) => {
      const wc = e.sender;
      const fn = this.topics.get(topic);
      if (!fn) {
        this.log('warn', `unknown topic ${topic}`);
        return;
      }
      let map = this.subs.get(wc.id);
      if (!map) {
        map = new Map();
        this.subs.set(wc.id, map);
        wc.once('destroyed', () => this.dropAll(wc.id));
      }
      const push: Push = (data) => this.enqueue(wc, id, data);
      try {
        // placeholder so an early unsub is honoured
        let cancelled = false;
        map.set(id, () => {
          cancelled = true;
        });
        const unsub = await fn(params, push, this.ctxOf(wc));
        if (cancelled || wc.isDestroyed()) {
          unsub();
          return;
        }
        map.set(id, unsub);
      } catch (err) {
        this.log('warn', `topic ${topic} failed: ${(err as Error).message}`);
        push({ __error: (err as Error).message });
      }
    });
    ipcMain.on('unsub', (e, id: number) => {
      const map = this.subs.get(e.sender.id);
      const fn = map?.get(id);
      if (fn) {
        map!.delete(id);
        try {
          fn();
        } catch (err) {
          this.log('warn', `unsub failed: ${(err as Error).message}`);
        }
      }
    });
  }

  private dropAll(wcId: number): void {
    const map = this.subs.get(wcId);
    if (map) for (const fn of map.values()) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.subs.delete(wcId);
    this.queues.delete(wcId);
    this.windowIds.delete(wcId);
  }

  private enqueue(wc: WebContents, id: number, data: unknown): void {
    if (wc.isDestroyed()) return;
    let q = this.queues.get(wc.id);
    if (!q) {
      q = { wc, batch: [], scheduled: false };
      this.queues.set(wc.id, q);
    }
    q.batch.push([id, data]);
    if (!q.scheduled) {
      q.scheduled = true;
      const qq = q;
      setImmediate(() => {
        qq.scheduled = false;
        const batch = qq.batch;
        qq.batch = [];
        if (!qq.wc.isDestroyed() && batch.length) qq.wc.send('push', batch);
      });
    }
  }

  /** Send a named event to every renderer (or all except one). */
  broadcast(event: string, data: unknown, except?: WebContents): void {
    for (const wc of webContents.getAllWebContents()) {
      if (wc === except || wc.isDestroyed()) continue;
      if (wc.getType() !== 'window') continue;
      wc.send('event', event, data);
    }
  }
}
