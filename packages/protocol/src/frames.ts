import { DEVICES, DEVICE_VIEWPORT_HEIGHT, DEVICE_WIDTH, type Device } from './render.js';

export interface FrameSize { width: number; viewportHeight: number }
export interface CanvasFrame extends FrameSize { id: string; pageId: string; x: number; y: number }

export const FRAME_WIDTH_MIN = 240;
export const FRAME_WIDTH_MAX = 3840;
export const FRAME_VIEWPORT_MIN = 320;
export const FRAME_VIEWPORT_MAX = 4000;
export const FRAME_COORD_MAX = 1_000_000;
export const MAX_FRAMES_PER_PAGE = 12;
export const MAX_FRAMES_PER_APP = 600;
export const FRAME_GAP = 80;
export const ROW_GAP = 200;
export const FRAME_GRID = 8;

export const DEFAULT_FRAME_SIZES: readonly FrameSize[] = DEVICES.map((d) => ({
  width: DEVICE_WIDTH[d],
  viewportHeight: DEVICE_VIEWPORT_HEIGHT[d],
}));

const preset = (width: number, viewportHeight: number): FrameSize => ({ width, viewportHeight });
export const FRAME_PRESETS: readonly FrameSize[] = [
  preset(1920, 1080), preset(1600, 900), preset(1440, 900), preset(1280, 800), preset(1024, 768),
  preset(834, 1194), preset(768, 1024), preset(600, 960), preset(390, 844), preset(360, 780),
];

/** Which style tier a frame of this width gets; mirrors the (max-width: 1023px) / (max-width: 599px) media. */
export function tierForWidth(width: number): Device {
  if (width <= 599) return 'mobile';
  if (width <= 1023) return 'tablet';
  return 'base';
}

export function sizeKey(size: FrameSize): string {
  return `${size.width}x${size.viewportHeight}`;
}

export function parseSizeKey(key: string): FrameSize | null {
  if (!/^\d+x\d+$/.test(key)) return null;
  const [w, h] = key.split('x').map(Number) as [number, number];
  if (!inRange(w, FRAME_WIDTH_MIN, FRAME_WIDTH_MAX) || !inRange(h, FRAME_VIEWPORT_MIN, FRAME_VIEWPORT_MAX)) return null;
  return { width: w, viewportHeight: h };
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

const ID_PATTERN = /^f[0-9a-f]{16}$/;

export function validateFrames(
  frames: unknown,
  pageIds: ReadonlySet<string>,
): { ok: true; frames: CanvasFrame[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!Array.isArray(frames)) return fail('frames must be an array');
  if (frames.length > MAX_FRAMES_PER_APP) return fail(`more than ${MAX_FRAMES_PER_APP} frames`);
  const out: CanvasFrame[] = [];
  const firstIndexOfId = new Map<string, number>();
  const perPage = new Map<string, number>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as Record<string, unknown> | null;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return fail(`frames[${i}] must be an object`);
    if (typeof f.id !== 'string' || !ID_PATTERN.test(f.id)) {
      return fail(`frames[${i}].id must be f followed by 16 lowercase hex characters`);
    }
    const dup = firstIndexOfId.get(f.id);
    if (dup !== undefined) return fail(`frames[${i}].id duplicates frames[${dup}].id`);
    firstIndexOfId.set(f.id, i);
    if (typeof f.pageId !== 'string' || !pageIds.has(f.pageId)) return fail(`frames[${i}].pageId is not a page of this app`);
    if (!inRange(f.width, FRAME_WIDTH_MIN, FRAME_WIDTH_MAX)) {
      return fail(`frames[${i}].width must be an integer from ${FRAME_WIDTH_MIN} to ${FRAME_WIDTH_MAX}`);
    }
    if (!inRange(f.viewportHeight, FRAME_VIEWPORT_MIN, FRAME_VIEWPORT_MAX)) {
      return fail(`frames[${i}].viewportHeight must be an integer from ${FRAME_VIEWPORT_MIN} to ${FRAME_VIEWPORT_MAX}`);
    }
    for (const axis of ['x', 'y'] as const) {
      if (!inRange(f[axis], -FRAME_COORD_MAX, FRAME_COORD_MAX)) {
        return fail(`frames[${i}].${axis} must be an integer from -${FRAME_COORD_MAX} to ${FRAME_COORD_MAX}`);
      }
    }
    const n = (perPage.get(f.pageId) ?? 0) + 1;
    if (n > MAX_FRAMES_PER_PAGE) return fail(`page ${f.pageId} has more than ${MAX_FRAMES_PER_PAGE} frames`);
    perPage.set(f.pageId, n);
    out.push({ id: f.id, pageId: f.pageId, x: f.x as number, y: f.y as number, width: f.width, viewportHeight: f.viewportHeight });
  }
  return { ok: true, frames: out };
}

/** Existing frames plus the default three for every page that has none, one row per page. */
export function defaultFrames(
  pages: readonly { pageId: string }[],
  existing: readonly CanvasFrame[],
  heightOf: (pageId: string, size: FrameSize) => number,
  newId: () => string,
): CanvasFrame[] {
  const out = [...existing];
  const has = new Set(existing.map((f) => f.pageId));
  let y = existing.length === 0
    ? 0
    : Math.max(...existing.map((f) => f.y + heightOf(f.pageId, f))) + ROW_GAP;
  for (const { pageId } of pages) {
    if (has.has(pageId)) continue;
    let x = 0;
    let rowHeight = 0;
    for (const size of DEFAULT_FRAME_SIZES) {
      out.push({ id: newId(), pageId, x, y, width: size.width, viewportHeight: size.viewportHeight });
      x += size.width + FRAME_GAP;
      rowHeight = Math.max(rowHeight, heightOf(pageId, size));
    }
    y += rowHeight + ROW_GAP;
  }
  return out;
}
