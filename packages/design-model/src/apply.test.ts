import { describe, expect, test } from 'vitest';
import { applyOp, applyOpInternal, validateOp, validateOpInternal } from './apply.js';
import { canonicalStringify } from './canonical.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import { exportPage } from './export.js';
import type { DesignDoc, DesignNode, NodeStyle, Op, Page } from './types.js';

function applied(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error('expected the op to be rejected');
  return result.error;
}

// Restore ops (undo's inverses) only reach the internal path.
function appliedInternal(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOpInternal(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function rejectedInternal(doc: DesignDoc, op: Op): string {
  const error = validateOpInternal(doc, op);
  if (error === null) throw new Error('expected the op to be rejected');
  return error;
}

function nodeOf(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`fixture is missing ${id}`);
  return hit.node;
}

function styleOf(doc: DesignDoc, id: string): NodeStyle {
  const node = nodeOf(doc, id);
  if (node.kind === 'text') throw new Error(`${id} is a text node`);
  return node.style;
}

function attrsOf(doc: DesignDoc, id: string): Record<string, string> {
  const node = nodeOf(doc, id);
  if (node.kind !== 'element') throw new Error(`${id} is not an element`);
  return node.attrs;
}

// Everything an op can change, in canonical form.
function content(doc: DesignDoc): string[] {
  return [doc.pages, doc.components, doc.tokens].map((part) => canonicalStringify(part));
}

function restoreOp(seq: number, entries: unknown[]): Op {
  return { op: 'restore', seq, entries } as unknown as Op;
}

describe('setStyle', () => {
  test('sets a base prop without touching the input', () => {
    const doc = sampleDoc();
    const next = applied(doc, { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12px' });
    expect(styleOf(next, 'n3').base.padding).toBe('12px');
    expect(styleOf(doc, 'n3').base.padding).toBe('8px');
  });

  test('creates a mobile override and removes the map when its last prop is cleared', () => {
    const withMobile = applied(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' });
    expect(styleOf(withMobile, 'n3').mobile).toEqual({ padding: '4px' });
    const cleared = applied(withMobile, { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: null });
    expect(styleOf(cleared, 'n3')).not.toHaveProperty('mobile');
  });

  test('keeps a device map that still has other props', () => {
    const one = applied(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'tablet', prop: 'padding', value: '4px' });
    const two = applied(one, { op: 'setStyle', node: 'n3', device: 'tablet', prop: 'margin', value: '2px' });
    const three = applied(two, { op: 'setStyle', node: 'n3', device: 'tablet', prop: 'padding', value: null });
    expect(styleOf(three, 'n3').tablet).toEqual({ margin: '2px' });
  });

  test('rejects an invalid value', () => {
    const error = rejected(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12' });
    expect(error).toContain('padding');
  });

  test('rejects a text node', () => {
    const error = rejected(sampleDoc(), { op: 'setStyle', node: 'n4', device: 'base', prop: 'color', value: 'red' });
    expect(error).toContain('cannot be styled');
  });

  test('rejects a value with an unclosed function', () => {
    const error = rejected(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'base', prop: 'color', value: 'var(--a' });
    expect(error).toBe('Value for color has unbalanced brackets or quotes');
  });

  test('rejects an unknown device as a malformed op', () => {
    const op = { op: 'setStyle', node: 'n3', device: 'desktop', prop: 'padding', value: '4px' } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe('Malformed op: setStyle.device must be one of base, tablet, mobile');
  });
});

describe('setText', () => {
  test('replaces the text of a text node', () => {
    const next = applied(sampleDoc(), { op: 'setText', node: 'n4', text: 'Sign in' });
    expect(nodeOf(next, 'n4')).toEqual({ id: 'n4', kind: 'text', text: 'Sign in' });
  });

  test('rejects an element', () => {
    expect(rejected(sampleDoc(), { op: 'setText', node: 'n3', text: 'x' })).toContain('is not a text node');
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['a number', 123],
    ['a missing text', undefined],
  ])('rejects %s as a malformed op', (_label, text) => {
    const op = { op: 'setText', node: 'n4', text } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe('Malformed op: setText.text must be a string');
  });
});

describe('setAttr', () => {
  test('sets and removes an attribute', () => {
    const withType = applied(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'type', value: 'submit' });
    expect(attrsOf(withType, 'n3')).toEqual({ type: 'submit' });
    const without = applied(withType, { op: 'setAttr', node: 'n3', name: 'type', value: null });
    expect(attrsOf(without, 'n3')).toEqual({});
  });

  test('rejects style', () => {
    const error = rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'style', value: 'color:red' });
    expect(error).toContain('is not allowed');
  });

  test.each(['class', 'data-d-id', 'Bad', '1x'])('rejects the attribute name %s', (name) => {
    const error = rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name, value: 'x' });
    expect(error).toContain('is not allowed');
  });

  test.each(['viewBox', 'preserveAspectRatio', 'stdDeviation'])('accepts the case-sensitive SVG attribute %s', (name) => {
    expect(attrsOf(applied(sampleDoc(), { op: 'setAttr', node: 'n3', name, value: '0 0 1 1' }), 'n3')).toEqual({ [name]: '0 0 1 1' });
  });

  test.each(['strokeWidth', 'fillRule', 'ViewBox'])('rejects the camelCase name %s, which no SVG attribute has', (name) => {
    expect(rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name, value: '1' })).toContain('is not allowed');
  });

  test('sets data-d-shell only on a page root, and only to html', () => {
    const doc = sampleDoc();
    const root = Object.values(doc.pages)[0]!.root.id;
    expect(attrsOf(applied(doc, { op: 'setAttr', node: root, name: 'data-d-shell', value: 'html' }), root)).toEqual({ 'data-d-shell': 'html' });
    expect(rejected(doc, { op: 'setAttr', node: root, name: 'data-d-shell', value: 'body' })).toBe('Attribute data-d-shell must be "html"');
    expect(rejected(doc, { op: 'setAttr', node: 'n3', name: 'data-d-shell', value: 'html' })).toBe('Attribute "data-d-shell" is only allowed on a page root');
  });

  test('rejects an event handler attribute', () => {
    const error = rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'onclick', value: 'alert(1)' });
    expect(error).toBe('Attribute "onclick" is not allowed');
  });

  test('rejects an instance node', () => {
    expect(rejected(sampleDoc(), { op: 'setAttr', node: 'n5', name: 'id', value: 'x' })).toContain('is not an element');
  });

  test.each<[string, unknown]>([['an object', {}], ['a number', 5]])('rejects %s as a value', (_label, value) => {
    const op = { op: 'setAttr', node: 'n3', name: 'type', value } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe('Malformed op: setAttr.value must be a string or null');
  });
});

