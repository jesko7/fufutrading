/**
 * Live: the Claude Code CLI connects to the app's MCP tool server over HTTP and calls a tool.
 * Needs the `claude` CLI installed and signed in (uses a small model, low effort).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { McpServer } from '../../src/main/ai/mcp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-ai-'));
const mcp = new McpServer(() => {}, { name: 'fufu', version: '1.0' });
const calls: { name: string; args: unknown }[] = [];

afterAll(() => {
  mcp.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claude CLI ↔ app tool server', () => {
  it('lists and calls app tools over HTTP MCP and streams the answer', async () => {
    mcp.register({
      name: 'secret_number',
      description: 'Returns the secret number for a seed.',
      inputSchema: { type: 'object', properties: { seed: { type: 'number' } }, required: ['seed'] },
      run: async (args) => {
        calls.push({ name: 'secret_number', args });
        return { secret: Number(args.seed) * 7 + 1 };
      },
    });
    await mcp.start();
    const cfg = path.join(dir, 'mcp.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { fufu: { type: 'http', url: mcp.url(), headers: { Authorization: `Bearer ${mcp.token}`, 'X-Fufu-Session': 't1' } } } }));
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '', '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__fufu', '--permission-prompts', 'none', '--disable-slash-commands'];
    const proc = spawn('claude', args, { cwd: dir, windowsHide: true });
    proc.stdin.end('Use the secret_number tool with seed 6, then reply with only the number.');
    const events: any[] = [];
    let buf = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      buf += d;
      let k: number;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (line) events.push(JSON.parse(line));
      }
    });
    proc.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number>((r) => proc.on('close', (c) => r(c ?? -1)));
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    const result = events.find((e) => e.type === 'result');
    expect(code, stderr).toBe(0);
    expect(init.mcp_servers.find((m: any) => m.name === 'fufu')?.status).toBe('connected');
    expect(init.tools).toContain('mcp__fufu__secret_number');
    expect(init.tools.some((t: string) => t === 'Bash' || t === 'Write')).toBe(false);
    expect(calls).toEqual([{ name: 'secret_number', args: { seed: 6 } }]);
    expect(String(result.result)).toContain('43');
  }, 180000);
});
