// Tile math for the canvas: which zoom level to draw, which tiles of a frame
// cover a visible area, and which coarser tile can stand in while a finer one
// is still loading. Tiles are TILE_SIZE device px at their own zoom, so a tile
// at zoom z covers TILE_SIZE / z world px.

import { TILE_SIZE, ZOOMS } from '@hub/protocol';
import type { PageRender, TileLevel, Zoom } from '@hub/protocol';
import { intersectRect, rectsIntersect } from './geom.js';
import type { Rect } from './geom.js';
import type { Frame } from './layout.js';

export interface TileRef {
  key: string;
  x: number;
  y: number;
  zoom: Zoom;
  world: Rect;
}

export interface Fallback {
  ref: TileRef;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// Smallest zoom that still covers the on-screen scale in device pixels.
export function pickZoom(scale: number, dpr: number): Zoom {
  const need = scale * dpr;
  return ZOOMS.find((z) => z >= need) ?? 1;
}

/** The render whose tiles a frame shows: its own, or while pending the stale one pinned to its top-left. */
export function shownRender(frame: Frame): PageRender | null {
  return frame.render ?? frame.stale;
}

export function levelOf(frame: Frame, zoom: Zoom): TileLevel | undefined {
  return shownRender(frame)?.levels.find((l) => l.zoom === zoom);
}

function tileRef(frame: Frame, level: TileLevel, zoom: Zoom, tx: number, ty: number): TileRef {
  const size = TILE_SIZE / zoom;
  return {
    key: level.key,
    x: tx,
    y: ty,
    zoom,
    world: { x: frame.x + tx * size, y: frame.y + ty * size, w: size, h: size },
  };
}

// Tiles of `frame` at `zoom` that overlap `area` within the frame (world px). Edges are
// exclusive: an area ending exactly on a tile boundary does not take the next tile.
export function frameTiles(frame: Frame, zoom: Zoom, within: Rect): TileRef[] {
  const level = levelOf(frame, zoom);
  if (!level) return [];
  // A stale render can be larger than the frame; nothing past the frame's edges is shown.
  const area = intersectRect(within, frame);
  if (area === null) return [];
  const size = TILE_SIZE / zoom;
  const x0 = Math.max(0, Math.floor((area.x - frame.x) / size));
  const x1 = Math.min(level.cols - 1, Math.ceil((area.x + area.w - frame.x) / size) - 1);
  const y0 = Math.max(0, Math.floor((area.y - frame.y) / size));
  const y1 = Math.min(level.rows - 1, Math.ceil((area.y + area.h - frame.y) / size) - 1);
  if (x0 > x1 || y0 > y1) return [];

  const out: TileRef[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      out.push(tileRef(frame, level, zoom, tx, ty));
    }
  }
  return out;
}

// Culls whole frames first, then collects their tiles in frame order.
export function visibleTiles(frames: readonly Frame[], area: Rect, zoom: Zoom): TileRef[] {
  return frames.flatMap((f) => (rectsIntersect(f, area) ? frameTiles(f, zoom, area) : []));
}

// The coarser tile of `frame` at `zoom` that covers `ref`, with the sub-rect of
// it that `ref` occupies (source x/y/w/h in the coarse tile's device px).
// Only coarser levels qualify; null when `zoom` is not coarser or has no level.
export function fallbackFor(frame: Frame, ref: TileRef, zoom: Zoom): Fallback | null {
  if (zoom >= ref.zoom) return null;
  const level = levelOf(frame, zoom);
  if (!level) return null;
  const r = zoom / ref.zoom;
  const tx = Math.floor(ref.x * r);
  const ty = Math.floor(ref.y * r);
  if (tx >= level.cols || ty >= level.rows) return null;
  return {
    ref: tileRef(frame, level, zoom, tx, ty),
    sx: ref.x * TILE_SIZE * r - tx * TILE_SIZE,
    sy: ref.y * TILE_SIZE * r - ty * TILE_SIZE,
    sw: TILE_SIZE * r,
    sh: TILE_SIZE * r,
  };
}
