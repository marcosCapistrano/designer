import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FrameSize } from '@hub/protocol';
import { RENDER_VERSION, tileKey } from './keys.js';

const S1440: FrameSize = { width: 1440, viewportHeight: 900 };
const S834: FrameSize = { width: 834, viewportHeight: 1194 };
const S390: FrameSize = { width: 390, viewportHeight: 844 };
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('tileKey', () => {
  it('matches sha256 of the version prefix plus the concatenation', () => {
    expect(tileKey('<p></p>', 'p{}', S1440, 0.25)).toBe(sha256('r2:<p></p>p{}1440x9000.25'));
  });

  it('RENDER_VERSION is 2', () => {
    expect(RENDER_VERSION).toBe(2);
  });

  it('is pinned to the formula with the current RENDER_VERSION', () => {
    expect(tileKey('a', 'b', S834, 0.5)).toBe(sha256(`r${RENDER_VERSION}:` + 'a' + 'b' + '834x1194' + String(0.5)));
  });

  it('changes when the RENDER_VERSION prefix changes', () => {
    const key = tileKey('a', 'b', S1440, 1);
    expect(key).not.toBe(sha256(`r${RENDER_VERSION + 1}:` + 'a' + 'b' + '1440x900' + '1'));
    expect(key).not.toBe(sha256(`r${RENDER_VERSION - 1}:` + 'a' + 'b' + '1440x900' + '1'));
    // The pre-version formula (no prefix) must not collide either.
    expect(key).not.toBe(sha256('a' + 'b' + '1440x900' + '1'));
  });

  it('differs by width, viewport height and zoom, and is equal for equal sizes', () => {
    const base = tileKey('a', 'b', S1440, 1);
    expect(base).not.toBe(tileKey('a', 'b', { width: 1600, viewportHeight: 900 }, 1));
    expect(base).not.toBe(tileKey('a', 'b', { width: 1440, viewportHeight: 1000 }, 1));
    expect(tileKey('a', 'b', { width: 1600, viewportHeight: 900 }, 1)).not.toBe(
      tileKey('a', 'b', { width: 1600, viewportHeight: 1000 }, 1),
    );
    expect(base).not.toBe(tileKey('a', 'b', S1440, 0.5));
    expect(base).toBe(tileKey('a', 'b', { width: 1440, viewportHeight: 900 }, 1));
  });

  it('is 64 lowercase hex chars', () => {
    expect(tileKey('a', 'b', S390, 0.5)).toMatch(/^[0-9a-f]{64}$/);
  });
});
