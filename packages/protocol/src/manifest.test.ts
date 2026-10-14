import { expect, test } from 'vitest';
import { parseAppManifest } from './manifest.js';

const SPEC_EXAMPLE = {
  name: 'myapp',
  template: 'vite-hono-pg@1',
  design: { dir: 'design', routes: 'web/src/routes.tsx', devices: ['desktop', 'tablet', 'mobile'] },
  build: { install: 'pnpm i', test: 'pnpm test', typecheck: 'pnpm typecheck' },
  deploy: {
    image: 'ghcr.io/marco/myapp',
    staging: { server: 'shared-staging', url: 'http://myapp.staging.tail1234.ts.net' },
    production: { server: 'shared-production', url: 'https://myapp.203.0.113.7.sslip.io', domain: null },
  },
};

function withPatch(patch: (doc: any) => void): string {
  const doc = structuredClone(SPEC_EXAMPLE);
  patch(doc);
  return JSON.stringify(doc);
}

test('accepts the spec example', () => {
  const result = parseAppManifest(JSON.stringify(SPEC_EXAMPLE));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.manifest.build.test).toBe('pnpm test');
});

test('rejects invalid JSON', () => {
  expect(parseAppManifest('{')).toEqual({ ok: false, error: '.hub/app.json is not valid JSON' });
});

test('names the failing field', () => {
  const result = parseAppManifest(withPatch((d) => { d.name = 'My App'; }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('name: ');
});

test('rejects an uppercase image', () => {
  const result = parseAppManifest(withPatch((d) => { d.deploy.image = 'ghcr.io/Marco/myapp'; }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('deploy.image');
});

test('rejects an unknown device', () => {
  const result = parseAppManifest(withPatch((d) => { d.design.devices = ['watch']; }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('design.devices.0');
});

test('domain may be a string', () => {
  const result = parseAppManifest(withPatch((d) => { d.deploy.production.domain = 'myapp.com'; }));
  expect(result.ok).toBe(true);
});

test('missing build section', () => {
  const result = parseAppManifest(withPatch((d) => { delete d.build; }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('build');
});

test('index re-exports nothing from the manifest module', async () => {
  const index = await import('./index.js');
  const manifest = await import('./manifest.js');
  const leaked = Object.keys(manifest).filter((name) => name in index);
  expect(leaked).toEqual([]);
  expect(Object.keys(manifest)).toContain('AppManifestSchema');
});

test('strips unknown keys', () => {
  const result = parseAppManifest(
    withPatch((d) => {
      d.extra = 'x';
      d.build.extra = 'y';
    }),
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect('extra' in result.manifest).toBe(false);
    expect('extra' in result.manifest.build).toBe(false);
  }
});

test('rejects an empty production domain', () => {
  const result = parseAppManifest(withPatch((d) => { d.deploy.production.domain = ''; }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('deploy.production.domain');
});
