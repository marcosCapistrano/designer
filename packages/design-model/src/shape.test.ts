import { describe, expect, test } from 'vitest';
import { nodeProblem, opProblem, RESERVED_KEYS } from './shape.js';

const text = (id: string, value: unknown = 'Hi'): Record<string, unknown> => ({ id, kind: 'text', text: value });
const element = (id: string, children: unknown[] = []): Record<string, unknown> => ({
  id, kind: 'element', tag: 'p', attrs: {}, style: { base: {} }, children,
});

// An element chain with `levels` nodes from the root down. The root is level 1.
function chain(levels: number): Record<string, unknown> {
  let node = element(`n${levels}`);
  for (let level = levels - 1; level >= 1; level--) node = element(`n${level}`, [node]);
  return node;
}

describe('opProblem', () => {
  test.each<[string, unknown]>([
    ['setStyle', { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '4px' }],
    ['setText', { op: 'setText', node: 'n4', text: 'Sign in' }],
    ['setAttr', { op: 'setAttr', node: 'n3', name: 'type', value: null }],
    ['setName', { op: 'setName', node: 'n3', name: null }],
    ['setToken', { op: 'setToken', group: 'color', name: 'accent', value: '#f00' }],
    ['insertNode', { op: 'insertNode', parent: 'n2', index: 0, node: text('n9') }],
    ['removeNode', { op: 'removeNode', node: 'n3' }],
    ['moveNode', { op: 'moveNode', node: 'n5', parent: 'n2', index: 0 }],
    ['wrapNodes', { op: 'wrapNodes', nodes: ['n4'], wrapper: element('n9') }],
    ['extractComponent', { op: 'extractComponent', node: 'n2', component: 'Header', instanceId: 'n9' }],
    ['setInstanceProp', { op: 'setInstanceProp', node: 'n5', prop: 'title', value: null }],
    ['detachInstance', { op: 'detachInstance', node: 'n5', idMap: { n6: 'n10' } }],
    ['addPage', { op: 'addPage', page: { id: 'pricing', name: 'Pricing', route: '/pricing', root: element('n9') } }],
    ['duplicatePage', { op: 'duplicatePage', source: 'home', page: { id: 'b', name: 'B', route: '/b' }, idMap: { n1: 'n10' } }],
    ['removePage', { op: 'removePage', page: 'home' }],
  ])('accepts a well-formed %s', (_kind, op) => {
    expect(opProblem(op)).toBeNull();
  });

  test.each<[string, unknown, string]>([
    ['null', null, 'Malformed op: op must be an object'],
    ['a string', 'setText', 'Malformed op: op must be an object'],
    ['an array', [], 'Malformed op: op must be an object'],
    ['an object with no op', { node: 'n4' }, 'Malformed op: op must be a string'],
    ['an object with a numeric op', { op: 3 }, 'Malformed op: op must be a string'],
    ['restore', { op: 'restore', seq: 9, entries: [] }, 'restore ops are internal'],
    ['an unknown kind', { op: 'banana' }, 'Unknown op "banana"'],
    ['an Object.prototype name', { op: 'toString' }, 'Unknown op "toString"'],
    ['setText with null text', { op: 'setText', node: 'n4', text: null }, 'Malformed op: setText.text must be a string'],
    ['setText with numeric text', { op: 'setText', node: 'n4', text: 123 }, 'Malformed op: setText.text must be a string'],
    ['setText without text', { op: 'setText', node: 'n4' }, 'Malformed op: setText.text must be a string'],
    ['setText with a numeric node', { op: 'setText', node: 4, text: 'x' }, 'Malformed op: setText.node must be a string'],
    ['setStyle with an unknown device', { op: 'setStyle', node: 'n3', device: 'desktop', prop: 'padding', value: '4px' }, 'Malformed op: setStyle.device must be one of base, tablet, mobile'],
    ['setStyle with a numeric value', { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: 4 }, 'Malformed op: setStyle.value must be a string or null'],
    ['setAttr with an object value', { op: 'setAttr', node: 'n3', name: 'type', value: {} }, 'Malformed op: setAttr.value must be a string or null'],
    ['setAttr with a numeric value', { op: 'setAttr', node: 'n3', name: 'type', value: 5 }, 'Malformed op: setAttr.value must be a string or null'],
    ['setName with a numeric name', { op: 'setName', node: 'n3', name: 5 }, 'Malformed op: setName.name must be a string or null'],
    ['setToken with a numeric value', { op: 'setToken', group: 'color', name: 'accent', value: 5 }, 'Malformed op: setToken.value must be a string or null'],
    ['setToken without a group', { op: 'setToken', name: 'accent', value: '#f00' }, 'Malformed op: setToken.group must be a string'],
    ['setInstanceProp with a numeric value', { op: 'setInstanceProp', node: 'n5', prop: 'title', value: 7 }, 'Malformed op: setInstanceProp.value must be a string or null'],
    ['insertNode with a negative index', { op: 'insertNode', parent: 'n2', index: -1, node: text('n9') }, 'Malformed op: insertNode.index must be a non-negative integer'],
    ['insertNode with a fractional index', { op: 'insertNode', parent: 'n2', index: 1.5, node: text('n9') }, 'Malformed op: insertNode.index must be a non-negative integer'],
    ['insertNode with a string index', { op: 'insertNode', parent: 'n2', index: '0', node: text('n9') }, 'Malformed op: insertNode.index must be a non-negative integer'],
    ['insertNode with an unknown node kind', { op: 'insertNode', parent: 'n2', index: 0, node: { id: 'n9', kind: 'banana' } }, 'Malformed op: insertNode.node: node n9: kind must be element, text or instance'],
    ['insertNode with a text node without text', { op: 'insertNode', parent: 'n2', index: 0, node: { id: 'n9', kind: 'text' } }, 'Malformed op: insertNode.node: node n9: text must be a string'],
    ['insertNode with a numeric node id', { op: 'insertNode', parent: 'n2', index: 0, node: text(9 as unknown as string) }, 'Malformed op: insertNode.node: node id must be a non-empty string'],
    ['insertNode with a null node', { op: 'insertNode', parent: 'n2', index: 0, node: null }, 'Malformed op: insertNode.node: node must be an object'],
    ['wrapNodes with a numeric node list entry', { op: 'wrapNodes', nodes: [1], wrapper: element('n9') }, 'Malformed op: wrapNodes.nodes must be an array of strings'],
    ['wrapNodes with a text wrapper', { op: 'wrapNodes', nodes: ['n4'], wrapper: text('n9') }, 'Malformed op: wrapNodes.wrapper must be an element node'],
    ['detachInstance with a numeric idMap value', { op: 'detachInstance', node: 'n5', idMap: { n6: 5 } }, 'Malformed op: detachInstance.idMap must be an object of strings'],
    ['addPage with a text root', { op: 'addPage', page: { id: 'p', name: 'P', route: '/p', root: text('n9') } }, 'Malformed op: addPage.page.root must be an element node'],
    ['addPage with a numeric id', { op: 'addPage', page: { id: 7, name: 'P', route: '/p', root: element('n9') } }, 'Malformed op: addPage.page.id must be a string'],
    ['duplicatePage without a route', { op: 'duplicatePage', source: 'home', page: { id: 'b', name: 'B' }, idMap: {} }, 'Malformed op: duplicatePage.page.route must be a string'],
    ['removePage with a numeric page', { op: 'removePage', page: 2 }, 'Malformed op: removePage.page must be a string'],
    ['insertNode with a 65-level payload', { op: 'insertNode', parent: 'n2', index: 0, node: chain(65) }, 'Malformed op: insertNode.node: Node tree deeper than 64 levels'],
    ['insertNode with a 70-level payload', { op: 'insertNode', parent: 'n2', index: 0, node: chain(70) }, 'Malformed op: insertNode.node: Node tree deeper than 64 levels'],
  ])('reports %s', (_label, op, problem) => {
    expect(opProblem(op)).toBe(problem);
  });
});

