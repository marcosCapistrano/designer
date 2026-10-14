import { describe, expect, test } from 'vitest';
import { applyOp, applyOpInternal } from '../apply.js';
import { canonicalStringify } from '../canonical.js';
import { sampleDoc } from '../fixtures.js';
import { allocIds, findNode } from '../tree.js';
import type { DesignDoc, DesignNode, ElementNode, Op } from '../types.js';
import { nodeProblem } from '../shape.js';
import { validateSubtree } from './structure.js';

const TOO_DEEP = 'Node tree deeper than 64 levels';

function applied(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

// Undo applies a restore op, which only the internal path accepts.
function undoneBy(doc: DesignDoc, inverse: Op): DesignDoc {
  const result = applyOpInternal(doc, inverse);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error('expected the op to be rejected');
  return result.error;
}

function nodeOf(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`fixture is missing ${id}`);
  return hit.node;
}

function childrenOf(doc: DesignDoc, id: string): DesignNode[] {
  const node = nodeOf(doc, id);
  if (node.kind !== 'element') throw new Error(`${id} is not an element`);
  return node.children;
}

function childIds(doc: DesignDoc, id: string): string[] {
  return childrenOf(doc, id).map((child) => child.id);
}

// Everything an op can change, in canonical form. meta.seq is left out: undo never lowers it.
function content(doc: DesignDoc): string[] {
  return [doc.pages, doc.components, doc.tokens].map((part) => canonicalStringify(part));
}

function element(id: string, children: DesignNode[] = [], tag = 'section'): ElementNode {
  return { id, kind: 'element', tag, attrs: {}, style: { base: {} }, children };
}

function text(id: string, value = 'x'): DesignNode {
  return { id, kind: 'text', text: value };
}

// A chain of `height` levels: element nodes down to one text leaf. Ids are `${prefix}1` to `${prefix}${height}`.
function chain(height: number, prefix: string): DesignNode {
  let node: DesignNode = text(`${prefix}${height}`);
  for (let level = height - 1; level >= 1; level--) {
    node = element(`${prefix}${level}`, [node]);
  }
  return node;
}

function homeRoot(doc: DesignDoc): ElementNode {
  const page = doc.pages['home'];
  if (!page) throw new Error('fixture is missing the home page');
  return page.root;
}

describe('insertNode', () => {
  test('inserts a text node into the header', () => {
    const next = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 1, node: text('n9', 'Hi'),
    });
    expect(childIds(next, 'n2')).toEqual(['n3', 'n9']);
    expect(next.meta.seq).toBe(10);
  });

  test('inserts an instance of an existing component', () => {
    const next = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n1', index: 0,
      node: { id: 'n9', kind: 'instance', component: 'Card', props: { title: 'Two' }, style: { base: {} } },
    });
    expect(childIds(next, 'n1')).toEqual(['n9', 'n2', 'n5']);
  });

  test('inserts a copy, not the node object from the op', () => {
    const node = element('n9', [text('n10')], 'p');
    const next = applied(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 0, node });
    expect(childrenOf(next, 'n2')[0]).toEqual(node);
    expect(childrenOf(next, 'n2')[0]).not.toBe(node);
  });

  test('rejects a duplicate id', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: text('n3'),
    })).toBe('Id n3 already exists');
  });

  test('rejects a duplicate id within the inserted subtree', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [text('n9')]),
    })).toBe('Id n9 already exists');
  });

  test('rejects an insert into a text node', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n4', index: 0, node: text('n9'),
    })).toContain('is not an element');
  });

  test('rejects an index past the end of the children', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 2, node: text('n9'),
    })).toContain('out of range');
  });

  test('rejects a negative index', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: -1, node: text('n9'),
    })).toBe('Malformed op: insertNode.index must be a non-negative integer');
  });

  test('rejects an invalid tag', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [], 'Div'),
    })).toContain('Invalid tag "Div"');
  });

  test('rejects an invalid style value in the subtree', () => {
    const node: ElementNode = { ...element('n9'), style: { base: {}, tablet: { padding: '12' } } };
    expect(rejected(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 0, node })).toContain('padding');
  });

  test('rejects an instance of a missing component', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n1', index: 0,
      node: { id: 'n9', kind: 'instance', component: 'Missing', props: {}, style: { base: {} } },
    })).toBe('Component Missing not found');
  });

  test('rejects an empty node id as a malformed op', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: text(''),
    })).toBe('Malformed op: insertNode.node: node id must be a non-empty string');
  });

  test.each(['a b', 'x"y', 'n5/n6', 'n9007199254740993'])('rejects the node id %j', (id) => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: text(id),
    })).toBe(`Invalid node id "${id}"`);
  });

  test('accepts the id n999999999999999, and allocIds then has no id left to give', () => {
    const next = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: text('n999999999999999'),
    });
    expect(allocIds(next, 0)).toEqual([]);
    expect(() => allocIds(next, 1)).toThrow('allocIds would exceed the largest node id n999999999999999');
  });

  test.each(['script', 'style', 'iframe'])('rejects the denied tag %s', (tag) => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [], tag),
    })).toBe(`Tag "${tag}" is not allowed`);
  });

  test('rejects an unsafe URL attribute in the subtree', () => {
    const node: ElementNode = { ...element('n9'), attrs: { href: 'javascript:alert(1)' } };
    expect(rejected(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 0, node }))
      .toBe('Unsafe URL in attribute href');
  });

  test('rejects a srcdoc attribute in the subtree', () => {
    const node: ElementNode = { ...element('n9'), attrs: { srcdoc: '<p>x</p>' } };
    expect(rejected(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 0, node }))
      .toBe('Attribute srcdoc is not allowed');
  });

  test('rejects an insert into an img', () => {
    const withImg = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [], 'img'),
    });
    expect(rejected(withImg, { op: 'insertNode', parent: 'n9', index: 0, node: text('n10') }))
      .toBe('Void element img cannot have children');
  });

  test('rejects an inserted img that has children', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [text('n10')], 'img'),
    })).toBe('Void element img cannot have children');
  });

  test('rejects an instance prop the component does not declare', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n1', index: 0,
      node: { id: 'n9', kind: 'instance', component: 'Card', props: { subtitle: 'x' }, style: { base: {} } },
    })).toBe('Component Card has no prop "subtitle"');
  });
});

