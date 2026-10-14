import { DEVICES, type Op } from './types.js';

// Checks the shape of ops and of the node payloads they carry. Shape only: whether an op can
// run against a doc is decided by its handler.

const MAX_DEPTH = 64;
// Ids and names become object keys, so these would collide with Object.prototype.
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

// A plain object: a literal, a JSON value or Object.create(null). Arrays and class instances are not.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringMap = (value: unknown): boolean =>
  isPlainObject(value) && Object.values(value).every(isString);

// Each rule returns the problem with the field at `path`, or null.
type Rule = (value: unknown, path: string) => string | null;

const text: Rule = (value, path) => (isString(value) ? null : `${path} must be a string`);
const nullableText: Rule = (value, path) =>
  value === null || isString(value) ? null : `${path} must be a string or null`;
const index: Rule = (value, path) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? null
    : `${path} must be a non-negative integer`;
const device: Rule = (value, path) =>
  DEVICES.some((known) => known === value) ? null : `${path} must be one of ${DEVICES.join(', ')}`;
const textList: Rule = (value, path) =>
  Array.isArray(value) && value.every(isString) ? null : `${path} must be an array of strings`;
const textMap: Rule = (value, path) => (isStringMap(value) ? null : `${path} must be an object of strings`);

const node: Rule = (value, path) => {
  const problem = nodeProblem(value);
  return problem === null ? null : `${path}: ${problem}`;
};
const element: Rule = (value, path) =>
  isPlainObject(value) && value['kind'] === 'element' ? node(value, path) : `${path} must be an element node`;

// The header fields every page carries.
const pageHeader = (value: Record<string, unknown>, path: string): string | null => {
  for (const field of ['id', 'name', 'route'] as const) {
    if (!isString(value[field])) return `${path}.${field} must be a string`;
  }
  return null;
};
const newPage: Rule = (value, path) => {
  if (!isPlainObject(value)) return `${path} must be an object`;
  return pageHeader(value, path) ?? element(value['root'], `${path}.root`);
};
const duplicatedPage: Rule = (value, path) => {
  if (!isPlainObject(value)) return `${path} must be an object`;
  return pageHeader(value, path);
};

type OpKind = Exclude<Op['op'], 'restore'>;
type FieldRules = {
  [K in OpKind]-?: { [F in Exclude<keyof Extract<Op, { op: K }>, 'op'>]-?: Rule };
};

// Every field of every non-restore op. The type makes a missing or extra field a compile error.
const FIELD_RULES: FieldRules = {
  setStyle: { node: text, device, prop: text, value: nullableText },
  setText: { node: text, text },
  setAttr: { node: text, name: text, value: nullableText },
  setName: { node: text, name: nullableText },
  setToken: { group: text, name: text, value: nullableText },
  insertNode: { parent: text, index, node },
  removeNode: { node: text },
  moveNode: { node: text, parent: text, index },
  wrapNodes: { nodes: textList, wrapper: element },
  extractComponent: { node: text, component: text, instanceId: text },
  setInstanceProp: { node: text, prop: text, value: nullableText },
  detachInstance: { node: text, idMap: textMap },
  addPage: { page: newPage },
  duplicatePage: { source: text, page: duplicatedPage, idMap: textMap },
  removePage: { page: text },
};

const RESTORE_INTERNAL = 'restore ops are internal';

// Why `value` is not a well-formed op, or null when it is. Restore ops are internal and are refused here.
export function opProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'Malformed op: op must be an object';
  const kind = value['op'];
  if (!isString(kind)) return 'Malformed op: op must be a string';
  if (kind === 'restore') return RESTORE_INTERNAL;
  if (!Object.hasOwn(FIELD_RULES, kind)) return `Unknown op "${kind}"`;
  const rules: Record<string, Rule> = FIELD_RULES[kind as OpKind];
  for (const [field, rule] of Object.entries(rules)) {
    const problem = rule(value[field], `${kind}.${field}`);
    if (problem !== null) return `Malformed op: ${problem}`;
  }
  return null;
}

// Why `value` is not a well-formed node, or null when it is. `depth` is the node's level: the root is 1.
export function nodeProblem(value: unknown, depth = 1): string | null {
  if (depth > MAX_DEPTH) return `Node tree deeper than ${MAX_DEPTH} levels`;
  if (!isPlainObject(value)) return 'node must be an object';
  const id = value['id'];
  if (!isString(id) || id === '') return 'node id must be a non-empty string';
  switch (value['kind']) {
    case 'element':
      return elementProblem(id, value, depth);
    case 'text':
      return isString(value['text']) ? null : `node ${id}: text must be a string`;
    case 'instance':
      return instanceProblem(id, value);
    default:
      return `node ${id}: kind must be element, text or instance`;
  }
}

function elementProblem(id: string, node: Record<string, unknown>, depth: number): string | null {
  const shape = commonProblem(id, node) ?? attrsProblem(id, node);
  if (shape !== null) return shape;
  if (!isString(node['tag'])) return `node ${id}: tag must be a string`;
  const children = node['children'];
  if (!Array.isArray(children)) return `node ${id}: children must be an array`;
  for (const child of children) {
    const problem = nodeProblem(child, depth + 1);
    if (problem !== null) return problem;
  }
  return null;
}

function instanceProblem(id: string, node: Record<string, unknown>): string | null {
  const shape = commonProblem(id, node);
  if (shape !== null) return shape;
  if (!isString(node['component'])) return `node ${id}: component must be a string`;
  const props = node['props'];
  if (!isPlainObject(props)) return `node ${id}: props must be an object`;
  if (!Object.values(props).every(isString)) return `node ${id}: props values must be strings`;
  return null;
}

// The name and style every element and instance carries.
function commonProblem(id: string, node: Record<string, unknown>): string | null {
  if (node['name'] !== undefined && !isString(node['name'])) return `node ${id}: name must be a string`;
  const style = node['style'];
  if (!isPlainObject(style) || !isPlainObject(style['base'])) {
    return `node ${id}: style must be an object with a base object`;
  }
  return Object.values(style).every(isStringMap) ? null : `node ${id}: style maps must be objects of strings`;
}

function attrsProblem(id: string, node: Record<string, unknown>): string | null {
  const attrs = node['attrs'];
  if (!isPlainObject(attrs)) return `node ${id}: attrs must be an object`;
  return Object.values(attrs).every(isString) ? null : `node ${id}: attrs values must be strings`;
}
