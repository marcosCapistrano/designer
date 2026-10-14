// Wires the canvas modules together: camera, gestures, layout, tiles, hit
// testing, selection and the two paint layers. Every state change schedules one
// frame; the frame paints the base layer, the overlay when it changed, and
// requests the tiles the viewport needs.

import { DEVICES, TILE_SIZE } from '@hub/protocol';
import type { Device, HitBox, NodeSelection, RenderManifest, TileLevel } from '@hub/protocol';
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
import { boxSelect, hitTest, toPagePoint } from './hit.js';
import type { Frame } from './layout.js';
import { frameAt, layoutBounds, layoutFrames } from './layout.js';
import type { TileImage, TileWant } from './loader.js';
import { GestureTracker, wheelAction } from './gestures.js';
import type { GestureAction, PointerIn, Tool, WheelIn } from './gestures.js';
import { paintOverlay } from './overlay.js';
import { BasePainter } from './painter.js';
import type { PaintStats } from './painter.js';
import { pickZoom, visibleTiles } from './tiles.js';

export interface ControllerDeps {
  base: CanvasRenderingContext2D;
  overlay: CanvasRenderingContext2D;
  tiles: { get(key: string, x: number, y: number): TileImage | undefined; request(wants: readonly TileWant[]): void };
  hitMaps: { get(hash: string): readonly HitBox[] | undefined; load(hash: string): Promise<readonly HitBox[]> };
  requestFrame: (cb: () => void) => void;
  now: () => number;
  onSelect?: (s: NodeSelection | null) => void;
}

export interface ControllerStats {
  framesPainted: number;
  tilesDrawn: number;
  lastMode: PaintStats['mode'] | null;
}

/** Zoom changes are painted unsmoothed until the camera has been still this long. */
export const SETTLE_MS = 150;
/** Tiles are prefetched this far beyond each viewport edge, as a fraction of the viewport. */
export const PREFETCH_MARGIN = 0.25;

const FIT_PADDING = 40;

interface IndexEntry {
  frame: Frame;
  level: TileLevel;
}