describe('removeNode', () => {
  test('removes a button, and undo restores it', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'removeNode', node: 'n3' });
    if (!result.ok) throw new Error(result.error);
    expect(childIds(result.value.doc, 'n2')).toEqual([]);

    const undone = undoneBy(result.value.doc, result.value.inverse);
    expect(content(undone)).toEqual(content(doc));
  });

  test('rejects a page root', () => {
    expect(rejected(sampleDoc(), { op: 'removeNode', node: 'n1' })).toBe('cannot remove a root');
  });

  test('rejects a component root', () => {
    expect(rejected(sampleDoc(), { op: 'removeNode', node: 'n6' })).toBe('cannot remove a root');
  });
});

describe('moveNode', () => {
  test('moves n5 to index 0 of n1', () => {
    const next = applied(sampleDoc(), { op: 'moveNode', node: 'n5', parent: 'n1', index: 0 });
    expect(childIds(next, 'n1')).toEqual(['n5', 'n2']);
  });

  test('reads the index after the node is detached from its parent', () => {
    // Detaching n2 leaves [n5], so index 1 is the end of the list.
    const next = applied(sampleDoc(), { op: 'moveNode', node: 'n2', parent: 'n1', index: 1 });
    expect(childIds(next, 'n1')).toEqual(['n5', 'n2']);
  });

  test('rejects an index past the end after detaching', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n2', parent: 'n1', index: 2,
    })).toContain('out of range');
  });

  test('rejects a move into a descendant', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n2', parent: 'n3', index: 0,
    })).toContain('descendant');
  });

  test('rejects a move into an img', () => {
    const withImg = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 0, node: element('n9', [], 'img'),
    });
    expect(rejected(withImg, { op: 'moveNode', node: 'n5', parent: 'n9', index: 0 }))
      .toBe('Void element img cannot have children');
  });

  test('rejects a move into itself', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n2', parent: 'n2', index: 0,
    })).toContain('descendant');
  });

  test('rejects a cross-container move', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n7', parent: 'n1', index: 0,
    })).toContain('container');
  });

  test('rejects a text parent', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n5', parent: 'n4', index: 0,
    })).toContain('is not an element');
  });

  test('rejects a page root', () => {
    expect(rejected(sampleDoc(), {
      op: 'moveNode', node: 'n1', parent: 'n2', index: 0,
    })).toBe('cannot move a root');
  });
});

