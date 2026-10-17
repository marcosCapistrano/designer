// The canvas component: owns the two paint layers, wires DOM events into the
// controller, and renders the tool toolbar. Source, frames, framesEditable, cache,
// onSelect, onDoubleTap, onOutside and debug are read once at mount; the app passes stable values. scope and insets follow their props.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { CanvasFrame, HitBox, NodeSelection } from '@hub/protocol';
import type { CanvasController, ControllerStats } from './controller.js';
import type { BlobCache } from './cache.js';
import type { FrameStore } from './frames.js';
import type { Camera, Insets } from './geom.js';
import { FrameMenu } from './FrameMenu.js';
import type { PointerIn, Tool, WheelIn } from './gestures.js';
import type { Frame } from './layout.js';
import { COLORS } from './painter.js';
import { IconButton } from '../ui/IconButton.js';
import { HandIcon, MicIcon, PointerIcon } from '../ui/icons.js';
import './canvas.css';
import type { LoaderStats } from './loader.js';
import type { CanvasRuntime } from './runtime.js';
import { createCanvasRuntime } from './runtime.js';
import type { TileSource } from './source.js';

export interface CanvasViewProps {
  source: TileSource;
  /**
   * Must serve exactly one manifest's tiles and hit maps. Once the manifest loads,
   * the view deletes everything in the cache that the manifest does not reference,
   * so two apps sharing a cache would erase each other's tiles. Give each app its
   * own, with `createIdbCache(name)`.
   */
  cache: BlobCache;
  /** The frame layout to draw the manifest's pages in. */
  frames: FrameStore;
  /**
   * Whether frames can be moved, resized and opened in the frame menu (default true). Preview
   * canvases turn it off: their manifest is a fixed snapshot, so a change there could not render.
   */
  framesEditable?: boolean;
  onSelect?: (s: NodeSelection | null) => void;
  /** Called after every camera change (pans included). */
  onCamera?: (camera: Camera) => void;
  /** Where to start instead of fitting the first page. Read at mount. */
  initialCamera?: Camera;
  /** Screen space covered by floating chrome over the canvas; fits keep frames clear of it. Read at mount. */
  insets?: Insets;
  /** Set on mount to a function that fits every frame into view; cleared on unmount. */
  fitRef?: { current: (() => void) | null };
  /** Set on mount to the canvas's selection and scope controls; cleared on unmount. */
  handleRef?: { current: CanvasHandle | null };
  /** Component mode: the instance path being edited on `pageId`, or null outside it. */
  scope?: { prefix: string; pageId: string } | null;
  /** A double tap, with what it selected. Read at mount. */
  onDoubleTap?: (s: NodeSelection) => void;
  /** In component mode, a tap outside the instance being edited. Read at mount. */
  onOutside?: () => void;
  debug?: boolean;
}

/** What the app drives on the canvas besides its props. */
export interface CanvasHandle {
  selectNodes(pageId: string, nodeIds: string[]): Promise<void>;
  /** Fits one page's frames into the view. */
  fitPage(pageId: string): void;
  /** The selected frame's hit map, or null. */
  selectionBoxes(): readonly HitBox[] | null;
}

/** Test and debug hooks, exposed on `window.__hubCanvas` only when `debug` is set. */
export interface HubCanvasDebug {
  panBy(dx: number, dy: number): void;
  setCamera(c: Camera): void;
  camera(): Camera;
  frames(): readonly Frame[];
  selection(): NodeSelection | null;
  stats(): ControllerStats & { loader: LoaderStats };
  idle(): Promise<void>;
}

declare global {
  interface Window {
    __hubCanvas?: HubCanvasDebug;
  }
}

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; icon: () => JSX.Element }> = [
  { tool: 'pan', label: 'Pan', icon: HandIcon },
  { tool: 'select', label: 'Select', icon: PointerIcon },
];

const ERROR_STYLE =
  'position:absolute;left:12px;top:72px;max-width:calc(100% - 24px);padding:8px 12px;background:var(--surface-2);border:1px solid var(--border);border-left:4px solid var(--danger);border-radius:8px;color:var(--text);font-size:13px';

