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

/** Checks a passphrase against a stored hash. Malformed input returns false and never throws. */
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
    if (!BASE64URL.test(saltText) || !BASE64URL.test(keyText)) return false;

    const expected = Buffer.from(keyText, 'base64url');
    if (expected.length === 0) return false;
    const actual = scryptSync(passphrase, Buffer.from(saltText, 'base64url'), expected.length, {
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
