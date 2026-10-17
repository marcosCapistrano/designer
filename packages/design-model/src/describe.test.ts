import { describe, expect, test } from 'vitest';
import { describeOp } from './describe.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import type { DesignDoc, DesignNode, ElementNode, Op } from './types.js';

function nodeById(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (!hit) throw new Error(`fixture is missing ${id}`);
  return hit.node;
}

function elementById(doc: DesignDoc, id: string): ElementNode {
  const node = nodeById(doc, id);
  if (node.kind !== 'element') throw new Error(`${id} must be an element`);
  return node;
}

// Sample doc plus an unnamed div (n9) and span (n10) between Header and a text node (n11),
// and an unnamed instance of Card (n12) inside Header.
function nestedDoc(): DesignDoc {
  const doc = sampleDoc();
  const header = elementById(doc, 'n2');
  header.children.push(
    {
      id: 'n9', kind: 'element', tag: 'div', attrs: {}, style: { base: {} },
      children: [
        {
          id: 'n10', kind: 'element', tag: 'span', attrs: {}, style: { base: {} },
          children: [{ id: 'n11', kind: 'text', text: 'Hi' }],
        },
      ],
    },
    { id: 'n12', kind: 'instance', component: 'Card', props: {}, style: { base: {} } },
  );
  return doc;
}

