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
