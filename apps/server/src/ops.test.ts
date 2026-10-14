import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashPassphrase } from './auth/passphrase.js';
import { CREDENTIAL_KEYS, loadConfig } from './config.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const read = (file: string): string => readFileSync(join(root, file), 'utf8');

const SCRIPTS = ['ops/hub/bootstrap.sh', 'ops/hub/set-secret.sh', 'ops/hub/check-claude.sh'] as const;

const OPS_FILES = [
  'ops/hub/bootstrap.sh',
  'ops/hub/hub.service',
  'ops/hub/hub.env.example',
  'ops/hub/set-secret.sh',
  'ops/hub/check-claude.sh',
  'docs/hub-bootstrap.md',
] as const;

/** Parses KEY=value lines of an env file (comments and blank lines are skipped). */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of text.matchAll(/^([A-Z_]+)=(.*)$/gm)) {
    env[match[1] ?? ''] = match[2] ?? '';
  }
  return env;
}

describe('hub server bootstrap', () => {
  it('scripts parse', () => {
    for (const file of SCRIPTS) {
      expect(() => execFileSync('bash', ['-n', file], { cwd: root })).not.toThrow();
    }
  });

  it('nothing sets ANTHROPIC_API_KEY', () => {
    for (const file of OPS_FILES) {
      expect(read(file)).not.toMatch(/^\s*(export\s+)?ANTHROPIC_API_KEY=/m);
    }
  });

  it('unit runs as hub with encrypted credentials and no API key', () => {
    const lines = read('ops/hub/hub.service').split('\n');
    for (const line of [
      'User=hub',
      'EnvironmentFile=/etc/hub/hub.env',
      'LoadCredentialEncrypted=HUB_PASSPHRASE_HASH',
      'LoadCredentialEncrypted=GITHUB_TOKEN',
      'LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN',
      'UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN',
      'ExecStart=/opt/hub/apps/server/node_modules/.bin/tsx /opt/hub/apps/server/src/main.ts',
      'Restart=on-failure',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('env example holds only non-secret settings', () => {
    const example = read('ops/hub/hub.env.example');
    const keys = [...example.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1] ?? '');
    expect(keys).toEqual(['HUB_BIND', 'HUB_PORT', 'HUB_DATA_DIR', 'HUB_APPS_DIR', 'GITHUB_OWNER']);
    for (const key of keys) {
      expect(CREDENTIAL_KEYS).not.toContain(key);
    }
  });

  it('example env plus the passphrase credential loads', () => {
    const parsedExample = parseEnv(read('ops/hub/hub.env.example'));
    const config = loadConfig({ ...parsedExample, HUB_PASSPHRASE_HASH: hashPassphrase('x'.repeat(12)) });
    expect(config.bind).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
  });

  it('docs give the exact commands', () => {
    const docs = read('docs/hub-bootstrap.md');
    for (const text of [
      'claude setup-token',
      'set-secret.sh CLAUDE_CODE_OAUTH_TOKEN',
      'check-claude.sh',
      'tailscale serve --bg --https=443 http://127.0.0.1:8787',
      'ufw delete allow OpenSSH',
    ]) {
      expect(docs).toContain(text);
    }
  });

  it('set-secret only accepts known names', () => {
    const result = spawnSync('bash', ['ops/hub/set-secret.sh', 'BOGUS'], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Unknown secret BOGUS');
  });

  it('set-secret reads stdin without a trailing newline and still fails on empty input', () => {
    // Runs only the stdin read statement copied from set-secret.sh, under the script's set -euo pipefail.
    const statement = /IFS= read -r value[^\n;]*/.exec(read('ops/hub/set-secret.sh'))?.[0];
    expect(statement).toBeDefined();
    const probe = `set -euo pipefail\n${statement}\nprintf '%s' "$value"`;

    const bare = spawnSync('bash', ['-c', probe], { input: 'ghp_example', encoding: 'utf8' });
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe('ghp_example');

    const newline = spawnSync('bash', ['-c', probe], { input: 'scrypt:x\n', encoding: 'utf8' });
    expect(newline.status).toBe(0);
    expect(newline.stdout).toBe('scrypt:x');

    const empty = spawnSync('bash', ['-c', probe], { input: '', encoding: 'utf8' });
    expect(empty.status).not.toBe(0);
  });

  it('git gets the GitHub header from its environment, never from an argument', () => {
    for (const file of ['ops/hub/bootstrap.sh', 'docs/hub-bootstrap.md']) {
      const text = read(file);
      for (const line of text.split('\n')) {
        if (line.includes('extraheader')) expect(line, file).not.toMatch(/\s-c\s/);
      }
      expect(text, file).toContain('GIT_CONFIG_KEY_0=http.https://github.com/.extraheader');
      expect(text, file).toContain('GIT_CONFIG_VALUE_0=');
    }
  });
});
