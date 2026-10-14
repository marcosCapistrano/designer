import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, SECRET_ENV_KEYS, isWildcardBind, loadConfig, scrubEnv } from './config.js';

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

  it('rejects every other spelling of an all-interface bind', () => {
    const spellings = [
      '0', // Node binds this to 0.0.0.0
      '00',
      '0x0',
      '0.0',
      '0.0.0',
      '0.0.0.00',
      '000.000.000.000',
      '0x0.0x0.0x0.0x0',
      '::0',
      '[::0]',
      '0::0',
      '0:0:0:0:0:0:0:0',
      '0000:0000:0000:0000:0000:0000:0000:0000',
      '[0:0:0:0:0:0:0:0]',
      '::%eth0',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '::0.0.0.0',
      ' 0 ',
    ];
    for (const bind of spellings) {
      expect(isWildcardBind(bind), bind).toBe(true);
      expect(() => loadConfig({ ...FULL, HUB_BIND: bind }), bind).toThrow(/wildcard/);
    }
  });

  it('accepts a specific address', () => {
    const specific = ['127.0.0.1', '100.64.0.5', '10.0.0.0', '0.0.0.1', '1.0.0.0', '::1', '[::1]', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', 'localhost'];
    for (const bind of specific) {
      expect(isWildcardBind(bind), bind).toBe(false);
      expect(loadConfig({ ...FULL, HUB_BIND: bind }).bind, bind).toBe(bind);
    }
  });

  it('rejects a bad port', () => {
    for (const port of ['abc', '70000', '0', '65536', '-1', '80.5', '1e3', '8787abc', '0x50']) {
      expect(() => loadConfig({ ...FULL, HUB_PORT: port }), port).toThrow(/HUB_PORT/);
    }
  });

  it('accepts the port bounds', () => {
    expect(loadConfig({ ...FULL, HUB_PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...FULL, HUB_PORT: '65535' }).port).toBe(65535);
  });

  it('treats a blank HUB_PORT as unset', () => {
    expect(loadConfig({ ...FULL, HUB_PORT: '  ' }).port).toBe(8787);
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

  it('treats blank environment values as unset and falls through to the credentials file', () => {
    const dir = makeCredentialsDir({ HUB_PASSPHRASE_HASH: 'scrypt:file\n', GITHUB_TOKEN: 'ghp_file\n' });
    const config = loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: '  ', GITHUB_TOKEN: '', CREDENTIALS_DIRECTORY: dir });
    expect(config.passphraseHash).toBe('scrypt:file');
    expect(config.githubToken).toBe('ghp_file');
  });

  it('treats an empty or whitespace-only credential file as absent', () => {
    const dir = makeCredentialsDir({ GITHUB_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: ' \n' });
    const config = loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir });
    expect(config.githubToken).toBeNull();
    expect(config.claudeOauthToken).toBeNull();
    expect(() => loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: undefined, CREDENTIALS_DIRECTORY: dir })).toThrow(
      'Missing required environment variables: HUB_PASSPHRASE_HASH',
    );
  });

  it('treats a missing credential file as absent', () => {
    const dir = makeCredentialsDir({});
    expect(loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir }).githubToken).toBeNull();
  });

  it('fails with a ConfigError, not the raw fs error, when a credential cannot be read', () => {
    const dir = makeCredentialsDir({});
    mkdirSync(join(dir, 'GITHUB_TOKEN'));
    let error: unknown;
    try {
      loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('GITHUB_TOKEN');
    expect((error as Error).message).toContain('EISDIR');
    expect((error as Error).message).not.toContain(dir);
  });

  it.skipIf(process.getuid?.() === 0)('fails with a ConfigError when a credential file is unreadable', () => {
    const dir = makeCredentialsDir({ GITHUB_TOKEN: 'ghp_secret' });
    chmodSync(join(dir, 'GITHUB_TOKEN'), 0o000);
    expect(() => loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir })).toThrow(ConfigError);
  });

  it('prefers an environment value over the credentials file', () => {
    const dir = makeCredentialsDir({ HUB_PASSPHRASE_HASH: 'scrypt:file\n' });
    const config = loadConfig({ ...FULL, CREDENTIALS_DIRECTORY: dir });
    expect(config.passphraseHash).toBe('scrypt:x');
  });
});

describe('scrubEnv', () => {
  it('removes every secret key', () => {
    const env = Object.fromEntries(SECRET_ENV_KEYS.map((key) => [key, `value-of-${key}`]));
    expect(scrubEnv({ ...env, KEEP: 'yes' })).toEqual({ KEEP: 'yes' });
  });

  it('does not mutate its input', () => {
    const env = { PATH: '/bin', GITHUB_TOKEN: 'g' };
    scrubEnv(env);
    expect(env).toEqual({ PATH: '/bin', GITHUB_TOKEN: 'g' });
  });

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
    ).toEqual({ PATH: '/bin' });
  });
});
