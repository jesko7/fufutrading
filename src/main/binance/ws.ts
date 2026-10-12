/**
 * Resilient Binance WebSocket streams.
 *
 *  - Ref-counted stream subscriptions multiplexed over combined-stream connections.
 *  - Futures routing (verified 2026-10-12): depth/bookTicker streams are served on
 *    wss://fstream.binance.com/public, all other market streams on /market.
 *  - Automatic reconnect with exponential backoff + jitter, staleness watchdog, and a proactive
 *    reconnect before Binance's 24h connection limit. Consumers get `onReconnect` so they can
 *    backfill anything missed while disconnected.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { Market } from '../../shared/symbols';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

export interface StreamHandler {
  onData(data: any): void;
  /** Called after the connection carrying this stream was re-established. */
  onReconnect?(): void;
  /** Called when the connection drops (data may be missing until onReconnect). */
  onDisconnect?(): void;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

class StreamConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private desired = new Set<string>();
  private active = new Set<string>();
  private pendingOps: { method: 'SUBSCRIBE' | 'UNSUBSCRIBE'; params: string[] }[] = [];
  private opTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private nextId = 1;
  lastMessageAt = 0;
  state: ConnState = 'idle';
  urlIndex = 0;
  connectedAt = 0;
  messages = 0;

  constructor(
    readonly name: string,
    private urls: string[],
    private log: Logger,
    private staleMs = 20000,
  ) {
    super();
  }

  add(stream: string): void {
    if (this.desired.has(stream)) return;
    this.desired.add(stream);
    if (this.state === 'open') this.queueOp('SUBSCRIBE', stream);
    else if (this.state === 'idle' || this.state === 'closed') this.connect();
  }

  remove(stream: string): void {
    if (!this.desired.delete(stream)) return;
    if (this.state === 'open' && this.active.has(stream)) this.queueOp('UNSUBSCRIBE', stream);
    if (this.desired.size === 0) {
      // keep the socket briefly for quick re-subscribes; close after idle
      setTimeout(() => {
        if (this.desired.size === 0) this.close();
      }, 30000).unref?.();
    }
  }

  private queueOp(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', stream: string): void {
    const last = this.pendingOps[this.pendingOps.length - 1];
    if (last && last.method === method && last.params.length < 100) last.params.push(stream);
    else this.pendingOps.push({ method, params: [stream] });
    if (!this.opTimer) this.opTimer = setTimeout(() => this.flushOps(), 50);
  }

  private flushOps(): void {
    this.opTimer = null;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Binance limits incoming control messages (5/s spot, 10/s futures): send one op per 250ms.
    const op = this.pendingOps.shift();
    if (!op) return;
    this.ws.send(JSON.stringify({ method: op.method, params: op.params, id: this.nextId++ }));
    for (const s of op.params) {
      if (op.method === 'SUBSCRIBE') this.active.add(s);
      else this.active.delete(s);
    }
    if (this.pendingOps.length) this.opTimer = setTimeout(() => this.flushOps(), 250);
  }

  private connect(): void {
    if (this.desired.size === 0) {
      this.state = 'idle';
      return;
    }
    this.cleanupSocket();
    this.state = this.attempts > 0 ? 'reconnecting' : 'connecting';
    this.emit('state', this.state);
    const streams = [...this.desired];
    const base = this.urls[this.urlIndex % this.urls.length];
    // put up to 100 streams in the URL, subscribe the rest via messages
    const inUrl = streams.slice(0, 100);
    const url = `${base}?streams=${inUrl.join('/')}`;
    const ws = new WebSocket(url, { handshakeTimeout: 10000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      const wasReconnect = this.attempts > 0 || this.connectedAt > 0;
      this.attempts = 0;
      this.state = 'open';
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.active = new Set(inUrl);
      this.pendingOps = [];
      for (const s of this.desired) if (!this.active.has(s)) this.queueOp('SUBSCRIBE', s);
      for (const s of this.active) if (!this.desired.has(s)) this.queueOp('UNSUBSCRIBE', s);
      this.emit('state', this.state);
      this.emit('open', wasReconnect);
      this.startWatchdog();
      // Binance closes connections after 24h; reconnect proactively a bit earlier.
      this.lifetimeTimer = setTimeout(() => {
        this.log('info', `${this.name}: proactive reconnect before 24h limit`);
        this.forceReconnect();
      }, 23.5 * 3600 * 1000);
      this.lifetimeTimer.unref?.();
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      this.messages++;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.stream && msg.data) this.emit('message', msg.stream, msg.data);
      else if (msg && msg.error) this.log('warn', `${this.name}: ${JSON.stringify(msg.error)}`);
    });
    ws.on('ping', () => {
      this.lastMessageAt = Date.now();
    });
    ws.on('error', (err: Error) => {
      this.log('warn', `${this.name} socket error: ${err.message}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.onDropped();
    });
    ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      this.log('warn', `${this.name}: HTTP ${res.statusCode} on connect`);
      this.urlIndex++;
      if (this.ws === ws) this.onDropped();
    });
  }

  private onDropped(): void {
    const wasOpen = this.state === 'open';
    this.cleanupSocket();
    if (this.desired.size === 0) {
      this.state = 'idle';
      this.emit('state', this.state);
      return;
    }
    if (wasOpen) this.emit('drop');
    this.attempts++;
    if (this.attempts % 3 === 0) this.urlIndex++; // rotate fallback hosts on repeated failures
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempts - 1, 5)) * (0.75 + Math.random() * 0.5);
    this.state = 'reconnecting';
    this.emit('state', this.state);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  forceReconnect(): void {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    } else this.connect();
  }

  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.state !== 'open' || this.desired.size === 0) return;
      if (Date.now() - this.lastMessageAt > this.staleMs) {
        this.log('warn', `${this.name}: no data for ${Math.round((Date.now() - this.lastMessageAt) / 1000)}s, reconnecting`);
        this.forceReconnect();
      }
    }, 2000);
    this.watchdog.unref?.();
  }

  private cleanupSocket(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.opTimer) clearTimeout(this.opTimer);
    this.watchdog = this.lifetimeTimer = this.reconnectTimer = this.opTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners('close');
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    this.desired.clear();
    this.cleanupSocket();
    this.state = 'closed';
    this.emit('state', this.state);
  }
}

const FUTURES_PUBLIC = /@(depth|bookTicker)/;

export class BinanceStreams extends EventEmitter {
  private conns: Record<string, StreamConnection> = {};
  private handlers = new Map<string, Set<StreamHandler>>(); // key = `${market}|${stream}`

  constructor(private log: Logger) {
    super();
    this.conns.spot = this.makeConn('spot', ['wss://stream.binance.com:9443/stream', 'wss://data-stream.binance.vision/stream', 'wss://stream.binance.com:443/stream']);
    this.conns.fmarket = this.makeConn('futures-market', ['wss://fstream.binance.com/market/stream']);
    this.conns.fpublic = this.makeConn('futures-public', ['wss://fstream.binance.com/public/stream']);
  }

  private makeConn(name: string, urls: string[]): StreamConnection {
    const c = new StreamConnection(name, urls, this.log);
    const market: Market = name === 'spot' ? 'spot' : 'futures';
    c.on('message', (stream: string, data: any) => {
      const hs = this.handlers.get(`${market}|${stream}`);
      if (hs) for (const h of hs) h.onData(data);
    });
    c.on('open', (wasReconnect: boolean) => {
      if (!wasReconnect) return;
      this.log('info', `${name}: reconnected`);
      for (const [key, hs] of this.handlers) {
        const [m, stream] = key.split('|');
        if (m !== market || this.connFor(market, stream) !== c) continue;
        for (const h of hs) h.onReconnect?.();
      }
    });
    c.on('drop', () => {
      for (const [key, hs] of this.handlers) {
        const [m, stream] = key.split('|');
        if (m !== market || this.connFor(market, stream) !== c) continue;
        for (const h of hs) h.onDisconnect?.();
      }
    });
    c.on('state', () => this.emit('state', this.status()));
    return c;
  }

  private connFor(market: Market, stream: string): StreamConnection {
    if (market === 'spot') return this.conns.spot;
    return FUTURES_PUBLIC.test(stream) ? this.conns.fpublic : this.conns.fmarket;
  }

  /** Subscribe to a raw stream name like "btcusdt@aggTrade". Returns an unsubscribe function. */
  subscribe(market: Market, stream: string, handler: StreamHandler): () => void {
    const key = `${market}|${stream}`;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    this.connFor(market, stream).add(stream);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = this.handlers.get(key);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(key);
        this.connFor(market, stream).remove(stream);
      }
    };
  }

  status(): Record<string, { state: ConnState; lastMessageAt: number; messages: number }> {
    const out: Record<string, { state: ConnState; lastMessageAt: number; messages: number }> = {};
    for (const [k, c] of Object.entries(this.conns)) out[k] = { state: c.state, lastMessageAt: c.lastMessageAt, messages: c.messages };
    return out;
  }

  /** For tests / diagnostics. */
  forceReconnectAll(): void {
    for (const c of Object.values(this.conns)) if (c.state === 'open') c.forceReconnect();
  }

  closeAll(): void {
    for (const c of Object.values(this.conns)) c.close();
  }
}
