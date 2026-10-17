import { describe, expect, it, vi } from 'vitest';
import type { DesignTarget, Device } from '@hub/protocol';
import { byTestId, elements, inputEvent, props } from '../../../ui/test-vnode.js';
import { BorderSection, FillSection, PropsSection, RawSection, SizeSection, SpacingSection, TextSection, TypographySection, VisibilitySection } from './sections.js';
import type { SectionProps } from './sections.js';

const h3: DesignTarget = {
  id: 'n1', kind: 'element', shared: false, tag: 'h3', text: 'Title', textNode: 't1',
  style: { base: { 'font-size': '1.25rem', color: '#ff0000', 'padding-top': 'var(--space-4)', display: 'none' }, tablet: { 'font-weight': '600' } },
};

function render(Section: (p: SectionProps) => unknown, device: Device = 'base', target: DesignTarget = h3, extra: Partial<SectionProps> = {}) {
  const onEdit = vi.fn();
  const onLink = vi.fn();
  const p: SectionProps = { target, device, epoch: 0, pending: new Set(), locked: false, linked: { padding: false, margin: false }, onLink, onEdit, ...extra };
  const els = elements(Section(p) as never);
  return { onEdit, onLink, get: (id: string) => byTestId(els, id), els };
}
const click = (v: unknown) => (props(v as never).onClick as () => void)();
const enter = (v: unknown, value: string) => (props(v as never).onKeyDown as (e: Event) => void)(inputEvent(value, 'Enter'));
const blur = (v: unknown, value: string) => (props(v as never).onBlur as (e: Event) => void)(inputEvent(value));

describe('TypographySection', () => {
  it('shows the tier’s font size and steps it on the chosen device', () => {
    const s = render(TypographySection, 'tablet');
    expect(props(s.get('typography-font-size-input')).defaultValue).toBe('1.25rem');
    expect(props(s.get('typography-font-size-input')).placeholder).toBe('inherits Desktop');
    click(s.get('typography-font-size-plus'));
    expect(s.onEdit).toHaveBeenCalledWith('typography:font-size', [{ op: 'setStyle', node: 'n1', device: 'tablet', prop: 'font-size', value: '1.375rem' }]);
  });

  it('shows an own value with no inherited placeholder', () => {
    const s = render(TypographySection, 'base');
    expect(props(s.get('typography-font-size-input')).placeholder).toBeUndefined();
  });

  it('commits a weight from the select, and clears the color with null', () => {
    const s = render(TypographySection, 'tablet');
    expect(props(s.get('typography-font-weight')).value).toBe('600');
    (props(s.get('typography-font-weight')).onChange as (e: Event) => void)(inputEvent('700'));
    blur(s.get('typography-color-input'), '');
    expect(s.onEdit.mock.calls).toEqual([
      ['typography:font-weight', [{ op: 'setStyle', node: 'n1', device: 'tablet', prop: 'font-weight', value: '700' }]],
      ['typography:color', [{ op: 'setStyle', node: 'n1', device: 'tablet', prop: 'color', value: null }]],
    ]);
  });

  it('marks a field busy while its edit is in flight', () => {
    const s = render(TypographySection, 'base', h3, { pending: new Set(['typography:font-size']) });
    expect(props(s.get('typography-font-size-input')).disabled).toBe(true);
    expect(props(s.get('typography-color-input')).disabled).toBeFalsy();
  });
});

describe('SpacingSection', () => {
  it('shows a token value as text with − and + disabled', () => {
    const s = render(SpacingSection);
    expect(props(s.get('spacing-padding-top-input')).defaultValue).toBe('var(--space-4)');
    expect(props(s.get('spacing-padding-top-plus')).disabled).toBe(true);
  });

  it('writes one side when unlinked', () => {
    const s = render(SpacingSection);
    enter(s.get('spacing-padding-left-input'), '12px');
    expect(s.onEdit).toHaveBeenCalledWith('spacing:padding-left', [{ op: 'setStyle', node: 'n1', device: 'base', prop: 'padding-left', value: '12px' }]);
  });

  it('writes all four sides in one edit when linked', () => {
    const s = render(SpacingSection, 'mobile', h3, { linked: { padding: true, margin: false } });
    enter(s.get('spacing-padding-left-input'), '12px');
    expect(s.onEdit).toHaveBeenCalledTimes(1);
    expect(s.onEdit.mock.calls[0]![1]).toEqual(['top', 'right', 'bottom', 'left'].map((side) => ({ op: 'setStyle', node: 'n1', device: 'mobile', prop: `padding-${side}`, value: '12px' })));
  });

  it('toggles the link for a kind', () => {
    const s = render(SpacingSection);
    click(s.get('spacing-margin-link'));
    expect(s.onLink).toHaveBeenCalledWith('margin', true);
  });
});

