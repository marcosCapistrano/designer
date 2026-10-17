import { describe, expect, it, vi } from 'vitest';
import type { DesignSelection } from '@hub/protocol';
import { byTestId, elements, inputEvent, props, text } from '../../../ui/test-vnode.js';
import { InspectorView, SECTIONS, readSections, writeSections } from './Inspector.js';
import type { InspectorViewProps } from './Inspector.js';
import type { InspectorState } from './model.js';

const info: DesignSelection = {
  revision: 'r1',
  selection: { pageId: 'p', device: 'tablet', nodeIds: ['n1'] },
  targets: [
    { id: 'n1', kind: 'element', shared: false, tag: 'h3', name: 'Title', text: 'Hi', textNode: 't1', style: { base: { 'font-size': '20px' } } },
    { id: 'c1', kind: 'instance', shared: true, component: 'C1', name: 'Ad Card', title: 'AdListCard', declaredProps: { title: 'x' }, style: { base: {} } },
    { id: 'b1', kind: 'element', shared: false, tag: 'section', name: 'Filters', style: { base: { 'background-color': '#111' } } },
  ],
};
const base: InspectorState = { info, loading: false, error: null, targetId: 'n1', device: 'tablet', pending: new Set(), errors: {}, epoch: 0 };

function render(state: Partial<InspectorState> = {}, extra: Partial<InspectorViewProps> = {}) {
  const handlers = { onTarget: vi.fn(), onDevice: vi.fn(), onToggleSection: vi.fn(), onLink: vi.fn(), onEdit: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(), onAdd: vi.fn(), onEnterComponent: vi.fn(), onParent: vi.fn() };
  const els = elements(InspectorView({ state: { ...base, ...state }, sections: {}, linked: { padding: false, margin: false }, locked: false, added: new Set(), mode: 'page', path: null, ...handlers, ...extra }));
  return { ...handlers, els, get: (id: string) => byTestId(els, id) };
}
const click = (v: unknown) => (props(v as never).onClick as () => void)();

