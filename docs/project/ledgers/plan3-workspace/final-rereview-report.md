# Plan 3 final wave: scoped re-review (c758a36..c8ced59)

Reviewer: one scoped re-review, read-only on /home/claude/wt-p3. Experiments ran in a private detached worktree at c8ced59 in the reviewer's scratchpad, against the real `openRepo`, `checkToolUse` and the installed SDK. No package suite was run (the controller ran them all green).

Inputs: final-review-report.md (I1, I2, M1-M7, Ledger triage), progress.md Rulings 16-20, the lane A/B/C briefs and reports, and the fix diff (23 commits, 85 files, +5294/-483). The non-test source hunks were read in full. Test hunks were read where a verdict depended on them.

## Probes run

- **I1, the hub's real `push('build/x-1')`** with these Claude-written configs:

  | Config | origin `main` | What happened |
  |---|---|---|
  | `remote.origin.push = build/x-1:main` | unchanged | `build/x-1` created |
  | `remote.origin.push = +refs/heads/*:refs/heads/main` | unchanged | push fails: invalid refspec |
  | `remote.origin.mirror = true`, local `main` moved to Claude's commit | unchanged | push fails: "--mirror can't be combined with refspecs" |
  | `pushurl` or `pushInsteadOf` → another repo | unchanged | push goes to the other repo |
  | `branch.<b>.pushRemote` + `branch.<b>.merge = main` | unchanged | |
  | `push.recurseSubmodules = on-demand` or `check`, nested repo whose own `remote.origin.push` maps to `main` | unchanged | |
  | `push.followTags = true` | unchanged | Claude's annotated tag v9 **was** pushed (see residuals) |

- **Hooks.** `pre-push` and `reference-transaction` hooks in `.git/hooks` ran only for the test's own local git calls. They did not run during the hub's authed `fetch` or `push`.
- **M2.**
  - Push A. Claude amends to A2. Push with lease A succeeds, and origin = A2.
  - Then someone else pushes B on top. Claude amends again. Push with lease A2 is refused ("stale info"), and origin stays B.
  - A non-SHA lease throws before git runs.
- **Guard** (lane B):
  - These now get the push reason:
    - `git config` writes to `remote.*.push|pushurl|url` and `url.*.insteadOf|pushInsteadOf`, including `--global`, `--file=.git/config`, `set --append`, `-C sub`, `env …` and `sh -c '…'`
    - `git remote set-url`
    - `Monitor{command}`
    - `git annex sync`, `git-annex copy --to`
  - Reads stay allowed.
  - The Ruling 16 repros (I-1, R2, R3, R4, I-2/R5, R7) are all UNCLEAR.
  - Edit, Write and NotebookEdit to `.claude/settings*.json` and `.mcp.json` are denied at any depth. `.claude/commands/*` stays editable.
- **SDK.** The installed SDK (0.3.299) emits the warning as `process.emitWarning(msg, {code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"})`. That is the options form the filter matches.

## Finding Verdicts

- **I1: addressed.**
  - `git.ts:163` pushes the explicit `refs/heads/<b>:refs/heads/<b>`. Every probe above left origin `main` unchanged: refspec, wildcard, mirror, pushurl, insteadOf, pushRemote and submodule recursion.
  - `core.hooksPath=/dev/null` rides in `GIT_CONFIG_PARAMETERS` on fetch, push and ls-remote, and the hooks probe confirms it.
  - `assertBranchName` and `--` are added. `defaultBranch` now fails closed through `ls-remote --symref`.
  - Lane B also denies the porcelain config writes (defence in depth only; see Minor N3).
  - The docs gain step 9, branch protection.
  - Residual (not introduced here): the push still follows `push.followTags`, so Claude's tags reach origin. See Out-of-Scope.
- **I2: addressed.**
  - `service.ts:309-350`: `keepLeftovers` commits locally on the closed or merged task's `build/` branch, then branches as usual.
  - A dirty default branch, a non-`build/` branch, or a `build/` branch with no task still gets a 409. Each has a test (service.test "still refuses …").
  - The Stop → Close → send test checks four things:
    - task 2 is on a new branch
    - the old branch holds "Uncommitted work left by task #1"
    - origin has no old branch
    - origin `main` is unchanged
  - Nothing pushes the old branch later: closed and merged tasks are never continued, and `finish` pushes only `task.branch` with the pinned refspec.
  - A failed leftovers commit (for example a hook) is a 409 and starts no task.
- **M1: addressed.** The continue path runs a best-effort `fetch()` and logs one line on failure (`service.ts:299-305`). There is a test for the moved base and one for a failed fetch.
- **M2: addressed, with the documented deviation.**
  - The lease is the new `pushed_sha` column, written after each successful push (`finish.ts:173-186`), not `headSha`, which GitHub overwrites.
  - The probe confirms both an amend by Claude and a refusal of someone else's push.
  - A stale-info refusal gets a clear task error.
  - Migration 2 (`db.ts:20-22`) is a nullable `ADD COLUMN`. `migrate` now refuses a database version newer than the code.
