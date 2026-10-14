### Task 21: startHub, production entry, fake hub

**Files:**
- Create: `apps/server/src/server.ts`, `apps/server/src/main.ts`, `apps/server/src/dev/fake-hub.ts`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: Task 20 (`createApp`), Task 8 (`SocketHub`, `attachWebSocket`), Task 18 (`BuildService`), Task 13, Task 7, Task 6, Task 5, Task 4, Task 3, Task 10 (`SdkClaudeRunner`, main only), Task 12 (`OctokitGitHub`, `FakeGitHub`), Task 9 (`FakeClaudeRunner`), Task 11 (`openRepo`, `makeTestRepo`, `TEST_IDENTITY`), Task 14 (`runCommand`).
- Produces:

```ts
export interface HubOptions {
  config: HubConfig; runner: ClaudeRunner; github: GitHub | null; clientDir: string | null;
  openRepo?: (dir: string) => GitRepo;   // default d => openRepo(d, { token: config.githubToken })
  runCommand?: RunCommand;               // default runCommand
  ciPollMs?: number;                     // default 30_000
  retryPollMs?: number;                  // default 60_000
  onMerged?: BuildDeps['onMerged'];
  log?: (line: string) => void;          // default console.log
}
export interface RunningHub { url: string; port: number; hub: SocketHub; build: BuildService; close(): Promise<void> }
export function startHub(opts: HubOptions): Promise<RunningHub>;
```

`startHub` steps:
1. `mkdir` the data dir, then `db = openDb(join(dataDir, 'hub.sqlite'))`.
2. Create `SessionStore`, `LoginLimiter`, `AppRegistry(appsDir)` and `SocketHub`. Create `BuildService` with `now: Date.now`.
3. If `build.recover() > 0`, log `` `Marked ${n} interrupted build task(s) as failed` ``.
4. `server = serve({ fetch: createApp(...).fetch, port, hostname: bind }, info => …)`. Await listening; `info.port` gives the real port.
5. `attachWebSocket(server as Server, hub, { isAuthed: h => sessions.valid(readCookie(h, SESSION_COOKIE)) })`.
6. Start unref'd intervals: `build.pollCi()` every `ciPollMs`, `build.retryQueued()` every `retryPollMs`, and `sessions.purgeExpired()` hourly. Each catches and logs errors.
7. Log `` `Hub listening on http://${bind}:${port}` ``.
8. `close()`: clear the timers, `await build.stopAll()`, close the WebSocket server, `server.close()` (awaited), and `db.close()`.

`main.ts`:
1. `config = loadConfig(process.env)`. A `ConfigError` prints its message and runs `process.exit(1)`.
2. `github = config.githubToken ? new OctokitGitHub(config.githubToken) : null`.
3. `clientDir = fileURLToPath(new URL('../../client/dist', import.meta.url))` if `index.html` exists there. Otherwise use `null` and log `'Client build not found; run pnpm -F @hub/client build'`.
4. `startHub({ config, runner: new SdkClaudeRunner({ oauthToken: config.claudeOauthToken }), github, clientDir })`.
5. On `SIGINT` and `SIGTERM`, `await hub.close()` and then `process.exit(0)`.

`dev/fake-hub.ts`: used by the e2e tests (`pnpm -F @hub/server dev:fake`). It never calls the SDK or GitHub.
1. Make a temp root. Create `makeTestRepo({ workDir: join(root, 'apps', 'demo'), files: { '.hub/app.json': JSON.stringify(<SPEC_EXAMPLE with name 'demo' and build { install: 'true', typecheck: 'true', test: 'true' }>) } })`.
2. `passphrase = process.env.HUB_DEV_PASSPHRASE ?? 'hub-dev-passphrase'`.
3. Call `startHub` with:
   - `config`: `bind '127.0.0.1'`, `port Number(process.env.HUB_FAKE_PORT ?? 8787)`, `dataDir root/data`, `appsDir root/apps`, `passphraseHash hashPassphrase(passphrase)`, `githubToken null`, `githubOwner null`, `claudeOauthToken null`.
   - `runner`: `new FakeClaudeRunner([[ async o => { writeFileSync(join(o.cwd, 'NOTES.md'), `# Notes\n\n${o.prompt}\n`) }, { type: 'text', text: 'Working on it.' }, o => ({ type: 'tool', name: 'Write', input: { file_path: join(o.cwd, 'NOTES.md') } }), { type: 'text', text: 'Done.' }, { type: 'done', sessionId: 'fake-session', ok: true } ]])`.
   - `github`: `new FakeGitHub({ autoGreenAfter: 1 })`.
   - `openRepo: d => openRepo(d, { identity: TEST_IDENTITY })`, `ciPollMs: 1000`, `clientDir: null`.
4. Log `` `Fake hub on http://127.0.0.1:${port} (passphrase: ${passphrase})` ``.