type MarqueeAction = Extract<GestureAction, { type: 'marquee' }>;

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
    for (const level of frame.render?.levels ?? []) {
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
  private devices: ReadonlySet<Device> = new Set(DEVICES);
  private layout: readonly Frame[] = [];
  private index = new Map<string, IndexEntry[]>();

  private cam: Camera = { x: 0, y: 0, scale: 1 };
  private viewSize: Size = { w: 0, h: 0 };
  private dpr = 1;
  private needsFit = false;
  private lastZoom = -Infinity;

  private scheduled = false;
  private overlayDirty = false;
  private selected: NodeSelection | null = null;
  private marquee: Rect | null = null;
  /** Bumped by every tap, box select and relayout; a stale async result is dropped. */
  private selectToken = 0;
  /** Bumped by every setManifest; a hit-map load started under an older manifest must not touch the selection. */
  private manifestGen = 0;

  private framesPainted = 0;
  private tilesDrawn = 0;
  private lastMode: PaintStats['mode'] | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.painter = new BasePainter(deps.base, deps.tiles);
    this.gestures = new GestureTracker(() => this.toolValue);
  }

  setManifest(m: RenderManifest): void {
    if (this.manifest === null) this.needsFit = true;
    this.manifest = m;
    const gen = ++this.manifestGen;
    this.relayout();

    const sel = this.selected;
    if (sel !== null) {
      const frame = this.findFrame(sel.pageId, sel.device);
      const hash = frame ? renderHash(frame) : null;
      if (frame && hash !== null) {
        // Both handlers ignore a load that a later manifest has superseded, so a
        // stale rejection cannot clear a selection that a newer manifest kept.
        void this.deps.hitMaps.load(hash).then(
          () => {
            if (gen !== this.manifestGen) return;
            this.overlayDirty = true;
            this.schedule();
          },
          () => {
            if (gen === this.manifestGen && this.selected === sel) this.select(null);
          },
        );
      } else {
        this.select(null);
      }
    }
    this.schedule();
  }

  resize(w: number, h: number, dpr: number): void {
    // Both layers share the device-pixel size so the overlay lines up with the base.
    for (const ctx of [this.deps.base, this.deps.overlay]) {
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

  setDevices(visible: ReadonlySet<Device>): void {
    this.devices = new Set(visible);
    this.relayout();
    const sel = this.selected;
    if (sel !== null && this.findFrame(sel.pageId, sel.device) === undefined) this.select(null);
    this.painter.invalidate();
    this.schedule();
  }

  setTool(t: Tool): void {
    this.toolValue = t;
  }

  get tool(): Tool {
    return this.toolValue;
  }

  get camera(): Camera {
    return this.cam;
  }

  setCamera(c: Camera): void {
    this.cam = { x: c.x, y: c.y, scale: clampScale(c.scale) };
    this.schedule();
  }

  get frames(): readonly Frame[] {
    return this.layout;
  }

  get selection(): NodeSelection | null {
    return this.selected;
  }

  pointer(ev: PointerIn): void {
    for (const action of this.gestures.handle(ev)) this.apply(action);
  }

  wheel(ev: WheelIn): void {
    this.apply(wheelAction(ev));
  }

  panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.cam = panCamera(this.cam, dx, dy);
    this.schedule();
  }

  zoomAt(x: number, y: number, factor: number): void {
    if (factor === 1) return;
    this.cam = zoomCamera(this.cam, { x, y }, factor);
    this.lastZoom = this.deps.now();
    this.schedule();
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
    this.select(id === null ? null : { pageId: frame.pageId, device: frame.device, nodeIds: [id] });
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
    this.select(nodeIds.length > 0 ? { pageId: frame.pageId, device: frame.device, nodeIds } : null);
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
    const stats = this.painter.paint({
      camera: this.cam,
      viewport: this.viewSize,
      dpr: this.dpr,
      frames: this.layout,
      zoom,
      smoothing,
    });

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

    const area = viewRect(this.cam, this.viewSize);
    this.deps.tiles.request([
      ...visibleTiles(this.layout, area, zoom),
      ...(zoom !== 0.25 ? visibleTiles(this.layout, area, 0.25) : []),
      ...visibleTiles(this.layout, expandRect(area, PREFETCH_MARGIN), zoom),
    ]);

    this.framesPainted++;
    this.tilesDrawn += stats.tilesDrawn;
    this.lastMode = stats.mode;
    if (!smoothing) this.schedule();
  }

  stats(): ControllerStats {
    return { framesPainted: this.framesPainted, tilesDrawn: this.tilesDrawn, lastMode: this.lastMode };
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
    this.layout = this.manifest === null ? [] : layoutFrames(this.manifest, this.devices);
    this.index = buildIndex(this.layout);
    this.overlayDirty = true;
    this.selectToken++;
  }

  private findFrame(pageId: string, device: Device): Frame | undefined {
    return this.layout.find((f) => f.pageId === pageId && f.device === device);
  }

  /** Waits for the first page to have frames, so an empty layout never fits to the origin. */
  private fitFirstPage(m: RenderManifest): void {
    const first = m.pages[0];
    if (first === undefined) return;
    const pageFrames = this.layout.filter((f) => f.pageId === first.pageId);
    if (pageFrames.length === 0) return;
    this.cam = fitRect(layoutBounds(pageFrames), this.viewSize, FIT_PADDING);
    this.needsFit = false;
  }

  private select(s: NodeSelection | null): void {
    this.selected = s;
    this.overlayDirty = true;
    this.deps.onSelect?.(s);
    this.schedule();
  }

  private highlight(): { frame: Frame; boxes: readonly HitBox[] } | null {
    const sel = this.selected;
    if (sel === null) return null;
    const frame = this.findFrame(sel.pageId, sel.device);
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