- **M3: addressed (Ruling 19).** When a PR exists, the close copy says it stays open on GitHub (`service.ts:118-123`). No new GitHub write path.
- **M4: addressed.**
  - `listSuitesForRef` is read. An open suite with runs holds the state at pending, and an unread page fails closed (`octokit.ts:107-125`, `github.ts:65-91`).
  - Suites with zero runs are ignored by design, to survive stale app suites.
- **M5: addressed.** No `style=` remains in `shell/`. `shell.css` has the classes, plus `:hover` (hover-capable pointers only) and `:focus-visible`.
- **M6: partially addressed.**
  - `ReadOnlyPaths=/opt/hub` (`hub.service:28`) stops in-unit writes to the code.
  - The update step that the new docs prescribe still runs as the hub user with the hub's `HOME`, which Claude can write. See N1.
- **M7: addressed.** `probe-t11/` is gone from the worktree root.
- **Ledger ride-along rows:**
  - **T1, T2: addressed.**
    - Manifest export and stripping tests.
    - The `satisfies Record<ServerMsg['type'], true>` set.
    - `Number.isFinite(t)`.
    - A tag-only doc comment.
  - **T3: addressed.**
    - `isWildcardBind` covers `0`, `0.0`, `0x0`, `::`, `::0`, `[::]`, zones and the IPv4-mapped form.
    - `readCredential` catches ENOENT only; other errors are a ConfigError that names the key.
    - Config tests added.
  - **T4: addressed.** Downgrade refusal, the 2-statement rollback test, and asserts on `foreign_keys` and `busy_timeout`.
  - **T5: addressed.**
    - A power-of-two N no lower than current, and r/p minimums.
    - A non-empty salt and a full-length key.
    - The `reset()` doc.
    - CLI CRLF and 11/12 tests.
  - **T6, T8: addressed** (tests).
  - **T11: addressed.**
    - The test helper's `git()` pipes its output and sets `GIT_CONFIG_GLOBAL=/dev/null`.
    - Catches are narrowed (`remoteUrl`, `defaultBranch`, `currentBranch` via `symbolic-ref`).
    - `--untracked-files=normal`, `--` before names, and a quote round-trip test.
  - **T12, T13: addressed.** The `total_count` guard, the repo-aware fake, limit tests, and `notFound`.
  - **T14: addressed.** The group gets SIGKILL on settle when timed out or aborted (`commands.ts:153`). Grep and Glob patterns are cut. The test gaps are filled.
  - **T15: addressed** (tests).
  - **T16: addressed.**
    - `defaultBranch` fails closed.
    - A Stop wins over the branch message.
    - The `currentBranch` heads/ fix covers the misleading "switched to" case.
    - `error: null` is set on the no_changes and "No new changes" short-circuits.
    - The docstring is fixed, and the seed noise is piped away.
  - **T17 (parked rows), T18: addressed.**
    - `refreshCi` re-reads the task after its await.
    - A Merge read or merge call that fails is a 502 "Could not reach GitHub.".
    - Octokit has a 30 s `AbortSignal.timeout` combined with the caller's signal.
    - The 1.5 s wall-clock races are removed, and there is a test that a rejected flight clears its entry.
  - **T19, T20, T21: addressed.**
    - `TILE_RE` is bounded to 5 digits.
    - A cut-off upload gets 400 and is not logged.
    - `mayServe` allows only ENOENT/ENOTDIR and refuses anything else.
    - csrf-before-bodyLimit, HEAD and traversal tests.
    - `errorText` never throws.
    - Ticks are drained (10 s cap) before `stopAll`/`db.close`.
    - The IPv6 URL is bracketed.
    - A failure after listen tears the listener down.
  - **T9 / Ruling 16 carries: addressed** (probed). The corpora are unchanged, per lane B.
  - **T10: addressed.**
    - Command-bearing tools are guarded.
    - `guardHook` fails closed.
    - Settings and MCP files are blocked.
    - Env, queryFn and matcher tests.
    - A pre-aborted run skips Claude Code.
    - The warning filter is in place. Its process-wide patch is judged acceptable: it is installed once, matches by exact code only, and passes every other call through with its original arguments.
    - The optional WireMessage narrowing stays parked.
    - The disableAllHooks probe was documented.
  - **T22, T23: addressed.**
    - Listeners are isolated, and bookkeeping runs before any listener is notified.
    - The reconnect timer is single and checks `running`.
    - A throwing makeSocket or send counts as a drop.
    - A non-JSON 200 becomes an ApiError.
    - A tile-source 401 calls `onUnauthorized`.
    - Interpretation and route tests, and a duplicate build.message returns `v`.
  - **T24: addressed.**
    - `r.ok` is checked before every `put`, and writes are inside `waitUntil`.
    - The install fails on a non-OK shell.
    - The build stamps a hashed cache name, and activate prunes only `hub-shell-*` caches.
    - The shell's `/assets/` are precached best effort.
  - **T25: addressed.**
    - `applyState` takes `running` only from a current snapshot.
    - BuildSync's `synced` cursor, single flight, and refetch after a failure.
    - `applyTask` follows the task's status.
    - Load and action errors are split.
    - Scroll re-pin, `prLink` https-only, Merge/Close mutual disable, and `errorText` moved to `net/`.
  - **T26, T27, T28: addressed.**
    - A loading note in the app list.
    - `withAuth` clears the logout error on 'out'.
    - `SessionCheck` liveness.
    - A 10 s session timeout.
    - The unreachable reset guard and its comment are gone.
    - The e2e awaits the manifest body.
  - **T29: addressed.**
    - No "safe to re-run" claim.
    - `stty`-based prompts.
    - Secrets arrive on stdin, are never exported, and are unset.
    - The header no longer shows the history form.
    - The update `git pull` uses `GIT_CONFIG_*`.
    - set-secret prints the empty-stdin message.
    - The check-claude export is split.
    - The argv test is broadened (`apps/client/dev/ops.test.ts`).
    - shellcheck is clean at warning level.
  - **Rows marked "stay parked" or "resolved": not re-reviewed.**

