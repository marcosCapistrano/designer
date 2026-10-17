// The Design tab: a full-screen canvas with floating layers — top bar, inspector, chat, preview banner, toasts.
// DesignArea owns the state and server calls; DesignAreaView lays the layers out and is tested without a DOM.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DesignEditResult, DesignProposal, ImportResponse, NodeSelection } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import { ServerFrameStore } from '../../net/frame-store.js';
import type { WsClient } from '../../net/ws.js';
import type { BlobCache } from '../../canvas/cache.js';
import { createNullCache } from '../../canvas/cache.js';
import type { TileSource } from '../../canvas/source.js';
import { CanvasView, readOnlyFrameStore } from '../../canvas/index.js';
import type { FrameStore } from '../../canvas/index.js';
import { formatRoute } from '../../shell/route.js';
import type { Area } from '../../shell/route.js';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { SheetView } from '../../ui/Sheet.js';
import { ToastStack } from '../../ui/ToastStack.js';
import { useToasts } from '../../ui/toasts.js';
import { createValueStore } from '../../ui/value-store.js';
import type { ValueStore } from '../../ui/value-store.js';
import type { Camera } from '../../canvas/geom.js';
import type { ToastInput, ToastItem } from '../../ui/toasts.js';
import { ChatSheet } from './ChatSheet.js';
import { ImportSheet } from './ImportSheet.js';
import { Inspector } from './inspector/Inspector.js';
import { importOutcome } from './import-result.js';
import type { Details } from './import-result.js';
import { CANVAS_INSETS, INSPECTOR_WIDTH, panelLayout } from './layout.js';
import { PreviewBanner } from './PreviewBanner.js';
import { proposalSource } from './preview-source.js';
import { resultToast } from './result-toast.js';
import type { ResultOrigin } from './result-toast.js';
import { TopBar } from './TopBar.js';
import './design.css';

export interface DesignAreaViewProps {
  app: string;
  api: ApiClient;
  ws: WsClient;
  live: TileSource;
  cache: BlobCache;
  /** A cache for previews, so a proposal's manifest never collects the live tiles. */
  previewCache: BlobCache;
  frames: FrameStore;
  previewFrames: FrameStore;
  revision: string | null;
  proposal: DesignProposal | null;
  previewSource: TileSource | null;
  selection: NodeSelection | null;
  inspectorOpen: boolean;
  selectionLabel: string | null;
  width: number;
  zoom: ValueStore<number>;
  /** The live canvas's last camera, so a remounted canvas (live ↔ preview) starts where the user was. */
  camera: Camera | null;
  busy: boolean;
  building: boolean;
  chatBusy: boolean;
  /** An inspector edit is in flight. */
  inspectorBusy: boolean;
  toasts: readonly ToastItem[];
  details: Details | null;
  importOpen: boolean;
  fitRef: { current: (() => void) | null };
  onSelect(selection: NodeSelection | null): void;
  /** An edit result from chat (the inspector reports through onInspectorResult). */
  onResult(result: DesignEditResult): void;
  onInspectorResult(result: DesignEditResult): void;
  onApply(): void;
  onCancel(): void;
  onUndo(): void;
  onRedo(): void;
  onFit(): void;
  onCamera(camera: Camera): void;
  onArea(area: Area): void;
  onImportOpen(open: boolean): void;
  onImported(out: ImportResponse): void;
  onRetried(warnings: string[]): void;
  onError(message: string): void;
  onDismissToast(id: number): void;
  onDetails(details: Details | null): void;
  onCloseInspector(): void;
  onInspectorBusy(busy: boolean): void;
  onSelectionLabel(label: string | null): void;
  onChatBusy(busy: boolean): void;
  onSampleBusy(busy: boolean): void;
  onPreviewFocus(): void;
}

function inspector(p: DesignAreaViewProps, locked: boolean, side: 'right' | 'bottom'): JSX.Element {
  return (
    <SheetView open side={side} width={side === 'right' ? INSPECTOR_WIDTH : undefined} maxHeight="55vh" label="Inspector" onClose={p.onCloseInspector} data-testid="inspector-sheet">
      <Inspector app={p.app} api={p.api} selection={p.selection!} revision={p.revision} disabled={locked} onResult={p.onInspectorResult} onClose={p.onCloseInspector} onLabel={p.onSelectionLabel} onPending={p.onInspectorBusy} />
    </SheetView>
  );
}