describe('setInstanceProp', () => {
  test('rejects a number as a value', () => {
    const op = { op: 'setInstanceProp', node: 'n5', prop: 'title', value: 7 } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe('Malformed op: setInstanceProp.value must be a string or null');
  });
});

describe('setName', () => {
  test('names and unnames a node', () => {
    const named = applied(sampleDoc(), { op: 'setName', node: 'n1', name: 'Page' });
    expect(nodeOf(named, 'n1')).toMatchObject({ name: 'Page' });
    const unnamed = applied(named, { op: 'setName', node: 'n1', name: null });
    expect(nodeOf(unnamed, 'n1')).not.toHaveProperty('name');
  });

  test('rejects a text node', () => {
    expect(rejected(sampleDoc(), { op: 'setName', node: 'n4', name: 'Label' })).toContain('cannot be named');
  });
});

describe('setToken', () => {
  test('adds a name to an existing group', () => {
    const next = applied(sampleDoc(), { op: 'setToken', group: 'color', name: 'accent', value: '#ff0000' });
    expect(next.tokens).toEqual({ color: { primary: '#3366ff', accent: '#ff0000' } });
  });

  test('adds a new group', () => {
    const next = applied(sampleDoc(), { op: 'setToken', group: 'space', name: 'sm', value: '4px' });
    expect(next.tokens).toEqual({ color: { primary: '#3366ff' }, space: { sm: '4px' } });
  });

  test('deletes a name and then its empty group', () => {
    const next = applied(sampleDoc(), { op: 'setToken', group: 'color', name: 'primary', value: null });
    expect(next.tokens).toEqual({});
  });

  test('keeps a group that still has names', () => {
    const one = applied(sampleDoc(), { op: 'setToken', group: 'color', name: 'accent', value: '#f00' });
    const two = applied(one, { op: 'setToken', group: 'color', name: 'primary', value: null });
    expect(two.tokens).toEqual({ color: { accent: '#f00' } });
  });

  test('accepts a group named like an Object.prototype member', () => {
    const next = applied(sampleDoc(), { op: 'setToken', group: 'constructor', name: 'x', value: '1' });
    expect(next.tokens).toEqual({ color: { primary: '#3366ff' }, constructor: { x: '1' } });
  });

  test('accepts token names that start with a digit or contain an underscore, and exports them as --group-name', () => {
    const one = applied(sampleDoc(), { op: 'setToken', group: 'space', name: '0_5', value: '0.125rem' });
    const two = applied(one, { op: 'setToken', group: 'container', name: '2xl', value: '42rem' });
    expect(two.tokens).toMatchObject({ space: { '0_5': '0.125rem' }, container: { '2xl': '42rem' } });
    const exported = exportPage(two, Object.keys(two.pages)[0]!);
    expect(exported.ok && exported.value.css).toContain('--container-2xl:42rem;--space-0_5:0.125rem;');
  });

  test.each([
    ['Color', 'primary'],
    ['color', 'Primary'],
    ['color', 'primary name'],
    ['', 'x'],
    ['space', '-x'],
    ['space', ''],
    ['space_x', '1'],
    ['1space', 'x'],
    // The importer splits `--group-name` at the first dash, so a dashed group would not round-trip.
    ['brand-color', 'x'],
  ])('rejects token group %j and name %j', (group, name) => {
    const error = rejected(sampleDoc(), { op: 'setToken', group, name, value: '1px' });
    expect(error).toContain('Invalid token name');
  });

  test('deletes a dashed token group saved before groups lost their dashes', () => {
    const doc = structuredClone(sampleDoc());
    doc.tokens['brand-color'] = { x: '#f00' };
    const next = applied(doc, { op: 'setToken', group: 'brand-color', name: 'x', value: null });
    expect(Object.hasOwn(next.tokens, 'brand-color')).toBe(false);
    expect(rejected(doc, { op: 'setToken', group: 'brand-color', name: 'y', value: '1px' })).toContain('Invalid token name');
  });

  test('rejects a token value that would break out of the CSS block', () => {
    const error = rejected(sampleDoc(), { op: 'setToken', group: 'color', name: 'primary', value: 'red;}' });
    expect(error).toContain('forbidden character');
  });

  test('rejects an empty token value', () => {
    const error = rejected(sampleDoc(), { op: 'setToken', group: 'color', name: 'primary', value: '' });
    expect(error).toContain('Invalid value');
  });

  test('rejects a token value with an unclosed quote', () => {
    const error = rejected(sampleDoc(), { op: 'setToken', group: 'color', name: 'primary', value: '"abc' });
    expect(error).toBe('Value for --color-primary has unbalanced brackets or quotes');
  });

  test('reports a number value as malformed, without throwing', () => {
    const op = { op: 'setToken', group: 'color', name: 'primary', value: 5 } as unknown as Op;
    expect(validateOp(sampleDoc(), op)).toBe('Malformed op: setToken.value must be a string or null');
  });

  test('the internal validator reports a number value without throwing', () => {
    const op = { op: 'setToken', group: 'color', name: 'primary', value: 5 } as unknown as Op;
    expect(() => validateOpInternal(sampleDoc(), op)).not.toThrow();
    expect(validateOpInternal(sampleDoc(), op)).not.toBeNull();
  });
});

