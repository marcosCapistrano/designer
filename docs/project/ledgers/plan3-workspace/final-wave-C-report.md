# Plan 3 final wave, lane C: client + ops + docs

Worktree /home/claude/wt-p3-fc, branch p3-fc, off c758a36. Nothing pushed. Only apps/client/**, ops/** and docs/hub-bootstrap.md changed.

Status: DONE_WITH_CONCERNS (every item done; the concerns are listed at the end).

## Commits

| sha | subject |
|---|---|
| 854b8ec | fix(client): service worker caches only OK responses and prunes old builds |
| 7940655 | fix(client): a stale snapshot no longer sets running, pin Build state rules |
| e803614 | fix(client): Build sync keeps its cursor and running flag honest, errors move to net/ |
| 6264321 | fix(client): WsClient survives throwing listeners, api and tile-source error paths |
| a105093 | refactor(client): move the app list and app page styles from inline strings to shell.css |
| 4585568 | fix(client): shell auth rules, bounded session check, app list loading state |
| 04395b9 | fix(ops): mount /opt/hub read-only in the hub unit |
| e5094bb | fix(ops): bootstrap keeps secrets off argv and out of installers, docs tell the truth |
| 9600f8e | docs(ops): protect each app's default branch until the deploy plan ships |

## Suites (final, on 9600f8e)

- `pnpm -F @hub/client test`: 30 files, 353 tests, all pass (was 24 files, 235). This includes `dev/ops.test.ts` with shellcheck 0.11 on PATH; without shellcheck that one test skips.
- `pnpm -r typecheck`: clean.
- `pnpm -F @hub/client build && size`: 23 962 B gzip of JS (limit 150 000; it was 23 143 B). The stamped `sw.js` is counted.
- `CI=1 pnpm -F @hub/client test:e2e` (ports 4173 and 8787 free beforehand): 20 passed, 2 failed. The two failures are the perf pan phases (30 fps against the 50 fps floor, environmental as the brief says). Every other spec passes, including the 4 new ones (3 in `shell.spec.ts`, 1 in `pwa.spec.ts`).
- `apps/server/src/ops.test.ts` (read only, other lane's file) still passes 9/9 against the changed ops files.

## Items

### 1. T24 sw.js (priority): DONE, 854b8ec
- Navigation caches the shell only when `r.ok`. The `put` is now inside `e.waitUntil`, so the worker is not killed mid-write.
- Install fetches `/` with `cache: 'reload'` and fails if it is not OK, so a 502 at install time cannot become the shell.
- Pruning: the cache name was a constant (`hub-shell-v1`), so activate's existing delete loop never had anything to prune. `stampServiceWorker` in `vite.config.ts` now stamps a content-hash id (from the emitted file names) into `__BUILD_ID__` at `closeBundle`. Activate deletes only `hub-shell-*` caches other than its own, and install precaches the shell's own `/assets/` files (best effort), so replacing the cache never leaves a shell without its scripts.
- RED seen: `dev/sw.test.ts` (new, runs sw.js in a vm with a fake Cache API). Against the old sw.js, "a 5xx navigation is passed through but never replaces the cached shell" failed (`expected 'bad gateway' to be 'good shell'`), as did "install caches the shell and the assets it names" and "activate leaves caches that are not the hub shell alone". The stamping has an e2e check in `pwa.spec.ts` (served sw.js has no placeholder and a `hub-shell-<12 hex>` name).

### 2. T25 priority: DONE, 7940655 and e803614
- `applyState` takes `s.running` only when the snapshot's task is at least as new as the one shown (or both are null). It also takes an option for a caller that knows a newer source already set `running`. Comment on `running` added.
  - RED seen: "a snapshot older than the task on screen does not touch running" and "a snapshot with no task cannot set running over a task already on screen" failed against the old `applyState`.
- Fetch logic moved out of the component into `areas/build/sync.ts` (`BuildSync`), so it is testable in node (there is no DOM in the vitest setup).
  - Catch-up cursor is `synced`: the newest message a successful fetch returned, never the newest message on screen. A live message after a failed catch-up no longer becomes the cursor. A live message after a failed fetch also retries it.
  - One fetch at a time (a request during a fetch runs after it), and a snapshot sets `running` only if no live `build.task` or action reply arrived while it was in flight (updatedAt cannot tell: the run ending does not always change it).
  - RED seen: I first ported the old BuildArea logic faithfully into `sync.ts` and ran `sync.test.ts`: 9 of 20 failed ("does not move the cursor past history that was never fetched", "a live message after a failed catch-up fetches the missed history", "after a failed first load, a live message does not become the cursor", "a snapshot does not set running over a live build.task that arrived while it was in flight", the three applyTask running tests, the single-flight test, the no-stacked-retry test). All 20 pass with the fix.

### 3. T25 rest: DONE, 7940655 and e803614
- applyTask on a replaced task: `running` now follows the replied task's status (`isRunStatus`), not the stale view value. RED seen: "a new working task from send turns running on at once", "a merged or closed task turns running off" and "a snapshot issued before the reply does not undo its running flag".
- `setError(null)` no longer wipes send/stop errors: load errors (`BuildSync.loadError`) and action errors (`actionError` in BuildArea) are separate. A failed load gets a Retry button, and a Stop that returns `stopped: false` refreshes the state. BuildArea itself has no DOM test (see concerns); the split is structural and typechecked, and the Build e2e flow passes.
- Scroll re-pin: the layout effect also depends on `view.task` and the shown error.
- `prLink`: https only, "Pull request" when the number is null. RED seen: tests failed because `prLink` did not exist; the behavior is pinned by 4 tests (javascript:, http:, data:, unparsable URL, null number).
- Merge and Close both disable while either runs (TaskCard).
- `errorText` moved to `net/errors.ts` (+ test); AppList and TaskCard import it from there.

### 4. T22: DONE, 6264321
- WsClient: ping timer is created before the 'open' status is announced and the reconnect is scheduled before 'closed' is announced; each status and message listener runs in its own try/catch (errors go to `onListenerError`, `console.error` by default); the reconnect timer is single and checks `running`; a `makeSocket` that throws and a ping whose `send` throws are treated as a drop.
  - RED seen (6 of the 9 new ws tests failed against the old client): a throwing 'closed' listener (no reconnect), a throwing 'open' listener (no pings), a throwing message listener (starved the listener after it), makeSocket throwing (twice), ping send throwing. The test FakeSocket now dispatches events like a browser (a throwing handler is reported, never rethrown to the caller). Tests that were already green and now pin behavior: close() during the backoff, close() from a 'closed' listener, kick during a pending reconnect leaves one timer.
- ApiClient: a 200 that is not JSON becomes an `ApiError`; api tests added for logout, session (200, 5xx, timeout), non-JSON error body, network failure, `after=0`, stop/merge/close/send, and that the default fetch is not called with the client as `this`. RED seen: the non-JSON 200 test and the session timeout test (it hangs until the test timeout against the old code) failed.
- hitMap URL test and an encoded-app-name test added to tile-source tests.
- ServerTileSource: new options object `{ fetchFn, onUnauthorized }`; a 401 on a manifest, tile or hit map calls `onUnauthorized` (wired in AppView to `ApiClient.reportUnauthorized()`). RED seen: the 401 test failed (the signature change made the old call shape fail too).

### 5. T23: DONE, 7940655
- Tests pin: stale build.task ignored whole (running too), applyState never regresses the task, null snapshot task keeps the current one, render.ready and pong return `v`, a duplicate build.message returns `v` (RED seen: "returns the same view for a build.message already shown"), plus route tests for '', '#', '#/', empty app name, more than two segments, trailing slash, a slash in the app name and the apps route format.

### 6. T26, T27, T28: DONE, e803614 and 4585568
- AppList: "Loading apps…" (`apps-loading`) until the first answer. RED seen by mutation: with the note removed, the new e2e test fails.
- Logout error: the rule lives in `shell/auth.ts` (`withAuth`), unit-tested; going 'out' always clears it. RED seen by mutation (e2e "a failed logout error does not come back after the session ends and the user logs in again" fails when the clear is removed: the old error is still shown after logging in again).
- Live flag on the session check: `shell/session-check.ts` (`SessionCheck`): a newer run replaces an older one and `stop()` drops the answer; App uses it for the start-up/Retry check and for the check after a socket close (stopped in the effect cleanup). RED seen by mutation: removing the guard fails 3 of its 6 tests.
- `AbortSignal.timeout` on `session()` (10 s, configurable) so 'checking' ends: a timeout rejects and App shows the offline screen.
- BuildArea: the unreachable reset guard and the "relies on stable api/ws" comment are gone (the component is keyed by app; the effect creates one BuildSync). AppView got a comment saying `api` and `ws` are created once in App.
- `build.spec.ts` design test awaits the manifest body (`response.json()`) before asserting `canvas-error` has count 0.

### 7. M5: DONE, a105093
- AppList and AppView inline style strings are now `.app-list-*`, `.app-row`, `.app-view-*` classes in `shell.css` with the same values, plus hover (hover-capable pointers only) and a `:focus-visible` outline. e2e test checks both screens carry no `style` attribute and the selected tab keeps its accent colour (`.app-list-page` and `.app-view` must exist, so the test fails against the old markup).

### 8. M6: DONE, 04395b9
- `ReadOnlyPaths=/opt/hub` in hub.service. Checked by reading the server: it writes only under the data dir (db, mkdir) and the apps dir; tsx's cache goes to the unit's PrivateTmp; the update step (`sudo -u hub bash -c ...`) runs outside the unit. Not exercised on a real systemd host.

### 9. T29, in the order given: DONE, e5094bb
1. "Every step is safe to re-run" removed; the intro says what is true (step 2 may repeat but re-opens public SSH, so repeat step 3; step 8 fails if the directory exists).
2. Prompts use `printf ...; stty -echo; IFS= read -r X; stty echo` (steps 2, 5, 8, 12). Not run under zsh (none on this machine); the form uses no bash-only flag, and a test fails on any `read` with `-p` in a docs code block.
3. bootstrap.sh reads the GitHub token (line 1) and the Tailscale key (line 2) from stdin into plain unexported shell variables and unsets them after their last use; the docs no longer `export` them nor put the key in the ssh command. The one place a secret is on a command line is `tailscale up --authkey=` (documented, one-off key).
4. bootstrap.sh header no longer shows the token-in-history form.
5. Update step (now 12) authenticates `git pull` through `GIT_CONFIG_*` environment variables (same pattern as the clone), with `set -e`, and restarts only if the update succeeded.
6. set-secret.sh prints "Empty value" for empty stdin (the read is inside an `if !` so `set -e` no longer ends the script first). The statement shape that apps/server's ops.test.ts extracts and probes is unchanged, so that test still passes.
7. check-claude.sh assigns the credential and then exports it (SC2155); it also fails with a clear message outside systemd.
8. Broadened test: `apps/client/dev/ops.test.ts` runs the real bootstrap.sh, set-secret.sh and check-claude.sh in a sandbox against stub commands that record argv, environment and stdin. It asserts the token and its base64 are on no argv, the Tailscale key is on `tailscale up` only, no installer (`curl | bash`, run with an old node so the NodeSource installer runs) sees any secret, no command gets a secret in its environment (git gets the header by design), the token reaches set-secret on stdin, blank secrets work, and non-root is refused. Plus doc checks (no `read -p`, no export of a secret, the update step carries the header) and a shellcheck run at warning level.
   - RED seen: run against the old ops and docs files, 14 of 28 tests failed. Two mutations were also run: adding `export github_token ts_authkey` to the new bootstrap.sh fails the installer-environment test and the "does not export" test; the old check-claude.sh fails both check-claude tests.
- shellcheck: `shellcheck ops/hub/*.sh` was reporting SC2155 (check-claude.sh) at default severity; it is clean now at `--severity=warning`. The `${TS_AUTHKEY:+...}` expansion (SC2086 territory) became an array. I installed shellcheck 0.11 through a scratch pip venv to run it.

### 10. docs/hub-bootstrap.md branch protection: DONE, 9600f8e
- New step 9 "Protect each app's default branch" (Require a pull request before merging). Later steps move up by one; Known limits is now step 13 (the review report called it §12). A test checks the steps are numbered in order.

## Concerns for the controller

1. The broadened ops tests are in `apps/client/dev/ops.test.ts`, because the existing `apps/server/src/ops.test.ts` is in the server lane's tree. The old test is untouched and passes. If you want one home for them, move the file at merge (it only reads `ops/` and `docs/`, and needs no server code).
2. The bootstrap interface changed: `GITHUB_TOKEN` and `TS_AUTHKEY` in the environment are no longer read; the two secrets come on stdin (or are prompted for on a terminal). Anyone with a note of the old `TS_AUTHKEY=... GITHUB_TOKEN=... bash bootstrap.sh` form needs docs step 2.
3. `tailscale up --authkey=...` still puts the one-off key on that command's argv for a moment. I did not switch to `--auth-key=file:` because I could not check the Tailscale version support from here. The test pins this as the only allowed place.
4. The Build area and App wiring (Retry button, Stop refresh, action vs load error split, SessionCheck use) has no DOM unit test: the client test setup has no DOM. The logic they call is unit-tested (`BuildSync`, `SessionCheck`, `auth`), the logout-error and loading behaviors have e2e specs, and the Build flow e2e passes. There is no e2e for the Retry button or for the Stop-returns-false refresh.
5. The two perf pan phases still fail here (30 fps), as the brief expects.
6. Docs step numbering shifted (see item 10).
7. Nothing needed a server change, so nothing was skipped for that reason. Not touched and still parked per the ledger: the manifestError tooltip on touch, hash surviving logout.
