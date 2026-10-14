import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { exportPage } from './export.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import type { DesignDoc, DesignNode, ElementNode, InstanceNode, Op } from './types.js';
import { validateDoc } from './validate.js';

// I6 residual: a prop that feeds a URL attribute must not carry javascript: into the exported page.
const UNSAFE = 'javascript:alert(1)';
const UNSAFE_MESSAGE = 'Unsafe URL in attribute href';

function link(id: string, props: Record<string, string> = {}): InstanceNode {
  return { id, kind: 'instance', component: 'Link', props, style: { base: {} } };
}

// The sample doc plus a Link component, <a href="{{url}}">{{label}}</a>, and one instance of it on the home page.
function linkDoc(): DesignDoc {
  const doc = structuredClone(sampleDoc());
  doc.components['Link'] = {
    name: 'Link',
    props: { url: { default: 'https://example.com' }, label: { default: 'Go' } },
    root: {
      id: 'n20',
      kind: 'element',
      tag: 'a',
      attrs: { href: '{{url}}' },
      style: { base: {} },
      children: [{ id: 'n21', kind: 'text', text: '{{label}}' }],
    },
  };
  const home = doc.pages['home'];
  if (!home) throw new Error('fixture is missing the home page');
  home.root.children.push(link('n22', { url: 'https://a.test' }));
  doc.meta.seq = 23;
  return doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error('expected the op to be rejected');
  return result.error;
}

function exported(doc: DesignDoc, pageId = 'home'): ReturnType<typeof exportPage> {
  return exportPage(doc, pageId);
}

describe('the fixture', () => {
  test('is valid, loads, and exports its link', () => {
    const doc = linkDoc();
    expect(validateDoc(doc)).toBeNull();
    expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
    const result = exported(doc);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.html).toContain('href="https://a.test"');
  });
});

describe('setInstanceProp with a URL prop', () => {
  test.each([
    UNSAFE,
    'JavaScript:alert(1)',
    ' \tjava\nscript:alert(1)',
    'vbscript:x',
    'data:text/html,<p>x</p>',
  ])('refuses %j', (value) => {
    const error = rejected(linkDoc(), { op: 'setInstanceProp', node: 'n22', prop: 'url', value });
    expect(error).toContain(UNSAFE_MESSAGE);
  });

  test('accepts a safe URL and a prop that feeds only text', () => {
    const doc = linkDoc();
    for (const op of [
      { op: 'setInstanceProp', node: 'n22', prop: 'url', value: '/contact' },
      { op: 'setInstanceProp', node: 'n22', prop: 'label', value: UNSAFE },
      { op: 'setInstanceProp', node: 'n22', prop: 'url', value: null },
    ] satisfies Op[]) {
      expect(applyOp(doc, op).ok, JSON.stringify(op)).toBe(true);
    }
  });

  test('judges the attribute as a whole, so two safe halves that join into javascript: are refused', () => {
    const doc = linkDoc();
    const comp = doc.components['Link'];
    if (!comp) throw new Error('fixture is missing Link');
    comp.props = { head: { default: 'x' }, tail: { default: 'y' } };
    comp.root.attrs = { href: '{{head}}{{tail}}' };
    const inst = findNode(doc, 'n22')?.node as InstanceNode;
    inst.props = { head: 'java' };
    expect(validateDoc(doc)).toBeNull();
    const error = rejected(doc, { op: 'setInstanceProp', node: 'n22', prop: 'tail', value: 'script:alert(1)' });
    expect(error).toContain(UNSAFE_MESSAGE);
  });

  test('refuses a prop that feeds any attribute, since validateAttrValue checks them all', () => {
    const doc = linkDoc();
    const comp = doc.components['Link'];
    if (!comp) throw new Error('fixture is missing Link');
    comp.root.attrs = { href: '{{url}}', 'data-src': '{{label}}' };
    const error = rejected(doc, { op: 'setInstanceProp', node: 'n22', prop: 'label', value: UNSAFE });
    expect(error).toContain('Unsafe URL in attribute data-src');
  });
});

describe('insertNode of an instance with a URL prop', () => {
  test('refuses an unsafe prop value', () => {
    const error = rejected(linkDoc(), {
      op: 'insertNode',
      parent: 'n1',
      index: 0,
      node: link('n30', { url: UNSAFE }),
    });
    expect(error).toContain(UNSAFE_MESSAGE);
  });

  test('refuses an instance nested in an inserted element', () => {
    const wrapper: ElementNode = {
      id: 'n30',
      kind: 'element',
      tag: 'div',
      attrs: {},
      style: { base: {} },
      children: [link('n31', { url: UNSAFE })],
    };
    expect(rejected(linkDoc(), { op: 'insertNode', parent: 'n1', index: 0, node: wrapper })).toContain(
      UNSAFE_MESSAGE,
    );
  });

  test('refuses an instance on a page that is added', () => {
    const root: ElementNode = {
      id: 'n30',
      kind: 'element',
      tag: 'main',
      attrs: {},
      style: { base: {} },
      children: [link('n31', { url: UNSAFE })],
    };
    const page = { id: 'about', name: 'About', route: '/about', root };
    expect(rejected(linkDoc(), { op: 'addPage', page })).toContain(UNSAFE_MESSAGE);
  });

  test('accepts a safe prop value', () => {
    const op: Op = { op: 'insertNode', parent: 'n1', index: 0, node: link('n30', { url: '/about' }) };
    expect(applyOp(linkDoc(), op).ok).toBe(true);
  });
});