## New Issues in the fix diff

### Critical

None.

### Important

None.

### Minor

- **N1: the docs overstate M6, and the update step loads hub-HOME config that Claude can write.** (`docs/hub-bootstrap.md:91`, step 12 at `:74-88`, `ops/hub/hub.service:26-28`)
  - What the new Known-limits text says: "a Claude run cannot edit the hub's own code."
  - Why that is too strong:
    - Claude runs as the hub user, and HOME is `/var/lib/hub`, which Claude can write.
    - The guard allows `git config --global core.hooksPath …` (probed) and shell writes to `~/.npmrc`.
    - Step 12 runs `git pull` and `pnpm install` as `sudo -u hub -H`, outside the read-only unit, with the GitHub header in git's environment.
    - So a Claude-planted post-merge hook or npm `node-options` would run there and could rewrite `/opt/hub` before the restart.
  - This is the same-uid class that plan 4 P4-24 closes.
  - Fix now: either soften the sentence, or harden step 12. Hardening means running with `GIT_CONFIG_GLOBAL=/dev/null`, `git -c core.hooksPath=/dev/null pull` and `NPM_CONFIG_USERCONFIG=/dev/null`.
- **N2: future scrypt changes would lock the user out.** (`apps/server/src/auth/passphrase.ts:45-46`)
  - `verifyPassphrase` now refuses stored params below the current `SCRYPT_PARAMS`.
  - If a later plan raises N, r or p, the existing stored hash stops verifying, with no message.
  - Fix: keep a separate fixed floor constant, or leave a comment at `SCRYPT_PARAMS` that raising it requires re-running step 5.
- **N3: lane B's push-config rule is defence in depth, not a closure.** (`apps/server/src/claude/guard.ts:247`, `gitConfigReason`)
  - These routes are still allowed:
    - `git remote add x <url>`, then `git config rename-section remote.x remote.origin`
    - `git config include.path <file>`
    - `remote.origin.mirror` (which makes the hub's push fail)
    - `remote.origin.fetch` (which can point `origin/<base>` at Claude's commit)
  - None of them moves origin `main`, because the pinned refspec holds (probed).
  - The lane B report's wording ("closes the config path") overstates it. No code change is needed for plan 3.
- **N4 (nit): the lease can go stale after a crash.** (`finish.ts:173-186`)
  - `pushed_sha` is written after the push returns. A crash between the two leaves a stale lease, and the next push is refused with "someone else changed it".
  - The same refusal appears after GitHub's "Update branch" button. In both cases the result is safe.
- **N5 (nit): the service-worker stamp breaks under `vite build --watch`.** (`apps/client/vite.config.ts:31-35`)
  - `stampServiceWorker` throws when the placeholder is already gone. That happens on a `vite build --watch` rebuild if public/ is not re-copied.
  - Dev-only. Production builds are a single pass.

## Out-of-Scope Observations

- **Tags reach origin.** The hub's push still honours a Claude-written `push.followTags` (probed: tag v9 reached origin). It cannot move `main`. If a repo runs tag-triggered workflows, a tag could start one.
  - One-flag hardening: `--no-follow-tags`, and optionally `-c push.recurseSubmodules=no`, in `git.ts` push.
- **Shell redirects are still parked.** A shell redirect into `.git/config`, `.claude/settings.json` or `.mcp.json` remains the parked Ruling 14 class (plan 4 OS boundary).
- **The hub's local git calls still run Claude-writable hooks.** These are commit, checkout and status, including the new leftovers commit. They have no token in their environment, so this is the pre-existing same-uid class.
- **Migration 2 numbering.** It takes migration slot 2, so plan 4's migrations must be renumbered (accepted in Ruling 20's amendment).

## Verdict

**Ready for PR: with residuals** (Minor only).

- All 8 named findings are addressed or partially addressed: I1, I2, M1-M5 and M7 addressed, M6 partially addressed. Every ride-along row is addressed.
- New issues: Critical 0, Important 0, Minor 5 (N1-N3, plus nits N4 and N5).
- N1 is the only one worth a one-line docs or step-12 change before the PR.