describe('malformed ops', () => {
  const deep = (levels: number): unknown => {
    let node: Record<string, unknown> = { id: `n${levels}`, kind: 'element', tag: 'p', attrs: {}, style: { base: {} }, children: [] };
    for (let level = levels - 1; level >= 1; level--) {
      node = { id: `n${level}`, kind: 'element', tag: 'p', attrs: {}, style: { base: {} }, children: [node] };
    }
    return node;
  };

  test.each<[string, unknown, string]>([
    ['an unknown node kind', { id: 'n9', kind: 'banana' }, 'Malformed op: insertNode.node: node n9: kind must be element, text or instance'],
    ['a text node without text', { id: 'n9', kind: 'text' }, 'Malformed op: insertNode.node: node n9: text must be a string'],
    ['a numeric node id', { id: 9, kind: 'text', text: 'x' }, 'Malformed op: insertNode.node: node id must be a non-empty string'],
    ['a 70-level payload', deep(70), 'Malformed op: insertNode.node: Node tree deeper than 64 levels'],
  ])('insertNode with %s is rejected by applyOp and validateOp', (_label, node, problem) => {
    const op = { op: 'insertNode', parent: 'n2', index: 0, node } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe(problem);
    expect(validateOp(sampleDoc(), op)).toBe(problem);
  });
});

