// Wires the canvas modules together: camera, gestures, layout, tiles, hit
// testing, selection and the two paint layers. Every state change schedules one
// frame; the frame paints the base layer, the overlay when it changed, and
// requests the tiles the viewport needs.

import { TILE_SIZE } from '@hub/protocol';
import type { CanvasFrame, HitBox, NodeSelection, PageRender, RenderManifest, TileLevel } from '@hub/protocol';
import {
  clampScale,
  expandRect,
  fitRect,
  intersectRect,
  normalizeRect,
  panBy as panCamera,
  screenToWorld,
  snapCamera,
  viewRect,
  zoomAt as zoomCamera,
} from './geom.js';
import type { Camera, Point, Rect, Size } from './geom.js';
import { dragTo, hitHandle, settleFrame } from './frame-drag.js';
import type { FrameDrag } from './frame-drag.js';
import { boxSelect, hitTest, toPagePoint } from './hit.js';
import type { Frame } from './layout.js';
import { frameAt, layoutBounds, layoutFrames } from './layout.js';
import type { TileImage, TileWant } from './loader.js';
import { GestureTracker, TAP_SLOP, wheelAction } from './gestures.js';
import type { GestureAction, PointerIn, Tool, WheelIn } from './gestures.js';
import { paintOverlay } from './overlay.js';
import { BasePainter } from './painter.js';
import type { BackBuffer, PaintInput, PaintStats } from './painter.js';
import { pickZoom, shownRender, visibleTiles } from './tiles.js';

export interface ControllerDeps {
  base: CanvasRenderingContext2D;
  /** A second base canvas for ping-pong blits (see BasePainter); without it a pan blits the canvas onto itself. */
  baseBack?: BackBuffer;
  overlay: CanvasRenderingContext2D;
  /**
   * Shows the painted base and overlay layers moved and scaled, or as painted for null. With it,
   * a zoom gesture scales the last painted image on the compositor and repaints once the camera
   * settles, instead of repainting every frame; without it every frame repaints.
   */
  setLayerTransform?: (t: LayerTransform | null) => void;
  tiles: { get(key: string, x: number, y: number): TileImage | undefined; request(wants: readonly TileWant[]): void };
  hitMaps: { get(hash: string): readonly HitBox[] | undefined; load(hash: string): Promise<readonly HitBox[]> };
  requestFrame: (cb: () => void) => void;
  now: () => number;
  onSelect?: (s: NodeSelection | null) => void;
  /** Called after every camera change: pans, zooms, fits and explicit cameras. */
  onCamera?: (camera: Camera) => void;
  /** A frame drag was released with the frame changed: the whole layout, to save. */
  onFramesChange?: (frames: CanvasFrame[]) => void;
  /** A tap (not a drag) on a frame's label band: the frame and the tap's screen point, to open its menu at. */
  onFrameMenu?: (frameId: string, screen: Point) => void;
  /** Whether frames can be moved, resized or opened in the menu (default true). Off, handles are neither drawn nor hit. */
  framesEditable?: boolean;
}

/** Where the painted layers are shown: translate by (x, y) CSS px, then scale about the layer origin. */
export interface LayerTransform {
  x: number;
  y: number;
  scale: number;
}

export interface ControllerStats {
  /** Frames the controller ran: each either painted the base layer or, in 'preview', moved it. */
  framesPainted: number;
  tilesDrawn: number;
  lastMode: PaintStats['mode'] | 'preview' | null;
  /** Frames that moved the painted layers with a transform instead of repainting them. */
  previewFrames: number;
}

/** Zoom changes are painted unsmoothed until the camera has been still this long. */
export const SETTLE_MS = 150;
/**
 * The painted image stands in for a zoom gesture only within this scale ratio (one tile level
 * either way); a larger change repaints so the preview never gets too coarse or leaves too much
 * of the viewport uncovered.
 */
