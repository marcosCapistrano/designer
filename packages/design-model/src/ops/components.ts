import { resolveProps, substituteProps } from '../props.js';
import { validateNodeId } from '../rules.js';
import { allIds } from '../tree.js';
import type {
  ComponentDef,
  DesignDoc,
  DesignNode,
  ElementNode,
  InstanceNode,
  NodeStyle,
} from '../types.js';
import type { HandlerMap } from './handler.js';
import { validateSubtree } from './structure.js';
import {
  cycleError,
  lookupNode,
  ownValue,
  requireNode,
} from './util.js';

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;

function requireInstance(draft: DesignDoc, id: string): InstanceNode {
  const { node } = requireNode(draft, id);
  if (node.kind !== 'instance') throw new Error(`Node ${id} is not an instance`);
  return node;
}

// Every node id in a component tree.
function treeIds(node: DesignNode): string[] {
  return node.kind === 'element' ? [node.id, ...node.children.flatMap(treeIds)] : [node.id];
}

function remap(ids: Record<string, string>, id: string): string {
  const next = ownValue(ids, id);
  if (next === undefined) throw new Error(`idMap is missing ${id}`);
  return next;
}

type Values = Record<string, string>;

// Copies keep no object from the component: values are copied, and placeholders are filled.
function copyNode(node: DesignNode, ids: Record<string, string>, values: Values): DesignNode {
  if (node.kind === 'element') return copyElement(node, ids, values);
  if (node.kind === 'text') {
    return {
      ...structuredClone(node),
      id: remap(ids, node.id),
      text: substituteProps(node.text, values),
    };
  }
  return {
    ...structuredClone(node),
    id: remap(ids, node.id),
    props: Object.fromEntries(
      Object.entries(node.props).map(([name, value]) => [name, substituteProps(value, values)]),
    ),
  };
}

function copyElement(node: ElementNode, ids: Record<string, string>, values: Values): ElementNode {
  const { attrs, children, ...rest } = node;
  return {
    ...structuredClone(rest),
    id: remap(ids, node.id),
    attrs: Object.fromEntries(
      Object.entries(attrs).map(([name, value]) => [name, substituteProps(value, values)]),
    ),
    children: children.map((child) => copyNode(child, ids, values)),
  };
}

// The instance's style maps win over the root's, device by device.
function mergeStyle(root: NodeStyle, over: NodeStyle): NodeStyle {
  const merged: NodeStyle = { base: { ...root.base, ...over.base } };
  for (const device of ['tablet', 'mobile'] as const) {
    const map = { ...root[device], ...over[device] };
    if (Object.keys(map).length > 0) merged[device] = map;
  }
  return merged;
}

// What detachInstance puts in place of the instance. The root keeps the instance's name when set.
function expand(def: ComponentDef, inst: InstanceNode, ids: Record<string, string>): ElementNode {
  const copy = copyElement(def.root, ids, resolveProps(def, inst));
  copy.style = mergeStyle(def.root.style, inst.style);
  if (inst.name !== undefined) copy.name = inst.name;
  return copy;
}

export const componentHandlers: HandlerMap = {
  extractComponent: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      const { node, container, parent } = found.hit;
      if (container.kind !== 'page') return `Node ${op.node} is inside a component`;
      if (parent === null) return 'cannot extract a root';
      if (node.kind !== 'element') return `Node ${op.node} is not an element`;
      if (!COMPONENT_NAME.test(op.component)) return `Invalid component name "${op.component}"`;
      if (ownValue(doc.components, op.component) !== undefined) {
        return `Component ${op.component} already exists`;
      }
      const idProblem = validateNodeId(op.instanceId);
      if (idProblem !== null) return idProblem;
      return allIds(doc).includes(op.instanceId) ? `Id ${op.instanceId} already exists` : null;
    },
    mutate(draft, op) {
      const { node, parent, index } = requireNode(draft, op.node);
      if (node.kind !== 'element' || parent === null) {
        throw new Error(`Node ${op.node} cannot be extracted`);
      }

      const instance: InstanceNode = {
        id: op.instanceId,
        kind: 'instance',
        component: op.component,
        props: {},
        style: { base: {} },
      };
      if (node.name !== undefined) instance.name = node.name;
      parent.children.splice(index, 1, instance);
      draft.components[op.component] = { name: op.component, props: {}, root: node };
    },
  },

  setInstanceProp: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      const { node } = found.hit;
      if (node.kind !== 'instance') return `Node ${op.node} is not an instance`;
      const def = ownValue(doc.components, node.component);
      if (def === undefined) return `Component ${node.component} not found`;
      if (Object.hasOwn(def.props, op.prop)) return null;
      return `Component ${node.component} has no prop "${op.prop}"`;
    },
    mutate(draft, op) {
      const inst = requireInstance(draft, op.node);
      if (op.value === null) delete inst.props[op.prop];
      else inst.props[op.prop] = op.value;
    },
  },

  detachInstance: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      const { node, container } = found.hit;
      if (node.kind !== 'instance') return `Node ${op.node} is not an instance`;
      const def = ownValue(doc.components, node.component);
      if (def === undefined) return `Component ${node.component} not found`;
      const ids = treeIds(def.root);
      if (ids.some((id) => ownValue(op.idMap, id) === undefined)) {
        return 'idMap must cover every component node';
      }
      const known = new Set(ids);
      const unknown = Object.keys(op.idMap).find((key) => !known.has(key));
      if (unknown !== undefined) return `idMap has unknown key ${unknown}`;
      const copy = expand(def, node, op.idMap);
      return validateSubtree(doc, copy) ?? cycleError(doc, container, [copy]);
    },
    mutate(draft, op) {
      const { node, parent, index } = requireNode(draft, op.node);
      if (node.kind !== 'instance' || parent === null) {
        throw new Error(`Node ${op.node} cannot be detached`);
      }
      const def = ownValue(draft.components, node.component);
      if (def === undefined) throw new Error(`Component ${node.component} not found`);
      parent.children.splice(index, 1, expand(def, node, op.idMap));
    },
  },
};
