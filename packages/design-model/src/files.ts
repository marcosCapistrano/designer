import { canonicalLine, canonicalStringify } from './canonical.js';
import { type Container, walkDoc } from './tree.js';
import type { ComponentDef, DesignDoc, Op, Page, Result, Tokens } from './types.js';

const META = 'meta.json';
const TOKENS = 'tokens.json';
const PAGE_FILE = /^pages\/([^/]+)\.json$/;
const COMPONENT_FILE = /^components\/([^/]+)\.json$/;

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

// Only the structure the rest of the engine relies on is checked. Nested nodes are not
// validated, so malformed node contents can still throw during the duplicate-id scan.
export function parseDoc(files: Record<string, string>): Result<DesignDoc> {
  const meta = readJsonFile(files, META);
  if (!meta.ok) return meta;
  if (!isRecord(meta.value)) return { ok: false, error: `${META}: expected an object` };
  if (meta.value['version'] !== 1) return { ok: false, error: `${META}: unsupported version` };
  if (typeof meta.value['seq'] !== 'number') return { ok: false, error: `${META}: seq must be a number` };

  const tokens = readJsonFile(files, TOKENS);
  if (!tokens.ok) return tokens;
  if (!isRecord(tokens.value)) return { ok: false, error: `${TOKENS}: expected an object` };

  const pages: Record<string, Page> = {};
  const components: Record<string, ComponentDef> = {};
  for (const file of Object.keys(files).sort()) {
    if (file === META || file === TOKENS) continue;
    const pageFile = PAGE_FILE.exec(file);
    const componentFile = COMPONENT_FILE.exec(file);
    if (pageFile !== null) {
      const id = pageFile[1] ?? '';
      const page = readEntry<Page>(files, file, 'id', id);
      if (!page.ok) return page;
      pages[id] = page.value;
    } else if (componentFile !== null) {
      const componentName = componentFile[1] ?? '';
      const component = readEntry<ComponentDef>(files, file, 'name', componentName);
      if (!component.ok) return component;
      components[componentName] = component.value;
    } else {
      return { ok: false, error: `unexpected file "${file}"` };
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

// A page or component file must hold an object whose id (or name) equals the file name,
// and whose root is an element node.
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
  if (!isRecord(root) || root['kind'] !== 'element' || !Array.isArray(root['children'])) {
    return { ok: false, error: `${name}: root must be an element node` };
  }
  return { ok: true, value: value as T };
}

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
