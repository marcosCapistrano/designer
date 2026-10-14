import { expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { DesignSession } from './session.js';
import type { ComponentDef, DesignDoc, DesignNode, ElementNode, Op, Page } from './types.js';

const PAGES = 50;
const NODES_PER_PAGE = 300;

// A tree of exactly `size` nodes: divs and text, split in halves so the depth stays small.
function tree(size: number, nextId: () => string): DesignNode {
  const id = nextId();
  if (size === 1) return { id, kind: 'text', text: 'Lorem ipsum' };
  const rest = size - 1;
  const children: DesignNode[] =
    rest === 1
      ? [{ id: nextId(), kind: 'text', text: 'Lorem ipsum' }]
      : [tree(Math.floor(rest / 2), nextId), tree(rest - Math.floor(rest / 2), nextId)];
  return { id, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children };
}

// 50 pages of 300 nodes each, with ids n1..n15000. Returns the doc and the id of the last page's root.
function buildDoc(): { doc: DesignDoc; target: string } {
  let counter = 0;
  const nextId = (): string => `n${++counter}`;
  const pages: Record<string, Page> = {};
  let target = '';
  for (let i = 0; i < PAGES; i++) {
    const rootId = nextId();
    const root: ElementNode = {
      id: rootId,
      kind: 'element',
      tag: 'main',
      attrs: {},
      style: { base: {} },
      children: [tree(NODES_PER_PAGE - 1, nextId)],
    };
    pages[`p${i}`] = { id: `p${i}`, name: `Page ${i}`, route: `/p${i}`, root };
    target = rootId;
  }
  return {
    doc: { meta: { version: 1, seq: counter + 1 }, pages, components: {}, tokens: {} },
    target,
  };
}

test('applying one setStyle to a 50-page doc has a median under 150 ms', () => {
  const { doc, target } = buildDoc();
  const op: Op = { op: 'setStyle', node: target, device: 'base', prop: 'padding', value: '4px' };

  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const result = applyOp(doc, op);
    durations.push(performance.now() - started);
    expect(result.ok).toBe(true);
  }

  durations.sort((a, b) => a - b);
  expect(durations[2]).toBeLessThan(150);
}, 30_000);

test('applying one setStyle through a session on a 50-page doc has a median under 150 ms', () => {
  const { doc, target } = buildDoc();
  const session = new DesignSession(doc);
  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    // A different value each time, so every apply changes the doc.
    const op: Op = { op: 'setStyle', node: target, device: 'base', prop: 'padding', value: `${i + 1}px` };
    const started = performance.now();
    const result = session.apply([op]);
    durations.push(performance.now() - started);
    expect(result.ok).toBe(true);
  }

  durations.sort((a, b) => a - b);
  expect(durations[2]).toBeLessThan(150);
}, 30_000);

// F6: inserting many instances of one big component finds that component's templated attributes once.
const INSTANCES = 2000;
const COMPONENT_NODES = 2000;

function bigComponentDoc(): { doc: DesignDoc; wrapper: ElementNode; reads: () => number } {
  let counter = 0;
  const nextId = (): string => `b${++counter}`;
  const children: DesignNode[] = Array.from({ length: COMPONENT_NODES - 2 }, () => ({
    id: nextId(),
    kind: 'element',
    tag: 'span',
    attrs: { 'data-a': 'plain' },
    style: { base: {} },
    children: [],
  }));
  const root: ElementNode = {
    id: nextId(),
    kind: 'element',
    tag: 'a',
    attrs: { href: '{{url}}', title: '{{label}}' },
    style: { base: {} },
    children,
  };
  const big: ComponentDef = {
    name: 'Big',
    props: { url: { default: '/x' }, label: { default: 'Go' } },
    root,
  };
  // Counts every read of the component's root, so a walk of its tree shows up as a read.
  let reads = 0;
  Object.defineProperty(big, 'root', {
    enumerable: true,
    get: () => {
      reads += 1;
      return root;
    },
  });

  const page: Page = {
    id: 'home',
    name: 'Home',
    route: '/',
    root: { id: 'p1', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
  };
  const wrapper: ElementNode = {
    id: 'w1',
    kind: 'element',
    tag: 'div',
    attrs: {},
    style: { base: {} },
    children: Array.from({ length: INSTANCES }, (_, i): DesignNode => ({
      id: `i${i}`,
      kind: 'instance',
      component: 'Big',
      props: { url: `/page-${i}`, label: `Item ${i}` },
      style: { base: {} },
    })),
  };
  return {
    doc: { meta: { version: 1, seq: counter + 1 }, pages: { home: page }, components: { Big: big }, tokens: {} },
    wrapper,
    reads: () => reads,
  };
}

test('insertNode of 2000 instances walks the component tree once, not once per instance', () => {
  const { doc, wrapper, reads } = bigComponentDoc();
  const before = reads();
  const result = applyOp(doc, { op: 'insertNode', parent: 'p1', index: 0, node: wrapper });
  expect(result.ok).toBe(true);
  // A few reads come from looking nodes up. Walking the tree per instance would be 2000 more.
  expect(reads() - before).toBeLessThan(20);
}, 30_000);

test('inserting 2000 instances of a 2000-node component has a median under 250 ms', () => {
  const { doc, wrapper } = bigComponentDoc();
  const durations: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const result = applyOp(doc, { op: 'insertNode', parent: 'p1', index: 0, node: wrapper });
    durations.push(performance.now() - started);
    expect(result.ok).toBe(true);
  }
  durations.sort((a, b) => a - b);
  expect(durations[1]).toBeLessThan(250);
}, 30_000);
