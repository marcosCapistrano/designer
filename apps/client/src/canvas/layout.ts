// Device frame layout for the canvas: one row per manifest page, one frame per
// visible device, in world px. Frames only carry geometry and their render
// metadata; tiles and hit maps are looked up elsewhere by `render`.

import {
  DEFAULT_FRAME_SIZES,
  DEVICES,
  DEVICE_VIEWPORT_HEIGHT,
  DEVICE_WIDTH,
  FRAME_GAP,
  ROW_GAP,
  sizeKey,
} from '@hub/protocol';
import type { Device, PageRender, RenderManifest } from '@hub/protocol';
import type { Point, Rect } from './geom.js';

export interface Frame {
  pageId: string;
  name: string;
  device: Device;
  x: number;
  y: number;
  w: number;
  h: number;
  render: PageRender | null;
}

export { FRAME_GAP, ROW_GAP };

export function layoutFrames(m: RenderManifest, visible: ReadonlySet<Device>): Frame[] {
  const devices = DEVICES.filter((d) => visible.has(d));
  // Task 4 replaces this device grid; until then each device maps to its default size.
  const keyOf = (d: Device): string => sizeKey(DEFAULT_FRAME_SIZES[DEVICES.indexOf(d)]!);
  if (devices.length === 0) return [];

  const frames: Frame[] = [];
  let rowY = 0;
  for (const page of m.pages) {
    let x = 0;
    let rowH = 0;
    for (const device of devices) {
      const render = page.renders[keyOf(device)] ?? null;
      const w = DEVICE_WIDTH[device];
      const h = render && render.height > 0 ? render.height : DEVICE_VIEWPORT_HEIGHT[device];
      frames.push({ pageId: page.pageId, name: page.name, device, x, y: rowY, w, h, render });
      x += w + FRAME_GAP;
      rowH = Math.max(rowH, h);
    }
    rowY += rowH + ROW_GAP;
  }
  return frames;
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
