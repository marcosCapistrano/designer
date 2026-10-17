import { ownValue } from './ops/util.js';
import { findNode, type Container } from './tree.js';
import type { Device, DesignDoc, DesignNode, Op } from './types.js';

const SEP = ' › ';
const UNSET = 'unset';

// One-line, human-readable summary of an op. `before` is the doc the op is applied to, so every
// id in the op resolves against the state it changes.
export function describeOp(before: DesignDoc, op: Op): string {
  switch (op.op) {
    case 'setStyle': {
      const old = styleValue(before, op.node, op.device, op.prop);
      const device = op.device === 'base' ? '' : ` (${op.device})`;
      return `${labelOf(before, op.node)}: ${op.prop} ${orUnset(old)} → ${orUnset(op.value)}${device}`;
    }
    case 'setText': {
      const node = findNode(before, op.node)?.node;
      const old = node?.kind === 'text' ? node.text : '';
      return `${labelOf(before, op.node)}: text "${old}" → "${op.text}"`;
    }
    case 'insertNode':
      return `${labelOf(before, op.parent)}: insert ${bareLabel(op.node)} at ${op.index}`;
    case 'removeNode':
      return `${labelOf(before, op.node)}: remove`;
    case 'moveNode':
      return `${labelOf(before, op.node)}: move to ${labelOf(before, op.parent)} at ${op.index}`;
    case 'setName':
      return op.name === null ? `${labelOf(before, op.node)}: clear data-name` : `${labelOf(before, op.node)}: set data-name to "${op.name}"`;
    case 'extractComponent':
      return `${labelOf(before, op.node)}: extract as component ${op.component}`;
    case 'setToken': {
      const group = ownValue(before.tokens, op.group);
      const old = group === undefined ? undefined : ownValue(group, op.name);
      return `Token --${op.group}-${op.name}: ${orUnset(old)} → ${orUnset(op.value)}`;
    }
    case 'addPage':
      return `Add page ${op.page.name} (${op.page.route})`;
    case 'removePage':
      return `Remove page ${pageName(before, op.page)}`;
    case 'duplicatePage':
      return `Duplicate page ${pageName(before, op.source)} as ${op.page.name} (${op.page.route})`;
    default: {
      // Ops without a format of their own are labelled by the node they act on, if they name one.
      const target = 'node' in op ? op.node : op.op === 'wrapNodes' ? (op.nodes[0] ?? null) : null;
      return target === null ? op.op : `${labelOf(before, target)}: ${op.op}`;
    }
  }
}

function orUnset(value: string | null | undefined): string {
  return value ?? UNSET;
}

// Device-specific value, as the op sees it. Undefined when that device has no override.
function styleValue(
  doc: DesignDoc,
  nodeId: string,
  device: Device,
  prop: string,
): string | undefined {
  const node = findNode(doc, nodeId)?.node;
  if (node === undefined || node.kind === 'text') return undefined;
  const map = node.style[device];
  return map === undefined ? undefined : ownValue(map, prop);
}

function pageName(doc: DesignDoc, pageId: string): string {
  return ownValue(doc.pages, pageId)?.name ?? pageId;
}

// The name the user gave the node, if any. Text nodes have none.
function ownName(node: DesignNode): string | undefined {
  if (node.kind === 'text') return undefined;
  return node.name || undefined;
}

// The node's own name, else its tag, `text`, or its component name.
function bareLabel(node: DesignNode): string {
  const name = ownName(node);
  if (name !== undefined) return name;
  if (node.kind === 'element') return node.tag;
  if (node.kind === 'text') return 'text';
  return node.component;
}

function containerPrefix(doc: DesignDoc, container: Container): string {
  if (container.kind === 'page') return ownValue(doc.pages, container.key)?.name ?? container.key;
  const component = ownValue(doc.components, container.key);
  return `Component ${component?.name ?? container.key}`;
}

// `Home › Header › LoginButton`: the container prefix, each named ancestor, then the node itself.
// An id that is not in `doc` is its own label.
function labelOf(doc: DesignDoc, id: string): string {
  const found = findNode(doc, id);
  if (found === null) return id;
  const ancestors = found.path.map(ownName).filter((name): name is string => name !== undefined);
  return [containerPrefix(doc, found.container), ...ancestors, bareLabel(found.node)].join(SEP);
}
