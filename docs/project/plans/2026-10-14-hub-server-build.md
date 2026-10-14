# Hub Server, Shell and Build Area Implementation Plan (Plan 3 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the always-on hub: a Hono + SQLite server that is reachable only through Tailscale, with passphrase login, an app registry, a typed WebSocket, and a Build area. In the Build area each app has one persistent Claude Code chat that works on a `build/<slug>` branch, verifies its work, pushes, opens a PR, tracks CI, and merges only when CI is green. Also ship the tablet shell (login, app list, Design/Build/Deploy tabs), render-file endpoints with a server-backed `TileSource`, and a bootstrap script for the Hetzner box.

**Architecture:** `apps/server` composes small modules: `config`, `db` (better-sqlite3 with append-only migrations), `auth` (scrypt passphrase, hashed session tokens, httpOnly cookie), `apps` (registry of git checkouts in `HUB_APPS_DIR`, with manifests validated by a zod schema from `@hub/protocol/manifest`), `ws` (one socket hub, `ServerMsg` JSON), `claude` (the `ClaudeRunner` contract, an Agent SDK runner with a deploy guard, and a fake), `git` (simple-git), `github` (an interface with Octokit and fake implementations), and `build` (store, turn, finish, CI/merge, service, routes). Claude never pushes or deploys. The hub commits leftovers, runs install/typecheck/test (and asks Claude to fix failures up to 2 times), pushes, and opens or updates the PR. Merge re-checks CI on the PR's current head and squash-merges with that SHA pinned. The client gains `net/` (typed fetch, a reconnecting WebSocket, `ServerTileSource`), `shell/` and `areas/build/`. Plan 2's canvas harness moves to `harness.html`. Extension points for plans 4–6: `MIGRATIONS` (append), `ServerMsg` + `SERVER_MSG_TYPES` (add variants), `BuildDeps.onMerged` (staging deploy hook), `SECRET_ENV_KEYS`, `ClaudeRunner` (`mcpServers`, `allowedTools`), and `renderDir`.

**Tech Stack:** Node 22, pnpm 10.28, TypeScript strict ESM, vitest. Server: hono `^4.13.13`, @hono/node-server `^2.1.5`, ws `^8.22.0`, better-sqlite3 `^13.0.3`, simple-git `^3.36.0`, @octokit/rest `^22.0.1`, @anthropic-ai/claude-agent-sdk `^0.3.290`, zod `^4.6.7`, tsx `^4.23.15`. Client: Preact + Vite from plan 2, Playwright `1.56.1`. Ops: Ubuntu 24.04, NodeSource Node 22, Tailscale (`tailscale serve`), systemd encrypted credentials, the Claude Code native installer.

**Spec:** `docs/superpowers/specs/2026-10-14-hub-design.md` (also `/mnt/project-files/designer/spec.md`): §3 architecture, security and realtime; §6 Build area; §10 step 1 bootstrap; §11 "usage limit → show and queue". Binding names: `/mnt/project-files/designer/architecture.md`. This plan builds on plan 1 (`@hub/design-model`) and on plan 2 (`/mnt/project-files/designer/plans/2026-10-14-renderer-canvas.md`): `packages/protocol` (`render.ts`, `ws.ts` with `RenderReadyMsg` and `ServerMsg`), `apps/client` (`canvas/` with `TileSource`, `StaticTileSource`, `CanvasView`, `createIdbCache`), `main.tsx`, `vite.config.ts`, `playwright.config.ts`, and the e2e specs. It extends those files and never recreates them.

**Verified on 2026-10-14** (Context7 + code.claude.com):
- Agent SDK `query({ prompt, options })` options are `cwd`, `resume`, `permissionMode` (`'bypassPermissions'` requires `allowDangerouslySkipPermissions: true`), `allowedTools`, `disallowedTools`, `canUseTool`, `hooks.PreToolUse`, `settingSources`, `systemPrompt: { type: 'preset', preset: 'claude_code', append }`, `env` (replaces the child env), `abortController`, and `mcpServers`.
- Deny rules apply even in bypass mode. A hook `deny` applies before everything else. `canUseTool` is not called for auto-approved calls.
- Scoped `Bash(...)` deny rules match the command only as written. That is why a PreToolUse hook is the real guard.
- A single-shot `query()` throws after it yields an error result.
- Rate limits arrive as `rate_limit_event` with `rate_limit_info.status === 'rejected'`, and as assistant `error: 'rate_limit'`.
- Headless subscription login: `claude setup-token` prints a one-year OAuth token, which is used as `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY` outranks it, so it must never be set.
- `tailscale serve` proxies only to `http://127.0.0.1`.
- systemd `UnsetEnvironment=` is applied last. `LoadCredentialEncrypted=NAME` reads `/etc/credstore.encrypted/NAME`, and a missing file is not fatal.
- simple-git blocks `GIT_CONFIG_*` and `EDITOR`/`PAGER` environment variables unless they are explicitly allowed. That is why the git wrapper passes a minimal env and the auth header via `config`.
- pnpm 10.26+ uses `allowBuilds`.

## Global Constraints

- Node 22, pnpm 10 workspace (`packages/*`, `apps/*`), TypeScript `strict`, ESM, `moduleResolution: "Bundler"`, `noUncheckedIndexedAccess`. Every `tsconfig.json` extends `../../tsconfig.base.json`. Tests are `*.test.ts` next to the code. From the repo root, run `pnpm -r typecheck` and `pnpm -r test`.
- Workspace packages have no build step. The server runs its TypeScript source with `tsx`.
- `vitest` and `typescript` use the same specifiers as `packages/design-model/package.json` (`^5.0.4` and `^7.0.2`).
- `@hub/protocol` gains exactly one runtime dependency, `zod`, and only `src/manifest.ts` imports it. That file is exported as the subpath `@hub/protocol/manifest`, and `src/index.ts` never re-exports it, so the client bundle never contains zod.
- Only Tasks 1 and 3 change `package.json` dependencies or `pnpm-lock.yaml`. Task 3 installs every server dependency up front, so parallel lanes never conflict on the lockfile.
- `ANTHROPIC_API_KEY` is never set, written or passed on. Every child process (Claude, git, build commands) gets `scrubEnv(...)`, which removes `SECRET_ENV_KEYS`. Claude authenticates with the subscription: either `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or the `claude` login of the `hub` user.
- The server binds `HUB_BIND`, and a wildcard address is a config error. In production `HUB_BIND=127.0.0.1`, behind `tailscale serve --https=443`, so the hub has no public port and Tailscale provides the HTTPS cert.
- Secrets (`HUB_PASSPHRASE_HASH`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are systemd encrypted credentials in production. They never appear in an API response, a WebSocket message, a log line, a git config file or a process argument list.
- All Claude use goes through `ClaudeRunner` (`apps/server/src/claude/runner.ts`). Tests use `FakeClaudeRunner`, GitHub goes through the `GitHub` interface (`FakeGitHub` in tests), and git tests use real `git` against local bare repos. No test touches the network.
- Claude works only on `build/<slug>-<taskId>` branches. The hub never commits to or pushes the default branch. Merges are squash merges that pin the PR head SHA, and only when that head's CI state is `success`.
- Times are epoch milliseconds (`number`). Task and message ids are SQLite integer row ids.
- The client's runtime dependencies stay `preact`, `idb-keyval` and `@hub/protocol`, and gzipped JS stays under 150 000 bytes. Client unit tests run in vitest's `node` environment with fakes (no jsdom), and DOM behavior is covered by Playwright specs.
- User-facing strings quoted in a task are exact copy.

## Review Focus

1. **Deploy commands hidden in a compound or path-qualified shell command** (`cd web && git push`, `/usr/bin/docker …`, `bash -c "ssh …"`, `FOO=1 git push`) must be denied, not just a bare `git push`. Test: Task 9, `denies composed and path-qualified deploy commands`.
2. **The tablet sleeps or the WebSocket drops mid-stream.** On reconnect the chat must catch up on the messages it missed and show none twice. Tests: Task 22, `missing pong forces a reconnect`; Task 23, `applyState dedupes messages already shown`. Task 25 refetches with `after=<lastId>` whenever the socket reopens.
3. **The hub restarts during a task.** No task may stay "Claude is working" forever. Test: Task 18, `recover marks interrupted tasks failed`.
4. **The stored Claude session can't be resumed** (token renewed, `~/.claude` cleared). The chat must start a fresh session, not fail every message. Test: Task 15, `stale session falls back to a fresh one`.
5. **CI turns red, or a new push lands, after the tablet showed green.** Merge must re-check CI on the PR's current head and pin that SHA. Test: Task 17, `merge rechecks CI on the current head`.

---

## File Structure

```
pnpm-workspace.yaml                         (modify) allowBuilds: better-sqlite3
packages/protocol/
  package.json                              (modify) zod dep, "./manifest" subpath, sideEffects false
  src/manifest.ts                           AppManifestSchema, parseAppManifest      (@hub/protocol/manifest)
  src/api.ts                                HTTP DTOs: BuildTask, BuildMessage, BuildState, AppSummary …
  src/ws.ts                                 (modify) ServerMsg/ClientMsg unions, parseServerMsg, parseClientMsg
apps/server/                                @hub/server
  package.json, tsconfig.json, vitest.config.ts
  src/config.ts                             loadConfig, SECRET_ENV_KEYS, scrubEnv
  src/db.ts                                 openDb, migrate, MIGRATIONS
  src/auth/passphrase.ts                    hashPassphrase, verifyPassphrase
  src/auth/limiter.ts                       LoginLimiter
  src/auth/hash-cli.ts                      `pnpm --silent -F @hub/server hash-passphrase`
  src/auth/sessions.ts                      SessionStore, readCookie, requireAuth
  src/auth/routes.ts                        /api/login, /api/logout, /api/session
  src/apps/registry.ts                      AppRegistry (git checkouts + manifest)
  src/apps/routes.ts                        /api/apps
  src/ws/hub.ts                             SocketHub (broadcast, heartbeat sweep, ping→pong)
  src/ws/attach.ts                          attachWebSocket (upgrade on /ws, cookie auth)
  src/claude/runner.ts                      ClaudeRunner contract, AgentEvent, usage-limit helpers
  src/claude/fake.ts                        FakeClaudeRunner
  src/claude/guard.ts                       deployDenyReason, checkToolUse, DEPLOY_DENY_RULES
  src/claude/sdk.ts                         SdkClaudeRunner over query()
  src/git/git.ts                            openRepo → GitRepo
  src/git/test-repo.ts                      makeTestRepo (test support used by later tasks)
  src/github/github.ts                      GitHub interface, summarizeChecks, parseGitHubRemote
  src/github/fake.ts                        FakeGitHub
  src/github/octokit.ts                     OctokitGitHub
  src/build/store.ts                        BuildStore (tasks, chat session, messages)
  src/build/naming.ts                       branchSlug, prTitle, prBody, summarizeTool, buildSystemPrompt, fixPrompt
  src/build/commands.ts                     resolveBuildCommands, runCommand
  src/build/deps.ts                         BuildDeps, addBuildMessage, publishTask, repoRefFor
  src/build/turn.ts                         runTurn, queueAfterLimit
  src/build/finish.ts                       finishTask (commit, verify+fix, push, PR)
  src/build/ci.ts                           BuildError, refreshCi, pollCi, mergeTask
  src/build/service.ts                      BuildService
  src/build/routes.ts                       /api/apps/:app/build…
  src/design/render-files.ts                renderDir, renderRoutes (manifest, tiles, hit maps)
  src/app.ts                                createApp (Hono composition + static client)
  src/server.ts                             startHub (db, services, serve, ws, timers)
  src/main.ts                               production entry
  src/dev/fake-hub.ts                       fake hub for e2e (`pnpm -F @hub/server dev:fake`)
  src/ops.test.ts                           checks the ops files
apps/client/
  harness.html, src/harness.tsx             plan 2's canvas harness, moved off "/"
  vite.config.ts                            (modify) multi-page input, /api + /ws proxy
  public/sw.js                              (modify) app-shell caching
  playwright.config.ts                      (modify) second webServer: fake hub
  e2e/canvas.spec.ts, e2e/perf.spec.ts      (modify) goto /harness.html?debug=1
  e2e/build.spec.ts, e2e/pwa.spec.ts        Build/shell smoke, offline shell
  src/net/api.ts, src/net/ws.ts, src/net/tile-source.ts
  src/shell/route.ts, src/shell/App.tsx, src/shell/Login.tsx, src/shell/AppList.tsx, src/shell/AppView.tsx, src/shell/shell.css
  src/areas/build/state.ts, src/areas/build/BuildArea.tsx, src/areas/build/TaskCard.tsx, src/areas/build/build.css
  src/canvas/CanvasView.tsx                 (modify) root position fixed → absolute
  src/main.tsx                              (modify) render the shell
ops/hub/bootstrap.sh, ops/hub/hub.service, ops/hub/hub.env.example, ops/hub/set-secret.sh, ops/hub/check-claude.sh
docs/hub-bootstrap.md
```

## Dependency lanes

Tasks in the same wave can run in parallel. Each task's **Consumes** line is authoritative.

| Wave | Tasks |
|---|---|
| 1 | 1 (protocol manifest), 24 (client harness move; plan 2 only) |
| 2 | 2 (protocol API/WS), 3 (server scaffold; after 1 because of the lockfile) |
| 3 | 4 (db), 5 (passphrase), 7 (registry), 9 (runner + guard), 11 (git), 14 (naming + commands), 22 (client net), 23 (client state) |
| 4 | 6 (sessions/auth routes), 8 (ws), 10 (SDK runner), 12 (GitHub), 13 (build store), 19 (render files), 25 (Build UI), 29 (ops) |
| 5 | 15 (turn), 26 (AppList/AppView) |
| 6 | 16 (finish), 17 (CI/merge), 27 (App/Login/main) |
| 7 | 18 (service) |
| 8 | 20 (HTTP app) |
| 9 | 21 (startHub, main, fake hub) |
| 10 | 28 (e2e) |

---

### Task 1: App manifest schema (`@hub/protocol/manifest`)

**Files:**
- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/manifest.ts`
- Test: `packages/protocol/src/manifest.test.ts`

**Interfaces:**
- Consumes: plan 2 Task 1 (`packages/protocol` exists).
- Produces (import from `@hub/protocol/manifest`; `src/index.ts` must not re-export it):

```ts
export const APP_MANIFEST_FILE = '.hub/app.json';
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const AppManifestSchema: /* z.object below */;
export type AppManifest = z.infer<typeof AppManifestSchema>;
export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; error: string };
export function parseAppManifest(text: string): ManifestResult;
```

Schema (exact; unknown keys are stripped, not rejected):

```ts
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');
const target = z.object({ server: z.string().min(1), url: httpUrl });
export const AppManifestSchema = z.object({
  name: z.string().regex(APP_NAME_RE, 'must be lowercase letters, digits and dashes'),
  template: z.string().regex(/^[a-z0-9-]+@\d+$/, 'must look like name@version'),
  design: z.object({ dir: z.string().min(1), routes: z.string().min(1), devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).min(1) }),
  build: z.object({ install: z.string().min(1), test: z.string().min(1), typecheck: z.string().min(1) }),
  deploy: z.object({
    image: z.string().regex(/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/, 'must be ghcr.io/<owner>/<name> in lowercase'),
    staging: target,
    production: target.extend({ domain: z.string().min(1).nullable() }),
  }),
});
```

`parseAppManifest`: if `JSON.parse` throws, return `{ ok: false, error: '.hub/app.json is not valid JSON' }`. If `safeParse` fails, return `error = issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')`.

- [ ] **Step 1: Write the failing tests.** Fixture `SPEC_EXAMPLE` (spec §4 with the placeholders filled in):

```json
{ "name": "myapp", "template": "vite-hono-pg@1",
  "design": { "dir": "design", "routes": "web/src/routes.tsx", "devices": ["desktop", "tablet", "mobile"] },
  "build": { "install": "pnpm i", "test": "pnpm test", "typecheck": "pnpm typecheck" },
  "deploy": { "image": "ghcr.io/marco/myapp",
    "staging": { "server": "shared-staging", "url": "http://myapp.staging.tail1234.ts.net" },
    "production": { "server": "shared-production", "url": "https://myapp.203.0.113.7.sslip.io", "domain": null } } }
```

  - `accepts the spec example`: `ok === true` and `manifest.build.test === 'pnpm test'`.
  - `rejects invalid JSON`: `parseAppManifest('{')` → error `'.hub/app.json is not valid JSON'`.
  - `names the failing field`: with name `'My App'`, the error contains `'name: '`.
  - `rejects an uppercase image`: `'ghcr.io/Marco/myapp'` → the error contains `'deploy.image'`.
  - `rejects an unknown device`: `devices: ['watch']` → the error contains `'design.devices.0'`.
  - `domain may be a string`: `'myapp.com'` → ok.
  - `missing build section`: delete `build` → the error contains `'build'`.
  - `index does not export the schema`: `'AppManifestSchema' in (await import('./index.js'))` is `false`.
- [ ] **Step 2: Run** `pnpm -F @hub/protocol exec vitest run src/manifest.test.ts`. Expected: FAIL (`./manifest.js` missing).
- [ ] **Step 3: Implement.**
  - Run `pnpm add -F @hub/protocol zod@^4.6.7`.
  - In `package.json`, add `"sideEffects": false` and set `"exports": { ".": "./src/index.ts", "./manifest": "./src/manifest.ts" }`.
  - Write `src/manifest.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/protocol test && pnpm -F @hub/protocol typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `packages/protocol pnpm-lock.yaml` as `feat(protocol): app manifest zod schema behind a subpath export`, with the attribution trailer your harness provides.

---

### Task 2: Build DTOs and WebSocket messages in `@hub/protocol`

**Files:**
- Create: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/ws.ts`, `packages/protocol/src/index.ts` (add `export * from './api.js';`)
- Test: `packages/protocol/src/ws.test.ts`

**Interfaces:**
- Consumes: Task 1 (package layout); plan 2's `RenderReadyMsg`.
- Produces (`api.ts`, exact):

