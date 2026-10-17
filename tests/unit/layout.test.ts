import { describe, it, expect } from 'vitest';
import { insertModule, removeModule, split, stack, collectModules, type LayoutNode } from '../../src/shared/workspace';

const stackOf = (n: LayoutNode | null, id: string): Extract<LayoutNode, { type: 'stack' }> | null => {
  if (!n) return null;
  if (n.type === 'stack') return n.modules.includes(id) ? n : null;
  for (const c of n.children) {
    const r = stackOf(c, id);
    if (r) return r;
  }
  return null;
};

describe('workspace layout', () => {
  it('inserts a tab at a position in a stack and makes it active', () => {
    const s = stack(['a', 'b', 'c']);
    const at1 = insertModule(s, 'x', s.id, 'center', 1) as Extract<LayoutNode, { type: 'stack' }>;
    expect(at1.modules).toEqual(['a', 'x', 'b', 'c']);
    expect(at1.active).toBe(1);
    expect((insertModule(s, 'x', s.id, 'center') as Extract<LayoutNode, { type: 'stack' }>).modules).toEqual(['a', 'b', 'c', 'x']);
    expect((insertModule(s, 'x', s.id, 'center', 99) as Extract<LayoutNode, { type: 'stack' }>).modules).toEqual(['a', 'b', 'c', 'x']);
  });

  it('reorders a tab within its stack (remove, then insert at the index)', () => {
    const s = stack(['a', 'b', 'c']);
    const root = split('row', [s, stack(['d'])]);
    const moved = insertModule(removeModule(root, 'a'), 'a', s.id, 'center', 2);
    expect(stackOf(moved, 'a')!.modules).toEqual(['b', 'c', 'a']);
    expect(collectModules(moved).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a module dropped on the edge of a panel becomes a panel beside it', () => {
    const left = stack(['chart']);
    const right = stack(['book', 'tape']);
    const root = split('row', [left, right]);
    const moved = insertModule(removeModule(root, 'tape'), 'tape', left.id, 'right');
    expect(stackOf(moved, 'tape')!.modules).toEqual(['tape']);
    expect(stackOf(moved, 'book')!.modules).toEqual(['book']);
    expect(collectModules(moved)).toEqual(['chart', 'tape', 'book']);
  });
});
