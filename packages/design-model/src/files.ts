import { canonicalLine, canonicalStringify } from './canonical.js';
import { type Container, walkDoc } from './tree.js';
import type { ComponentDef, DesignDoc, Op, Page, Result, Tokens } from './types.js';

const META = 'meta.json';
const TOKENS = 'tokens.json';
const PAGE_FILE = /^pages\/([^/]+)\.json$/;
const COMPONENT_FILE = /^components\/([^/]+)\.json$/;
// Files that sit beside the model in design/ but are not part of the document.
const IGNORED_FILES = new Set(['changes.jsonl', 'sync.json']);
const IGNORED_PREFIX = 'archive/';
// Ids and names become object keys, so these would collide with Object.prototype.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Each page and component gets its own file, named by its record key (its id or name).
export function serializeDoc(doc: DesignDoc): Record<string, string> {
  const files: Record<string, string> = {
    [META]: canonicalStringify(doc.meta),
    [TOKENS]: canonicalStringify(doc.tokens),
  };
  for (const [key, page] of Object.entries(doc.pages)) {
    files[`pages/${key}.json`] = canonicalStringify(page);
  }
  for (const [key, def] of Object.entries(doc.components)) {
    files[`components/${key}.json`] = canonicalStringify(def);
  }
  return files;
}

// Checks the meta, tokens, page and component files, and every node in them, before the
// duplicate-id scan. Malformed input returns an error and never throws.
export function parseDoc(files: Record<string, string>): Result<DesignDoc> {
  const meta = readJsonFile(files, META);
  if (!meta.ok) return meta;
  if (!isRecord(meta.value)) return { ok: false, error: `${META}: expected an object` };
  if (meta.value['version'] !== 1) return { ok: false, error: `${META}: unsupported version` };
  const seq = meta.value['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, error: `${META}: seq must be a non-negative integer` };
  }

  const tokens = readJsonFile(files, TOKENS);
  if (!tokens.ok) return tokens;
  if (!isRecord(tokens.value)) return { ok: false, error: `${TOKENS}: expected an object` };

  const pages: Record<string, Page> = {};
  const components: Record<string, ComponentDef> = {};
  for (const file of Object.keys(files).sort()) {
    if (file === META || file === TOKENS || isIgnored(file)) continue;
    const pageFile = PAGE_FILE.exec(file);
    const match = pageFile ?? COMPONENT_FILE.exec(file);
    if (match === null) return { ok: false, error: `unexpected file "${file}"` };
    const key = match[1] ?? '';
    if (RESERVED_KEYS.has(key)) return { ok: false, error: `${file}: "${key}" is a reserved name` };
    if (pageFile !== null) {
      const page = readEntry<Page>(files, file, 'id', key);
      if (!page.ok) return page;
      pages[key] = page.value;
    } else {
      const component = readEntry<ComponentDef>(files, file, 'name', key);
      if (!component.ok) return component;
      components[key] = component.value;
    }
  }

  const doc: DesignDoc = {
    meta: meta.value as DesignDoc['meta'],
    pages,
    components,
    tokens: tokens.value as Tokens,
  };
  const duplicate = duplicateIdError(doc);
  return duplicate === null ? { ok: true, value: doc } : { ok: false, error: duplicate };
}