- [ ] **Step 1: Write the failing tests** (`server.test.ts`):
  - Setup:
    - Temp `dataDir` and `appsDir`, with `makeTestRepo({ workDir: join(appsDir, 'demo') })`.
    - `config = { bind: '127.0.0.1', port: 0, …, passphraseHash: HASH, githubToken: null, githubOwner: null, claudeOauthToken: null }`.
    - `startHub` with `FakeClaudeRunner([[{ type: 'text', text: 'Hi' }, { type: 'done', sessionId: 's', ok: true }]])`, `new FakeGitHub()`, an identity `openRepo`, and an always-ok `runCommand`.
  - Tests:
    - `serves health and refuses anonymous websockets`: `fetch(url + '/api/health')` → 200. `new WebSocket(url.replace('http', 'ws') + '/ws')` → `unexpected-response` 401.
    - `a logged-in socket receives build messages`:
      - Log in with `fetch` and take `set-cookie`. Open a WebSocket with that cookie.
      - `POST /api/apps/demo/build/messages { text: 'Say hi' }` → 202.
      - Within 5 s the socket receives a `build.message` whose `message.text === 'Hi'`.
    - `close stops listening`: after `close()`, `fetch(url + '/api/health')` rejects.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Verify.**
  - The test file passes (3 tests).
  - `pnpm -F @hub/server typecheck` is clean.
  - `pnpm -F @hub/server dev:fake` prints the `Fake hub on …` line, and `curl -s http://127.0.0.1:8787/api/health` prints `{"ok":true}`. Stop it with Ctrl-C.
- [ ] **Step 5: Commit** `apps/server/src/server.* apps/server/src/main.ts apps/server/src/dev` as `feat(server): startHub wiring, production entry, fake hub for e2e`, with the attribution trailer your harness provides.

---


---

## Controller additions (decisions from earlier tasks; these are requirements too)

Worktree /home/claude/wt-p3-21, branch p3-21, off feat/hub-server 2ae0c74. Tasks 1-20 and 22-27 are merged there; read the real signatures in apps/server/src rather than trusting the brief's Interfaces block where they differ (e.g. Task 20's `createApp` options, `buildRoutes(…, hasApp)`, csrf + bodyLimit already inside createApp).

1. Clock: `HubOptions` gains `now?: () => number` (default `Date.now`). Pass the same function to `SessionStore`, to whatever authRoutes/LoginLimiter use for `now`, and to `BuildService`. No other wall-clock reads in startHub.
2. Sessions: call `sessions.purgeExpired()` once at startup (before listening), then hourly as the brief says.
3. Production wiring (main.ts): construct `SdkClaudeRunner` with the oauth token explicitly from config (never read ANTHROPIC_API_KEY; never put the token in argv), and pass Task 14's real `runCommand` explicitly (the one that applies scrubEnv and CI=1), even though it is also the default.
4. Keep every guard attachWebSocket already has (path check, throwing isAuthed refused, payload limits). Do not re-implement upgrade handling in server.ts.
5. Sockets must not outlive their session. Extend attachWebSocket (ws/attach.ts, Task 8's file; keep its tests green): remember each socket's cookie header; on every heartbeat sweep re-run `isAuthed` for each socket and terminate the ones that fail; return a `recheck()` that does the same immediately. Wire authRoutes' logout (add an optional `onLogout` callback to authRoutes/createApp if there is none) to call `recheck()`. Tests: after POST /api/logout, an open socket with that cookie is closed within 1 s; after the session expires (advance the injected clock, then trigger a sweep or recheck) the socket is closed; a socket with a still-valid session stays open.
6. WebSocket Origin check (from the Task 20 re-review): refuse the upgrade (403, same refusal path as 401) when an `Origin` header is present and its host[:port] differs from the request's `Host` header. Absent Origin is allowed (non-browser clients cannot ride the cookie cross-site). Tests: matching Origin connects; `Origin: https://other.tailnet.ts.net` with a valid cookie is refused; no Origin with a valid cookie connects.
7. main.ts installs `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log one line (message only, no stack with secrets; JSON.stringify the message) and `process.exit(1)` — systemd restarts the hub.
8. dev/fake-hub.ts is used by Task 28's Playwright tests: the client is served by Vite (port 4173 with a proxy to /api and /ws, see apps/client/vite.config.ts and playwright.config.ts); make sure the fake hub's port and the proxy target agree, and that csrf and the Origin check accept the proxied requests (the Vite proxy should send the hub's own Host/Origin — set `changeOrigin: true` on the proxy if needed and say so in the report).

Verification beyond the brief: `pnpm -F @hub/server test` (full server suite) and `pnpm typecheck` at the root must pass. E2E: before running any Playwright, `lsof -i :4173` must be empty; run with `CI=1`.
