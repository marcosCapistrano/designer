import { describe, expect, it, vi } from 'vitest';
import type { DesignSelection } from '@hub/protocol';
import { byTestId, elements, props, text } from '../../../ui/test-vnode.js';
import { InspectorView, SECTIONS, readSections, writeSections } from './Inspector.js';
import type { InspectorViewProps } from './Inspector.js';
import type { InspectorState } from './model.js';

const info: DesignSelection = {
  revision: 'r1',
  selection: { pageId: 'p', device: 'tablet', nodeIds: ['n1'] },
  targets: [
    { id: 'n1', kind: 'element', shared: false, tag: 'h3', text: 'Hi', textNode: 't1', style: { base: {} } },
    { id: 'c1', kind: 'instance', shared: true, component: 'AdListCard', declaredProps: { title: 'x' } },
  ],
};
const base: InspectorState = { info, loading: false, error: null, targetId: 'n1', device: 'tablet', pending: new Set(), errors: {}, epoch: 0 };

function render(state: Partial<InspectorState> = {}, extra: Partial<InspectorViewProps> = {}) {
  const handlers = { onTarget: vi.fn(), onDevice: vi.fn(), onToggleSection: vi.fn(), onLink: vi.fn(), onEdit: vi.fn(), onClose: vi.fn(), onRetry: vi.fn() };
  const els = elements(InspectorView({ state: { ...base, ...state }, sections: {}, linked: { padding: false, margin: false }, locked: false, ...handlers, ...extra }));
  return { ...handlers, els, get: (id: string) => byTestId(els, id) };
}
const click = (v: unknown) => (props(v as never).onClick as () => void)();

describe('InspectorView', () => {
  it('shows one chip per target, the active one pressed, and a Shared badge', () => {
    const v = render();
    expect(props(v.get('inspector-target-n1'))['aria-pressed']).toBe('true');
    expect(text(v.get('inspector-target-n1'))).toContain('h3');
    expect(text(v.get('inspector-target-c1'))).toContain('AdListCard');
    expect(text(v.get('inspector-target-c1'))).toContain('Shared');
    click(v.get('inspector-target-c1'));
    expect(v.onTarget).toHaveBeenCalledWith('c1');
  });

  it('notes that shared edits preview first', () => {
    expect(() => render().get('inspector-shared-note')).toThrow();
    expect(text(render({ targetId: 'c1' }).get('inspector-shared-note'))).toContain('Edits preview before they apply');
  });

  it('sets the device from the segmented control', () => {
    const v = render();
    expect(props(v.get('inspector-device-tablet'))['aria-checked']).toBe('true');
    click(v.get('inspector-device-mobile'));
    expect(v.onDevice).toHaveBeenCalledWith('mobile');
  });

  it('shows the text section for an element with text and props only for an instance', () => {
    const el = render();
    expect(() => el.get('section-text')).not.toThrow();
    expect(() => el.get('section-props')).toThrow();
    const inst = render({ targetId: 'c1' });
    expect(() => inst.get('section-props')).not.toThrow();
    expect(() => inst.get('section-text')).toThrow();
  });

  it('collapses a section, and reports the toggle', () => {
    const v = render({}, { sections: { typography: false } });
    expect(props(v.get('section-typography'))['aria-expanded']).toBe('false');
    expect(() => v.get('typography-font-size-input')).toThrow();
    click(v.get('section-typography'));
    expect(v.onToggleSection).toHaveBeenCalledWith('typography', true);
  });

  it('collapses Any CSS property by default', () => {
    expect(props(render().get('section-raw'))['aria-expanded']).toBe('false');
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
    expect(SECTIONS.map((s) => s.id)).toEqual(['text', 'typography', 'fill', 'spacing', 'size', 'border', 'visibility', 'props', 'raw']);
  });
});
