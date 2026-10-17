import { describe, expect, it, vi } from 'vitest';
import { isLiteralColor } from './color.js';
import { ColorField } from './ColorField.js';
import { byTestId, elements, inputEvent, props } from './test-vnode.js';

describe('isLiteralColor', () => {
  it('accepts hex, rgb, hsl and named colors', () => {
    for (const v of ['#fff', '#ffff', '#11223344', '#a1b2c3', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'hsl(10 20% 30%)', 'hsla(10,20%,30%,.4)', 'red', 'RebeccaPurple', 'transparent'])
      expect(isLiteralColor(v)).toBe(true);
  });
  it('rejects tokens, keywords and garbage', () => {
    for (const v of ['var(--c)', 'inherit', 'currentColor', '#ggg', '#12345', 'notacolor', ''])
      expect(isLiteralColor(v)).toBe(false);
  });
});

function setup(value: string) {
  const onCommit = vi.fn();
  const els = elements(ColorField({ value, label: 'Color', onCommit, 'data-testid': 'c' }));
  return { onCommit, get: (id: string) => byTestId(els, id) };
}

describe('ColorField', () => {
  it('previews a literal color in the swatch', () => {
    const s = setup('#ff0000');
    expect(String(props(s.get('c-swatch')).style)).toContain('#ff0000');
  });

  it('shows a neutral swatch and the token name for a var() value', () => {
    const s = setup('var(--color-text)');
    expect(props(s.get('c-swatch')).class).toContain('ui-swatch-neutral');
    expect(props(s.get('c-input')).defaultValue).toBe('var(--color-text)');
  });

  it('commits text on Enter, null when cleared, and nothing when unchanged', () => {
    const s = setup('#ff0000');
    (props(s.get('c-input')).onKeyDown as (e: Event) => void)(inputEvent('#00ff00', 'Enter'));
    (props(s.get('c-input')).onBlur as (e: Event) => void)(inputEvent(''));
    (props(s.get('c-input')).onBlur as (e: Event) => void)(inputEvent('#ff0000'));
    expect(s.onCommit.mock.calls).toEqual([['#00ff00'], [null]]);
  });

  it('commits from the native picker only for six-digit hex values', () => {
    const hex = setup('#ff0000');
    (props(hex.get('c-picker')).onChange as (e: Event) => void)(inputEvent('#123456'));
    expect(hex.onCommit).toHaveBeenCalledWith('#123456');
    const named = setup('red');
    expect(() => named.get('c-picker')).toThrow();
  });
});

describe('ColorField label', () => {
  it('has no <label> wrapping the hidden picker, so tapping the caption never opens it', () => {
    const onCommit = vi.fn();
    const els = elements(ColorField({ value: '#ff0000', label: 'Color', onCommit, 'data-testid': 'c' }));
    expect(els.filter((e) => e.type === 'label')).toEqual([]);
  });
});
