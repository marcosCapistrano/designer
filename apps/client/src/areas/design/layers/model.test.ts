import { describe, expect, it } from 'vitest';
import type { LayerNode } from '@hub/protocol';
import { autoOpen, layerRows, presentIn, subtree } from './model.js';

const tree: LayerNode = {
  id: 'root', name: 'div', kind: 'element', children: [
    { id: 'h', name: 'Title', kind: 'text', text: 'Hi', children: [] },
    { id: 'a', name: 'Filter Panel', kind: 'instance', component: 'C', children: [
      { id: 'a/r', name: 'Filter Panel', kind: 'element', children: [
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
    const deeper = layerRows(tree, { open: new Set(['root', 'a', 'a/r']), selected: [], present: () => true });
    expect(deeper.map((r) => r.node.id)).toEqual(['root', 'h', 'a', 'a/r', 'a/s']);
  });
  it('marks layers without a box in the frame as absent', () => {
    const rows = layerRows(tree, { open: new Set(['root']), selected: [], present: (id) => id !== 'h' });
    expect(rows.find((r) => r.node.id === 'h')!.present).toBe(false);
    expect(rows.find((r) => r.node.id === 'a')!.present).toBe(true);
  });
});

describe('autoOpen', () => {
  it('opens the ancestors of the selection, through instances', () => {
    expect([...autoOpen(tree, ['a/s'])].sort()).toEqual(['a', 'a/r', 'root']);
    expect([...autoOpen(tree, ['missing'])]).toEqual([]);
  });
});

describe('subtree', () => {
  it('finds a layer by id', () => {
    expect(subtree(tree, 'a/r')?.name).toBe('Filter Panel');
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
