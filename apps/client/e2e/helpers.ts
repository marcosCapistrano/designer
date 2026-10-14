import type { Page } from '@playwright/test';

/** A device frame as the canvas lays it out (world px), with the render it shows. */
export interface E2EFrame {
  pageId: string;
  device: string;
  x: number;
  y: number;
  w: number;
  h: number;
  render: { hash: string } | null;
}

/** A hit box in page CSS px at zoom 1. */
export interface E2EBox {
  nodeId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Waits for the first paint and for the loader to go idle. The page code is a
 * string because it runs in Chromium, where tsx's `__name` helpers do not exist.
 */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction('!!window.__hubCanvas && window.__hubCanvas.stats().framesPainted > 0');
  await page.evaluate('window.__hubCanvas.idle()');
}

export async function frameOf(page: Page, pageId: string, device: string): Promise<E2EFrame> {
  const expr = `(() => {
    const f = window.__hubCanvas.frames().find((g) => g.pageId === ${JSON.stringify(pageId)} && g.device === ${JSON.stringify(device)});
    return f === undefined ? null : {
      pageId: f.pageId, device: f.device, x: f.x, y: f.y, w: f.w, h: f.h,
      render: f.render === null ? null : { hash: f.render.hash },
    };
  })()`;
  const frame = await page.evaluate<E2EFrame | null>(expr);
  if (frame === null) throw new Error(`no frame for ${pageId}/${device}`);
  return frame;
}

export async function hitMapOf(page: Page, hash: string): Promise<E2EBox[]> {
  const res = await page.request.get(`/dev-renders/hitmaps/${hash}.json`);
  if (!res.ok()) throw new Error(`hit map ${hash}: HTTP ${res.status()}`);
  return (await res.json()) as E2EBox[];
}

/** Screen CSS px of a point given in frame-local page px, for a camera (world origin and CSS px per world px). */
export function toScreen(
  cam: { x: number; y: number; scale: number },
  f: E2EFrame,
  px: number,
  py: number,
): { x: number; y: number } {
  return { x: (f.x + px - cam.x) * cam.scale, y: (f.y + py - cam.y) * cam.scale };
}

/** Resolves after two animation frames, so a paint scheduled by the last event has run. */
export async function nextPaint(page: Page): Promise<void> {
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

/**
 * The RGB of the base canvas at a screen point (CSS px), read from the canvas that is shown. The
 * base layer is two canvases that take turns, so the shown one is found by its visibility.
 */
export async function basePixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const rgb = await page.evaluate<number[]>(`(() => {
    const c = [...document.querySelectorAll('[data-testid=canvas-base]')].find((e) => getComputedStyle(e).visibility === 'visible');
    const d = c.getContext('2d').getImageData(Math.round(${x} * devicePixelRatio), Math.round(${y} * devicePixelRatio), 1, 1).data;
    return [d[0], d[1], d[2]];
  })()`);
  return [rgb[0] ?? -1, rgb[1] ?? -1, rgb[2] ?? -1];
}

/** The CSS transform on the box holding the canvas layers: '' when they are shown as painted. */
export function layerTransform(page: Page): Promise<string> {
  return page.evaluate<string>(`document.querySelector('[data-testid=canvas] > div').style.transform`);
}

/** `#rrggbb` as [r, g, b]. */
export function rgbOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
