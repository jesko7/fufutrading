/** Automatic placement of new modules so panes never become too small to use. */
import type { DropPos, LayoutNode } from '../../shared/workspace';

type Stack = Extract<LayoutNode, { type: 'stack' }>;

/** Smallest pane a split may leave behind (px). */
const MIN_W = 360;
const MIN_H = 240;

function stacksOf(n: LayoutNode | null, out: Stack[] = []): Stack[] {
  if (!n) return out;
  if (n.type === 'stack') out.push(n);
  else for (const c of n.children) stacksOf(c, out);
  return out;
}

function sizeOf(id: string): { w: number; h: number } {
  const r = document.querySelector<HTMLElement>(`.stack[data-stack-id="${id}"]`)?.getBoundingClientRect();
  return r ? { w: r.width, h: r.height } : { w: 0, h: 0 };
}

/**
 * Where a new module goes: beside the preferred (focused) pane while both halves stay at least
 * MIN_W wide, else below it while both stay MIN_H tall, else the same in the largest pane, and
 * as a tab when nothing can be split. Explicit drops and menu choices are never changed.
 */
export function autoPlacement(root: LayoutNode | null, prefer: string | null): { stackId: string | null; pos: DropPos } {
  const all = stacksOf(root);
  if (!all.length) return { stackId: null, pos: 'right' };
  const fit = (s: Stack): DropPos | null => {
    const { w, h } = sizeOf(s.id);
    const right = w / 2 >= MIN_W;
    const below = h / 2 >= MIN_H;
    if (right && (w >= h * 1.2 || !below)) return 'right';
    if (below) return 'bottom';
    return null;
  };
  const pref = prefer ? all.find((s) => s.id === prefer) : undefined;
  if (pref) {
    const p = fit(pref);
    if (p) return { stackId: pref.id, pos: p };
  }
  let largest = all[0];
  let area = -1;
  for (const s of all) {
    const { w, h } = sizeOf(s.id);
    if (w * h > area) {
      area = w * h;
      largest = s;
    }
  }
  const p = fit(largest);
  if (p) return { stackId: largest.id, pos: p };
  return { stackId: (pref || largest).id, pos: 'center' };
}
