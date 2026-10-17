// Frame layout for the canvas: one Frame per saved CanvasFrame whose page is in
// the manifest, in world px. Frames only carry geometry and their render
// metadata; tiles and hit maps are looked up elsewhere by `render`.

import { sizeKey, tierForWidth } from '@hub/protocol';
import type { CanvasFrame, Device, PageRender, RenderManifest } from '@hub/protocol';
import type { Point, Rect } from './geom.js';

export interface Frame {
  frameId: string;
  pageId: string;
  name: string;
  /** The style tier the frame's width gets. */
  device: Device;
  x: number;
  y: number;
  w: number;
  h: number;
  viewportHeight: number;
  /** The render of this page at this frame's size, or null while there is none. */
  render: PageRender | null;
  /** While pending, the last render this frame showed, drawn pinned to its top-left. */
  stale: PageRender | null;
  pending: boolean;
}

/** `lastRenders` maps a frame id to the last render it was laid out with. */
export function layoutFrames(
  frames: readonly CanvasFrame[],
  m: RenderManifest,
  lastRenders?: ReadonlyMap<string, PageRender>,
): Frame[] {
  const pages = new Map(m.pages.map((p) => [p.pageId, p]));
  const out: Frame[] = [];
  for (const f of frames) {
    const page = pages.get(f.pageId);
    if (page === undefined) continue;
    const render = page.renders[sizeKey(f)] ?? null;
    const pending = render === null;
    out.push({
      frameId: f.id,
      pageId: f.pageId,
      name: page.name,
      device: tierForWidth(f.width),
      x: f.x,
      y: f.y,
      w: f.width,
      h: Math.max(render?.height ?? 0, f.viewportHeight),
      viewportHeight: f.viewportHeight,
      render,
      stale: pending ? lastRenders?.get(f.id) ?? null : null,
      pending,
    });
  }
  return out;
}

export function frameAt(frames: readonly Frame[], p: Point): Frame | null {
  for (const f of frames) {
    if (f.x <= p.x && p.x < f.x + f.w && f.y <= p.y && p.y < f.y + f.h) return f;
  }
  return null;
}

export function layoutBounds(frames: readonly Frame[]): Rect {
  const first = frames[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = first.x;
  let y0 = first.y;
  let x1 = first.x + first.w;
  let y1 = first.y + first.h;
  for (const f of frames) {
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.w);
    y1 = Math.max(y1, f.y + f.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
