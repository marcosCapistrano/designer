import { Hono, type Context } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_PATH, type RenderManifest } from '@hub/protocol';
import { APP_NAME_RE } from '@hub/protocol/manifest';

/** Served while an app has no render manifest yet. */
export const EMPTY_MANIFEST: RenderManifest = { version: 1, pages: [] };

// Anchored and strict: a URL segment that matches none of these never reaches the filesystem.
const KEY_RE = /^[0-9a-f]{64}$/;
// A tile column or row is at most a few digits (a 16000 px page is 32 rows of 512 px); the bound also keeps a
// huge digit run from becoming a file name longer than the filesystem allows, which would be a 500, not a 404.
const TILE_RE = /^\d{1,5}_\d{1,5}\.webp$/;
const HITMAP_RE = /^[0-9a-f]{64}\.json$/;
const IMMUTABLE = 'private, max-age=31536000, immutable';

export interface RenderRouteOptions {
  dataDir: string;
  /** Asked only for names that pass the app name pattern. */
  hasApp: (app: string) => Promise<boolean>;
}

/** Where one app's renders live. FsTileStore writes tiles/ and hitmaps/ and the manifest here. */
export function renderDir(dataDir: string, app: string): string {
  return join(dataDir, 'renders', app);
}

function notFound(c: Context): Response {
  return c.json({ error: 'Not found' }, 404);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

/** The file's bytes, or null when it is missing. Copied into a plain Uint8Array, which is what Hono's body accepts. */
async function readOrNull(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Mount at /api/apps. Every render path is /:app/render/..., so the app check runs first for all of them. */
export function renderRoutes(opts: RenderRouteOptions): Hono {
  const routes = new Hono();

  routes.use('/:app/render/*', async (c, next) => {
    const app = c.req.param('app');
    if (!APP_NAME_RE.test(app)) return notFound(c);
    if (!(await opts.hasApp(app))) return c.json({ error: 'Unknown app' }, 404);
    await next();
  });

  routes.get('/:app/render/manifest.json', async (c) => {
    const bytes = await readOrNull(join(renderDir(opts.dataDir, c.req.param('app')), MANIFEST_PATH));
    return c.body(bytes ?? JSON.stringify(EMPTY_MANIFEST) + '\n', 200, {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
    });
  });

  routes.get('/:app/render/tiles/:key/:tile', async (c) => {
    const key = c.req.param('key');
    const tile = c.req.param('tile');
    if (!KEY_RE.test(key) || !TILE_RE.test(tile)) return notFound(c);
    const bytes = await readOrNull(join(renderDir(opts.dataDir, c.req.param('app')), 'tiles', key, tile));
    if (bytes === null) return notFound(c);
    return c.body(bytes, 200, { 'content-type': 'image/webp', 'cache-control': IMMUTABLE });
  });

  routes.get('/:app/render/hitmaps/:file', async (c) => {
    const file = c.req.param('file');
    if (!HITMAP_RE.test(file)) return notFound(c);
    const bytes = await readOrNull(join(renderDir(opts.dataDir, c.req.param('app')), 'hitmaps', file));
    if (bytes === null) return notFound(c);
    return c.body(bytes, 200, { 'content-type': 'application/json', 'cache-control': IMMUTABLE });
  });

  return routes;
}
