/**
 * ScriptPool — worker threads that execute user scripts, isolated from the main process:
 *  - "live" workers (Pine) host chart/alert instances and analysis,
 *  - one "python" worker hosts Pyodide for live Python instances and analysis,
 *  - "batch" workers run backtests/optimizer trials (spawned on demand, reaped when idle).
 * A script that hangs is interrupted (Python: KeyboardInterrupt, Pine: cancel flag) and, if it
 * still does not yield, its worker is terminated; instances on that worker are reported lost so
 * their owners can reopen them. Script errors never reach the main process.
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import type { PyInitOptions } from '../../engine/python/host';
import type { AnalyzeResult, InstanceReply, InstanceSpec, InstanceUpdate, RunSpec, TrialSpec, TrialResult, BotStepSpec, BotStepResult } from '../../engine/host';
import type { RunContext, ScriptLanguage, ScriptResult } from '../../engine/types';

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;
type Group = 'live' | 'python' | 'batch';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  op: string;
  timer?: NodeJS.Timeout;
  onEvent?: (e: any) => void;
}

let slotSeq = 0;

class Slot {
  readonly id = ++slotSeq;
  readonly worker: Worker;
  readonly pending = new Map<number, Pending>();
  readonly instances = new Set<string>();
  readonly ctl = new Int32Array(new SharedArrayBuffer(16));
  readonly pyInterrupt = new Uint8Array(new SharedArrayBuffer(1));
  dead = false;
  lastUsed = Date.now();

  constructor(
    readonly group: Group,
    script: string,
    py: PyInitOptions | null,
    private onExit: (s: Slot, reason: string) => void,
  ) {
    this.worker = new Worker(script, {
      workerData: { py, ctl: this.ctl.buffer, pyInterrupt: this.pyInterrupt.buffer },
      resourceLimits: { maxOldGenerationSizeMb: group === 'batch' ? 4096 : 2048 },
      stdout: false,
      stderr: false,
    });
    this.worker.on('message', (m: any) => {
      if (m && m.event) {
        if (m.job !== undefined) this.pending.get(m.job)?.onEvent?.(m);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      this.lastUsed = Date.now();
      if (m.ok) p.resolve(m.r);
      else p.reject(new Error(m.error));
    });
    this.worker.on('error', (e: Error) => this.die(`crashed: ${e.message}`));
    this.worker.on('exit', (code) => this.die(code === 0 ? 'stopped' : `exited with code ${code}`));
  }

  die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`Script worker ${reason}`));
    }
    this.pending.clear();
    this.onExit(this, reason);
  }

  terminate(reason: string): void {
    if (this.dead) return;
    void this.worker.terminate();
    this.die(reason);
  }

  get load(): number {
    return this.pending.size * 4 + this.instances.size;
  }
}

export interface RunHandle {
  promise: Promise<{ result: ScriptResult; need: string[] }>;
  cancel(): void;
  /** Debugger control block (when started with debug options). */
  debug?: Int32Array;
}

export class ScriptPool {
  private slots: Slot[] = [];
  private instSlot = new Map<string, Slot>();
  private nextId = 1;
  private reaper: NodeJS.Timeout;
  readonly lostListeners = new Set<(inst: string, reason: string) => void>();
  readonly maxLive = 2;
  readonly maxBatch = Math.max(1, Math.min(8, os.cpus().length - 1));

  constructor(
    private script: string,
    private py: PyInitOptions | null,
    private log: Logger,
  ) {
    this.reaper = setInterval(() => this.reap(), 30000);
    this.reaper.unref?.();
  }

  get pythonAvailable(): boolean {
    return !!this.py;
  }

  private spawn(group: Group): Slot {
    const s = new Slot(group, this.script, this.py, (slot, reason) => {
      this.slots = this.slots.filter((x) => x !== slot);
      if (reason !== 'stopped' && reason !== 'idle') this.log('warn', `script worker #${slot.id} (${slot.group}) ${reason}`);
      for (const inst of slot.instances) {
        this.instSlot.delete(inst);
        for (const l of this.lostListeners) l(inst, reason);
      }
      slot.instances.clear();
    });
    this.slots.push(s);
    return s;
  }