describe('restore ops are internal', () => {
  test('applyOp refuses a restore op', () => {
    expect(rejected(sampleDoc(), restoreOp(9, []))).toBe('restore ops are internal');
  });

  test('validateOp refuses a restore op', () => {
    expect(validateOp(sampleDoc(), restoreOp(9, []))).toBe('restore ops are internal');
  });

  test('the internal path still applies a restore op', () => {
    expect(appliedInternal(sampleDoc(), restoreOp(9, [])).meta.seq).toBe(9);
  });

  test('internal restore rejects the entry key __proto__', () => {
    const op = restoreOp(9, [{ kind: 'tokens', key: '__proto__', value: null }]);
    expect(rejectedInternal(sampleDoc(), op)).toBe('Restore entry key "__proto__" is reserved');
  });

  test.each(['constructor', 'prototype'])('internal restore accepts the token group %s', (key) => {
    const op = restoreOp(9, [{ kind: 'tokens', key, value: null }]);
    expect(validateOpInternal(sampleDoc(), op)).toBeNull();
  });

  test('internal restore rejects a reserved page key', () => {
    const op = restoreOp(9, [{ kind: 'page', key: '__proto__', value: null }]);
    expect(rejectedInternal(sampleDoc(), op)).toBe('Restore entry key "__proto__" is reserved');
  });
});

