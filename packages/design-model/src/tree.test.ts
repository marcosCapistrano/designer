import { describe, expect, test } from 'vitest';
import { sampleDoc } from './fixtures.js';
import { allIds, allocIds, depthOf, findNode, heightOf, isDescendant, nextSeq, walkDoc } from './tree.js';
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

function rootOf(id: string, children: DesignNode[] = []): ElementNode {
  return { id, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children };
}

// Keys are inserted b before a and Z before A, so only the sort can produce a, b, A, Z.
function unorderedDoc(): DesignDoc {
  return {
    meta: { version: 1, seq: 1 },
    pages: {
      b: { id: 'b', name: 'B', route: '/b', root: rootOf('n10', [{ id: 'n11', kind: 'text', text: 'in b' }]) },
      a: { id: 'a', name: 'A', route: '/a', root: rootOf('n20', [{ id: 'n21', kind: 'text', text: 'in a' }]) },
    },
    components: {
      Z: { name: 'Z', props: {}, root: rootOf('n30', [{ id: 'n31', kind: 'text', text: 'in Z' }]) },
      A: { name: 'A', props: {}, root: rootOf('n40', [{ id: 'n41', kind: 'text', text: 'in A' }]) },
    },
    tokens: {},
  };
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

describe('sorted traversal order', () => {
  test('walkDoc visits pages then components in sorted key order', () => {
    const seen: string[] = [];
    walkDoc(unorderedDoc(), (node, container) => {
      seen.push(`${container.kind}:${container.key}:${node.id}`);
    });
    expect(seen).toEqual([
      'page:a:n20',
      'page:a:n21',
      'page:b:n10',
      'page:b:n11',
      'component:A:n40',
      'component:A:n41',
      'component:Z:n30',
      'component:Z:n31',
    ]);
  });

  test('findNode resolves an id in page b', () => {
    const hit = findNode(unorderedDoc(), 'n11');
    expect(hit?.container).toEqual({ kind: 'page', key: 'b' });
    expect(hit?.parent?.id).toBe('n10');
    expect(hit?.path.map((n) => n.id)).toEqual(['n10']);
  });
});

describe('allIds', () => {
  test('lists ids in walk order', () => {
    expect(allIds(sampleDoc())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
  });

  test('follows sorted key order, not insertion order', () => {
    expect(allIds(unorderedDoc())).toEqual(['n20', 'n21', 'n10', 'n11', 'n40', 'n41', 'n30', 'n31']);
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

  test('accepts counts of 0 and 1000', () => {
    expect(allocIds(sampleDoc(), 0)).toEqual([]);
    expect(allocIds(sampleDoc(), 1000)).toHaveLength(1000);
  });

  test.each([-1, 1.5, 1001, NaN, Infinity])('throws a RangeError for the count %s', (count) => {
    expect(() => allocIds(sampleDoc(), count)).toThrow(RangeError);
    expect(() => allocIds(sampleDoc(), count)).toThrow('allocIds count must be an integer from 0 to 1000');
  });

  test('allocates the largest id n999999999999999 and no further', () => {
    const doc = sampleDoc();
    doc.meta.seq = 999999999999999;
    expect(allocIds(doc, 1)).toEqual(['n999999999999999']);
    expect(() => allocIds(doc, 2)).toThrow(RangeError);
    expect(() => allocIds(doc, 2)).toThrow('allocIds would exceed the largest node id n999999999999999');
  });

  test('throws when the highest existing id leaves no room for the count', () => {
    const doc = sampleDoc();
    homeRoot(doc).children.push({ id: 'n999999999999998', kind: 'text', text: 'last' });
    expect(allocIds(doc, 1)).toEqual(['n999999999999999']);
    expect(() => allocIds(doc, 2)).toThrow('allocIds would exceed the largest node id n999999999999999');
  });

  test('throws when meta.seq is already past the largest id', () => {
    const doc = sampleDoc();
    doc.meta.seq = 1000000000000000;
    expect(() => allocIds(doc, 1)).toThrow(RangeError);
  });

  test('a count of 0 never throws, even past the largest id', () => {
    const doc = sampleDoc();
    doc.meta.seq = 1000000000000000;
    expect(allocIds(doc, 0)).toEqual([]);
  });
});

describe('depthOf', () => {
  test('the page root is level 1', () => {
    expect(depthOf(sampleDoc(), 'n1')).toBe(1);
  });

  test('each level below the root adds one', () => {
    expect(depthOf(sampleDoc(), 'n2')).toBe(2);
    expect(depthOf(sampleDoc(), 'n3')).toBe(3);
    expect(depthOf(sampleDoc(), 'n4')).toBe(4);
    expect(depthOf(sampleDoc(), 'n5')).toBe(2);
  });

  test('a component root is level 1', () => {
    expect(depthOf(sampleDoc(), 'n6')).toBe(1);
    expect(depthOf(sampleDoc(), 'n8')).toBe(3);
  });

  test('throws for a missing id', () => {
    expect(() => depthOf(sampleDoc(), 'zzz')).toThrow('Node zzz not found');
  });
});

describe('heightOf', () => {
  test('a text or instance node is one level', () => {
    expect(heightOf({ id: 'n9', kind: 'text', text: 'x' })).toBe(1);
    expect(heightOf({ id: 'n9', kind: 'instance', component: 'Card', props: {}, style: { base: {} } })).toBe(1);
  });

  test('an element without children is one level', () => {
    expect(heightOf({ id: 'n9', kind: 'element', tag: 'p', attrs: {}, style: { base: {} }, children: [] })).toBe(1);
    expect(heightOf(nodeById(sampleDoc(), 'n7'))).toBe(2);
  });

  test('counts the levels of the deepest branch', () => {
    expect(heightOf(nodeById(sampleDoc(), 'n1'))).toBe(4);
    expect(heightOf(nodeById(sampleDoc(), 'n6'))).toBe(3);
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

  test('ignores an id with a prefix before the n', () => {
    const doc: DesignDoc = {
      meta: { version: 1, seq: 1 },
      pages: { p: { id: 'p', name: 'P', route: '/', root: rootOf('xn41') } },
      components: {},
      tokens: {},
    };
    expect(nextSeq(doc)).toBe(1);
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
