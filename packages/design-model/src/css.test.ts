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
});
