import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '@hub/protocol';
import type { AppManifest } from '@hub/protocol/manifest';
import { FsSyncStore } from '@hub/sync';
import { SyncService, type SyncDeps } from './service.js';
import { syncRoutes } from './routes.js';
import { Hono } from 'hono';

function manifest(design: Partial<AppManifest['design']> = {}): AppManifest {
  return {
    name: 'demo', template: 'next-adopted@1', design: { dir: 'design', routes: 'app', devices: ['desktop'], ...design },
    build: { install: 'true', test: 'true', typecheck: 'true' },
    deploy: { image: 'ghcr.io/acme/demo', staging: { server: 'none', url: 'http://localhost' }, production: { server: 'none', url: 'http://localhost', domain: null } },
  };
}
async function setup(files: Record<string, string> = { 'app/page.tsx': 'export default () => <main>Hello</main>' }, appManifest: AppManifest | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'hub-import-service-'));
  const store = new FsSyncStore(root);
  const source: { project: { files: Record<string, string> }; commit: string; config: Record<string, string> } = { project: { files }, commit: 'abc123', config: {} };
  const messages: ServerMsg[] = [];
  const deps: SyncDeps = {
    dataDir: root,
    registry: { get: async (name) => name === 'demo' ? { name, dir: root, adopted: appManifest !== null, manifest: appManifest, manifestError: null } : null },
    build: { withCheckout: async (_app, action) => action() },
    store: () => store,
    readSource: vi.fn(async () => source),
    hub: { broadcast: (message) => { messages.push(message); } },
    render: vi.fn(async () => ({ manifest: { version: 2 as const, pages: [] }, warnings: [] })),
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
  it('preserves the previous design on unsupported source and the previous snapshot on read failure', async () => {
    const s = await setup();
    await s.service.import('demo', { mode: 'next' });
    let previous = await s.store.load();
    s.source.project.files['app/page.tsx'] = 'export default () => <p>{fetch("/")}</p>';
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: [], reused: [], failed: [{ route: '/', diagnostics: [{ file: 'app/page.tsx' }] }] });
    expect((await s.store.load())!.state.doc).toEqual(previous!.state.doc);
    previous = await s.store.load();
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
    s.deps.render = async () => ({ manifest: { version: 2, pages: [] }, warnings: [] });
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
  it('partial import keeps good routes and the old failed route', async () => {
    const s = await setup({ 'app/page.tsx': 'export default () => <main>Hello</main>', 'app/login/page.tsx': 'export default () => <form>Login</form>' });
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/', '/login'], failed: [] });
    const before = (await s.store.load())!.state.doc;
    const login = Object.values(before.pages).find((page) => page.route === '/login')!;
    s.source.project.files['app/page.tsx'] = 'export default () => <main>Changed</main>';
    s.source.project.files['app/login/page.tsx'] = 'export default () => <form>{fetch("/")}</form>';
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/'], failed: [{ route: '/login', diagnostics: [{ file: 'app/login/page.tsx', message: expect.any(String) }] }] });
    const after = (await s.store.load())!.state.doc;
    expect(after.pages[login.id]).toEqual(login);
    expect(JSON.stringify(Object.values(after.pages).find((page) => page.route === '/'))).toContain('Changed');
    await s.service.close();
  });
  it('fails a first import where no route succeeds, saving nothing', async () => {
    const s = await setup({ 'app/page.tsx': 'export default () => <p>{fetch("/")}</p>' });
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: 'app/page.tsx' }] });
    expect(await s.store.load()).toBeNull();
    await s.service.close();
  });
  it('design.include: ["/login"] imports only /login, for Next discovery and explicit React entries', async () => {
    const s = await setup({ 'app/page.tsx': 'export default () => <main>{fetch("/")}</main>', 'app/login/page.tsx': 'export default () => <form>Login</form>', 'app/(a)/x/page.tsx': '', 'app/(b)/x/page.tsx': '' }, manifest({ include: ['/login'] }));
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/login'], failed: [] });
    expect((await s.service.summary('demo')).pages.map((page) => page.route)).toEqual(['/login']);
    expect(await s.service.import('demo', { mode: 'react', entries: [{ route: '/', file: 'app/page.tsx' }, { route: '/login', file: 'app/login/page.tsx' }] })).toMatchObject({ ok: true, rebuilt: ['/login'], failed: [] });
    expect(await s.service.import('demo', { mode: 'react', entries: [{ route: '/', file: 'app/page.tsx' }] })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: '.hub/app.json', message: expect.stringContaining('design.include') }] });
    await s.service.close();
  });
  it('uses design.routes as the Next app directory when the request names none', async () => {
    const s = await setup({ 'site/src/app/page.tsx': 'export default () => <main>Site</main>', 'app/page.tsx': 'export default () => <main>Other</main>' }, manifest({ routes: 'site/src/app' }));
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/'] });
    expect(JSON.stringify((await s.store.load())!.state.doc)).toContain('Site');
    expect(await s.service.import('demo', { mode: 'next', appDir: 'app' })).toMatchObject({ ok: true, rebuilt: ['/'] });
    expect(JSON.stringify((await s.store.load())!.state.doc)).toContain('Other');
    const fallback = await setup({ 'src/app/page.tsx': 'export default () => <main>Src</main>' }, manifest({ routes: 'web/src/routes.tsx' }));
    expect(await fallback.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/'] });
    await s.service.close(); await fallback.service.close();
  });
  it('resolves tsconfig path aliases and applies .hub/adapters.json, failing explicitly on invalid configuration', async () => {
    const s = await setup({ 'site/src/app/page.tsx': `import { Logo } from '@/ui/logo'; import Link from 'next/link'; export default () => <main><Logo /><Link href="/x">Go</Link></main>`, 'site/src/ui/logo.tsx': 'export function Logo() { return <b>Logo</b>; }' }, manifest({ routes: 'site/src/app' }));
    s.source.config = { 'site/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] }, }, // jsonc\n}', '.hub/adapters.json': JSON.stringify({ modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { href: 'href' } } } } }) };
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, rebuilt: ['/'], failed: [] });
    const saved = JSON.stringify((await s.store.load())!.state.doc);
    expect(saved).toContain('Logo'); expect(saved).toContain('"href":"/x"');
    const before = await s.store.load();
    s.source.config['.hub/adapters.json'] = '{ "modules": { "next/link": {} } }';
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: '.hub/adapters.json' }] });
    s.source.config['.hub/adapters.json'] = '{}}';
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: '.hub/adapters.json' }] });
    s.source.config = { 'site/tsconfig.json': '{ "extends": "./base.json" }' };
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: 'site/tsconfig.json', message: expect.stringContaining('extends') }] });
    expect(await s.store.load()).toEqual(before);
    await s.service.close();
  });
  it('reports source-only rules and inlined components in the import and the summary', async () => {
    const s = await setup({ 'app/page.tsx': `import './page.css'; import { Card } from './card'; export default () => <main><Card><p>Hi</p></Card></main>`, 'app/card.tsx': 'export function Card({ children }) { return <section>{children}</section>; }', 'app/page.css': 'main { color: red; } main:hover { color: blue; } @media print { main { color: black; } }' });
    const inlined = [{ route: '/', component: 'Card', file: 'app/card.tsx', reason: 'children' }];
    expect(await s.service.import('demo', { mode: 'next' })).toMatchObject({ ok: true, sourceOnlyRules: 2, inlined });
    expect(await s.service.summary('demo')).toMatchObject({ sourceOnlyRules: 2, inlined });
    await s.service.close();
  });
});
