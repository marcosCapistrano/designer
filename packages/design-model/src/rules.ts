// Shared validation rules for ids, tags and attribute values. Each validator returns the reason
// a value is not allowed, or null.

// Keys that would collide with Object.prototype when used as a record key.
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SEQUENCE_ID_PATTERN = /^n(\d+)$/;
const MAX_SEQUENCE = 999999999999999;

// The message names the id, truncated to 64 characters so an overlong value cannot flood it.
export function validateNodeId(id: unknown): string | null {
  const invalid = `Invalid node id "${String(id).slice(0, 64)}"`;
  if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) return invalid;
  const match = SEQUENCE_ID_PATTERN.exec(id);
  if (match !== null && Number(match[1]) > MAX_SEQUENCE) return invalid;
  return null;
}

const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validatePageId(id: unknown): string | null {
  if (typeof id !== 'string' || !PAGE_ID_PATTERN.test(id) || RESERVED_KEYS.has(id)) {
    return `Invalid page id "${String(id)}"`;
  }
  return null;
}

// Elements that cannot hold children in HTML.
export const VOID_TAGS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

// Tags that run script, load other content, or change the page frame.
export const DENIED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta',
  'link', 'noscript', 'template', 'slot', 'portal', 'title', 'head', 'html', 'body',
]);

const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;

export function validateTag(tag: string): string | null {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) return `Invalid tag "${String(tag)}"`;
  if (DENIED_TAGS.has(tag)) return `Tag "${tag}" is not allowed`;
  return null;
}

// Spaces and control characters. Browsers strip some of these from a URL before reading its scheme,
// so they are removed here before the prefix check.
const IGNORED_IN_URL = /[\u0000- ]/g;
const UNSAFE_URL_PREFIXES = ['javascript:', 'vbscript:', 'data:text/html'] as const;

export function validateAttrValue(name: string, value: string): string | null {
  if (name === 'srcdoc') return 'Attribute srcdoc is not allowed';
  // Op logs are decoded without a shape check, so a value can arrive here as another type.
  if (typeof value !== 'string') return `Attribute ${name} must have a string value`;
  const normalized = value.replace(IGNORED_IN_URL, '').toLowerCase();
  if (UNSAFE_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return `Unsafe URL in attribute ${name}`;
  }
  return null;
}
