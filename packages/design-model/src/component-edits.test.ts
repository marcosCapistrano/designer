import { describe, expect, test } from 'vitest';
import { applyOp, validateOp } from './apply.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import type { ComponentDef, DesignDoc, DesignNode, ElementNode, InstanceNode, Op } from './types.js';
import { validateDoc } from './validate.js';

// F6: an edit inside a component can make an existing instance's props unsafe in an attribute.
// The instance was fine before, because the prop only fed text. The edit must be refused.
const SAFE_LOOKING = 'JavaScript: The Good Parts';

function instance(id: string, component: string, props: Record<string, string> = {}): InstanceNode {
  return { id, kind: 'instance', component, props, style: { base: {} } };
}

function el(id: string, tag: string, children: DesignNode[] = [], attrs: Record<string, string> = {}): ElementNode {
  return { id, kind: 'element', tag, attrs, style: { base: {} }, children };
}

// The sample doc plus Link, <a href="{{url}}">{{label}}</a> (n20, n21), and an instance n22 on the home page
// whose label reads like a script URL. The label only feeds text, so the doc is valid.
function linkDoc(label = SAFE_LOOKING): DesignDoc {
  const doc = structuredClone(sampleDoc());
  const link: ComponentDef = {
    name: 'Link',
    props: { url: { default: '/home' }, label: { default: 'Go' } },
    root: el('n20', 'a', [{ id: 'n21', kind: 'text', text: '{{label}}' }], { href: '{{url}}' }),
  };
  doc.components['Link'] = link;
  const home = doc.pages['home'];
  if (!home) throw new Error('fixture is missing the home page');
  home.root.children.push(instance('n22', 'Link', { url: '/a', label }));
  doc.meta.seq = 23;
  return doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error(`expected the op to be rejected: ${JSON.stringify(op)}`);
  return result.error;
}

