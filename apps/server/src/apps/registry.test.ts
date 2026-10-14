import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRegistry } from './registry.js';

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

function manifestFor(name: string): string {
  return JSON.stringify({ ...SPEC_EXAMPLE, name });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-registry-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCheckout(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function writeManifest(name: string, text: string): void {
  const hubDir = join(root, name, '.hub');
  mkdirSync(hubDir, { recursive: true });
  writeFileSync(join(hubDir, 'app.json'), text);
}

describe('AppRegistry', () => {
  it('lists git checkouts only, sorted', async () => {
    makeCheckout('zeta');
    mkdirSync(join(root, 'alpha'));
    writeFileSync(join(root, 'alpha', '.git'), 'gitdir: ../.git/modules/alpha\n');
    mkdirSync(join(root, 'notgit'));
    makeCheckout('.hidden');
    writeFileSync(join(root, 'readme.txt'), 'not an app');

    const entries = await new AppRegistry(root).list();

    expect(entries.map((e) => e.name)).toEqual(['alpha', 'zeta']);
  });

  it('valid manifest means adopted', async () => {
    makeCheckout('alpha');
    writeManifest('alpha', manifestFor('alpha'));

    const entry = await new AppRegistry(root).get('alpha');

    expect(entry?.adopted).toBe(true);
    expect(entry?.manifestError).toBeNull();
    expect(entry?.manifest?.name).toBe('alpha');
  });

  it('invalid manifest reports the error', async () => {
    makeCheckout('alpha');
    writeManifest('alpha', '{');

    const entry = await new AppRegistry(root).get('alpha');

    expect(entry?.manifestError).toBe('.hub/app.json is not valid JSON');
    expect(entry?.adopted).toBe(false);
    expect(entry?.manifest).toBeNull();
  });

  it('manifest name must match the folder', async () => {
    makeCheckout('alpha');
    writeManifest('alpha', manifestFor('other'));

    const entry = await new AppRegistry(root).get('alpha');

    expect(entry?.manifestError).toContain('does not match the folder name "alpha"');
    expect(entry?.adopted).toBe(false);
  });

  it('get returns null for unknown or unsafe names', async () => {
    makeCheckout('alpha');
    const registry = new AppRegistry(root);

    expect(await registry.get('nope')).toBeNull();
    expect(await registry.get('..')).toBeNull();
    expect(await registry.get('.')).toBeNull();
    expect(await registry.get('a/b')).toBeNull();
    expect(await registry.get('a\\b')).toBeNull();
    expect(await registry.get('.hidden')).toBeNull();
    expect(await registry.get('')).toBeNull();
    expect((await registry.get('alpha'))?.name).toBe('alpha');
  });

  it('missing apps dir lists nothing', async () => {
    const registry = new AppRegistry(join(root, 'does-not-exist'));

    expect(await registry.list()).toEqual([]);
  });
});