describe('validation', () => {
  test('reports an unknown node with the exact message', () => {
    expect(rejected(sampleDoc(), { op: 'setText', node: 'zzz', text: 'x' })).toBe('Node zzz not found');
  });

  test.each(['bogus', 'toString'])('reports the unknown op %s', (name) => {
    const op = { op: name } as unknown as Op;
    expect(rejected(sampleDoc(), op)).toBe(`Unknown op "${name}"`);
  });

  test('validateOp returns null for a valid op and a reason for an invalid one', () => {
    expect(validateOp(sampleDoc(), { op: 'setText', node: 'n4', text: 'x' })).toBeNull();
    expect(validateOp(sampleDoc(), { op: 'setText', node: 'n3', text: 'x' })).toContain('is not a text node');
  });

  test('never mutates the input doc', () => {
    const doc = sampleDoc();
    const before = canonicalStringify(doc);
    applied(doc, { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' });
    applied(doc, { op: 'setToken', group: 'color', name: 'primary', value: null });
    applyOpInternal(doc, restoreOp(3, []));
    expect(canonicalStringify(doc)).toBe(before);
  });
});

describe('undo', () => {
  const cases: [string, Op][] = [
    ['base padding', { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12px' }],
    ['mobile override', { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' }],
    ['clearing a base prop', { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: null }],
    ['text', { op: 'setText', node: 'n4', text: 'Sign in' }],
    ['attr', { op: 'setAttr', node: 'n3', name: 'type', value: 'submit' }],
    ['name', { op: 'setName', node: 'n2', name: 'Top bar' }],
    ['unname', { op: 'setName', node: 'n2', name: null }],
    ['token add', { op: 'setToken', group: 'color', name: 'accent', value: '#ff0000' }],
    ['token delete that empties the group', { op: 'setToken', group: 'color', name: 'primary', value: null }],
    ['token in a new group', { op: 'setToken', group: 'space', name: 'sm', value: '4px' }],
  ];

  test.each(cases)('inverse restores exactly after %s', (_label, op) => {
    const doc = sampleDoc();
    const result = applyOp(doc, op);
    if (!result.ok) throw new Error(result.error);
    expect(content(result.value.doc)).not.toEqual(content(doc));

    const undone = appliedInternal(result.value.doc, result.value.inverse);
    expect(content(undone)).toEqual(content(doc));
  });

  test('inverse of an op that changes nothing is also a no-op', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'setAttr', node: 'n3', name: 'title', value: null });
    if (!result.ok) throw new Error(result.error);
    expect(content(result.value.doc)).toEqual(content(doc));
    expect(content(appliedInternal(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });

  test('restore entries set and delete records', () => {
    const doc = sampleDoc();
    const page = doc.pages['home'];
    if (!page) throw new Error('fixture is missing the home page');
    const removed = appliedInternal(doc, restoreOp(9, [{ kind: 'page', key: 'home', value: null }]));
    expect(removed.pages).toEqual({});
    const added = appliedInternal(removed, restoreOp(9, [{ kind: 'page', key: 'home', value: page }]));
    expect(content(added)).toEqual(content(doc));
  });
  test('inverse entries are sorted by kind, then key', () => {
    const page = (id: string, root: string): Page => ({
      id, name: id, route: `/${id}`,
      root: { id: root, kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
    });
    const seeded = appliedInternal(sampleDoc(), restoreOp(9, [
      { kind: 'page', key: 'zeta', value: page('zeta', 'n90') },
      { kind: 'page', key: 'alpha', value: page('alpha', 'n91') },
    ]));
    const result = applyOpInternal(seeded, restoreOp(9, [
      { kind: 'tokens', key: 'color', value: null },
      { kind: 'page', key: 'zeta', value: null },
      { kind: 'component', key: 'Card', value: null },
      { kind: 'page', key: 'alpha', value: null },
    ]));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.inverse.entries.map((entry) => `${entry.kind}:${entry.key}`)).toEqual([
      'page:alpha', 'page:zeta', 'component:Card', 'tokens:color',
    ]);
  });
});

describe('restore validation', () => {
  const pageNoRoot = { id: 'home', name: 'Home', route: '/' };

  test.each([
    ['negative seq', restoreOp(-1, []), 'Invalid restore seq'],
    ['fractional seq', restoreOp(1.5, []), 'Invalid restore seq'],
    ['entries that are not an array', { op: 'restore', seq: 3, entries: {} } as unknown as Op, 'Restore entries must be an array'],
    ['unknown entry kind', restoreOp(3, [{ kind: 'widget', key: 'x', value: null }]), 'Invalid restore entry kind "widget"'],
    ['empty entry key', restoreOp(3, [{ kind: 'tokens', key: '', value: null }]), 'Invalid restore entry key'],
    ['page value without a root', restoreOp(3, [{ kind: 'page', key: 'home', value: pageNoRoot }]), 'Invalid restore value for page "home"'],
    ['token value that is not a string', restoreOp(3, [{ kind: 'tokens', key: 'color', value: { primary: 1 } }]), 'Invalid restore value for tokens "color"'],
    [
      'duplicate entry',
      restoreOp(3, [
        { kind: 'tokens', key: 'color', value: null },
        { kind: 'tokens', key: 'color', value: { primary: '#000' } },
      ]),
      'Duplicate restore entry tokens "color"',
    ],
  ])('rejects %s', (_label, op, expected) => {
    expect(rejectedInternal(sampleDoc(), op)).toContain(expected);
  });
});

describe('seq', () => {
  test('an op that inserts nothing keeps seq', () => {
    expect(applied(sampleDoc(), { op: 'setText', node: 'n4', text: 'x' }).meta.seq).toBe(9);
  });

  test('restore never lowers seq', () => {
    expect(appliedInternal(sampleDoc(), restoreOp(3, [])).meta.seq).toBe(9);
  });

  test('restore never lowers seq, even when no node id reaches it', () => {
    const bare: DesignDoc = { meta: { version: 1, seq: 9 }, pages: {}, components: {}, tokens: {} };
    expect(appliedInternal(bare, restoreOp(3, [])).meta.seq).toBe(9);
  });

  test('restore raises seq to its own value', () => {
    expect(appliedInternal(sampleDoc(), restoreOp(12, [])).meta.seq).toBe(12);
  });
});