describe('wrapNodes', () => {
  test('wraps n2 and n5 in n9, the only child of n1', () => {
    const next = applied(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n2', 'n5'], wrapper: element('n9'),
    });
    expect(childIds(next, 'n1')).toEqual(['n9']);
    expect(childIds(next, 'n9')).toEqual(['n2', 'n5']);
  });

  test('wraps a single node at its own index', () => {
    const next = applied(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n5'], wrapper: element('n9'),
    });
    expect(childIds(next, 'n1')).toEqual(['n2', 'n9']);
    expect(childIds(next, 'n9')).toEqual(['n5']);
  });

  test('rejects nodes that are not contiguous', () => {
    const three = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n1', index: 1, node: text('n9', 'between'),
    });
    expect(rejected(three, {
      op: 'wrapNodes', nodes: ['n2', 'n5'], wrapper: element('n10'),
    })).toBe('nodes must be contiguous siblings');
  });

  test('rejects nodes given out of document order', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n5', 'n2'], wrapper: element('n9'),
    })).toBe('nodes must be contiguous siblings');
  });

  test('rejects nodes under different parents', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n3', 'n5'], wrapper: element('n9'),
    })).toBe('nodes must be contiguous siblings');
  });

  test('rejects an empty node list', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: [], wrapper: element('n9'),
    })).toBe('nodes must be contiguous siblings');
  });

  test('rejects a page root', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n1'], wrapper: element('n9'),
    })).toBe('cannot wrap a root');
  });

  test('rejects a wrapper that already has children', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n5'], wrapper: element('n9', [text('n10')]),
    })).toBe('wrapper must be an element with no children');
  });

  test('rejects a void wrapper', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n5'], wrapper: element('n9', [], 'img'),
    })).toBe('Void element img cannot have children');
  });

  test('rejects a wrapper id that is already in use', () => {
    expect(rejected(sampleDoc(), {
      op: 'wrapNodes', nodes: ['n5'], wrapper: element('n2'),
    })).toBe('Id n2 already exists');
  });

  test('wraps a copy of the wrapper, not the object from the op', () => {
    const wrapper = element('n9');
    const next = applied(sampleDoc(), { op: 'wrapNodes', nodes: ['n5'], wrapper });
    expect(nodeOf(next, 'n9')).toEqual(element('n9', [nodeOf(next, 'n5')]));
    expect(nodeOf(next, 'n9')).not.toBe(wrapper);
  });

  test('undo restores the original tree', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'wrapNodes', nodes: ['n2', 'n5'], wrapper: element('n9') });
    if (!result.ok) throw new Error(result.error);
    expect(content(undoneBy(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });
});

function instance(id: string, component: string): DesignNode {
  return { id, kind: 'instance', component, props: {}, style: { base: {} } };
}

// The Card root holds Shell, and Shell holds Card, so the doc already has a cycle. Only the
// move and wrap tests use it: those ops rearrange nodes already in the container, so an
// insertNode could never produce this doc.
function cyclicDoc(): DesignDoc {
  const doc = sampleDoc();
  doc.components.Shell = { name: 'Shell', props: {}, root: element('n20', [instance('n21', 'Card')]) };
  doc.components.Card?.root.children.push(instance('n10', 'Shell'));
  return doc;
}

// Shell holds a Card instance, so Shell reaches Card but Card does not reach Shell.
function shellDoc(): DesignDoc {
  const doc = sampleDoc();
  doc.components.Shell = { name: 'Shell', props: {}, root: element('n20', [instance('n21', 'Card')]) };
  return doc;
}

