# Plan 3 (hub server): final whole-branch review

Range: 23f2b92 (origin/main) .. c758a36 (feat/hub-server), 103 commits, 113 files, +19 338 / -45.
Reviewer: final Opus review, read-only on /home/claude/wt-p3.

## How this was reviewed

- I read the 860 KB diff package in three passes:
  1. The commit list and file stat (the package header).
  2. Every non-test source file in the stat, read at c758a36. Almost all of them are new files, so the file at HEAD is the diff's `+` side. The modified files were read as hunks: client e2e specs, CanvasView, main.tsx, vite and playwright config, sw.js, protocol ws.ts and package.json.
  3. The tests, skimmed where a finding needed them.
- Not read line by line: guard.ts and shell-lexer.ts. Their residuals are adjudicated (Ruling 16), so I read their rule entry points and probed them as black boxes.
- Probes (run in my scratchpad against the worktree's source, which was not modified):
  - the hub's own `GitRepo.push` against a Claude-written `remote.origin.push`
  - BuildService Stop → Close → send with a dirty checkout
  - the guard on git config, Monitor, merge/rebase/fetch and the Ruling 16 repros
  - guard timing on 80-200 KB commands (≤ 107 ms)
  - Node's bind of `HUB_BIND=0`
- Suites at c758a36:
  - `pnpm -r typecheck` is clean.
  - `pnpm -r test`: protocol 15, design-model 811, renderer 94, server 981 + 1 skipped, client 235, all passing.
  - `CI=1 pnpm -F @hub/client test:e2e` (ports free, load average 0.2): 16 passed, and the 2 perf pan phases failed (30 fps against a 50 fps floor, under the 4× throttle). Only perf failed, so I treat it as environmental. The ledger's control run of plan 2's config fails the same way here. GitHub CI on the PR decides.
- Client bundle: 23 143 B gzip of JS, with no zod in it.
- `git status` of the worktree is unchanged by the review. Only the pre-existing untracked `probe-t11/` shows.

## Strengths

- **Clean seams.**
  - `BuildDeps`, `ClaudeRunner`, `GitHub` and `RunCommand` are injected everywhere.
  - Tests use real git against bare repos, `FakeClaudeRunner` and `FakeGitHub`, and no test touches the network.
  - The extension points plans 4–6 need exist as named: `MIGRATIONS`, `SERVER_MSG_TYPES`, `onMerged`, `SECRET_ENV_KEYS`, `mcpServers`/`allowedTools` and `renderDir`.
- **Secret handling is careful and tested.**
  - The git token travels only in `GIT_CONFIG_PARAMETERS`, with an argv test.
  - `scrubEnv` covers every child process: Claude, git and build commands.
  - systemd encrypted credentials, with `UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`. The bootstrap refuses an `/etc/environment` that sets an API key.
  - Error logs carry the message only, JSON-escaped and cut to 500 characters.
  - The ops scripts never put the token on an argv.
  - Nothing sets or passes `ANTHROPIC_API_KEY`.
- **It fails closed where it matters.**
  - `summarizeChecks` treats unknown conclusions and unread runs as pending.
  - Merge re-reads CI on the PR's current head and pins that SHA.
  - finish's branch allowlist (build/ only, not the base, not the default) is re-checked before every commit and push, and a Stop before push wins.
  - The guard is one quote-aware lexer with a work budget, a nesting limit and fail-closed throws.
- **Runtime robustness.**
  - Crash handlers log one line and exit, and systemd restarts the hub.
  - WebSocket upgrades check the path, Origin, auth and a 64 KiB maxPayload, and have error listeners.
  - Sockets are re-checked on every heartbeat and on logout.
  - HTTP has a body limit, csrf, refusal of dotfiles and symlink escapes, and no secrets in error output.
  - CI refreshes are single-flight, so a slow GitHub read for one app no longer blocks another app.
  - Restart recovery and the usage-limit queue are tested.
- **Client.**
  - Reconnect catch-up dedupes messages by id.
  - Logout takes effect only when the server confirms it.
  - Session expiry on the socket sends the user back to login.
  - A regression spec for the early draft goes RED when its fix is reverted.
  - The offline shell is tested in the e2e specs.
- **Process.** Every Important finding from the per-task reviews was closed with a RED → GREEN test, and the key guards were confirmed by mutation testing.

## Issues

### Critical

None.

### Important

**I1. The hub's own push obeys a Claude-written push refspec, so it can update the default branch.**

- Where:
  - `apps/server/src/git/git.ts:119-121`: `push(branch)` runs `git push --set-upstream origin <branch>`.
  - `apps/server/src/build/finish.ts:66-84`, `:159-165`: the allowlist checks only the local branch name.
- **What.** A refspec with no `:dst` follows `remote.origin.push` from `.git/config`, and Claude can write that file.
  - The guard allows `git config remote.origin.push 'refs/heads/build/x:refs/heads/main'` (probed: the reason is `null`).
  - After that one command, `blockedReason()` passes, because the local branch is `build/x-1`.
  - The hub's authed push then sets origin's `main` to Claude's commit, and no `build/x-1` branch is created.
  - Probe with the real `openRepo(...).push('build/x-1')`: `origin main moved: true`, `origin has build/x-1: false`.
  - PR creation then fails, but main has already been changed.
- **Why it matters.** This breaks the hard constraint "the hub never commits to or pushes the default branch; PRs only". It does so through the hub's own credentialed action, which Ruling 11's allowlist was written to stop. The trigger is one ordinary-looking `git config` command, which a prompt injection in repo content could also ask for.
  - Same-uid credential reads stay a known plan 4 residual. This is the hub-side path, and it is a one-line fix.
- **How to fix.**
  - Push an explicit refspec: `['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]`. Plan 4 T42 already uses `<sha>:refs/heads/<branch>`.
  - Add a RED test in `git.test.ts`:
    - Set `remote.origin.push` to map the build branch onto `refs/heads/main`.
    - After `push`, origin's `main` SHA is unchanged and origin's `build/...` equals HEAD.
  - Optional, same wave:
    - Add `-c core.hooksPath=/dev/null` to the two authed calls (fetch, push), so a Claude-written `pre-push` hook does not run with `GIT_CONFIG_PARAMETERS` in its environment.
    - Add one line to docs/hub-bootstrap.md: protect each app's default branch on GitHub (require a PR) until plan 4 ships.

**I2. After Stop then "Close task", every new Build message is refused, and the tablet has no way out.**

- Where:
  - `apps/server/src/build/service.ts:299-302`: prepare refuses a new task on a dirty checkout.
  - `:114-123`: close does not touch the working tree.
- **What.** Probe:
  1. Claude writes a file and the user taps Stop. The task is `failed` with "Stopped by you.".
  2. The user taps "Close task". The task is `closed`, and `git status` shows `?? half-done.ts`.
  3. `send('Something else')` → 409 "The checkout has uncommitted changes on build/add-a-half-done-feature-1. Commit or discard them first."
  4. Every later send gets the same 409.
  - The Build UI has no commit or discard action, so the only fix is SSH to the server.
  - A second path to the same state: verify commands leave untracked files that are not in `.gitignore` (Next.js rewriting `next-env.d.ts`, test reports, and so on). The task is then merged, and the next new task is refused.
- **Why it matters.** The spec's Build area is meant to be driven from the tablet. Stop then Close is the obvious way to abandon work, and the close copy itself promises "The next message starts a new branch." The 409 copy follows the plan exactly (Task 18), but the plan did not consider this flow, and the result for the user is a dead end.
- **How to fix** (small; the controller decides, since it goes beyond the plan text).
  - When the dirty checkout is on a `build/` branch whose task is not open (closed or merged), commit the leftovers locally on that branch and do not push them. Use a message such as "Uncommitted work left by task #N". `git stash push -u` would also work.
  - Then create the new branch as usual.
  - Keep the 409 for a dirty default or non-`build/` branch, since that is a person's own work on the server.
  - Test: stop mid-edit → close → send creates task 2 on a new branch. The old branch holds the WIP commit, nothing is pushed, and origin is unchanged.

### Minor

**M1. A continued task never refreshes `origin/<base>`, and Claude cannot fetch.** (`service.ts:293-297`)
- Only a new task runs `fetch()`. Claude's environment has no token, so `git fetch` fails on a private repo.
- If the base moves while a PR is open, Claude cannot merge or rebase onto the real base. `commitsAhead` in finish also reads a stale ref.
- Fix: also `fetch()` (best effort) in prepare when a task is continued.

**M2. No `--force-with-lease` for the hub-owned work branch.** (`git.ts:119-121`, `finish.ts:164`)
- If Claude amends or rebases after the first push (a natural answer to "squash" or "rebase on main"), every later push fails as non-fast-forward. The task fails, and the error is not handed back to Claude.
- Fix: push with `--force-with-lease=refs/heads/<b>:<task.headSha>` when the task has a recorded head. It is the hub's own `build/` branch, so this is safe.

**M3. "Close task" leaves the PR open on GitHub, untracked.** (`service.ts:114-123`)
- After a close, the poller ignores the task. A later merge on GitHub fires no `onMerged`, which matters once plan 4 adds the staging deploy.
- Fix: close the PR through the API on close, or extend the copy to say the pull request stays open on GitHub.

**M4. CI can read `success` before every check run exists.** (`github/github.ts:176-186`, `github/octokit.ts:84-95`)
- GitHub creates a job's check run only when the job is queued. With the template's typecheck/test → build-image chain (`needs:`), there is a seconds-wide window in which only the finished jobs are listed and all of them are green.
- In that window the hub announces "CI passed. Ready to merge." and would merge.
- Fix: also read `checks.listSuitesForRef` and treat any suite that is not completed as pending. Branch protection with required checks is the backstop.

**M5. Inline style strings in the app list and app view.** (`apps/client/src/shell/AppList.tsx:132-144`, `apps/client/src/shell/AppView.tsx:252-265`)
- The rest of the client uses plain CSS (`shell.css`, `build.css`). This is not Tailwind, but it breaks the plain-CSS convention, and inline styles cannot express `:focus-visible`, `:hover` or media queries.
- Fix: move the styles into `shell.css` classes.

**M6. The hub user can rewrite `/opt/hub`.** (`ops/hub/hub.service:75-95`, `ops/hub/bootstrap.sh:33`)
- `/opt/hub` belongs to the hub user, and Claude runs as that user. A Claude run can therefore edit the guard or the branch allowlist, and the next restart loads the edited code.
- Fix: `ReadOnlyPaths=/opt/hub` in the unit costs one line, and nothing writes there at runtime. Otherwise this stays with plan 4 (separate user, P4-24).

**M7. Housekeeping: untracked `probe-t11/` sits in the worktree root.** It is not in the branch. Delete it before anyone runs `git add -A`.

## Ledger triage

- Must-fix before merge: none of the ledger items on its own. I1 and I2 above are the must-fixes.
- Everything marked "ride-along" belongs in the one final fix wave.
- "Stay parked" means the item stays parked, normally to plan 4, with the reason given.

| Source | Item | Verdict |
|---|---|---|
| T1 | index test that no manifest export leaks; tests for unknown-key stripping and domain '' rejection | ride-along (tests) |
| T2 | `SERVER_MSG_TYPES` exhaustiveness (`satisfies Record<ServerMsg['type'], true>`) | ride-along; plans 4 and 6 add variants |
| T2 | `parseClientMsg` `Number.isFinite(t)` (`1e999` parses to Infinity, harmless) | ride-along (one line) |
| T2 | `parseServerMsg` is tag-only | ride-along as a doc comment; stay parked as a design choice |
| T3 | `readCredential` single read with ENOENT catch; other fs errors → ConfigError | ride-along |
| T3 | more config tests (blank env, empty file, port bounds, scrubEnv over all keys and non-mutation) | ride-along |
| T3 | more wildcard spellings | ride-along, **priority**: probed, `HUB_BIND=0` binds 0.0.0.0 in Node and config accepts it; `::0` binds all on an IPv6 host. ufw is the only backstop. |
| T4 | rollback test with a 2-statement migration; assert `foreign_keys=1` and `busy_timeout` | ride-along |
| T4 | `user_version > MIGRATIONS.length` should fail loudly | ride-along (protects a downgrade during plan 4 rollouts) |
| T5 (priority) | `verifyPassphrase` fails closed on weak stored params; reject empty salt; doc and test that `reset()` keeps the lock; CLI tests for CRLF and the 11/12 boundary | ride-along |
| T6 | test that a blocked attempt never calls verify | ride-along |
| T7 (parked) | stat errors swallowed; errorCode optional chaining; dir is lexical, not realpath | stay parked (plan 4 T8: no links followed in checkouts) |
| T8 | capture uncaughtException in the invalid-UTF-8 and 64 KiB tests; raw-socket byte check for the throwing-isAuthed 401; close() heartbeat test | ride-along (tests) |
| T8 | Origin allow-list | resolved in T21 (`sameOrigin` in attach.ts) |
| T9 / Ruling 16 | I-1/R1 (per-word `hidden` flag at guard.ts:154 and :688), R2, R3, R4, I-2/R5 (stdin `--rcfile`/`--init-file` → UNCLEAR), R7, R8 (git-annex and similar push-shaped subcommands) | ride-along, one rule and one RED test each, as Ruling 16 says. Re-probed: I-1, I-2, R7 and `git annex sync` are still allowed; `git lfs push` is already denied. |
| T9 / Ruling 16 | I-3/R6, R9 scripts, R10 dataflow, R11 interpreters and unmodelled wrappers | stay parked (plan 4 OS boundary, Ruling 14) |
| T9 (earlier) | fake abort-after-last-step; nested .git paths editable; accepted false denies | stay parked (accepted) |
| T9 (round 3) | git/gh `--version` false denies | resolved (probed: both allowed) |
| T10 (priority) | `guardHook` fails open on throw → try/catch deny plus a test | ride-along. In practice it cannot throw today, since the Bash path is wrapped and the edit path is pure. |
| T10 | guard treats `Monitor{command}` like Bash | ride-along, **priority**: probed, `checkToolUse('Monitor', {command:'git push origin HEAD:main'})` is `null`, and `Bash(...)` deny rules do not cover it. Fix generally: any tool input with a string `command` goes through `deployDenyReason`. |
| T10 | block Edit/Write to `.claude/settings*.json` and `.mcp.json` | ride-along. These run outside the guard through `settingSources: ['project']`. Also probe once whether a project `disableAllHooks: true` disables the SDK callback hook. The SDK typings say it covers hooks "defined in settings files and by installed plugins", so it probably does not. |
| T10 | run-level idle or overall watchdog | stay parked (plan 4); Stop works and shutdown aborts |
| T10 | env test over every SECRET_ENV_KEYS entry, oauthToken null, queryFn args, no hook matcher | ride-along |
| T10 | narrow on SDK types instead of the `WireMessage` cast | ride-along (low value) or stay parked |
| T10 | filter the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` stderr warning | ride-along |
| T10 | skip queryFn on a pre-aborted signal | ride-along |
| T10 | scrubEnv denylist → allowlist (AWS_*, SSH_AUTH_SOCK, NPM_TOKEN, CLAUDE_CODE_USE_BEDROCK) | stay parked (plan 4 hub-agent environment) |
| T11 | `git()` stdio pipe plus `GIT_CONFIG_GLOBAL=/dev/null`; narrow catches; quote round-trip test; `--untracked-files=normal`; `--` before branch names | ride-along. There is no option-injection path today: names are hub-built or prefixed `origin/`. |
| T11 carry | default-branch push guard in Tasks 15-18 | resolved (Ruling 11 allowlist), but see I1 |
| T12 | `total_count` undefined guard; fake ignores the repo arg | ride-along |
| T12 carry | CI poll timeout | resolved (`CI_POLL_LIMIT` 120 per head) |
| T13 | limit tests with and without afterId; updateTask throws on unknown id; dedupe not-found message | ride-along |
| T14 | SIGKILL the group in finish when timed out or aborted (a daemonized grandchild survives today); tail test; spawn error, CI=1, timed-out fixPrompt, NotebookEdit and leading-punctuation slug tests; truncate Grep/Glob patterns | ride-along |
| T15 | the 8 test gaps | ride-along |
| T16 | `defaultBranch()` fails closed when origin/HEAD is unset (or uses `ls-remote --symref`) | ride-along |
| T16 | misleading "switched to branch" message for refs/heads/ forms; finish.ts docstring (the fix budget is shared across commands, not per command); rename test at :449 | ride-along |
| T16 (parked) | error not cleared on the no_changes / "No new changes" short-circuits (stale error under "No changes") | ride-along |
| T16 (parked) | makeTestRepo seed-push stderr noise (the "push negotiation failed" lines in the suite output) | ride-along |
| T17 | merged-once guards also require `mergeSha !== null`; poll-only path never fires onMerged for a null sha | stay parked (plan 4 deploy hook owner) |
| T17 (parked) | refreshCi writes ci on a just-merged task | ride-along with the T18 carry below (re-read after await) |
| T17 (parked) | two concurrent merges → the second gets 409 | stay parked (single user; client disables the button) |
| T17 (parked) | Task 20 keeps plain errors → 500 | ride-along: a GitHub read failure on Merge shows "Internal error"; map it to 502 "Could not reach GitHub." |
| T18 | check `signal.aborted` before blockedReason's result; `toBe(2)` at :1150; replace 1.5 s wall-clock races at :1112/:1145; test that a rejected flight clears its map entry | ride-along |
| T18 carry | refreshCi re-reads the task after its await | ride-along |
| T18 (parked) | Octokit request timeout. The sequential poll pass, and a send/state stuck behind a hung same-task read, are today bounded only by undici's ~300 s defaults; a stuck send keeps the app reserved and Stop cannot interrupt prepare. | ride-along: a 30 s `AbortSignal.timeout` in the Octokit fetch |
| T19 | ENAMETOOLONG → 404 (bound the digits in `TILE_RE`); move the secret.txt fixture | ride-along |
| T20 | aborted chunked upload logged as an unhandled error; `mayServe` fails open on other errnos; csrf-before-bodyLimit and HEAD-on-dotfile tests; raw-path traversal tests | ride-along |
| T20 carry | csrf Origin fallback behind `tailscale serve` (Origin is https, the URL is http; it relies on `Sec-Fetch-Site`) | stay parked (accepted, Task 28 notes); add a docs smoke step in plan 4 |
| T20 ruling | I2 CSRF layer | resolved (csrf middleware) |
| T21 | `oneLine` `String(err)` throws on a null-prototype object; heartbeat test timings ≥ 250 ms; purge-before-listen test; await in-flight ticks before `db.close()`; bracket the IPv6 bind in the url; outer catch after listen | ride-along |
| T22 | WsClient: reconnect/ping before notifying listeners, try/catch per listener (a throwing status listener today prevents `scheduleReconnect`), guard the reconnect timer; makeSocket throw → drop; close() during backoff test; api tests; hitMap URL test; `json()` SyntaxError → ApiError | ride-along |
| T22 | ServerTileSource 401 does not call onUnauthorized | ride-along (plan 6 also touches the Design area) |
| T23 | pin the interpretations with tests; route tests; applyServerMsg returns `v` for render.ready/pong and duplicate build.message; comment on `running` in applyState | ride-along |
| T24 | sw.js caches a 5xx `/` over the shell | ride-along, **priority**: `if (r.ok)` before `put`. A 502 from `tailscale serve` during a hub restart would become the offline shell. |
| T24 | cache name never pruned between deploys; no sw.js unit test | ride-along (the e2e covers offline) |
| T25 (priority) | stale `running` from overlapping snapshots: `applyState` takes `s.running` even when it keeps the newer task (state.ts:274-282), which disables Send until a remount | ride-along, **priority** |
| T25 | catch-up cursor skips history after a failed catch-up followed by a live message | ride-along, **priority**: a hole in Review Focus 2 |
| T25 | applyTask `running` on a replaced task; `setError(null)` wipes send/stop errors; re-pin scroll; prUrl https-only and prNumber null guard; Merge/Close mutual disable; move `errorText` to a shared module | ride-along |
| T26 | loading state; `errorText` to net/; ws-stable comment | ride-along |
| T26 | AppList reload on reconnect | resolved (T27 fix) |
| T26 | manifestError tooltip invisible on touch | stay parked (plan 6 polish) |
| T27 | clear logoutError when auth goes 'out'; live flag on the session-check callback | ride-along |
| T27 | server closes sockets on logout and expiry | resolved (T21 recheck on logout and heartbeat) |
| T27 (parked) | 'checking' has no timeout | ride-along (an `AbortSignal.timeout` on `session()`) |
| T27 (parked) | hash survives logout | stay parked (accepted) |
| T28 | BuildArea reset guard unreachable (keyed): keep or drop, and fix the "relies on stable api/ws" comment; build.spec design test should await the manifest body | ride-along |
| T28 | trailers name Sonnet 5.5 | stay parked (accepted) |
| T29 (priority) | docs say "every step is safe to re-run", which is false; step 2 `read -rs -p` breaks on a zsh laptop (macOS default: `-p` means coprocess, so the token silently becomes empty); don't export GITHUB_TOKEN/TS_AUTHKEY to the `curl \| bash` installers; bootstrap.sh:2 header shows the token-in-history form; step 11 `git pull` has no auth for a private repo; unreachable empty-stdin message; check-claude.sh `export` masks a `cat` failure; broaden the no-token-in-argv test; shellcheck SC2155/SC2086 | ride-along, in that priority order |
| Plan 2 perf | re-run perf on a quiet machine before the PR | done here at load 0.2: the two pan phases still miss (30 fps), and the 16 other e2e pass. Environmental; the PR's GitHub CI decides. |
| Plan 4 (P4-24, T41/T42) | same-uid credential reads, hub git in a Claude-writable checkout, ProtectSystem=strict | stay parked (plan 4). I1 is the one hub-side piece worth closing now. |

## Declined to judge

- Ruling 16 residuals, and Ruling 14's parked classes (scripts, interpreters, dataflow, credential reads, git config-driven exec): adjudicated, not re-litigated.
- Claude (same uid) reading `/run/credentials` and the hub's environment: a known plan 3 limit, stated in docs/hub-bootstrap.md §12; plan 4 P4-24 fixes it.
- Claude-written git hooks or fsmonitor seeing `GIT_CONFIG_PARAMETERS` during the hub's authed fetch/push: in plan 3 no worse than the same-uid read; plan 4 T42 tests pre-push and pushurl. I offered only an optional `core.hooksPath` line.
- Global login lockout (5 failures / 15 min, not per client): a single-user, tailnet-only design choice.
- Composer under the soft keyboard on the Tab S6 Lite: needs the real device (spec §10 step 8 polish).
- Usage-limit retry time shown in UTC: exact copy from the plan.
- Fix budget shared across commands (2 total): the plan text specifies it; only the docstring is wrong (ledger T16).
- One Claude session resumed across tasks and branches: spec §6 "one chat per app".
- Review tasks with settled CI polled every 30 s indefinitely (GitHub rate budget): fine for one user with a few apps.
- `harness.html` shipping in the production dist: Task 24 put it there on purpose; it is a dev page with no data.
- CI reads check runs only, not legacy commit statuses: the template CI is GitHub Actions.
- Second concurrent merge returning 409: a single user, and the client disables the button.
- Stream granularity (whole assistant messages, not token deltas): the spec says "streams" without a granularity.
- Perf e2e failures: environmental per the brief; GitHub CI decides.

## Assessment

**Ready to merge: With fixes.**

- The branch is well built and well tested: typecheck clean, 2 136 unit tests green, e2e green apart from the perf phases. The Review Focus items hold, and nothing is Critical.
- Fix I1 before the PR (pin the push refspec, with a RED test). It is one line, and it closes a path by which the hub itself pushes to the default branch.
- Fix I2 in the same final wave, together with the ride-along items above. I2 is a small recovery step that keeps Stop → Close from locking the tablet out of Build.
