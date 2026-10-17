import { describe, expect, it, vi } from 'vitest';
import type { DesignProposal, NodeSelection } from '@hub/protocol';
import { CanvasView } from '../../canvas/index.js';
import { Modal } from '../../ui/Modal.js';
import { Menu } from '../../ui/Menu.js';
import { byTestId, byType, elements, props, text } from '../../ui/test-vnode.js';
import { ChatSheet } from './ChatSheet.js';
import { DesignAreaView } from './DesignArea.js';
import type { DesignAreaViewProps } from './DesignArea.js';
import { ImportFormView, importRequest } from './ImportSheet.js';
import { ImportSheet } from './ImportSheet.js';
import { Inspector } from './inspector/Inspector.js';
import { PreviewBanner } from './PreviewBanner.js';
import { TopBar } from './TopBar.js';

const SHALLOW = new Set<unknown>([CanvasView, Inspector, ChatSheet, ImportSheet, Menu, Modal]);
const live = { manifest: async () => ({ version: 2 as const, pages: [] }), tile: async () => new Blob(), hitMap: async () => [], subscribe: () => () => {} };
const previewSource = { ...live };
const selection: NodeSelection = { pageId: 'p', device: 'base', nodeIds: ['n1'] };
const proposal: DesignProposal = { id: 'prop1', revision: 'r1', descriptions: ['/ads › AdListCard › color → red'], manifest: { version: 2, pages: [] }, warnings: ['Shared component'] };

function render(extra: Partial<DesignAreaViewProps> = {}) {
  const h = {
    onSelect: vi.fn(), onResult: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onFit: vi.fn(), onZoom: vi.fn(),
    onArea: vi.fn(), onImportOpen: vi.fn(), onImported: vi.fn(), onRetried: vi.fn(), onDismissToast: vi.fn(), onDetails: vi.fn(),
    onCloseInspector: vi.fn(), onSelectionLabel: vi.fn(), onChatBusy: vi.fn(), onSampleBusy: vi.fn(), onPreviewFocus: vi.fn(), onError: vi.fn(),
  };
  const p: DesignAreaViewProps = {
    app: 'adhunters-v7', api: {} as never, ws: {} as never, live, cache: {} as never, previewCache: {} as never, frames: {} as never, previewFrames: {} as never,
    revision: 'r1', proposal: null, previewSource: null, selection: null, inspectorOpen: false, selectionLabel: null,
    width: 1440, zoom: 25, busy: false, building: false, chatBusy: false, toasts: [], details: null, importOpen: false, fitRef: { current: null },
    ...h, ...extra,
  };
  const els = elements(DesignAreaView(p), [], SHALLOW);
  return { ...h, els, get: (id: string) => byTestId(els, id) };
}

describe('DesignAreaView canvas', () => {
  it('shows the live design, editable, with the persistent tile cache', () => {
    const v = render();
    const canvas = props(byType(v.els, CanvasView));
    expect(canvas.source).toBe(live);
    expect(canvas.framesEditable).toBe(true);
    expect(canvas.onSelect).toBe(v.onSelect);
  });

  it('shows a proposal on the main canvas, read-only, with the preview cache and a banner', () => {
    const v = render({ proposal, previewSource });
    const canvas = byType(v.els, CanvasView);
    expect(props(canvas).source).toBe(previewSource);
    expect(props(canvas).framesEditable).toBe(false);
    expect(props(canvas).cache).not.toBe(props(render().els.find((e) => e.type === CanvasView)!).cache);
    expect(String(canvas.key)).toContain('prop1');
    expect(text(v.get('preview-banner'))).toContain('/ads › AdListCard › color → red');
  });

  it('locks the inspector and chat while a proposal waits for a decision', () => {
    const v = render({ proposal, previewSource, selection, inspectorOpen: true });
    expect(props(byType(v.els, Inspector)).disabled).toBe(true);
    expect(props(byType(v.els, ChatSheet)).disabled).toBe(true);
    const free = render({ selection, inspectorOpen: true });
    expect(props(byType(free.els, Inspector)).disabled).toBe(false);
    expect(props(byType(free.els, ChatSheet)).disabled).toBe(false);
  });
});

describe('DesignAreaView panels', () => {
  it('docks the inspector right and chat under it on a wide screen', () => {
    const v = render({ selection, inspectorOpen: true, width: 1440 });
    expect(String(props(v.get('inspector-sheet')).class)).toContain('ui-sheet-right');
    expect(props(byType(v.els, ChatSheet)).docked).toBe(true);
  });

  it('uses a bottom sheet below 900 px and keeps chat as a full-width bar', () => {
    const v = render({ selection, inspectorOpen: true, width: 834 });
    expect(String(props(v.get('inspector-sheet')).class)).toContain('ui-sheet-bottom');
    expect(props(byType(v.els, ChatSheet)).docked).toBe(false);
  });

  it('has no inspector without a selection', () => {
    expect(() => render().get('inspector-sheet')).toThrow();
  });
});