describe('whole-tree depth', () => {
  test('insertNode applies a payload that ends at level 64 under a level-2 parent', () => {
    const next = applied(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 1, node: chain(62, 'd') });
    expect(nodeProblem(homeRoot(next))).toBeNull();
  });

  test('insertNode rejects a payload that would end at level 65 under a level-2 parent', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 1, node: chain(63, 'd'),
    })).toBe(TOO_DEEP);
  });

  test('insertNode applies a 63-level payload under the page root', () => {
    const next = applied(sampleDoc(), { op: 'insertNode', parent: 'n1', index: 0, node: chain(63, 'd') });
    expect(nodeProblem(homeRoot(next))).toBeNull();
  });

  test('insertNode rejects a 64-level payload under the page root', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n1', index: 0, node: chain(64, 'd'),
    })).toBe(TOO_DEEP);
  });

  // n2 holds the chain t1 to t40, so t_i is level i + 2 and t28 is level 30.
  function docWithMovable(height: number): DesignDoc {
    const withTargets = applied(sampleDoc(), {
      op: 'insertNode', parent: 'n2', index: 1, node: chain(40, 't'),
    });
    return applied(withTargets, { op: 'insertNode', parent: 'n1', index: 2, node: chain(height, 'm') });
  }

  test('moveNode applies a subtree that ends at level 64 under a level-30 parent', () => {
    const next = applied(docWithMovable(34), { op: 'moveNode', node: 'm1', parent: 't28', index: 0 });
    expect(nodeProblem(homeRoot(next))).toBeNull();
  });

  test('moveNode rejects a subtree that would end at level 65 under a level-30 parent', () => {
    expect(rejected(docWithMovable(35), {
      op: 'moveNode', node: 'm1', parent: 't28', index: 0,
    })).toBe(TOO_DEEP);
  });

  // n2 holds n3 and the chain d1 to d_height, so wrapping d1 puts it one level lower.
  function docWithWrapTarget(height: number): DesignDoc {
    return applied(sampleDoc(), { op: 'insertNode', parent: 'n2', index: 1, node: chain(height, 'd') });
  }

  test('wrapNodes applies a wrap that ends at level 64 under a level-2 parent', () => {
    const next = applied(docWithWrapTarget(61), { op: 'wrapNodes', nodes: ['d1'], wrapper: element('w1') });
    expect(nodeProblem(homeRoot(next))).toBeNull();
  });

  test('wrapNodes rejects a wrap that would end at level 65 under a level-2 parent', () => {
    expect(rejected(docWithWrapTarget(62), {
      op: 'wrapNodes', nodes: ['d1'], wrapper: element('w1'),
    })).toBe(TOO_DEEP);
  });

  test('wrapNodes measures the tallest wrapped node, not the first', () => {
    expect(rejected(docWithWrapTarget(62), {
      op: 'wrapNodes', nodes: ['n3', 'd1'], wrapper: element('w1'),
    })).toBe(TOO_DEEP);
  });
});

describe('component cycles', () => {
  test('rejects an instance of Card inserted into Card', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n6', index: 0, node: instance('n9', 'Card'),
    })).toBe('Component cycle at Card');
  });

  test('rejects a cycle nested inside the inserted subtree', () => {
    expect(rejected(sampleDoc(), {
      op: 'insertNode', parent: 'n6', index: 0, node: element('n9', [instance('n10', 'Card')]),
    })).toBe('Component cycle at Card');
  });

  test('rejects an instance whose expansion contains Card', () => {
    expect(rejected(shellDoc(), {
      op: 'insertNode', parent: 'n6', index: 0, node: instance('n9', 'Shell'),
    })).toBe('Component cycle at Card');
  });

  test('allows an instance of Card inside Shell, because Card does not reach Shell', () => {
    expect(childIds(applied(shellDoc(), {
      op: 'insertNode', parent: 'n20', index: 1, node: instance('n9', 'Card'),
    }), 'n20')).toEqual(['n21', 'n9']);
  });

  test('allows an instance of Shell inside a page', () => {
    expect(childIds(applied(shellDoc(), {
      op: 'insertNode', parent: 'n1', index: 0, node: instance('n9', 'Shell'),
    }), 'n1')).toEqual(['n9', 'n2', 'n5']);
  });

  test('moveNode rejects a subtree that reaches the container', () => {
    expect(rejected(cyclicDoc(), {
      op: 'moveNode', node: 'n10', parent: 'n6', index: 0,
    })).toBe('Component cycle at Card');
  });

  test('wrapNodes rejects a subtree that reaches the container', () => {
    expect(rejected(cyclicDoc(), {
      op: 'wrapNodes', nodes: ['n10'], wrapper: element('n11'),
    })).toBe('Component cycle at Card');
  });
});

describe('validateSubtree', () => {
  test('accepts a valid subtree', () => {
    expect(validateSubtree(sampleDoc(), element('n9', [text('n10')]))).toBeNull();
  });

  test('reports an id that is already in the doc', () => {
    expect(validateSubtree(sampleDoc(), element('n2'))).toBe('Id n2 already exists');
  });

  test('reports an id listed in ctx.extraIds', () => {
    const ctx = { extraIds: new Set(['n9']) };
    expect(validateSubtree(sampleDoc(), element('n9'), ctx)).toBe('Id n9 already exists');
  });

  test('reports an invalid attribute name', () => {
    const node: ElementNode = { ...element('n9'), attrs: { onclick: 'alert(1)' } };
    expect(validateSubtree(sampleDoc(), node)).toBe('Attribute "onclick" is not allowed');
  });

  test('reports an unknown device key in a style', () => {
    const node = { ...element('n9'), style: { base: {}, desktop: { padding: '4px' } } } as unknown as ElementNode;
    expect(validateSubtree(sampleDoc(), node)).toContain('desktop');
  });
});
