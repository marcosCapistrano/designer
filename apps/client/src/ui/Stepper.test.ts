import { describe, expect, it, vi } from 'vitest';
import { formatLength, parseLength, stepFor, stepValue } from './length.js';
import { Stepper } from './Stepper.js';
import { byTestId, elements, inputEvent, props } from './test-vnode.js';

describe('length values', () => {
  it('parses numbers with the units the inspector steps', () => {
    expect(parseLength('16px')).toEqual({ number: 16, unit: 'px' });
    expect(parseLength('1.25rem')).toEqual({ number: 1.25, unit: 'rem' });
    expect(parseLength('-4px')).toEqual({ number: -4, unit: 'px' });
    expect(parseLength('.5em')).toEqual({ number: 0.5, unit: 'em' });
    expect(parseLength('50%')).toEqual({ number: 50, unit: '%' });
    expect(parseLength('100vh')).toEqual({ number: 100, unit: 'vh' });
  });

  it('does not parse values it cannot step', () => {
    for (const v of ['auto', 'calc(100% - 8px)', 'var(--space-4)', '16', '', '1px 2px']) expect(parseLength(v)).toBeNull();
  });

  it('steps by 1 for px, %, vh, vw and 0.125 for rem and em', () => {
    expect(stepFor('px')).toBe(1);
    expect(stepFor('%')).toBe(1);
    expect(stepFor('vw')).toBe(1);
    expect(stepFor('rem')).toBe(0.125);
    expect(stepFor('em')).toBe(0.125);
  });

  it('steps a value keeping its unit, and leaves unparsable values alone', () => {
    expect(stepValue('16px', 1)).toBe('17px');
    expect(stepValue('1.25rem', -1)).toBe('1.125rem');
    expect(stepValue('0.1rem', 1)).toBe('0.225rem');
    expect(stepValue('auto', 1)).toBe('auto');
  });

  it('formats without float noise', () => {
    expect(formatLength(0.1 + 0.2, 'rem')).toBe('0.3rem');
  });
});

function setup(value: string, extra: Record<string, unknown> = {}) {
  const onCommit = vi.fn();
  const els = elements(Stepper({ value, label: 'Font size', onCommit, 'data-testid': 'fs', ...extra }));
  return { onCommit, els, get: (id: string) => byTestId(els, id) };
}

describe('Stepper', () => {
  it('commits the stepped value from + and −', () => {
    const s = setup('16px');
    (props(s.get('fs-plus')).onClick as () => void)();
    (props(s.get('fs-minus')).onClick as () => void)();
    expect(s.onCommit.mock.calls).toEqual([['17px'], ['15px']]);
  });

  it('disables + and − for a value it cannot step, and keeps it editable as text', () => {
    const s = setup('var(--space-4)');
    expect(props(s.get('fs-plus')).disabled).toBe(true);
    expect(props(s.get('fs-minus')).disabled).toBe(true);
    expect(props(s.get('fs-input')).defaultValue).toBe('var(--space-4)');
    expect(props(s.get('fs-input')).disabled).toBeFalsy();
  });

  it('commits typed text on Enter and blur, and null when cleared', () => {
    const s = setup('16px');
    (props(s.get('fs-input')).onKeyDown as (e: Event) => void)(inputEvent('20px', 'Enter'));
    (props(s.get('fs-input')).onBlur as (e: Event) => void)(inputEvent('  '));
    expect(s.onCommit.mock.calls).toEqual([['20px'], [null]]);
  });

  it('does not commit an unchanged value on blur', () => {
    const s = setup('16px');
    (props(s.get('fs-input')).onBlur as (e: Event) => void)(inputEvent('16px'));
    expect(s.onCommit).not.toHaveBeenCalled();
  });

  it('shows a placeholder for an inherited value', () => {
    const s = setup('', { placeholder: 'inherits Desktop' });
    expect(props(s.get('fs-input')).placeholder).toBe('inherits Desktop');
  });
});

describe('Stepper label', () => {
  it('has no <label> wrapping its buttons, so tapping the caption never steps the value', () => {
    const s = setup('16px');
    expect(s.els.filter((e) => e.type === 'label')).toEqual([]);
    expect(props(s.get('fs')).role).toBe('group');
    expect(props(s.get('fs'))['aria-label']).toBe('Font size');
  });
});

describe('Stepper commits once', () => {
  it('does not commit the same typed value again when the field blurs after Enter', () => {
    const s = setup('16px');
    const input = props(s.get('fs-input'));
    const target = { value: '20px' };
    const ev = (key?: string) => ({ currentTarget: target, key, preventDefault() {} }) as unknown as Event;
    (input.onKeyDown as (e: Event) => void)(ev('Enter'));
    (input.onBlur as (e: Event) => void)(ev());
    expect(s.onCommit.mock.calls).toEqual([['20px']]);
  });
  it('commits again when the user types a different value after Enter', () => {
    const s = setup('16px');
    const input = props(s.get('fs-input'));
    const target = { value: '20px' };
    const ev = (key?: string) => ({ currentTarget: target, key, preventDefault() {} }) as unknown as Event;
    (input.onKeyDown as (e: Event) => void)(ev('Enter'));
    target.value = '24px';
    (input.onBlur as (e: Event) => void)(ev());
    expect(s.onCommit.mock.calls).toEqual([['20px'], ['24px']]);
  });
});