```ts
export type BuildTaskStatus = 'working' | 'verifying' | 'pushing' | 'review' | 'no_changes' | 'failed' | 'queued' | 'merged' | 'closed';
export const OPEN_TASK_STATUSES: readonly BuildTaskStatus[] = ['working', 'verifying', 'pushing', 'review', 'no_changes', 'failed', 'queued'];
export function isOpenTask(status: BuildTaskStatus): boolean;
export type CiState = 'none' | 'pending' | 'success' | 'failure';
export type BuildMessageKind = 'user' | 'assistant' | 'tool' | 'status' | 'error';
export interface BuildMessage { id: number; app: string; taskId: number | null; kind: BuildMessageKind; text: string; at: number }
export interface BuildTask {
  id: number; app: string; title: string; branch: string; base: string; status: BuildTaskStatus;
  prNumber: number | null; prUrl: string | null; headSha: string | null; ci: CiState; mergeSha: string | null;
  error: string | null; retryAt: number | null; createdAt: number; updatedAt: number;
}
export interface BuildState { running: boolean; task: BuildTask | null; messages: BuildMessage[] }
export interface AppSummary { name: string; adopted: boolean; manifestError: string | null; buildStatus: BuildTaskStatus | null; running: boolean }
export interface LoginRequest { passphrase: string }
export interface SendBuildRequest { text: string }
export interface TaskResponse { task: BuildTask }
export interface StopResponse { stopped: boolean }
export interface ApiErrorBody { error: string }
```

- Produces (`ws.ts`, replacing `export type ServerMsg = RenderReadyMsg;`):

```ts
export interface BuildMessageMsg { type: 'build.message'; app: string; message: BuildMessage }
export interface BuildTaskMsg { type: 'build.task'; app: string; task: BuildTask; running: boolean }
export interface PongMsg { type: 'pong'; t: number }
/** Server → client. Plans 4 and 6 add variants here and to SERVER_MSG_TYPES. */
export type ServerMsg = RenderReadyMsg | BuildMessageMsg | BuildTaskMsg | PongMsg;
export const SERVER_MSG_TYPES: readonly ServerMsg['type'][] = ['render.ready', 'build.message', 'build.task', 'pong'];
export interface PingMsg { type: 'ping'; t: number }
export type ClientMsg = PingMsg;
export function parseServerMsg(data: string): ServerMsg | null;  // JSON object whose `type` is in SERVER_MSG_TYPES; never throws
export function parseClientMsg(data: string): ClientMsg | null;  // only { type: 'ping', t: number }; never throws
```

- [ ] **Step 1: Write the failing tests** (`ws.test.ts`):
  - `parses known server messages`: `parseServerMsg('{"type":"pong","t":5}')` toEqual `{ type: 'pong', t: 5 }`.
  - `rejects unknown or malformed data`: `'nope'`, `'{"type":"x"}'`, `'[]'` and `'null'` → `null`.
  - `parseClientMsg accepts ping only`: `'{"type":"ping","t":1}'` → ok. `'{"type":"ping"}'` and `'{"type":"pong","t":1}'` → `null`.
  - `lists every server message type`: `SERVER_MSG_TYPES` toEqual `['render.ready','build.message','build.task','pong']`.
  - `open task statuses`: `isOpenTask('review') === true`, and `isOpenTask('merged')` and `isOpenTask('closed')` are false.
- [ ] **Step 2: Run** `pnpm -F @hub/protocol exec vitest run src/ws.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `api.ts` and the `ws.ts` additions. Use `import type` for DTOs in `ws.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/protocol test && pnpm -F @hub/protocol typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `packages/protocol/src` as `feat(protocol): build DTOs, server/client WebSocket messages`, with the attribution trailer your harness provides.

---

### Task 3: Server scaffold and config

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/config.ts`
- Modify: `pnpm-workspace.yaml`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: Task 1 (it must land first because both change `pnpm-lock.yaml`).
- Produces:

```ts
export interface HubConfig {
  bind: string; port: number; dataDir: string; appsDir: string; passphraseHash: string;
  githubToken: string | null; githubOwner: string | null; claudeOauthToken: string | null;
}
export class ConfigError extends Error {}
export const DEFAULT_PORT = 8787;
export const CREDENTIAL_KEYS: readonly string[] = ['HUB_PASSPHRASE_HASH', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
export const SECRET_ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'HCLOUD_TOKEN', 'HUB_PASSPHRASE_HASH', 'HUB_SSH_KEY_PATH', 'CREDENTIALS_DIRECTORY'];
export function loadConfig(env: Record<string, string | undefined>): HubConfig;
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string>;
```

Rules for `loadConfig`:
- A credential key's value is `env[K]` if non-blank. Otherwise it is the trimmed contents of `${env.CREDENTIALS_DIRECTORY}/${K}` when that file exists (systemd `LoadCredentialEncrypted`). Otherwise it is absent.
- Required: `HUB_BIND`, `HUB_DATA_DIR`, `HUB_APPS_DIR`, `HUB_PASSPHRASE_HASH`. All missing names go into one error: `` `Missing required environment variables: ${names.join(', ')}` `` (in that order).
- `HUB_BIND` in `['0.0.0.0', '::', '[::]', '*']` → `'HUB_BIND must be one specific address (127.0.0.1 behind tailscale serve), not a wildcard'`.
- `HUB_PORT` defaults to 8787. It must be an integer 1–65535, else `'HUB_PORT must be a port number'`.
- `HUB_PASSPHRASE_HASH` must start with `scrypt:`, else `'HUB_PASSPHRASE_HASH must come from: pnpm --silent -F @hub/server hash-passphrase'`.
- Directories go through `path.resolve`. `GITHUB_TOKEN`, `GITHUB_OWNER` and `CLAUDE_CODE_OAUTH_TOKEN` are `null` when absent.

`scrubEnv` copies every defined entry whose key is not in `SECRET_ENV_KEYS`.

- [ ] **Step 1: Scaffold.**
  - `package.json`: name `@hub/server`, `"private": true`, `"type": "module"`. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"start": "tsx src/main.ts"`, `"dev:fake": "tsx src/dev/fake-hub.ts"`, `"hash-passphrase": "tsx src/auth/hash-cli.ts"`.
  - Install all server dependencies now; no later task touches the lockfile:
    - `pnpm add -F @hub/server @hub/protocol@workspace:* hono@^4.13.13 @hono/node-server@^2.1.5 ws@^8.22.0 better-sqlite3@^13.0.3 simple-git@^3.36.0 @octokit/rest@^22.0.1 @anthropic-ai/claude-agent-sdk@^0.3.290 zod@^4.6.7 tsx@^4.23.15`
    - `pnpm add -D -F @hub/server @types/node@^22 @types/ws@^8.18.2 @types/better-sqlite3@^9.6.0 vitest@^5.0.4 typescript@^7.0.2`
    - pnpm auto-installs the SDK's other peers.
  - `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"], "esModuleInterop": true }, "include": ["src"] }`.
  - `vitest.config.ts`: `test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 }`.
  - Append this to `pnpm-workspace.yaml`, merging with any existing `allowBuilds` map:

    ```yaml
    allowBuilds:
      better-sqlite3: true
    ```

  - Run `pnpm install`.
- [ ] **Step 2: Write the failing tests** (`config.test.ts`). `FULL = { HUB_BIND: '127.0.0.1', HUB_PORT: '9000', HUB_DATA_DIR: 'data', HUB_APPS_DIR: '/srv/apps', HUB_PASSPHRASE_HASH: 'scrypt:x' }`.
  - `loads a full environment`: `loadConfig(FULL)` toEqual `{ bind: '127.0.0.1', port: 9000, dataDir: resolve('data'), appsDir: '/srv/apps', passphraseHash: 'scrypt:x', githubToken: null, githubOwner: null, claudeOauthToken: null }`.
  - `defaults the port to 8787`.
  - `lists every missing variable`: `loadConfig({})` throws `ConfigError` with exactly `'Missing required environment variables: HUB_BIND, HUB_DATA_DIR, HUB_APPS_DIR, HUB_PASSPHRASE_HASH'`.
  - `rejects wildcard binds`: `'0.0.0.0'` and `'::'` throw `/wildcard/`.
  - `rejects a bad port`: `'abc'` and `'70000'` throw `/HUB_PORT/`.
  - `rejects a hash that is not scrypt`.
  - `reads secrets from CREDENTIALS_DIRECTORY`:
    - In a temp dir, write `HUB_PASSPHRASE_HASH` (`'scrypt:file\n'`) and `GITHUB_TOKEN` (`'ghp_file\n'`).
    - Then `loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: undefined, CREDENTIALS_DIRECTORY: dir })` has `passphraseHash 'scrypt:file'` and `githubToken 'ghp_file'`.
    - An env value wins over the file.
  - `scrubEnv removes secrets and keeps the rest`: `scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', CREDENTIALS_DIRECTORY: '/run/c', CLAUDE_CODE_OAUTH_TOKEN: 'o', U: undefined })` toEqual `{ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }`.
- [ ] **Step 3: Run** `pnpm -F @hub/server test`. Expected: FAIL (`./config.js` missing).
- [ ] **Step 4: Implement** `src/config.ts`.
- [ ] **Step 5: Verify.**
  - `pnpm -F @hub/server test && pnpm -F @hub/server typecheck` passes.
  - `pnpm -F @hub/server exec node -e "const D=require('better-sqlite3'); new D(':memory:').close(); console.log('sqlite ok')"` prints `sqlite ok`, which proves the native build ran.
- [ ] **Step 6: Commit** `apps/server pnpm-workspace.yaml pnpm-lock.yaml` as `feat(server): scaffold, config with credentials and env scrubbing`, with the attribution trailer your harness provides.

---

### Task 4: SQLite and migrations

**Files:**
- Create: `apps/server/src/db.ts`
- Test: `apps/server/src/db.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
import Database from 'better-sqlite3';
export type Db = Database.Database;
/** MIGRATIONS[i] moves PRAGMA user_version from i to i+1. Later plans append; never edit an entry. */
export const MIGRATIONS: readonly string[];
export function migrate(db: Db, migrations?: readonly string[] /* default MIGRATIONS */): number;
export function openDb(file: string): Db;
```

`migrate` runs each pending migration in its own `db.transaction`, which executes the SQL and then `PRAGMA user_version = i+1`. It returns the final version and rethrows errors. `openDb`:
1. Unless the file is `':memory:'`, run `mkdirSync(dirname(file), { recursive: true })` and `pragma('journal_mode = WAL')`.
2. Then `pragma('foreign_keys = ON')` and `pragma('busy_timeout = 5000')`.
3. Then `migrate`.

`MIGRATIONS[0]` (exact):

```sql
CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE build_chats (app TEXT PRIMARY KEY, claude_session_id TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE build_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL,
  status TEXT NOT NULL, pr_number INTEGER, pr_url TEXT, head_sha TEXT, ci TEXT NOT NULL DEFAULT 'none', merge_sha TEXT,
  error TEXT, retry_at INTEGER, pending_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX build_tasks_app ON build_tasks (app, id);
CREATE TABLE build_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, task_id INTEGER REFERENCES build_tasks(id),
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX build_messages_app ON build_messages (app, id);
```

- [ ] **Step 1: Write the failing tests:**
  - `fresh db migrates to the latest version`: `openDb(':memory:')` → `pragma('user_version', { simple: true }) === MIGRATIONS.length`, and `sqlite_master` lists `auth_sessions`, `build_chats`, `build_tasks` and `build_messages`.
  - `migrate is idempotent`: a second `migrate(db)` returns the same version.
  - `applies only pending migrations`: `migrate(db, ['CREATE TABLE a(x)'])`, then `migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE b(y)'])` → returns 2, and both tables exist.
  - `a failing migration stops at the last good version`: on a fresh `new Database(':memory:')`, `migrate(db, ['CREATE TABLE a(x)', 'CREATE TABLE a(x)'])` throws and `user_version === 1`.
  - `file db uses WAL and creates its folder`: `openDb(join(tmp, 'sub', 'hub.sqlite'))` → `pragma('journal_mode', { simple: true }) === 'wal'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `db.ts`.
- [ ] **Step 4: Run** the same command. Expected: 5 pass.
- [ ] **Step 5: Commit** `apps/server/src/db.ts apps/server/src/db.test.ts` as `feat(server): sqlite with append-only migrations`, with the attribution trailer your harness provides.

---

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

### Task 7: App registry

**Files:**
- Create: `apps/server/src/apps/registry.ts`
- Test: `apps/server/src/apps/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseAppManifest`, `AppManifest`, `APP_MANIFEST_FILE` from `@hub/protocol/manifest`), Task 3.
- Produces:

```ts
export interface AppEntry { name: string; dir: string; adopted: boolean; manifest: AppManifest | null; manifestError: string | null }
export class AppRegistry {
  constructor(appsDir: string);
  list(): Promise<AppEntry[]>;              // sorted by name; missing appsDir → []
  get(name: string): Promise<AppEntry | null>;
}
```

Rules:
- An app is a directory directly in `appsDir` whose name does not start with `.` and that contains a `.git` entry (directory or file). Each call rescans; there is no cache.
- `get(name)` returns `null` for names containing `/` or `\`, for `.` and `..`, and for unknown names. It stats only that one directory.
- Manifest at `<dir>/.hub/app.json`:
  - Absent → `{ adopted: false, manifest: null, manifestError: null }`.
  - Unparsable → `manifestError` = the `parseAppManifest` error.
  - Valid but `manifest.name !== name` → `` `manifest name "${manifest.name}" does not match the folder name "${name}"` `` and `adopted: false`.
  - Otherwise `adopted: true`.

- [ ] **Step 1: Write the failing tests.** Make directories in a temp dir with `mkdirSync`; a fake `.git` directory is enough. Use the Task 1 `SPEC_EXAMPLE` manifest, copied into this test with `name` set per test.
  - `lists git checkouts only, sorted`: `zeta/.git/`, `alpha/.git` (a file), `notgit/`, `.hidden/.git/` and a file `readme.txt` → names `['alpha', 'zeta']`.
  - `valid manifest means adopted`: `alpha/.hub/app.json` with name `alpha` → `adopted: true` and `manifest.name === 'alpha'`.
  - `invalid manifest reports the error`: `'{'` → `manifestError === '.hub/app.json is not valid JSON'` and `adopted: false`.
  - `manifest name must match the folder`: name `other` in `alpha` → `manifestError` contains `does not match the folder name "alpha"`.
  - `get returns null for unknown or unsafe names`: `'nope'`, `'..'` and `'a/b'` → `null`. `get('alpha')` → entry.
  - `missing apps dir lists nothing`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/apps/registry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `registry.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** `apps/server/src/apps` as `feat(server): app registry over git checkouts with manifest validation`, with the attribution trailer your harness provides.

---

### Task 8: WebSocket hub

**Files:**
- Create: `apps/server/src/ws/hub.ts`, `apps/server/src/ws/attach.ts`
- Test: `apps/server/src/ws/ws.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ServerMsg`, `parseClientMsg`), Task 3, Task 6 (`readCookie`, tests only).
- Produces:

```ts
// hub.ts
export interface WsHub { broadcast(msg: ServerMsg): void }
export interface SocketLike { readonly readyState: number; send(data: string): void; ping(): void; terminate(): void }
export class SocketHub implements WsHub {
  add(s: SocketLike): void;            // new sockets start "alive"
  remove(s: SocketLike): void;
  size(): number;
  broadcast(msg: ServerMsg): void;     // JSON.stringify once; send to readyState === 1 only; a throwing send is ignored
  markAlive(s: SocketLike): void;      // called on 'pong'
  sweep(): void;                       // terminate+remove sockets not alive; ping the rest; mark all not alive
  handleMessage(s: SocketLike, data: string): void;   // parseClientMsg ping → s.send(JSON pong with same t); else ignore
}
// attach.ts
export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 30_000;
export function attachWebSocket(server: import('node:http').Server, hub: SocketHub,
  opts: { isAuthed: (cookieHeader: string | undefined) => boolean; heartbeatMs?: number }): { wss: WebSocketServer; close(): void };
```

`attachWebSocket` creates `new WebSocketServer({ noServer: true })` and handles `server.on('upgrade', (req, socket, head) => …)`:
- If the path (`new URL(req.url ?? '/', 'http://hub').pathname`) is not `/ws`, write `'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'` and destroy the socket.
- If `!opts.isAuthed(req.headers.cookie)`, write `'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'` and destroy it.
- Otherwise call `wss.handleUpgrade` and then:
  - `hub.add(ws)`
  - `ws.on('pong', () => hub.markAlive(ws))`
  - `ws.on('message', d => hub.handleMessage(ws, d.toString()))`
  - `ws.on('close', () => hub.remove(ws))`

A `setInterval(() => hub.sweep(), heartbeatMs).unref()` runs the heartbeat. `close()` clears the interval, terminates every client, and calls `wss.close()`.

- [ ] **Step 1: Write the failing tests.** Fake socket: `{ readyState: 1, sent: [] as string[], send(d) { this.sent.push(d) }, ping: vi.fn(), terminate: vi.fn() }`.
  - `broadcast sends JSON to open sockets only`: with an open and a closed (`readyState: 3`) socket, only the open one receives `JSON.stringify({ type: 'pong', t: 1 })`.
  - `a throwing socket does not stop the broadcast`.
  - `sweep terminates silent sockets and pings the rest`: `add(a)`, `add(b)`, `sweep()` → both pinged. Then `markAlive(a)` and `sweep()` → `b.terminate` called once, `a.ping` called twice, and `size() === 1`.
  - `ping gets a pong`: `handleMessage(s, '{"type":"ping","t":7}')` → `s.sent` toEqual `['{"type":"pong","t":7}']`. `handleMessage(s, 'garbage')` sends nothing.
  - Integration tests use `http.createServer((_q, r) => r.end())` and `attachWebSocket(server, hub, { isAuthed: h => readCookie(h, 'hub_session') === 'good' })`, listening on port 0 at `127.0.0.1`, with the `ws` client:
    - `rejects connections without a session`: `'unexpected-response'` with `res.statusCode === 401`.
    - `authed client receives broadcasts`: `new WebSocket(url, { headers: { cookie: 'hub_session=good' } })`; on open, `hub.broadcast({ type: 'pong', t: 1 })`. The client receives that JSON.
    - `other paths are refused`: `/nope` → `'unexpected-response'` with 404.
    - `closed sockets leave the hub`: `client.close()` → `expect.poll(() => hub.size()).toBe(0)`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/ws`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** `apps/server/src/ws` as `feat(server): WebSocket hub with cookie auth and heartbeat`, with the attribution trailer your harness provides.

---

### Task 9: ClaudeRunner contract, fake runner, deploy guard

**Files:**
- Create: `apps/server/src/claude/runner.ts`, `apps/server/src/claude/fake.ts`, `apps/server/src/claude/guard.ts`
- Test: `apps/server/src/claude/fake.test.ts`, `apps/server/src/claude/guard.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces (`runner.ts`; the architecture contract, plus the optional `signal`):

```ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'done'; sessionId: string; ok: boolean; error?: string };
export interface RunOptions {
  cwd: string; prompt: string; resume?: string; mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  systemPrompt?: string;   // appended to Claude Code's own system prompt
  signal?: AbortSignal;    // abort → done { ok: false, error: 'aborted' }
}
/** run() never throws and always ends with exactly one 'done'. */
export interface ClaudeRunner { run(opts: RunOptions): AsyncIterable<AgentEvent> }
export const USAGE_LIMIT = 'usage_limit';
export function usageLimitError(resetsAtMs: number | null): string;   // 'usage_limit' | `usage_limit:${resetsAtMs}`
export function parseUsageLimit(error: string | undefined): { resetsAtMs: number | null } | null;
```

- Produces (`fake.ts`):

```ts
export type FakeStep = AgentEvent | ((opts: RunOptions) => void | AgentEvent | Promise<void | AgentEvent>);
export class FakeClaudeRunner implements ClaudeRunner {
  constructor(scripts: FakeStep[][]);       // call i plays scripts[min(i, scripts.length - 1)]
  readonly calls: RunOptions[];
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}
```

`run` behavior:
- Before each step, if `opts.signal?.aborted`, yield `{ type: 'done', sessionId: '', ok: false, error: 'aborted' }` and stop.
- An event step is yielded. A function step is awaited, and its return value is yielded when it is an event.
- When the script ends without a `done`, yield `{ type: 'done', sessionId: 'fake-session', ok: true }`.

- Produces (`guard.ts`):

```ts
export const DEPLOY_DENY_RULES: readonly string[] = ['Bash(git push *)', 'Bash(docker *)', 'Bash(docker-compose *)', 'Bash(ssh *)',
  'Bash(scp *)', 'Bash(rsync *)', 'Bash(kubectl *)', 'Bash(hcloud *)', 'Bash(gh pr merge *)', 'Bash(gh workflow run *)',
  'Bash(gh release *)', 'Bash(npm publish *)', 'Bash(pnpm publish *)'];
export function deployDenyReason(command: string): string | null;
export function checkToolUse(cwd: string, toolName: string, input: Record<string, unknown>): string | null;
```

