import { describe, expect, test } from 'vitest';
import { sampleDoc } from './fixtures.js';
import { allIds, allocIds, findNode, isDescendant, nextSeq, walkDoc } from './tree.js';
import type { DesignDoc, DesignNode, ElementNode } from './types.js';

function nodeById(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (!hit) throw new Error(`fixture is missing ${id}`);
  return hit.node;
}

function homeRoot(doc: DesignDoc): ElementNode {
  const page = doc.pages['home'];
  if (!page) throw new Error('fixture is missing the home page');
  return page.root;
}

describe('findNode', () => {
  test('finds nested node', () => {
    const hit = findNode(sampleDoc(), 'n4');
    expect(hit?.node.id).toBe('n4');
    expect(hit?.parent?.id).toBe('n3');
    expect(hit?.index).toBe(0);
    expect(hit?.container).toEqual({ kind: 'page', key: 'home' });
    expect(hit?.path.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  test('reports the index among siblings', () => {
    const hit = findNode(sampleDoc(), 'n5');
    expect(hit?.parent?.id).toBe('n1');
    expect(hit?.index).toBe(1);
    expect(hit?.path.map((n) => n.id)).toEqual(['n1']);
  });

  test('finds component node', () => {
    expect(findNode(sampleDoc(), 'n8')?.container).toEqual({ kind: 'component', key: 'Card' });
  });

  test('root has no parent and an empty path', () => {
    const hit = findNode(sampleDoc(), 'n1');
    expect(hit?.parent).toBeNull();
    expect(hit?.index).toBe(0);
    expect(hit?.path).toEqual([]);
  });

  test('component root has no parent', () => {
    const hit = findNode(sampleDoc(), 'n6');
    expect(hit?.parent).toBeNull();
    expect(hit?.container).toEqual({ kind: 'component', key: 'Card' });
  });

  test('missing returns null', () => {
    expect(findNode(sampleDoc(), 'zzz')).toBeNull();
  });
});

describe('walkDoc', () => {
  test('visits pages then components, pre-order, with containers', () => {
    const seen: [string, string, string][] = [];
    walkDoc(sampleDoc(), (node, container) => {
      seen.push([node.id, container.kind, container.key]);
    });
    expect(seen).toEqual([
      ['n1', 'page', 'home'],
      ['n2', 'page', 'home'],
      ['n3', 'page', 'home'],
      ['n4', 'page', 'home'],
      ['n5', 'page', 'home'],
      ['n6', 'component', 'Card'],
      ['n7', 'component', 'Card'],
      ['n8', 'component', 'Card'],
    ]);
  });
});

describe('allIds', () => {
  test('lists ids in walk order', () => {
    expect(allIds(sampleDoc())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
  });
});

describe('allocIds', () => {
  test('allocates from meta.seq without changing the doc', () => {
    const doc = sampleDoc();
    expect(allocIds(doc, 2)).toEqual(['n9', 'n10']);
    expect(doc.meta.seq).toBe(9);
    expect(doc).toEqual(sampleDoc());
  });

  test('allocates past an id that is above meta.seq', () => {
    const doc = sampleDoc();
    doc.meta.seq = 1;
    homeRoot(doc).children.push({ id: 'n41', kind: 'text', text: 'far' });
    expect(allocIds(doc, 1)).toEqual(['n42']);
  });
});

describe('nextSeq', () => {
  test('uses meta.seq when it is already past every id', () => {
    expect(nextSeq(sampleDoc())).toBe(9);
  });

  test('uses max id plus one when it is above meta.seq', () => {
    const doc = sampleDoc();
    doc.meta.seq = 1;
    homeRoot(doc).children.push({ id: 'n41', kind: 'text', text: 'far' });
    expect(nextSeq(doc)).toBe(42);
  });

  test('ignores ids that do not match /^n(\\d+)$/', () => {
    const doc = sampleDoc();
    doc.meta.seq = 1;
    // The fixture's n8 already sets the floor at 9. If n41x were matched, the result would be 42.
    homeRoot(doc).children.push({ id: 'n41x', kind: 'text', text: 'odd' });
    expect(nextSeq(doc)).toBe(9);
  });
});

describe('isDescendant', () => {
  test('a node contains its own descendants', () => {
    const doc = sampleDoc();
    expect(isDescendant(nodeById(doc, 'n2'), 'n4')).toBe(true);
  });

  test('a node does not contain its ancestors', () => {
    const doc = sampleDoc();
    expect(isDescendant(nodeById(doc, 'n4'), 'n2')).toBe(false);
  });

  test('a node contains itself', () => {
    const doc = sampleDoc();
    expect(isDescendant(nodeById(doc, 'n2'), 'n2')).toBe(true);
  });

  test('an instance has no children to descend into', () => {
    const doc = sampleDoc();
    const instance = nodeById(doc, 'n5');
    expect(isDescendant(instance, 'n5')).toBe(true);
    expect(isDescendant(instance, 'n6')).toBe(false);
  });
});
