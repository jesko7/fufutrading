/**
 * AI assistant ("AI Studio") — Claude Code (the `claude` CLI) working inside the app.
 *
 * Each turn starts `claude -p` with stream-json output, the chosen model, effort, mode and
 * thinking setting, no built-in shell/file tools, and the app's own tools over MCP (local HTTP,
 * token-protected): docs, script library, compile checks, runs on real data, backtests,
 * optimizations and "show in app". Claude therefore works in a loop — write, check, run,
 * backtest, refine — instead of guessing. Conversations continue with `--resume`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { AppCore } from '../core';
import { DocStore, uid, writeJsonAtomic } from '../storage/jsonStore';
import { McpServer } from './mcp';
import { aiTools, type AiCard, type AiTool, type AiToolDeps } from './tools';

export type AiMode = 'build' | 'plan' | 'ask';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiSettings {
  model: string;
  mode: AiMode;
  effort: AiEffort;
  thinking: boolean;
}

export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; status: 'running' | 'ok' | 'error'; result?: string; card?: AiCard };

export interface AiContext {
  script?: { id: string; name: string; language: string };
  chart?: { symbol: string; market: string; tf: string };
  error?: string;
  selection?: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  t: number;
  text?: string;
  context?: AiContext;
  parts?: AiPart[];
  done?: boolean;
  error?: string;
  cost?: number;
  ms?: number;
  settings?: AiSettings;
}

export interface AiChat {
  id: string;
  title: string;
  created: number;
  updated: number;
  settings: AiSettings;
  claudeSession: string | null;
  messages: AiMessage[];
  cost: number;
}

export const DEFAULT_AI: AiSettings = { model: 'sonnet', mode: 'build', effort: 'medium', thinking: true };

const MODE_PROMPT: Record<AiMode, string> = {
  build: 'Mode: BUILD. Implement what the user asks: follow the research steps, iterate until it works and the evidence is honest, save it with save_script and show it with show_in_app.',
  plan: 'Mode: PLAN. Research and propose. You may read scripts, check, run and backtest drafts to gather evidence, but do not save anything. End with a concrete step-by-step plan the user can approve (they can switch to Build to execute it).',
  ask: 'Mode: ASK. Answer and explain. Use tools only to look things up or verify claims (read, check, run, backtest). Do not save scripts.',
};

const SYSTEM_PROMPT = `You are the AI assistant built into FuFu Trading, a desktop crypto trading platform (Binance BTC/ETH/SOL spot and USDⓈ-M perpetual futures, paper trading only). You create, explain, debug and improve indicators and strategies in Pine Script (FuFu's supported subset of v4–v6) and Python (the fufu API).

You have a test bench. Use it instead of guessing, and work like a careful quant researcher:

1. Understand the goal. If the request is vague, choose sensible defaults (instrument, timeframe, style) and say which you chose.
2. Ground the idea in the market: market_snapshot gives volatility, ATR and trend, so parameters fit the instrument (for example stops in ATRs rather than fixed prices); futures_snapshot shows positioning (open interest, funding, long/short ratios). Scripts can use positioning history too: request.security("BINANCE:BTCUSDT.P_OI", tf, close) gives open interest since 2020 (also _OI_USD, _LSR, _TOP_LSR, _TOP_POS; Python: data.security('BTCUSDT.P_OI', tf)), lookahead-free, in backtests, replays and bots. State the hypothesis in one sentence: why should this make money (trend persistence, mean reversion after overextension, volatility breakouts, session effects …)?
3. Write it. Read the docs for the language first (get_docs "pine" / "pine_functions" / "python") and only use features they list; if something the user wants is unsupported, say so and offer the closest supported approach. Give every value a user would tune an input. No future data: no lookahead_on without [1], no negative offsets. Prefer simple rules with few parameters, and comment where it helps.
4. check_script every draft and fix all errors and lookahead/repainting warnings.
5. Verify. run_script indicators and look at the values (sane ranges, NaN only during warm-up) and their predictive value: the information coefficient of plots and the returns after signals against the baseline.
6. Evaluate strategies with backtest over at least one to two years (longer for slow timeframes) with realistic costs, and judge them on all of:
   - return and drawdown against buy & hold and cash, with enough trades (fewer than 30 supports no conclusion);
   - vsRandom: the share of random twins (same trades at random times) the strategy beats and its p-value. Below 0.05 suggests real timing skill; above 0.2 is indistinguishable from luck;
   - the Greeks: is the return mostly beta (high R², alpha near zero)? Alpha with low beta is worth more than a leveraged copy of buy & hold;
   - fee drag: a profit factor near 1 means fees decide the outcome.
7. Validate before calling anything robust: robustness_test (other coins, neighbouring timeframes, separate periods). Optimize only with an out-of-sample check (optimize with holdout or walkforward), keep budgets small, prefer parameters on a broad plateau, and present out-of-sample results as the realistic expectation, never in-sample ones.
8. Iterate on evidence. When a result is weak, change the idea (filters, exits, regime conditions) rather than only the parameters. Stop after a few honest attempts and say what you learned.

Never invent numbers. Report results with the period, instrument, timeframe and costs they came from. Past performance does not predict future results; say so when you present a strategy.

When you finish, reply concisely:
- what you built or found, in one or two sentences;
- for strategies, a small Markdown report card: return vs buy & hold, max drawdown, Sharpe, trades, beats random (p-value), alpha and beta, the robustness verdict and the out-of-sample result if you optimized;
- an honest verdict (promising, needs work, or no edge) with the main caveat;
- how to use it in the app (for example "added to your chart", "open it in the Strategy Tester", "run it on a paper account as a bot").
Tool results are shown to the user as cards, so don't repeat long tables.`;

function findClaude(): { cmd: string; shell: boolean } | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(process.env.APPDATA || '', 'npm'), '/usr/local/bin', '/opt/homebrew/bin');
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, `claude${e}`);
      try {
        if (fs.statSync(p).isFile()) return { cmd: p, shell: e === '.cmd' || e === '.bat' };
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function quoteWin(a: string): string {
  if (a === '') return '""';
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export class AIService {
  private store: DocStore<AiChat>;
  private dir: string;
  private mcp: McpServer;
  private tools: AiTool[];
  private running = new Map<string, { proc: ChildProcess; msg: AiMessage; t0: number; stopped: boolean }>();
  private listeners = new Set<(chatId: string, full: boolean) => void>();
  private claudeInfo: { available: boolean; version?: string; path?: string; error?: string } | null = null;
  private pushTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly core: AppCore,
    deps: Omit<AiToolDeps, 'core' | 'docsDir'>,
  ) {
    this.dir = path.join(core.paths.userData, 'ai');
    fs.mkdirSync(path.join(this.dir, 'work'), { recursive: true });
    this.store = new DocStore<AiChat>(path.join(this.dir, 'chats'));
    this.mcp = new McpServer(core.log, { name: 'fufu', version: '1.0', instructions: 'FuFu Trading tools: docs, scripts, checks, runs, backtests, optimizations.' });
    this.tools = aiTools({ ...deps, core, docsDir: path.join(core.paths.dist, 'docs') });
    for (const t of this.tools) this.mcp.register({ ...t, run: (args, ctx) => this.runTool(t, args, ctx.session) });
    core.onShutdown(() => this.shutdown());
  }

  // ------------------------------------------------------------------ claude CLI

  async status(force = false): Promise<{ available: boolean; version?: string; path?: string; error?: string }> {
    if (this.claudeInfo && !force) return this.claudeInfo;
    const c = findClaude();
    if (!c) {
      this.claudeInfo = { available: false, error: 'The Claude Code CLI ("claude") was not found. Install it from https://claude.com/claude-code and sign in once in a terminal.' };
      return this.claudeInfo;
    }
    this.claudeInfo = await new Promise((resolve) => {
      execFile(c.cmd, ['--version'], { timeout: 20000, shell: c.shell, windowsHide: true }, (err, stdout) => {
        if (err) resolve({ available: false, path: c.cmd, error: `claude --version failed: ${err.message}` });
        else resolve({ available: true, path: c.cmd, version: String(stdout).trim().split(/\s/)[0] });
      });
    });
    return this.claudeInfo!;
  }

  // ------------------------------------------------------------------ chats

  list(): Omit<AiChat, 'messages'>[] {
    return this.store
      .loadAll()
      .sort((a, b) => b.updated - a.updated)
      .map(({ messages, ...rest }) => ({ ...rest, preview: messages.find((m) => m.role === 'user')?.text?.slice(0, 120) || '', running: this.running.has(rest.id) }) as Omit<AiChat, 'messages'>);
  }

  get(id: string): (AiChat & { running: boolean }) | null {
    const c = this.store.get(id);
    return c ? { ...c, running: this.running.has(id) } : null;
  }

  create(settings?: Partial<AiSettings>): AiChat {
    const now = Date.now();
    const c: AiChat = { id: uid('ai'), title: 'New chat', created: now, updated: now, settings: { ...DEFAULT_AI, ...(settings || {}) }, claudeSession: null, messages: [], cost: 0 };
    this.store.put(c, true);
    this.notify(c.id, true);
    return c;
  }

  remove(id: string): void {
    this.stop(id);
    this.store.delete(id);
    this.notify(id, true);
  }

  rename(id: string, title: string): void {
    const c = this.store.get(id);
    if (!c) return;
    c.title = title.slice(0, 120) || c.title;
    this.store.put(c, true);
    this.notify(id, true);
  }

  updateSettings(id: string, s: Partial<AiSettings>): AiChat {
    const c = this.store.get(id);
    if (!c) throw new Error('Chat not found');
    c.settings = { ...c.settings, ...sanitize(s) };
    this.store.put(c, true);
    this.notify(id, true);
    return c;
  }

  onChange(l: (chatId: string, full: boolean) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(chatId: string, full: boolean): void {
    if (full) {
      const t = this.pushTimers.get(chatId);
      if (t) clearTimeout(t);
      this.pushTimers.delete(chatId);
      for (const l of this.listeners) l(chatId, true);
      return;
    }
    if (this.pushTimers.has(chatId)) return;
    this.pushTimers.set(
      chatId,
      setTimeout(() => {
        this.pushTimers.delete(chatId);
        for (const l of this.listeners) l(chatId, false);
      }, 60),
    );
  }

  /** The message being streamed (for delta pushes). */
  streaming(chatId: string): AiMessage | null {
    return this.running.get(chatId)?.msg || null;
  }

  // ------------------------------------------------------------------ turns

  async send(chatId: string | null, text: string, settings?: Partial<AiSettings>, context?: AiContext): Promise<string> {
    const info = await this.status();
    if (!info.available) throw new Error(`Validation: ${info.error}`);
    const prompt = String(text || '').trim();
    if (!prompt) throw new Error('Validation: write a message first');
    const chat = chatId ? this.store.get(chatId) : this.create(settings);
    if (!chat) throw new Error('Chat not found');
    if (this.running.has(chat.id)) throw new Error('Validation: Claude is still working on the previous message');
    if (settings) chat.settings = { ...chat.settings, ...sanitize(settings) };
    const s = chat.settings;
    const now = Date.now();
    chat.messages.push({ id: uid('m'), role: 'user', t: now, text: prompt, context });
    if (chat.title === 'New chat') chat.title = prompt.replace(/\s+/g, ' ').slice(0, 60);
    const msg: AiMessage = { id: uid('m'), role: 'assistant', t: now, parts: [], settings: { ...s } };
    chat.messages.push(msg);
    chat.updated = now;
    this.store.put(chat, true);
    await this.mcp.start();
    this.mcp.setVisible(
      chat.id,
      this.tools.filter((t) => s.mode === 'build' || t.readOnly).map((t) => t.name),
    );
    const files = this.writeFiles(chat.id, s);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      s.model,
      '--effort',
      s.effort,
      '--tools',
      '',
      '--mcp-config',
      files.mcp,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__fufu',
      '--permission-prompts',
      'none',
      '--append-system-prompt-file',
      files.system,
      '--settings',
      files.settings,
      '--disable-slash-commands',
    ];
    if (chat.claudeSession) args.push('--resume', chat.claudeSession);
    const c = findClaude()!;
    const proc = spawn(c.cmd, c.shell ? args.map(quoteWin) : args, {
      cwd: path.join(this.dir, 'work'),
      shell: c.shell,
      windowsHide: true,
      env: { ...process.env, MCP_TOOL_TIMEOUT: '900000', MAX_MCP_OUTPUT_TOKENS: '60000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    const run = { proc, msg, t0: Date.now(), stopped: false };
    this.running.set(chat.id, run);
    this.notify(chat.id, true);
    proc.stdin?.end(this.composePrompt(prompt, context));
    let buf = '';
    let stderr = '';
    const blocks = new Map<number, AiPart>();
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => {
      buf += d;
      let k: number;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (!line) continue;
        try {
          this.onEvent(chat.id, msg, JSON.parse(line), blocks);
        } catch (e) {
          this.core.log('warn', `ai: bad stream line (${(e as Error).message}): ${line.slice(0, 200)}`);
        }
      }
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on('error', (e) => {
      msg.error = `Could not start Claude: ${e.message}`;
    });
    proc.on('close', (code) => {
      this.running.delete(chat.id);
      for (const p of msg.parts || []) if (p.type === 'tool' && p.status === 'running') p.status = run.stopped ? 'error' : 'ok';
      if (run.stopped) msg.error = msg.error || 'Stopped.';
      else if (code !== 0 && !msg.done && !msg.error) msg.error = (stderr.trim().split('\n').slice(-3).join(' ') || `Claude exited with code ${code}`).slice(0, 600);
      msg.done = true;
      msg.ms = Date.now() - run.t0;
      const cur = this.store.get(chat.id);
      if (cur) {
        const idx = cur.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) cur.messages[idx] = msg;
        cur.updated = Date.now();
        cur.claudeSession = chatSession.get(chat.id) || cur.claudeSession;
        cur.cost = +(cur.cost + (msg.cost || 0)).toFixed(4);
        this.store.put(cur, true);
      }
      this.mcp.setVisible(chat.id, []);
      this.notify(chat.id, true);
    });
    return chat.id;
  }

  stop(chatId: string): boolean {
    const r = this.running.get(chatId);
    if (!r) return false;
    r.stopped = true;
    try {
      if (process.platform === 'win32' && r.proc.pid) execFile('taskkill', ['/pid', String(r.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else r.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return true;
  }

  private composePrompt(text: string, ctx?: AiContext): string {
    const lines: string[] = [];
    if (ctx?.script) lines.push(`The user has the script "${ctx.script.name}" (id ${ctx.script.id}, ${ctx.script.language}) open in the Script Editor.`);
    if (ctx?.chart) lines.push(`The focused chart shows ${ctx.chart.symbol} ${ctx.chart.market} ${ctx.chart.tf}.`);
    if (ctx?.error) lines.push(`The current script reports: ${ctx.error}`);
    if (ctx?.selection) lines.push(`Selected code:\n\`\`\`\n${ctx.selection.slice(0, 8000)}\n\`\`\``);
    return lines.length ? `<app_context>\n${lines.join('\n')}\n</app_context>\n\n${text}` : text;
  }

  private writeFiles(chatId: string, s: AiSettings): { mcp: string; system: string; settings: string } {
    const mcp = path.join(this.dir, `mcp-${chatId}.json`);
    writeJsonAtomic(mcp, { mcpServers: { fufu: { type: 'http', url: this.mcp.url(), headers: { Authorization: `Bearer ${this.mcp.token}`, 'X-Fufu-Session': chatId } } } });
    const system = path.join(this.dir, `system-${s.mode}.md`);
    fs.writeFileSync(system, `${SYSTEM_PROMPT}\n\n${MODE_PROMPT[s.mode]}\n`);
    const settings = path.join(this.dir, `settings-${s.thinking ? 'think' : 'nothink'}.json`);
    writeJsonAtomic(settings, { alwaysThinkingEnabled: s.thinking });
    return { mcp, system, settings };
  }

  // ------------------------------------------------------------------ stream parsing

  private onEvent(chatId: string, msg: AiMessage, ev: any, blocks: Map<number, AiPart>): void {
    const parts = msg.parts!;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          if (ev.session_id) chatSession.set(chatId, ev.session_id);
          const fufu = (ev.mcp_servers || []).find((m: any) => m.name === 'fufu');
          if (fufu && fufu.status !== 'connected') msg.error = `The app's tool server did not connect (${fufu.status}).`;
        }
        break;
      case 'stream_event': {
        const e = ev.event;
        if (!e) break;
        if (e.type === 'message_start') blocks.clear();
        else if (e.type === 'content_block_start') {
          const b = e.content_block;
          let part: AiPart | null = null;
          if (b.type === 'text') part = { type: 'text', text: b.text || '' };
          else if (b.type === 'thinking') part = { type: 'thinking', text: b.thinking || '' };
          else if (b.type === 'tool_use') part = { type: 'tool', id: b.id, name: b.name, input: {}, status: 'running' };
          if (part) {
            parts.push(part);
            blocks.set(e.index, part);
          }
        } else if (e.type === 'content_block_delta') {
          const p = blocks.get(e.index);
          const d = e.delta;
          if (!p || !d) break;
          if (d.type === 'text_delta' && p.type === 'text') p.text += d.text;
          else if (d.type === 'thinking_delta' && p.type === 'thinking') p.text += d.thinking;
        }
        this.notify(chatId, false);
        break;
      }
      case 'assistant': {
        // the complete message: make tool inputs exact (partial JSON is not parsed)
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_use') {
            const p = parts.find((x) => x.type === 'tool' && x.id === c.id) as Extract<AiPart, { type: 'tool' }> | undefined;
            if (p) p.input = c.input;
            else parts.push({ type: 'tool', id: c.id, name: c.name, input: c.input, status: 'running' });
          } else if (c.type === 'text' && !parts.some((x) => x.type === 'text' && x.text === c.text)) {
            // stream events were not delivered (older CLI): append the text
            if (!blocks.size) parts.push({ type: 'text', text: c.text });
          }
        }
        this.notify(chatId, false);
        break;
      }
      case 'user': {
        for (const c of ev.message?.content || []) {
          if (c.type !== 'tool_result') continue;
          const p = parts.find((x) => x.type === 'tool' && x.id === c.tool_use_id) as Extract<AiPart, { type: 'tool' }> | undefined;
          if (!p) continue;
          const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text || '').join('\n') : String(c.content || '');
          p.status = c.is_error ? 'error' : 'ok';
          p.result = text.slice(0, 4000);
        }
        this.notify(chatId, false);
        break;
      }
      case 'result': {
        msg.done = true;
        msg.cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0;
        if (ev.session_id) chatSession.set(chatId, ev.session_id);
        if (ev.is_error && !msg.error) msg.error = String(ev.result || ev.subtype || 'Claude reported an error').slice(0, 800);
        if (!parts.some((p) => p.type === 'text' && p.text.trim()) && typeof ev.result === 'string' && ev.result.trim()) parts.push({ type: 'text', text: ev.result });
        this.notify(chatId, false);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ tools

  /** Run a tool without Claude (end-to-end tests only; see registerAI). */
  async testTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; card: AiCard | null }> {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`unknown tool ${name}`);
    const result = await t.run(args, { session: 'test' } as never);
    return { result, card: t.card?.(args, result) ?? null };
  }

  private async runTool(t: AiTool, args: Record<string, unknown>, chatId: string): Promise<unknown> {
    const result = await t.run(args, { session: chatId });
    try {
      const card = t.card?.(args, result);
      if (card) {
        const msg = this.running.get(chatId)?.msg;
        const part = [...(msg?.parts || [])].reverse().find((p) => p.type === 'tool' && p.name === `mcp__fufu__${t.name}` && !p.card) as Extract<AiPart, { type: 'tool' }> | undefined;
        if (part) part.card = card;
        this.notify(chatId, false);
      }
    } catch (e) {
      this.core.log('warn', `ai card ${t.name}: ${(e as Error).message}`);
    }
    return result;
  }

  shutdown(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
    this.mcp.stop();
    this.store.flush();
  }
}