`deployDenyReason` algorithm. It is deliberately conservative: a false positive costs a retry, while a miss could deploy.
1. `s = command.replace(/["'`]/g, ' ').replace(/\$\(/g, ';').replace(/[()]/g, ' ')`, then segments = `s.split(/&&|\|\||[;|&\n]/)`, trimmed, non-empty.
2. Per segment, split words on whitespace. While the first word matches `/^[A-Za-z_][A-Za-z0-9_]*=/` or is one of `sudo env exec command nohup time xargs bash sh zsh -c -lc`, drop it. `program = basename(words[0])`.
3. Rules, checked in this order. Return the first reason found.

| Match | Reason (exact) |
|---|---|
| `git`, first non-option argument (skip `-C <x>`, `-c <x>` and other `-…`) is `push` | `git push is done by the Hub after its checks pass.` |
| `git`, subcommand `checkout` or `switch`, and a later word is exactly `main` or `master` | `Stay on the task branch; the Hub manages main.` |
| program in `docker docker-compose podman kubectl helm hcloud ssh scp sftp rsync flyctl fly vercel netlify terraform ansible ansible-playbook caddy` | `` `Deploying is a Hub action; ${program} is not allowed in Build.` `` |
| `gh` and args start with `pr merge`, `workflow run`, `release`, `secret` or `api` | `Merges, releases and workflow runs go through the Hub.` |
| `npm`/`pnpm`/`yarn`/`bun` and an argument is `publish` | `Publishing packages is not allowed in Build.` |
| `npm`/`pnpm`/`yarn`/`bun` and (`args[0] === 'deploy'` or `args[0] === 'run'` and `args[1]` starts with `deploy`) | `Deploying is a Hub action; deploy scripts are not allowed in Build.` |
| `curl` or `wget` and any word contains `api.hetzner.cloud` | `Deploying is a Hub action; the Hetzner API is not allowed in Build.` |

`checkToolUse`:
- `Bash` → `deployDenyReason(String(input.command ?? ''))`.
- `Edit`, `Write` and `NotebookEdit`: `p = resolve(cwd, String(input.file_path ?? input.notebook_path ?? ''))` and `rel = relative(cwd, p)`.
  - `rel` starts with `..` or is absolute → `` `Edits must stay inside the app checkout (${cwd}).` ``
  - `rel === '.git'` or starts with `.git/` → `Do not edit .git directly.`
- Any other tool → `null`.

- [ ] **Step 1: Write the failing tests.**
  - `guard.test.ts`:
    - `allows ordinary work`: each of `pnpm test`, `git status`, `git commit -m "push the button"`, `git checkout -b feature`, `git checkout -- src/a.ts`, `grep -r docker .`, `cat Dockerfile` and `echo ssh is fine` → `null`.
    - `denies composed and path-qualified deploy commands`: each of these gives a non-null reason:
      - `git push`, `git push origin build/x`, `cd web && git push`, `git -C web push`, `/usr/bin/git push`, `FOO=1 git push`
      - `sudo docker compose up`, `bash -c "ssh deploy@1.2.3.4"`, `echo hi; scp a b:/c`, `x=$(ssh host)`
      - `gh pr merge 3`, `pnpm publish`, `npm run deploy:prod`, `curl -X POST https://api.hetzner.cloud/v1/servers`
      - `git switch main`, `git checkout master`
    - `push reason is exact`: `deployDenyReason('git push')` === `'git push is done by the Hub after its checks pass.'`.
    - `edits stay in the checkout`: `checkToolUse('/repo', 'Write', { file_path: '/repo/src/a.ts' })` → `null`. `{ file_path: '/etc/passwd' }` and `{ file_path: '../other/x' }` contain `'inside the app checkout'`. `{ file_path: '.git/config' }` → `'Do not edit .git directly.'` `Read` with `{ file_path: '/etc/hosts' }` → `null`. `Bash` with `{ command: 'git push' }` → the push reason.
  - `fake.test.ts`:
    - `plays scripted events and appends done`: `[[{ type: 'text', text: 'a' }]]` → events `[text a, { type: 'done', sessionId: 'fake-session', ok: true }]`.
    - `functions run in order and may yield events`: a step `o => ({ type: 'text', text: o.cwd })` yields the cwd.
    - `later calls use later scripts, then repeat the last`: with 2 scripts and 3 calls, the third plays script 2. `calls.length === 3`.
    - `abort stops with an aborted done`: the signal is aborted before `run` → only `{ type: 'done', sessionId: '', ok: false, error: 'aborted' }`.
    - `usage limit helpers round-trip`: `usageLimitError(123) === 'usage_limit:123'` → `{ resetsAtMs: 123 }`. `usageLimitError(null) === 'usage_limit'` → `{ resetsAtMs: null }`. `parseUsageLimit('boom')` and `parseUsageLimit(undefined)` → `null`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/claude` as `feat(server): ClaudeRunner contract, fake runner, deploy guard`, with the attribution trailer your harness provides.

---

### Task 10: Agent SDK runner

**Files:**
- Create: `apps/server/src/claude/sdk.ts`
- Test: `apps/server/src/claude/sdk.test.ts`

**Interfaces:**
- Consumes: Task 9 (`RunOptions`, `AgentEvent`, `ClaudeRunner`, `usageLimitError`, `DEPLOY_DENY_RULES`, `checkToolUse`), Task 3 (`scrubEnv`).
- Produces:

```ts
import { query, type Options, type SDKMessage, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
export const AUTH_FAILED_MESSAGE = 'Claude Code is not logged in on the hub. Run `claude setup-token` and store the token with ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN (docs/hub-bootstrap.md).';
export interface RunnerContext { env: Record<string, string | undefined>; oauthToken: string | null }
export function guardHook(cwd: string): HookCallback;
export function buildQueryOptions(opts: RunOptions, ctx: RunnerContext): Options;
export interface MapState { sessionId: string | null; resultOk: boolean | null; resultError: string | null; apiError: string | null; limited: boolean; resetsAtMs: number | null }
export function newMapState(): MapState;
export function mapMessage(msg: SDKMessage, state: MapState): AgentEvent[];
export function finalEvent(state: MapState, opts: { resume?: string; aborted: boolean; thrown: unknown }): AgentEvent;
export class SdkClaudeRunner implements ClaudeRunner {
  constructor(opts?: { oauthToken?: string | null; env?: Record<string, string | undefined> /* process.env */; queryFn?: typeof query });
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}
```

`buildQueryOptions` returns exactly these keys. Omit `resume` when it is undefined. It does not set `abortController`.

```ts
{
  cwd: opts.cwd,
  ...(opts.resume ? { resume: opts.resume } : {}),
  permissionMode: 'bypassPermissions',          // full permissions inside the repo…
  allowDangerouslySkipPermissions: true,
  disallowedTools: [...DEPLOY_DENY_RULES],      // …but deploys are denied, even in bypass mode
  hooks: { PreToolUse: [{ hooks: [guardHook(opts.cwd)] }] },   // no matcher: every tool call
  canUseTool: async (toolName) => ({ behavior: 'deny', message: `${toolName} needs a person's approval and the Hub cannot ask. Ask in your reply instead.` }),
  allowedTools: opts.allowedTools ?? [],
  mcpServers: (opts.mcpServers ?? {}) as Options['mcpServers'],
  settingSources: ['project'],                  // the app's CLAUDE.md and .claude/settings.json
  systemPrompt: { type: 'preset', preset: 'claude_code', ...(opts.systemPrompt ? { append: opts.systemPrompt } : {}) },
  env: { ...scrubEnv(ctx.env), ...(ctx.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: ctx.oauthToken } : {}) },
}
```

`guardHook(cwd)`:
- If `input.hook_event_name !== 'PreToolUse'` → `{}`.
- `reason = checkToolUse(cwd, input.tool_name, input.tool_input as Record<string, unknown>)`.
- A reason → `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }`. No reason → `{}`.

`mapMessage` narrows on `msg.type`. If the installed SDK types differ, cast through `unknown` to these minimal shapes:
- `system` with `subtype === 'init'` → `state.sessionId = session_id`, `[]`.
- `assistant` → `[]` when `parent_tool_use_id !== null` (subagent internals stay hidden).
  - If `error` is set, `state.apiError = error`, and `'rate_limit'` also sets `limited = true`.
  - Then for each `message.content` block: `text` with non-blank text → `{ type: 'text', text }`; `tool_use` → `{ type: 'tool', name, input }`.
- `rate_limit_event`: when `rate_limit_info.status === 'rejected'`, set `limited = true`. If `resetsAt` is a number, `resetsAtMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt`.
- `result` → `sessionId = session_id`, `resultOk = subtype === 'success' && !is_error`. When it is not ok, `resultError = subtype === 'success' ? (result || 'Claude reported an error') : subtype`.
- Anything else → `[]`.

`finalEvent` sets `sessionId = state.sessionId ?? opts.resume ?? ''`. The rules apply in this order:
1. `limited` → `error: usageLimitError(resetsAtMs)`.
2. `aborted` → `'aborted'`.
3. `apiError` in `authentication_failed`/`oauth_org_not_allowed` → `AUTH_FAILED_MESSAGE`.
4. `resultOk === true` → `{ ok: true }` with no `error` key.
5. Otherwise `error = resultError ?? apiError ?? (thrown instanceof Error ? thrown.message : 'Claude Code ended without a result')`.

`run`:
1. Create an `AbortController` and link it to `opts.signal` (abort now if already aborted, otherwise `once` on `'abort'`).
2. Iterate `queryFn({ prompt: opts.prompt, options: { ...buildQueryOptions(opts, ctx), abortController: ac } })` and yield the events from `mapMessage`.
3. Catch any throw; the SDK throws after an error result.
4. Finally yield `finalEvent(state, { resume: opts.resume, aborted: ac.signal.aborted, thrown })`.

- [ ] **Step 1: Write the failing tests** (no real Claude):
  - `options give full repo permissions but deny deploys`:
    - Call `o = buildQueryOptions({ cwd: '/repo', prompt: 'x', resume: 's1', systemPrompt: 'extra' }, { env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g' }, oauthToken: 'o' })`.
    - Assert `cwd '/repo'`, `resume 's1'`, `permissionMode 'bypassPermissions'`, `allowDangerouslySkipPermissions true`.
    - Assert `disallowedTools` contains `'Bash(git push *)'`, `settingSources` is `['project']`, and `systemPrompt` toEqual `{ type: 'preset', preset: 'claude_code', append: 'extra' }`.
    - Assert `env` toEqual `{ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }`.
  - `no resume key when not resuming`: `'resume' in o === false`.
  - `PreToolUse hook denies a composed push`:
    - Call the hook from `o.hooks.PreToolUse[0].hooks[0]` with `({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd web && git push' }, session_id: 's', transcript_path: '', cwd: '/repo' } as any, 'tu1', { signal: new AbortController().signal })`.
    - It returns `hookSpecificOutput.permissionDecision === 'deny'`.
    - For `pnpm test` it returns `{}`.
  - `canUseTool denies and says why`: `o.canUseTool!('AskUserQuestion', {}, {} as any)` → `behavior 'deny'`, and the message contains `'AskUserQuestion'`.
  - `maps text and tool blocks`: an assistant message (`parent_tool_use_id: null`) with content `[{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]` → `[{ type: 'text', text: 'Hi' }, { type: 'tool', name: 'Bash', input: { command: 'ls' } }]`.
  - `hides subagent messages`: with `parent_tool_use_id: 'x'` → `[]`.
  - `success result ends ok`: init `session_id 'abc'`, then result `success` → `finalEvent` toEqual `{ type: 'done', sessionId: 'abc', ok: true }`.
  - `error result carries the subtype`: result `error_max_turns` → `ok: false`, `error: 'error_max_turns'`.
  - `rejected rate limit becomes usage_limit`: `{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1760000000 } }` → error `'usage_limit:1760000000000'`.
  - `assistant rate_limit error becomes usage_limit`: error `'usage_limit'`.
  - `authentication failure explains the fix`: assistant `error: 'authentication_failed'` → `AUTH_FAILED_MESSAGE`.
  - `run yields done after the query throws`: a fake `queryFn` async generator yields an init (`session_id 'abc'`) and then throws `new Error('process exited')` → the last event is `{ type: 'done', sessionId: 'abc', ok: false, error: 'process exited' }`.
  - `run aborts`: a fake `queryFn` waits for `options.abortController.signal`'s `abort`, then throws. Aborting `opts.signal` → error `'aborted'`.
  - `live: answers with the subscription login`: `test.skipIf(!process.env.HUB_LIVE_CLAUDE)`. `new SdkClaudeRunner({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })` in a temp dir, with prompt `'Reply with the single word OK and do nothing else.'` → some text event contains `OK`, and `done.ok === true`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude/sdk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sdk.ts`.
- [ ] **Step 4: Run** the same command. Expected: 13 pass and 1 skipped. `pnpm -F @hub/server typecheck` is clean.
- [ ] **Step 5: Commit** `apps/server/src/claude/sdk.ts apps/server/src/claude/sdk.test.ts` as `feat(server): Agent SDK runner with bypass permissions and a deploy-guard hook`, with the attribution trailer your harness provides.

---

### Task 11: Git wrapper and test repositories

**Files:**
- Create: `apps/server/src/git/git.ts`, `apps/server/src/git/test-repo.ts`
- Test: `apps/server/src/git/git.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
// git.ts (simple-git)
export interface GitIdentity { name: string; email: string }
export interface RepoOptions { token?: string | null; identity?: GitIdentity }
export interface GitRepo {
  readonly dir: string;
  currentBranch(): Promise<string>;                               // rev-parse --abbrev-ref HEAD
  defaultBranch(): Promise<string>;                               // symbolic-ref --short refs/remotes/origin/HEAD minus 'origin/'; else 'main' if origin/main exists; else 'master'
  fetch(): Promise<void>;                                         // fetch origin --prune (authed)
  createBranchFrom(branch: string, base: string): Promise<void>;  // checkout --no-track -B <branch> origin/<base>
  checkout(branch: string): Promise<void>;
  isDirty(): Promise<boolean>;                                    // staged, unstaged or untracked changes
  commitAll(message: string): Promise<string | null>;             // add -A; commit; full HEAD sha, or null when clean
  headSha(): Promise<string>;
  commitsAhead(base: string): Promise<number>;                    // rev-list --count origin/<base>..HEAD
  push(branch: string): Promise<void>;                            // push --set-upstream origin <branch> (authed)
  remoteUrl(): Promise<string | null>;                            // `git config --get remote.origin.url` (unexpanded)
}
export function gitEnv(identity?: GitIdentity): Record<string, string>;
// exactly: PATH, HOME (from process.env, defaults '/usr/bin:/bin' and '/tmp'), GIT_TERMINAL_PROMPT '0',
// plus GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL when identity is given
export function authConfig(token: string | null | undefined): string[];
// token → [`http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]; else []
export function openRepo(dir: string, opts?: RepoOptions): GitRepo;
// test-repo.ts (test support, used by Tasks 15–18 and 21)
export const TEST_IDENTITY: GitIdentity;           // { name: 'Hub Test', email: 'hub-test@example.com' }
export const TEST_REMOTE = 'https://github.com/acme/demo.git';
export interface TestRepo { origin: string; work: string }
export function makeTestRepo(opts?: { workDir?: string; files?: Record<string, string> }): TestRepo;
export function git(cwd: string, ...args: string[]): string;   // execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv(TEST_IDENTITY) } }).trim()
```

Both simple-git instances use `.env(gitEnv(opts.identity))`. That minimal env is required, because simple-git refuses `EDITOR`, `PAGER` and `GIT_CONFIG_*` in the env. The token goes only through `simpleGit({ baseDir, config: authConfig(token) })`, a second instance used only for `fetch` and `push`. It is never written to `.git/config`.

`makeTestRepo` steps:
1. `tmp = mkdtempSync(join(tmpdir(), 'hub-git-'))`, `origin = join(tmp, 'origin.git')`, `git init --bare -b main <origin>`.
2. In `seed = join(tmp, 'seed')`, run `git init -b main`, write `README.md` (`'# demo\n'`) plus `opts.files` (creating parent folders), `add -A`, `commit -m init`, `remote add origin <origin>`, `push origin main`. Then `rmSync(seed)`.
3. `work = opts.workDir ?? join(tmp, 'demo')`. Run `git clone <origin> <work>`.
4. In `work`, run `remote set-url origin https://github.com/acme/demo.git` and `config url.<origin>.insteadOf https://github.com/acme/demo.git`. The remote reads like GitHub, but fetch and push go to the local bare repo.

- [ ] **Step 1: Write the failing tests** (each uses `makeTestRepo()` and `openRepo(work, { identity: TEST_IDENTITY })`):
  - `knows the default and current branch`: `defaultBranch() === 'main'` and `currentBranch() === 'main'`.
  - `creates a branch from origin`: `createBranchFrom('build/x-1', 'main')` → `currentBranch() === 'build/x-1'`.
  - `commitAll commits everything or returns null`: a clean tree → `null`. Writing `a.txt` → `isDirty()` is true, and `commitAll('add a')` returns a 40-hex SHA equal to `headSha()`. Then `isDirty()` is false and `commitsAhead('main') === 1`.
  - `push publishes the branch`: after the commit, `push('build/x-1')` → `git(origin, 'rev-parse', 'refs/heads/build/x-1')` equals `headSha()`.
  - `token never lands in git config`: `openRepo(work, { token: 'secret-token', identity: TEST_IDENTITY }).push('build/x-1')` succeeds, and `.git/config` contains neither `secret-token` nor its base64.
  - `authConfig`: `authConfig('t')` toEqual `['http.https://github.com/.extraheader=AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==']`, and `authConfig(null)` is `[]`.
  - `remote url is the configured one`: `remoteUrl() === TEST_REMOTE`.
  - `gitEnv is minimal`: with `vi.stubEnv('PAGER', 'less')` and `vi.stubEnv('GITHUB_TOKEN', 'g')`, `Object.keys(gitEnv()).sort()` toEqual `['GIT_TERMINAL_PROMPT', 'HOME', 'PATH']`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/git`. Expected: FAIL.
- [ ] **Step 3: Implement** `git.ts` and `test-repo.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** `apps/server/src/git` as `feat(server): git wrapper with header-only auth and test repos`, with the attribution trailer your harness provides.

---

### Task 12: GitHub interface, fake and Octokit implementation

**Files:**
- Create: `apps/server/src/github/github.ts`, `apps/server/src/github/fake.ts`, `apps/server/src/github/octokit.ts`
- Test: `apps/server/src/github/github.test.ts`, `apps/server/src/github/octokit.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CiState`), Task 3.
- Produces:

```ts
// github.ts
export interface RepoRef { owner: string; repo: string }
export interface PrInfo { number: number; url: string; state: 'open' | 'closed'; merged: boolean; mergeSha: string | null; headSha: string; headRef: string; baseRef: string }
export interface CheckRun { name: string; status: string; conclusion: string | null }
export interface CiStatus { state: CiState; checks: CheckRun[] }
export interface MergeOutcome { merged: boolean; sha: string | null; message: string }
export interface GitHub {
  findOpenPr(r: RepoRef, branch: string): Promise<PrInfo | null>;
  createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  getPr(r: RepoRef, n: number): Promise<PrInfo>;
  checkStatus(r: RepoRef, sha: string): Promise<CiStatus>;
  merge(r: RepoRef, n: number, sha: string): Promise<MergeOutcome>;   // squash, pinned to sha; refusals return merged:false (no throw)
}
export const FAILED_CONCLUSIONS: readonly string[] = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'];
export function summarizeChecks(runs: readonly CheckRun[]): CiState;
// [] → 'none'; any completed run with a FAILED_CONCLUSIONS conclusion → 'failure';
// else any run not completed (or completed with conclusion null) → 'pending'; else 'success'
export function parseGitHubRemote(url: string): RepoRef | null;
// git@github.com:o/r(.git), ssh://git@github.com/o/r(.git), https://[user[:pass]@]github.com/o/r(.git) → { owner, repo }; anything else → null
// fake.ts
export class FakeGitHub implements GitHub {
  constructor(opts?: { autoGreenAfter?: number });   // set: a sha without explicit checks reports one in-progress run for its first N checkStatus calls, then one success run
  readonly prs: Map<number, PrInfo & { title: string; body: string }>;
  readonly merges: { number: number; sha: string }[];
  readonly calls: string[];                         // method names, in call order
  setChecks(sha: string, runs: CheckRun[]): void;   // explicit runs win; a sha with no runs and no autoGreen → []
  movePrHead(n: number, sha: string): void;
  markMerged(n: number): void;                      // merged on GitHub: merged true, state 'closed', mergeSha `merged-${n}`
  closePr(n: number): void;
}
// octokit.ts
export class OctokitGitHub implements GitHub {
  constructor(token: string, fetchFn?: typeof fetch);   // new Octokit({ auth: token, request: { fetch: fetchFn } })
}
```

`FakeGitHub` rules:
- `createPr` numbers PRs from 1, with `url` = `` `https://github.com/${owner}/${repo}/pull/${n}` ``, `state 'open'`, `merged false`, `mergeSha null`, `headSha` = `` `head-${n}` ``. Set the head with `movePrHead`, which a pushing caller would do. The service tests read `headSha` from git and do not depend on it. A second `createPr` for the same open `head` throws `Error('A pull request already exists for <head>')`.
- `findOpenPr` matches `headRef === branch && state === 'open'`.
- `getPr` on an unknown number throws `Error('Not Found')`.
- `merge` checks, in order:
  - The PR is not open → `{ merged: false, sha: null, message: 'Pull request is not open' }`.
  - `sha !== headSha` → `{ merged: false, sha: null, message: 'Head branch was modified. Review and try the merge again.' }`.
  - Otherwise mark the PR merged and closed with `mergeSha: `merged-${n}``, push to `merges`, and return `{ merged: true, sha: `merged-${n}`, message: 'Merged' }`.

`OctokitGitHub` maps each method to one Octokit call:
- `findOpenPr` → `rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open', per_page: 1 })`.
- `createPr` → `rest.pulls.create(...)`.
- `getPr` → `rest.pulls.get(...)`. `mergeSha` is `merge_commit_sha` when `merged`, else null.
- `checkStatus` → `rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 })`.
- `merge` → `rest.pulls.merge({ owner, repo, pull_number, merge_method: 'squash', sha })`. A `RequestError` with status 405 or 409 becomes `{ merged: false, sha: null, message: err.message }`; other errors rethrow.

PR fields map from `number`, `html_url`, `state`, `merged ?? false`, `head.sha`, `head.ref` and `base.ref`.

- [ ] **Step 1: Write the failing tests.**
  - `github.test.ts`:
    - `summarizeChecks`:
      - `[]` → `'none'`.
      - `[{ name: 'a', status: 'in_progress', conclusion: null }]` → `'pending'`.
      - success, skipped and neutral → `'success'`.
      - `[failure (completed), queued]` → `'failure'`.
      - `timed_out` → `'failure'`.
      - completed with `null` conclusion → `'pending'`.
    - `parseGitHubRemote`: `'git@github.com:o/r.git'`, `'https://github.com/o/r'`, `'https://github.com/o/r.git'`, `'https://x-access-token:abc@github.com/o/r.git'` and `'ssh://git@github.com/o/r.git'` → `{ owner: 'o', repo: 'r' }`. `'/tmp/origin.git'` and `'https://gitlab.com/o/r'` → `null`.
    - `fake numbers PRs and finds them by branch`.
    - `fake refuses a stale merge`: `movePrHead(1, 'h2')`, then `merge(r, 1, 'h1')` → `merged: false` and `merges` is empty.
    - `fake autoGreenAfter`: `new FakeGitHub({ autoGreenAfter: 1 })` gives `'pending'` and then `'success'` for the same sha.
  - `octokit.test.ts` uses a fake fetch that records `(url, init)` and returns `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`:
    - `createPr posts to the pulls endpoint`:
      - It requests `https://api.github.com/repos/o/r/pulls` with method `POST`.
      - The JSON body is `{ head: 'build/x-1', base: 'main', title: 'T', body: 'B' }`, and the `authorization` header is `'token tok'`.
      - The response `{ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open', merged: false, head: { sha: 'abc', ref: 'build/x-1' }, base: { ref: 'main' } }` maps to `PrInfo` with `mergeSha: null`.
    - `findOpenPr filters by owner and branch`: the URL's `searchParams.get('head') === 'o:build/x-1'` and `state === 'open'`. A `[]` response → `null`.
    - `checkStatus maps check runs`: `GET …/repos/o/r/commits/abc/check-runs`. The response `{ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }` → `{ state: 'success', checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }`.
    - `merge squashes and pins the sha`: `PUT …/repos/o/r/pulls/7/merge` with body `{ merge_method: 'squash', sha: 'abc' }`. The response `{ merged: true, sha: 'def', message: 'Pull Request successfully merged' }` → the same outcome.
    - `a refused merge is reported, not thrown`: status 405 with `{ message: 'Pull Request is not mergeable' }` → `merged: false`, and the message contains `not mergeable`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/github`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 12 pass.
- [ ] **Step 5: Commit** `apps/server/src/github` as `feat(server): GitHub interface with Octokit and fake implementations`, with the attribution trailer your harness provides.

---

### Task 13: Build store

**Files:**
- Create: `apps/server/src/build/store.ts`
- Test: `apps/server/src/build/store.test.ts`

**Interfaces:**
- Consumes: Task 2 (`BuildTask`, `BuildMessage`, `BuildMessageKind`, `BuildTaskStatus`, `OPEN_TASK_STATUSES`), Task 4 (`Db`, `openDb`).
- Produces:

```ts
export type TaskPatch = Partial<Pick<BuildTask, 'title' | 'branch' | 'status' | 'prNumber' | 'prUrl' | 'headSha' | 'ci' | 'mergeSha' | 'error' | 'retryAt'>> & { pendingPrompt?: string | null };
export class BuildStore {
  constructor(db: Db, now?: () => number);
  chatSession(app: string): string | null;
  setChatSession(app: string, sessionId: string | null): void;           // upsert into build_chats
  createTask(t: { app: string; title: string; branch: string; base: string }): BuildTask;   // status 'working', ci 'none', nulls elsewhere
  task(id: number): BuildTask | null;
  updateTask(id: number, patch: TaskPatch): BuildTask;                   // only the given keys; always bumps updatedAt
  openTask(app: string): BuildTask | null;                                // newest task of app with status in OPEN_TASK_STATUSES
  latestTask(app: string): BuildTask | null;
  tasksWithStatus(statuses: readonly BuildTaskStatus[]): BuildTask[];     // ascending id
  pendingPrompt(taskId: number): string | null;
  addMessage(m: { app: string; taskId: number | null; kind: BuildMessageKind; text: string }): BuildMessage;
  messages(app: string, afterId?: number, limit?: number /* 500 */): BuildMessage[];
  // ascending id; with afterId: id > afterId, first `limit`; without: the newest `limit`
  userPrompts(taskId: number): string[];                                  // 'user' messages of the task, ascending
}
```

Rows map from snake_case columns to the camelCase DTO fields.

- [ ] **Step 1: Write the failing tests** (`openDb(':memory:')`, with `now` returning a variable `t`):
  - `creates a task in working state`: `createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' })` toEqual a `BuildTask` with `id 1`, `status 'working'`, `ci 'none'`, every nullable field `null`, and `createdAt === updatedAt === t`.
  - `openTask returns the newest open task`: t1 merged, t2 working → t2. Then t2 closed → `null`.
  - `updateTask patches only the given fields`: `{ status: 'review', prNumber: 3 }` keeps `title`, and `updatedAt` advances with `t`.
  - `chat session round-trips`: `null` → `'abc'` → `null`.
  - `messages are ordered and paged by app`: 3 messages for `demo` and 1 for `other`. `messages('demo')` ids are ascending with length 3. `messages('demo', firstId)` has length 2.
  - `default page is the newest 500`: after 502 adds, `messages('demo')` has length 500 and the first id is 3.
  - `userPrompts lists the task's user messages`.
  - `pending prompt round-trips through updateTask`.
  - `tasksWithStatus and latestTask`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/store.ts apps/server/src/build/store.test.ts` as `feat(server): build store for tasks, chat session and messages`, with the attribution trailer your harness provides.

---

### Task 14: Build naming and command runner

**Files:**
- Create: `apps/server/src/build/naming.ts`, `apps/server/src/build/commands.ts`
- Test: `apps/server/src/build/naming.test.ts`, `apps/server/src/build/commands.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AppManifest`), Task 3 (`scrubEnv`).
- Produces:

```ts
// commands.ts
export type BuildCommandName = 'install' | 'typecheck' | 'test';
export interface BuildCommand { name: BuildCommandName; cmd: string }
export interface CommandResult { ok: boolean; code: number | null; output: string; timedOut: boolean; aborted: boolean }
export const OUTPUT_TAIL = 4000;
export const COMMAND_TIMEOUT_MS = 900_000;
export type RunCommand = (cmd: string, opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<CommandResult>;
export function resolveBuildCommands(dir: string, manifest: AppManifest | null): Promise<BuildCommand[]>;
export const runCommand: RunCommand;
// naming.ts
export function branchSlug(prompt: string, id: number): string;
export function prTitle(prompt: string): string;
export function prBody(prompts: readonly string[]): string;
export function summarizeTool(name: string, input: unknown, cwd: string): string;
export function buildSystemPrompt(branch: string): string;
export function fixPrompt(c: BuildCommand, r: CommandResult): string;
```

`resolveBuildCommands`:
- If the manifest is valid → `[install, typecheck, test]` from `manifest.build`, in that order.
- Otherwise, read `<dir>/package.json`. If it is missing or unparsable → `[]`.
- The package manager is `pnpm` when `pnpm-lock.yaml` exists, else `yarn` when `yarn.lock` exists, else `npm`.
- Install is `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci` (with `package-lock.json`) / `npm install` (without).
- `typecheck` is added when `scripts.typecheck` exists: `` `${pm} run typecheck` ``.
- `test` is added when `scripts.test` exists and does not contain `no test specified`: `` `${pm} test` ``.

`runCommand`:
- Runs `spawn('bash', ['-c', cmd], { cwd, env: { ...scrubEnv(process.env), CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`.
- Stdout and stderr are appended to one string. When it passes `2 * OUTPUT_TAIL` characters, keep only the last `OUTPUT_TAIL`. The result `output` is the last `OUTPUT_TAIL` characters.
- On timeout (`timeoutMs ?? COMMAND_TIMEOUT_MS`) or abort, run `process.kill(-pid, 'SIGTERM')` and then `SIGKILL` after 5 s.
- `ok = code === 0 && !timedOut && !aborted`.

`naming.ts` rules:
- `branchSlug`:
  1. Lowercase the prompt, replace `/[^a-z0-9]+/g` with spaces, split into words, and take the first 6.
  2. Join them with `-`, slice to 40 characters, and strip a trailing `-`.
  3. If the result is empty, use `'task'`. Then append `` `-${id}` ``.
- `prTitle`:
  1. Take the first line, collapse whitespace, and trim.
  2. If it is longer than 72 characters, use the first 71 plus `…`.
  3. If it is empty, use `'Hub build task'`.
- `prBody(prompts)` = `'Opened by the Hub Build area.\n\n## Requests\n\n' + prompts.map((p, i) => `${i + 1}. ${p.replace(/\s+/g, ' ').trim()}`).join('\n') + '\n'`.
- `summarizeTool`:
  - `Bash` → `$ ` plus the first line of `command`, cut to 160 characters plus `…` when longer.
  - `Read`, `Edit`, `Write` and `NotebookEdit` → `` `${name} ${shown}` ``. `shown` is the path relative to `cwd` when the path is inside it, else the absolute path.
  - `Grep` and `Glob` → `` `${name} ${pattern}` ``.
  - Anything else, including a non-object input → `name`.
- `buildSystemPrompt(branch)` (exact):

```
You are Claude Code running inside the Hub, in this app's git checkout on branch `${branch}`.
- Stay on this branch. Do not switch branches, push, merge or deploy: the Hub pushes, opens the pull request and deploys after its own checks.
- Make the change the user asks for, add or update tests, and run the project's typecheck and tests before you finish.
- Commit your work with a clear message when you are done.
- The user reads your replies on a tablet: keep them short and say what you changed.
```

- `fixPrompt(c, r)` (exact): `` `The Hub ran \`${c.cmd}\` (${c.name}) and it failed${r.timedOut ? ' (timed out)' : ` with exit code ${r.code}`}. Fix the cause, run it again yourself, and commit. Last output:\n\n${r.output.slice(-3000)}` ``.

- [ ] **Step 1: Write the failing tests.**
  - `naming.test.ts`:
    - `branch slugs`:
      - `('Add a dark-mode toggle to Settings!', 12)` → `'add-a-dark-mode-toggle-to-12'`.
      - `('!!!', 5)` → `'task-5'`.
      - `('Implement the extraordinarily comprehensive internationalization subsystem now', 9)` → `'implement-the-extraordinarily-comprehens-9'`.
    - `pr titles`: `'  Fix   the\nlogin bug'` → `'Fix the'`. `'a'.repeat(100)` → `'a'.repeat(71) + '…'`. `''` → `'Hub build task'`.
    - `pr body lists the requests`: `prBody(['one', 'two\nlines'])` === `'Opened by the Hub Build area.\n\n## Requests\n\n1. one\n2. two lines\n'`.
    - `tool summaries`:
      - `('Bash', { command: 'pnpm test\nmore' }, '/r')` → `'$ pnpm test'`.
      - A 200-character command → length 163 (`'$ '` + 160 + `…`).
      - `('Edit', { file_path: '/r/src/a.ts' }, '/r')` → `'Edit src/a.ts'`.
      - `('Read', { file_path: '/etc/hosts' }, '/r')` → `'Read /etc/hosts'`.
      - `('Grep', { pattern: 'TODO' }, '/r')` → `'Grep TODO'`.
      - `('mcp__x__y', null, '/r')` → `'mcp__x__y'`.
    - `system prompt names the branch`: it contains `` 'branch `build/x-1`' `` and `'Do not switch branches, push, merge or deploy'`.
    - `fix prompt quotes the command and exit code`: `fixPrompt({ name: 'test', cmd: 'pnpm test' }, { ok: false, code: 1, output: 'boom', timedOut: false, aborted: false })` contains ``'`pnpm test` (test) and it failed with exit code 1'`` and ends with `'boom'`.
  - `commands.test.ts`:
    - `manifest commands come first`: a manifest with build `{ install: 'i', typecheck: 'tc', test: 't' }` → `[{ name: 'install', cmd: 'i' }, { name: 'typecheck', cmd: 'tc' }, { name: 'test', cmd: 't' }]`.
    - `pnpm project without a manifest`: `pnpm-lock.yaml` plus scripts typecheck and test → `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`.
    - `npm default test script is skipped`: `package-lock.json` and `scripts.test = 'echo "Error: no test specified" && exit 1'` → only `[{ name: 'install', cmd: 'npm ci' }]`.
    - `yarn project`: `yarn install --frozen-lockfile`, `yarn run typecheck`, `yarn test`.
    - `no package.json means no commands`: `[]`.
    - `reports exit code and output`: `'echo out; echo err 1>&2; exit 3'` → `ok false`, `code 3`, and the output contains `out` and `err`.
    - `keeps only the output tail`: `"head -c 10000 /dev/zero | tr '\\0' x"` → `output.length === 4000`.
    - `times out and kills the process group`: `'sleep 10 & sleep 10; wait'` with `timeoutMs: 200` → `timedOut true`, resolving in under 3000 ms.
    - `abort stops the command`: abort after 100 ms on `'sleep 10'` → `aborted true`.
    - `secrets are not passed`: `vi.stubEnv('GITHUB_TOKEN', 'leak')`, then `'echo "${GITHUB_TOKEN:-none}"'` → the trimmed output is `'none'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/naming.test.ts src/build/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 16 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/naming.* apps/server/src/build/commands.*` as `feat(server): build naming helpers and process-group command runner`, with the attribution trailer your harness provides.

---

### Task 15: Build dependencies and one Claude turn

**Files:**
- Create: `apps/server/src/build/deps.ts`, `apps/server/src/build/turn.ts`
- Test: `apps/server/src/build/turn.test.ts`

**Interfaces:**
- Consumes: Task 7 (`AppRegistry`), Task 8 (`WsHub`), Task 9 (`ClaudeRunner`, `FakeClaudeRunner`, `parseUsageLimit`), Task 11 (`GitRepo`, `openRepo`), Task 12 (`GitHub`, `RepoRef`, `parseGitHubRemote`), Task 13 (`BuildStore`), Task 14 (`RunCommand`, `summarizeTool`, `buildSystemPrompt`).
- Produces:

```ts
// deps.ts
export interface BuildDeps {
  store: BuildStore;
  runner: ClaudeRunner;
  hub: WsHub;
  registry: Pick<AppRegistry, 'get'>;
  openRepo: (dir: string) => GitRepo;
  github: GitHub | null;
  runCommand: RunCommand;
  now: () => number;
  onMerged?: (e: { app: string; taskId: number; prNumber: number; sha: string }) => void;   // plan 4: staging deploy
}
export function addBuildMessage(deps: BuildDeps, app: string, taskId: number | null, kind: BuildMessageKind, text: string): BuildMessage;
// store.addMessage, then hub.broadcast({ type: 'build.message', app, message })
export function publishTask(deps: BuildDeps, task: BuildTask, running: boolean): void;
// hub.broadcast({ type: 'build.task', app: task.app, task, running })
export function repoRefFor(deps: BuildDeps, dir: string): Promise<RepoRef | null>;
// parseGitHubRemote((await deps.openRepo(dir).remoteUrl()) ?? '')
// turn.ts
export interface TurnInput { app: string; taskId: number; cwd: string; branch: string; prompt: string; signal: AbortSignal }
export interface TurnResult { ok: boolean; error: string | null; limited: boolean; resetsAtMs: number | null }
export const USAGE_RETRY_FALLBACK_MS = 900_000;
export function runTurn(deps: BuildDeps, input: TurnInput): Promise<TurnResult>;
export function queueAfterLimit(deps: BuildDeps, task: BuildTask, prompt: string, result: TurnResult): BuildTask;
```

`runTurn`:
1. Set `resume = store.chatSession(app) ?? undefined`. Play `runner.run({ cwd, prompt, resume, systemPrompt: buildSystemPrompt(branch), signal })`:
   - `text` → `addBuildMessage(…, 'assistant', e.text)`.
   - `tool` → `addBuildMessage(…, 'tool', summarizeTool(e.name, e.input, cwd))`.
   - Count those events and keep the `done`. A missing `done` counts as `{ ok: false, sessionId: '', error: 'Claude Code ended without a result' }`.
2. Retry once without resume when all of these hold: `!done.ok`, `resume` was set, 0 events, `parseUsageLimit(done.error) === null`, and `done.error !== 'aborted'`. Before the retry, `setChatSession(app, null)` and add a `status` message `'Could not resume the previous Claude session; starting a new one.'`. Then play once more with no resume.
3. If `done.sessionId` is non-empty, `setChatSession(app, done.sessionId)`.
4. Return:
   - limited: `{ ok: false, error: done.error, limited: true, resetsAtMs }`
   - ok: `{ ok: true, error: null, limited: false, resetsAtMs: null }`
   - otherwise: `{ ok: false, error: done.error ?? 'Claude Code failed', limited: false, resetsAtMs: null }`

`queueAfterLimit` updates the task to `{ status: 'queued', retryAt, pendingPrompt: prompt, error: null }`, where `retryAt = result.resetsAtMs ?? deps.now() + USAGE_RETRY_FALLBACK_MS`. It adds a `status` message `` `Claude usage limit reached. The Hub will retry at ${new Date(retryAt).toISOString().slice(11, 16)} UTC.` ``, calls `publishTask(task, false)`, and returns the task.

- [ ] **Step 1: Write the failing tests.**
  - Deps: a real `BuildStore(openDb(':memory:'), () => t)`, `hub = { sent: [] as ServerMsg[], broadcast(m) { this.sent.push(m) } }`, `FakeClaudeRunner`, and stubs for the rest (`registry: { get: async () => null }`, `github: null`, `runCommand: async () => …`, `openRepo: () => { throw new Error('unused') }`).
  - A task created with `store.createTask(...)` gives `taskId`. `input = { app: 'demo', taskId, cwd: '/r', branch: 'build/x-1', prompt: 'p', signal: new AbortController().signal }`.

  Tests:
  - `streams text and tools as messages`: script `[text 'Looking', tool Edit { file_path: '/r/a.ts' }, done ok 's1']` → `store.messages('demo').map(m => [m.kind, m.text])` toEqual `[['assistant', 'Looking'], ['tool', 'Edit a.ts']]`. `hub.sent` has 2 `build.message` entries, the result is `{ ok: true, error: null, limited: false, resetsAtMs: null }`, and `chatSession('demo') === 's1'`.
  - `resumes the chat session`: with `setChatSession('demo', 's0')` → `runner.calls[0].resume === 's0'`, and `systemPrompt` contains `build/x-1`.
  - `stale session falls back to a fresh one`:
    - Scripts `[[done ok:false error 'No conversation found' sessionId '']]` then `[[text 'Hi', done ok 's2']]`, with chat `'old'`.
    - Then `calls[0].resume === 'old'`, `calls[1].resume === undefined`, and a status message contains `'starting a new one'`.
    - Finally `chatSession === 's2'` and `ok === true`.
  - `does not retry after real work`: `[text 'x', done ok:false error 'boom']` with resume → `calls.length === 1` and the result is `{ ok: false, error: 'boom', … }`.
  - `usage limit is reported, not retried`: `[done ok:false error 'usage_limit:1760000000000' sessionId '']` with resume → `{ ok: false, limited: true, resetsAtMs: 1760000000000 }` and `calls.length === 1`.
  - `queueAfterLimit queues with the reset time`: status `'queued'`, `retryAt 1760000000000`, `store.pendingPrompt(id) === 'p'`, and the last message contains `'retry at'`. With `resetsAtMs: null` and `t = 1000`, `retryAt === 901000`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/turn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `deps.ts` and `turn.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/deps.ts apps/server/src/build/turn.*` as `feat(server): one Claude turn with streaming, resume fallback and usage-limit queueing`, with the attribution trailer your harness provides.

---

### Task 16: Finish a task (commit, verify and fix, push, PR)

**Files:**
- Create: `apps/server/src/build/finish.ts`
- Test: `apps/server/src/build/finish.test.ts`

**Interfaces:**
- Consumes: Task 15 (`BuildDeps`, `addBuildMessage`, `publishTask`, `repoRefFor`, `runTurn`, `queueAfterLimit`), Task 14 (`resolveBuildCommands`, `prBody`, `fixPrompt`), Task 11 (`makeTestRepo`, `TEST_IDENTITY`, `git`, tests), Task 12 (`FakeGitHub`, tests).
- Produces:

```ts
export const MAX_FIX_ATTEMPTS = 2;
export interface FinishInput { task: BuildTask; dir: string; manifest: AppManifest | null; signal: AbortSignal }
export function finishTask(deps: BuildDeps, input: FinishInput): Promise<BuildTask>;   // returns the final task row
```

Algorithm. Every status change goes through `store.updateTask` and then `publishTask(task, true)`. `fail(msg)` = update `{ status: 'failed', error: msg }`, add an `error` message `msg`, and return the task.
1. `repo = deps.openRepo(dir)`. If `currentBranch() !== task.branch` → `fail(`Claude switched to branch ${current}; the work must stay on ${task.branch}.`)`.
2. If `isDirty()`: `commitAll(task.title)` and add a `status` message `'Committed changes Claude left uncommitted.'`.
3. If `commitsAhead(task.base) === 0` → update to `no_changes`, add a status message `'No code changes, so no pull request.'`, and return.
4. If `task.prNumber` is set and `headSha() === task.headSha` → update to `review`, add a status message `'No new changes.'`, and return.
5. Verify. `commands = resolveBuildCommands(dir, manifest)`, `attempt = 0`.
   - If `commands` is empty, add the status message `'No typecheck or test commands found; skipped checks.'`
   - Loop: update to `verifying`. For each command:
     - Add a status message `` `Running ${c.name}: ${c.cmd}` `` and run `r = runCommand(c.cmd, { cwd: dir, signal })`.
     - `r.aborted` → `fail('Stopped by you.')`.
     - `!r.ok` and `attempt === MAX_FIX_ATTEMPTS`:
       - Add an `error` message with `r.output.slice(-1500)`.
       - Then `fail(`${c.name} still fails after ${MAX_FIX_ATTEMPTS} fix attempts.`)`.
     - `!r.ok` otherwise:
       1. Increment `attempt` and add a status message `` `${c.name} failed; asking Claude to fix it (attempt ${attempt} of ${MAX_FIX_ATTEMPTS}).` ``.
       2. Update to `working` and run `turn = runTurn(deps, { app, taskId, cwd: dir, branch, prompt: fixPrompt(c, r), signal })`.
       3. If `turn.limited` → `return queueAfterLimit(deps, task, fixPrompt(c, r), turn)`.
       4. If `!turn.ok` → `fail(turn.error === 'aborted' ? 'Stopped by you.' : turn.error!)`.
       5. Commit any leftovers as in step 2, then restart the loop from the first command.
   - The loop ends when every command passes.
6. Push. Update to `pushing` and run `push(task.branch)`. A throw → `fail(`git push failed: ${msg}`)`. Then add a status message `` `Pushed ${task.branch}.` ``.
7. Pull request:
   - `!deps.github` → `fail('GITHUB_TOKEN is not set: the branch was pushed but no pull request was opened.')`.
   - `ref = repoRefFor(deps, dir)`; `null` → `fail('origin is not a GitHub repository.')`.
   - `existing = findOpenPr(ref, branch)`.
   - If there is none, `createPr(ref, { head: branch, base: task.base, title: task.title, body: prBody(store.userPrompts(task.id)) })`. A throw → `fail(`Could not open the pull request: ${msg}`)`.
   - Update `{ status: 'review', prNumber, prUrl, headSha: await repo.headSha(), ci: 'pending', error: null }`.
   - Add a status message: `` `Updated pull request #${n}.` `` when it existed, else `` `Opened pull request #${n}.` ``.
   - Return.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `{ work } = makeTestRepo()`, then in `work`: `git checkout -b build/notes-1`.
    - `task = store.createTask({ app: 'demo', title: 'Add notes', branch: 'build/notes-1', base: 'main' })` and `store.addMessage({ app: 'demo', taskId: task.id, kind: 'user', text: 'add notes' })`.
    - `openRepo: d => openRepo(d, { identity: TEST_IDENTITY })`, `github = new FakeGitHub()`, `manifest.build = { install: 'i', typecheck: 'tc', test: 'pnpm test' }`.
    - `runCommand` is a fake keyed by `cmd` that returns `{ ok: true, code: 0, output: '', timedOut: false, aborted: false }` unless a test overrides it.
  - Tests:
    - `pushes and opens a PR when checks pass`:
      - Write `notes.md` (uncommitted), then `finishTask` → `status 'review'`, `prNumber 1`, `ci 'pending'`.
      - `github.prs.get(1)` has `headRef 'build/notes-1'` and a body containing `'1. add notes'`.
      - `git(origin, 'rev-parse', 'refs/heads/build/notes-1')` equals `headSha`.
      - The messages include `'Committed changes Claude left uncommitted.'` and `'Opened pull request #1.'`.
    - `no commits means no PR`: → `'no_changes'` and `github.calls` is empty.
    - `failing test is fixed by Claude, then passes`:
      - `pnpm test` fails the first time with code 1. The runner script `[o => writeFileSync(join(o.cwd, 'fix.txt'), 'x'), done ok 's']`.
      - `runner.calls[0].prompt` contains `'exit code 1'` and `` '`pnpm test`' ``. The final status is `'review'`.
    - `gives up after two fix attempts`: `pnpm test` always fails → `runner.calls.length === 2`, `status 'failed'`, error `'test still fails after 2 fix attempts.'`.
    - `switching branches fails the task`: `git checkout main` before → `failed`, and the error contains `'switched to branch main'`.
    - `existing PR is updated, not duplicated`: finish, add a commit, finish again → message `'Updated pull request #1.'` and `github.prs.size === 1`.
    - `follow-up without changes keeps the PR as is`: finish twice with no new commit → the second ends `'review'` with `'No new changes.'` and runs no commands.
    - `missing GitHub client fails after pushing`: `github: null` → `failed`, and the error starts with `'GITHUB_TOKEN is not set'`.
    - `usage limit during a fix queues the task`: `pnpm test` fails, and the runner script is `[done ok:false error 'usage_limit:99']` → `status 'queued'`, `retryAt 99`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/finish.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `finish.ts`.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/finish.*` as `feat(server): finish build tasks with verify/fix loop, push and PR`, with the attribution trailer your harness provides.

---

### Task 17: CI refresh and merge

**Files:**
- Create: `apps/server/src/build/ci.ts`
- Test: `apps/server/src/build/ci.test.ts`

**Interfaces:**
- Consumes: Task 15 (`BuildDeps`, `addBuildMessage`, `publishTask`, `repoRefFor`), Task 12 (`FakeGitHub`, `FAILED_CONCLUSIONS`), Task 13.
- Produces:

```ts
export class BuildError extends Error { constructor(message: string, readonly status: 400 | 404 | 409) }
export function refreshCi(deps: BuildDeps, taskId: number): Promise<BuildTask | null>;
export function pollCi(deps: BuildDeps, isRunning: (app: string) => boolean): Promise<void>;
export function mergeTask(deps: BuildDeps, app: string, taskId: number, running: boolean): Promise<BuildTask>;
```

`refreshCi`:
- Return the stored task unchanged when it is missing, not `review`, has no `prNumber`, `deps.github` is null, or the app or `RepoRef` can't be found. The `RepoRef` comes from `registry.get(task.app)` → `repoRefFor(deps, entry.dir)`.
- Call `pr = getPr`:
  - `pr.merged` → `{ status: 'merged', mergeSha: pr.mergeSha }`, a status message `` `Pull request #${n} was merged on GitHub.` ``, and `onMerged` when `mergeSha` is set.
  - `pr.state === 'closed'` → `closed` with a status message `` `Pull request #${n} was closed.` ``.
  - Otherwise call `ci = checkStatus(ref, pr.headSha)`. If `ci.state` or the head changed, update `{ ci: ci.state, headSha: pr.headSha }` and `publishTask(task, false)`.
- When the CI state changed:
  - to `success` → status message `'CI passed. Ready to merge.'`
  - to `failure` → `error` message `` `CI failed: ${failedNames.join(', ')}` ``, where the names are the checks with a `FAILED_CONCLUSIONS` conclusion.
- GitHub errors are caught (`console.warn`), and the task is returned unchanged.

`pollCi`: runs `refreshCi` in sequence for every `review` task whose app `!isRunning`.

`mergeTask` checks, in order:
1. Missing task or `task.app !== app` → `BuildError('Task not found', 404)`.
2. `running` → 409 `'Claude is still working on this app.'`.
3. Status `merged` → return it (idempotent).
4. Not `review`, or no `prNumber` → 409 `'This task has no open pull request.'`.
5. No github → 409 `'GITHUB_TOKEN is not set.'`.
6. `pr = getPr`:
   - `merged` → mark it merged and return.
   - Not `open` → mark it `closed` and throw 409 `'The pull request is closed.'`.
7. `ci = checkStatus(ref, pr.headSha)`. Update `{ ci, headSha }`. If `ci.state !== 'success'` → 409 `` `CI is ${ci.state === 'none' ? 'not reporting any checks' : ci.state}; merge needs green CI.` ``.
8. `out = github.merge(ref, pr.number, pr.headSha)`. If `!out.merged` → 409 `` `GitHub refused the merge: ${out.message}` ``.
9. Update `{ status: 'merged', mergeSha: out.sha, error: null }`, add a status message `` `Merged pull request #${n}.` ``, call `publishTask(task, false)` and `onMerged?.({ app, taskId, prNumber: n, sha: out.sha! })`, and return.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `registry = { get: async n => n === 'demo' ? { name: 'demo', dir: '/w', adopted: true, manifest: null, manifestError: null } : null }`.
    - `openRepo = () => ({ remoteUrl: async () => 'https://github.com/acme/demo.git' }) as unknown as GitRepo` and `github = new FakeGitHub()`.
    - Create PR 1 via `github.createPr` and `github.movePrHead(1, 'h1')`. The task is `review` with `prNumber 1`, `headSha 'h1'` and `ci 'pending'`.
  - Tests:
    - `refresh records green CI and announces it`: `setChecks('h1', [success])` → `ci 'success'` and the message `'CI passed. Ready to merge.'`.
    - `refresh names failed checks`: `[{ name: 'test', status: 'completed', conclusion: 'failure' }]` → an error message `'CI failed: test'`.
    - `refresh detects a PR merged on GitHub`: `markMerged(1)` → `status 'merged'`, `mergeSha 'merged-1'`, and `onMerged` is called.
    - `refresh detects a closed PR`.
    - `merge refuses while CI is pending`: `BuildError` 409 with a message containing `'pending'`, and `github.merges` is empty.
    - `merge refuses with no checks`: the message contains `'not reporting any checks'`.
    - `merge pins the PR head sha`:
      - With `h1` green → `merges[0]` toEqual `{ number: 1, sha: 'h1' }`.
      - The task is `merged` with `mergeSha 'merged-1'`.
      - `onMerged` is called with `{ app: 'demo', taskId, prNumber: 1, sha: 'merged-1' }`.
    - `merge rechecks CI on the current head`: `h1` is green, but `movePrHead(1, 'h2')` with `h2` pending → 409, no merge, and the task's `headSha` is `'h2'`.
    - `merge refuses while Claude is running`: 409.
    - `unknown task or wrong app is 404`.
    - `pollCi skips running apps`: `isRunning = () => true` → `github.calls` is empty.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/ci.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ci.ts`.
- [ ] **Step 4: Run** the same command. Expected: 11 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/ci.*` as `feat(server): CI tracking and green-only merge pinned to the PR head`, with the attribution trailer your harness provides.

---

### Task 18: BuildService

**Files:**
- Create: `apps/server/src/build/service.ts`
- Test: `apps/server/src/build/service.test.ts`

**Interfaces:**
- Consumes: Tasks 15, 16, 17 (`runTurn`, `queueAfterLimit`, `finishTask`, `refreshCi`, `pollCi`, `mergeTask`, `BuildError`), Task 14 (`branchSlug`, `prTitle`), Task 2 (`isOpenTask`, `BuildState`), Task 11 (tests), Task 12 (tests).
- Produces:

```ts
export const MAX_MESSAGE_CHARS = 20_000;
export class BuildService {
  constructor(deps: BuildDeps);
  isRunning(app: string): boolean;
  latestStatus(app: string): BuildTaskStatus | null;
  state(app: string, after?: number): Promise<BuildState>;   // { running, task: latestTask, messages: store.messages(app, after) }; 404 for unknown app
  send(app: string, text: string): Promise<BuildTask>;        // resolves after git prep, while Claude runs in the background
  stop(app: string): boolean;
  close(app: string, taskId: number): Promise<BuildTask>;
  merge(app: string, taskId: number): Promise<BuildTask>;     // mergeTask(deps, app, id, isRunning(app))
  idle(app: string): Promise<void>;                            // resolves when the app's background work ends (tests, shutdown)
  stopAll(): Promise<void>;                                    // abort every run and await idle
  recover(): number;
  retryQueued(): Promise<number>;
  pollCi(): Promise<void>;                                     // pollCi(deps, a => this.isRunning(a))
}
```

`send(app, text)`:
1. `t = text.trim()`. Empty → `BuildError('Message is empty.', 400)`. Longer than `MAX_MESSAGE_CHARS` → 400 `'Message is longer than 20000 characters.'`.
2. `entry = registry.get(app)`. Missing → 404 `'Unknown app'`.
3. `isRunning(app)` → 409 `'Claude is already working on this app. Wait or tap Stop.'`.
4. Reserve `running.set(app, new AbortController())` before the first `await`, so two sends can't race. Release it on any error in steps 5–6.
5. Find the task: `task = store.openTask(app)`. If it is `review`, `task = await refreshCi(...)`. If it is no longer open, `task = null`.
6. Prepare git with `repo = openRepo(entry.dir)`:
   - **Task exists:** if `currentBranch() !== task.branch`, `checkout(task.branch)`.
   - **No task:** if `isDirty()` → 409 `` `The checkout has uncommitted changes on ${branch}. Commit or discard them first.` ``. Otherwise:
     1. `fetch()` and `base = defaultBranch()`.
     2. `task = store.createTask({ app, title: prTitle(t), branch: '', base })` and `branch = `build/${branchSlug(t, task.id)}``.
     3. `updateTask(task.id, { branch })` and `createBranchFrom(branch, base)`.
   - A git error → if a task was created, mark it `failed` with the message. Throw 409 `` `Git: ${msg}` ``.
7. Add a `user` message `t` and `publishTask(task, true)`.
8. Start `work(...)` without awaiting it, store the promise for `idle`, and return `store.task(id)`.

`work(app, entry, task, prompt, controller)`:
1. Update `{ status: 'working', error: null, retryAt: null, pendingPrompt: null }` and publish.
2. `r = runTurn(...)`:
   - `r.limited` → `queueAfterLimit`.
   - `!r.ok` → `failed`, with error `r.error === 'aborted' ? 'Stopped by you.' : r.error`, plus an `error` message.
   - Otherwise → `finishTask(deps, { task: store.task(id)!, dir: entry.dir, manifest: entry.manifest, signal })`.
3. An unexpected throw → `failed` with `` `Unexpected error: ${msg}` ``.
4. `finally`: delete the running and inflight entries, and `publishTask(store.task(id)!, false)`.

Other methods:
- `stop(app)` aborts the app's controller and returns whether one existed.
- `close(app, id)`:
  1. A missing task or wrong app → 404 `'Task not found'`. A running app → 409 `'Claude is still working on this app.'`.
  2. `merged` or `closed` → return it as is.
  3. Otherwise set `closed` with `error: null`, add a status message `'Task closed. The next message starts a new branch.'` and publish.
- `recover()`: every task in `working`, `verifying` or `pushing` becomes `failed` with error `'Interrupted because the Hub restarted. Send a message to continue.'`, plus an `error` message. Returns the count.
- `retryQueued()`:
  1. For each `queued` task with `retryAt <= now()` whose app is not running and still exists:
     - Reserve the app.
     - Add a status message `'Retrying after the usage limit.'`.
     - Check out the task's branch.
     - Start `work` with `store.pendingPrompt(id) ?? 'Continue where you left off.'`.
  2. Return the number started.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `{ origin, work } = makeTestRepo({ files: { '.hub/app.json': JSON.stringify(manifestFor('demo')) } })`, where `manifestFor(name)` is Task 1's `SPEC_EXAMPLE` with `name`. `entry = { name: 'demo', dir: work, adopted: true, manifest, manifestError: null }`.
    - `registry = { get: async n => n === 'demo' ? entry : null }`, `openRepo = d => openRepo(d, { identity: TEST_IDENTITY })`, `github = new FakeGitHub()`.
    - `runCommand` is a fake that is always ok. `now` returns a variable `t`. `write = (name: string) => (o: RunOptions) => { writeFileSync(join(o.cwd, name), 'x') }`.
  - Tests:
    - `a prompt runs Claude on a new build branch and opens a PR`:
      - Script `[write('notes.md'), text 'Done.', done ok 's1']`.
      - `send('demo', 'Add a notes file')` resolves to `{ status: 'working', branch: 'build/add-a-notes-file-1' }`.
      - After `idle('demo')`: the task is `review` with `prNumber 1`, and the message kinds include `user`, `assistant` and `status`.
      - `runner.calls[0].cwd === work`, `git(work, 'branch', '--show-current') === 'build/add-a-notes-file-1'`, and origin's `main` SHA is unchanged.
    - `a second prompt continues the open task`: the same task id, `runner.calls[1].resume === 's1'`, and `github.prs.size === 1`.
    - `a concurrent prompt is refused`: the first script waits on a deferred promise. The second `send` rejects with `BuildError` status 409.
    - `a dirty checkout blocks a new task`: write `stray.txt` first → 409 with a message containing `'uncommitted changes'`.
    - `stop aborts the run`: the script step `o => new Promise<void>(r => o.signal!.addEventListener('abort', () => r()))` → `stop('demo') === true`. After `idle`, the task is `failed` with error `'Stopped by you.'`.
    - `usage limit queues the task and retryQueued resumes it`:
      - Scripts `[[done ok:false error 'usage_limit:5000' sessionId '']]` then `[[write('a.txt'), done ok 's2']]`, with `t = 1000`.
      - After `idle`, the task is `queued` with `retryAt 5000`.
      - `retryQueued()` at `t = 4000` → 0. At `t = 6000` → 1. After `idle`, the task is `review` and `runner.calls[1].prompt === 'Add a notes file'`.
    - `recover marks interrupted tasks failed`: a task set to `verifying` through the store → a new service's `recover() === 1`, and the error contains `'Hub restarted'`.
    - `a merged PR starts a new task on the next prompt`: after the first task reaches `review`, `github.markMerged(1)`. The next `send` creates task 2 on `build/…-2`, and the runner's `resume` is still `'s1'`.
    - `close ends the task so the next prompt starts a new branch`.
    - `rejects empty messages and unknown apps`: 400 and 404.
    - `state returns messages after an id`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/server test`. Expected: all server tests pass.
- [ ] **Step 5: Commit** `apps/server/src/build/service.*` as `feat(server): BuildService with one chat per app, stop, queue and recovery`, with the attribution trailer your harness provides.

---

### Task 19: Render file endpoints

**Files:**
- Create: `apps/server/src/design/render-files.ts`
- Test: `apps/server/src/design/render-files.test.ts`

**Interfaces:**
- Consumes: Task 3; plan 2's `RenderManifest`, `MANIFEST_PATH` and path layout (`tiles/<key>/<x>_<y>.webp`, `hitmaps/<hash>.json`, as written by `FsTileStore`).
- Produces:

```ts
export const EMPTY_MANIFEST: RenderManifest = { version: 1, pages: [] };
export function renderDir(dataDir: string, app: string): string;     // join(dataDir, 'renders', app); plan 6 writes FsTileStore here
export function renderRoutes(opts: { dataDir: string; hasApp: (app: string) => Promise<boolean> }): Hono;   // mount at /api/apps
```

Routes:
- `GET /:app/render/manifest.json` → the file, or `EMPTY_MANIFEST` when it is missing. `content-type: application/json`, `Cache-Control: no-cache`.
- `GET /:app/render/tiles/:key/:tile`: `key` must match `/^[0-9a-f]{64}$/` and `tile` must match `/^\d+_\d+\.webp$/`. Responds `image/webp` with `Cache-Control: private, max-age=31536000, immutable`.
- `GET /:app/render/hitmaps/:file`: `file` must match `/^[0-9a-f]{64}\.json$/`. Responds `application/json`, immutable.
- An unknown app → 404 `{ error: 'Unknown app' }`. A bad name or missing file → 404 `{ error: 'Not found' }`.

- [ ] **Step 1: Write the failing tests** (`new Hono().route('/api/apps', renderRoutes({ dataDir, hasApp: async a => a === 'demo' || a === 'empty' }))`, with `K = 'a'.repeat(64)` and files written under `renderDir(dataDir, 'demo')`):
  - `serves the manifest without caching`: 200, the JSON is equal, and `cache-control` is `'no-cache'`.
  - `missing manifest is empty`: `/api/apps/empty/render/manifest.json` → `{ version: 1, pages: [] }`.
  - `serves tiles as immutable webp`: `/tiles/${K}/0_0.webp` → `content-type 'image/webp'`, the immutable cache header, and equal bytes.
  - `serves hit maps`.
  - `unknown app is 404`.
  - `rejects malformed names`: `tiles/..%2F..%2Fetc/0_0.webp`, `tiles/abc/0_0.webp`, `tiles/${K}/x_y.webp` and `hitmaps/..%2Fx.json` → 404.
  - `missing tile is 404`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/design`. Expected: FAIL.
- [ ] **Step 3: Implement** `render-files.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 pass.
- [ ] **Step 5: Commit** `apps/server/src/design` as `feat(server): render manifest, tile and hit map endpoints`, with the attribution trailer your harness provides.

---

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

### Task 22: Client network layer (API, WebSocket, server tile source)

**Files:**
- Create: `apps/client/src/net/api.ts`, `apps/client/src/net/ws.ts`, `apps/client/src/net/tile-source.ts`
- Test: `apps/client/src/net/api.test.ts`, `apps/client/src/net/ws.test.ts`, `apps/client/src/net/tile-source.test.ts`

**Interfaces:**
- Consumes: Task 2 (DTOs, `ServerMsg`, `parseServerMsg`); plan 2 Task 16 (`TileSource`, `StaticTileSource` from `../canvas/source.js`).
- Produces:

```ts
// api.ts
export class ApiError extends Error { constructor(readonly status: number, message: string) }
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export class ApiClient {
  constructor(opts?: { fetchFn?: FetchFn; onUnauthorized?: () => void });
  login(passphrase: string): Promise<void>;
  logout(): Promise<void>;
  session(): Promise<boolean>;                 // 200 → true, 401 → false, other → ApiError; network errors propagate
  apps(): Promise<AppSummary[]>;
  buildState(app: string, after?: number): Promise<BuildState>;
  sendBuild(app: string, text: string): Promise<BuildTask>;
  stopBuild(app: string): Promise<boolean>;
  merge(app: string, taskId: number): Promise<BuildTask>;
  closeTask(app: string, taskId: number): Promise<BuildTask>;
}
// ws.ts
export type WsStatus = 'connecting' | 'open' | 'closed';
export interface SocketLike {
  readyState: number; send(data: string): void; close(): void;
  onopen: ((ev: unknown) => void) | null; onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export interface WsClientOptions { url: string; makeSocket?: (url: string) => SocketLike; now?: () => number; pingMs?: number /* 25_000 */; pongTimeoutMs?: number /* 10_000 */; maxBackoffMs?: number /* 30_000 */ }
export function wsUrl(loc: { protocol: string; host: string }): string;   // 'wss://host/ws' for https:, else 'ws://host/ws'
export class WsClient {
  constructor(opts: WsClientOptions);
  connect(): void;
  close(): void;                                                      // stops reconnecting
  kick(): void;                                                       // open → ping now; otherwise reconnect now with backoff reset
  on(listener: (msg: ServerMsg) => void): () => void;                 // pong is not forwarded
  onStatus(listener: (s: WsStatus) => void): () => void;
  get status(): WsStatus;
}
// tile-source.ts
export function renderBase(app: string): string;   // `/api/apps/${encodeURIComponent(app)}/render`
export class ServerTileSource implements TileSource {
  constructor(app: string, ws: Pick<WsClient, 'on'>, fetchFn?: (url: string) => Promise<Response>);
  // manifest/tile/hitMap delegate to new StaticTileSource(renderBase(app), fetchFn); subscribe → render.ready for this app only
}
```

`ApiClient` behavior:
- Same-origin paths under `/api` with `credentials: 'same-origin'`. Bodies are JSON with `content-type: application/json`. App names go through `encodeURIComponent`.
- A non-OK response throws `ApiError(status, body.error ?? `HTTP ${status}`)`.
- A 401 from any call except `login` and `session` first calls `onUnauthorized`.

`WsClient` behavior:
- The default `makeSocket` is `u => new WebSocket(u) as unknown as SocketLike`. Timers use the global `setTimeout`/`setInterval`.
- On open: status `open`, reset `attempt = 0`, and start the ping interval.
- Each ping sends `JSON.stringify({ type: 'ping', t: now() })` and arms a pong timer. If no `pong` arrives within `pongTimeoutMs`, call `socket.close()`.
- On close: clear the timers and set status `closed`. Unless `close()` was called, reconnect after `min(maxBackoffMs, 1000 * 2 ** attempt)`, then `attempt++`.
- Messages go through `parseServerMsg`, and invalid ones are dropped.

- [ ] **Step 1: Write the failing tests.**
  - `api.test.ts` uses a fake fetch that records `[url, init]`:
    - `login posts the passphrase`: `'/api/login'`, `POST`, body `'{"passphrase":"p"}'`, `content-type application/json`.
    - `wrong passphrase throws the server message`: 401 `{ error: 'Wrong passphrase' }` → `ApiError` with status 401 and message `'Wrong passphrase'`, and `onUnauthorized` is not called.
    - `401 elsewhere calls onUnauthorized`: `apps()` → called once, and the call rejects.
    - `session is false on 401`.
    - `buildState encodes the app and passes after`: `buildState('my app', 5)` → `'/api/apps/my%20app/build?after=5'`. Without `after` → `'/api/apps/my%20app/build'`.
    - `sendBuild returns the task`: 202 `{ task }` → `task`.
  - `ws.test.ts` uses `vi.useFakeTimers()` and a `FakeSocket` with:
    - `readyState 0`, `sent: string[]`, `open()` (sets `readyState 1` and calls `onopen`), `receive(obj)` (calls `onmessage({ data: JSON.stringify(obj) })`).
    - `close()`, which when not already 3 sets `readyState 3` and calls `onclose`.

    Tests:
    - `wsUrl`: `{ protocol: 'https:', host: 'h' }` → `'wss://h/ws'`. `http:` → `'ws://h/ws'`.
    - `delivers parsed messages`: a `build.task` message reaches the listener. `'garbage'` and a pong do not.
    - `reconnects with backoff`:
      - Close the first socket → at +999 ms there is still 1 socket; at +1 ms there are 2.
      - Close the second → +1999 ms still 2; +1 ms gives 3.
    - `backoff resets after open`.
    - `missing pong forces a reconnect`:
      - After `open()`, advance 25 000 ms → `sent[0]` matches `/"type":"ping"/`.
      - Advance 10 000 ms → that socket has `readyState 3` and the status is `'closed'`.
      - Advance 1000 ms → there are 2 sockets.
    - `a pong keeps the connection`.
    - `kick reconnects immediately when closed`.
    - `close stops reconnecting`: after `close()`, advancing 60 000 ms leaves 1 socket.
    - `status transitions`: `['connecting', 'open', 'closed', 'connecting']`.
  - `tile-source.test.ts`:
    - `fetches under the app's render path`: `manifest()` → `'/api/apps/demo/render/manifest.json'`. `tile('k', 1, 2)` → `'/api/apps/demo/render/tiles/k/1_2.webp'`.
    - `subscribe gets render.ready for this app only`: a fake `ws.on` captures the listener. A `render.ready` for `other` is ignored, the one for `demo` calls back with its manifest, and unsubscribe stops further calls.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/net`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 17 pass. `pnpm -F @hub/client typecheck` is clean.
- [ ] **Step 5: Commit** `apps/client/src/net` as `feat(client): typed API client, reconnecting WebSocket, server tile source`, with the attribution trailer your harness provides.

---

### Task 23: Client routing and Build view state

**Files:**
- Create: `apps/client/src/shell/route.ts`, `apps/client/src/areas/build/state.ts`
- Test: `apps/client/src/shell/route.test.ts`, `apps/client/src/areas/build/state.test.ts`

**Interfaces:**
- Consumes: Task 2 (DTOs, `ServerMsg`).
- Produces:

```ts
// route.ts
export type Area = 'design' | 'build' | 'deploy';
export const AREAS: readonly Area[] = ['design', 'build', 'deploy'];
export const AREA_LABEL: Readonly<Record<Area, string>> = { design: 'Design', build: 'Build', deploy: 'Deploy' };
export type Route = { name: 'apps' } | { name: 'app'; app: string; area: Area };
export function parseHash(hash: string): Route;
// '' | '#' | '#/' → apps; '#/apps/<enc>' → area 'build'; '#/apps/<enc>/<area>' (unknown area → 'build'); a bad escape or anything else → apps
export function formatRoute(r: Route): string;   // '#/' or `#/apps/${encodeURIComponent(app)}/${area}`
// state.ts
export interface BuildView { loaded: boolean; running: boolean; task: BuildTask | null; messages: BuildMessage[] }
export const EMPTY_VIEW: BuildView;               // { loaded: false, running: false, task: null, messages: [] }
export const MAX_VIEW_MESSAGES = 1000;
export const STATUS_LABEL: Readonly<Record<BuildTaskStatus, string>>;
export function applyState(v: BuildView, s: BuildState): BuildView;
export function applyServerMsg(v: BuildView, app: string, m: ServerMsg): BuildView;   // returns v itself when m is irrelevant
export function lastMessageId(v: BuildView): number;   // 0 when empty
export interface TaskSummary { label: string; tone: 'busy' | 'ok' | 'warn' | 'error' | 'done'; canMerge: boolean; mergeHint: string | null }
export function summarizeTask(t: BuildTask, running: boolean): TaskSummary;
```

`STATUS_LABEL` (exact): `{ working: 'Claude is working', verifying: 'Running checks', pushing: 'Pushing', review: 'Pull request open', no_changes: 'No changes', failed: 'Failed', queued: 'Queued (usage limit)', merged: 'Merged', closed: 'Closed' }`.

Merging rules:
- Messages merge by id: dedupe, ascending order, and keep only the newest `MAX_VIEW_MESSAGES`.
- A task replaces the current one when there is none, when its id is greater, or when the id is the same and `updatedAt >=` the current one's.
- `applyState` sets `running` and `loaded: true`. `build.task` sets `running` from the message.

`summarizeTask` labels:
- For `review` the label depends on CI: success → `'Ready to merge'`, pending → `'Waiting for CI'`, failure → `'CI failed'`, none → `'No CI checks'`.
- Every other status uses `STATUS_LABEL`.

`summarizeTask` tones:
- `busy` for working, verifying and pushing.
- `ok` for review + success.
- `warn` for review + pending or none, and for queued.
- `error` for review + failure and for failed.
- `done` for no_changes, merged and closed.

`canMerge = status === 'review' && ci === 'success' && !running`. `mergeHint` (exact), checked in this order:
1. `canMerge` → `null`.
2. running → `'Wait for Claude to finish.'`.
3. review + pending → `'Merge unlocks when CI is green.'`.
4. review + failure → `'Fix CI before merging.'`.
5. review + none → `'This repo reports no CI checks, so the Hub cannot merge it.'`.
6. Anything else → `null`.

- [ ] **Step 1: Write the failing tests.**
  - `route.test.ts`:
    - Round trips: `formatRoute({ name: 'app', app: 'my app', area: 'design' })` === `'#/apps/my%20app/design'`, and it parses back.
    - `'#/apps/x'` → area `'build'`.
    - `'#/apps/x/bogus'` → area `'build'`.
    - `'#/apps/%E0%A4%A'` → apps.
    - `'#/whatever'` → apps.
  - `state.test.ts`:
    - `applyState dedupes messages already shown`: a view with ids [1, 2] plus a state with [2, 3] → ids [1, 2, 3].
    - `out-of-order messages are sorted`: a `build.message` with id 3, then id 2 → [2, 3].
    - `other apps are ignored`: the same reference is returned.
    - `an older task update is ignored, and a newer task id replaces it`.
    - `build.task sets running`.
    - `keeps the newest 1000 messages`.
    - `lastMessageId`: empty → 0.
    - `summarizeTask table`:
      - review/success/not running → `{ label: 'Ready to merge', tone: 'ok', canMerge: true, mergeHint: null }`.
      - review/pending → `canMerge false` with hint `'Merge unlocks when CI is green.'`.
      - review/success/running → hint `'Wait for Claude to finish.'`.
      - queued → label `'Queued (usage limit)'`, tone `'warn'`.
      - merged → tone `'done'`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/shell src/areas`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 13 pass.
- [ ] **Step 5: Commit** `apps/client/src/shell/route.* apps/client/src/areas/build/state.*` as `feat(client): hash routes and Build view state`, with the attribution trailer your harness provides.

---

### Task 24: Move the canvas harness, proxy to the hub, app-shell service worker

**Files:**
- Create: `apps/client/harness.html`, `apps/client/src/harness.tsx`
- Modify: `apps/client/vite.config.ts`, `apps/client/public/sw.js`, `apps/client/e2e/canvas.spec.ts`, `apps/client/e2e/perf.spec.ts`

**Interfaces:**
- Consumes: plan 2 Tasks 8, 10, 22–24 (current `main.tsx`, `index.html`, `vite.config.ts`, e2e specs).
- Produces:
  - `/harness.html` serves plan 2's canvas dev harness: `?tiles=`, `?debug=1`, `window.__hubCanvas`, and the selection bar.
  - `/` is left for the shell (Task 27).
  - The dev and preview servers proxy `/api` and `/ws` to `http://127.0.0.1:8787`.

Changes:
- `harness.html` is a copy of `index.html` with `<title>Hub canvas harness</title>` and `<script type="module" src="/src/harness.tsx">`.
- `src/harness.tsx` is plan 2's current `main.tsx` content (the `App` with `StaticTileSource`, `createIdbCache()` and the selection bar) without the service worker registration. Leave `main.tsx` unchanged in this task.
- `vite.config.ts`:
  - Add `build.rollupOptions.input = { main: fileURLToPath(new URL('./index.html', import.meta.url)), harness: fileURLToPath(new URL('./harness.html', import.meta.url)) }`.
  - Add `const hubProxy = { '/api': { target: 'http://127.0.0.1:8787' }, '/ws': { target: 'http://127.0.0.1:8787', ws: true } }`, used as both `server.proxy` and `preview.proxy`.
  - Keep the plugins.
- In `e2e/canvas.spec.ts` and `e2e/perf.spec.ts`, replace every `page.goto('/?debug=1')` with `page.goto('/harness.html?debug=1')`.
- `public/sw.js` (exact; caches the app shell for the tablet, never `/api`, `/ws` or tiles):

```js
const CACHE = 'hub-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.add('/'))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' && url.pathname === '/') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});
```

- [ ] **Step 1: Make the changes above.**
- [ ] **Step 2: Verify.**
  - `pnpm -F @hub/client typecheck && pnpm -F @hub/client test` is clean.
  - `pnpm -F @hub/client build` lists `dist/harness.html`, and `pnpm -F @hub/client size` stays under 150000.
  - `pnpm -F @hub/client test:e2e e2e/canvas.spec.ts e2e/perf.spec.ts` passes 6 tests.
- [ ] **Step 3: Commit** `apps/client/harness.html apps/client/src/harness.tsx apps/client/vite.config.ts apps/client/public/sw.js apps/client/e2e` as `chore(client): move canvas harness to /harness.html, proxy /api and /ws, cache the app shell`, with the attribution trailer your harness provides.

---

### Task 25: Build area UI

**Files:**
- Create: `apps/client/src/areas/build/BuildArea.tsx`, `apps/client/src/areas/build/TaskCard.tsx`, `apps/client/src/areas/build/build.css`

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `ApiError`, `WsClient`), Task 23 (`BuildView`, `EMPTY_VIEW`, `applyState`, `applyServerMsg`, `lastMessageId`, `summarizeTask`).
- Produces:

```tsx
export function BuildArea(props: { app: string; api: ApiClient; ws: WsClient }): JSX.Element;
export function TaskCard(props: { task: BuildTask; running: boolean; onMerge: () => Promise<void>; onClose: () => Promise<void> }): JSX.Element;
```

`BuildArea`:
- **Loading and live updates:**
  - Mount: `api.buildState(app)` → `applyState`. Subscribe with `ws.on(m => setView(v => applyServerMsg(v, app, m)))`.
  - Catch-up: `ws.onStatus(s => s === 'open' && refetch(lastMessageId(viewRef.current)))` refetches with `after` and applies the result. Keep a `viewRef`.
  - Unsubscribe both on unmount.
- **Layout:** a full-height flex column with the TaskCard at the top, then the message list, then the composer.
- **Message list** (`data-testid="build-messages"`, scrollable):
  - One element per message with `data-testid={`msg-${kind}`}`.
  - `user` messages are right-aligned bubbles. `assistant` messages are left bubbles with `white-space: pre-wrap`. `tool` messages are small, gray and monospace. `status` messages are small and italic. `error` messages are red.
  - Auto-scroll to the bottom on new messages when the list was within 80 px of the bottom.
- **Composer:**
  - `<textarea data-testid="build-input" placeholder="Ask Claude to change this app…">` and `<button data-testid="build-send">Send</button>`.
  - Send is disabled while the trimmed text is empty, `view.running` is true, or a send is pending. Ctrl/Cmd+Enter sends.
  - On success, clear the input. An `ApiError` message shows in `data-testid="build-error"`.
  - `<button data-testid="build-stop">Stop</button>` is visible only while running and calls `api.stopBuild(app)`.
- **TaskCard** is rendered when `view.task` is set. `onMerge` and `onClose` call `api.merge`/`api.closeTask` and apply the returned task.

`TaskCard` (`data-testid="task-card"`) shows:
- the title, and the branch in monospace;
- `data-testid="task-status"` with `summarizeTask(...).label`, colored by `tone`;
- when `prUrl` is set, `<a data-testid="pr-link" href={prUrl} target="_blank" rel="noreferrer">PR #{prNumber}</a>`;
- `data-testid="ci-state"` with the raw `task.ci` text;
- `task.error` in `data-testid="task-error"`;
- `<button data-testid="merge" disabled={!canMerge}>Merge</button>`, showing `Merging…` while pending, with `mergeHint` below it and errors in `data-testid="merge-error"`;
- `<button data-testid="close-task">Close task</button>`, only when the task is open (not merged or closed) and not running.

- [ ] **Step 1: Implement** the three files. Browser behavior is tested in Task 28.
- [ ] **Step 2: Verify:** `pnpm -F @hub/client typecheck && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
- [ ] **Step 3: Commit** `apps/client/src/areas/build` as `feat(client): Build chat with streaming, PR and CI status, Merge`, with the attribution trailer your harness provides.

---

### Task 26: App list and per-app view with area tabs

**Files:**
- Create: `apps/client/src/shell/AppList.tsx`, `apps/client/src/shell/AppView.tsx`
- Modify: `apps/client/src/canvas/CanvasView.tsx` (the root style `position:fixed` becomes `position:absolute`, so the canvas fills its container. The harness looks the same because `#app` fills the viewport.)

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `WsClient`, `ServerTileSource`), Task 23 (`Area`, `AREAS`, `AREA_LABEL`, `formatRoute`, `STATUS_LABEL`), Task 25 (`BuildArea`), Task 24; plan 2 `CanvasView`, `createIdbCache`.
- Produces:

```tsx
export function AppList(props: { api: ApiClient; ws: WsClient }): JSX.Element;
export function AppView(props: { app: string; area: Area; api: ApiClient; ws: WsClient }): JSX.Element;
```

`AppList`:
- Loads `api.apps()` on mount and again on every `build.task` WebSocket message.
- Renders `<ul data-testid="app-list">`. Each item is `<a data-testid={`app-${name}`} href={formatRoute({ name: 'app', app: name, area: 'build' })}>` and shows:
  - the name;
  - a badge `Adopted` or `Not adopted`, with `title={manifestError ?? ''}`;
  - `running ? 'Claude is working' : buildStatus ? STATUS_LABEL[buildStatus] : ''`.
- With no apps it renders `<p data-testid="no-apps">No apps yet. Clone a repo into HUB_APPS_DIR on the hub server.</p>`.
- Load errors show in `data-testid="apps-error"`.

`AppView`:
- Header: `<a href="#/" data-testid="back">All apps</a>` and the app name.
- `<nav role="tablist">` with one `<a role="tab" data-testid={`tab-${a}`} aria-selected={a === area} href={formatRoute({ name: 'app', app, area: a })}>{AREA_LABEL[a]}</a>` per area.
- A body container with `position:relative; flex:1; overflow:hidden`:
  - `design` → `<CanvasView key={app} source={useMemo(() => new ServerTileSource(app, ws), [app])} cache={useMemo(() => createIdbCache(`hub-tiles-${app}`), [app])} />`. The cache is per app, so plan 2's `cache.gc` on one app never evicts another app's tiles.
  - `build` → `<BuildArea key={app} app={app} api={api} ws={ws} />`.
  - `deploy` → `<p data-testid="deploy-placeholder">Deploy is not set up yet.</p>`. Plan 4 replaces it.

- [ ] **Step 1: Implement** both files and the one-line `CanvasView` change.
- [ ] **Step 2: Verify.**
  - `pnpm -F @hub/client typecheck && pnpm -F @hub/client test && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
  - `pnpm -F @hub/client test:e2e e2e/canvas.spec.ts` still passes 5 tests.
- [ ] **Step 3: Commit** `apps/client/src/shell/AppList.tsx apps/client/src/shell/AppView.tsx apps/client/src/canvas/CanvasView.tsx` as `feat(client): app list and per-app Design/Build/Deploy tabs`, with the attribution trailer your harness provides.

---

### Task 27: Shell root, login, entry point

**Files:**
- Create: `apps/client/src/shell/App.tsx`, `apps/client/src/shell/Login.tsx`, `apps/client/src/shell/shell.css`
- Modify: `apps/client/src/main.tsx`

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `ApiError`, `WsClient`, `wsUrl`), Task 23 (`parseHash`, `Route`), Task 26 (`AppList`, `AppView`), Task 24 (service worker).
- Produces:

```tsx
export function App(): JSX.Element;
export function Login(props: { api: ApiClient; onDone: () => void }): JSX.Element;
```

`App`:
- `auth` state is `'checking' | 'in' | 'out' | 'offline'`.
- `api = useMemo(() => new ApiClient({ onUnauthorized: () => setAuth('out') }))` and `ws = useMemo(() => new WsClient({ url: wsUrl(location) }))`.
- On mount, `api.session()` sets `in` or `out`, and a rejection sets `offline`.
- When `auth === 'in'`, call `ws.connect()`; leaving `in` calls `ws.close()`.
- `route` comes from `parseHash(location.hash)` and updates on `hashchange`. On `visibilitychange` to visible, call `ws.kick()`.
- Render:
  - `checking` → `<p data-testid="loading">Loading…</p>`.
  - `offline` → `<div data-testid="offline">Can't reach the Hub. Check that Tailscale is connected.<button>Retry</button></div>`; Retry re-runs the session check.
  - `out` → `<Login api onDone={() => setAuth('in')} />`.
  - `in` → a header with the title `Hub` and `<button data-testid="logout">Log out</button>` (calls `api.logout()`, then sets `out`), then `<AppList>` or `<AppView>` by route.

`Login`:
- `<form data-testid="login">` holds `<input data-testid="passphrase" type="password" autocomplete="current-password" autofocus>` and `<button data-testid="login-submit">Unlock</button>`.
- Errors show in `data-testid="login-error"`: 401 → `'Wrong passphrase.'`, 429 → the server message, anything else → `'Could not reach the Hub.'`.

`main.tsx`:
1. `import './shell/shell.css'`.
2. `render(<App />, document.getElementById('app')!)`.
3. Keep `if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');`.

`shell.css`: tablet-first layout. The shell is a full-height flex column; content areas scroll internally (`overflow:auto`); touch targets are at least 44 px; system font.

- [ ] **Step 1: Implement** the files.
- [ ] **Step 2: Verify:** `pnpm -F @hub/client typecheck && pnpm -F @hub/client test && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
- [ ] **Step 3: Commit** `apps/client/src/shell apps/client/src/main.tsx` as `feat(client): shell with passphrase login, routing and reconnect on wake`, with the attribution trailer your harness provides.

---

### Task 28: Playwright smoke tests for the shell and Build area

**Files:**
- Modify: `apps/client/playwright.config.ts`
- Test: `apps/client/e2e/build.spec.ts`, `apps/client/e2e/pwa.spec.ts`

**Interfaces:**
- Consumes: Task 21 (`dev:fake`; passphrase `hub-dev-passphrase`; app `demo`; FakeGitHub turns CI green on the second poll; polls every 1 s), Task 24 (preview proxy), Tasks 25–27 (test ids).
- Produces: `webServer` becomes an array that keeps plan 2's preview entry unchanged and adds this one:

```ts
{ command: 'pnpm -F @hub/server dev:fake', url: 'http://127.0.0.1:8787/api/health', timeout: 120_000, reuseExistingServer: !process.env.CI }
```

- [ ] **Step 1: Write the tests.** Helper `login(page)`: `goto('/')`, fill `passphrase` with `'hub-dev-passphrase'`, then click `login-submit`.
  - `build.spec.ts`:
    - `wrong passphrase shows an error, the right one opens the app list`: the wrong passphrase → `login-error` has text `'Wrong passphrase.'`. Then `login(page)` → `app-demo` is visible.
    - `a Build prompt streams, opens a PR, and merges after CI`:
      1. Log in and click `app-demo`. `tab-build` has `aria-selected="true"`.
      2. Fill `build-input` with `'Add a notes file'` and click `build-send`.
      3. `msg-user` contains that text, and `build-messages` contains `'Done.'` (timeout 30 s).
      4. `pr-link` contains `'PR #'`, and `ci-state` has text `'success'` (timeout 30 s).
      5. `merge` is enabled. Click it, and `task-status` has text `'Merged'`.
    - `design tab shows the app's canvas`: click `tab-design` → `getByTestId('canvas')` is visible, and `canvas-error` has count 0.
    - `deploy tab shows the placeholder`.
    - `log out returns to the login screen`.
  - `pwa.spec.ts`, `the app shell loads offline after one visit`:
    1. `goto('/')`, `await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))`, then `page.reload()` so the page is controlled.
    2. `context.setOffline(true)`, then `page.reload()` → `getByTestId('offline')` is visible.
    3. `context.setOffline(false)`.
- [ ] **Step 2: Run** `pnpm -F @hub/client test:e2e e2e/build.spec.ts e2e/pwa.spec.ts`. Expected: 6 pass. If one fails, fix the code it exposes, not the assertion.
- [ ] **Step 3: Run everything:** `pnpm typecheck && pnpm test && pnpm -F @hub/client build && pnpm -F @hub/client size && pnpm -F @hub/client test:e2e`. Expected: all green, including plan 2's canvas and perf specs. CI needs no workflow change, because Playwright starts both servers.
- [ ] **Step 4: Commit** `apps/client/playwright.config.ts apps/client/e2e/build.spec.ts apps/client/e2e/pwa.spec.ts` as `test(client): e2e for login, Build flow to merge, offline shell`, with the attribution trailer your harness provides.

---

### Task 29: Hub server bootstrap (Hetzner + Tailscale + Claude subscription + systemd)

**Files:**
- Create: `ops/hub/bootstrap.sh`, `ops/hub/hub.service`, `ops/hub/hub.env.example`, `ops/hub/set-secret.sh`, `ops/hub/check-claude.sh`, `docs/hub-bootstrap.md`
- Test: `apps/server/src/ops.test.ts`

**Interfaces:**
- Consumes: Task 3 (`loadConfig`, `CREDENTIAL_KEYS`), Task 5 (`hash-passphrase` script, `hashPassphrase`). The service starts `src/main.ts` (Task 21) at deploy time.
- Produces: the exact runbook below. Everything is idempotent and safe to re-run.

`ops/hub/hub.env.example` (exact; non-secret settings only):

```
# /etc/hub/hub.env (root, mode 600). Secrets are NOT here: store them with ops/hub/set-secret.sh.
# Never add ANTHROPIC_API_KEY anywhere: the Hub uses your Claude subscription.
HUB_BIND=127.0.0.1
HUB_PORT=8787
HUB_DATA_DIR=/var/lib/hub/data
HUB_APPS_DIR=/var/lib/hub/apps
GITHUB_OWNER=
```

`ops/hub/hub.service` (exact):

```ini
[Unit]
Description=Hub server
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service

[Service]
Type=simple
User=hub
Group=hub
WorkingDirectory=/opt/hub/apps/server
EnvironmentFile=/etc/hub/hub.env
Environment=NODE_ENV=production
Environment=PATH=/var/lib/hub/.local/bin:/usr/local/bin:/usr/bin:/bin
LoadCredentialEncrypted=HUB_PASSPHRASE_HASH
LoadCredentialEncrypted=GITHUB_TOKEN
LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
ExecStart=/opt/hub/apps/server/node_modules/.bin/tsx /opt/hub/apps/server/src/main.ts
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

`ops/hub/set-secret.sh` (exact):

```bash
#!/usr/bin/env bash
# Usage: sudo ops/hub/set-secret.sh NAME   (value from stdin, or typed silently)
set -euo pipefail
name="${1:-}"
case "$name" in HUB_PASSPHRASE_HASH|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN) ;; *) echo "Unknown secret $name" >&2; exit 1 ;; esac
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
install -d -m 700 /etc/credstore.encrypted
if [ -t 0 ]; then read -rs -p "$name: " value; echo; else IFS= read -r value; fi
[ -n "$value" ] || { echo "Empty value" >&2; exit 1; }
printf '%s' "$value" | systemd-creds encrypt --name="$name" - "/etc/credstore.encrypted/$name"
echo "Stored $name encrypted. Apply with: sudo systemctl restart hub"
```

`ops/hub/check-claude.sh` (exact; run through `systemd-run` with the service's user and credential):

```bash
#!/usr/bin/env bash
set -euo pipefail
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/CLAUDE_CODE_OAUTH_TOKEN")"
cd /var/lib/hub
exec /var/lib/hub/.local/bin/claude -p 'Reply with the single word OK.'
```

`ops/hub/bootstrap.sh` (exact):

```bash
#!/usr/bin/env bash
# Fresh Hetzner Ubuntu 24.04, as root:  TS_AUTHKEY=tskey-auth-… GITHUB_TOKEN=github_pat_… bash bootstrap.sh
set -euo pipefail
HUB_REPO_URL="${HUB_REPO_URL:-https://github.com/marcosCapistrano/designer.git}"
HUB_GIT_NAME="${HUB_GIT_NAME:-Hub}"
HUB_GIT_EMAIL="${HUB_GIT_EMAIL:-hub@localhost}"
PNPM_VERSION="10.28.0"
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
if grep -qs '^ANTHROPIC_API_KEY=' /etc/environment; then echo "Remove ANTHROPIC_API_KEY from /etc/environment first" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential python3 ufw

if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g "pnpm@${PNPM_VERSION}"

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
tailscale status >/dev/null 2>&1 || tailscale up --ssh --hostname=hub ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"}

ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
ufw allow OpenSSH            # removed in docs step 3 once Tailscale SSH works
ufw --force enable

id hub >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hub --shell /bin/bash hub
install -d -o hub -g hub -m 750 /var/lib/hub/data /var/lib/hub/apps
install -d -o hub -g hub -m 755 /opt/hub
install -d -o root -g root -m 700 /etc/hub /etc/credstore.encrypted
systemd-creds setup

AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
fi
if [ ! -d /opt/hub/.git ]; then sudo -u hub git "${AUTH[@]}" clone "$HUB_REPO_URL" /opt/hub
else sudo -u hub git "${AUTH[@]}" -C /opt/hub pull --ff-only; fi
sudo -u hub -H bash -c 'cd /opt/hub && pnpm install --frozen-lockfile && pnpm -F @hub/client build'
(cd /opt/hub && pnpm -F @hub/renderer exec playwright install-deps chromium)
sudo -u hub -H bash -c 'cd /opt/hub && pnpm -F @hub/renderer exec playwright install chromium'
[ -s /etc/hub/hub.env ] || install -o root -g root -m 600 /opt/hub/ops/hub/hub.env.example /etc/hub/hub.env
if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN" | /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN; fi

sudo -u hub -H bash -c 'test -x ~/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash'
sudo -u hub -H git config --global user.name "$HUB_GIT_NAME"
sudo -u hub -H git config --global user.email "$HUB_GIT_EMAIL"

install -o root -g root -m 644 /opt/hub/ops/hub/hub.service /etc/systemd/system/hub.service
systemctl daemon-reload
systemctl enable hub
tailscale serve --bg --https=443 http://127.0.0.1:8787

echo "Bootstrap done. Continue with docs/hub-bootstrap.md step 3."
```

`docs/hub-bootstrap.md` contains these numbered steps with these exact commands. The prose around them is up to the implementer.
1. **Create the server:**
   - Hetzner Cloud Console → Add server: Ubuntu 24.04, **CX32** (4 vCPU, 8 GB; 4 GB is the minimum), with your SSH key.
   - In the Tailscale admin console:
     - Enable **MagicDNS** and **HTTPS Certificates** (DNS page).
     - Create a one-off **auth key** (Settings → Keys).
   - Create a GitHub **fine-grained token** for your app repos with these permissions: Contents read/write, Pull requests read/write, Checks read, Commit statuses read, Metadata read.
2. **Run the bootstrap** from your laptop clone:
   - `scp ops/hub/bootstrap.sh root@<public-ip>:/root/`
   - `ssh root@<public-ip> 'TS_AUTHKEY=tskey-auth-… GITHUB_TOKEN=github_pat_… bash /root/bootstrap.sh'`
3. **Close public SSH**, after `ssh root@hub` over Tailscale works: `sudo ufw delete allow OpenSSH`. Also remove port 22 from any Hetzner Cloud Firewall.
4. **Log Claude Code in with your subscription** (never an API key): `sudo -u hub -H /var/lib/hub/.local/bin/claude setup-token`.
   - It prints a URL. Open it on your laptop or tablet, sign in with the Claude account that has the subscription, and paste the code back at `Paste code here if prompted`.
   - Copy the printed token, then run `sudo /opt/hub/ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN` and paste it.
   - The token lasts one year. Repeat this step to renew it.
5. **Set the passphrase** you will type on the tablet (≥ 12 characters):
   `read -rs -p 'Hub passphrase: ' P; echo; printf '%s' "$P" | sudo -u hub -H pnpm --silent --dir /opt/hub -F @hub/server hash-passphrase | sudo /opt/hub/ops/hub/set-secret.sh HUB_PASSPHRASE_HASH; unset P`
6. **Set the GitHub owner:** run `sudo nano /etc/hub/hub.env` and set `GITHUB_OWNER=<your GitHub user>`. If the bootstrap ran without `GITHUB_TOKEN`, also run `sudo /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN`.
7. **Check that Claude uses the subscription:** `sudo systemd-run --wait --pipe --quiet -p User=hub -p LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN /opt/hub/ops/hub/check-claude.sh` must print `OK`.
8. **Clone app repos** (one per app):
   `read -rs -p 'GitHub token: ' T; echo; sudo -u hub -H env T="$T" bash -c 'cd /var/lib/hub/apps && git -c http.https://github.com/.extraheader="AUTHORIZATION: basic $(printf "x-access-token:%s" "$T" | base64 -w0)" clone https://github.com/<owner>/<app>.git'; unset T`
9. **Start the hub:**
   - `sudo systemctl start hub && journalctl -u hub -n 20` shows `Hub listening on http://127.0.0.1:8787`.
   - `curl -s http://127.0.0.1:8787/api/health` prints `{"ok":true}`.
10. **On the tablet:**
    - Install Tailscale and join the tailnet.
    - Open `https://hub.<tailnet>.ts.net` in Chrome and unlock with the passphrase.
    - Menu → **Add to Home screen**.
11. **Update later:**
    `sudo -u hub -H bash -c 'cd /opt/hub && git pull --ff-only && pnpm install --frozen-lockfile && pnpm -F @hub/client build' && sudo systemctl restart hub`
12. **Known limits** (one short paragraph each):
    - Claude runs as the same Unix user as the hub. The deploy guard is a tool policy, not a sandbox.
    - Secrets are encrypted with the systemd host key (Hetzner CX servers have no TPM).

- [ ] **Step 1: Write the failing test** `apps/server/src/ops.test.ts` (`root = fileURLToPath(new URL('../../../', import.meta.url))`):
  - `scripts parse`: `execFileSync('bash', ['-n', f], { cwd: root })` succeeds for `ops/hub/bootstrap.sh`, `ops/hub/set-secret.sh` and `ops/hub/check-claude.sh`.
  - `nothing sets ANTHROPIC_API_KEY`: none of the six ops/docs files matches `/^\s*(export\s+)?ANTHROPIC_API_KEY=/m`.
  - `unit runs as hub with encrypted credentials and no API key`: `hub.service` contains each of these lines:
    - `User=hub`
    - `EnvironmentFile=/etc/hub/hub.env`
    - `LoadCredentialEncrypted=HUB_PASSPHRASE_HASH`
    - `LoadCredentialEncrypted=GITHUB_TOKEN`
    - `LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN`
    - `UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`
    - `ExecStart=/opt/hub/apps/server/node_modules/.bin/tsx /opt/hub/apps/server/src/main.ts`
    - `Restart=on-failure`
  - `env example holds only non-secret settings`: the keys matched by `/^([A-Z_]+)=/gm` toEqual `['HUB_BIND', 'HUB_PORT', 'HUB_DATA_DIR', 'HUB_APPS_DIR', 'GITHUB_OWNER']`, and none of them is in `CREDENTIAL_KEYS`.
  - `example env plus the passphrase credential loads`: `loadConfig({ ...parsedExample, HUB_PASSPHRASE_HASH: hashPassphrase('x'.repeat(12)) })` → `bind '127.0.0.1'`, `port 8787`.
  - `docs give the exact commands`: `docs/hub-bootstrap.md` contains `claude setup-token`, `set-secret.sh CLAUDE_CODE_OAUTH_TOKEN`, `check-claude.sh`, `tailscale serve --bg --https=443 http://127.0.0.1:8787` and `ufw delete allow OpenSSH`.
  - `set-secret only accepts known names`: `bash ops/hub/set-secret.sh BOGUS` exits 1 with stderr `Unknown secret BOGUS`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/ops.test.ts`. Expected: FAIL (files missing).
- [ ] **Step 3: Create** the six files. Mark the three scripts executable (`chmod +x`, committed with mode 755).
- [ ] **Step 4: Run** the same command. Expected: 7 pass. If `shellcheck` is installed, `shellcheck ops/hub/*.sh` is clean.
- [ ] **Step 5: Commit** `ops/hub docs/hub-bootstrap.md apps/server/src/ops.test.ts` as `docs(ops): hub server bootstrap with Tailscale, subscription login, encrypted credentials, systemd`, with the attribution trailer your harness provides.

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| §3 Hub API: Node + TS + Hono, SQLite for hub state | 3, 4, 20, 21 |
| §3 Claude Code via Agent SDK with subscription login; no API key (§1) | 9, 10, 29 (`setup-token`, `UnsetEnvironment`, `scrubEnv`) |
| §3 Git checkouts of every app, GitHub API | 7, 11, 12 |
| §3 Realtime: one WebSocket per tablet carrying streamed Claude output and render-ready events | 2, 8, 15, 22 (`render.ready` via `ServerTileSource`) |
| §3 Security: no public port, Tailscale only, Tailscale HTTPS cert | 3 (no wildcard bind), 29 (ufw, `tailscale serve`) |
| §3 Secrets stay on the hub, encrypted at rest, never sent to the client | 3 (credentials), 11 (header-only git auth), 20 (no secrets in responses), 29 (`systemd-creds`) |
| §3 Client: Preact PWA, < 150 KB gzipped | 24, 25, 26, 27 (size checks), 28 (offline shell) |
| Architecture: passphrase (scrypt) + httpOnly session cookie, both required with `HUB_BIND` | 3, 5, 6, 8 |
| Architecture: app registry with manifest zod schema in `@hub/protocol` | 1, 7 |
| §6 One chat per app, Claude Code session in the checkout, streamed, persisted, resumable | 13, 15, 18, 25 |
| §6 Branch only, never `main`; typecheck + tests, pushed branch, PR, CI | 9 (guard), 14, 16, 17, 18 |
| §6 Full permissions in the repo but cannot deploy | 9, 10 |
| §6 Merge only when CI is green (staging deploy hooks in via `onMerged`, plan 4) | 17, 20, 25 |
| §11 Usage limit is shown and the task is queued | 10, 15, 18 |
| Render manifests, tiles and hit maps served; server `TileSource` | 19, 22, 26 |
| §10 step 1: bootstrap, Tailscale, auth, PWA shell, app list, WebSocket | 21, 26, 27, 29 |
