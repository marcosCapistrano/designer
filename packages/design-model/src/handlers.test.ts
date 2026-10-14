import { describe, expect, test } from 'vitest';
import { validateOp } from './apply.js';
import { sampleDoc } from './fixtures.js';
import type { Op } from './types.js';

// The component ops have no handler until the component task adds them. That task removes
// them from ComponentKind and adds a sample op for each to SAMPLES.
type ComponentKind = 'extractComponent' | 'setInstanceProp' | 'detachInstance';
type HandledKind = Exclude<Op['op'], ComponentKind>;

// One valid sample op per handled kind. The mapped type fails typecheck when an Op kind is
// missing here, or when a sample's op field does not match its key.
const SAMPLES: { [K in HandledKind]: Extract<Op, { op: K }> } = {
  setStyle: { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '4px' },
  setText: { op: 'setText', node: 'n4', text: 'Sign in' },
  setAttr: { op: 'setAttr', node: 'n3', name: 'type', value: 'submit' },
  setName: { op: 'setName', node: 'n3', name: 'Login' },
  setToken: { op: 'setToken', group: 'color', name: 'accent', value: '#f00' },
  insertNode: { op: 'insertNode', parent: 'n2', index: 0, node: { id: 'n9', kind: 'text', text: 'Hi' } },
  removeNode: { op: 'removeNode', node: 'n3' },
  moveNode: { op: 'moveNode', node: 'n5', parent: 'n2', index: 0 },
  wrapNodes: {
    op: 'wrapNodes',
    nodes: ['n4'],
    wrapper: { id: 'n9', kind: 'element', tag: 'span', attrs: {}, style: { base: {} }, children: [] },
  },
  addPage: {
    op: 'addPage',
    page: {
      id: 'pricing', name: 'Pricing', route: '/pricing',
      root: { id: 'n9', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
    },
  },
  duplicatePage: {
    op: 'duplicatePage',
    source: 'home',
    page: { id: 'home-b', name: 'Home B', route: '/b' },
    idMap: { n1: 'n10', n2: 'n11', n3: 'n12', n4: 'n13', n5: 'n14' },
  },
  removePage: { op: 'removePage', page: 'home' },
  restore: { op: 'restore', seq: 9, entries: [] },
};

describe('handler coverage', () => {
  test.each(Object.keys(SAMPLES) as HandledKind[])('%s has a handler', (kind) => {
    // An op with no handler is reported as Unknown op. A handled kind's sample is valid.
    expect(validateOp(sampleDoc(), SAMPLES[kind])).toBeNull();
  });
});
