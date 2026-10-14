import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hitMapPath, MANIFEST_PATH, tilePath, type RenderManifest } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MANIFEST, renderDir, renderRoutes } from './render-files.js';

const K = 'a'.repeat(64);
const IMMUTABLE = 'private, max-age=31536000, immutable';
const TILE = Buffer.from([0, 1, 2, 250, 255, 82, 73, 70, 70]);
const HITS = [{ nodeId: 'n5/n6', x: 1, y: 2, w: 3, h: 4 }];
const MANIFEST: RenderManifest = {
  version: 1,
  pages: [
    {
      pageId: 'home',
      name: 'Home',
      route: '/',
      renders: { base: { device: 'base', hash: K, width: 1440, height: 900, levels: [{ zoom: 1, key: K, cols: 1, rows: 1 }] } },
    },
  ],
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hub-render-files-'));
  const dir = renderDir(dataDir, 'demo');
  mkdirSync(join(dir, 'tiles', K), { recursive: true });
  writeFileSync(join(dir, tilePath(K, 0, 0)), TILE);
  mkdirSync(join(dir, 'hitmaps'), { recursive: true });
  writeFileSync(join(dir, hitMapPath(K)), JSON.stringify(HITS));
  writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(MANIFEST) + '\n');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const knownApps = async (app: string): Promise<boolean> => app === 'demo' || app === 'empty';

function server(hasApp: (app: string) => Promise<boolean> = knownApps): Hono {
  return new Hono().route('/api/apps', renderRoutes({ dataDir, hasApp }));
}

describe('render file endpoints', () => {
  it('serves the manifest without caching', async () => {
    const res = await server().request('/api/apps/demo/render/manifest.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.json()).toEqual(MANIFEST);
  });

  it('missing manifest is empty', async () => {
    const res = await server().request('/api/apps/empty/render/manifest.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, pages: [] });
    expect(EMPTY_MANIFEST).toEqual({ version: 1, pages: [] });
  });

  it('serves tiles as immutable webp', async () => {
    const res = await server().request(`/api/apps/demo/render/tiles/${K}/0_0.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(TILE);
  });

  it('serves hit maps', async () => {
    const res = await server().request(`/api/apps/demo/render/hitmaps/${K}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(await res.json()).toEqual(HITS);
  });

  it('unknown app is 404', async () => {
    const app = server();
    const manifest = await app.request('/api/apps/nope/render/manifest.json');
    expect(manifest.status).toBe(404);
    expect(await manifest.json()).toEqual({ error: 'Unknown app' });
    const tile = await app.request(`/api/apps/nope/render/tiles/${K}/0_0.webp`);
    expect(tile.status).toBe(404);
    expect(await tile.json()).toEqual({ error: 'Unknown app' });
  });

  it('rejects malformed names', async () => {
    const app = server();
    const paths = [
      `/api/apps/demo/render/tiles/..%2F..%2Fetc/0_0.webp`,
      `/api/apps/demo/render/tiles/abc/0_0.webp`,
      `/api/apps/demo/render/tiles/${K}/x_y.webp`,
      `/api/apps/demo/render/hitmaps/..%2Fx.json`,
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'Not found' });
    }
  });

  it('missing tile is 404', async () => {
    const res = await server().request(`/api/apps/demo/render/tiles/${K}/9_9.webp`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('path segments never reach outside the render dir', () => {
  it('rejects traversal, separators and absolute paths in every URL segment', async () => {
    const app = server();
    const paths = [
      `/api/apps/demo/render/tiles/${K}/..%2F0_0.webp`,
      `/api/apps/demo/render/tiles/..%2F${K}/0_0.webp`,
      `/api/apps/demo/render/tiles/%2Fetc%2Fpasswd/0_0.webp`,
      `/api/apps/demo/render/tiles/${K}/%2Fetc%2Fpasswd.webp`,
      `/api/apps/demo/render/tiles/..%5C..%5C${K}/0_0.webp`,
      `/api/apps/demo/render/tiles/%252e%252e%252f${K}/0_0.webp`,
      `/api/apps/demo/render/hitmaps/%2Fetc%2Fpasswd.json`,
      `/api/apps/demo/render/hitmaps/..%2F${K}.json`,
      `/api/apps/demo/render/hitmaps/${K}.json%2F..%2F..%2Fmanifest.json`,
      `/api/apps/demo/render/hitmaps/..%5C${K}.json`,
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'Not found' });
    }
  });

  it('encoded dot segments do not match any route', async () => {
    const app = server();
    for (const path of [
      `/api/apps/demo/render/tiles/%2e%2e/0_0.webp`,
      `/api/apps/demo/render/hitmaps/%2e%2e.json`,
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('rejects malformed app names before asking the registry', async () => {
    const hasApp = vi.fn(async () => true);
    const app = server(hasApp);
    const paths = [
      `/api/apps/..%2F..%2Fdemo/render/manifest.json`,
      `/api/apps/..%2Fdemo/render/tiles/${K}/0_0.webp`,
      `/api/apps/%2Fdemo/render/manifest.json`,
      `/api/apps/Demo/render/manifest.json`,
      `/api/apps/-demo/render/manifest.json`,
      `/api/apps/demo%00/render/manifest.json`,
    ];
    for (const path of paths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'Not found' });
    }
    expect(hasApp).not.toHaveBeenCalled();
  });

  it('answers 404, not 500, for a tile name too long for the filesystem', async () => {
    const app = server();
    const digits = '9'.repeat(300);
    for (const tile of [`${digits}_0.webp`, `0_${digits}.webp`, `${digits}_${digits}.webp`]) {
      const res = await app.request(`/api/apps/demo/render/tiles/${K}/${tile}`);
      expect(res.status, tile.slice(0, 20)).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('serves tiles with several-digit coordinates', async () => {
    const dir = renderDir(dataDir, 'demo');
    writeFileSync(join(dir, tilePath(K, 12, 345)), TILE);
    const res = await server().request(`/api/apps/demo/render/tiles/${K}/12_345.webp`);
    expect(res.status).toBe(200);
  });

  it('never serves files outside the render dir', async () => {
    const dir = renderDir(dataDir, 'demo');
    // Targets that a traversal would reach if the segments were joined unchecked.
    writeFileSync(join(dataDir, 'renders', `${K}.json`), 'SECRET-HITMAP');
    writeFileSync(join(dir, 'tiles', '0_0.webp'), 'SECRET-TILE');
    writeFileSync(join(dataDir, 'renders', 'secret.txt'), 'SECRET-DATA');
    const app = server();
    for (const path of [
      `/api/apps/demo/render/hitmaps/..%2F..%2F${K}.json`,
      `/api/apps/demo/render/tiles/${K}/..%2F0_0.webp`,
      `/api/apps/demo/render/tiles/${K}/..%2F..%2F..%2Fsecret.txt`,
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('SECRET');
    }
  });
});