describe('nodeProblem', () => {
  test('accepts a tree exactly 64 levels deep', () => {
    expect(nodeProblem(chain(64))).toBeNull();
  });

  test('rejects a tree 65 levels deep', () => {
    expect(nodeProblem(chain(65))).toBe('Node tree deeper than 64 levels');
  });

  test('rejects an unknown kind below the root', () => {
    expect(nodeProblem(element('n1', [{ id: 'n2', kind: 'span' }]))).toBe(
      'node n2: kind must be element, text or instance',
    );
  });

  test('rejects an attribute value that is not a string', () => {
    expect(nodeProblem({ ...element('n1'), attrs: { title: 5 } })).toBe('node n1: attrs values must be strings');
  });

  test('rejects a style map with a value that is not a string', () => {
    expect(nodeProblem({ ...element('n1'), style: { base: { padding: 4 } } })).toBe(
      'node n1: style maps must be objects of strings',
    );
  });

  test('rejects a name that is not a string', () => {
    expect(nodeProblem({ ...element('n1'), name: 3 })).toBe('node n1: name must be a string');
  });

  test('rejects an instance prop that is not a string', () => {
    const instance = { id: 'n5', kind: 'instance', component: 'Card', props: { title: 7 }, style: { base: {} } };
    expect(nodeProblem(instance)).toBe('node n5: props values must be strings');
  });
});

describe('RESERVED_KEYS', () => {
  test('lists the names that would collide with Object.prototype', () => {
    expect([...RESERVED_KEYS].sort()).toEqual(['__proto__', 'constructor', 'prototype']);
  });
});
