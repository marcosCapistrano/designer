import { validateStyle } from '../css.js';
import { validateAttrValue } from '../rules.js';
import {
  DEVICES,
  type DesignDoc,
  type ElementNode,
  type InstanceNode,
  type StyleMap,
  type TextNode,
} from '../types.js';
import { editedAttrsIssue, templatedAttr } from '../props.js';
import { isPlainObject } from '../shape.js';
import type { HandlerMap } from './handler.js';
import { lookupNode, ownValue, requireElement, requireNode, validateAttrName } from './util.js';

// A token group has no dash: `--group-name` is split back at its first dash, so a dashed group would not round-trip.
const GROUP_PATTERN = /^[a-z][a-z0-9]*$/;
// A token name follows its group in `--group-name`, so it may start with a digit and use `_` (`--space-0_5`).
const TOKEN_NAME_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/;

// setStyle and setName apply to element and instance nodes. validate has already rejected text nodes.
function requireNonText(draft: DesignDoc, id: string): ElementNode | InstanceNode {
  const { node } = requireNode(draft, id);
  if (node.kind === 'text') throw new Error(`Node ${id} is a text node`);
  return node;
}

function requireText(draft: DesignDoc, id: string): TextNode {
  const { node } = requireNode(draft, id);
  if (node.kind !== 'text') throw new Error(`Node ${id} is not a text node`);
  return node;
}

// null deletes the key, a string sets it. Shared by style maps and attributes.
function writeEntry(map: Record<string, string>, key: string, value: string | null): void {
  if (value === null) delete map[key];
  else map[key] = value;
}

// Restore writes a copy, so objects from the op never end up inside the returned doc.
function assign<T>(record: Record<string, T>, key: string, value: T | null): void {
  if (value === null) delete record[key];
  else record[key] = structuredClone(value);
}

// Restore entries come from stored history, so they are checked as unknown data.
// Returns the reason an entry is malformed, or null.
function entryProblem(entry: unknown): string | null {
  if (!isPlainObject(entry)) return 'Invalid restore entry';
  const { kind, key, value } = entry;
  if (kind !== 'page' && kind !== 'component' && kind !== 'tokens') {
    return `Invalid restore entry kind "${String(kind)}"`;
  }
  if (typeof key !== 'string' || key === '') return `Invalid restore entry key for ${kind}`;
  // Assigning __proto__ would replace the prototype of the record it is written to. constructor and
  // prototype are plain own keys, and token groups may use them, so undo must accept them.
  if (key === '__proto__') return `Restore entry key "${key}" is reserved`;
  if (value === null) return null;
  if (!isPlainObject(value)) return `Invalid restore value for ${kind} "${key}"`;
  if (kind === 'tokens') {
    return Object.values(value).every((v) => typeof v === 'string')
      ? null
      : `Invalid restore value for tokens "${key}"`;
  }
  return isPlainObject(value['root']) ? null : `Invalid restore value for ${kind} "${key}"`;
}

export const basicHandlers: HandlerMap = {
  setStyle: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      if (found.hit.node.kind === 'text') return `Text node ${op.node} cannot be styled`;
      if (!DEVICES.includes(op.device)) return `Unknown device "${op.device}"`;
      return op.value === null ? null : validateStyle(op.prop, op.value);
    },
    mutate(draft, op) {
      const node = requireNonText(draft, op.node);
      if (op.device === 'base') {
        writeEntry(node.style.base, op.prop, op.value);
        return;
      }
      const map: StyleMap = node.style[op.device] ?? {};
      writeEntry(map, op.prop, op.value);
      if (Object.keys(map).length === 0) delete node.style[op.device];
      else node.style[op.device] = map;
    },
  },

  setText: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      return found.hit.node.kind === 'text' ? null : `Node ${op.node} is not a text node`;
    },
    mutate(draft, op) {
      requireText(draft, op.node).text = op.text;
    },
  },

  setAttr: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      if (found.hit.node.kind !== 'element') return `Node ${op.node} is not an element`;
      const { container, node } = found.hit;
      const nameProblem = validateAttrName(op.name, container.kind === 'page' && ownValue(doc.pages, container.key)?.root === node);
      if (nameProblem !== null) return nameProblem;
      if (op.value === null) return null;
      // Inside a component, a placeholder in the value is filled in by every instance of it.
      return (
        validateAttrValue(op.name, op.value) ??
        editedAttrsIssue(doc, found.hit.container, templatedAttr(op.node, op.name, op.value))
      );
    },
    mutate(draft, op) {
      writeEntry(requireElement(draft, op.node).attrs, op.name, op.value);
    },
  },

  setName: {
    validate(doc, op) {
      const found = lookupNode(doc, op.node);
      if (!found.ok) return found.error;
      return found.hit.node.kind === 'text' ? `Text node ${op.node} cannot be named` : null;
    },
    mutate(draft, op) {
      const node = requireNonText(draft, op.node);
      if (op.name === null) delete node.name;
      else node.name = op.name;
    },
  },

  setToken: {
    validate(_doc, op) {
      // group and name become the CSS custom property name `--group-name`.
      if (!GROUP_PATTERN.test(op.group) || !TOKEN_NAME_PATTERN.test(op.name)) {
        return `Invalid token name: group "${op.group}", name "${op.name}"`;
      }
      if (op.value === null) return null;
      // validateStyle needs a string. opProblem reports other types first, so this only guards internal callers.
      if (typeof op.value !== 'string') return 'Malformed op: setToken.value must be a string or null';
      // A token is emitted as a custom property, so its value gets the same checks.
      return validateStyle(`--${op.group}-${op.name}`, op.value);
    },
    mutate(draft, op) {
      const existing = ownValue(draft.tokens, op.group);
      if (op.value === null) {
        if (existing === undefined) return;
        delete existing[op.name];
        if (Object.keys(existing).length === 0) delete draft.tokens[op.group];
        return;
      }
      const group = existing ?? {};
      group[op.name] = op.value;
      draft.tokens[op.group] = group;
    },
  },

  restore: {
    validate(_doc, op) {
      if (!Number.isSafeInteger(op.seq) || op.seq < 0) return `Invalid restore seq ${op.seq}`;
      if (!Array.isArray(op.entries)) return 'Restore entries must be an array';
      const seen = new Set<string>();
      for (const entry of op.entries) {
        const problem = entryProblem(entry);
        if (problem !== null) return problem;
        const id = `${entry.kind}:${entry.key}`;
        if (seen.has(id)) return `Duplicate restore entry ${entry.kind} "${entry.key}"`;
        seen.add(id);
      }
      return null;
    },
    mutate(draft, op) {
      for (const entry of op.entries) {
        if (entry.kind === 'page') assign(draft.pages, entry.key, entry.value);
        else if (entry.kind === 'component') assign(draft.components, entry.key, entry.value);
        else assign(draft.tokens, entry.key, entry.value);
      }
      // Never lower seq: an undo must not free an id that a later op already used.
      draft.meta.seq = Math.max(draft.meta.seq, op.seq);
    },
  },
};
