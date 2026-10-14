# Plan 4 pre-flight scan

Plan: `plans/2026-10-14-deploy-newapp.md` (42 tasks, 12 waves). Checked against `feat/hub-server` in `/home/claude/wt-p3` at 289adcd (5b0a644 plus guard fix round 4) and the plan 3 ledger. The scan was read-only and touched no worktree. A guard probe was re-run on 289adcd: every credential command in Task 9 still gets `null` from plan 3's guard, and `curl api.hetzner.cloud` is still denied. So Task 9's expected reasons hold.

Counts: **15 mismatches** (M1–M15), **12 conflicts** (C1–C12), plus 9 minor defects (m1–m9) that are not counted.

## 1. Extension-point check

| Name | Real location | Plan 4 assumes | Real code | Verdict |
|---|---|---|---|---|
| `MIGRATIONS` | db.ts:8 | append one entry (T11) | `readonly string[]`; db.test compares `.length` | match |
| `ServerMsg` / `SERVER_MSG_TYPES` | protocol ws.ts:9-10 | 3 variants added; ws.test list updated (T2) | union plus const list; ws.test.ts:22 checks the exact list | match |
| `parseServerMsg` | protocol ws.ts:26 | T2 test passes a `deploy.update` **object** | `(data: string)`; tag-only check | **M1** T2 test passes `JSON.stringify(obj)` |
| `SERVER_MSG_TYPES` exhaustiveness | ledger :15 (final-wave minor) | plain list | final wave adds `satisfies Record<ServerMsg['type'], true>` | **M2** (conditional) T2 also adds its 3 keys to that record |
| `HubConfig` / `loadConfig` | config.ts:4 / :62 | T1 adds 11 **required** fields and edits only config.ts and config.test | literals at dev/fake-hub.ts:39-48 and server.test.ts:55 (`configFor`) stop typechecking | **M3** T1 also edits both literals (see C1) |
| `CREDENTIAL_KEYS` / `SECRET_ENV_KEYS` / `scrubEnv` | config.ts:20 / :23 / :99 | 3→6 keys; 9 keys + 3 | 3 keys; 9 keys; filter by list | match |
| `ClaudeRunner` / `buildQueryOptions` / `RunnerContext` / `SdkClaudeRunner` | runner.ts:17; sdk.ts:39 / :18 / :170 | ctx gains optional `runAs`; constructor gains `runAs` | `{env, oauthToken}`; constructor `{oauthToken?, env?, queryFn?}` | match (additive) |
| SDK `spawnClaudeCodeProcess` | sdk.d.ts:2464 / 9572 / 9624 | `(SpawnOptions) => SpawnedProcess` | as assumed (0.3.299) | match |
| `checkToolUse` / `deployDenyReason` | guard.ts:1036 / :1027 (moved in round 4) | file tools Read, Edit, Write, NotebookEdit, Grep, Glob | `EDIT_TOOLS` (:40) also holds **MultiEdit**; non-edit tools return null at :1044 | **M4** T9 adds MultiEdit and puts its check before :1044 |
| `GitHub` / `RepoRef` / `CiStatus` | github.ts:36 / :3 / :25 | T7 adds createRepo and getRepo | interface; additive | match |
| `FakeGitHub` | github/fake.ts:31 | merge sha is opaque | `merged-${n}` (not hex), so DeployService.onMerged ignores fake merges | match (intended; fake hub stages through the button) |
| `OctokitGitHub` + test helper | octokit.ts:48; octokit.test `recordingFetch` | T7 tests a 404-then-201 sequence | `(token, fetchFn?)`; the helper returns one canned response | **M5** T7 adds a sequenced fetch helper of its own |
| `BuildDeps.onMerged` | build/deps.ts:20; fired at ci.ts:86 and :199 | `{app, taskId, prNumber, sha}` on every merge | the poll path fires only when `mergeSha !== null` (ledger :90) | match |
| `BuildService.send` (seed failure) | service.ts:74 → `prepare()` :274-313 → `discard()` :247 | T8: "the task is **failed**" | discard sets status **closed** | **M6** T8 says closed through discard, error 409 `Git: …` |
| `BuildService.send` (step mapping) | service.ts:274-313 | T8 cites plan 3 step numbers | open-task check sits after `refreshOnce`; seed write goes after `createBranchFrom`, inside the try that discards | **M7** T8 names `prepare()` and the two insertion points |
| `GitRepo` / `openRepo` / `gitEnv` / `authConfig` | git.ts:13 / :62 / :29 / :45 | T42 `plainCheckouts.clone` uses `simpleGit({config: authConfig(token)})` | `config:` puts the token in **argv**; `authedEnv` (:55, `GIT_CONFIG_PARAMETERS`) is private | **M8** export `authedEnv` and clone with `.env(authedEnv(token))` (C3) |
| `makeTestRepo` / `TEST_IDENTITY` / `git` | test-repo.ts:34 / :7 / :15 | `{origin, work}` | as assumed | match |
| `AppRegistry` / `AppEntry` | apps/registry.ts:67 / :5 | `get(name)`; fields name, dir, adopted, manifest, manifestError | as assumed; built inside startHub | match |
| `AppManifestSchema` / `parseAppManifest` / `APP_NAME_RE` | protocol manifest.ts:9 / :32 / :4 (`./manifest` export) | imports from `@hub/protocol/manifest`; `{ok, manifest}` | as assumed; index.ts does not re-export manifest | match |
| `resolveBuildCommands` | build/commands.ts:73 | T26 `adoptManifest` sets npm → `npm ci` | without a lockfile npm resolves to `npm install` | **M9** reuse `detectPackageManager`'s rule (`npm ci` only with a lockfile) |
| `RunCommand` / `runCommand` / `OUTPUT_TAIL` / `COMMAND_TIMEOUT_MS` | commands.ts:25 / :101 / :21 / :22 | `createRunCommand(runAs)`; `runCommand = createRunCommand(null)` | detached group kill, SIGTERM then SIGKILL after 5 s | match |
| `createApp` / `AppDeps` | app.ts:100 / :19 | T38 mounts routes before the `/api/*` 404 | csrf :119, then bodyLimit :120, then auth, then build routes :141, then 404 :143 | **M10** csrf rejects form-type and bodyless POSTs, so T38 tests send `content-type: application/json` |
| `startHub` (construction) | server.ts:58 | T38 builds Deploy, Adopt, Move and NewApp and hooks `deploy.onMerged` | the registry is built inside; `onMerged` is fixed in the BuildService constructor (:81) | **M11** build BuildService first; `onMerged: (e) => deploy?.onMerged(e)` looked up at call time |
| `startHub` (close) | server.ts close(): server, then build.stopAll, then sockets, then db.close | T38 adds `deploy.stopAll()` | setup runs are not awaited; a write after db.close becomes an unhandled rejection, and main.ts:69-70 exits | **M12** close awaits `setup.idle()`; every background promise ends in `.catch` |
| `HubOptions` / `RunningHub` | server.ts:21 / :38 | `infra?`, `now`, `log` | `now?`, `heartbeatMs?`, `log?`, `retryPollMs?`, `onMerged?`, `runCommand?`, `openRepo?` | match (additive) |
| GitHub reads (CI wait) | ledger :106 (hung read stalls; no Octokit timeout) | T34 `waitAndRun` polls checkStatus and hasTag until it gets an answer | no fetch timeout in Octokit, HttpHetzner (T4) or GhcrRegistry (T6) | **M13** every outbound fetch gets `AbortSignal.timeout(30_000)` |
| `errorText` | build/TaskCard.tsx:19 | T27 imports `../build/TaskCard.js` | ledger :85 final wave: "move errorText to net/" | **M14** T27 imports from wherever plan 3's final wave leaves it |
| `ops/hub/*` + `ops.test.ts` | ops.test.ts:115 `git gets the GitHub header…` | T20 rewrites docs step 8 (hub-bootstrap.md:47-57) | the test needs `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` in both bootstrap.sh and the docs | **M15** T20 rewrites that test and lists it (C2) |
| `hub.service` / `hub.env.example` / `set-secret.sh` / `bootstrap.sh` | hub.service:16, 17, 23, 25; env.example:34; set-secret:5; bootstrap:32, 54, 61-62 | insert after :16 and :17; replace :34; rewrite :5 | lines as assumed; `NoNewPrivileges=true` and `ProtectSystem=full` | match |
| `dev/fake-hub.ts` | :39-48 config; DEMO_MANIFEST | T39 rewires infra; demo app has no Dockerfile | as assumed (the literal breaks in W1, see M3) | match |
| `ApiClient` / `WsClient` / `ApiError` | net/api.ts:49 (private json :106, request :111, appPath :46) / ws.ts:35 / api.ts:13 | T17 adds methods inside the class | as assumed | match |
| `route.ts` (`Route` / `parseHash` / `formatRoute`) | shell/route.ts:7 / :19 / :35 | T32 adds `{name:'new'}` | formatRoute handles only `apps` and `app`; route.test has 5 tests | match |
| `AppView.tsx` / `App.tsx` / `AppList.tsx` | AppView:66 `deploy-placeholder`; App:142; AppList:112 empty state | T40 replaces the placeholder; build.spec.ts:82 changes | as assumed | match |
| `parseDoc` (plan 1) | design-model files.ts:40 | returns `{ok, value}` | as assumed | match |

