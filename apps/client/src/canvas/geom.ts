// Camera and rectangle geometry for the infinite canvas.
// Screen values are CSS px relative to the canvas top-left. A camera is the
// world point at the screen origin; `scale` is CSS px per world px.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function worldToScreen(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) * c.scale, y: (p.y - c.y) * c.scale };
}

export function screenToWorld(c: Camera, p: Point): Point {
  return { x: p.x / c.scale + c.x, y: p.y / c.scale + c.y };
}

// A screen drag of (dx, dy) moves the world under the pointer by the same
// screen distance, so the camera origin moves the opposite way in world units.
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x - dx / c.scale, y: c.y - dy / c.scale, scale: c.scale };
}

// Scales by `factor` (clamped) while keeping the world point under `p` fixed.
export function zoomAt(c: Camera, p: Point, factor: number): Camera {
  const anchor = screenToWorld(c, p);
  const scale = clampScale(c.scale * factor);
  return { x: anchor.x - p.x / scale, y: anchor.y - p.y / scale, scale };
}

export function viewRect(c: Camera, view: Size): Rect {
  return { x: c.x, y: c.y, w: view.w / c.scale, h: view.h / c.scale };
}

// Rounds the camera origin to whole device pixels so tiles stay pixel-aligned.
export function snapCamera(c: Camera, dpr: number): Camera {
  const s = c.scale * dpr;
  return { x: Math.round(c.x * s) / s, y: Math.round(c.y * s) / s, scale: c.scale };
}

export function fitRect(r: Rect, view: Size, padding: number): Camera {
  const scale = clampScale(
    Math.min((view.w - 2 * padding) / r.w, (view.h - 2 * padding) / r.h),
  );
  return {
    x: r.x + r.w / 2 - view.w / (2 * scale),
    y: r.y + r.h / 2 - view.h / (2 * scale),
    scale,
  };
}

/** Screen space the app's chrome covers on each edge, in CSS px. */
export interface Insets { top: number; right: number; bottom: number; left: number }
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Like fitRect, but fits into the view minus the insets, so floating chrome never covers what was fitted. */
export function fitRectInset(r: Rect, view: Size, padding: number, insets: Insets): Camera {
  const inner = fitRect(r, { w: view.w - insets.left - insets.right, h: view.h - insets.top - insets.bottom }, padding);
  return { x: inner.x - insets.left / inner.scale, y: inner.y - insets.top / inner.scale, scale: inner.scale };
}

// Positive-area overlap only: rectangles that merely touch do not intersect.
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  if (!rectsIntersect(a, b)) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.min(a.x + a.w, b.x + b.w) - x,
    h: Math.min(a.y + a.h, b.y + b.h) - y,
  };
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

// Grows each side by `fraction` of the rect's size: x uses w, y uses h.
export function expandRect(r: Rect, fraction: number): Rect {
  const dx = fraction * r.w;
  const dy = fraction * r.h;
  return { x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy };
}

// Maps a world rect to device pixels, rounding each edge (not each size) so
// adjacent rects share exact boundaries.
export function worldToDevice(r: Rect, c: Camera, dpr: number): Rect {
  const s = c.scale * dpr;
  const x0 = Math.round((r.x - c.x) * s);
  const x1 = Math.round((r.x + r.w - c.x) * s);
  const y0 = Math.round((r.y - c.y) * s);
  const y1 = Math.round((r.y + r.h - c.y) * s);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
