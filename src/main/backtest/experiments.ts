/**
 * Experiment tracker and saved parameter sets.
 *  - experiments: research notes with status, tags and links to backtests, optimizations,
 *    scripts and parameter sets,
 *  - parameter sets: named input values per script (from the optimizer, the tester or manual),
 *    usable on charts, in the Strategy Tester and by bots.
 */
import path from 'node:path';
import type { AppCore } from '../core';
import { DocStore, uid } from '../storage/jsonStore';

export type ExperimentStatus = 'idea' | 'testing' | 'promising' | 'rejected' | 'live';

export interface ExperimentLink {
  kind: 'backtest' | 'optimization' | 'script' | 'paramset';
  id: string;
  label: string;
  added: number;
}

export interface Experiment {
  id: string;
  title: string;
  notes: string;
  tags: string[];
  status: ExperimentStatus;
  links: ExperimentLink[];
  created: number;
  updated: number;
}

export interface ParamSet {
  id: string;
  scriptId: string;
  scriptName: string;
  name: string;
  inputs: Record<string, unknown>;
  notes?: string;
  source?: { kind: 'optimization' | 'backtest' | 'manual'; id?: string };
  /** Context the set was found in. */
  context?: { symbol?: string; market?: string; tf?: string };
  created: number;
}

const STATUSES: ExperimentStatus[] = ['idea', 'testing', 'promising', 'rejected', 'live'];

export class ExperimentService {
  private experiments: DocStore<Experiment>;
  private sets: DocStore<ParamSet>;

  constructor(private core: AppCore) {
    this.experiments = new DocStore<Experiment>(path.join(core.paths.userData, 'experiments'));
    this.sets = new DocStore<ParamSet>(path.join(core.paths.userData, 'paramsets'));
    core.onShutdown(() => {
      this.experiments.flush();
      this.sets.flush();
    });
    this.register();
  }

  private changed(kind: 'experiments' | 'paramsets', id: string): void {
    this.core.router.broadcast(`${kind}:changed`, { id });
  }

  listExperiments(): Experiment[] {
    return this.experiments.loadAll().sort((a, b) => b.updated - a.updated);
  }

  saveExperiment(e: Partial<Experiment> & { title?: string }): Experiment {
    const now = Date.now();
    const cur = e.id ? this.experiments.get(e.id) : undefined;
    const next: Experiment = {
      id: cur?.id || uid('exp'),
      title: String(e.title ?? cur?.title ?? 'New experiment').slice(0, 200) || 'New experiment',
      notes: String(e.notes ?? cur?.notes ?? '').slice(0, 200000),
      tags: (e.tags ?? cur?.tags ?? []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      status: STATUSES.includes(e.status as ExperimentStatus) ? (e.status as ExperimentStatus) : cur?.status || 'idea',
      links: e.links ?? cur?.links ?? [],
      created: cur?.created || now,
      updated: now,
    };
    this.experiments.put(next);
    this.changed('experiments', next.id);
    return next;
  }

  link(id: string, link: Omit<ExperimentLink, 'added'>): Experiment {
    const cur = this.experiments.get(id);
    if (!cur) throw new Error('Experiment not found');
    if (!cur.links.some((l) => l.kind === link.kind && l.id === link.id)) cur.links.push({ ...link, added: Date.now() });
    return this.saveExperiment(cur);
  }

  unlink(id: string, kind: string, linkId: string): Experiment {
    const cur = this.experiments.get(id);
    if (!cur) throw new Error('Experiment not found');
    cur.links = cur.links.filter((l) => !(l.kind === kind && l.id === linkId));
    return this.saveExperiment(cur);
  }

  saveSet(s: Omit<ParamSet, 'id' | 'created'> & { id?: string }): ParamSet {
    if (!s.scriptId) throw new Error('Validation: scriptId required');
    const cur = s.id ? this.sets.get(s.id) : undefined;
    const next: ParamSet = { ...cur, ...s, id: cur?.id || uid('ps'), name: String(s.name || 'Parameter set').slice(0, 120), inputs: { ...(s.inputs || {}) }, created: cur?.created || Date.now() } as ParamSet;
    this.sets.put(next, true);
    this.changed('paramsets', next.id);
    return next;
  }

  private register(): void {
    const r = this.core.router;
    r.handle('experiments:list', () => this.listExperiments());
    r.handle('experiments:save', ([e]) => this.saveExperiment(e || {}));
    r.handle('experiments:delete', ([id]) => {
      this.experiments.delete(String(id));
      this.changed('experiments', String(id));
      return true;
    });
    r.handle('experiments:link', ([id, link]) => this.link(String(id), link));
    r.handle('experiments:unlink', ([id, kind, linkId]) => this.unlink(String(id), String(kind), String(linkId)));
    r.handle('paramsets:list', ([scriptId]) =>
      this.sets
        .loadAll()
        .filter((s) => !scriptId || s.scriptId === scriptId)
        .sort((a, b) => b.created - a.created),
    );
    r.handle('paramsets:save', ([s]) => this.saveSet(s));
    r.handle('paramsets:delete', ([id]) => {
      this.sets.delete(String(id));
      this.changed('paramsets', String(id));
      return true;
    });
  }
}

export function registerExperiments(core: AppCore): ExperimentService {
  return new ExperimentService(core);
}
