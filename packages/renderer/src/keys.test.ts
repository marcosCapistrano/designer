import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION, tileKey } from './keys.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('tileKey', () => {
  it('matches sha256 of the version prefix plus the concatenation', () => {
    expect(tileKey('<p></p>', 'p{}', 'base', 0.25)).toBe(sha256('r1:<p></p>p{}base0.25'));
  });

  it('RENDER_VERSION is 1', () => {
    expect(RENDER_VERSION).toBe(1);
  });

  it('is pinned to the formula with the current RENDER_VERSION', () => {
    expect(tileKey('a', 'b', 'tablet', 0.5)).toBe(sha256(`r${RENDER_VERSION}:` + 'a' + 'b' + 'tablet' + String(0.5)));
  });

  it('changes when the RENDER_VERSION prefix changes', () => {
    const key = tileKey('a', 'b', 'base', 1);
    expect(key).not.toBe(sha256(`r${RENDER_VERSION + 1}:` + 'a' + 'b' + 'base' + '1'));
    expect(key).not.toBe(sha256(`r${RENDER_VERSION - 1}:` + 'a' + 'b' + 'base' + '1'));
    // The pre-version formula (no prefix) must not collide either.
    expect(key).not.toBe(sha256('a' + 'b' + 'base' + '1'));
  });

  it('differs by device and zoom', () => {
    const base = tileKey('a', 'b', 'base', 1);
    expect(base).not.toBe(tileKey('a', 'b', 'tablet', 1));
    expect(base).not.toBe(tileKey('a', 'b', 'base', 0.5));
  });

  it('is 64 lowercase hex chars', () => {
    expect(tileKey('a', 'b', 'mobile', 0.5)).toMatch(/^[0-9a-f]{64}$/);
  });
});
