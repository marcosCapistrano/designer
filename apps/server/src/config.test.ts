import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, scrubEnv } from './config.js';

const FULL = {
  HUB_BIND: '127.0.0.1',
  HUB_PORT: '9000',
  HUB_DATA_DIR: 'data',
  HUB_APPS_DIR: '/srv/apps',
  HUB_PASSPHRASE_HASH: 'scrypt:x',
};

const tempDirs: string[] = [];

function makeCredentialsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-config-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads a full environment', () => {
    expect(loadConfig(FULL)).toEqual({
      bind: '127.0.0.1',
      port: 9000,
      dataDir: resolve('data'),
      appsDir: '/srv/apps',
      passphraseHash: 'scrypt:x',
      githubToken: null,
      githubOwner: null,
      claudeOauthToken: null,
    });
  });

  it('defaults the port to 8787', () => {
    const { HUB_PORT: _unused, ...withoutPort } = FULL;
    expect(loadConfig(withoutPort).port).toBe(8787);
  });

  it('lists every missing variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: HUB_BIND, HUB_DATA_DIR, HUB_APPS_DIR, HUB_PASSPHRASE_HASH',
    );
  });

  it('rejects wildcard binds', () => {
    for (const bind of ['0.0.0.0', '::', '[::]', '*']) {
      expect(() => loadConfig({ ...FULL, HUB_BIND: bind })).toThrow(/wildcard/);
    }
  });

  it('rejects a bad port', () => {
    for (const port of ['abc', '70000']) {
      expect(() => loadConfig({ ...FULL, HUB_PORT: port })).toThrow(/HUB_PORT/);
    }
  });

  it('rejects a hash that is not scrypt', () => {
    expect(() => loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: 'bcrypt:x' })).toThrow(
      'HUB_PASSPHRASE_HASH must come from: pnpm --silent -F @hub/server hash-passphrase',
    );
  });

  it('reads secrets from CREDENTIALS_DIRECTORY', () => {
    const dir = makeCredentialsDir({
      HUB_PASSPHRASE_HASH: 'scrypt:file\n',
      GITHUB_TOKEN: 'ghp_file\n',
    });
    const config = loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: undefined, CREDENTIALS_DIRECTORY: dir });
    expect(config.passphraseHash).toBe('scrypt:file');
    expect(config.githubToken).toBe('ghp_file');
  });

  it('prefers an environment value over the credentials file', () => {
    const dir = makeCredentialsDir({ HUB_PASSPHRASE_HASH: 'scrypt:file\n' });
    const config = loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir });
    expect(config.passphraseHash).toBe('scrypt:x');
  });
});

describe('scrubEnv', () => {
  it('removes secrets and keeps the rest', () => {
    expect(
      scrubEnv({
        PATH: '/bin',
        GITHUB_TOKEN: 'g',
        ANTHROPIC_API_KEY: 'k',
        CREDENTIALS_DIRECTORY: '/run/c',
        CLAUDE_CODE_OAUTH_TOKEN: 'o',
        U: undefined,
      }),
    ).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  });
});