const chatSession = new Map<string, string>();

function sanitize(s: Partial<AiSettings>): Partial<AiSettings> {
  const out: Partial<AiSettings> = {};
  if (typeof s.model === 'string' && /^[\w.\-[\]]{2,60}$/.test(s.model)) out.model = s.model;
  if (s.mode === 'build' || s.mode === 'plan' || s.mode === 'ask') out.mode = s.mode;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(String(s.effort))) out.effort = s.effort;
  if (typeof s.thinking === 'boolean') out.thinking = s.thinking;
  return out;
}

export function registerAI(core: AppCore, deps: Omit<AiToolDeps, 'core' | 'docsDir'>): AIService {
  const svc = new AIService(core, deps);
  const r = core.router;
  r.handle('ai:status', ([force]) => svc.status(!!force));
  // the end-to-end runner checks tool results directly, without spending Claude usage
  if (process.env.FUFU_TEST_TOOLS === '1') r.handle('ai:testTool', ([name, args]) => svc.testTool(String(name), (args as Record<string, unknown>) || {}));
  r.handle('ai:list', () => svc.list());
  r.handle('ai:get', ([id]) => svc.get(String(id)));
  r.handle('ai:create', ([settings]) => svc.create(settings || {}));
  r.handle('ai:send', ([id, text, settings, context]) => svc.send(id ? String(id) : null, String(text || ''), settings || undefined, context || undefined));
  r.handle('ai:stop', ([id]) => svc.stop(String(id)));
  r.handle('ai:delete', ([id]) => {
    svc.remove(String(id));
    return true;
  });
  r.handle('ai:rename', ([id, title]) => {
    svc.rename(String(id), String(title || ''));
    return true;
  });
  r.handle('ai:settings', ([id, s]) => svc.updateSettings(String(id), s || {}));
  r.topic('ai:chats', (_p, push) => {
    push(svc.list());
    return svc.onChange((_id, full) => full && push(svc.list()));
  });
  r.topic('ai:chat', (p: { id: string }, push) => {
    push({ full: svc.get(p.id) });
    return svc.onChange((id, full) => {
      if (id !== p.id) return;
      if (full) push({ full: svc.get(p.id) });
      else {
        const m = svc.streaming(p.id);
        if (m) push({ delta: m });
      }
    });
  });
  return svc;
}
