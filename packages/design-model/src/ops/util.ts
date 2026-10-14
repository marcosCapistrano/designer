import { findNode, type Container, type Located } from '../tree.js';
import type { DesignDoc, DesignNode, ElementNode } from '../types.js';

export type NodeLookup = { ok: true; hit: Located } | { ok: false; error: string };

// For validate functions: finds the node, or returns the error to report.
export function lookupNode(doc: DesignDoc, id: string): NodeLookup {
  const hit = findNode(doc, id);
  return hit === null ? { ok: false, error: `Node ${id} not found` } : { ok: true, hit };
}

// For mutate functions only: validate has already confirmed the node exists.
export function requireNode(draft: DesignDoc, id: string): Located {
  const lookup = lookupNode(draft, id);
  if (!lookup.ok) throw new Error(lookup.error);
  return lookup.hit;
}

// For mutate functions only: validate has already confirmed the node is an element.
export function requireElement(draft: DesignDoc, id: string): ElementNode {
  const { node } = requireNode(draft, id);
  if (node.kind !== 'element') throw new Error(`Node ${id} is not an element`);
  return node;
}

const ATTR_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_ATTRS: ReadonlySet<string> = new Set(['style', 'class', 'data-d-id']);

// Returns the reason an attribute name is not allowed, or null.
export function validateAttrName(name: string): string | null {
  if (!ATTR_NAME_PATTERN.test(name) || RESERVED_ATTRS.has(name) || name.startsWith('on')) {
    return `Attribute "${name}" is not allowed`;
  }
  return null;
}

// Own properties only. Plain indexing would reach Object.prototype for a key such as "constructor".
export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// Component names of every instance in the given subtrees, in document order.
export function instanceComponents(nodes: readonly DesignNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'instance') return [node.component];
    if (node.kind === 'text') return [];
    return instanceComponents(node.children);
  });
}

// True when component `from` is `target`, or the expansion of `from` contains an instance that
// reaches `target`. A name with no definition contributes nothing. Safe on cyclic input.
export function componentReaches(doc: DesignDoc, from: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [from];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name === target) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const def = ownValue(doc.components, name);
    if (def !== undefined) pending.push(...instanceComponents([def.root]));
  }
  return false;
}

// Ruling 21: nodes placed inside component C must not make C contain itself. Returns the
// error for placing them into container, or null.
export function cycleError(
  doc: DesignDoc,
  container: Container,
  nodes: readonly DesignNode[],
): string | null {
  if (container.kind !== 'component') return null;
  const target = container.key;
  const cyclic = instanceComponents(nodes).some((name) => componentReaches(doc, name, target));
  return cyclic ? `Component cycle at ${target}` : null;
}
