import { describe, expect, test } from 'vitest';
import { validateAttrName } from './util.js';

describe('validateAttrName', () => {
  test('accepts a lowercase name with dashes', () => {
    expect(validateAttrName('aria-label')).toBeNull();
  });

  test('rejects an on-attribute', () => {
    expect(validateAttrName('onclick')).toBe('Attribute "onclick" is not allowed');
  });

  test('rejects a reserved attribute', () => {
    expect(validateAttrName('class')).toBe('Attribute "class" is not allowed');
  });

  test.each([5, undefined, null, ['title'], { toString: () => 'title' }])(
    'rejects the non-string name %j with a message, not a TypeError',
    (name) => {
      expect(validateAttrName(name as unknown as string)).toBe('Attribute name must be a string');
    },
  );
});
