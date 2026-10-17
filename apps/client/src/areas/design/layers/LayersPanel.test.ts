import { describe, expect, it, vi } from 'vitest';
import type { LayerNode } from '@hub/protocol';
import { byTestId, elements, props, text } from '../../../ui/test-vnode.js';
import { LayersPanelView } from './LayersPanel.js';
import type { LayerRow } from './model.js';

const node = (id: string, name: string, kind: LayerNode['kind'], extra: Partial<LayerNode> = {}): LayerNode => ({ id, name, kind, children: [], ...extra });
const rows: LayerRow[] = [
  { node: node('root', 'div', 'element'), depth: 0, expandable: true, open: true, selected: false, present: true },
  { node: node('h', 'Title', 'text', { text: 'Hello' }), depth: 1, expandable: false, open: false, selected: true, present: false },
  { node: node('a', 'Filter Panel', 'instance', { component: 'C' }), depth: 1, expandable: true, open: false, selected: false, present: true },
];

function view() {
  const handlers = { onSelect: vi.fn(), onToggle: vi.fn(), onEnter: vi.fn(), onClose: vi.fn() };
  return { els: elements(LayersPanelView({ rows, title: 'Layers', ...handlers })), ...handlers };
}

describe('LayersPanelView', () => {
  it('shows each layer with its name, text preview, selection and absence', () => {
    const { els } = view();
    expect(text(byTestId(els, 'layer-h'))).toContain('Title');
    expect(text(byTestId(els, 'layer-h'))).toContain('Hello');
    expect(props(byTestId(els, 'layer-h'))['aria-selected']).toBe('true');
    expect(String(props(byTestId(els, 'layer-h'))['class'])).toContain('layers-row-absent');
    expect(props(byTestId(els, 'layer-a'))['aria-selected']).toBe('false');
  });
  it('selects, toggles, enters a component and closes', () => {
    const { els, onSelect, onToggle, onEnter, onClose } = view();
    (props(byTestId(els, 'layer-select-a'))['onClick'] as () => void)();
    expect(onSelect).toHaveBeenCalledWith('a');
    (props(byTestId(els, 'layer-toggle-a'))['onClick'] as () => void)();
    expect(onToggle).toHaveBeenCalledWith('a');
    (props(byTestId(els, 'layer-enter-a'))['onClick'] as () => void)();
    expect(onEnter).toHaveBeenCalledWith('a');
    expect(els.some((e) => props(e)['data-testid'] === 'layer-enter-h')).toBe(false);
    expect(els.some((e) => props(e)['data-testid'] === 'layer-toggle-h')).toBe(false);
    (props(byTestId(els, 'layers-close'))['onClick'] as () => void)();
    expect(onClose).toHaveBeenCalled();
  });
});
