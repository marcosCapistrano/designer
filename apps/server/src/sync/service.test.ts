import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@hub/protocol';
import { FsSyncStore } from '@hub/sync';
import { SyncService, type SyncDeps } from './service.js';
import { syncRoutes } from './routes.js';
import { Hono } from 'hono';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'hub-import-service-'));
  const store = new FsSyncStore(root);
  const source = { project: { files: { 'app/page.tsx': 'export default () => <main>Hello</main>' } }, commit: 'abc123' };
  const messages: ServerMsg[] = [];
  const deps: SyncDeps = {
    dataDir: root,
    registry: { get: async (name) => name === 'demo' ? { name, dir: root, adopted: false, manifest: null, manifestError: null } : null },
    build: { withCheckout: async (_app, action) => action() },
    store: () => store,
    readSource: vi.fn(async () => source),
    hub: { broadcast: (message) => { messages.push(message); } },
    render: vi.fn(async () => ({ manifest: { version: 1 as const, pages: [] }, warnings: [] })),
  };
  const service = new SyncService(deps);
  return { service, deps, store, source, messages };
}
describe('import service', () => {
  it('saves and renders source without executing the app, then reuses its baseline', async () => {
    const s = await setup();
    expect(await s.service.summary('demo')).toMatchObject({ imported: false, pending: 0 });
    const first = await s.service.import('demo', { mode: 'next' });
    expect(first).toMatchObject({ ok: true, rebuilt: ['/'], reused: [], warnings: [] });
    expect(s.messages).toMatchObject([{ type: 'render.ready', app: 'demo' }]);
    expect(await s.service.summary('demo')).toMatchObject({ imported: true, pages: [{ route: '/' }] });
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, reused: ['/'], rebuilt: [] });
    await s.service.close();
  });
  it('preserves the previous snapshot on unsupported source and on read failure', async () => {
    const s = await setup();
    await s.service.import('demo', { mode: 'next' });
    const previous = await s.store.load();
    s.source.project.files['app/page.tsx'] = 'export default () => <p>{fetch("/")}</p>';
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source' });
    expect(await s.store.load()).toEqual(previous);
    s.deps.readSource = async () => { throw new Error('dirty checkout'); };
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ message: 'dirty checkout' }] });
    expect(await s.store.load()).toEqual(previous);
    await s.service.close();
  });
  it('keeps saved design on render failure and lets the user retry preview', async () => {
    const s = await setup();
    s.deps.render = async () => { throw new Error('browser unavailable'); };
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, manifest: null, warnings: [expect.stringContaining('Preview')] });
    expect(await s.store.load()).not.toBeNull();
    s.deps.render = async () => ({ manifest: { version: 1, pages: [] }, warnings: [] });
    expect(await s.service.retryPreview('demo')).toMatchObject({ warnings: [] });
    await s.service.close();
  });
  it('does not read source for unknown or unsafe apps and respects checkout reservation failures', async () => {
    const s = await setup();
    await expect(s.service.import('../secret', { mode: 'next' })).rejects.toMatchObject({ status: 404 });
    expect(s.deps.readSource).not.toHaveBeenCalled();
    s.deps.build.withCheckout = async () => { throw new Error('busy'); };
    await expect(s.service.import('demo', { mode: 'next' })).rejects.toThrow('busy');
    expect(await s.store.load()).toBeNull();
    await s.service.close();
  });
  it('rejects malformed route input before invoking import', async () => {
    const s = await setup();
    const app = new Hono().route('/api/apps', syncRoutes(s.service));
    for (const body of [{ mode: 'react', entries: [{ route: '/', file: '../secret.tsx' }] }, { mode: 'react', entries: [] }, { mode: 'next', appDir: '/etc' }, { mode: 'other' }]) {
      const res = await app.request('/api/apps/demo/design/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(s.deps.readSource).not.toHaveBeenCalled();
    await s.service.close();
  });
});