  /** Batch workers kept alive while bots run (each step reuses a warm worker, Pyodide stays loaded). */
  keepWarm = 0;

  private reap(): void {
    const now = Date.now();
    let warm = Math.min(this.keepWarm, this.maxBatch);
    for (const s of [...this.slots].sort((a, b) => b.lastUsed - a.lastUsed)) {
      if (s.group === 'batch' && !s.pending.size && warm > 0 && now - s.lastUsed < 30 * 60000) {
        warm--;
        continue;
      }
      if (s.group === 'batch' && !s.pending.size && now - s.lastUsed > 60000) s.terminate('idle');
      if (s.group === 'python' && !s.pending.size && !s.instances.size && now - s.lastUsed > 10 * 60000) s.terminate('idle');
    }
  }

  private slotFor(group: Group): Slot {
    const alive = this.slots.filter((s) => s.group === group && !s.dead);
    if (group === 'python') return alive[0] || this.spawn('python');
    const max = group === 'live' ? this.maxLive : this.maxBatch;
    const idle = alive.find((s) => s.load === 0);
    if (idle) return idle;
    if (alive.length < max) return this.spawn(group);
    return alive.reduce((a, b) => (b.load < a.load ? b : a));
  }

  private call<T>(slot: Slot, msg: Record<string, unknown>, opts: { timeoutMs?: number; onEvent?: (e: any) => void; id?: number } = {}): Promise<T> {
    if (slot.dead) return Promise.reject(new Error('Script worker is not running'));
    const id = opts.id ?? this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, op: String(msg.op), onEvent: opts.onEvent };
      if (opts.timeoutMs) {
        p.timer = setTimeout(() => {
          this.log('warn', `script ${msg.op} exceeded ${Math.round(opts.timeoutMs! / 1000)}s — interrupting`);
          Atomics.store(slot.ctl, 0, id);
          slot.pyInterrupt[0] = 2;
          p.timer = setTimeout(() => slot.terminate(`terminated: ${msg.op} did not stop after interrupt`), 4000);
        }, opts.timeoutMs);
      }
      slot.pending.set(id, p);
      slot.lastUsed = Date.now();
      slot.worker.postMessage({ ...msg, id });
    });
  }

  // ------------------------------------------------------------------ API

  warmPython(): Promise<boolean> {
    if (!this.py) return Promise.resolve(false);
    return this.call<boolean>(this.slotFor('python'), { op: 'warmPython' }, { timeoutMs: 180000 });
  }

  analyze(lang: ScriptLanguage, code: string, ctx?: RunContext): Promise<AnalyzeResult> {
    const slot = this.slotFor(lang === 'python' ? 'python' : 'live');
    return this.call<AnalyzeResult>(slot, { op: 'analyze', lang, code, ctx }, { timeoutMs: lang === 'python' ? 180000 : 20000 });
  }

  open(inst: string, spec: InstanceSpec): Promise<InstanceReply> {
    this.close(inst);
    const slot = this.slotFor(spec.lang === 'python' ? 'python' : 'live');
    slot.instances.add(inst);
    this.instSlot.set(inst, slot);
    return this.call<InstanceReply>(slot, { op: 'open', inst, spec }, { timeoutMs: spec.lang === 'python' ? 240000 : 60000 });
  }

  update(inst: string, u: InstanceUpdate): Promise<InstanceReply> {
    const slot = this.instSlot.get(inst);
    if (!slot || slot.dead) return Promise.reject(new Error('Script instance was lost'));
    return this.call<InstanceReply>(slot, { op: 'update', inst, u }, { timeoutMs: 60000 });
  }

  has(inst: string): boolean {
    const s = this.instSlot.get(inst);
    return !!s && !s.dead;
  }

  close(inst: string): void {
    const slot = this.instSlot.get(inst);
    if (!slot) return;
    this.instSlot.delete(inst);
    slot.instances.delete(inst);
    if (!slot.dead) this.call(slot, { op: 'close', inst }).catch(() => {});
  }

  /** One-shot run (backtest / optimizer trial / debug session) on a batch worker. */
  run(spec: Omit<RunSpec, 'ticks' | 'debug' | 'shouldStop'>, opts: { timeoutMs?: number; debug?: { breakpoints: number[]; breakOnNext: boolean; onPause: (snapshot: unknown, reason: string) => void } } = {}): RunHandle {
    // debug sessions block their worker while paused: always use a dedicated worker
    const slot = opts.debug ? this.spawn('batch') : this.slotFor('batch');
    const id = this.nextId++;
    let debugCtl: Int32Array | undefined;
    let debugMsg: Record<string, unknown> | undefined;
    if (opts.debug) {
      debugCtl = new Int32Array(new SharedArrayBuffer(4 * 258));
      opts.debug.breakpoints.slice(0, 255).forEach((l, k) => (debugCtl![2 + k] = l));
      debugMsg = { sab: debugCtl.buffer, breakpoints: opts.debug.breakpoints, breakOnNext: opts.debug.breakOnNext };
    }
    const onPause = opts.debug?.onPause;
    const promise = this.call<{ result: ScriptResult; need: string[] }>(slot, { op: 'run', spec, debug: debugMsg }, { id, timeoutMs: opts.debug ? undefined : opts.timeoutMs, onEvent: (e) => e.event === 'debugPause' && onPause?.(e.snapshot, e.reason) }).finally(() => {
      if (opts.debug) slot.terminate('stopped');
    });
    return {
      promise,
      debug: debugCtl,
      cancel: () => {
        if (slot.dead || !slot.pending.has(id)) return;
        Atomics.store(slot.ctl, 0, id);
        slot.pyInterrupt[0] = 2;
        if (debugCtl) {
          Atomics.store(debugCtl, 1, 5);
          Atomics.notify(debugCtl, 1);
        }
        setTimeout(() => {
          if (slot.pending.has(id)) slot.terminate('terminated: run cancelled');
        }, 3000).unref?.();
      },
    };
  }

  /** Optimizer trial on a batch worker; returns a compact result. Pass shared-memory bars to avoid copies. */
  trial(spec: TrialSpec, opts: { timeoutMs?: number } = {}): { promise: Promise<TrialResult>; cancel: () => void } {
    const slot = this.slotFor('batch');
    const id = this.nextId++;
    const promise = this.call<TrialResult>(slot, { op: 'trial', spec }, { id, timeoutMs: opts.timeoutMs ?? 10 * 60000 });
    return {
      promise,
      cancel: () => {
        if (slot.dead || !slot.pending.has(id)) return;
        Atomics.store(slot.ctl, 0, id);
        slot.pyInterrupt[0] = 2;
      },
    };
  }

  /** One live-bot step on a batch worker (compact result). */
  botStep(spec: BotStepSpec, opts: { timeoutMs?: number } = {}): { promise: Promise<BotStepResult>; cancel: () => void } {
    const slot = this.slotFor('batch');
    const id = this.nextId++;
    const promise = this.call<BotStepResult>(slot, { op: 'botStep', spec }, { id, timeoutMs: opts.timeoutMs ?? 120000 });
    return {
      promise,
      cancel: () => {
        if (slot.dead || !slot.pending.has(id)) return;
        Atomics.store(slot.ctl, 0, id);
        slot.pyInterrupt[0] = 2;
      },
    };
  }

  /** Number of trials that can run at once. */
  get parallelism(): number {
    return this.maxBatch;
  }

  stats(): { group: string; id: number; instances: number; pending: number }[] {
    return this.slots.map((s) => ({ group: s.group, id: s.id, instances: s.instances.size, pending: s.pending.size }));
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all(this.slots.map((s) => s.worker.terminate().catch(() => 0)));
    this.slots = [];
  }
}
