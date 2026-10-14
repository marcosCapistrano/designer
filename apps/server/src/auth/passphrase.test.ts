import { execFileSync, spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashPassphrase, SCRYPT_PARAMS, verifyPassphrase } from './passphrase.js';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const tsx = join(serverDir, 'node_modules/.bin/tsx');
const cli = 'src/auth/hash-cli.ts';

/** A hash string with the standard cost parameters but any salt, even one hashPassphrase would never produce. */
function scryptHash(passphrase: string, salt: Buffer): string {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const key = scryptSync(passphrase, salt, keylen, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

function runCli(input: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(tsx, [cli], { cwd: serverDir, input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

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

  describe('weak stored hashes fail closed', () => {
    const PASS = 'correct horse battery';
    const salt = Buffer.alloc(16, 1);
    const good = hashPassphrase(PASS, salt);
    const [, n, r, p, saltText, keyText] = good.split(':') as [string, string, string, string, string, string];
    const rebuild = (parts: { n?: string; r?: string; p?: string; salt?: string; key?: string }): string =>
      ['scrypt', parts.n ?? n, parts.r ?? r, parts.p ?? p, parts.salt ?? saltText, parts.key ?? keyText].join(':');

    it('the baseline hash verifies', () => {
      expect(verifyPassphrase(PASS, rebuild({}))).toBe(true);
    });

    it('rejects an N that is not a power of two, is 1, or is cheaper than the hashing cost', () => {
      for (const bad of ['0', '1', '3', '16383', '16385', '24576', '8192', '2']) {
        expect(verifyPassphrase(PASS, rebuild({ n: bad })), `N=${bad}`).toBe(false);
      }
    });

    it('rejects r or p below the hashing cost, zero or not a number', () => {
      for (const bad of ['0', '1', '7', '']) {
        expect(verifyPassphrase(PASS, rebuild({ r: bad })), `r=${bad}`).toBe(false);
      }
      for (const bad of ['0', '', '-1', '1.5']) {
        expect(verifyPassphrase(PASS, rebuild({ p: bad })), `p=${bad}`).toBe(false);
      }
    });

    it('rejects an empty salt', () => {
      const empty = scryptHash(PASS, Buffer.alloc(0));
      expect(empty.split(':')[4]).toBe('');
      expect(verifyPassphrase(PASS, empty)).toBe(false);
    });

    it('rejects a key that is not keylen bytes', () => {
      for (const bytes of [1, 4, SCRYPT_PARAMS.keylen - 1, SCRYPT_PARAMS.keylen + 1, 64]) {
        const key = Buffer.from(keyText, 'base64url');
        const resized = Buffer.concat([key, Buffer.alloc(64, 7)]).subarray(0, bytes).toString('base64url');
        expect(verifyPassphrase(PASS, rebuild({ key: resized })), `${bytes} bytes`).toBe(false);
      }
    });
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

  it('cli strips a CRLF line ending but nothing else', () => {
    const out = runCli('a long passphrase\r\n');
    expect(out.status).toBe(0);
    expect(verifyPassphrase('a long passphrase', out.stdout.trim())).toBe(true);
    expect(verifyPassphrase('a long passphrase\r', out.stdout.trim())).toBe(false);
  });

  it('cli accepts exactly 12 characters and rejects 11', () => {
    const twelve = runCli('abcdefghijkl\n');
    expect(twelve.status).toBe(0);
    expect(verifyPassphrase('abcdefghijkl', twelve.stdout.trim())).toBe(true);

    const eleven = runCli('abcdefghijk\n');
    expect(eleven.status).toBe(1);
    expect(eleven.stdout).toBe('');
    expect(eleven.stderr).toContain('Passphrase must be at least 12 characters');
  });

  it('cli counts a trailing CR before the newline as part of an 11-character line', () => {
    // "abcdefghijk\r\n" is 11 characters once the CRLF is stripped.
    expect(runCli('abcdefghijk\r\n').status).toBe(1);
  });
});
