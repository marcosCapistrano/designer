import { describe, expect, test } from 'vitest';
import { findNode } from './tree.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { MAX_DEPTH } from './shape.js';
import { validateDoc } from './validate.js';
import type { DesignDoc, DesignNode, ElementNode, InstanceNode } from './types.js';

// A fresh copy of the sample, so each test mutates its own doc.
function mutableDoc(): DesignDoc {
  return structuredClone(sampleDoc());
}

function at(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`fixture is missing node ${id}`);
  return hit.node;
}

function element(doc: DesignDoc, id: string): ElementNode {
  const node = at(doc, id);
  if (node.kind !== 'element') throw new Error(`fixture node ${id} is not an element`);
  return node;
}

function instance(doc: DesignDoc, id: string): InstanceNode {
  const node = at(doc, id);
  if (node.kind !== 'instance') throw new Error(`fixture node ${id} is not an instance`);
  return node;
}

// An element chain with `levels` nodes from the root down. The root is level 1.
function chain(levels: number, level = 1): ElementNode {
  return {
    id: `d${level}`,
    kind: 'element',
    tag: 'div',
    attrs: {},
    style: { base: {} },
    children: level < levels ? [chain(levels, level + 1)] : [],
  };
}

function withHomeRoot(root: ElementNode): DesignDoc {
  const doc = mutableDoc();
  doc.pages = { home: { id: 'home', name: 'Home', route: '/', root } };
  return doc;
}

describe('validateDoc', () => {
  test('sampleDoc() is valid', () => {
    expect(validateDoc(sampleDoc())).toBeNull();
  });

  test('rejects a page key that is not a valid page id', () => {
    const doc = mutableDoc();
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    doc.pages = { 'Home Page': { ...home, id: 'Home Page' } };
    expect(validateDoc(doc)).toContain('Invalid page id "Home Page"');
  });

  test('rejects a page whose id does not match its key', () => {
    const doc = mutableDoc();
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    doc.pages = { home: { ...home, id: 'other' } };
    expect(validateDoc(doc)).toBe('page home: page id "other" does not match its key');
  });

  test('rejects an invalid node id', () => {
    const doc = mutableDoc();
    at(doc, 'n4').id = 'bad id';
    expect(validateDoc(doc)).toContain('Invalid node id "bad id"');
  });

  test('rejects a node id used twice in one page', () => {
    const doc = mutableDoc();
    at(doc, 'n4').id = 'n2';
    expect(validateDoc(doc)).toBe('page home node n2: Duplicate node id n2');
  });

  test('rejects a node id that a component already uses', () => {
    const doc = mutableDoc();
    const card = doc.components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    card.root.id = 'n1';
    expect(validateDoc(doc)).toBe('component Card node n1: Duplicate node id n1');
  });

  test('rejects a tag that is not allowed', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'script';
    expect(validateDoc(doc)).toContain('Tag "script" is not allowed');
  });

  test('rejects a tag that is not a valid tag name', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'Div';
    expect(validateDoc(doc)).toContain('Invalid tag "Div"');
  });

  test('rejects an attribute name that is not allowed', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { onclick: 'x' };
    expect(validateDoc(doc)).toContain('Attribute "onclick" is not allowed');
  });

  test('rejects an unsafe attribute value', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { href: 'JavaScript:alert(1)' };
    expect(validateDoc(doc)).toContain('Unsafe URL in attribute href');
  });

  test('rejects srcdoc', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { srcdoc: '<p>x</p>' };
    expect(validateDoc(doc)).toContain('Attribute srcdoc is not allowed');
  });

  test('rejects a void element that has children', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'img';
    expect(validateDoc(doc)).toContain('Void element img cannot have children');
  });

  test('rejects a style value with a forbidden character', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['padding'] = '8px}';
    expect(validateDoc(doc)).toContain('Value for padding contains a forbidden character');
  });

  test('rejects a style value that the property does not accept', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['padding'] = 'red';
    expect(validateDoc(doc)).toContain('Invalid value "red" for padding');
  });

  test('rejects an unknown style property', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['not-a-prop'] = '1px';
    expect(validateDoc(doc)).toContain('Unknown CSS property "not-a-prop"');
  });

  test('checks the style of every device, not only base', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.mobile = { color: 'red', padding: '8px !important' };
    expect(validateDoc(doc)).toContain('Value for padding must not use !important');
  });

  test('rejects a device key that is not a device', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style = { base: {}, desktop: {} } as unknown as ElementNode['style'];
    expect(validateDoc(doc)).toContain('Unknown device "desktop"');
  });

  test('rejects a token value that setToken would refuse', () => {
    const doc = mutableDoc();
    doc.tokens = { color: { primary: 'red}' } };
    expect(validateDoc(doc)).toBe('token color.primary: Value for --color-primary contains a forbidden character');
  });

  test('rejects a token name that setToken would refuse', () => {
    const doc = mutableDoc();
    doc.tokens = { Color: { primary: '#fff' } };
    expect(validateDoc(doc)).toContain('Invalid token name: group "Color", name "primary"');
  });

  test('rejects an instance of a component that does not exist', () => {
    const doc = mutableDoc();
    instance(doc, 'n5').component = 'Nope';
    expect(validateDoc(doc)).toContain('Component Nope not found');
  });

  test('rejects an instance prop that its component does not declare', () => {
    const doc = mutableDoc();
    instance(doc, 'n5').props = { title: 'Hello', color: 'red' };
    expect(validateDoc(doc)).toContain('Component Card has no prop "color"');
  });

  test('accepts a page tree exactly 64 levels deep', () => {
    expect(validateDoc(withHomeRoot(chain(MAX_DEPTH)))).toBeNull();
  });

  test('rejects a page tree deeper than 64 levels', () => {
    expect(validateDoc(withHomeRoot(chain(MAX_DEPTH + 1)))).toBe(
      'page home: Node tree deeper than 64 levels',
    );
  });

  test('rejects a component tree deeper than 64 levels', () => {
    const doc = mutableDoc();
    const card = doc.components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    card.root = chain(MAX_DEPTH + 1);
    expect(validateDoc(doc)).toBe('component Card: Node tree deeper than 64 levels');
  });
});

describe('parseDoc uses validateDoc', () => {
  test('rejects a doc that validateDoc rejects, with the same message', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'script';
    expect(parseDoc(serializeDoc(doc))).toEqual({
      ok: false,
      error: 'page home node n2: Tag "script" is not allowed',
    });
  });
});