## 2. Task-pair table

| Producer → consumer | Shared file or interface | Agree |
|---|---|---|
| T1 → T5 | `scrubEnv` drops `SSH_AUTH_SOCK` and the deploy secrets | yes |
| T1 → T9 | credential names = `CREDENTIAL_MARKERS` | yes |
| T1 → T12, T13 | `yaml` dependency | yes |
| T1 → T15, T16, T39 | `DEFAULT_TEMPLATES_DIR`; design-model devDependency | yes |
| T1 → T20 | credential and setting names; set-secret `case`; env.example keys | yes |
| T1 → T22, T29, T36 | `provisionProblems` | yes |
| T1 → T34, T39 | `HubConfig`, `deployProblems` | yes (T39 test uses an undefined `baseConfig`, m6) |
| T1 → T39 (fake-hub.ts literal) | HubConfig literal | **no**: broken in W1, fixed in W11 (C1) |
| T2 → T10, 11, 17, 18, 19, 24, 25, 27, 35, 37 | DTOs and constants (`ConfirmAction`, `VOICE_ORIGIN`, `DeployRecord`, `SETUP_STEPS`, `HUB_ORIGIN_HEADER`, `shortSha`…) | yes |
| T2 → T18, T19 | new `ServerMsg` variants | yes |
| T3 → T15, T21, T36 | `readTemplate`, `renderTemplate`, `TEMPLATE_NAME`/`TEMPLATE_ID`, `imageFor` | yes |
| T4 → T22, T31, T39 | `Hetzner`, `FakeHetzner`, `HttpHetzner`, `FirewallRule` | yes; the fake numbering gives 203.0.113.5 in T29, T36 and T40 |
| T5 → T12, 13, 22, 23, 28, 31, 39 | `shq`, `SshRunner`, `FakeSsh`, `OpenSshRunner`, `readPublicKey` | yes |
| T6 → T34, T39 | `ImageRegistry`, `FakeRegistry`, `GhcrRegistry` | yes |
| T7 → T36 | `createRepo`, `getRepo`, `repoExistsMessage`, `FakeGitHub.repos` | yes |
| T8 → T29, T30 | `send(…, {seedFiles})`, `readCheckoutFile` | yes (state wording, M6) |
| T10 → T22, 24, 29, 30, 34, 35, 37 | `ConfirmStore`, `DeployError`, `isVoiceOrigin`, error constants | yes |
| T11 → T22, T25 | `servers` and `setup_runs` tables | yes |
| T11 → T24, T33, T34 | `DeployStore` (`slot`, records, logs) | yes |
| T12 → T22, 23, 29, 30, 33, 36 | `cloudInit`, `READY_FILE`, `SHARED_*`, `siteConfig`, `upstreamPort`, `stagingUrl`, `productionUrl` | yes |
| T13 → T21 | `VALID_COMPOSE` "byte for byte" in compose.test.ts, which exports nothing | **partial**: duplicated with no equality test (C7) |
| T13 → T23, T33, T34 | remote builders, `checkComposeContract`, `composeServices` | yes |
| T14 → T24, 33, 34, 39 | `AppGit`, `FakeAppGit`, `createAppGit` | yes; the `readDir` parameter agrees with T42 |
| T15, T16 → T21 | template workspace (root package, shared, web, api) | yes |
| T16 → T24 | `CONTRACT_MARKER`; `isContractSql` vs the template's `isContract` | **partial**: regex duplicated, only the marker tested (C8) |
| T17 → T27, T32 | new `ApiClient` methods | yes |
| T18 → T27 | `state.ts` reducers and selectors | yes |
| T19 → T32 | `stepRows`, `applySetupMsg`, `quoteSummary`, `nameProblem` | yes |
| T19 ↔ T36 | `NAME_HINT` vs `NEW_APP_NAME_HINT` (same string) | **partial**: duplicated, untested (C9) |
| T22 → T19 → T40 | `missing()` order → `quoteSummary` → e2e text | **no**: sorted keys put production first; e2e expects staging first (C5) |
| T22 → T29, 30, 31, 33, 34, 36, 38 | `ServerManager`, `ServerStore`, `dedicatedKey` | yes |
| T23 → T28, 31, 33, 36 | `StackOps`, `StackError`, `StackTarget` | yes |
| T13 + T23 + T28 + T33 | `ensureStackCmd` in `prepare`, `startDb`, `relocate` order | **no**: the new DB starts with a fresh password before the secrets move (C6) |
| T24 → T29, 30, 34 | `provisionCard`, `promoteCard`, `rollbackCard`, `provisionSubject` | yes |
| T25 → T29, 36, 38 | `SetupRunStore`, `bootstrapRepo` | yes |
| T26 → T29 | `adoptManifest`, `adoptPrompt` | yes (npm rule, M9) |
| T27 → T32, T40 | `ConfirmDialog`; DeployArea.tsx (T40 modifies T27's file in a later wave) | yes |
| T28 → T33 | `relocate`, `MoveHandle` | yes as an interface (C6 is the order) |
| T29 → T30 | `SetupDeps`, `publishRun`, `checkProvisionConfirm`, `SETUP_RUNNING_MESSAGE` | yes, but **same wave** (C4) |
| T29, T30, T36 → T37 | the three services | yes |
| T33 → T34 | `runPipeline`, `readDeployFiles` | yes |
| T34 → T35, 36, 38 | `DeployService` | yes |
| T35, T37 → T38 | the route factories | yes (csrf content-type, M10) |
| T38 → T39 | `InfraOptions` | yes |
| T39 → T40 | fake hub with infra | yes |
| T41 → T20 | `hub-agent` user; unit capabilities | yes; T20 credits T41 with the `Agent isolation OK` line, which T39 logs (m3) |
| T41 → T39, T42 | `RunAs`, `runAsAgent` (stdout Buffer), `createRunCommand`, `checkAgentIsolation`, `SdkClaudeRunner({runAs})` | yes |
| T42 → T20 | mirror layout in `add-app.sh` | yes |
| T42 → T29, 30, 36, 38, 39 | `MirroredCheckouts`, `plainCheckouts` | yes, but `plainCheckouts` puts the token in argv (C3) |

| Task | Internal consistency |
|---|---|
| T1 | ok |
| T2 | ok (M1 is against plan 3) |
| T3 | ok |
| T4 | **12 tests listed, Step 4 expects "11 pass"** (m1) |
| T5–T7 | ok |
| T8 | "failed" vs real closed (M6); otherwise ok |
| T9 | ok (M4) |
| T10–T19 | ok |
| T20 | **two tests both say "the five lines above"** (one means the caps block, the other the credential block) (m2); `Agent isolation OK` credited to T41 (m3) |
| T21 | Step 3 makes the lockfile, which needs the npm registry (outside the no-network rule, but it is a step, not a test) (m4) |
| T22–T26 | ok |
| T27 | **no tests at all** (C10) |
| T28–T30 | ok |
| T31 | "deletes everything it created", but the GHCR package `hub-live-app` stays (m5) |
| T32–T35 | ok |
| T36 | whether `created.length` counts the call that `failNext` rejected is not stated (m7) |
| T37, T38 | ok |
| T39 | test uses an undefined `baseConfig` (m6) |
| T40 | ok internally (C5 is cross-task) |
| T41 | ok: 18 tests (11 always run, 7 live and skipped without CAP_SETUID) |
| T42 | ok internally (C3) |

## 3. Wave check

| Consumer (wave) | Consumes (wave) | Problem | Fix |
|---|---|---|---|
| T30 (W5) | T29 (W5): `SetupDeps`, `publishRun`, `checkProvisionConfirm` | same wave | move T30 to W6 (beside T33; T37 in W9 still follows) |
| T1 (W1) | — | leaves `pnpm -F @hub/server typecheck` red from W1 until T39 (W11) fixes fake-hub.ts; server.test.ts is never fixed | C1 / M3 |

Every other Consumes line points to an earlier wave. No two tasks in one wave edit the same file. T1 and T41 (both W1) touch different files: T1's test calls `buildQueryOptions` without `runAs`, which stays valid.

## 4. Global-constraint conflicts and reviewer defects

| # | Finding | Where | Severity |
|---|---|---|---|
| C1 | T1 makes 11 HubConfig fields required. The literals in fake-hub.ts:39 and server.test.ts:55 fail typecheck, and T1 Step 5's own `typecheck` fails | T1 Files | blocks T1 |
| C2 | T20 removes `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` from the docs, which breaks plan 3's ops.test.ts:115. T20 does not list that test | T20 | blocks T20 |
| C3 | `plainCheckouts.clone` with `config: authConfig(token)` puts the token on git's argv (visible in `/proc/*/cmdline`), against Ruling 5 and the Global Constraint "token in the environment" | T42 | security |
| C4 | T30 consumes T29 in the same wave | waves | ordering |
| C5 | `missing()` sorts its keys, so the quote and the confirm card come out production first. The T40 e2e expects "shared-staging (…), shared-production (…)" | T22 / T19 / T40 | e2e fails |
| C6 | `runPipeline` calls `prepare` (`ensureStackCmd` makes a fresh `secrets.env`), then `startDb(d.sha)` (Postgres initializes with the **new** password), then `relocate` overwrites `secrets.env` with the **old** password. Migrate and the app then fail SCRAM auth. Every move of an app with a DB breaks. T33 test 13 cannot see this because it uses FakeSsh | T33 / T28 | data path broken |
| C7 | `VALID_COMPOSE` copied "byte for byte" into compose.test.ts (exports nothing) and the template's compose.yml, with no equality test. T33 and T34 also need it but cannot import it | T13 / T21 | verbatim duplication |
| C8 | `CONTRACT_MARKER` and `isContractSql` duplicate the template's `isContract` regex; only the marker string is tested | T24 / T16 | verbatim duplication |
| C9 | `NEW_APP_NAME_HINT` (T36) and `NAME_HINT` (T19) are the same literal with no shared source or test | T19 / T36 | verbatim duplication |
| C10 | T27 (ConfirmDialog, DeployArea) has no tests. The tap-only rule (`isTrusted`, Enter does not confirm, expiry) is untested anywhere, although it is the production-safety gate | T27 / T40 | untested safety rule |
| C11 | Global Constraint: "secrets reach app servers only on SSH stdin". But `TS_AUTHKEY` travels in cloud-init user_data, stays in `/root/hub-setup.sh`, and is served by 169.254.169.254 to every app container | T12 | constraint violated |
| C12 | New app writes the production Caddy site and creates the production DB on the shared production server with only the "Create app" tap. No confirm card appears unless servers must be created | T36 | production change without a confirm |

| # | Minor defect (not counted above) |
|---|---|
| m1 | T4 lists 12 tests but expects 11 to pass |
| m2 | T20's two "five lines above" tests are ambiguous |
| m3 | T20 credits `Agent isolation OK` to T41, but T39 logs it |
| m4 | T21 Step 3 needs the npm registry |
| m5 | T31 leaves the GHCR package `hub-live-app` behind |
| m6 | T39 test uses an undefined `baseConfig` |
| m7 | T36: should `created.length` count the call `failNext` rejected? |
| m8 | `add-app.sh` accepts a trailing dash, which `APP_NAME_RE` rejects |
| m9 | A server marked ready in `servers` but deleted on Hetzner is never re-checked. The docs omit the Tailscale ACL grant from the hub to `tag:hub-app` |

No vacuous tests found. String-contains checks are weak in T15, T20 and T21 (they assert that a line is present, not where it sits).

## 5. Security review of the hub-agent design (T41, T42, T20, T39, Residual risks)

Today's risk: the hub runs with ambient `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`, and a bounding set of the same three, so a compromised hub can switch to uid 0.
- uid 0 keeps only the bounded capabilities, but it **owns** root files, so DAC lets it in without `CAP_DAC_OVERRIDE`.
- `ProtectSystem=full` leaves `/var`, `/run` and `/root` writable. Escalation paths include `/var/spool/cron/crontabs/root`, `/root/.ssh/authorized_keys`, `/run/systemd/private` (uid-0 peer check, so `systemd-run` as full root works), `/run/dbus`, and `/var/lib/systemd/credential.secret` (decrypts the whole credstore).
- The hub's other children inherit `CAP_SETUID`. That includes `git index-pack` on bundles the agent made (T42) and ssh.

| Option | Hub capabilities | Root-equivalent if the hub is compromised | New root code | Can kill agent runs | Plan 4 cost | Verdict |
|---|---|---|---|---|---|---|
| A. Current (ambient caps + `setpriv`) | SETUID, SETGID, KILL | **yes** | none | yes (CAP_KILL) | 0 | reject |
| B. sudoers `hub ALL=(hub-agent) NOPASSWD:SETENV: /opt/hub/ops/hub/agent-exec` | none | no | sudo (setuid root) | no: sudo does not relay SIGKILL; group kill needs a second `sudo -u hub-agent kill` | T41 rewrite, T20 sudoers and unit | reject: must drop `NoNewPrivileges` (sudo is setuid), sudo becomes root attack surface, and every call adds journal noise |
| C. Root-owned helper (setuid binary or root daemon) | none | no, if bug-free | **yes** | via the helper | new root-reviewed code | reject: moves the root surface into new code |
| D. Keep A and add hardening (`ProtectSystem=strict`, `ReadWritePaths`, `ProtectHome`, `InaccessiblePaths=/run/systemd /run/dbus /var/lib/systemd`, `RestrictSUIDSGID`) | SETUID, SETGID, KILL | reduced, still uid 0 inside a denylist sandbox (abstract sockets and any missed root path stay reachable) | none | yes | +5 lines in T20 | add-on only |
| E. polkit plus `systemd-run --uid=hub-agent` | none | **yes**: polkit cannot restrict `User=` of a transient unit | none | yes | T41 rewrite | reject |
| **F. Socket-activated per-run exec unit** | **none** (`CapabilityBoundingSet=` empty) | **no** | none (systemd does the switch) | yes: closing the connection stops the instance; `KillMode=control-group` reaps strays | **about +1 task** (below) | **recommend** |

F in detail:
- **Socket unit.** `hub-agent-exec.socket` has `ListenStream=/run/hub-agent.sock`, `SocketUser=hub`, `SocketMode=0600` and `Accept=yes`. Each spawn opens one connection, which gets its own `hub-agent-exec@.service` instance.
- **Instance unit.** `User=hub-agent`, `Group=hub-agent`, `SupplementaryGroups=hub-apps`, `UMask=0007`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/hub-apps /var/lib/hub-agent`, `InaccessiblePaths=/var/lib/hub /etc/hub /etc/credstore.encrypted`, `ProtectHome=yes`, `PrivateTmp=yes`, `ProtectProc=invisible`, `IPAddressDeny=169.254.169.254`, `TasksMax=`, `MemoryMax=`, `RuntimeMaxSec=` (≥ the 15 min command timeout).
- **Exec script.** `ExecStart=/usr/bin/node /opt/hub/ops/hub/agent-exec.mjs` is dependency-free. It reads one JSON header `{command, args, cwd, env}` and runs the child on pipes. Frames are `stdin`, `stdin-end`, `stdout`, `stderr`, `exit{code,signal}` and `kill{signal}`.
- **Hub client.** `AgentClient` implements the SDK's `SpawnedProcess` over the connection, and `runAsAgent` keeps T41's `AgentResult` shape. The hub caps every frame it reads (1 MiB) because the peer is untrusted. A timeout or Stop closes the socket, and systemd kills the run's whole cgroup.
- **Hub unit.** Drop `AmbientCapabilities`, set `CapabilityBoundingSet=` empty, keep `NoNewPrivileges`. Add `ProtectSystem=strict`, `ReadWritePaths=/var/lib/hub /var/lib/hub-apps /var/lib/hub-mirrors`, `ProtectHome=yes`, `RestrictSUIDSGID=yes`, and `Requires=`/`After=hub-agent-exec.socket`. The hub's git and ssh children then hold no capabilities either.
- **Why it is safe.**
  - `hub-agent` cannot connect: the socket is hub-owned and 0600, and lives in `/run`, which only root can write.
  - A compromised run can only forge its own session's frames, and that output is already untrusted.
  - Yama (ptrace_scope=1) blocks `pidfd_getfd` from Claude's children on the parent exec process.
  - Tests need no root: they run `agent-exec.mjs`'s connection handler in-process on a temp socket, so the "live" block always runs.

What F costs plan 4:

| Task | Change |
|---|---|
| T41 | Split. **41a (W1):** frame protocol, `ops/hub/agent-exec.mjs`, `AgentClient` (`spawnAsAgent`, `runAsAgent`), in-process socket tests. **41b (W2):** sdk.ts and commands.ts hooks (`createRunCommand(agent)`), plus `checkAgentIsolation` through the socket. `resolveRunAs`, `agentArgv` and `canSwitchUsers` go; `capsOf` stays. |
| T20 | Hub unit lines change as above. Two new unit files. bootstrap enables the socket. ops.test gets +2 tests. Docs step 12 and Residual risks are rewritten. |
| T1 | Add `HUB_AGENT_SOCKET` (default `/run/hub-agent.sock`). The `deployProblems` text about the agent changes. Config tests change. |
| T39 | `main.ts` builds `AgentClient(config.agentSocket)` instead of `resolveRunAs`; the startup isolation check runs through it. |
| T42 | Parameter type `RunAs` → `AgentClient`; logic unchanged. It consumes 41a (W1), so it stays in W2. |
| Residual risks | Bullets 1–2 are replaced by "the hub holds no capabilities". |
| Net | +1 task. Waves unchanged. |

Interim, if F is deferred: apply D, and start the hub's own git and ssh through `setpriv --inh-caps=-all --ambient-caps=-all` (T5 and T42 argv). Do this regardless of F (fixes C11): cloud-init adds `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP` and deletes `/root/hub-setup.sh` after use.

## 6. Paid and outside-world actions

| Step | Effect | Gate in plan 4 | Executor |
|---|---|---|---|
| `ServerManager.ensure` → `createServer` (T22, used by T29, T30, T36) | **paid** cx23 server (the SSH key and firewall are free) | confirm token for `provision`, trusted tap only, voice refused | code only; tests use FakeHetzner |
| T31 live test plus `deploy-live.yml` | **paid** server (cents), GHCR push, then deletes its own server, key and firewall | manual `workflow_dispatch`; needs the repo secret `HUB_LIVE_HCLOUD_TOKEN`; skipped otherwise | must not run it; user only |
| T36 `createRepo` | new real GitHub repo | "Create app" tap only | code only; FakeGitHub |
| T25 / T36 `bootstrapRepo` push | push `main` to a real remote; starts Actions and a GHCR push | "Create app" tap only | code only; bare test remotes |
| T42 `MirroredCheckouts.push`; T29 / T30 Build branch and PR | push to a real remote, open PRs | Adopt or Move tap (plus a confirm if servers are missing) | code only; test remotes |
| T34 staging deploy | deploy to **staging** | `onMerged` after the Build merge tap, or the staging button; no confirm (per spec) | code only; FakeSsh |
| T34 production promote and rollback | **production deploy** | confirm token bound to the SHA; tap only; voice refused | code only |
| T33 auto-rollback | production change | runs inside an already-confirmed deploy | code only |
| T36 production Caddy site and production DB on the shared server | **production server change** | "Create app" tap only (C12) | code only |
| T28 / T33 relocation: `pg_restore --clean` on the target; `removeSite` and `down` on the old host | **destructive** on two servers | production: confirm card; staging: Build merge tap | code only |
| T31 `afterAll` | deletes the live test's own Hetzner resources | same manual run | user only |
| T20 ops scripts (`bootstrap.sh`, `make-ssh-key.sh --replace`, `add-app.sh`) | root changes on the hub host; `--replace` cuts off existing servers | manual `sudo` | must not run |
| T21 Step 5 (template install, build, docker) | npm registry and local docker | free | allowed if the network allows |

No implementation step needs the executor to create a paid resource, deploy, push to a real remote or delete anything. The only real-world run is T31's, and only the user starts it.

## Proposed rulings

1. T1 also updates the HubConfig literals in server.test.ts and fake-hub.ts (or exports `withDeployDefaults(base)`) — W1 typecheck is otherwise red until W11 — cost if wrong: every W1–W10 task's typecheck gate fails.
2. T2's `parses deploy and setup messages` passes `JSON.stringify(obj)` — `parseServerMsg` takes a string — cost if wrong: T2 does not compile.
3. T2 adds its 3 types to plan 3's exhaustiveness record if the final wave lands it — keeps the record total — cost if wrong: protocol typecheck fails.
4. T8: a seed failure closes the task through `discard()` with 409 `Git: …`; the checks sit in `prepare()` after `refreshOnce` and after `createBranchFrom` — that is how plan 3 actually works — cost if wrong: T8 tests assert a state that never occurs.
5. T9 also covers MultiEdit and places the credential path check before guard.ts:1044 — MultiEdit is an edit tool and today returns early — cost if wrong: a credential read through MultiEdit's path is allowed.
6. T42 `plainCheckouts.clone` uses `.env(authedEnv(token))` (export `authedEnv` from git.ts), never `config:` — Ruling 5, the token stays off argv — cost if wrong: the GitHub token shows in `/proc/*/cmdline` to `hub-agent`.
7. T7 writes its own sequenced fetch helper — octokit.test's helper returns one response — cost if wrong: the 404-then-create test cannot be written.
8. T20 rewrites ops.test.ts:115 to check add-app.sh's header handling and lists the file — it removes the docs lines that test needs — cost if wrong: plan 3's ops test fails in W2.
9. Move T30 to Wave 6 — it consumes T29 — cost if wrong: a parallel T30 builds against missing exports.
10. T22 `missing()` dedupes but keeps input order; `provisionSubject` keeps its own sort — the quote order is user-facing — cost if wrong: T40 e2e fails, or the confirm card lists servers in an odd order.
11. When moving, `runPipeline` skips its own `startDb` before `relocate`; T33 adds a test that the target `secrets.env` write happens before the first `up -d --wait db` on the new host — otherwise Postgres initializes with a new password — cost if wrong: every move of an app with a DB fails at migrate.
12. T13 exports `VALID_COMPOSE` from `deploy/fixtures.ts`; T21 asserts it is byte-equal to the template's compose.yml; T33 and T34 import it — removes the copy — cost if wrong: the copies drift and the contract test lies.
13. T24 tests `isContractSql` against the template's `isContract` on a shared corpus — removes the duplicated regex risk — cost if wrong: the promote card misses a contract migration.
14. The name hint lives once in `@hub/protocol` (`APP_NAME_HINT`) — removes the duplicate literal — cost if wrong: client and server texts drift.
15. T27 gains a jsdom test file and T40 an e2e step: an untrusted click, Enter, or a tap after expiry does not confirm — this is the production safety gate — cost if wrong: a scripted click could promote to production.
16. Cloud-init blocks 169.254.169.254 from Docker (`DOCKER-USER`) and deletes `/root/hub-setup.sh`; the Global Constraint names the TS key as the one user_data exception — closes C11 — cost if wrong: any app container can read the tailnet auth key.
17. New app's production Caddy site and DB are created at the first production promote (which is confirmed), not at Create — keeps "production changes need a confirm" — cost if wrong: one tap changes the shared production server.
18. T38's `close()` awaits setup runs; every background promise ends in `.catch(log)` — main.ts exits on unhandledRejection — cost if wrong: a Stop during a run crashes the hub.
19. T38: the onMerged hook is late-bound (`(e) => deploy?.onMerged(e)`), and BuildService is built before the setup services — the constructor fixes onMerged — cost if wrong: Build merges never stage.
20. T38's route tests send `content-type: application/json` on every POST — Hono csrf rejects the rest — cost if wrong: the tests get 403s.
21. Hetzner, GHCR and Octokit fetches use `AbortSignal.timeout(30_000)` — a hung read stalls `waitAndRun` and `stopAll` (ledger :106) — cost if wrong: one dead connection blocks an env forever.
22. `adoptManifest` uses `detectPackageManager`'s rule (`npm ci` only with a lockfile) — matches `resolveBuildCommands` — cost if wrong: adopted npm apps without a lockfile fail install.
23. T27 imports `errorText` from wherever plan 3's final wave leaves it (net/) — ledger :85 moves it — cost if wrong: T27 does not compile.
24. Replace ambient CAP_SETUID/SETGID/KILL with the socket-activated `hub-agent-exec` unit (option F), splitting T41 into 41a and 41b — the hub becomes capability-free and no longer root-equivalent — cost if wrong: about one extra task and a frame protocol to maintain; if skipped, a hub compromise is a host compromise.
25. Fix the minors m1–m9 inline when the task runs (counts, test names, `baseConfig`, add-app name regex, GHCR cleanup note, Tailscale ACL line) — cheap text fixes — cost if wrong: reviewer churn.
