/**
 * Minimal MCP server (streamable HTTP transport, JSON responses) on 127.0.0.1.
 * Claude Code connects to it with `{"type":"http","url":...,"headers":{"Authorization":"Bearer …"}}`
 * and calls the app's tools (read/write scripts, compile checks, runs, backtests…).
 * Only loopback connections with the per-session token are accepted.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns text (or an object rendered as JSON) for the model. Throw for tool errors. */
  run(args: Record<string, unknown>, ctx: { session: string }): Promise<unknown>;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class McpServer {
  private server: http.Server | null = null;
  port = 0;
  readonly token = crypto.randomBytes(24).toString('hex');
  private tools = new Map<string, McpTool>();
  /** Tools visible per AI session (mode-dependent), keyed by the session header. */
  private visible = new Map<string, Set<string>>();
  onCall: ((session: string, name: string, args: Record<string, unknown>) => void) | null = null;
  onResult: ((session: string, name: string, ok: boolean, text: string) => void) | null = null;

  constructor(
    private log: Logger,
    private info: { name: string; version: string; instructions?: string },
  ) {}

  register(t: McpTool): void {
    this.tools.set(t.name, t);
  }

  /** Restrict which tools a session sees (by name). */
  setVisible(session: string, names: string[] | null): void {
    if (names) this.visible.set(session, new Set(names));
    else this.visible.delete(session);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.log('info', `ai: tool server on 127.0.0.1:${this.port}`);
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) return this.reply(res, 403, { error: 'forbidden' });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.reply(res, 401, { error: 'unauthorized' });
    if (!req.url?.startsWith('/mcp')) return this.reply(res, 404, { error: 'not found' });
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const session = String(req.headers['x-fufu-session'] || new URL(req.url, 'http://x').searchParams.get('s') || '');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 5_000_000) return this.reply(res, 413, { error: 'too large' });
    }
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return this.reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(msg);
    const msgs: any[] = batch ? msg : [msg];
    const out: any[] = [];
    for (const m of msgs) {
      const r = await this.dispatch(m, session);
      if (r) out.push(r);
    }
    if (!out.length) {
      res.writeHead(202).end();
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (msgs.some((m) => m.method === 'initialize')) headers['Mcp-Session-Id'] = session || crypto.randomUUID();
    res.writeHead(200, headers).end(JSON.stringify(batch ? out : out[0]));
  }

  private reply(res: http.ServerResponse, status: number, obj: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  }

  private toolsFor(session: string): McpTool[] {
    const v = this.visible.get(session);
    return [...this.tools.values()].filter((t) => !v || v.has(t.name));
  }

  private async dispatch(m: any, session: string): Promise<any | null> {
    const id = m?.id;
    const isRequest = id !== undefined && id !== null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (m?.method) {
        case 'initialize': {
          const want = m.params?.protocolVersion;
          return ok({ protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.info.name, version: this.info.version }, instructions: this.info.instructions });
        }
        case 'ping':
          return isRequest ? ok({}) : null;
        case 'tools/list':
          return ok({ tools: this.toolsFor(session).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        case 'tools/call': {
          const name = String(m.params?.name || '');
          const args = (m.params?.arguments || {}) as Record<string, unknown>;
          const tool = this.toolsFor(session).find((t) => t.name === name);
          if (!tool) return ok({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
          this.onCall?.(session, name, args);
          try {
            const r = await tool.run(args, { session });
            const text = typeof r === 'string' ? r : JSON.stringify(r, null, 1);
            this.onResult?.(session, name, true, text);
            return ok({ content: [{ type: 'text', text }] });
          } catch (e) {
            const text = `Error: ${(e as Error).message.replace(/^Validation: /, '')}`;
            this.onResult?.(session, name, false, text);
            return ok({ content: [{ type: 'text', text }], isError: true });
          }
        }
        default:
          if (!isRequest) return null; // notifications (initialized, cancelled…)
          return fail(-32601, `Method not found: ${m?.method}`);
      }
    } catch (e) {
      this.log('warn', `mcp ${m?.method}: ${(e as Error).message}`);
      return isRequest ? fail(-32603, (e as Error).message) : null;
    }
  }
}
