import { describe, expect, it } from 'vitest';
import { boxOf, prefixOf, scopedId } from './scope.js';

describe('scopedId', () => {
  it('outside component mode, a hit inside an instance is the instance', () => {
    expect(scopedId('a/x/y', '')).toBe('a');
    expect(scopedId('s1', '')).toBe('s1');
  });
  it('inside an instance, a hit is one level deeper', () => {
    expect(scopedId('a/x', 'a')).toBe('a/x');
    expect(scopedId('a/b/y', 'a')).toBe('a/b');
    expect(scopedId('a/b/y', 'a/b')).toBe('a/b/y');
  });
  it('a hit outside the scope is null', () => {
    expect(scopedId('c/x', 'a')).toBeNull();
    expect(scopedId('ab/x', 'a')).toBeNull();
    expect(scopedId('a', 'a')).toBeNull();
  });
});

describe('prefixOf', () => {
  it('is the innermost instance, or empty', () => {
    expect(prefixOf([])).toBe('');
    expect(prefixOf(['a', 'a/b'])).toBe('a/b');
  });
});

describe('boxOf', () => {
  const map = [
    { nodeId: 'p', x: 0, y: 0, w: 500, h: 500 },
    { nodeId: 'a/r', x: 10, y: 20, w: 100, h: 50 },
    { nodeId: 'a/s', x: 50, y: 60, w: 100, h: 50 },
    { nodeId: 'ab/r', x: 400, y: 400, w: 10, h: 10 },
  ];
  it('is a node own box, else the union of the boxes under it', () => {
    expect(boxOf(map, 'p')).toEqual({ nodeId: 'p', x: 0, y: 0, w: 500, h: 500 });
    expect(boxOf(map, 'a')).toEqual({ nodeId: 'a', x: 10, y: 20, w: 140, h: 90 });
    expect(boxOf(map, 'zz')).toBeNull();
  });
});