describe('DesignAreaView status', () => {
  it('shows an empty state with Import when nothing is imported', () => {
    const v = render({ revision: null });
    expect(text(v.get('design-empty'))).toContain('Import pages to start designing');
    (props(v.get('design-empty-import')).onClick as () => void)();
    expect(v.onImportOpen).toHaveBeenCalledWith(true);
    expect(() => render().get('design-empty')).toThrow();
  });

  it('shows toasts and a details modal', () => {
    const v = render({ toasts: [{ id: 1, kind: 'ok', text: 'Imported 3 pages' }], details: { title: 'Routes not imported', items: ['/x — boom'] } });
    expect(text(v.get('toast-1'))).toBe('Imported 3 pages');
    const modal = props(v.get('details'));
    expect(modal.open).toBe(true);
    expect(modal.title).toBe('Routes not imported');
    expect(text(modal.children as never)).toContain('/x — boom');
    (modal.onClose as () => void)();
    expect(v.onDetails).toHaveBeenCalledWith(null);
  });

  it('says to wait for Build while it runs', () => {
    expect(text(render({ building: true }).get('design-building'))).toContain('Wait for Build to finish');
  });
});

describe('TopBar', () => {
  const bar = (extra = {}) => {
    const h = { onArea: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onFit: vi.fn() };
    const els = elements(TopBar({ app: 'adhunters-v7', area: 'design', canUndo: true, canRedo: false, zoom: 37, menu: [], ...h, ...extra }), [], SHALLOW);
    return { ...h, get: (id: string) => byTestId(els, id) };
  };
  it('links back to all apps and names the app', () => {
    const b = bar();
    expect(props(b.get('topbar-back')).href).toBe('#/');
    expect(text(b.get('topbar-title'))).toBe('adhunters-v7');
  });
  it('switches area, undoes, and fits from the zoom readout', () => {
    const b = bar();
    (props(b.get('topbar-area-build')).onClick as () => void)();
    (props(b.get('topbar-undo')).onClick as () => void)();
    (props(b.get('topbar-fit')).onClick as () => void)();
    expect(b.onArea).toHaveBeenCalledWith('build');
    expect(b.onUndo).toHaveBeenCalled();
    expect(b.onFit).toHaveBeenCalled();
    expect(text(b.get('topbar-fit'))).toBe('37%');
    expect(props(b.get('topbar-redo')).disabled).toBe(true);
  });
});

describe('PreviewBanner', () => {
  it('lists the changes and warnings and applies or cancels', () => {
    const onApply = vi.fn(); const onCancel = vi.fn();
    const els = elements(PreviewBanner({ proposal, busy: false, onApply, onCancel }));
    expect(text(byTestId(els, 'preview-banner'))).toContain('Shared component');
    (props(byTestId(els, 'preview-apply')).onClick as () => void)();
    (props(byTestId(els, 'preview-cancel')).onClick as () => void)();
    expect(onApply).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('import form', () => {
  it('builds the Next and React requests as before', () => {
    expect(importRequest('next', '', 'src/App.tsx', '/')).toEqual({ mode: 'next' });
    expect(importRequest('next', ' src/app ', '', '')).toEqual({ mode: 'next', appDir: 'src/app' });
    expect(importRequest('react', '', ' src/App.tsx ', ' / ')).toEqual({ mode: 'react', entries: [{ route: '/', file: 'src/App.tsx' }] });
  });
  it('shows the app directory for Next and entry fields for React', () => {
    const h = { onMode: vi.fn(), onAppDir: vi.fn(), onFile: vi.fn(), onRoute: vi.fn(), onImport: vi.fn(), onRetry: vi.fn() };
    const next = elements(ImportFormView({ mode: 'next', appDir: '', file: '', route: '', busy: false, disabled: false, ...h }));
    expect(() => byTestId(next, 'import-appdir')).not.toThrow();
    expect(() => byTestId(next, 'import-file')).toThrow();
    const react = elements(ImportFormView({ mode: 'react', appDir: '', file: 'a', route: '/', busy: false, disabled: false, ...h }));
    expect(() => byTestId(react, 'import-file')).not.toThrow();
    (props(byTestId(react, 'import-retry')).onClick as () => void)();
    expect(h.onRetry).toHaveBeenCalled();
  });
});
