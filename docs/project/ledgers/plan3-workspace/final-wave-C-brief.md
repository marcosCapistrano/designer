# Plan 3 final wave, lane C: client + ops + docs

Worktree: /home/claude/wt-p3-fc (branch p3-fc, off c758a36). Your files: apps/client/**, ops/**, docs/hub-bootstrap.md. Do not touch apps/server or packages (other lanes own them).

Source of truth: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-review-report.md (M5, M6 and the "Ledger triage" rows T22-T29). Each behavior change gets a test that fails before the fix (RED) and passes after; say in the report which ones you saw RED.

## Items
1. (priority) T24 sw.js: only cache responses with `r.ok` (a 502 during a hub restart must not become the offline shell); prune old cache names on activate.
2. (priority) T25 stale `running`: applyState must not take `s.running` when it keeps the newer task (state.ts:274-282). And the catch-up cursor hole: after a failed catch-up followed by a live message, history must still be fetched (cursor must not jump past unfetched history).
3. T25 rest: applyTask running on a replaced task; `setError(null)` must not wipe send/stop errors; re-pin scroll; prUrl https-only and prNumber null guard; Merge/Close mutually disabled while either runs; move `errorText` to a shared net/ module (T26 too).
4. T22 WsClient: reconnect/ping bookkeeping before notifying listeners; try/catch per listener (a throwing status listener must not prevent scheduleReconnect); guard the reconnect timer; makeSocket throw → treated as a drop; close() during backoff test; api tests; hitMap URL test; `json()` SyntaxError → ApiError; ServerTileSource 401 calls onUnauthorized.
5. T23 tests pinning the interpretations, route tests; applyServerMsg returns `v` unchanged for render.ready/pong and a duplicate build.message; comment on `running` in applyState.
6. T26 loading state in AppList; T27 clear logoutError whenever auth goes 'out', live flag on the session-check callback, `AbortSignal.timeout` on session() so 'checking' ends; T28 drop the unreachable BuildArea reset guard (BuildArea is keyed by app) and fix the "relies on stable api/ws" comment, build.spec design test awaits the manifest body before toHaveCount(0).
7. M5 move the inline style strings in shell/AppList.tsx:132-144 and shell/AppView.tsx:252-265 into shell.css classes (plain CSS; no Tailwind, no inline styles).
8. M6 ops/hub/hub.service: `ReadOnlyPaths=/opt/hub` (check nothing in the unit writes there at runtime; the update step runs outside the unit).
9. T29 docs/ops, in this order: remove "every step is safe to re-run" or make it true; step 2 must not use `read -rs -p` (zsh on macOS: -p is coprocess) — use a POSIX-safe prompt; do not export GITHUB_TOKEN/TS_AUTHKEY into `curl | bash` installers; bootstrap.sh:2 header must not show the token-in-history form; step 11 `git pull` needs auth for a private repo (document it without putting the token in argv); unreachable empty-stdin message; check-claude.sh `export` masks a cat failure; broaden the no-token-in-argv test; shellcheck SC2155/SC2086 clean.
10. docs/hub-bootstrap.md: add one step telling the user to protect each app's default branch on GitHub (require a pull request) until the deploy plan ships.

## Rules
- Run `pnpm -F @hub/client test`, `pnpm -r typecheck`, and `CI=1 pnpm -F @hub/client test:e2e` (ports 4173 and 8787 must be free first; another lane may be running server tests but not e2e). The two perf pan phases fail on this machine regardless (environmental; GitHub CI decides); every other e2e must pass.
- Client bundle must stay under the existing budget check.
- Small commits. Commit trailer: use the Co-Authored-By and Claude-Session lines your own harness gives you.
- Report file: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-wave-C-report.md (each item → done/skipped with reason, RED evidence, commit list, suite counts).
