import {
  DEVICE_VIEWPORT_HEIGHT,
  DEVICE_WIDTH,
  MAX_PAGE_HEIGHT,
  type Device,
  type HitBox,
} from '@hub/protocol';
import type { Page } from 'playwright';
import { buildDocument } from './html.js';

export interface CaptureJob {
  html: string;
  /** Used as given; callers apply cssForDevice first when they need the device's effective CSS. */
  css: string;
  device: Device;
}

export interface Capture {
  png: Buffer;
  width: number;
  height: number;
  hitMap: HitBox[];
}

/** Runs inside Chromium via page.evaluate. Kept as a string so no transpiler rewrites it. */
export const HIT_MAP_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-d-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    let z = 0;
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') { z = parseInt(cs.zIndex, 10) || 0; break; }
    }
    const x = Math.floor(r.left + scrollX), y = Math.floor(r.top + scrollY);
    out.push({ nodeId: el.getAttribute('data-d-id'), x, y, w: Math.ceil(r.right + scrollX) - x, h: Math.ceil(r.bottom + scrollY) - y, z });
  }
  return out;
})()`;

/** Renders one page at one device width and returns a full-page PNG plus its hit map. */
export async function capturePage(page: Page, job: CaptureJob): Promise<Capture> {
  const d = job.device;
  await page.setViewportSize({ width: DEVICE_WIDTH[d], height: DEVICE_VIEWPORT_HEIGHT[d] });
  await page.setContent(buildDocument(job.html, job.css, d), { waitUntil: 'load' });
  await page.evaluate('document.fonts.ready.then(() => true)');

  const full = Number(
    await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'),
  );
  const width = DEVICE_WIDTH[d];
  const height = Math.min(MAX_PAGE_HEIGHT, Math.max(DEVICE_VIEWPORT_HEIGHT[d], full));

  const raw = (await page.evaluate(HIT_MAP_SCRIPT)) as Array<HitBox & { z: number }>;
  // Stable sort: DOM pre-order, with z-indexed layers after everything else.
  const hitMap: HitBox[] = raw
    .slice()
    .sort((a, b) => a.z - b.z)
    .map(({ nodeId, x, y, w, h }) => ({ nodeId, x, y, w, h }))
    .filter((b) => b.x < width && b.y < height && b.x + b.w > 0 && b.y + b.h > 0);

  const png = await page.screenshot({
    type: 'png',
    fullPage: true,
    clip: { x: 0, y: 0, width, height },
    animations: 'disabled',
    caret: 'hide',
  });

  return { png, width, height, hitMap };
}
