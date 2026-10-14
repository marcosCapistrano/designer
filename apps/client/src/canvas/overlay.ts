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
}

export const SELECT_COLOR = '#1a73e8';

export function paintOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput): void {
  const { camera, dpr, selection, marquee } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (selection !== null) {
    const { frame, boxes } = selection;
    for (const box of boxes) {
      const d = worldToDevice(
        { x: frame.x + box.x, y: frame.y + box.y, w: box.w, h: box.h },
        camera,
        dpr,
      );
      ctx.fillStyle = 'rgba(26,115,232,0.08)';
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
    ctx.fillStyle = 'rgba(26,115,232,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = dpr;
    ctx.strokeRect(x, y, w, h);
  }
}
