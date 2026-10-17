import { validateOpInternal } from './apply.js';
import { validateStyle } from './css.js';
import { defaultProps, propAttrIssue, resolveProps, templatedAttrs } from './props.js';
import { validateAttrValue, validateNodeId, validatePageId, validateTag, VOID_TAGS } from './rules.js';
import { instanceComponents, ownValue, validateAttrName } from './ops/util.js';
import {
  componentFieldsProblem,
  isPlainObject,
  MAX_DEPTH,
  nodeProblem,
  pageFieldsProblem,
  tokensProblem,
} from './shape.js';
import {
  DEVICES,
  type ComponentDef,
  type DesignDoc,
  type DesignNode,
  type ElementNode,
  type InstanceNode,
  type NodeStyle,
  type StyleMap,
} from './types.js';

// Checks a whole doc against the rules the ops enforce, so a doc that passes can be loaded and edited.
// Returns the first problem as "<where>: <problem>", where <where> is "page <id>" or "component <name>",
// with " node <id>" added when the problem is on a node. Returns null when every rule holds.
export function validateDoc(doc: DesignDoc): string | null {
  // Nothing below reads a field before this has shown it is there, so no doc can make validateDoc throw.
  const shape = docShapeProblem(doc);
  if (shape !== null) return shape;

  const scan: Scan = { ids: new Set<string>(), attrs: new Map<ComponentDef, TemplatedAttrs>() };
  for (const [key, page] of sortedEntries(doc.pages)) {
    const where = `page ${label(key)}`;
    const keyProblem = validatePageId(key);
    if (keyProblem !== null) return `${where}: ${keyProblem}`;
    if (page.id !== key) return `${where}: page id "${label(page.id)}" does not match its key`;
    const problem = nodeIssue(doc, where, page.root, 1, scan, true);
    if (problem !== null) return problem;
  }
  for (const [key, def] of sortedEntries(doc.components)) {
    const where = `component ${label(key)}`;
    const problem = nodeIssue(doc, where, def.root, 1, scan);
    if (problem !== null) return problem;
    // A default is a value an instance gets when it sets none, so it must be safe where it is used.
    const unsafe = propAttrIssue(def, defaultProps(def), attrsOf(scan, def));
    if (unsafe !== null) return `${where}: ${unsafe}`;
  }
  const cycle = cycleIssue(doc);
  if (cycle !== null) return cycle;
  return tokensIssue(doc);
}

// Why `doc` is not shaped like a DesignDoc, or null: the meta, the three records, the header fields of each
// page and component, and the shape of every node tree. The rules in validateDoc read all of these unchecked,
// and so does a session, so both ask this first.
export function docShapeProblem(doc: unknown): string | null {
  if (!isPlainObject(doc)) return 'doc must be an object';
  const meta = doc['meta'];
  const seq = isPlainObject(meta) ? meta['seq'] : undefined;
  if (!isPlainObject(meta) || meta['version'] !== 1 || !Number.isSafeInteger(seq) || (seq as number) < 0) {
    return 'meta must be an object with version 1 and a non-negative integer seq';
  }
  const { pages, components } = doc;
  if (!isPlainObject(pages)) return 'pages must be an object';
  if (!isPlainObject(components)) return 'components must be an object';
  const tokens = tokensProblem(doc['tokens']);
  if (tokens !== null) return `tokens: ${tokens}`;

  for (const [key, def] of sortedEntries(components)) {
    const problem = componentFieldsProblem(def) ?? rootProblem(def);
    if (problem !== null) return `component ${label(key)}: ${problem}`;
  }
  for (const [key, page] of sortedEntries(pages)) {
    const problem = pageFieldsProblem(page) ?? rootProblem(page);
    if (problem !== null) return `page ${label(key)}: ${problem}`;
  }
  return null;
}

// Why the root of a page or component (already known to be an object) is not a well-formed element tree.
function rootProblem(entry: unknown): string | null {
  const root = isPlainObject(entry) ? entry['root'] : undefined;
  if (!isPlainObject(root) || root['kind'] !== 'element') return 'root must be an element node';
  return nodeProblem(root);
}