describe('detachInstance with a URL prop', () => {
  test('refuses to expand an instance whose prop makes an attribute unsafe', () => {
    const doc = linkDoc();
    (findNode(doc, 'n22')?.node as InstanceNode).props = { url: UNSAFE };
    const error = rejected(doc, {
      op: 'detachInstance',
      node: 'n22',
      idMap: { n20: 'n50', n21: 'n51' },
    });
    expect(error).toContain(UNSAFE_MESSAGE);
  });

  test('expands a safe instance', () => {
    const op: Op = { op: 'detachInstance', node: 'n22', idMap: { n20: 'n50', n21: 'n51' } };
    expect(applyOp(linkDoc(), op).ok).toBe(true);
  });
});

describe('parseDoc with a URL prop', () => {
  test('refuses a loaded default that feeds an attribute', () => {
    const doc = linkDoc();
    const comp = doc.components['Link'];
    if (!comp) throw new Error('fixture is missing Link');
    comp.props['url'] = { default: UNSAFE };
    const result = parseDoc(serializeDoc(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(UNSAFE_MESSAGE);
      expect(result.error).toContain('Link');
    }
  });

  test('refuses a loaded default even when no instance uses it', () => {
    const doc = linkDoc();
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    home.root.children = home.root.children.filter((child: DesignNode) => child.id !== 'n22');
    const comp = doc.components['Link'];
    if (!comp) throw new Error('fixture is missing Link');
    comp.props['url'] = { default: UNSAFE };
    expect(validateDoc(doc)).toContain(UNSAFE_MESSAGE);
    expect(parseDoc(serializeDoc(doc)).ok).toBe(false);
  });

  test('refuses a loaded instance prop value', () => {
    const doc = linkDoc();
    const inst = findNode(doc, 'n22')?.node as InstanceNode;
    inst.props = { url: UNSAFE };
    const result = parseDoc(serializeDoc(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(UNSAFE_MESSAGE);
  });

  test('accepts an unsafe-looking value that feeds only text', () => {
    const doc = linkDoc();
    const inst = findNode(doc, 'n22')?.node as InstanceNode;
    inst.props = { url: '/x', label: UNSAFE };
    expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
  });
});

describe('exportPage and javascript: in a prop', () => {
  test('fails the page when an instance prop makes an attribute unsafe', () => {
    const doc = linkDoc();
    (findNode(doc, 'n22')?.node as InstanceNode).props = { url: UNSAFE };
    const result = exported(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(`Page home node n22/n20: ${UNSAFE_MESSAGE}`);
  });

  test('fails the page when a default makes an attribute unsafe', () => {
    const doc = linkDoc();
    const comp = doc.components['Link'];
    if (!comp) throw new Error('fixture is missing Link');
    comp.props['url'] = { default: UNSAFE };
    (findNode(doc, 'n22')?.node as InstanceNode).props = {};
    const result = exported(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(UNSAFE_MESSAGE);
  });

  test('fails the page when a value passes through an outer component', () => {
    // Outer hands its url to Link. The edit-time check looks at one component's own attributes,
    // so this is caught when the page is exported.
    const doc = linkDoc();
    doc.components['Outer'] = {
      name: 'Outer',
      props: { url: { default: '/safe' } },
      root: {
        id: 'n40',
        kind: 'element',
        tag: 'section',
        attrs: {},
        style: { base: {} },
        children: [link('n41', { url: '{{url}}' })],
      },
    };
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    home.root.children.push({
      id: 'n42',
      kind: 'instance',
      component: 'Outer',
      props: { url: UNSAFE },
      style: { base: {} },
    });
    doc.meta.seq = 43;
    const result = exported(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(UNSAFE_MESSAGE);
  });

  test('fails the page for an unsafe attribute that has no prop at all', () => {
    const doc = linkDoc();
    (findNode(doc, 'n2')?.node as ElementNode).attrs = { href: UNSAFE };
    const result = exported(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(`Page home node n2: ${UNSAFE_MESSAGE}`);
  });

  test('never emits javascript: for any value that gets through the ops', () => {
    const doc = linkDoc();
    const attempts = [UNSAFE, 'JAVASCRIPT:1', '\u0001javascript:1', 'java\tscript:1', '/ok', 'https://ok.test'];
    for (const value of attempts) {
      const result = applyOp(doc, { op: 'setInstanceProp', node: 'n22', prop: 'url', value });
      if (!result.ok) continue;
      const out = exportPage(result.value.doc, 'home');
      if (!out.ok) continue;
      expect(out.value.html.replace(/[\u0000- ]/g, '').toLowerCase()).not.toContain('javascript:');
    }
  });
});