function readJsonFile(files: Record<string, string>, name: string): Result<unknown> {
  const text = Object.hasOwn(files, name) ? files[name] : undefined;
  if (text === undefined) return { ok: false, error: `${name} is missing` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${name}: invalid JSON` };
  }
}

function isIgnored(file: string): boolean {
  return IGNORED_FILES.has(file) || file.startsWith(IGNORED_PREFIX);
}

// A page or component file must hold an object whose id (or name) equals the file name,
// and whose root is a well-formed element node.
function readEntry<T>(
  files: Record<string, string>,
  name: string,
  field: 'id' | 'name',
  expected: string,
): Result<T> {
  const read = readJsonFile(files, name);
  if (!read.ok) return read;
  const value = read.value;
  if (!isRecord(value)) return { ok: false, error: `${name}: expected an object` };
  if (value[field] !== expected) {
    return { ok: false, error: `${name}: ${field} must be "${expected}" to match the file name` };
  }
  const root = value['root'];
  if (!isRecord(root) || root['kind'] !== 'element') {
    return { ok: false, error: `${name}: root must be an element node` };
  }
  const problem = nodeProblem(root);
  return problem === null ? { ok: true, value: value as T } : { ok: false, error: `${name}: ${problem}` };
}

// Why `value` is not a well-formed node, or null when it is. Element children are checked recursively.
function nodeProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'node must be an object';
  const id = value['id'];
  if (typeof id !== 'string' || id === '') return 'node id must be a non-empty string';
  switch (value['kind']) {
    case 'element':
      return elementProblem(id, value);
    case 'text':
      return typeof value['text'] === 'string' ? null : `node ${id}: text must be a string`;
    case 'instance':
      return instanceProblem(id, value);
    default:
      return `node ${id}: kind must be element, text or instance`;
  }
}

function elementProblem(id: string, node: Record<string, unknown>): string | null {
  if (typeof node['tag'] !== 'string') return `node ${id}: tag must be a string`;
  if (!isRecord(node['attrs'])) return `node ${id}: attrs must be an object`;
  if (!hasBase(node['style'])) return `node ${id}: style must be an object with a base object`;
  const children = node['children'];
  if (!Array.isArray(children)) return `node ${id}: children must be an array`;
  for (const child of children) {
    const problem = nodeProblem(child);
    if (problem !== null) return problem;
  }
  return null;
}

function instanceProblem(id: string, node: Record<string, unknown>): string | null {
  if (typeof node['component'] !== 'string') return `node ${id}: component must be a string`;
  if (!isRecord(node['props'])) return `node ${id}: props must be an object`;
  if (!hasBase(node['style'])) return `node ${id}: style must be an object with a base object`;
  return null;
}

const hasBase = (style: unknown): boolean => isRecord(style) && isRecord(style['base']);

function fileOf(container: Container): string {
  return container.kind === 'page' ? `pages/${container.key}.json` : `components/${container.key}.json`;
}

// Node ids must be unique across every page and component. Names the files that hold a repeat.
function duplicateIdError(doc: DesignDoc): string | null {
  const entries: [string, string][] = [];
  walkDoc(doc, (node, container) => {
    entries.push([node.id, fileOf(container)]);
  });
  const firstFile = new Map<string, string>();
  for (const [id, file] of entries) {
    const first = firstFile.get(id);
    if (first === undefined) {
      firstFile.set(id, file);
      continue;
    }
    const where = first === file ? file : `${first} and ${file}`;
    return `Duplicate node id "${id}" in ${where}`;
  }
  return null;
}

// One canonical single-line JSON object per op, each followed by a newline.
export function encodeOpLog(ops: Op[]): string {
  return ops.map((op) => `${canonicalLine(op)}\n`).join('');
}

// Blank lines are skipped. Every line must parse as JSON before any line is checked for an
// op field, so a syntax error is reported ahead of a shape error on an earlier line.
// Only the shape is checked here. Op semantics are checked when an op is applied.
export function decodeOpLog(text: string): Result<Op[]> {
  const parsed: { number: number; value: unknown }[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const number = index + 1;
    try {
      parsed.push({ number, value: JSON.parse(line) });
    } catch {
      return { ok: false, error: `line ${number}: not valid JSON` };
    }
  }
  for (const { number, value } of parsed) {
    if (!isRecord(value) || typeof value['op'] !== 'string') {
      return { ok: false, error: `line ${number}: expected an object with a string "op" field` };
    }
  }
  return { ok: true, value: parsed.map(({ value }) => value as Op) };
}
