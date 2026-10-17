import { SVG_CASED_ATTRS } from '../rules.js';
import { MAX_DEPTH } from '../shape.js';
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

// Ruling P: marks a page root that stands for the source document's html element (see export.ts).
export const SHELL_ATTR = 'data-d-shell';

// Returns the reason an attribute name is not allowed, or null. `pageRoot` is true for the root element of a page.
export function validateAttrName(name: string, pageRoot = false): string | null {
  // Op logs are decoded without a shape check, so a name can arrive here as another type.
  if (typeof name !== 'string') return 'Attribute name must be a string';
  if (name === SHELL_ATTR && !pageRoot) return `Attribute "${SHELL_ATTR}" is only allowed on a page root`;
  if ((!ATTR_NAME_PATTERN.test(name) && !SVG_CASED_ATTRS.has(name)) || RESERVED_ATTRS.has(name) || name.startsWith('on')) {
    return `Attribute "${name}" is not allowed`;
  }
  return null;
}

// A subtree of `height` levels whose root sits at `level` (the page or component root is level 1).
// Returns the error when its deepest node would be past MAX_DEPTH, or null.
export function depthError(level: number, height: number): string | null {
  return level + height - 1 > MAX_DEPTH ? `Node tree deeper than ${MAX_DEPTH} levels` : null;
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
