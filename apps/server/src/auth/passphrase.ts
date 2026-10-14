import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;

const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const DECIMAL = /^\d+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Hashes a passphrase as `scrypt:N:r:p:salt:key` (base64url fields, no `$`). */
export function hashPassphrase(passphrase: string, salt: Buffer = randomBytes(SALT_BYTES)): string {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const key = scryptSync(passphrase, salt, keylen, { N, r, p, maxmem: MAX_MEMORY });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

function parseParam(text: string): number | null {
  return DECIMAL.test(text) ? Number(text) : null;
}

function isPowerOfTwo(n: number): boolean {
  if (!Number.isSafeInteger(n) || n < 2) return false;
  const big = BigInt(n);
  return (big & (big - 1n)) === 0n;
}

/**
 * Checks a passphrase against a stored hash. Malformed or weak input returns false and never throws.
 * The stored cost parameters must be no cheaper than the ones hashPassphrase writes (N a power of two,
 * r and p at least 1), the salt must not be empty, and the key must be the full SCRYPT_PARAMS.keylen bytes:
 * a short stored key would let a wrong passphrase match by chance.
 */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  try {
    const parts = stored.split(':');
    if (parts.length !== 6) return false;
    const [scheme = '', nText = '', rText = '', pText = '', saltText = '', keyText = ''] = parts;
    if (scheme !== 'scrypt') return false;

    const N = parseParam(nText);
    const r = parseParam(rText);
    const p = parseParam(pText);
    if (N === null || r === null || p === null) return false;
    if (!isPowerOfTwo(N) || N < SCRYPT_PARAMS.N) return false;
    if (r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p) return false;
    if (!BASE64URL.test(saltText) || !BASE64URL.test(keyText)) return false;

    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    if (salt.length === 0 || expected.length !== SCRYPT_PARAMS.keylen) return false;
    const actual = scryptSync(passphrase, salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
