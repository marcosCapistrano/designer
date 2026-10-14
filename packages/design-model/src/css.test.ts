import { describe, expect, test } from 'vitest';
import { validateStyle } from './css.js';

describe('validateStyle', () => {
  test.each([
    ['padding', '8px'],
    ['padding', '8px 12px'],
    ['color', '#fff'],
    ['color', 'var(--color-primary)'],
    ['display', 'flex'],
    ['--brand', 'anything'],
  ])('accepts %s: %s', (prop, value) => {
    expect(validateStyle(prop, value)).toBeNull();
  });

  test('rejects unitless padding', () => {
    const reason = validateStyle('padding', '12');
    expect(reason).not.toBeNull();
    expect(reason).toContain('padding');
  });

  test('rejects bad color', () => {
    expect(validateStyle('color', 'blu')).not.toBeNull();
  });

  test('rejects unknown property', () => {
    const reason = validateStyle('colr', 'red');
    expect(reason).toContain('Unknown CSS property');
    expect(reason).toContain('colr');
  });

  test('rejects camelCase', () => {
    expect(validateStyle('backgroundColor', 'red')).not.toBeNull();
  });

  test('rejects an empty custom property value', () => {
    expect(validateStyle('--brand', '')).not.toBeNull();
  });

  test('accepts var() inside a known property value', () => {
    expect(validateStyle('padding', 'var(--gap) 12px')).toBeNull();
  });

  test('reports malformed values instead of throwing', () => {
    const reason = validateStyle('padding', '12px;}');
    expect(reason).toContain('padding');
  });

  test.each([
    ['padding', '1px}body{color:red'],
    ['padding', '1px;color:red'],
    ['color', 'red</style>'],
    ['--x', 'a</style>'],
    ['--x', 'a\\b'],
    ['padding', '1px\n2px'],
    ['color', 'var(--x)}'],
  ])('rejects a forbidden character in %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toContain('forbidden character');
  });

  test('rejects CSS comment markers in a value', () => {
    expect(validateStyle('padding', '1px /*')).toContain('forbidden character');
    expect(validateStyle('--x', 'a */ b')).toContain('forbidden character');
  });
});