describe('InspectorView', () => {
  it('shows one chip per target, the active one pressed, and a Shared badge', () => {
    const v = render();
    expect(props(v.get('inspector-target-n1'))['aria-pressed']).toBe('true');
    expect(text(v.get('inspector-target-n1'))).toContain('Title');
    expect(text(v.get('inspector-target-c1'))).toContain('Ad Card');
    expect(text(v.get('inspector-target-c1'))).toContain('Shared');
    click(v.get('inspector-target-c1'));
    expect(v.onTarget).toHaveBeenCalledWith('c1');
  });

  it('notes that shared edits preview first, outside component mode', () => {
    expect(() => render().get('inspector-shared-note')).toThrow();
    expect(text(render({ targetId: 'c1' }).get('inspector-shared-note'))).toContain('Edits preview before they apply');
    expect(() => render({ targetId: 'c1' }, { mode: 'component' }).get('inspector-shared-note')).toThrow();
  });

  it('sets the device from the segmented control', () => {
    const v = render();
    expect(props(v.get('inspector-device-tablet'))['aria-checked']).toBe('true');
    click(v.get('inspector-device-mobile'));
    expect(v.onDevice).toHaveBeenCalledWith('mobile');
  });

  it('instance targets show the component card with props and Edit component', () => {
    const el = render();
    expect(() => el.get('section-text')).not.toThrow();
    expect(() => el.get('section-component')).toThrow();
    const inst = render({ targetId: 'c1' });
    expect(text(inst.get('section-component-body'))).toContain('AdListCard');
    expect(() => inst.get('props-title-input')).not.toThrow();
    expect(() => inst.get('section-text')).toThrow();
    click(inst.get('inspector-edit-component'));
    expect(inst.onEnterComponent).toHaveBeenCalledWith('c1');
  });

  it('a box without text has no Typography', () => {
    expect(() => render().get('section-typography')).not.toThrow();
    expect(() => render({ targetId: 'b1' }).get('section-typography')).toThrow();
  });

  it('an empty section shows only its head', () => {
    const v = render({ targetId: 'b1' });
    expect(() => v.get('section-fill-body')).not.toThrow();
    expect(() => v.get('section-border-body')).toThrow();
    expect(() => v.get('section-border')).not.toThrow();
  });

  it('+ lists unshown fields and adding shows one', () => {
    const v = render({ targetId: 'b1' });
    const add = v.get('section-border-add');
    expect(() => v.get('add-border-border-radius')).not.toThrow();
    expect(() => v.get('add-fill-background-color')).toThrow();
    (props(add).onChange as (e: Event) => void)({ currentTarget: { value: 'border-radius' } } as unknown as Event);
    expect(v.onAdd).toHaveBeenCalledWith('border:border-radius');
    expect(() => render({ targetId: 'b1' }, { added: new Set(['border:border-radius']) }).get('border-border-radius-input')).not.toThrow();
  });

  it('shows the layer name, its kind and the component path', () => {
    const v = render({ targetId: 'b1' }, { path: 'Filter Panel › Verticais' });
    expect(props(v.get('inspector-name')).defaultValue).toBe('Filters');
    expect(text(v.get('inspector-kind'))).toBe('Frame');
    expect(text(v.get('inspector-path'))).toBe('Filter Panel › Verticais');
    expect(text(render().get('inspector-kind'))).toBe('Text');
    expect(text(render({ targetId: 'c1' }).get('inspector-kind'))).toBe('AdListCard');
    expect(() => render().get('inspector-path')).toThrow();
  });

  it('selects the parent layer from the header, when there is one', () => {
    const v = render();
    click(v.get('inspector-parent'));
    expect(v.onParent).toHaveBeenCalled();
    expect(() => render({}, { onParent: undefined }).get('inspector-parent')).toThrow();
  });

  it('renaming commits setName', () => {
    const v = render({ targetId: 'b1' });
    (props(v.get('inspector-name')).onKeyDown as (e: Event) => void)(inputEvent('Filtros', 'Enter'));
    expect(v.onEdit).toHaveBeenCalledWith('name:name', [{ op: 'setName', node: 'b1', name: 'Filtros' }]);
  });

  it('renaming to blank clears the name', () => {
    const v = render({ targetId: 'b1' });
    (props(v.get('inspector-name')).onBlur as (e: Event) => void)(inputEvent('  '));
    expect(v.onEdit).toHaveBeenCalledWith('name:name', [{ op: 'setName', node: 'b1', name: null }]);
  });

  it('collapses a section, and reports the toggle', () => {
    const v = render({}, { sections: { typography: false } });
    expect(props(v.get('section-typography'))['aria-expanded']).toBe('false');
    expect(() => v.get('typography-font-size-input')).toThrow();
    click(v.get('section-typography'));
    expect(v.onToggleSection).toHaveBeenCalledWith('typography', true);
  });

  it('collapses All CSS by default', () => {
    expect(props(render().get('section-raw'))['aria-expanded']).toBe('false');
    expect(text(render().get('section-raw'))).toContain('All CSS');
  });

  it('shows a section error under its section', () => {
    expect(text(render({ errors: { spacing: 'Invalid value' } }).get('section-spacing-error'))).toBe('Invalid value');
  });

  it('shows a load error with Retry, and a loading state', () => {
    const v = render({ info: null, error: 'Selection could not be read.' });
    expect(text(v.get('inspector-error'))).toContain('Selection could not be read.');
    click(v.get('inspector-retry'));
    expect(v.onRetry).toHaveBeenCalled();
    expect(() => render({ info: null, loading: true }).get('inspector-loading')).not.toThrow();
  });

  it('closes from its button', () => {
    const v = render();
    click(v.get('inspector-close'));
    expect(v.onClose).toHaveBeenCalled();
  });
});

describe('section open state', () => {
  it('reads and writes the stored map, tolerating junk', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readSections(storage)).toEqual({});
    writeSections(storage, { spacing: false });
    expect(store.get('hub.inspector.sections')).toBe('{"spacing":false}');
    expect(readSections(storage)).toEqual({ spacing: false });
    store.set('hub.inspector.sections', 'not json');
    expect(readSections(storage)).toEqual({});
  });
  it('lists the sections in the spec’s order', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(['text', 'typography', 'fill', 'spacing', 'size', 'border', 'visibility', 'component', 'raw']);
  });
});
