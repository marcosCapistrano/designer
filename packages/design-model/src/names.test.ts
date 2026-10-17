import { describe, expect, test } from 'vitest';
import { describeOp } from './describe.js';
import { componentTitle, componentUses, displayName, layerOutline } from './names.js';
import type { DesignDoc, ElementNode, InstanceNode } from './types.js';

const el = (id: string, tag: string, children: ElementNode['children'] = [], name?: string): ElementNode =>
  ({ id, kind: 'element', tag, attrs: {}, style: { base: {} }, children, ...(name ? { name } : {}) });
const inst = (id: string, component: string, name?: string): InstanceNode =>
  ({ id, kind: 'instance', component, props: {}, style: { base: {} }, ...(name ? { name } : {}) });

function doc(): DesignDoc {
  return {
    meta: { version: 1, seq: 100 },
    pages: {
      p1: { id: 'p1', name: 'Home', route: '/', root: el('root', 'div', [el('h', 'h1', [{ id: 't1', kind: 'text', text: '  Hi  ' }]), inst('a', 'C')]) },
    },
    components: {
      C: { name: 'C', props: {}, root: el('cr', 'section', [el('cs', 'span', [{ id: 't2', kind: 'text', text: 'x' }]), inst('n', 'D')], 'Filter Panel') },
      D: { name: 'D', props: {}, root: el('dr', 'button') },
    },
    tokens: {},
  };
}

describe('displayName', () => {
  test('an element is its name, else its tag', () => {
    const d = doc();
    expect(displayName(d, el('x', 'div', [], 'Card'))).toBe('Card');
    expect(displayName(d, el('x', 'div'))).toBe('div');
  });
  test('an instance is its name, else its component title', () => {
    const d = doc();
    expect(displayName(d, inst('i', 'C', 'Filtros'))).toBe('Filtros');
    expect(displayName(d, inst('i', 'C'))).toBe('Filter Panel');
  });
  test('a text node is its trimmed text', () => {
    expect(displayName(doc(), { id: 't', kind: 'text', text: '  Hello  ' })).toBe('Hello');
  });
});

describe('componentTitle', () => {
  test('is the definition root name, else the component id', () => {
    expect(componentTitle(doc(), 'C')).toBe('Filter Panel');
    expect(componentTitle(doc(), 'D')).toBe('D');
    expect(componentTitle(doc(), 'Missing')).toBe('Missing');
  });
});

describe('componentUses', () => {
  test('counts instances on pages and inside definitions', () => {
    expect(componentUses(doc())).toEqual({ C: 1, D: 1 });
  });
});

describe('layerOutline', () => {
  test('nests instance layers under their path, and text-only elements are text layers', () => {
    expect(layerOutline(doc(), 'p1')).toEqual({
      id: 'root', name: 'div', kind: 'element', children: [
        { id: 'h', name: 'h1', kind: 'text', text: 'Hi', children: [] },
        { id: 'a', name: 'Filter Panel', kind: 'instance', component: 'C', children: [
          { id: 'a/cr', name: 'Filter Panel', kind: 'element', children: [
            { id: 'a/cs', name: 'span', kind: 'text', text: 'x', children: [] },
            { id: 'a/n', name: 'D', kind: 'instance', component: 'D', children: [
              { id: 'a/n/dr', name: 'button', kind: 'element', children: [] },
            ] },
          ] },
        ] },
      ],
    });
  });
  test('an unknown page has no outline', () => {
    expect(layerOutline(doc(), 'nope')).toBeNull();
  });
});

describe('describeOp setName', () => {
  test('names the data-name it sets or clears', () => {
    expect(describeOp(doc(), { op: 'setName', node: 'h', name: 'Title' })).toContain('set data-name to "Title"');
    expect(describeOp(doc(), { op: 'setName', node: 'h', name: null })).toContain('clear data-name');
  });
});
