import { describe, expect, it } from 'vitest';
import { effectiveStyle, inheritedLabel, sideProps, sideValues } from './values.js';

const style = { base: { 'font-size': '16px', color: 'red', padding: '8px 16px' }, tablet: { 'font-size': '14px', 'padding-left': '4px' }, mobile: { color: 'blue' } };

describe('effectiveStyle', () => {
  it('returns the tier’s own value as not inherited', () => {
    expect(effectiveStyle(style, 'tablet', 'font-size')).toEqual({ value: '14px', inherited: null });
    expect(effectiveStyle(style, 'base', 'color')).toEqual({ value: 'red', inherited: null });
  });
  it('inherits tablet from base, and mobile from tablet before base', () => {
    expect(effectiveStyle(style, 'tablet', 'color')).toEqual({ value: 'red', inherited: 'base' });
    expect(effectiveStyle(style, 'mobile', 'font-size')).toEqual({ value: '14px', inherited: 'tablet' });
    expect(effectiveStyle(style, 'mobile', 'color')).toEqual({ value: 'blue', inherited: null });
  });
  it('is empty when no tier sets the property, or there is no style', () => {
    expect(effectiveStyle(style, 'mobile', 'gap')).toEqual({ value: '', inherited: null });
    expect(effectiveStyle(undefined, 'base', 'gap')).toEqual({ value: '', inherited: null });
  });
});

describe('inheritedLabel', () => {
  it('names the tier a value comes from', () => {
    expect(inheritedLabel('base')).toBe('inherits Desktop');
    expect(inheritedLabel('tablet')).toBe('inherits Tablet');
  });
});

describe('side values', () => {
  it('lists the four longhands in top, right, bottom, left order', () => {
    expect(sideProps('padding')).toEqual(['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
    expect(sideProps('margin')).toEqual(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  });
  it('expands a shorthand for display, with longhands of the same or a closer tier winning', () => {
    expect(sideValues(style, 'base', 'padding').map((s) => s.value)).toEqual(['8px', '16px', '8px', '16px']);
    const tablet = sideValues(style, 'tablet', 'padding');
    expect(tablet.map((s) => s.value)).toEqual(['8px', '16px', '8px', '4px']);
    expect(tablet.map((s) => s.inherited)).toEqual(['base', 'base', 'base', null]);
  });
  it('expands one to four shorthand values like CSS does', () => {
    const v = (padding: string) => sideValues({ base: { padding } }, 'base', 'padding').map((s) => s.value);
    expect(v('4px')).toEqual(['4px', '4px', '4px', '4px']);
    expect(v('1px 2px 3px')).toEqual(['1px', '2px', '3px', '2px']);
    expect(v('1px 2px 3px 4px')).toEqual(['1px', '2px', '3px', '4px']);
  });
  it('leaves sides empty when nothing sets them', () => {
    expect(sideValues({ base: {} }, 'base', 'margin').map((s) => s.value)).toEqual(['', '', '', '']);
  });
});
