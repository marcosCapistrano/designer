import { describe, expect, it } from 'vitest';
import type { DesignTarget } from '@hub/protocol';
import { FIELDS, hasValue, shownFields, textBearing } from './fields.js';

const box: DesignTarget = { id: 'n1', kind: 'element', shared: false, tag: 'section', style: { base: { 'background-color': '#111', padding: '8px' }, tablet: { width: '100%' } } };

describe('fields', () => {
  it('lists each section’s properties', () => {
    expect(FIELDS.typography.map((f) => f.prop)).toEqual(['font-size', 'font-weight', 'line-height', 'color']);
    expect(FIELDS.spacing.map((f) => f.prop)).toEqual(['padding', 'margin', 'gap']);
  });
  it('a property has a value when the tier sets or inherits it; sides count their shorthand', () => {
    expect(hasValue(box, 'base', 'background-color')).toBe(true);
    expect(hasValue(box, 'mobile', 'background-color')).toBe(true);
    expect(hasValue(box, 'base', 'width')).toBe(false);
    expect(hasValue(box, 'tablet', 'width')).toBe(true);
    expect(hasValue(box, 'base', 'padding')).toBe(true);
    expect(hasValue(box, 'base', 'margin')).toBe(false);
    expect(hasValue({ ...box, style: { base: { 'margin-left': '4px' } } }, 'base', 'margin')).toBe(true);
  });
  it('only fields with values show, plus the ones added', () => {
    expect(shownFields('fill', box, 'base', new Set())).toEqual(['background-color']);
    expect(shownFields('border', box, 'base', new Set())).toEqual([]);
    expect(shownFields('border', box, 'base', new Set(['border:border-radius']))).toEqual(['border-radius']);
    expect(shownFields('size', box, 'tablet', new Set())).toEqual(['width']);
  });
  it('text-bearing targets are the ones with their own text', () => {
    expect(textBearing(box)).toBe(false);
    expect(textBearing({ ...box, textNode: 't1', text: 'Hi' })).toBe(true);
  });
});
