import { describe, expect, test } from 'vitest';
import { applyOp, applyOpInternal } from '../apply.js';
import { canonicalStringify } from '../canonical.js';
import { sampleDoc } from '../fixtures.js';
import { findNode } from '../tree.js';
import type { DesignDoc, DesignNode, ElementNode, Op } from '../types.js';

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

// Everything an op can change, in canonical form. meta.seq is left out: undo never lowers it.
function content(doc: DesignDoc): string[] {
  return [doc.pages, doc.components, doc.tokens].map((part) => canonicalStringify(part));
}

function element(id: string, children: DesignNode[] = [], tag = 'section'): ElementNode {
  return { id, kind: 'element', tag, attrs: {}, style: { base: {} }, children };
}

function instance(id: string, component: string, props: Record<string, string> = {}): DesignNode {
  return { id, kind: 'instance', component, props, style: { base: {} } };
}

describe('extractComponent', () => {
  test('moves the header into a new component and puts an instance in its place', () => {
    const next = applied(sampleDoc(), {
      op: 'extractComponent', node: 'n2', component: 'SiteHeader', instanceId: 'n9',
    });
    expect(next.components.SiteHeader).toMatchObject({ name: 'SiteHeader', props: {}, root: { id: 'n2' } });
    expect(childrenOf(next, 'n1')[0]).toEqual({
      id: 'n9', kind: 'instance', name: 'Header', component: 'SiteHeader', props: {}, style: { base: {} },
    });
  });

  test('leaves the instance unnamed when the node had no name', () => {
    const unnamed = applied(sampleDoc(), { op: 'setName', node: 'n2', name: null });
    const next = applied(unnamed, {
      op: 'extractComponent', node: 'n2', component: 'SiteHeader', instanceId: 'n9',
    });
    expect(childrenOf(next, 'n1')[0]).not.toHaveProperty('name');
  });

  test('rejects a lowercase component name', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n2', component: 'card', instanceId: 'n9',
    })).toBe('Invalid component name "card"');
  });

  test('rejects a component name that already exists', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n2', component: 'Card', instanceId: 'n9',
    })).toBe('Component Card already exists');
  });

  test('rejects an instance id already in use', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n2', component: 'SiteHeader', instanceId: 'n3',
    })).toBe('Id n3 already exists');
  });

  test('rejects a node inside a component', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n7', component: 'SiteHeader', instanceId: 'n9',
    })).toBe('Node n7 is inside a component');
  });

  test('rejects a page root', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n1', component: 'SiteHeader', instanceId: 'n9',
    })).toBe('cannot extract a root');
  });

  test('rejects a text node', () => {
    expect(rejected(sampleDoc(), {
      op: 'extractComponent', node: 'n4', component: 'SiteHeader', instanceId: 'n9',
    })).toBe('Node n4 is not an element');
  });

  test('undo restores the page and removes the component', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, {
      op: 'extractComponent', node: 'n2', component: 'SiteHeader', instanceId: 'n9',
    });
    if (!result.ok) throw new Error(result.error);
    expect(content(undoneBy(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });
});

describe('setInstanceProp', () => {
  test('sets a declared prop on the instance', () => {
    const next = applied(sampleDoc(), { op: 'setInstanceProp', node: 'n5', prop: 'title', value: 'World' });
    expect(nodeOf(next, 'n5')).toMatchObject({ props: { title: 'World' } });
  });

  test('null removes the override', () => {
    const next = applied(sampleDoc(), { op: 'setInstanceProp', node: 'n5', prop: 'title', value: null });
    expect(nodeOf(next, 'n5')).toMatchObject({ props: {} });
  });

  test('does not change the input doc', () => {
    const doc = sampleDoc();
    applied(doc, { op: 'setInstanceProp', node: 'n5', prop: 'title', value: 'World' });
    expect(nodeOf(doc, 'n5')).toMatchObject({ props: { title: 'Hello' } });
  });

  test('rejects a prop the component does not declare', () => {
    expect(rejected(sampleDoc(), {
      op: 'setInstanceProp', node: 'n5', prop: 'subtitle', value: 'x',
    })).toBe('Component Card has no prop "subtitle"');
  });

  test('rejects a node that is not an instance', () => {
    expect(rejected(sampleDoc(), {
      op: 'setInstanceProp', node: 'n2', prop: 'title', value: 'x',
    })).toBe('Node n2 is not an instance');
  });
});

