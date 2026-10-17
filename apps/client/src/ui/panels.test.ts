import { describe, expect, it, vi } from 'vitest';
import { SheetView } from './Sheet.js';
import { ModalView } from './Modal.js';
import { MenuView } from './Menu.js';
import { ToastStack } from './ToastStack.js';
import { byTestId, elements, props, text } from './test-vnode.js';

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    expect(SheetView({ open: false, side: 'right', label: 'Inspector', onClose: () => {}, children: 'x' })).toBeNull();
  });
  it('renders a labelled side panel with its width', () => {
    const els = elements(SheetView({ open: true, side: 'right', width: 360, label: 'Inspector', onClose: () => {}, children: 'x', 'data-testid': 's' }));
    const panel = byTestId(els, 's');
    expect(props(panel)['aria-label']).toBe('Inspector');
    expect(String(props(panel).class)).toContain('ui-sheet-right');
    expect(String(props(panel).style)).toContain('360px');
  });
  it('closes from its handle', () => {
    const onClose = vi.fn();
    const els = elements(SheetView({ open: true, side: 'bottom', label: 'Chat', onClose, children: 'x', 'data-testid': 's' }));
    (props(byTestId(els, 's-close')).onClick as () => void)();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Modal', () => {
  it('is a labelled dialog that closes from its backdrop and close button', () => {
    const onClose = vi.fn();
    const els = elements(ModalView({ open: true, title: 'Import pages', onClose, children: 'body', 'data-testid': 'm' }));
    expect(props(byTestId(els, 'm')).role).toBe('dialog');
    expect(text(byTestId(els, 'm'))).toContain('Import pages');
    (props(byTestId(els, 'm-backdrop')).onClick as () => void)();
    (props(byTestId(els, 'm-close')).onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('renders nothing when closed', () => {
    expect(ModalView({ open: false, title: 't', onClose: () => {}, children: 'x' })).toBeNull();
  });
});

describe('Menu', () => {
  it('lists items when open, runs the chosen one and closes', () => {
    const run = vi.fn();
    const setOpen = vi.fn();
    const els = elements(MenuView({ label: 'More', open: true, setOpen, items: [{ label: 'Import pages', run, 'data-testid': 'mi' }, { label: 'Retry', run: () => {}, disabled: true }], 'data-testid': 'menu' }));
    expect(props(byTestId(els, 'menu'))['aria-expanded']).toBe('true');
    (props(byTestId(els, 'mi')).onClick as () => void)();
    expect(run).toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledWith(false);
  });
  it('hides items when closed and opens from its button', () => {
    const setOpen = vi.fn();
    const els = elements(MenuView({ label: 'More', open: false, setOpen, items: [{ label: 'A', run: () => {}, 'data-testid': 'mi' }], 'data-testid': 'menu' }));
    expect(() => byTestId(els, 'mi')).toThrow();
    (props(byTestId(els, 'menu')).onClick as () => void)();
    expect(setOpen).toHaveBeenCalledWith(true);
  });
  it('can show its current choice as text, and marks the checked item', () => {
    const els = elements(MenuView({ label: 'Pages', text: '/ads/grid', open: true, setOpen: vi.fn(), items: [{ label: '/ads', run: () => {}, 'data-testid': 'a' }, { label: '/ads/grid', run: () => {}, checked: true, 'data-testid': 'g' }], 'data-testid': 'menu' }));
    expect(text(byTestId(els, 'menu'))).toContain('/ads/grid');
    expect(String(props(byTestId(els, 'menu')).class)).toContain('ui-menu-text');
    expect(props(byTestId(els, 'g'))['aria-checked']).toBe('true');
    expect(props(byTestId(els, 'g')).role).toBe('menuitemradio');
    expect(props(byTestId(els, 'a'))['aria-checked']).toBe('false');
  });
});

describe('ToastStack', () => {
  it('shows each toast with its kind, a dismiss button on sticky ones, and its action', () => {
    const onDismiss = vi.fn();
    const action = vi.fn();
    const els = elements(ToastStack({ toasts: [{ id: 1, kind: 'ok', text: 'Saved' }, { id: 2, kind: 'error', text: 'Failed', sticky: true, action: { label: 'Details', run: action } }], onDismiss }));
    expect(String(props(byTestId(els, 'toast-1')).class)).toContain('ui-toast-ok');
    expect(props(byTestId(els, 'toast-2')).role).toBe('alert');
    expect(() => byTestId(els, 'toast-1-dismiss')).toThrow();
    (props(byTestId(els, 'toast-2-action')).onClick as () => void)();
    (props(byTestId(els, 'toast-2-dismiss')).onClick as () => void)();
    expect(action).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith(2);
  });
});

describe('ToastStack passive toasts', () => {
  it('lets taps through a toast with no buttons, but not one with an action or a dismiss button', () => {
    const els = elements(ToastStack({ toasts: [{ id: 1, kind: 'ok', text: 'Undone.' }, { id: 2, kind: 'warning', text: 'x', sticky: true }, { id: 3, kind: 'ok', text: 'y', action: { label: 'Details', run: () => {} } }], onDismiss: () => {} }));
    expect(String(props(byTestId(els, 'toast-1')).class)).toContain('ui-toast-passive');
    expect(String(props(byTestId(els, 'toast-2')).class)).not.toContain('ui-toast-passive');
    expect(String(props(byTestId(els, 'toast-3')).class)).not.toContain('ui-toast-passive');
  });
});
