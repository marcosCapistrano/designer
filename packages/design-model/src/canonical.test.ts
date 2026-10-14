import { expect, test } from 'vitest';
import { canonicalStringify } from './canonical.js';

test('sorts keys recursively', () => {
  expect(canonicalStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(
    '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
  );
});

test('keeps array order', () => {
  expect(canonicalStringify([3, 1])).toBe('[\n  3,\n  1\n]\n');
});

test('omits undefined', () => {
  expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}\n');
});

test('stable across insertion order', () => {
  const forward = { a: 1, b: { x: true, y: [1, 2] }, c: 'z' };
  const backward = { c: 'z', b: { y: [1, 2], x: true }, a: 1 };
  expect(canonicalStringify(forward)).toBe(canonicalStringify(backward));
});

test('sorts keys by code point, not by UTF-16 code unit', () => {
  // U+FF5E is below U+1F600 by code point, but the emoji's high surrogate (0xD83D) is below 0xFF5E.
  expect(canonicalStringify({ '\u{1F600}': 1, '～': 2 })).toBe(
    '{\n  "～": 2,\n  "\u{1F600}": 1\n}\n',
  );
});

test('sorts integer-like keys as strings', () => {
  expect(canonicalStringify({ 2: 'b', 10: 'a' })).toBe('{\n  "10": "a",\n  "2": "b"\n}\n');
});
