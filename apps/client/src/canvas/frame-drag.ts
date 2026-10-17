// Moving and resizing frames: where the handles are, and what a drag on one
// does to the frame. The handles sit outside the page area (the label band
// above it and a band outside its right edge), so taps on the page still select.

import {
  DEVICE_LABEL,
  FRAME_COORD_MAX,
  FRAME_GRID,
  FRAME_VIEWPORT_MAX,
  FRAME_VIEWPORT_MIN,
  FRAME_WIDTH_MAX,
  FRAME_WIDTH_MIN,
  tierForWidth,
} from '@hub/protocol';
import type { CanvasFrame } from '@hub/protocol';
import type { Point } from './geom.js';
import type { Frame } from './layout.js';
import { frameAt } from './layout.js';

export type HandleKind = 'move' | 'width' | 'height';

/** Width in CSS px of the band outside a frame's right edge, and of the height tab in it. */
export const HANDLE_PX = 24;
/** Height in CSS px of the label band above a frame, which is its move handle. */
export const LABEL_BAND_PX = 20;

/** Below this camera scale frame labels and handles are not drawn, so there are no handles to hit. */
export const LABEL_MIN_SCALE = 0.04;

export interface HandleHit {
  frameId: string;
  kind: HandleKind;
}

/**
 * The handle under world point `p` at camera scale `scale`, or null. A point inside any frame is
 * never a handle, and below LABEL_MIN_SCALE (where none are drawn) nothing is.
 */
export function hitHandle(frames: readonly Frame[], p: Point, scale: number): HandleHit | null {
  if (scale < LABEL_MIN_SCALE || frameAt(frames, p) !== null) return null;
  const band = HANDLE_PX / scale;
  const label = LABEL_BAND_PX / scale;
  // Last first, like frameAt: where frames overlap, the one painted on top owns the handle.
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.x <= p.x && p.x < f.x + f.w && f.y - label <= p.y && p.y < f.y) return { frameId: f.frameId, kind: 'move' };
    const right = f.x + f.w;
    if (p.x < right || p.x >= right + band) continue;
    if (Math.abs(p.y - (f.y + f.viewportHeight)) < band) return { frameId: f.frameId, kind: 'height' };
    if (f.y <= p.y && p.y < f.y + f.h) return { frameId: f.frameId, kind: 'width' };
  }
  return null;
}

function clampInt(v: number, lo: number, hi: number): number {
  // `+ 0` turns a -0 from rounding into 0.
  return Math.min(hi, Math.max(lo, Math.round(v))) + 0;
}

/** `frame` dragged by (dx, dy) world px on handle `kind`, within the frame limits. */
export function dragFrame(frame: CanvasFrame, kind: HandleKind, dx: number, dy: number): CanvasFrame {
  switch (kind) {
    case 'move':
      return {
        ...frame,
        x: clampInt(frame.x + dx, -FRAME_COORD_MAX, FRAME_COORD_MAX),
        y: clampInt(frame.y + dy, -FRAME_COORD_MAX, FRAME_COORD_MAX),
      };
    case 'width':
      return { ...frame, width: clampInt(frame.width + dx, FRAME_WIDTH_MIN, FRAME_WIDTH_MAX) };
    case 'height':
      return { ...frame, viewportHeight: clampInt(frame.viewportHeight + dy, FRAME_VIEWPORT_MIN, FRAME_VIEWPORT_MAX) };
  }
}

/** The frame as it lands on release: its position snapped to the grid. */
export function settleFrame(frame: CanvasFrame): CanvasFrame {
  const snap = (v: number) => clampInt(Math.round(v / FRAME_GRID) * FRAME_GRID, -FRAME_COORD_MAX, FRAME_COORD_MAX);
  return { ...frame, x: snap(frame.x), y: snap(frame.y) };
}

/** What the readout next to a dragged handle says. */
export function readoutText(width: number, viewportHeight: number): string {
  return `${width} × ${viewportHeight} · ${DEVICE_LABEL[tierForWidth(width)]}`;
}

/** A drag in progress on one frame's handle, by one pointer. */
export interface FrameDrag {
  pointerId: number;
  frameId: string;
  kind: HandleKind;
  /** Screen CSS px where the pointer went down. */
  start: Point;
  /** The frame as it was before the drag, restored by a cancel. */
  origin: CanvasFrame;
  /** The pointer has left the tap slop; until then a release is a tap on the handle. */
  moved: boolean;
}

/**
 * The frame for the pointer at screen point `p`, or null while the pointer is still within
 * `slop` of where it went down. Deltas are measured from the start, so the slop is not lost.
 */
export function dragTo(d: FrameDrag, p: Point, scale: number, slop: number): CanvasFrame | null {
  if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) <= slop) return null;
  d.moved = true;
  return dragFrame(d.origin, d.kind, (p.x - d.start.x) / scale, (p.y - d.start.y) / scale);
}