const MENU_WIDTH = 340;

/** The menu's box: at the tap, moved back inside the canvas, scrolling when it is taller than the canvas. */
function menuPanelStyle(at: { x: number; y: number }, root: HTMLElement | null): string {
  const w = root?.clientWidth ?? 800;
  const h = root?.clientHeight ?? 600;
  const width = Math.min(MENU_WIDTH, w - 16);
  const left = Math.max(8, Math.min(at.x, w - width - 8));
  const top = Math.max(8, Math.min(at.y, h - 120));
  return `position:absolute;left:${left}px;top:${top}px;width:${width}px;max-height:${h - top - 8}px;overflow-y:auto;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);touch-action:pan-y`;
}

export function CanvasView({ source, cache, frames, framesEditable = true, onSelect, onCamera, initialCamera, insets, fitRef, handleRef, scope = null, onDoubleTap, onOutside, debug = false }: CanvasViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const spareRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);
  const [menu, setMenu] = useState<{ frameId: string; x: number; y: number } | null>(null);
  const [tool, setToolState] = useState<Tool>('pan');
  const [error, setError] = useState<string | null>(null);

  const chooseTool = (t: Tool): void => {
    setToolState(t);
    controllerRef.current?.setTool(t);
  };

  useEffect(() => {
    const root = rootRef.current;
    const layers = layersRef.current;
    const baseCanvas = baseRef.current;
    const spareCanvas = spareRef.current;
    const overlayCanvas = overlayRef.current;
    if (!root || !layers || !baseCanvas || !spareCanvas || !overlayCanvas) return;
    const base = baseCanvas.getContext('2d', { alpha: false });
    const spare = spareCanvas.getContext('2d', { alpha: false });
    const overlay = overlayCanvas.getContext('2d');
    if (!base || !spare || !overlay) return;

    const runtime = createCanvasRuntime({
      base,
      baseBack: {
        ctx: spare,
        // Only the shown canvas is composited; the hidden one costs the page nothing.
        present: (shown) => {
          const hidden = shown === base ? spareCanvas : baseCanvas;
          shown.canvas.style.visibility = 'visible';
          hidden.style.visibility = 'hidden';
        },
      },
      overlay,
      // The layers sit in one box, so a zoom preview is a single style write for the compositor.
      setLayerTransform: (t) => {
        layers.style.transform = t === null ? '' : `translate(${t.x}px,${t.y}px) scale(${t.scale})`;
      },
      source,
      frames,
      cache,
      requestFrame: (cb) => requestAnimationFrame(() => cb()),
      now: () => performance.now(),
      onSelect,
      onCamera,
      initialCamera,
      insets,
      onError: setError,
      onFrameMenu: (frameId, p) => setMenu({ frameId, x: p.x, y: p.y }),
      framesEditable,
      onDoubleTap,
      onOutside,
    });
    const { controller, loader } = runtime;
    runtimeRef.current = runtime;
    controllerRef.current = controller;
    if (fitRef) fitRef.current = () => controller.fitAll();
    if (handleRef) handleRef.current = { selectNodes: (pageId, ids) => controller.selectNodes(pageId, ids), selectionBoxes: () => controller.selectionBoxes(), fitPage: (pageId) => controller.fitPage(pageId) };

    const sizeToRoot = (): void => {
      controller.resize(root.clientWidth, root.clientHeight, devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(sizeToRoot);
    observer.observe(root);
    sizeToRoot();

    const onPointer =
      (kind: PointerIn['kind']) =>
      (e: PointerEvent): void => {
        if (kind === 'down') root.setPointerCapture(e.pointerId);
        const rect = root.getBoundingClientRect();
        controller.pointer({
          id: e.pointerId,
          kind,
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          pointerType: e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse',
          button: e.button,
        });
      };
    const onDown = onPointer('down');
    const onMove = onPointer('move');
    const onUp = onPointer('up');
    const onCancel = onPointer('cancel');

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const ev: WheelIn = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      };
      controller.wheel(ev);
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    // A lost capture with no pointer-up would leave a ghost contact in the tracker. The event also
    // follows every normal pointer-up, where the tracker no longer holds the id and ignores it, so
    // this cancels that one pointer rather than resetting a finger that is still down.
    root.addEventListener('lostpointercapture', onCancel);
    root.addEventListener('wheel', onWheel, { passive: false });

    // Pointer-ups are not delivered while the window is unfocused or the tab is hidden.
    const resetGestures = (): void => controller.resetGestures();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') controller.resetGestures();
    };
    window.addEventListener('blur', resetGestures);
    document.addEventListener('visibilitychange', onVisibility);

    if (debug) {
      window.__hubCanvas = {
        panBy: (dx, dy) => controller.panBy(dx, dy),
        setCamera: (c) => controller.setCamera(c),
        camera: () => controller.camera,
        frames: () => controller.frames,
        selection: () => controller.selection,
        stats: () => ({ ...controller.stats(), loader: loader.stats() }),
        idle: () => loader.whenIdle(),
      };
    }

    return () => {
      runtime.dispose();
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('lostpointercapture', onCancel);
      window.removeEventListener('blur', resetGestures);
      document.removeEventListener('visibilitychange', onVisibility);
      root.removeEventListener('wheel', onWheel);
      observer.disconnect();
      controllerRef.current = null;
      if (fitRef) fitRef.current = null;
      if (handleRef) handleRef.current = null;
      runtimeRef.current = null;
      if (debug) delete window.__hubCanvas;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setScope(scope?.prefix ?? '', scope?.pageId ?? null);
  }, [scope?.prefix, scope?.pageId]);

  useEffect(() => {
    if (insets) controllerRef.current?.setInsets(insets);
  }, [insets?.top, insets?.right, insets?.bottom, insets?.left]);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu !== null]);

  const menuFrames: CanvasFrame[] = menu === null ? [] : (controllerRef.current?.canvasLayout ?? []);
  const menuFrame = menu === null ? undefined : menuFrames.find((f) => f.id === menu.frameId);

  return (
    <div
      ref={rootRef}
      data-testid="canvas"
      style={`position:absolute;inset:0;touch-action:none;user-select:none;background:${COLORS.bg}`}
    >
      <div ref={layersRef} style="position:absolute;inset:0;transform-origin:0 0">
        <canvas ref={baseRef} data-testid="canvas-base" style="position:absolute;inset:0;width:100%;height:100%" />
        <canvas
          ref={spareRef}
          data-testid="canvas-base"
          style="position:absolute;inset:0;width:100%;height:100%;visibility:hidden"
        />
        <canvas ref={overlayRef} style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" />
      </div>
      {error !== null && (
        <div data-testid="canvas-error" style={ERROR_STYLE}>
          {error}
        </div>
      )}
      {menu !== null && menuFrame !== undefined && (
        <>
          <div
            data-testid="frame-menu-backdrop"
            style="position:absolute;inset:0"
            onPointerDown={(e) => {
              e.stopPropagation();
              setMenu(null);
            }}
          />
          <div
            data-testid="frame-menu-panel"
            style={menuPanelStyle(menu, rootRef.current)}
            onPointerDown={(e) => e.stopPropagation()}
            // The canvas zooms on wheel; over the menu the wheel scrolls the menu instead.
            onWheel={(e) => e.stopPropagation()}
          >
            <FrameMenu
              key={menuFrame.id}
              frame={menuFrame}
              frames={menuFrames}
              onChange={(next) => {
                runtimeRef.current?.changeFrames(next);
                setMenu(null);
              }}
              onClose={() => setMenu(null)}
            />
          </div>
        </>
      )}
      <div class="canvas-tool-pill" onPointerDown={(e) => e.stopPropagation()}>
        {TOOLS.map(({ tool: t, label, icon: Icon }) => (
          <IconButton key={t} label={label} icon={<Icon />} pressed={tool === t} onClick={() => chooseTool(t)} data-testid={`tool-${t}`} />
        ))}
        <span class="canvas-tool-divider" aria-hidden="true" />
        <IconButton label="Voice coming later" icon={<MicIcon />} disabled data-testid="mic" />
      </div>
    </div>
  );
}
