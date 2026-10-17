import { describe, expect, it } from 'vitest';
import type { LayerNode } from '@hub/protocol';
import { autoOpen, instanceFor, layerRows, parentOf, presentIn, subtree } from './model.js';

const tree: LayerNode = {
  id: 'root', name: 'div', kind: 'element', children: [
    { id: 'h', name: 'Title', kind: 'text', text: 'Hi', children: [] },
    { id: 'a', name: 'Filter Panel', kind: 'instance', component: 'C', root: 'a/r', children: [
      { id: 'a/g', name: 'Group', kind: 'element', children: [
        { id: 'a/s', name: 'Verticais', kind: 'text', text: 'x', children: [] },
      ] },
    ] },
  ],
};

describe('layerRows', () => {
  it('lists open layers depth first, and only open layers show their children', () => {
    const rows = layerRows(tree, { open: new Set(['root']), selected: ['h'], present: () => true });
    expect(rows.map((r) => [r.node.id, r.depth, r.expandable, r.open, r.selected])).toEqual([
      ['root', 0, true, true, false],
      ['h', 1, false, false, true],
      ['a', 1, true, false, false],
    ]);
    const deeper = layerRows(tree, { open: new Set(['root', 'a', 'a/g']), selected: [], present: () => true });
    expect(deeper.map((r) => r.node.id)).toEqual(['root', 'h', 'a', 'a/g', 'a/s']);
    // A selected component root is its instance's row.
    expect(layerRows(tree, { open: new Set(['root']), selected: ['a/r'], present: () => true }).find((r) => r.node.id === 'a')!.selected).toBe(true);
  });
  it('marks layers without a box in the frame as absent', () => {
    const rows = layerRows(tree, { open: new Set(['root']), selected: [], present: (id) => id !== 'h' });
    expect(rows.find((r) => r.node.id === 'h')!.present).toBe(false);
    expect(rows.find((r) => r.node.id === 'a')!.present).toBe(true);
  });
});

describe('autoOpen', () => {
  it('opens the ancestors of the selection, through instances', () => {
    expect([...autoOpen(tree, ['a/s'])].sort()).toEqual(['a', 'a/g', 'root']);
    expect([...autoOpen(tree, ['a/r'])].sort()).toEqual(['root']);
    expect([...autoOpen(tree, ['missing'])]).toEqual([]);
  });
});

describe('subtree', () => {
  it('finds a layer by id', () => {
    expect(subtree(tree, 'a/g')?.name).toBe('Group');
    expect(subtree(tree, 'a/r')?.id).toBe('a');
    expect(subtree(tree, 'nope')).toBeNull();
  });
});

describe('presentIn', () => {
  it('a layer is present with its own box or a box under it; unknown maps count every layer present', () => {
    const present = presentIn([{ nodeId: 'h', x: 0, y: 0, w: 1, h: 1 }, { nodeId: 'a/r', x: 0, y: 0, w: 1, h: 1 }]);
    expect(present('h')).toBe(true);
    expect(present('a')).toBe(true);
    expect(present('a/s')).toBe(false);
    expect(presentIn(null)('anything')).toBe(true);
  });
});

describe('parentOf', () => {
  it('is the layer one level up; a component root counts as its instance', () => {
    expect(parentOf(tree, 'a/s')).toBe('a/g');
    expect(parentOf(tree, 'a/g')).toBe('a');
    expect(parentOf(tree, 'a')).toBe('root');
    expect(parentOf(tree, 'a/r')).toBe('root');
    expect(parentOf(tree, 'root')).toBeNull();
    expect(parentOf(tree, 'nope')).toBeNull();
  });
});

describe('instanceFor', () => {
  it('is the instance a component root id draws, else null', () => {
    expect(instanceFor(tree, 'a/r')).toBe('a');
    expect(instanceFor(tree, 'a/g')).toBeNull();
    expect(instanceFor(tree, 'a')).toBeNull();
  });
});
