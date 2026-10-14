import { findNode, type Located } from '../tree.js';
import type { DesignDoc, ElementNode } from '../types.js';

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
