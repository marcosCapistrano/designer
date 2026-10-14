import { validateStyle } from '../css.js';
import { allIds, isDescendant, type Container, type Located } from '../tree.js';
import {
  DEVICES,
  type DesignDoc,
  type DesignNode,
  type ElementNode,
  type NodeStyle,
  type StyleMap,
} from '../types.js';
import type { HandlerMap } from './handler.js';
import { lookupNode, ownValue, requireElement, requireNode, validateAttrName } from './util.js';

const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;
const NOT_SIBLINGS = 'nodes must be contiguous siblings';

// Returns the reason a subtree cannot be added to doc, or null. Ids must be unique within the
// subtree and absent from doc and from ctx.extraIds. Used by insertNode, wrapNodes and later
// by the component ops.
export function validateSubtree(
  doc: DesignDoc,
  node: DesignNode,
  ctx: { extraIds?: Set<string> } = {},
): string | null {
  const state: IdState = {
    taken: new Set(allIds(doc)),
    extra: ctx.extraIds ?? new Set<string>(),
    seen: new Set<string>(),
  };
  return checkNode(doc, node, state);
}

interface IdState {
  taken: ReadonlySet<string>;
  extra: ReadonlySet<string>;
  seen: Set<string>;
}

function checkNode(doc: DesignDoc, node: DesignNode, state: IdState): string | null {
  const { id } = node;
  if (state.seen.has(id) || state.taken.has(id) || state.extra.has(id)) {
    return `Id ${id} already exists`;
  }
  state.seen.add(id);

  if (node.kind === 'text') return null;
  if (node.kind === 'instance') {
    if (ownValue(doc.components, node.component) === undefined) {
      return `Component ${node.component} not found`;
    }
    return checkStyle(node.style);
  }

  if (!TAG_PATTERN.test(node.tag)) return `Invalid tag "${node.tag}"`;
  for (const name of Object.keys(node.attrs)) {
    const problem = validateAttrName(name);
    if (problem !== null) return problem;
  }
  const styleProblem = checkStyle(node.style);
  if (styleProblem !== null) return styleProblem;
  for (const child of node.children) {
    const problem = checkNode(doc, child, state);
    if (problem !== null) return problem;
  }
  return null;
}

const KNOWN_DEVICES: ReadonlySet<string> = new Set(DEVICES);

function checkStyle(style: NodeStyle): string | null {
  for (const [device, map] of Object.entries(style) as [string, StyleMap | undefined][]) {
    if (!KNOWN_DEVICES.has(device)) return `Unknown device "${device}"`;
    if (map === undefined) continue;
    for (const [prop, value] of Object.entries(map)) {
      const problem = validateStyle(prop, value);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function indexInRange(index: number, count: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index <= count;
}

function sameContainer(a: Container, b: Container): boolean {
  return a.kind === b.kind && a.key === b.key;
}

export const structureHandlers: HandlerMap = {
  insertNode: {
    validate(doc, op) {
      const found = lookupNode(doc, op.parent);
      if (!found.ok) return found.error;
      if (found.hit.node.kind !== 'element') return `Node ${op.parent} is not an element`;
      if (!indexInRange(op.index, found.hit.node.children.length)) {
        return `Index ${op.index} is out of range`;
      }
      return validateSubtree(doc, op.node);
    },
    mutate(draft, op) {
      requireElement(draft, op.parent).children.splice(op.index, 0, structuredClone(op.node));
    },
  },

  removeNode: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      return found.hit.parent === null ? 'cannot remove a root' : null;
    },
    mutate(draft, op) {
      const { parent, index } = requireNode(draft, op.node);
      if (parent === null) throw new Error('cannot remove a root');
      parent.children.splice(index, 1);
    },
  },

  moveNode: {
    validate(doc, op) {
      const moved = lookupNode(doc, op.node);
      if (!moved.ok) return moved.error;
      const target = lookupNode(doc, op.parent);
      if (!target.ok) return target.error;

      if (moved.hit.parent === null) return 'cannot move a root';
      if (target.hit.node.kind !== 'element') return `Node ${op.parent} is not an element`;
      if (!sameContainer(moved.hit.container, target.hit.container)) {
        return 'cannot move a node to another container';
      }
      if (isDescendant(moved.hit.node, op.parent)) {
        return 'cannot move a node into itself or its descendant';
      }

      // The index counts the target's children after the node is detached from them.
      const detached = moved.hit.parent.id === op.parent ? 1 : 0;
      const remaining = target.hit.node.children.length - detached;
      return indexInRange(op.index, remaining) ? null : `Index ${op.index} is out of range`;
    },
    mutate(draft, op) {
      const moved = requireNode(draft, op.node);
      if (moved.parent === null) throw new Error('cannot move a root');
      moved.parent.children.splice(moved.index, 1);
      requireElement(draft, op.parent).children.splice(op.index, 0, moved.node);
    },
  },

  wrapNodes: {
    validate(doc, op) {
      const hits: Located[] = [];
      for (const id of op.nodes) {
        const found = lookupNode(doc, id);
        if (!found.ok) return found.error;
        if (found.hit.parent === null) return 'cannot wrap a root';
        hits.push(found.hit);
      }
      const [first] = hits;
      if (first === undefined) return NOT_SIBLINGS;
      const contiguous = hits.every(
        (hit, i) => hit.parent === first.parent && hit.index === first.index + i,
      );
      if (!contiguous) return NOT_SIBLINGS;

      if (op.wrapper.kind !== 'element' || op.wrapper.children.length !== 0) {
        return 'wrapper must be an element with no children';
      }
      return validateSubtree(doc, op.wrapper);
    },
    mutate(draft, op) {
      const [firstId] = op.nodes;
      if (firstId === undefined) throw new Error(NOT_SIBLINGS);
      const first = requireNode(draft, firstId);
      if (first.parent === null) throw new Error('cannot wrap a root');

      const wrapper: ElementNode = {
        ...structuredClone(op.wrapper),
        children: first.parent.children.splice(first.index, op.nodes.length),
      };
      first.parent.children.splice(first.index, 0, wrapper);
    },
  },
};