// Ruling 21: no component may contain itself, directly or through the components it uses. A depth-first
// search with three colors (absent: not reached, 1: on the current path, 2: finished) finds a cycle when it
// reaches a component that is on the current path, and visits each component and each instance once.
// It runs after every component tree has passed its depth check, because it walks all of them.
// Names the smallest key on the first cycle found, so the answer does not depend on where the search entered it.
function cycleIssue(doc: DesignDoc): string | null {
  const entries = sortedEntries(doc.components);
  const uses = new Map<string, string[]>();
  for (const [key, def] of entries) {
    const names = new Set(instanceComponents([def.root]));
    uses.set(key, [...names].filter((name) => Object.hasOwn(doc.components, name)).sort());
  }

  const color = new Map<string, 1 | 2>();
  for (const [start] of entries) {
    if (color.has(start)) continue;
    // The path from the start, each with the index of the next component it uses to try.
    const path: { key: string; next: number }[] = [{ key: start, next: 0 }];
    color.set(start, 1);
    for (let top = path.at(-1); top !== undefined; top = path.at(-1)) {
      const used = uses.get(top.key) ?? [];
      const name = used[top.next];
      if (name === undefined) {
        color.set(top.key, 2);
        path.pop();
        continue;
      }
      top.next += 1;
      const seen = color.get(name);
      if (seen === 1) {
        const ring = path.slice(path.findIndex((step) => step.key === name)).map((step) => step.key);
        const first = ring.reduce((a, b) => (a < b ? a : b));
        return `component ${label(first)}: Component cycle at ${label(first)}`;
      }
      if (seen === undefined) {
        color.set(name, 1);
        path.push({ key: name, next: 0 });
      }
    }
  }
  return null;
}

// Ids and keys are echoed into messages, so they are cut short.
function label(value: unknown): string {
  return String(value).slice(0, 64);
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

type TemplatedAttrs = ReturnType<typeof templatedAttrs>;

// What one validateDoc call carries from node to node.
interface Scan {
  // Every node id seen so far in the doc, so a repeat anywhere is reported.
  ids: Set<string>;
  // The attributes with a placeholder, per component, found once and used for each of its instances.
  attrs: Map<ComponentDef, TemplatedAttrs>;
}

function attrsOf(scan: Scan, def: ComponentDef): TemplatedAttrs {
  let attrs = scan.attrs.get(def);
  if (attrs === undefined) {
    attrs = templatedAttrs(def);
    scan.attrs.set(def, attrs);
  }
  return attrs;
}

// The first problem in the subtree at `node`, which sits at `depth` (the root is 1), or null.
function nodeIssue(
  doc: DesignDoc,
  where: string,
  node: DesignNode,
  depth: number,
  scan: Scan,
  pageRoot = false,
): string | null {
  const { ids } = scan;
  if (depth > MAX_DEPTH) return `${where}: Node tree deeper than ${MAX_DEPTH} levels`;
  const here = `${where} node ${label(node.id)}`;
  const idProblem = validateNodeId(node.id);
  if (idProblem !== null) return `${here}: ${idProblem}`;
  if (ids.has(node.id)) return `${here}: Duplicate node id ${label(node.id)}`;
  ids.add(node.id);

  if (node.kind === 'text') return null;
  const problem = node.kind === 'instance' ? instanceIssue(doc, node, scan) : elementIssue(node, pageRoot);
  if (problem !== null) return `${here}: ${problem}`;
  if (node.kind === 'element') {
    for (const child of node.children) {
      const childIssue = nodeIssue(doc, where, child, depth + 1, scan);
      if (childIssue !== null) return childIssue;
    }
  }
  return null;
}

// The checks insertNode applies to an element, on a node that is already in the doc.
function elementIssue(node: ElementNode, pageRoot: boolean): string | null {
  const tagProblem = validateTag(node.tag);
  if (tagProblem !== null) return tagProblem;
  for (const [name, value] of Object.entries(node.attrs)) {
    const problem = validateAttrName(name, pageRoot) ?? validateAttrValue(name, value);
    if (problem !== null) return problem;
  }
  const styleProblem = styleIssue(node.style);
  if (styleProblem !== null) return styleProblem;
  if (VOID_TAGS.has(node.tag) && node.children.length > 0) {
    return `Void element ${node.tag} cannot have children`;
  }
  return null;
}

// The component must exist, and every prop must be declared by it. This is the rule that checkNode
// (insertNode) and setInstanceProp apply, written with the same messages. Their validators are not
// called here: each one searches the whole doc for its node, which would make this check quadratic.
function instanceIssue(doc: DesignDoc, node: InstanceNode, scan: Scan): string | null {
  const def = ownValue(doc.components, node.component);
  if (def === undefined) return `Component ${node.component} not found`;
  for (const prop of Object.keys(node.props)) {
    if (!Object.hasOwn(def.props, prop)) return `Component ${node.component} has no prop "${prop}"`;
  }
  return propAttrIssue(def, resolveProps(def, node), attrsOf(scan, def)) ?? styleIssue(node.style);
}

const KNOWN_DEVICES: ReadonlySet<string> = new Set(DEVICES);

// Every device map must name a known device, and every value on it must pass validateStyle.
function styleIssue(style: NodeStyle): string | null {
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

// Each token goes through setToken's own validator, so a token is valid exactly when setToken accepts it.
function tokensIssue(doc: DesignDoc): string | null {
  for (const [group, names] of sortedEntries(doc.tokens)) {
    for (const [name, value] of sortedEntries(names)) {
      const problem = validateOpInternal(doc, { op: 'setToken', group, name, value });
      if (problem !== null) return `token ${label(group)}.${label(name)}: ${problem}`;
    }
  }
  return null;
}
