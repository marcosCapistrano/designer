// Selection highlight and marquee drawn over the base layer. The overlay is
// cleared and repainted in full on every call.

import type { HitBox } from '@hub/protocol';
import { worldToDevice } from './geom.js';
import type { Camera, Rect } from './geom.js';
import type { Frame } from './layout.js';

export interface OverlayInput {
  camera: Camera; // pass the same snapped camera the painter used
  dpr: number;
  selection: { frame: Frame; boxes: readonly HitBox[] } | null;
  marquee: Rect | null; // screen CSS px
  /** Component mode: world rects to dim, each with an optional world hole (the instance being edited). */
  dim?: readonly { rect: Rect; keep: Rect | null }[];
}

export const DIM_COLOR = 'rgba(0,0,0,0.55)';

/** `r` minus `hole`, as up to four bands (above, below, left, right). */
function around(r: Rect, hole: Rect | null): Rect[] {
  if (hole === null) return [r];
  const x0 = Math.max(r.x, hole.x), y0 = Math.max(r.y, hole.y);
  const x1 = Math.min(r.x + r.w, hole.x + hole.w), y1 = Math.min(r.y + r.h, hole.y + hole.h);
  if (x0 >= x1 || y0 >= y1) return [r];
  return [
    { x: r.x, y: r.y, w: r.w, h: y0 - r.y },
    { x: r.x, y: y1, w: r.w, h: r.y + r.h - y1 },
    { x: r.x, y: y0, w: x0 - r.x, h: y1 - y0 },
    { x: x1, y: y0, w: r.x + r.w - x1, h: y1 - y0 },
  ].filter((b) => b.w > 0 && b.h > 0);
}

export const SELECT_COLOR = '#4c8dff'; // --accent

export function paintOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput): void {
  const { camera, dpr, selection, marquee } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  for (const { rect, keep } of input.dim ?? []) {
    ctx.fillStyle = DIM_COLOR;
    for (const band of around(rect, keep)) {
      const d = worldToDevice(band, camera, dpr);
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }
  }

  if (selection !== null) {
    const { frame, boxes } = selection;
    for (const box of boxes) {
      const d = worldToDevice(
        { x: frame.x + box.x, y: frame.y + box.y, w: box.w, h: box.h },
        camera,
        dpr,
      );
      ctx.fillStyle = 'rgba(76,141,255,0.12)';
      ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(d.x, d.y, d.w, d.h);
    }
  }

  if (marquee !== null) {
    const x = marquee.x * dpr;
    const y = marquee.y * dpr;
    const w = marquee.w * dpr;
    const h = marquee.h * dpr;
    ctx.fillStyle = 'rgba(76,141,255,0.16)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = dpr;
    ctx.strokeRect(x, y, w, h);
  }
}
