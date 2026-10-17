import { z } from 'zod';

/**
 * Preview adapters are data committed in the app repo (ruling R6): they map an external module export to
 * a host element, its children, or nothing. The importer never executes the package they stand in for.
 */
export const ADAPTERS_FILE = '.hub/adapters.json';
export const MAX_ADAPTERS = 500;
export const MAX_ADAPTERS_BYTES = 64 * 1024;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const notReserved = (key: string) => !RESERVED.has(key);
const key = (pattern: RegExp, message: string) => z.string().refine(notReserved, 'is a reserved key').regex(pattern, message);

// A bare package specifier with an optional scope and subpath; relative and aliased paths are source, never adapters.
const specifier = key(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@-]+)*$/i, 'must be an external package specifier');
const exportName = key(/^(?:\*|[A-Za-z_$][\w$]*)$/, 'must be an export name, "default" or "*"');
// Props compiled by other rules, or never rendered, cannot be copied to an attribute.
const UNMAPPED_PROPS = new Set(['className', 'class', 'style', 'children', 'key', 'ref', 'dangerouslySetInnerHTML']);
const jsxProp = key(/^[A-Za-z_$][\w$-]*$/, 'must be a JSX prop name')
  .refine((name) => !UNMAPPED_PROPS.has(name) && !/^on[A-Z]/.test(name), 'cannot be mapped to an attribute');
// Class and style follow host-element CSS rules; React-only names are never attributes.
const DENIED_ATTRS = new Set(['class', 'classname', 'style', 'srcdoc', 'children', 'key', 'ref', 'dangerouslysetinnerhtml']);
const htmlAttr = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'must be an attribute name')
  .refine((name) => !DENIED_ATTRS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('on'), 'is not an allowed attribute');
const cssPath = z.string()
  .regex(/^[^/\\].*\.css$/, 'must be a source-relative .css path')
  .refine((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'must be a normalized relative path');

export const AdapterSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('element'),
    tag: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase element tag'),
    attrs: z.record(jsxProp, htmlAttr)
      .refine((attrs) => new Set(Object.values(attrs)).size === Object.values(attrs).length, 'maps two props to one attribute')
      .optional(),
  }),
  z.strictObject({ kind: z.literal('children') }),
  z.strictObject({ kind: z.literal('omit') }),
]);

export const AdaptersSchema = z.strictObject({
  modules: z.record(specifier, z.record(exportName, AdapterSchema).refine((exports) => Object.keys(exports).length > 0, 'must declare at least one export')),
  styles: z.strictObject({ ignore: z.array(cssPath).max(MAX_ADAPTERS) }).optional(),
});

export type Adapter = z.infer<typeof AdapterSchema>;
export type Adapters = z.infer<typeof AdaptersSchema>;
export type AdaptersResult = { ok: true; adapters: Adapters } | { ok: false; error: string };

function reservedKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  return Object.keys(value).some((name) => RESERVED.has(name)) || Object.values(value).some((child) => reservedKey(child, depth + 1));
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function check(value: unknown): AdaptersResult {
  if (reservedKey(value)) return { ok: false, error: `${ADAPTERS_FILE} uses a reserved key` };
  const parsed = AdaptersSchema.safeParse(value);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error };
  }
  const count = Object.values(parsed.data.modules).reduce((sum, exports) => sum + Object.keys(exports).length, 0);
  if (count > MAX_ADAPTERS) return { ok: false, error: `At most ${MAX_ADAPTERS} adapters are supported` };
  return { ok: true, adapters: parsed.data };
}

/** The problem with an already-parsed adapters object, or null; for callers that hold the data, not the file. */
export function adaptersProblem(value: unknown): string | null {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { return `${ADAPTERS_FILE} must be JSON data`; }
  if (text === undefined) return `${ADAPTERS_FILE} must be JSON data`;
  if (bytes(text) > MAX_ADAPTERS_BYTES) return `${ADAPTERS_FILE} exceeds 64 KB`;
  const result = check(value);
  return result.ok ? null : result.error;
}

export function parseAdapters(text: string): AdaptersResult {
  if (bytes(text) > MAX_ADAPTERS_BYTES) return { ok: false, error: `${ADAPTERS_FILE} exceeds 64 KB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${ADAPTERS_FILE} is not valid JSON` };
  }
  return check(raw);
}
