### Task 6: Sessions, auth middleware, login routes

**Files:**
- Create: `apps/server/src/auth/sessions.ts`, `apps/server/src/auth/routes.ts`
- Test: `apps/server/src/auth/routes.test.ts`

**Interfaces:**
- Consumes: Task 4 (`Db`, `openDb`), Task 5 (`verifyPassphrase`, `hashPassphrase`, `LoginLimiter`).
- Produces:

```ts
// sessions.ts
export const SESSION_COOKIE = 'hub_session';
export const SESSION_TTL_MS = 2_592_000_000;   // 30 days
export class SessionStore {
  constructor(db: Db, now?: () => number);
  create(): string;                              // randomBytes(32) base64url; stores sha256(token) hex + expires_at
  valid(token: string | undefined): boolean;      // row exists and expires_at > now
  revoke(token: string): void;
  purgeExpired(): number;
}
export function readCookie(header: string | undefined, name: string): string | undefined;
export function requireAuth(sessions: SessionStore): MiddlewareHandler;   // hono/factory createMiddleware; 401 { error: 'Not logged in' }
// routes.ts — mount with app.route('/api', authRoutes(deps))
export interface AuthDeps { sessions: SessionStore; limiter: LoginLimiter; passphraseHash: string; now?: () => number }
export function authRoutes(deps: AuthDeps): Hono;
```

Routes (cookie helpers from `hono/cookie`):
- `POST /login`, body `{ passphrase }`, checked in this order:
  1. `limiter.blocked(now)` → 429 `{ error: 'Too many attempts. Try again in 15 minutes.' }`.
  2. Body is not JSON with a string `passphrase` → 400 `{ error: 'passphrase is required' }`.
  3. Wrong passphrase → `limiter.fail(now)`, then 401 `{ error: 'Wrong passphrase' }`.
  4. Right passphrase → `limiter.reset()`, then `setCookie(c, SESSION_COOKIE, sessions.create(), { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 2_592_000 })` and 204.
- `POST /logout`: revoke the cookie's token if present, `deleteCookie(c, SESSION_COOKIE, { path: '/' })`, 204.
- `GET /session`: 200 `{ ok: true }` if the cookie is valid, else 401 `{ error: 'Not logged in' }`.

- [ ] **Step 1: Write the failing tests.**
  - Setup: `db = openDb(':memory:')` and `HASH = hashPassphrase('correct horse battery staple', Buffer.alloc(16, 1))`.
  - `app = new Hono()`, then `app.route('/api', authRoutes({ sessions, limiter: new LoginLimiter(), passphraseHash: HASH }))`.
  - Then `app.use('/api/secret', requireAuth(sessions))` and `app.get('/api/secret', c => c.json({ ok: true }))`.
  - Helper `login(pass)` POSTs JSON and returns the `Response`.

  Tests:
  - `login sets an httpOnly strict secure cookie`: 204, and `set-cookie` contains `hub_session=`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` and `Max-Age=2592000`.
  - `cookie opens protected routes`: with the `hub_session=<token>` header → 200. Without it → 401 with body `{ error: 'Not logged in' }`.
  - `wrong passphrase is 401`: body `{ error: 'Wrong passphrase' }`.
  - `sixth attempt is rate limited`: 5 wrong logins, then the right one → 429.
  - `logout revokes the session`: the old cookie → 401 on `/api/secret`.
  - `expired sessions are rejected`: a store with injected `now`; `create()` at 0; `valid(token)` at `SESSION_TTL_MS` is false; `purgeExpired() === 1`.
  - `tokens are stored hashed`: the stored `token_hash` equals `createHash('sha256').update(token).digest('hex')` and differs from the token.
  - `readCookie parses a header`: `readCookie('a=1; hub_session=xyz; b=2', 'hub_session') === 'xyz'`. A missing name or an `undefined` header → `undefined`.
  - `session reports login state`: `GET /api/session` → 401, then after login → 200 `{ ok: true }`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/auth/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/auth` as `feat(server): hashed session cookies, auth middleware, login routes`, with the attribution trailer your harness provides.

---

