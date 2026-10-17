// Base layer of the canvas: frames, their tiles and their labels, painted into a
// 2D context. Between paints the previous image is blitted by the camera delta
// and only the exposed strips and invalidated world rects are repainted.
//
// A canvas drawn onto itself costs the browser a full snapshot copy on top of the
// blit, which dominates a pan frame at tablet resolution. With a second canvas
// (`BackBuffer`) the blit goes from the shown canvas into the hidden one, and the
// hidden one is then shown, so no canvas is ever drawn onto itself.

import { DEVICE_LABEL, ZOOMS } from '@hub/protocol';
import type { Zoom } from '@hub/protocol';
import { rectsIntersect, snapCamera, worldToDevice } from './geom.js';
import type { Camera, Rect, Size } from './geom.js';
import { HANDLE_PX, LABEL_BAND_PX, LABEL_MIN_SCALE, readoutText } from './frame-drag.js';
import type { HandleKind } from './frame-drag.js';
import type { Frame } from './layout.js';
import { fallbackFor, frameTiles } from './tiles.js';
import type { TileImage } from './loader.js';

export interface PaintInput {
  camera: Camera;
  viewport: Size;
  dpr: number;
  frames: readonly Frame[];
  zoom: Zoom;
  smoothing: boolean;
  /** The handle being dragged, whose readout (size and style tier) is drawn next to it. */
  readout?: Readout | null;
  /** Whether frame handles are drawn (default true); off where frames cannot be changed. */
  handles?: boolean;
}

export interface Readout {
  frameId: string;
  kind: HandleKind;
}

export interface PaintStats {
  mode: 'full' | 'partial' | 'none';
  blit: boolean;
  regions: number;
  tilesDrawn: number;
  missing: number;
}

export interface TileGetter {
  get(key: string, x: number, y: number): TileImage | undefined;
}

/**
 * A second canvas of the same size as the painter's own. `present` is called each
 * time a paint makes a different canvas the one that is shown, with that canvas's
 * context; the caller makes it visible and hides the other.
 */
export interface BackBuffer {
  ctx: CanvasRenderingContext2D;
  present(shown: CanvasRenderingContext2D): void;
}

export const COLORS = { bg: '#e9e9ec', frame: '#ffffff', label: '#5f6368', badge: '#d93025', fold: '#9aa0a6', readout: '#1a73e8' } as const;
export { LABEL_MIN_SCALE };

/** The text above a frame: page, size and style tier, and whether its size is still rendering. */
export function frameLabel(f: Frame): string {
  const label = `${f.name} · ${f.w} × ${f.viewportHeight} · ${DEVICE_LABEL[f.device]} styles`;
  return f.pending ? `${label} · Rendering…` : label;
}

/** Coarser fallbacks are tried largest first. */
const ZOOMS_COARSE_FIRST: readonly Zoom[] = [...ZOOMS].sort((a, b) => b - a);

interface Last {
  cam: Camera; // snapped to device px
  width: number;
  height: number;
  dpr: number;
  frames: readonly Frame[];
  zoom: Zoom;
  smoothing: boolean;
  readout: Readout | null;
}

function sameReadout(a: Readout | null, b: Readout | null): boolean {
  return a === b || (a !== null && b !== null && a.frameId === b.frameId && a.kind === b.kind);
}

interface Pass {
  cam: Camera; // snapped
  s: number; // device px per world px
  dpr: number;
  width: number;
  frames: readonly Frame[];
  zoom: Zoom;
  smoothing: boolean;
  readout: Readout | null;
  handles: boolean;
}

