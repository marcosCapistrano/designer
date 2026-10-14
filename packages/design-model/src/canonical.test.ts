import { expect, test } from 'vitest';
import { canonicalLine, canonicalStringify } from './canonical.js';

test('sorts keys recursively', () => {
  expect(canonicalStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(
    '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
  );
});

test('keeps array order', () => {
  expect(canonicalStringify([3, 1])).toBe('[\n  3,\n  1\n]\n');
});

test('writes sparse array holes as null', () => {
  expect(canonicalStringify([, 1])).toBe('[\n  null,\n  1\n]\n');
  expect(canonicalLine([, 1])).toBe('[null,1]');
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

test('sorts an astral key after U+E000 in either insertion order', () => {
  // By code point U+E000 comes first. Its code unit (0xE000) is above the emoji's high surrogate (0xD83D).
  const expected = '{\n  "": 2,\n  "\u{1F600}": 1\n}\n';
  expect(canonicalStringify({ '\u{1F600}': 1, '': 2 })).toBe(expected);
  expect(canonicalStringify({ '': 2, '\u{1F600}': 1 })).toBe(expected);
});

test('sorts integer-like keys as strings', () => {
  expect(canonicalStringify({ 2: 'b', 10: 'a' })).toBe('{\n  "10": "a",\n  "2": "b"\n}\n');
});

test('canonicalLine sorts keys and writes one line with no whitespace', () => {
  expect(canonicalLine({ b: [1, { d: 'x y', c: null }], a: undefined })).toBe(
    '{"b":[1,{"c":null,"d":"x y"}]}',
  );
});

test('canonicalLine matches canonicalStringify apart from layout', () => {
  const value = { z: { y: [true, 'q'], x: {} }, a: [] };
  const pretty = canonicalStringify(value);
  expect(canonicalLine(value)).toBe(JSON.stringify(JSON.parse(pretty)));
});
