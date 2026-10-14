// Values JSON.stringify drops from objects.
const isOmitted = (value: unknown): boolean =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

// Compares by code point. The default string sort compares UTF-16 code units, which
// disagrees for astral characters versus U+E000..U+FFFF.
function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (ch) => ch.codePointAt(0) ?? 0);
  const y = Array.from(b, (ch) => ch.codePointAt(0) ?? 0);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return x.length - y.length;
}

// Keys are sorted here instead of by building a sorted object, because JS always
// enumerates integer-like keys first in numeric order (so '10' would precede '2').
function write(value: unknown, indent: string): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns undefined for undefined, functions and symbols; JSON writes those as null.
    return JSON.stringify(value) ?? 'null';
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = Array.from(value, (item) => `${inner}${write(item, inner)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => !isOmitted(record[key]))
    .sort(compareCodePoints);
  if (keys.length === 0) return '{}';
  const members = keys.map((key) => `${inner}${JSON.stringify(key)}: ${write(record[key], inner)}`);
  return `{\n${members.join(',\n')}\n${indent}}`;
}

// Deterministic JSON: object keys sorted by code point at every level, array order kept,
// undefined properties omitted, 2-space indent, trailing newline.
export function canonicalStringify(value: unknown): string {
  return `${write(value, '')}\n`;
}
