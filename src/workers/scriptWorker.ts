/**
 * Script worker thread: hosts a ScriptHost (Pine + lazily Pyodide) and executes requests from
 * the main process strictly in order. A shared control block allows cancelling long runs:
 *   ctl[0] = id of the job to cancel (Pine runs poll it), pyInterrupt[0] = 2 raises
 *   KeyboardInterrupt inside Python.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ScriptHost, runTrial, botStep } from '../engine/host';
import { initPython, type PyInitOptions } from '../engine/python/host';

interface WorkerInit {
  py: PyInitOptions | null;
  ctl: SharedArrayBuffer;
  pyInterrupt: SharedArrayBuffer;
}

const init = workerData as WorkerInit;
const host = new ScriptHost(init.py);
const ctl = new Int32Array(init.ctl);
const pyInterrupt = new Uint8Array(init.pyInterrupt);
let interruptInstalled = false;

async function ensurePython(): Promise<void> {
  if (!init.py) throw new Error('Python is not available');
  const p = await initPython(init.py);
  if (!interruptInstalled) {
    p.setInterruptBuffer(pyInterrupt);
    interruptInstalled = true;
  }
}

function transferables(x: unknown, out: ArrayBuffer[] = [], seen = new Set<unknown>(), depth = 0): ArrayBuffer[] {
  if (!x || typeof x !== 'object' || depth > 6 || seen.has(x)) return out;
  seen.add(x);
  if (ArrayBuffer.isView(x)) {
    const b = (x as Float64Array).buffer;
    // only transfer buffers that are exclusively owned by this view
    if (b instanceof ArrayBuffer && (x as Float64Array).byteOffset === 0 && (x as Float64Array).byteLength === b.byteLength && !out.includes(b)) out.push(b);
    return out;
  }
  if (Array.isArray(x)) {
    for (const v of x) transferables(v, out, seen, depth + 1);
    return out;
  }
  for (const v of Object.values(x)) transferables(v, out, seen, depth + 1);
  return out;
}

async function handle(m: any): Promise<{ r: unknown; transfer: boolean }> {
  switch (m.op) {
    case 'ping':
      return { r: { instances: host.size }, transfer: false };
    case 'warmPython':
      await ensurePython();
      return { r: true, transfer: false };
    case 'analyze':
      if (m.lang === 'python') await ensurePython();
      return { r: await host.analyze(m.lang, m.code, m.ctx), transfer: false };
    case 'open':
      if (m.spec.lang === 'python') await ensurePython();
      return { r: await host.open(m.inst, m.spec), transfer: false };
    case 'update':
      return { r: await host.update(m.inst, m.u), transfer: false };
    case 'close':
      host.close(m.inst);
      return { r: true, transfer: false };
    case 'run': {
      if (m.spec.lang === 'python') await ensurePython();
      const jobId = m.id as number;
      const spec = { ...m.spec, shouldStop: () => Atomics.load(ctl, 0) === jobId };
      if (m.debug) {
        const dctl = new Int32Array(m.debug.sab as SharedArrayBuffer);
        spec.debug = {
          ctrl: dctl,
          breakpoints: m.debug.breakpoints || [],
          breakOnNext: !!m.debug.breakOnNext,
          onPause: (snapshot: unknown, reason: string) => parentPort!.postMessage({ event: 'debugPause', job: jobId, snapshot, reason }),
        };
      }
      const r = await host.run(spec);
      // results of one-shot runs own their arrays: transfer instead of copying
      return { r, transfer: true };
    }
    case 'trial': {
      if (m.spec.lang === 'python') await ensurePython();
      const jobId = m.id as number;
      const r = await runTrial(host, { ...m.spec, shouldStop: () => Atomics.load(ctl, 0) === jobId } as never);
      return { r, transfer: false };
    }
    case 'botStep': {
      if (m.spec.lang === 'python') await ensurePython();
      const jobId = m.id as number;
      const r = await botStep(host, { ...m.spec, shouldStop: () => Atomics.load(ctl, 0) === jobId });
      return { r, transfer: false };
    }
    default:
      throw new Error(`Unknown op ${m.op}`);
  }
}

let queue: Promise<void> = Promise.resolve();

parentPort!.on('message', (m: any) => {
  queue = queue.then(async () => {
    try {
      const { r, transfer } = await handle(m);
      if (transfer) {
        let list: ArrayBuffer[] = [];
        try {
          list = transferables(r);
        } catch {
          list = [];
        }
        parentPort!.postMessage({ id: m.id, ok: true, r }, list);
      } else parentPort!.postMessage({ id: m.id, ok: true, r });
    } catch (e) {
      parentPort!.postMessage({ id: m.id, ok: false, error: (e as Error)?.message || String(e) });
    } finally {
      if (Atomics.load(ctl, 0) === m.id) Atomics.store(ctl, 0, 0);
    }
  });
});

parentPort!.postMessage({ event: 'ready' });
