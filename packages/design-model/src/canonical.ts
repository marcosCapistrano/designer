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
function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .filter((key) => !isOmitted(record[key]))
    .sort(compareCodePoints);
}

// `indent` is null for single-line output: no whitespace at all.
function write(value: unknown, indent: string | null): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns undefined for undefined, functions and symbols; JSON writes those as null.
    return JSON.stringify(value) ?? 'null';
  }
  const inner = indent === null ? null : `${indent}  `;
  const colon = indent === null ? ':' : ': ';
  const wrap = (open: string, close: string, members: string[]): string => {
    if (members.length === 0) return `${open}${close}`;
    if (inner === null) return `${open}${members.join(',')}${close}`;
    return `${open}\n${members.map((member) => `${inner}${member}`).join(',\n')}\n${indent}${close}`;
  };
  if (Array.isArray(value)) {
    // Array.from, not map: map would skip holes and leave empty slots in the output.
    return wrap('[', ']', Array.from(value, (item) => write(item, inner)));
  }
  const record = value as Record<string, unknown>;
  return wrap(
    '{',
    '}',
    sortedKeys(record).map((key) => `${JSON.stringify(key)}${colon}${write(record[key], inner)}`),
  );
}

// Deterministic JSON: object keys sorted by code point at every level, array order kept,
// undefined properties omitted, 2-space indent, trailing newline.
export function canonicalStringify(value: unknown): string {
  return `${write(value, '')}\n`;
}

// The same canonical form on one line, with no whitespace and no trailing newline (op logs).
export function canonicalLine(value: unknown): string {
  return write(value, null);
}