describe('detachInstance', () => {
  const cardIds = { n6: 'n9', n7: 'n10', n8: 'n11' };

  test('replaces the instance with a copy of the component root', () => {
    const next = applied(sampleDoc(), { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(childrenOf(next, 'n1').map((child) => child.id)).toEqual(['n2', 'n9']);
    expect(nodeOf(next, 'n9')).toMatchObject({ kind: 'element', tag: 'div' });
    expect(nodeOf(next, 'n11')).toEqual({ id: 'n11', kind: 'text', text: 'Hello' });
    expect(findNode(next, 'n5')).toBeNull();
  });

  test('keeps the component when its last instance is detached', () => {
    const next = applied(sampleDoc(), { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(next.components.Card).toBeDefined();
  });

  test('uses the prop default when the instance does not set the prop', () => {
    const unset = applied(sampleDoc(), { op: 'setInstanceProp', node: 'n5', prop: 'title', value: null });
    const next = applied(unset, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(nodeOf(next, 'n11')).toEqual({ id: 'n11', kind: 'text', text: 'Title' });
  });

  test('fills {{prop}} placeholders in attribute values', () => {
    const withAttr = applied(sampleDoc(), { op: 'setAttr', node: 'n6', name: 'title', value: '{{title}}!' });
    const next = applied(withAttr, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(nodeOf(next, 'n9')).toMatchObject({ attrs: { title: 'Hello!' } });
  });

  test('leaves unknown placeholders as written', () => {
    const withText = applied(sampleDoc(), { op: 'setText', node: 'n8', text: '{{missing}} {{title}}' });
    const next = applied(withText, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(nodeOf(next, 'n11')).toEqual({ id: 'n11', kind: 'text', text: '{{missing}} Hello' });
  });

  test('fills a placeholder inside a nested instance prop from the detached instance', () => {
    const doc = sampleDoc();
    doc.components.Layout = {
      name: 'Layout',
      props: { pageTitle: { default: 'Home' } },
      root: element('n20', [instance('n21', 'Card', { title: '{{pageTitle}}' })]),
    };
    const page = applied(doc, {
      op: 'insertNode', parent: 'n1', index: 0,
      node: instance('n9', 'Layout', { pageTitle: 'Hi' }),
    });
    const next = applied(page, {
      op: 'detachInstance', node: 'n9', idMap: { n20: 'n10', n21: 'n11' },
    });
    expect(nodeOf(next, 'n11')).toEqual(instance('n11', 'Card', { title: 'Hi' }));
  });

  test('merges the instance style over the root style, instance wins', () => {
    const styled = applied(sampleDoc(), { op: 'setStyle', node: 'n5', device: 'base', prop: 'padding', value: '4px' });
    const withMargin = applied(styled, { op: 'setStyle', node: 'n5', device: 'base', prop: 'margin', value: '2px' });
    const next = applied(withMargin, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(nodeOf(next, 'n9')).toMatchObject({ style: { base: { padding: '4px', margin: '2px' } } });
  });

  test('keeps the instance name on the copy root', () => {
    const named = applied(sampleDoc(), { op: 'setName', node: 'n5', name: 'Hero' });
    const next = applied(named, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    expect(nodeOf(next, 'n9')).toMatchObject({ name: 'Hero' });
  });

  test('the copy does not share objects with the component', () => {
    const next = applied(sampleDoc(), { op: 'detachInstance', node: 'n5', idMap: cardIds });
    const restyled = applied(next, { op: 'setStyle', node: 'n9', device: 'base', prop: 'padding', value: '1px' });
    expect(next.components.Card?.root.style.base).toEqual({ padding: '16px' });
    expect(restyled.components.Card?.root.style.base).toEqual({ padding: '16px' });
  });

  test('rejects an idMap that misses a component node', () => {
    expect(rejected(sampleDoc(), {
      op: 'detachInstance', node: 'n5', idMap: { n6: 'n9', n7: 'n10' },
    })).toBe('idMap must cover every component node');
  });

  test('rejects an idMap key that is not a node of the component', () => {
    expect(rejected(sampleDoc(), {
      op: 'detachInstance', node: 'n5', idMap: { ...cardIds, n2: 'n12' },
    })).toBe('idMap has unknown key n2');
  });

  test('rejects a new id that is already in the doc', () => {
    expect(rejected(sampleDoc(), {
      op: 'detachInstance', node: 'n5', idMap: { n6: 'n2', n7: 'n10', n8: 'n11' },
    })).toBe('Id n2 already exists');
  });

  test('rejects a node that is not an instance', () => {
    expect(rejected(sampleDoc(), {
      op: 'detachInstance', node: 'n2', idMap: cardIds,
    })).toBe('Node n2 is not an instance');
  });

  test('undo restores the instance', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'detachInstance', node: 'n5', idMap: cardIds });
    if (!result.ok) throw new Error(result.error);
    expect(content(undoneBy(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });
});

describe('removeNode and components', () => {
  test('removing the last instance keeps the component', () => {
    const next = applied(sampleDoc(), { op: 'removeNode', node: 'n5' });
    expect(next.components.Card).toBeDefined();
  });
});