export const PREVIEW_MIN_RATIO = 0.5;
export const PREVIEW_MAX_RATIO = 2;
/** Tiles are prefetched this far beyond each viewport edge, as a fraction of the viewport. */
export const PREFETCH_MARGIN = 0.25;

const FIT_PADDING = 40;

interface IndexEntry {
  frame: Frame;
  level: TileLevel;
}

type MarqueeAction = Extract<GestureAction, { type: 'marquee' }>;

/** What is selected: nodes of one frame's render. Reported to onSelect as a NodeSelection. */
interface FrameSelection {
  frameId: string;
  nodeIds: string[];
}

/** The hash of the frame's render when it has tiles to draw, else null. */
function renderHash(f: Frame): string | null {
  const r = f.render;
  return r !== null && r.levels.length > 0 ? r.hash : null;
}

/** The frame that overlaps `r` with the largest positive area, or null. */
function largestOverlap(frames: readonly Frame[], r: Rect): Frame | null {
  let best: Frame | null = null;
  let bestArea = 0;
  for (const f of frames) {
    const i = intersectRect(r, f);
    if (i !== null && i.w * i.h > bestArea) {
      best = f;
      bestArea = i.w * i.h;
    }
  }
  return best;
}

/** Tile key to every (frame, level) that uses it, so a loaded tile can be repainted in place. */
function buildIndex(frames: readonly Frame[]): Map<string, IndexEntry[]> {
  const index = new Map<string, IndexEntry[]>();
  for (const frame of frames) {
    for (const level of shownRender(frame)?.levels ?? []) {
      const entry: IndexEntry = { frame, level };
      const list = index.get(level.key);
      if (list) list.push(entry);
      else index.set(level.key, [entry]);
    }
  }
  return index;
}

export class CanvasController {
  private readonly deps: ControllerDeps;
  private readonly painter: BasePainter;
  private readonly gestures: GestureTracker;

  private toolValue: Tool = 'pan';
  private manifest: RenderManifest | null = null;
  private canvasFrames: readonly CanvasFrame[] = [];
  private layout: readonly Frame[] = [];
  /** Frame id to the last render that frame was laid out with, shown while its size is rendering. */
  private lastRenders = new Map<string, PageRender>();
  private index = new Map<string, IndexEntry[]>();

  private cam: Camera = { x: 0, y: 0, scale: 1 };
  private viewSize: Size = { w: 0, h: 0 };
  private dpr = 1;
  private needsFit = false;
  /** An explicit camera was set, so the first manifest must not fit over it. */
  private cameraSet = false;
  private lastZoom = -Infinity;

  private scheduled = false;
  private overlayDirty = false;
  private selected: FrameSelection | null = null;
  private marquee: Rect | null = null;
  /** A move or resize of a frame by its handle; its pointer never reaches the gesture tracker. */
  private drag: FrameDrag | null = null;
  /** Bumped by every tap, box select and relayout; a stale async result is dropped. */
  private selectToken = 0;
  /** Bumped by every setManifest and setFrames; a hit-map load started under an older layout must not touch the selection. */
  private layoutGen = 0;

