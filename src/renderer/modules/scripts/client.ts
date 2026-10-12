/** Renderer-side access to the script library (cached list, change events, editor navigation). */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { bus } from '../../lib/bus';
import { openModule } from '../../app/moduleOps';
import type { ScriptMeta, ScriptDoc } from '../../../main/scripts/library';
import type { AnalyzeResult } from '../../../engine/host';

export type { ScriptMeta, ScriptDoc, AnalyzeResult };

let cache: ScriptMeta[] | null = null;
let inflight: Promise<ScriptMeta[]> | null = null;
const listeners = new Set<(l: ScriptMeta[]) => void>();

export function loadScripts(force = false): Promise<ScriptMeta[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight && !force) return inflight;
  inflight = api.call<ScriptMeta[]>('scripts:list').then((l) => {
    cache = l;
    inflight = null;
    for (const fn of listeners) fn(l);
    return l;
  });
  return inflight;
}

api.on('scripts:changed', () => void loadScripts(true));

export function scriptMeta(id: string): ScriptMeta | undefined {
  return cache?.find((s) => s.id === id);
}

export function useScripts(): ScriptMeta[] | null {
  const [list, setList] = useState<ScriptMeta[] | null>(cache);
  useEffect(() => {
    listeners.add(setList);
    void loadScripts();
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/** Open a script in the Script Editor (reusing an open editor), optionally jumping to a line. */
export async function openScriptInEditor(scriptId: string | null, opts: { line?: number; draft?: { language: 'pine' | 'python'; code: string; name?: string } } = {}): Promise<void> {
  const moduleId = await openModule('scripts', scriptId ? { scriptId } : {});
  // the editor may mount after this event: it also reads scriptId from its config
  setTimeout(() => bus.emit('scripts:open', { moduleId, scriptId, line: opts.line, draft: opts.draft }, false), 50);
}