function applied(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

const TITLE_FROM_LABEL: Op = { op: 'setAttr', node: 'n20', name: 'title', value: '{{label}}' };

describe('the fixture', () => {
  test('is valid and reloads', () => {
    const doc = linkDoc();
    expect(validateDoc(doc)).toBeNull();
    expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
  });
});

describe('setAttr inside a component', () => {
  test('refuses a templated attribute that an existing instance would make unsafe', () => {
    expect(rejected(linkDoc(), TITLE_FROM_LABEL)).toBe(
      'Unsafe URL in attribute title (component Link, node n20)',
    );
  });

  test('validateOp gives the same answer as applyOp', () => {
    const doc = linkDoc();
    expect(validateOp(doc, TITLE_FROM_LABEL)).toBe(rejected(doc, TITLE_FROM_LABEL));
  });

  test('the repro: the op sequence cannot leave a doc that validateDoc refuses', () => {
    let doc = applied(linkDoc('Go'), { op: 'setInstanceProp', node: 'n22', prop: 'label', value: SAFE_LOOKING });
    expect(validateDoc(doc)).toBeNull();
    const result = applyOp(doc, TITLE_FROM_LABEL);
    expect(result.ok).toBe(false);
    if (result.ok) doc = result.value.doc;
    expect(validateDoc(doc)).toBeNull();
    expect(parseDoc(serializeDoc(doc)).ok).toBe(true);
  });

  test('refuses it when the unsafe value is only a default', () => {
    const doc = linkDoc('Go');
    const link = doc.components['Link'];
    if (!link) throw new Error('fixture is missing Link');
    link.props['label'] = { default: SAFE_LOOKING };
    expect(validateDoc(doc)).toBeNull();
    expect(rejected(doc, TITLE_FROM_LABEL)).toContain('Unsafe URL in attribute title');
  });

  test('refuses it when the instance is on another page', () => {
    const doc = linkDoc('Go');
    doc.pages['about'] = {
      id: 'about',
      name: 'About',
      route: '/about',
      root: el('n30', 'main', [instance('n31', 'Link', { label: SAFE_LOOKING })]),
    };
    doc.meta.seq = 32;
    expect(validateDoc(doc)).toBeNull();
    expect(rejected(doc, TITLE_FROM_LABEL)).toContain('Unsafe URL in attribute title');
  });

  test('refuses it when the instance is inside another component', () => {
    const doc = linkDoc('Go');
    doc.components['Card'] = {
      name: 'Card',
      props: { title: { default: 'Title' } },
      root: el('n6', 'div', [instance('n40', 'Link', { label: SAFE_LOOKING })]),
    };
    expect(validateDoc(doc)).toBeNull();
    expect(rejected(doc, TITLE_FROM_LABEL)).toContain('Unsafe URL in attribute title');
  });

  test('accepts the same edit when every instance is safe', () => {
    const doc = linkDoc('Go');
    expect(validateDoc(applied(doc, TITLE_FROM_LABEL))).toBeNull();
  });

  test.each<[string, Op]>([
    ['a plain attribute', { op: 'setAttr', node: 'n20', name: 'title', value: SAFE_LOOKING.replace('JavaScript', 'Java') }],
    ['removing an attribute', { op: 'setAttr', node: 'n20', name: 'href', value: null }],
    ['an attribute on a page node', { op: 'setAttr', node: 'n3', name: 'title', value: '{{label}}' }],
    ['an attribute that no prop feeds', { op: 'setAttr', node: 'n20', name: 'title', value: '{{nothing}}' }],
  ])('still accepts %s', (_label, op) => {
    expect(validateDoc(applied(linkDoc(), op))).toBeNull();
  });
});

describe('insertNode inside a component', () => {
  test('refuses an element whose attribute an instance would make unsafe', () => {
    const op: Op = { op: 'insertNode', parent: 'n20', index: 0, node: el('n40', 'img', [], { alt: '{{label}}' }) };
    expect(rejected(linkDoc(), op)).toBe('Unsafe URL in attribute alt (component Link, node n40)');
  });

  test('refuses a nested element deeper in the inserted subtree', () => {
    const inner = el('n41', 'span', [], { 'data-t': 'x{{label}}', title: '{{label}}' });
    const op: Op = { op: 'insertNode', parent: 'n20', index: 0, node: el('n40', 'div', [inner]) };
    expect(rejected(linkDoc(), op)).toContain('(component Link, node n41)');
  });

  test('accepts the same element when it is not templated, or goes on a page', () => {
    const plain: Op = { op: 'insertNode', parent: 'n20', index: 0, node: el('n40', 'img', [], { alt: 'logo' }) };
    expect(validateDoc(applied(linkDoc(), plain))).toBeNull();
    const onPage: Op = { op: 'insertNode', parent: 'n1', index: 0, node: el('n40', 'img', [], { alt: '{{label}}' }) };
    expect(validateDoc(applied(linkDoc(), onPage))).toBeNull();
  });

  test('accepts a templated element when every instance is safe', () => {
    const op: Op = { op: 'insertNode', parent: 'n20', index: 0, node: el('n40', 'img', [], { alt: '{{label}}' }) };
    expect(validateDoc(applied(linkDoc('Go'), op))).toBeNull();
  });
});

describe('wrapNodes inside a component', () => {
  test('refuses a wrapper with a templated attribute that an instance would make unsafe', () => {
    const op: Op = { op: 'wrapNodes', nodes: ['n21'], wrapper: el('n40', 'span', [], { title: '{{label}}' }) };
    expect(rejected(linkDoc(), op)).toBe('Unsafe URL in attribute title (component Link, node n40)');
  });

  test('accepts a plain wrapper, and the templated one on a page', () => {
    const plain: Op = { op: 'wrapNodes', nodes: ['n21'], wrapper: el('n40', 'span') };
    expect(validateDoc(applied(linkDoc(), plain))).toBeNull();
    const onPage: Op = { op: 'wrapNodes', nodes: ['n3'], wrapper: el('n40', 'span', [], { title: '{{label}}' }) };
    expect(validateDoc(applied(linkDoc(), onPage))).toBeNull();
  });
});

describe('other edits that change a component', () => {
  // Outer holds an instance of Link whose url is Outer's own label. Detaching that instance writes
  // <a href="{{label}}"> into Outer, where an Outer instance with a script-like label would be unsafe.
  function outerDoc(label: string): DesignDoc {
    const doc = linkDoc('Go');
    doc.components['Outer'] = {
      name: 'Outer',
      props: { label: { default: 'Go' } },
      root: el('n50', 'section', [instance('n51', 'Link', { url: '{{label}}' })]),
    };
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    home.root.children.push(instance('n52', 'Outer', { label }));
    doc.meta.seq = 53;
    return doc;
  }

  const DETACH: Op = { op: 'detachInstance', node: 'n51', idMap: { n20: 'n60', n21: 'n61' } };

  test('detachInstance inside a component is refused when an instance of that component would be unsafe', () => {
    const doc = outerDoc(SAFE_LOOKING);
    expect(validateDoc(doc)).toBeNull();
    expect(rejected(doc, DETACH)).toBe('Unsafe URL in attribute href (component Outer, node n60)');
  });

  test('detachInstance inside a component is accepted when every instance is safe', () => {
    expect(validateDoc(applied(outerDoc('Go'), DETACH))).toBeNull();
  });

  test('moveNode inside a component changes no attribute, so it is accepted', () => {
    const doc = linkDoc();
    const wrapped = applied(doc, { op: 'insertNode', parent: 'n20', index: 0, node: el('n40', 'span') });
    const moved = applied(wrapped, { op: 'moveNode', node: 'n21', parent: 'n40', index: 0 });
    expect(validateDoc(moved)).toBeNull();
  });

  test('extractComponent makes a component with no props, so it is accepted', () => {
    const doc = applied(linkDoc(), { op: 'setAttr', node: 'n3', name: 'title', value: '{{label}}' });
    const next = applied(doc, { op: 'extractComponent', node: 'n3', component: 'Btn', instanceId: 'n70' });
    expect(validateDoc(next)).toBeNull();
    expect(findNode(next, 'n70')?.node.kind).toBe('instance');
  });
});
