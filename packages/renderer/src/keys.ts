import { createHash } from 'node:crypto';
import { sizeKey, type FrameSize, type Zoom } from '@hub/protocol';

/**
 * Renderer version, mixed into every tile key so a change to how pixels or hit boxes are produced
 * invalidates previously rendered levels on the server store and in the client's IndexedDB cache.
 *
 * Bump it (and only then) when any of these change the output for the same (html, css, size):
 *  - capture.ts: capturePage, HIT_MAP_SCRIPT (the hit-map script), the screenshot options
 *  - html.ts: BASE_CSS or the document skeleton buildDocument writes
 *  - tiles.ts: WEBP_OPTIONS
 *  - MAX_PAGE_HEIGHT (protocol)
 *  - a Chromium or Playwright upgrade (pool.ts launch args and context options included)
 */
export const RENDER_VERSION = 2;

/**
 * Level key: sha256 of the plain concatenation `r${RENDER_VERSION}:` + html + css + sizeKey(size) + String(zoom),
 * lowercase hex.
 */
export function tileKey(html: string, css: string, size: FrameSize, zoom: Zoom): string {
  return createHash('sha256')
    .update(`r${RENDER_VERSION}:` + html + css + sizeKey(size) + String(zoom))
    .digest('hex');
}