  private framesPainted = 0;
  private tilesDrawn = 0;
  private lastMode: ControllerStats['lastMode'] = null;
  private previewFrames = 0;
  /** The layers currently carry a transform that the next real paint must clear. */
  private previewing = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.painter = new BasePainter(deps.base, deps.tiles, deps.baseBack);
    this.gestures = new GestureTracker(() => this.toolValue);
  }

  setManifest(m: RenderManifest): void {
    if (this.manifest === null && !this.cameraSet) this.needsFit = true;
    this.manifest = m;
    this.relayoutKeepingSelection();
  }

  /** Lays the canvas out from these frames (the whole layout). */
  setFrames(frames: readonly CanvasFrame[]): void {
    // A layout from outside wins over a drag in progress, whose frame may be gone.
    this.drag = null;
    this.canvasFrames = frames.map((f) => ({ ...f }));
    this.relayoutKeepingSelection();
  }

  resize(w: number, h: number, dpr: number): void {
    // Every layer shares the device-pixel size so the overlay lines up with the base.
    const layers = [this.deps.base, this.deps.overlay];
    if (this.deps.baseBack) layers.push(this.deps.baseBack.ctx);
    for (const ctx of layers) {
      ctx.canvas.width = Math.round(w * dpr);
      ctx.canvas.height = Math.round(h * dpr);
    }
    this.viewSize = { w, h };
    this.dpr = dpr;
    // Assigning canvas.width clears the bitmap even at the same size, so the
    // painter's blit-from-previous-image state is no longer valid.
    this.painter.invalidate();
    this.overlayDirty = true;
    this.schedule();
  }

  setTool(t: Tool): void {
    this.toolValue = t;
  }

  get tool(): Tool {
    return this.toolValue;
  }

  /** Forgets in-progress gestures whose pointer-ups were lost (window blur, tab hidden). */
  resetGestures(): void {
    this.cancelDrag();
    for (const action of this.gestures.reset()) this.apply(action);
  }

  get camera(): Camera {
    return this.cam;
  }

  setCamera(c: Camera): void {
    this.cam = { x: c.x, y: c.y, scale: clampScale(c.scale) };
    // An explicit camera wins over the deferred first-page fit, whichever came first.
    this.needsFit = false;
    this.cameraSet = true;
    this.cameraChanged();
  }

  /** Fits every frame into the view. Does nothing while there are no frames. */
  fitAll(): void {
    if (this.layout.length === 0 || this.viewSize.w === 0) return;
    this.cam = fitRect(layoutBounds(this.layout), this.viewSize, FIT_PADDING);
    this.needsFit = false;
    this.cameraSet = true;
    this.cameraChanged();
  }

  /** The frame layout as the canvas holds it, mid-drag changes included. */
  get canvasLayout(): CanvasFrame[] {
    return this.canvasFrames.map((f) => ({ ...f }));
  }

  get frames(): readonly Frame[] {
    return this.layout;
  }

  get selection(): NodeSelection | null {
    return this.reported(this.selected);
  }

  pointer(ev: PointerIn): void {
    if (this.frameDragStep(ev)) return;
    for (const action of this.gestures.handle(ev)) this.apply(action);
  }

  wheel(ev: WheelIn): void {
    this.apply(wheelAction(ev));
  }

  panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.cam = panCamera(this.cam, dx, dy);
    this.cameraChanged();
  }

  zoomAt(x: number, y: number, factor: number): void {
    if (factor === 1) return;
    this.cam = zoomCamera(this.cam, { x, y }, factor);
    this.lastZoom = this.deps.now();
    this.cameraChanged();
  }

  /** `x`, `y` are screen CSS px. */
  async tap(x: number, y: number): Promise<void> {
    const token = ++this.selectToken;
    const world = screenToWorld(this.cam, { x, y });
    const frame = frameAt(this.layout, world);
    const hash = frame ? renderHash(frame) : null;
    if (!frame || hash === null) {
      this.select(null);
      return;
    }
    const map = await this.hitMapOf(hash);
    if (token !== this.selectToken) return;
    if (map === null) {
      this.select(null);
      return;
    }
    const id = hitTest(map, toPagePoint(frame, world));
    this.select(id === null ? null : { frameId: frame.frameId, nodeIds: [id] });
  }

  /** `a` and `b` are screen CSS px corners. */
  async selectBox(a: Point, b: Point): Promise<void> {
    const token = ++this.selectToken;
    const wa = screenToWorld(this.cam, a);
    const rect = normalizeRect(wa, screenToWorld(this.cam, b));
    const frame = frameAt(this.layout, wa) ?? largestOverlap(this.layout, rect);
    const hash = frame ? renderHash(frame) : null;
    const clipped = frame ? intersectRect(rect, frame) : null;
    if (!frame || hash === null || clipped === null) {
      this.select(null);
      return;
    }
    const map = await this.hitMapOf(hash);
    if (token !== this.selectToken) return;
    if (map === null) {
      this.select(null);
      return;
    }
    const pageRect = { x: clipped.x - frame.x, y: clipped.y - frame.y, w: clipped.w, h: clipped.h };
    const nodeIds = boxSelect(map, pageRect);
    this.select(nodeIds.length > 0 ? { frameId: frame.frameId, nodeIds } : null);
  }

  tileLoaded(key: string, x: number, y: number): void {
    const entries = this.index.get(key);
    if (entries === undefined) return;
    for (const { frame, level } of entries) {
      const size = TILE_SIZE / level.zoom;
      this.painter.invalidateWorld({
        x: frame.x + (x * TILE_SIZE) / level.zoom,
        y: frame.y + (y * TILE_SIZE) / level.zoom,
        w: size,
        h: size,
      });
    }
    this.schedule();
  }

  /** The scheduled paint callback. */
  frame(): void {
    const manifest = this.manifest;
    if (manifest === null || this.viewSize.w === 0) return;

    if (this.needsFit) this.fitFirstPage(manifest);

    const zoom = pickZoom(this.cam.scale, this.dpr);
    const smoothing = this.deps.now() - this.lastZoom >= SETTLE_MS;
    const input: PaintInput = {
      camera: this.cam,
      viewport: this.viewSize,
      dpr: this.dpr,
      frames: this.layout,
      zoom,
      smoothing,
      readout: this.drag?.moved ? { frameId: this.drag.frameId, kind: this.drag.kind } : null,
      handles: this.deps.framesEditable !== false,
    };
    // While zooming, the last painted image is scaled on the compositor; the repaint comes at settle.
    const preview = smoothing ? null : this.previewOf(input);
    let stats: PaintStats;
    if (preview !== null) {
      this.deps.setLayerTransform?.(preview);
      this.previewing = true;
      this.previewFrames++;
      stats = { mode: 'none', blit: false, regions: 0, tilesDrawn: 0, missing: 0 };
    } else {
      stats = this.painter.paint(input);
      if (this.previewing) {
        this.deps.setLayerTransform?.(null);
        this.previewing = false;
      }
    }

    const overlayShown = this.selected !== null || this.marquee !== null;
    if (this.overlayDirty || (stats.mode !== 'none' && overlayShown)) {
      paintOverlay(this.deps.overlay, {
        camera: snapCamera(this.cam, this.dpr),
        dpr: this.dpr,
        selection: this.highlight(),
        marquee: this.marquee,
      });
      this.overlayDirty = false;
    }

    // Priority order: the loader keeps only the first maxImages ids, so what is on
    // screen comes first, then the coarse stand-ins, then the prefetch margin.
    const area = viewRect(this.cam, this.viewSize);
    this.deps.tiles.request([
      ...visibleTiles(this.layout, area, zoom),
      ...(zoom !== 0.25 ? visibleTiles(this.layout, area, 0.25) : []),
      ...visibleTiles(this.layout, expandRect(area, PREFETCH_MARGIN), zoom),
    ]);

    this.framesPainted++;
    this.tilesDrawn += stats.tilesDrawn;
    this.lastMode = preview !== null ? 'preview' : stats.mode;
    if (!smoothing) this.schedule();
  }

  stats(): ControllerStats {
    return {
      framesPainted: this.framesPainted,
      tilesDrawn: this.tilesDrawn,
      lastMode: this.lastMode,
      previewFrames: this.previewFrames,
    };
  }

  /**
   * The transform that shows the last painted image at the current camera, or null when this frame
   * must repaint: no transform sink, the overlay needs repainting at the current camera, the image
   * cannot stand in, or the scale moved past the preview range.
   */
  private previewOf(input: PaintInput): LayerTransform | null {
    if (!this.deps.setLayerTransform || this.overlayDirty) return null;
    const painted = this.painter.previewOf(input);
    if (painted === null) return null;
    const ratio = this.cam.scale / painted.scale;
    if (ratio < PREVIEW_MIN_RATIO || ratio > PREVIEW_MAX_RATIO) return null;
    return {
      x: (painted.x - this.cam.x) * this.cam.scale,
      y: (painted.y - this.cam.y) * this.cam.scale,
      scale: ratio,
    };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.requestFrame(() => {
      this.scheduled = false;
      this.frame();
    });
  }

  /** Recomputes frames and the tile index. Pending taps are invalidated since their frames may be gone. */
  private relayout(): void {
    this.layout = this.manifest === null ? [] : layoutFrames(this.canvasFrames, this.manifest, this.lastRenders);
    const last = new Map<string, PageRender>();
    for (const f of this.layout) {
      const r = f.render ?? f.stale;
      if (r !== null) last.set(f.frameId, r);
    }
    this.lastRenders = last;
    this.index = buildIndex(this.layout);
    this.overlayDirty = true;
    this.selectToken++;
  }

  /**
   * Relayout, then keep the selection if its frame still has a render (reloading that render's hit
   * map, which may be new), else clear it.
   */
  private relayoutKeepingSelection(): void {
    const gen = ++this.layoutGen;
    const reportedBefore = this.reported(this.selected);
    this.relayout();

    const sel = this.selected;
    if (sel !== null) {
      const frame = this.findFrame(sel.frameId);
      const hash = frame ? renderHash(frame) : null;
      if (frame && hash !== null) {
        // A resize across a tier boundary changes which styles an edit of the selection applies to.
        const now = this.reported(sel);
        if (now !== null && (now.device !== reportedBefore?.device || now.pageId !== reportedBefore.pageId)) {
          this.deps.onSelect?.(now);
        }
        // Both handlers ignore a load that a later layout has superseded, so a
        // stale rejection cannot clear a selection that a newer layout kept.
        void this.deps.hitMaps.load(hash).then(
          () => {
            if (gen !== this.layoutGen) return;
            this.overlayDirty = true;
            this.schedule();
          },
          () => {
            if (gen === this.layoutGen && this.selected === sel) this.select(null);
          },
        );
      } else {
        this.select(null);
      }
    }
    this.schedule();
  }

  private findFrame(frameId: string): Frame | undefined {
    return this.layout.find((f) => f.frameId === frameId);
  }

  /** The selection as the app sees it: the frame's page and style tier. */
  private reported(sel: FrameSelection | null): NodeSelection | null {
    if (sel === null) return null;
    const frame = this.findFrame(sel.frameId);
    return frame ? { pageId: frame.pageId, device: frame.device, nodeIds: sel.nodeIds } : null;
  }

  /** Waits for the first page to have frames, so an empty layout never fits to the origin. */
  private fitFirstPage(m: RenderManifest): void {
    const first = m.pages[0];
    if (first === undefined) return;
    const pageFrames = this.layout.filter((f) => f.pageId === first.pageId);
    if (pageFrames.length === 0) return;
    this.cam = fitRect(layoutBounds(pageFrames), this.viewSize, FIT_PADDING);
    this.needsFit = false;
    this.deps.onCamera?.(this.cam);
  }

  private cameraChanged(): void {
    this.deps.onCamera?.(this.cam);
    this.schedule();
  }

  private select(s: FrameSelection | null): void {
    this.selected = s;
    this.overlayDirty = true;
    this.deps.onSelect?.(this.reported(s));
    this.schedule();
  }

  private highlight(): { frame: Frame; boxes: readonly HitBox[] } | null {
    const sel = this.selected;
    if (sel === null) return null;
    const frame = this.findFrame(sel.frameId);
    const hash = frame ? renderHash(frame) : null;
    if (!frame || hash === null) return null;
    const map = this.deps.hitMaps.get(hash);
    const ids = new Set(sel.nodeIds);
    return { frame, boxes: map ? map.filter((b) => ids.has(b.nodeId)) : [] };
  }

  /** Memory first, then a load. A failed load is null, which callers treat as no selection. */
  private async hitMapOf(hash: string): Promise<readonly HitBox[] | null> {
    try {
      return this.deps.hitMaps.get(hash) ?? (await this.deps.hitMaps.load(hash));
    } catch {
      return null;
    }
  }

  private apply(a: GestureAction): void {
    switch (a.type) {
      case 'pan':
        this.panBy(a.dx, a.dy);
        return;
      case 'zoom':
        this.zoomAt(a.x, a.y, a.factor);
        return;
      case 'tap':
        void this.tap(a.x, a.y);
        return;
      case 'marquee':
        this.marqueeStep(a);
        return;
    }
  }

  /**
   * Feeds a pointer event to a frame drag: starts one on a primary press on a handle (any tool,
   * any pointer type) unless another pointer is already in a gesture, and while one runs takes
   * every pointer event. Returns whether the event was taken.
   */
  private frameDragStep(ev: PointerIn): boolean {
    const d = this.drag;
    if (d !== null) {
      if (ev.id !== d.pointerId) return true;
      if (ev.kind === 'move') {
        const next = dragTo(d, ev, this.cam.scale, TAP_SLOP);
        if (next !== null) this.replaceFrame(next);
        return true;
      }
      if (ev.kind === 'up') {
        this.drag = null;
        // A release without movement is a tap on the handle, which moves nothing.
        if (d.moved) this.settleDrag(d);
        else {
          this.schedule();
          if (d.kind === 'move') this.deps.onFrameMenu?.(d.frameId, { x: ev.x, y: ev.y });
        }
        return true;
      }
      // A cancel, or a down for this pointer whose up was lost.
      this.cancelDrag();
      if (ev.kind === 'cancel') return true;
    }
    if (ev.kind !== 'down' || ev.button !== 0 || this.deps.framesEditable === false) return false;
    if (this.gestures.holds(ev.id)) this.resetGestures();
    if (this.gestures.active) return false;
    const hit = hitHandle(this.layout, screenToWorld(this.cam, ev), this.cam.scale);
    const origin = hit ? this.canvasFrames.find((f) => f.id === hit.frameId) : undefined;
    if (!hit || !origin) return false;
    this.drag = { pointerId: ev.id, frameId: hit.frameId, kind: hit.kind, start: { x: ev.x, y: ev.y }, origin, moved: false };
    return true;
  }

  private settleDrag(d: FrameDrag): void {
    const current = this.canvasFrames.find((f) => f.id === d.frameId);
    if (current === undefined) return;
    const settled = settleFrame(current);
    this.replaceFrame(settled);
    const o = d.origin;
    if (settled.x !== o.x || settled.y !== o.y || settled.width !== o.width || settled.viewportHeight !== o.viewportHeight) {
      this.deps.onFramesChange?.(this.canvasFrames.map((f) => ({ ...f })));
    }
  }

  /** Puts a dragged frame back as it was before the drag. */
  private cancelDrag(): void {
    const d = this.drag;
    if (d === null) return;
    this.drag = null;
    if (d.moved) this.replaceFrame(d.origin);
    else this.schedule();
  }

  private replaceFrame(next: CanvasFrame): void {
    this.canvasFrames = this.canvasFrames.map((f) => (f.id === next.id ? next : f));
    this.relayoutKeepingSelection();
  }

  private marqueeStep(a: MarqueeAction): void {
    const p0 = { x: a.x0, y: a.y0 };
    const p1 = { x: a.x1, y: a.y1 };
    if (a.phase === 'move') {
      this.marquee = normalizeRect(p0, p1);
    } else {
      this.marquee = null;
      if (a.phase === 'end') void this.selectBox(p0, p1);
    }
    this.overlayDirty = true;
    this.schedule();
  }
}