export function DesignAreaView(p: DesignAreaViewProps): JSX.Element {
  const previewing = p.proposal !== null;
  const showPreview = previewing && p.previewSource !== null;
  // Edits wait while Build runs, while another design action or a chat turn is in flight, and while a preview
  // awaits a decision. Undo and redo also wait for the inspector's own edits.
  const locked = p.busy || p.building || p.chatBusy || previewing;
  const history = !!p.revision && !locked && !p.inspectorBusy;
  const layout = panelLayout(p.width, p.inspectorOpen && p.selection !== null);
  return (
    <div class="design-area" data-testid="design-area">
      <div class="design-canvas">
        <CanvasView
          key={showPreview ? `preview:${p.proposal!.id}` : 'live'}
          source={showPreview ? p.previewSource! : p.live}
          cache={showPreview ? p.previewCache : p.cache}
          frames={showPreview ? p.previewFrames : p.frames}
          framesEditable={!showPreview}
          onSelect={showPreview ? undefined : p.onSelect}
          onCamera={p.onCamera}
          initialCamera={p.camera ?? undefined}
          insets={CANVAS_INSETS}
          fitRef={p.fitRef}
        />
      </div>
      {!p.revision && !previewing && (
        <div class="design-empty" data-testid="design-empty">
          <div class="design-empty-card">
            <p>Import pages to start designing.</p>
            <Button kind="primary" onClick={() => p.onImportOpen(true)} disabled={p.building} data-testid="design-empty-import">Import pages</Button>
          </div>
        </div>
      )}
      <TopBar
        app={p.app}
        area="design"
        onArea={p.onArea}
        canUndo={history}
        canRedo={history}
        onUndo={p.onUndo}
        onRedo={p.onRedo}
        zoom={p.zoom}
        onFit={p.onFit}
        menu={[
          { label: 'Import pages', run: () => p.onImportOpen(true), disabled: p.building, 'data-testid': 'menu-import' },
          { label: 'Sample preview', run: () => p.onImportOpen(true), disabled: p.building, 'data-testid': 'menu-samples' },
        ]}
      />
      {p.building && <p class="design-building" role="status" data-testid="design-building">Wait for Build to finish before importing or editing.</p>}
      {previewing && <PreviewBanner proposal={p.proposal!} busy={p.busy} onApply={p.onApply} onCancel={p.onCancel} />}
      {/* Inspector and chat keep one place each in this column, so opening the inspector or rotating the tablet
          never remounts them (and loses a draft or a device choice). Wide: a right column; narrow: stacked at the
          bottom, inspector above chat, so neither covers the other. */}
      <div class={layout.inspector === 'right' ? 'design-side design-side-docked' : layout.inspector === 'bottom' ? 'design-side design-side-stacked' : 'design-side'}>
        {layout.inspector !== 'none' && inspector(p, locked, layout.inspector)}
        <ChatSheet app={p.app} api={p.api} ws={p.ws} selection={p.selection} selectionLabel={p.selectionLabel} disabled={locked} docked={layout.chatDocked}
          onResult={p.onResult} onBusy={p.onChatBusy} onPreview={p.onPreviewFocus} />
      </div>
      <ToastStack toasts={p.toasts} onDismiss={p.onDismissToast} />
      <ImportSheet open={p.importOpen} onClose={() => p.onImportOpen(false)} app={p.app} api={p.api} source={p.live} disabled={p.building || p.busy}
        onImported={p.onImported} onRetried={p.onRetried} onError={p.onError} onSampleBusy={p.onSampleBusy} />
      {/* After the import sheet, so details opened from it show on top. */}
      <Modal open={p.details !== null} title={p.details?.title ?? ''} onClose={() => p.onDetails(null)} data-testid="details">
        <ul class="design-details">{p.details?.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </Modal>
    </div>
  );
}

export interface DesignAreaProps { app: string; api: ApiClient; ws: WsClient; source: TileSource; cache: BlobCache }

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export function DesignArea({ app, api, ws, source, cache }: DesignAreaProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const toasts = useToasts();
  const [revision, setRevision] = useState<string | null>(null);
  const [selection, setSelection] = useState<NodeSelection | null>(null);
  const [hiddenFor, setHiddenFor] = useState<NodeSelection | null>(null);
  const [selectionLabel, setSelectionLabel] = useState<string | null>(null);
  const [proposal, setProposal] = useState<DesignProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [inspectorBusy, setInspectorBusy] = useState(false);
  const zoom = useMemo(() => createValueStore(100), []);
  const cameraRef = useRef<Camera | null>(null);
  const [width, setWidth] = useState(1440);
  const [importOpen, setImportOpen] = useState(false);
  const [details, setDetails] = useState<Details | null>(null);

  const frames = useMemo(() => new ServerFrameStore(app, api), [app, api]);
  const previewFrames = useMemo(() => readOnlyFrameStore(frames), [frames]);
  const previewCache = useMemo(() => createNullCache(), []);
  const previewSource = useMemo(() => (proposal?.manifest ? proposalSource(proposal.manifest, source) : null), [proposal, source]);

  const push = useCallback((t: ToastInput) => toasts.push(t), [toasts]);
  const fail = useCallback((message: string) => push({ kind: 'error', text: message, sticky: true }), [push]);

  useEffect(() => {
    let active = true;
    void api.designSummary(app).then((s) => { if (active) setRevision((r) => r ?? s.revision); }).catch(() => {});
    return () => { active = false; };
  }, [app, api]);
  useEffect(() => {
    let active = true;
    const off = ws.on((m) => { if (m.type === 'build.task' && m.app === app) setBuilding(m.running); });
    void api.buildState(app).then((s) => { if (active) setBuilding(s.running); }).catch(() => {});
    return () => { active = false; off(); };
  }, [app, api, ws]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(root.clientWidth));
    observer.observe(root);
    setWidth(root.clientWidth);
    return () => observer.disconnect();
  }, []);

  const onResult = useCallback((result: DesignEditResult, origin: ResultOrigin) => {
    const toast = resultToast(result, origin);
    if (toast) push(toast);
    if (result.mode === 'preview') { setProposal(result.proposal); return; }
    setProposal(null);
    setRevision(result.revision);
  }, [push]);

  const act = useCallback(async (task: () => Promise<void>, failure: string) => {
    setBusy(true);
    try { await task(); } catch (error) { fail(errorText(error, failure)); } finally { setBusy(false); }
  }, [fail]);

  const history = (action: 'undo' | 'redo') => {
    if (!revision) return;
    void act(async () => onResult(await api.designHistory(app, revision, action), action), action === 'undo' ? 'Undo failed.' : 'Redo failed.');
  };

  const onImported = useCallback((out: ImportResponse) => {
    for (const o of importOutcome(out)) {
      const more = o.details;
      push({ ...o.toast, ...(more ? { action: { label: 'Details', run: () => setDetails(more) } } : {}) });
    }
    if (out.ok) { setRevision(out.revision); setProposal(null); setSelection(null); }
  }, [push]);

  return (
    <div ref={rootRef} class="design-root">
      <DesignAreaView
        app={app} api={api} ws={ws} live={source} cache={cache} previewCache={previewCache} frames={frames} previewFrames={previewFrames}
        revision={revision} proposal={proposal} previewSource={previewSource}
        selection={selection} inspectorOpen={selection !== null && selection !== hiddenFor} selectionLabel={selectionLabel}
        width={width} zoom={zoom} camera={cameraRef.current} busy={busy || sampleBusy} building={building} chatBusy={chatBusy} inspectorBusy={inspectorBusy}
        toasts={toasts.items} details={details} importOpen={importOpen} fitRef={fitRef}
        onSelect={setSelection}
        onResult={(r) => onResult(r, 'chat')}
        onInspectorResult={(r) => onResult(r, 'inspector')}
        onApply={() => proposal && void act(async () => onResult(await api.applyDesign(app, proposal.id), 'apply'), 'Apply failed.')}
        onCancel={() => proposal && void act(async () => { await api.cancelDesign(app, proposal.id); setProposal(null); }, 'Cancel failed.')}
        onUndo={() => history('undo')}
        onRedo={() => history('redo')}
        onFit={() => fitRef.current?.()}
        onCamera={(camera) => { cameraRef.current = camera; zoom.set(Math.round(camera.scale * 100)); }}
        onArea={(area) => { location.hash = formatRoute({ name: 'app', app, area }); }}
        onImportOpen={setImportOpen}
        onImported={onImported}
        onRetried={(warnings) => push(warnings.length ? { kind: 'warning', text: warnings.join(' '), sticky: true } : { kind: 'ok', text: 'Preview updated.' })}
        onError={fail}
        onDismissToast={toasts.dismiss}
        onDetails={setDetails}
        onCloseInspector={() => setHiddenFor(selection)}
        onInspectorBusy={setInspectorBusy}
        onSelectionLabel={setSelectionLabel}
        onChatBusy={setChatBusy}
        onSampleBusy={setSampleBusy}
        onPreviewFocus={() => document.getElementById('preview-banner')?.focus()}
      />
    </div>
  );
}
