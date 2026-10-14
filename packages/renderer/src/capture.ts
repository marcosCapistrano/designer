import {
  DEVICE_VIEWPORT_HEIGHT,
  DEVICE_WIDTH,
  MAX_PAGE_HEIGHT,
  type Device,
  type HitBox,
} from '@hub/protocol';
import type { Frame, Page } from 'playwright';
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

/** Matches a refresh that is scheduled but may not have fired when the load event does. */
const PENDING_REFRESH_SCRIPT = 'document.querySelector(\'meta[http-equiv="refresh" i]\') !== null';

const CONTEXT_DESTROYED = /Execution context was destroyed/;

const NAVIGATED = 'Page navigated during capture';

/**
 * Renders one page at one device width and returns a full-page PNG plus its hit map.
 *
 * Throws an Error starting "Page navigated during capture" when the main frame navigates (for
 * example through `<meta http-equiv=refresh>`), so the outcome never depends on a timing race.
 * A refresh that has not fired yet is detected in the DOM instead of waited for.
 */
export async function capturePage(page: Page, job: CaptureJob): Promise<Capture> {
  const mainFrame = page.mainFrame();
  let navigatedTo: string | null = null;
  const onNavigated = (frame: Frame): void => {
    if (frame === mainFrame) navigatedTo ??= frame.url();
  };
  page.on('framenavigated', onNavigated);
  const failIfNavigated = (): void => {
    if (navigatedTo !== null) throw new Error(`${NAVIGATED} (to ${navigatedTo})`);
  };
  try {
    return await captureLoaded(page, job, failIfNavigated);
  } catch (err) {
    // A navigation destroys the execution context, and that rejection can arrive before the
    // framenavigated event does, so the message counts as evidence of a navigation too.
    failIfNavigated();
    if (err instanceof Error && CONTEXT_DESTROYED.test(err.message)) {
      throw new Error(`${NAVIGATED} (execution context destroyed)`, { cause: err });
    }
    throw err;
  } finally {
    page.off('framenavigated', onNavigated);
  }
}

async function captureLoaded(page: Page, job: CaptureJob, failIfNavigated: () => void): Promise<Capture> {
  const d = job.device;
  await page.setViewportSize({ width: DEVICE_WIDTH[d], height: DEVICE_VIEWPORT_HEIGHT[d] });
  await page.setContent(buildDocument(job.html, job.css, d), { waitUntil: 'load' });
  failIfNavigated();
  if (await page.evaluate(PENDING_REFRESH_SCRIPT)) throw new Error(`${NAVIGATED} (pending <meta http-equiv="refresh">)`);
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
  failIfNavigated();

  return { png, width, height, hitMap };
}
