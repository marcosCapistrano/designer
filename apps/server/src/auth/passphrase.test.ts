import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashPassphrase, verifyPassphrase } from './passphrase.js';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const tsx = join(serverDir, 'node_modules/.bin/tsx');
const cli = 'src/auth/hash-cli.ts';

describe('passphrase', () => {
  it('hash has the documented format', () => {
    expect(hashPassphrase('correct horse battery')).toMatch(
      /^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/,
    );
  });

  it('verifies only the right passphrase', () => {
    const hash = hashPassphrase('correct horse battery');
    expect(verifyPassphrase('correct horse battery', hash)).toBe(true);
    expect(verifyPassphrase('correct horse batterx', hash)).toBe(false);
  });

  it('random salt makes hashes differ', () => {
    expect(hashPassphrase('correct horse battery')).not.toBe(hashPassphrase('correct horse battery'));
  });

  it('fixed salt is deterministic', () => {
    const salt = Buffer.alloc(16, 1);
    const first = hashPassphrase('correct horse battery', salt);
    expect(hashPassphrase('correct horse battery', salt)).toBe(first);
  });

  it('malformed hashes never verify', () => {
    for (const stored of ['', 'scrypt:1', 'bcrypt:a:b:c:d:e', 'scrypt:16384:8:1:@@:@@']) {
      expect(() => verifyPassphrase('correct horse battery', stored)).not.toThrow();
      expect(verifyPassphrase('correct horse battery', stored)).toBe(false);
    }
  });

  it('cli prints a hash', () => {
    const out = execFileSync(tsx, [cli], {
      cwd: serverDir,
      input: 'a long passphrase\n',
      encoding: 'utf8',
    });
    expect(verifyPassphrase('a long passphrase', out.trim())).toBe(true);
  });

  it('cli rejects short passphrases', () => {
    let caught: unknown;
    try {
      execFileSync(tsx, [cli], { cwd: serverDir, input: 'short', encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ status: 1 });
    expect(String((caught as { stderr?: unknown }).stderr)).toContain(
      'Passphrase must be at least 12 characters',
    );
  });
});
