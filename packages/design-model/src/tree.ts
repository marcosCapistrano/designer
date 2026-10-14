import { MAX_SEQUENCE } from './rules.js';
import type { DesignDoc, DesignNode, ElementNode } from './types.js';

export type Container = { kind: 'page'; key: string } | { kind: 'component'; key: string };

export interface Located {
  node: DesignNode;
  container: Container;
  parent: ElementNode | null;
  index: number;
  path: DesignNode[]; // ancestors, root..parent; empty for a root
}

interface Root {
  root: ElementNode;
  container: Container;
}

// Pages first, then components, each in sorted key order.
function rootsOf(doc: DesignDoc): Root[] {
  const pages = sortedEntries(doc.pages).map(
    ([key, page]): Root => ({ root: page.root, container: { kind: 'page', key } }),
  );
  const components = sortedEntries(doc.components).map(
    ([key, def]): Root => ({ root: def.root, container: { kind: 'component', key } }),
  );
  return [...pages, ...components];
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function visitTree(
  node: DesignNode,
  container: Container,
  visit: (node: DesignNode, container: Container) => void,
): void {
  visit(node, container);
  if (node.kind === 'element') {
    for (const child of node.children) visitTree(child, container, visit);
  }
}

// Returned nodes are references into the doc. Clone before mutating.
export function findNode(doc: DesignDoc, id: string): Located | null {
  for (const { root, container } of rootsOf(doc)) {
    if (root.id === id) return { node: root, container, parent: null, index: 0, path: [] };
    const hit = locateIn(root, id, [root], container);
    if (hit) return hit;
  }
  return null;
}

// `ancestors` holds the path from the root down to and including `parent`.
function locateIn(
  parent: ElementNode,
  id: string,
  ancestors: ElementNode[],
  container: Container,
): Located | null {
  for (const [index, child] of parent.children.entries()) {
    if (child.id === id) return { node: child, container, parent, index, path: ancestors };
    if (child.kind === 'element') {
      const hit = locateIn(child, id, [...ancestors, child], container);
      if (hit) return hit;
    }
  }
  return null;
}

// The level of a node, counting the page or component root as level 1.
export function depthOf(doc: DesignDoc, id: string): number {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`Node ${id} not found`);
  return hit.path.length + 1;
}

// How many levels a subtree takes, counting its own root: a leaf is 1.
export function heightOf(node: DesignNode): number {
  if (node.kind !== 'element') return 1;
  let tallest = 0;
  for (const child of node.children) tallest = Math.max(tallest, heightOf(child));
  return 1 + tallest;
}

export function walkDoc(
  doc: DesignDoc,
  visit: (node: DesignNode, container: Container) => void,
): void {
  for (const { root, container } of rootsOf(doc)) visitTree(root, container, visit);
}

export function allIds(doc: DesignDoc): string[] {
  const ids: string[] = [];
  walkDoc(doc, (node) => {
    ids.push(node.id);
  });
  return ids;
}

// Next unused sequence number. Never below meta.seq, and above every id of the form n<digits>.
export function nextSeq(doc: DesignDoc): number {
  let next = doc.meta.seq;
  for (const id of allIds(doc)) {
    const match = /^n(\d+)$/.exec(id);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

const MAX_ALLOC = 1000;

// Does not change doc. The caller stores the new seq when it applies the op.
export function allocIds(doc: DesignDoc, count: number): string[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_ALLOC) {
    throw new RangeError(`allocIds count must be an integer from 0 to ${MAX_ALLOC}`);
  }
  const start = nextSeq(doc);
  if (count > 0 && start + count - 1 > MAX_SEQUENCE) {
    throw new RangeError('allocIds would exceed the largest node id n999999999999999');
  }
  return Array.from({ length: count }, (_, i) => `n${start + i}`);
}

export function isDescendant(ancestor: DesignNode, id: string): boolean {
  if (ancestor.id === id) return true;
  if (ancestor.kind !== 'element') return false;
  return ancestor.children.some((child) => isDescendant(child, id));
}
