import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRegistry } from '../apps/registry.js';
import { LoginLimiter } from '../auth/limiter.js';
import { hashPassphrase } from '../auth/passphrase.js';
import { SessionStore } from '../auth/sessions.js';
import { createApp } from '../app.js';
import type { BuildService } from '../build/service.js';
import { openDb, type Db } from '../db.js';
import { SyncService } from '../sync/service.js';
import { CanvasFrames } from './frames.js';

const PASS = 'correct horse battery staple';
let db: Db;
let root: string;
let app: Hono;
const ensureRendered = vi.fn();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-frames-'));
  mkdirSync(join(root, 'apps', 'demo', '.git'), { recursive: true });
  ensureRendered.mockReset();
  db = openDb(':memory:');
  app = createApp({
    sessions: new SessionStore(db),
    limiter: new LoginLimiter(),
    passphraseHash: hashPassphrase(PASS, Buffer.alloc(16, 1)),
    registry: new AppRegistry(join(root, 'apps')),
    build: {} as unknown as BuildService,
    sync: { ensureRendered } as unknown as SyncService,
    frames: new CanvasFrames({ db, pages: async () => [{ pageId: 'p1' }], manifest: async () => null }),
    dataDir: join(root, 'data'),
  });
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

async function auth(): Promise<Record<string, string>> {
  const res = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
  const m = /hub_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return { cookie: `hub_session=${m![1]}`, 'sec-fetch-site': 'same-origin' };
}
const put = (h: Record<string, string>, body: unknown, name = 'demo') =>
  app.request(`/api/apps/${name}/design/frames`, { method: 'PUT', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('frame routes', () => {
  it('GET returns frames and triggers ensureRendered once', async () => {
    const h = await auth();
    const res = await app.request('/api/apps/demo/design/frames', { headers: h });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { frames: unknown[] }).frames).toHaveLength(3);
    expect(ensureRendered).toHaveBeenCalledTimes(1);
    expect(ensureRendered).toHaveBeenCalledWith('demo');
  });

  it('PUT valid round-trips through GET and triggers ensureRendered once', async () => {
    const h = await auth();
    const frames = [{ id: 'f0123456789abcdef', pageId: 'p1', x: 0, y: 8, width: 1280, viewportHeight: 800 }];
    const res = await put(h, { frames });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ frames });
    expect(ensureRendered).toHaveBeenCalledTimes(1);
    const got = await app.request('/api/apps/demo/design/frames', { headers: h });
    expect(await got.json()).toEqual({ frames });
  });

  it('PUT invalid is 400 with the validation message and no render', async () => {
    const h = await auth();
    const res = await put(h, { frames: [{ id: 'f0123456789abcdef', pageId: 'p1', x: 0, y: 0, width: 239, viewportHeight: 800 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'frames[0].width must be an integer from 240 to 3840' });
    expect(ensureRendered).not.toHaveBeenCalled();
    expect((await put(h, { nope: 1 })).status).toBe(400);
  });

  it('requires a session and a known app', async () => {
    const res = await app.request('/api/apps/demo/design/frames', { method: 'PUT', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"frames":[]}' });
    expect(res.status).toBe(401);
    const h = await auth();
    expect((await app.request('/api/apps/nope/design/frames', { headers: h })).status).toBe(404);
    expect((await put(h, { frames: [] }, 'nope')).status).toBe(404);
  });

  it('PUT with a new size schedules one render even when sent twice quickly', async () => {
    const frames = new CanvasFrames({ db, pages: async () => [{ pageId: 'p1' }], manifest: async () => null });
    const sync = new SyncService({
      registry: new AppRegistry(join(root, 'apps')), build: { withCheckout: async (_a: string, f: () => unknown) => f() } as never,
      hub: { broadcast: () => {} }, dataDir: join(root, 'data'), frames,
    });
    let finish!: () => void;
    const retry = vi.spyOn(sync, 'retryPreview').mockImplementation(() => new Promise((resolve) => { finish = () => { resolve({ manifest: null, warnings: [] }); }; }));
    const real = createApp({
      sessions: new SessionStore(db), limiter: new LoginLimiter(), passphraseHash: hashPassphrase(PASS, Buffer.alloc(16, 1)),
      registry: new AppRegistry(join(root, 'apps')), build: {} as unknown as BuildService, sync, frames, dataDir: join(root, 'data'),
    });
    const login = await real.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: PASS }) });
    const h = { cookie: `hub_session=${/hub_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const body = JSON.stringify({ frames: [{ id: 'f0123456789abcdef', pageId: 'p1', x: 0, y: 0, width: 1280, viewportHeight: 800 }] });
    expect((await real.request('/api/apps/demo/design/frames', { method: 'PUT', headers: h, body })).status).toBe(200);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect((await real.request('/api/apps/demo/design/frames', { method: 'PUT', headers: h, body })).status).toBe(200);
    expect(retry).toHaveBeenCalledTimes(1); // second PUT during the render does not start a second one
    finish(); // the manifest stays null, so the re-check after the render runs exactly one more
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    finish();
    await sync.whenRendered('demo');
    await sync.close();
  });
});
