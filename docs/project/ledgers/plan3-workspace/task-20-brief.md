### Task 20: HTTP app composition and API routes

**Files:**
- Create: `apps/server/src/app.ts`, `apps/server/src/build/routes.ts`, `apps/server/src/apps/routes.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: Task 6 (`authRoutes`, `requireAuth`, `SessionStore`), Task 5 (`LoginLimiter`), Task 7 (`AppRegistry`, `AppEntry`), Task 18 (`BuildService`), Task 17 (`BuildError`), Task 19 (`renderRoutes`), Task 2 (`AppSummary`).
- Produces:

```ts
// apps/routes.ts
export function toSummary(e: AppEntry, buildStatus: BuildTaskStatus | null, running: boolean): AppSummary;
export function appsRoutes(deps: { registry: AppRegistry; build: Pick<BuildService, 'latestStatus' | 'isRunning'> }): Hono;  // GET / and GET /:app
// build/routes.ts
export function buildRoutes(build: Pick<BuildService, 'state' | 'send' | 'stop' | 'merge' | 'close'>): Hono;
// app.ts
export interface AppDeps {
  sessions: SessionStore; limiter: LoginLimiter; passphraseHash: string; registry: AppRegistry; build: BuildService;
  dataDir: string; clientDir?: string | null; now?: () => number;
}
export function createApp(deps: AppDeps): Hono;
```

Build routes, mounted at `/api/apps`:
- `GET /:app/build?after=N`: `after` is used only when it is an integer ≥ 0, else `undefined`. Responds `c.json(await build.state(app, after))`.
- `POST /:app/build/messages`: a body without a string `text` → 400 `{ error: 'text is required' }`. Otherwise responds 202 `{ task }`.
- `POST /:app/build/stop` → `{ stopped }`.
- `POST /:app/build/tasks/:id/merge` and `POST /:app/build/tasks/:id/close`: a non-integer id → 400 `{ error: 'Bad task id' }`. Otherwise `{ task }`.

`createApp`, in this order:
1. `app.use('*', secureHeaders())`.
2. `GET /api/health` → `{ ok: true }`.
3. `app.route('/api', authRoutes(...))`.
4. `app.use('/api/*', requireAuth(sessions))`.
5. Mount `appsRoutes`, `buildRoutes` and `renderRoutes({ dataDir, hasApp: async a => (await registry.get(a)) !== null })` at `/api/apps`.
6. `app.all('/api/*', c => c.json({ error: 'Not found' }, 404))`.
7. If `clientDir` is set: `app.use('/*', serveStatic({ root: clientDir, onFound: (p, c) => c.header('Cache-Control', p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache') }))` from `@hono/node-server/serve-static`.
8. `app.onError`:
   - `BuildError` → `c.json({ error: e.message }, e.status)`.
   - Anything else → `console.error`, then `c.json({ error: 'Internal error' }, 500)`.
   - Never echo stack traces or secrets.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `db = openDb(':memory:')` and `HASH` as in Task 6.
    - A registry over a temp apps dir holding `demo/.git/`.
    - `build` is a stub (`as unknown as BuildService`) with `vi.fn` methods: `latestStatus → 'review'`, `isRunning → false`, `state`, `send → task`, `stop → true`, `merge`, `close`.
    - Helper `cookie()` logs in and returns the `Cookie` header.
  - Tests:
    - `health is public`.
    - `api requires login`: `GET /api/apps` without a cookie → 401.
    - `lists apps with build status` → `[{ name: 'demo', adopted: false, manifestError: null, buildStatus: 'review', running: false }]`.
    - `unknown app is 404`: `GET /api/apps/nope`.
    - `send returns 202 with the task`. A missing `text` → 400.
    - `BuildError maps to its status`: `send` rejects with `new BuildError('busy', 409)` → 409 `{ error: 'busy' }`.
    - `after must be a number`: `?after=abc` → `state` is called with `('demo', undefined)`. `?after=5` → `('demo', 5)`.
    - `merge and close parse the id`: `/tasks/x/merge` → 400.
    - `render routes are behind login`: without a cookie → 401. With one → 200 `{ version: 1, pages: [] }`.
    - `serves the client without login`:
      - The `clientDir` has `index.html` (`'<p>hub</p>'`) and `assets/app-1.js`.
      - `GET /` → 200, the body contains `hub`, and `cache-control` is `no-cache`.
      - The asset has the immutable header.
    - `sets security headers`: `x-content-type-options: nosniff`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 11 pass.
- [ ] **Step 5: Commit** `apps/server/src/app.* apps/server/src/build/routes.ts apps/server/src/apps/routes.ts` as `feat(server): HTTP composition with auth, apps, build, render and static client`, with the attribution trailer your harness provides.

---