describe('Fill, Size and Border sections', () => {
  it('edit their properties', () => {
    const fill = render(FillSection);
    enter(fill.get('fill-background-color-input'), '#000000');
    const size = render(SizeSection);
    enter(size.get('size-max-width-input'), '640px');
    const border = render(BorderSection);
    enter(border.get('border-border-radius-input'), '8px');
    expect(fill.onEdit.mock.calls[0]![0]).toBe('fill:background-color');
    expect(size.onEdit.mock.calls[0]![1][0]).toMatchObject({ prop: 'max-width', value: '640px' });
    expect(border.onEdit.mock.calls[0]![1][0]).toMatchObject({ prop: 'border-radius', value: '8px' });
  });
});

describe('VisibilitySection', () => {
  it('shows a hidden element as not visible, and showing it removes the override', () => {
    const s = render(VisibilitySection);
    expect(props(s.get('visibility-visible'))['aria-checked']).toBe('false');
    click(s.get('visibility-visible'));
    expect(s.onEdit).toHaveBeenCalledWith('visibility:display', [{ op: 'setStyle', node: 'n1', device: 'base', prop: 'display', value: null }]);
  });

  it('shows an element hidden by an inherited tier with revert', () => {
    const s = render(VisibilitySection, 'tablet');
    click(s.get('visibility-visible'));
    expect(s.onEdit.mock.calls[0]![1][0]).toMatchObject({ device: 'tablet', prop: 'display', value: 'revert' });
  });

  it('hides a visible element with display none', () => {
    const s = render(VisibilitySection, 'base', { ...h3, style: { base: {} } });
    click(s.get('visibility-visible'));
    expect(s.onEdit.mock.calls[0]![1][0]).toMatchObject({ prop: 'display', value: 'none' });
  });
});

describe('TextSection', () => {
  it('commits text on blur as setText on the text node', () => {
    const s = render(TextSection);
    blur(s.get('text-text'), 'New title');
    expect(s.onEdit).toHaveBeenCalledWith('text:text', [{ op: 'setText', node: 't1', text: 'New title' }]);
  });
  it('commits nothing when unchanged', () => {
    const s = render(TextSection);
    blur(s.get('text-text'), 'Title');
    expect(s.onEdit).not.toHaveBeenCalled();
  });
});

describe('PropsSection', () => {
  it('sets an instance prop', () => {
    const card: DesignTarget = { id: 'i1', kind: 'instance', shared: false, component: 'Card', declaredProps: { title: 'Hi' } };
    const s = render(PropsSection, 'base', card);
    enter(s.get('props-title-input'), 'Hello');
    expect(s.onEdit).toHaveBeenCalledWith('props:title', [{ op: 'setInstanceProp', node: 'i1', prop: 'title', value: 'Hello' }]);
  });
});

describe('RawSection', () => {
  it('sets the typed property on the chosen device', () => {
    const s = render(RawSection, 'mobile');
    const form = s.els.find((e) => e.type === 'form')!;
    (props(form).onSubmit as (e: Event) => void)({
      preventDefault() {},
      currentTarget: { elements: { namedItem: (n: string) => ({ value: n === 'prop' ? ' letter-spacing ' : '0.02em' }) } },
    } as unknown as Event);
    expect(s.onEdit).toHaveBeenCalledWith('raw:letter-spacing', [{ op: 'setStyle', node: 'n1', device: 'mobile', prop: 'letter-spacing', value: '0.02em' }]);
  });
});
