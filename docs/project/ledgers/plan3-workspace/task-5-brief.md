### Task 5: Passphrase hashing, login limiter, hash CLI

**Files:**
- Create: `apps/server/src/auth/passphrase.ts`, `apps/server/src/auth/limiter.ts`, `apps/server/src/auth/hash-cli.ts`
- Test: `apps/server/src/auth/passphrase.test.ts`, `apps/server/src/auth/limiter.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
// passphrase.ts (node:crypto scryptSync, randomBytes, timingSafeEqual)
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;
export function hashPassphrase(passphrase: string, salt?: Buffer /* default randomBytes(16) */): string;
// → `scrypt:16384:8:1:${salt.toString('base64url')}:${key.toString('base64url')}` (no '$', safe in env files and shells)
export function verifyPassphrase(passphrase: string, stored: string): boolean;
// parses N, r, p, salt and key from `stored`; maxmem 64 MiB; timingSafeEqual; any malformed input → false; never throws
// limiter.ts
export interface LimiterOptions { maxFailures?: number /* 5 */; windowMs?: number /* 900_000 */; lockMs?: number /* 900_000 */ }
export class LoginLimiter {
  constructor(opts?: LimiterOptions);
  blocked(now: number): boolean;   // now < lockedUntil
  fail(now: number): void;         // records a failure; drops failures older than windowMs; at maxFailures, lockedUntil = now + lockMs and failures clear
  reset(): void;
}
```

`hash-cli.ts`:
1. Read all of stdin and strip one trailing `\n` or `\r\n`.
2. If the length is less than `MIN_PASSPHRASE_LENGTH`, write `Passphrase must be at least 12 characters\n` to stderr and `process.exit(1)`.
3. Otherwise write `hashPassphrase(input) + '\n'` to stdout.

- [ ] **Step 1: Write the failing tests.**
  - `passphrase.test.ts`:
    - `hash has the documented format`: matches `/^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/`.
    - `verifies only the right passphrase`.
    - `random salt makes hashes differ`.
    - `fixed salt is deterministic`: `hashPassphrase('correct horse battery', Buffer.alloc(16, 1))` gives the same result twice.
    - `malformed hashes never verify`: `''`, `'scrypt:1'`, `'bcrypt:a:b:c:d:e'` and `'scrypt:16384:8:1:@@:@@'` → `false`, with no throw.
    - `cli prints a hash`:
      - Run `execFileSync(join(serverDir, 'node_modules/.bin/tsx'), ['src/auth/hash-cli.ts'], { cwd: serverDir, input: 'a long passphrase\n', encoding: 'utf8' })`, where `serverDir = fileURLToPath(new URL('../../', import.meta.url))`.
      - `verifyPassphrase('a long passphrase', out.trim()) === true`.
    - `cli rejects short passphrases`: input `'short'` throws, and the error has `status === 1`.
  - `limiter.test.ts`:
    - `blocks after 5 failures within the window`: `fail(0..4)` at ms 0, 1, 2, 3, 4 → `blocked(5) === true`, `blocked(900_003) === true` and `blocked(900_004) === false`.
    - `old failures expire`: `fail` at 0, 1, 2, 3, then at 900_001 → `blocked(900_001) === false`.
    - `reset clears failures`: 4 fails, `reset()`, 1 fail → not blocked.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/auth`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 10 pass. `printf 'a long passphrase' | pnpm --silent -F @hub/server hash-passphrase` prints one `scrypt:` line.
- [ ] **Step 5: Commit** `apps/server/src/auth` as `feat(server): scrypt passphrase hashing, login limiter, hash CLI`, with the attribution trailer your harness provides.

---

