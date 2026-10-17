// The canvas component: owns the two paint layers, wires DOM events into the
// controller, and renders the tool toolbar. Source, frames, cache, onSelect and
// debug are read once at mount; the app passes stable values.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { NodeSelection } from '@hub/protocol';
import type { CanvasController, ControllerStats } from './controller.js';
import type { BlobCache } from './cache.js';
import type { FrameStore } from './frames.js';
import type { Camera } from './geom.js';
import type { PointerIn, Tool, WheelIn } from './gestures.js';
import type { Frame } from './layout.js';
import { COLORS } from './painter.js';
import type { LoaderStats } from './loader.js';
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
  onSelect?: (s: NodeSelection | null) => void;
  debug?: boolean;
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

const TOOLS: ReadonlyArray<{ tool: Tool; label: string }> = [
  { tool: 'pan', label: 'Pan' },
  { tool: 'select', label: 'Select' },
];

const TOOLBAR_STYLE =
  'position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;flex-wrap:wrap;justify-content:center;width:max-content;max-width:calc(100% - 24px);gap:8px;padding:6px;background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.2)';
const ERROR_STYLE =
  'position:absolute;left:12px;top:12px;max-width:calc(100% - 24px);padding:8px 12px;background:#fff;border-radius:8px;color:#d93025;font-size:13px';

function buttonStyle(pressed: boolean): string {
  return pressed
    ? 'font:inherit;min-height:44px;padding:6px 10px;border:1px solid #1a73e8;border-radius:6px;background:#e8f0fe;color:#1a73e8;cursor:pointer'
    : 'font:inherit;min-height:44px;padding:6px 10px;border:1px solid #dadce0;border-radius:6px;background:#fff;color:#202124;cursor:pointer';
}

export function CanvasView({ source, cache, frames, onSelect, debug = false }: CanvasViewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const spareRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CanvasController | null>(null);
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
      onError: setError,
    });
    const { controller, loader } = runtime;
    controllerRef.current = controller;

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
      if (debug) delete window.__hubCanvas;
    };
  }, []);

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
      <div style={TOOLBAR_STYLE} onPointerDown={(e) => e.stopPropagation()}>
        {TOOLS.map(({ tool: t, label }) => {
          const on = tool === t;
          return (
            <button
              key={t}
              type="button"
              data-testid={`tool-${t}`}
              aria-pressed={on ? 'true' : 'false'}
              style={buttonStyle(on)}
              onClick={() => chooseTool(t)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