interface Counts {
  tilesDrawn: number;
  missing: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Device rect covering a world rect: floor on the near edge, ceil on the far edge.
function invalidRegion(r: Rect, cam: Camera, s: number, width: number, height: number): Rect | null {
  const x0 = clamp(Math.floor((r.x - cam.x) * s), 0, width);
  const x1 = clamp(Math.ceil((r.x + r.w - cam.x) * s), 0, width);
  const y0 = clamp(Math.floor((r.y - cam.y) * s), 0, height);
  const y1 = clamp(Math.ceil((r.y + r.h - cam.y) * s), 0, height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Device y of a frame's viewport line (the height tab) and of the middle of its viewport (the width grip). */
function handleYs(frame: Frame, cam: Camera, dpr: number): { fold: number; mid: number } {
  const at = (y: number) => worldToDevice({ x: frame.x, y, w: 0, h: 0 }, cam, dpr).y;
  return { fold: at(frame.y + frame.viewportHeight), mid: at(frame.y + frame.viewportHeight / 2) };
}

/** The height tab at the viewport line and a grip for the width band, both outside the right edge. */
function paintHandles(ctx: CanvasRenderingContext2D, r: Rect, fr: Rect, ys: { fold: number; mid: number }, dpr: number): void {
  const tab: Rect = { x: fr.x + fr.w, y: ys.fold - (HANDLE_PX / 2) * dpr, w: HANDLE_PX * dpr, h: HANDLE_PX * dpr };
  const grip: Rect = { x: fr.x + fr.w + 10 * dpr, y: ys.mid - 16 * dpr, w: 4 * dpr, h: 32 * dpr };
  ctx.fillStyle = COLORS.fold;
  if (rectsIntersect(tab, r)) ctx.fillRect(tab.x, tab.y, tab.w, tab.h);
  if (rectsIntersect(grip, r)) ctx.fillRect(grip.x, grip.y, grip.w, grip.h);
}

/** The dragged frame's size and style tier, next to the handle being dragged. */
function paintReadout(ctx: CanvasRenderingContext2D, pass: Pass, readout: Readout): void {
  const frame = pass.frames.find((f) => f.frameId === readout.frameId);
  if (frame === undefined) return;
  const { cam, dpr } = pass;
  const fr = worldToDevice(frame, cam, dpr);
  const ys = handleYs(frame, cam, dpr);
  const x = fr.x + fr.w + (HANDLE_PX + 8) * dpr;
  const y = readout.kind === 'height' ? ys.fold : readout.kind === 'width' ? ys.mid : fr.y - LABEL_BAND_PX * dpr - 4 * dpr;
  ctx.fillStyle = COLORS.readout;
  ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = readout.kind === 'move' ? 'bottom' : 'middle';
  ctx.fillText(readoutText(frame.w, frame.viewportHeight), readout.kind === 'move' ? fr.x : x, y);
}

export class BasePainter {
  /** The canvas holding the last painted image: the one that is shown. */
  private front: CanvasRenderingContext2D;
  /** The other canvas of a ping-pong pair; its content is stale until a blit overwrites it. */
  private back: CanvasRenderingContext2D | null;
  private readonly present: ((shown: CanvasRenderingContext2D) => void) | null;
  private readonly tiles: TileGetter;
  private last: Last | null = null;
  private invalidated = false;
  private dirty: Rect[] = [];

  constructor(ctx: CanvasRenderingContext2D, tiles: TileGetter, back?: BackBuffer) {
    this.front = ctx;
    this.back = back?.ctx ?? null;
    this.present = back?.present ?? null;
    this.tiles = tiles;
  }

  /**
   * The snapped camera of the image on the canvas when that image can stand in for a paint of
   * `input` after a pure move and scale of the canvas (a CSS transform), else null: the canvas was
   * resized or cleared, or the frames or dpr changed, so its content no longer matches.
   */
  previewOf(input: PaintInput): Camera | null {
    const last = this.last;
    if (last === null || this.invalidated) return null;
    const { canvas } = this.front;
    if (canvas.width !== last.width || canvas.height !== last.height) return null;
    if (input.dpr !== last.dpr || input.frames !== last.frames) return null;
    return last.cam;
  }

  /** The next paint repaints the whole canvas. */
  invalidate(): void {
    this.invalidated = true;
  }

  /** The next paint repaints this world rect. */
  invalidateWorld(r: Rect): void {
    this.dirty.push({ ...r });
  }

  paint(input: PaintInput): PaintStats {
    const front = this.front;
    const width = front.canvas.width;
    const height = front.canvas.height;
    const cam = snapCamera(input.camera, input.dpr);
    const s = cam.scale * input.dpr;
    const last = this.last;
    const readout = input.readout ?? null;
    front.setTransform(1, 0, 0, 1, 0, 0);

    const dx = last === null ? 0 : Math.round((last.cam.x - cam.x) * s);
    const dy = last === null ? 0 : Math.round((last.cam.y - cam.y) * s);
    const full =
      this.invalidated ||
      last === null ||
      cam.scale !== last.cam.scale ||
      width !== last.width ||
      height !== last.height ||
      input.dpr !== last.dpr ||
      input.frames !== last.frames ||
      input.zoom !== last.zoom ||
      (input.smoothing && !last.smoothing) ||
      !sameReadout(readout, last.readout) ||
      Math.abs(dx) >= width ||
      Math.abs(dy) >= height;

    // Set before any drawing and cleared only when the paint completes, so a
    // throw mid-paint leaves it set and the next paint starts from a full repaint.
    this.invalidated = true;
    const regions: Rect[] = [];
    let blit = false;
    // The canvas this paint draws into: the shown one, or the hidden one after a blit into it.
    let target = front;
    if (full || last === null) {
      regions.push({ x: 0, y: 0, w: width, h: height });
    } else {
      if (dx !== 0 || dy !== 0) {
        if (this.back !== null) {
          // The blit covers all of the target except the exposed strips, which are repainted below.
          target = this.back;
          target.setTransform(1, 0, 0, 1, 0, 0);
        }
        target.drawImage(front.canvas, dx, dy);
        blit = true;
        if (dx > 0) regions.push({ x: 0, y: 0, w: dx, h: height });
        if (dx < 0) regions.push({ x: width + dx, y: 0, w: -dx, h: height });
        if (dy > 0) regions.push({ x: 0, y: 0, w: width, h: dy });
        if (dy < 0) regions.push({ x: 0, y: height + dy, w: width, h: -dy });
      }
      for (const r of this.dirty) {
        const region = invalidRegion(r, cam, s, width, height);
        if (region !== null) regions.push(region);
      }
    }

    const pass: Pass = { cam, s, dpr: input.dpr, width, frames: input.frames, zoom: input.zoom, smoothing: input.smoothing, readout, handles: input.handles !== false };
    const counts: Counts = { tilesDrawn: 0, missing: 0 };
    for (const r of regions) this.paintRegion(target, r, pass, counts);

    if (target !== front) {
      this.back = front;
      this.front = target;
      this.present?.(target);
    }
    this.last = { cam, width, height, dpr: input.dpr, frames: input.frames, zoom: input.zoom, smoothing: input.smoothing, readout };
    this.invalidated = false;
    this.dirty = [];
    return {
      mode: full ? 'full' : regions.length > 0 ? 'partial' : 'none',
      blit,
      regions: regions.length,
      tilesDrawn: counts.tilesDrawn,
      missing: counts.missing,
    };
  }

  private paintRegion(ctx: CanvasRenderingContext2D, r: Rect, pass: Pass, counts: Counts): void {
    const { cam, s, dpr, width, frames, zoom } = pass;
    ctx.save();
    // restore() runs even when a tile lookup or draw throws, so the region clip
    // never outlives this paint on the canvas state stack.
    try {
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.imageSmoothingEnabled = pass.smoothing;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      const area: Rect = { x: cam.x + r.x / s, y: cam.y + r.y / s, w: r.w / s, h: r.h / s };
      for (const frame of frames) {
        const fr = worldToDevice(frame, cam, dpr);
        if (rectsIntersect(fr, r)) {
          ctx.fillStyle = COLORS.frame;
          ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
          // Stale tiles keep their own size, so they are clipped to the frame they stand in for.
          const clipped = frame.render === null && frame.stale !== null;
          if (clipped) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(fr.x, fr.y, fr.w, fr.h);
            ctx.clip();
          }
          try {
            for (const ref of frameTiles(frame, zoom, area)) {
              const d = worldToDevice(ref.world, cam, dpr);
              const image = this.tiles.get(ref.key, ref.x, ref.y);
              if (image !== undefined) {
                ctx.drawImage(image, d.x, d.y, d.w, d.h);
                counts.tilesDrawn++;
                continue;
              }
              counts.missing++;
              for (const z of ZOOMS_COARSE_FIRST) {
                const fb = fallbackFor(frame, ref, z);
                if (fb === null) continue;
                const coarse = this.tiles.get(fb.ref.key, fb.ref.x, fb.ref.y);
                if (coarse !== undefined) {
                  ctx.drawImage(coarse, fb.sx, fb.sy, fb.sw, fb.sh, d.x, d.y, d.w, d.h);
                  break;
                }
              }
            }
          } finally {
            if (clipped) ctx.restore();
          }
          if (frame.h > frame.viewportHeight) {
            // The fold: where the first screen of the page ends.
            const foldY = worldToDevice({ x: frame.x, y: frame.y + frame.viewportHeight, w: 0, h: 0 }, cam, dpr).y;
            ctx.strokeStyle = COLORS.fold;
            ctx.lineWidth = dpr;
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.beginPath();
            ctx.moveTo(fr.x, foldY);
            ctx.lineTo(fr.x + fr.w, foldY);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (frame.render?.error) {
            ctx.fillStyle = COLORS.badge;
            ctx.fillRect(fr.x + fr.w - 24 * dpr, fr.y + 8 * dpr, 16 * dpr, 16 * dpr);
          }
        }
        // The label text may run past the frame's right edge, so its cull band
        // extends to the canvas edge rather than the frame width.
        const labelBand: Rect = { x: fr.x, y: fr.y - LABEL_BAND_PX * dpr, w: Math.max(0, width - fr.x), h: LABEL_BAND_PX * dpr };
        if (cam.scale >= LABEL_MIN_SCALE && rectsIntersect(labelBand, r)) {
          ctx.fillStyle = COLORS.label;
          ctx.font = `${12 * dpr}px system-ui, sans-serif`;
          ctx.textBaseline = 'bottom';
          ctx.fillText(frameLabel(frame), fr.x, fr.y - 6 * dpr);
        }
        if (pass.handles && cam.scale >= LABEL_MIN_SCALE) paintHandles(ctx, r, fr, handleYs(frame, cam, dpr), dpr);
      }
      if (pass.readout !== null) paintReadout(ctx, pass, pass.readout);
    } finally {
      ctx.restore();
    }
  }
}