describe('describeOp', () => {
  describe('setStyle', () => {
    test('base device names the page, named ancestors and the node', () => {
      const op: Op = { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12px' };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: padding 8px → 12px');
    });

    test('mobile variant ends with the device name', () => {
      const op: Op = { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' };
      const text = describeOp(sampleDoc(), op);
      expect(text).toBe('Home › Header › LoginButton: padding unset → 4px (mobile)');
      expect(text.endsWith(' (mobile)')).toBe(true);
    });

    test('tablet variant reads the old value from the tablet map', () => {
      const doc = sampleDoc();
      elementById(doc, 'n3').style.mobile = { padding: '4px' };
      const tablet: Op = { op: 'setStyle', node: 'n3', device: 'tablet', prop: 'padding', value: '10px' };
      const mobile: Op = { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '6px' };
      expect(describeOp(doc, tablet)).toBe('Home › Header › LoginButton: padding unset → 10px (tablet)');
      expect(describeOp(doc, mobile)).toBe('Home › Header › LoginButton: padding 4px → 6px (mobile)');
    });

    test('null value reads as unset', () => {
      const op: Op = { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: null };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: padding 8px → unset');
    });

    test('component node is prefixed with the component name', () => {
      const op: Op = { op: 'setStyle', node: 'n7', device: 'base', prop: 'color', value: 'red' };
      const text = describeOp(sampleDoc(), op);
      expect(text.startsWith('Component Card › h2')).toBe(true);
      expect(text).toBe('Component Card › h2: color unset → red');
    });
  });

  describe('setText', () => {
    test('text node is labelled with its parent chain and "text"', () => {
      const op: Op = { op: 'setText', node: 'n4', text: 'Sign in' };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton › text: text "Log in" → "Sign in"');
    });

    test('text node inside a component keeps the component prefix; unnamed h2 is skipped', () => {
      const op: Op = { op: 'setText', node: 'n8', text: 'Title' };
      expect(describeOp(sampleDoc(), op)).toBe('Component Card › text: text "{{title}}" → "Title"');
    });
  });

  describe('setToken', () => {
    test('changed token value', () => {
      const op: Op = { op: 'setToken', group: 'color', name: 'primary', value: '#000' };
      expect(describeOp(sampleDoc(), op)).toBe('Token --color-primary: #3366ff → #000');
    });

    test('new token reads old value as unset', () => {
      const op: Op = { op: 'setToken', group: 'color', name: 'accent', value: '#f00' };
      expect(describeOp(sampleDoc(), op)).toBe('Token --color-accent: unset → #f00');
    });

    test('removed token reads new value as unset', () => {
      const op: Op = { op: 'setToken', group: 'color', name: 'primary', value: null };
      expect(describeOp(sampleDoc(), op)).toBe('Token --color-primary: #3366ff → unset');
    });
  });

  describe('insertNode', () => {
    test('named element is inserted under its parent label', () => {
      const op: Op = {
        op: 'insertNode', parent: 'n2', index: 0,
        node: { id: 'n9', kind: 'element', name: 'Logo', tag: 'img', attrs: {}, style: { base: {} }, children: [] },
      };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header: insert Logo at 0');
    });

    test('text node is described as "text"', () => {
      const op: Op = { op: 'insertNode', parent: 'n3', index: 1, node: { id: 'n9', kind: 'text', text: 'Go' } };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: insert text at 1');
    });

    test('unnamed instance is described by its component name', () => {
      const op: Op = {
        op: 'insertNode', parent: 'n1', index: 2,
        node: { id: 'n9', kind: 'instance', component: 'Card', props: {}, style: { base: {} } },
      };
      expect(describeOp(sampleDoc(), op)).toBe('Home › main: insert Card at 2');
    });
  });

  test('removeNode', () => {
    const op: Op = { op: 'removeNode', node: 'n3' };
    expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: remove');
  });

  test('moveNode names the node and the new parent', () => {
    const op: Op = { op: 'moveNode', node: 'n3', parent: 'n1', index: 1 };
    expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: move to Home › main at 1');
  });

  test('extractComponent names the node and the new component', () => {
    const op: Op = { op: 'extractComponent', node: 'n2', component: 'Hero', instanceId: 'n9' };
    expect(describeOp(sampleDoc(), op)).toBe('Home › Header: extract as component Hero');
  });

  describe('pages', () => {
    test('addPage', () => {
      const op: Op = {
        op: 'addPage',
        page: { id: 'about', name: 'About', route: '/about', root: { id: 'n20', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] } },
      };
      expect(describeOp(sampleDoc(), op)).toBe('Add page About (/about)');
    });

    test('removePage uses the page name', () => {
      const op: Op = { op: 'removePage', page: 'home' };
      expect(describeOp(sampleDoc(), op)).toBe('Remove page Home');
    });

    test('removePage of an unknown page uses the raw id', () => {
      const op: Op = { op: 'removePage', page: 'ghost' };
      expect(describeOp(sampleDoc(), op)).toBe('Remove page ghost');
    });

    test('duplicatePage names the source page and the copy', () => {
      const op: Op = {
        op: 'duplicatePage', source: 'home', page: { id: 'home-2', name: 'Home copy', route: '/copy' }, idMap: {},
      };
      expect(describeOp(sampleDoc(), op)).toBe('Duplicate page Home as Home copy (/copy)');
    });
  });

  describe('other ops', () => {
    test('setAttr falls back to label and op kind', () => {
      const op: Op = { op: 'setAttr', node: 'n3', name: 'type', value: 'button' };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: setAttr');
    });

    test('setName names the data-name it sets', () => {
      const op: Op = { op: 'setName', node: 'n3', name: 'Login' };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: set data-name to "Login"');
    });

    test('wrapNodes is labelled by its first node', () => {
      const op: Op = {
        op: 'wrapNodes', nodes: ['n3'],
        wrapper: { id: 'n30', kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children: [] },
      };
      expect(describeOp(sampleDoc(), op)).toBe('Home › Header › LoginButton: wrapNodes');
    });

    test('restore has no node and is described by its kind alone', () => {
      const op: Op = { op: 'restore', seq: 9, entries: [] };
      expect(describeOp(sampleDoc(), op)).toBe('restore');
    });
  });

  describe('label rule', () => {
    test('unnamed ancestors are skipped and the text node ends the label', () => {
      const op: Op = { op: 'setText', node: 'n11', text: 'Hello' };
      expect(describeOp(nestedDoc(), op)).toBe('Home › Header › text: text "Hi" → "Hello"');
    });

    test('unnamed instance is labelled by its component name', () => {
      const op: Op = { op: 'setStyle', node: 'n12', device: 'base', prop: 'padding', value: '4px' };
      expect(describeOp(nestedDoc(), op)).toBe('Home › Header › Card: padding unset → 4px');
    });

    test('unknown node id is used as the label', () => {
      const op: Op = { op: 'setStyle', node: 'n99', device: 'base', prop: 'padding', value: '1px' };
      expect(describeOp(sampleDoc(), op)).toBe('n99: padding unset → 1px');
    });
  });
});
