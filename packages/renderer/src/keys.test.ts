import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tileKey } from './keys.js';

describe('tileKey', () => {
  it('matches sha256 of the concatenation', () => {
    expect(tileKey('<p></p>', 'p{}', 'base', 0.25)).toBe(
      createHash('sha256').update('<p></p>p{}base0.25').digest('hex'),
    );
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
