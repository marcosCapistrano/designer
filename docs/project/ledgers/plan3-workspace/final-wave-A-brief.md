# Plan 3 final wave, lane A: server core (everything in apps/server except src/claude/) + packages/protocol

Worktree: /home/claude/wt-p3-fa (branch p3-fa, off c758a36). Your files: apps/server/src/** EXCEPT apps/server/src/claude/** (another lane owns it), packages/protocol/**. Do not touch apps/client, ops, docs (another lane owns them).

Source of truth for every item: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-review-report.md (read "Important", "Minor" and the "Ledger triage" table). Do every item below. Each behavior change gets a test that fails before the fix (RED) and passes after (GREEN); say in the report which tests you saw RED.

## Must-fix
1. **I1** pin the push refspec in git.ts push(): `push --set-upstream origin refs/heads/<b>:refs/heads/<b>`. RED test in git.test.ts: with `remote.origin.push` mapping the build branch onto refs/heads/main, after push origin main is unchanged and origin build/... == HEAD. Also add `-c core.hooksPath=/dev/null` to the two authed calls (fetch, push), with a test that a pre-push hook in the checkout does not run.
2. **I2** (controller Ruling 18): in BuildService prepare, when the checkout is dirty AND on a `build/` branch whose task is not open (closed or merged), commit the leftovers locally on that branch with message `Uncommitted work left by task #<id>` (include untracked files; never push), then create the new branch as usual. Keep the 409 for a dirty default branch or any non-`build/` branch. Test: Claude writes a file → Stop → Close → send creates task 2 on a new branch; old branch holds the WIP commit; origin unchanged. Also the verify-leftovers path: merged task + untracked file → next send works.

## Minor (from the report)
3. **M1** prepare also runs a best-effort fetch() when continuing an open task (a failed fetch must not fail the send; log one line).
4. **M2** (Ruling 20) push the hub's own build/ branch with `--force-with-lease=refs/heads/<b>:<task.headSha>` when the task has a recorded pushed head; plain push when it has none. Test: Claude amends after the first push → the second finish pushes successfully; a lease mismatch (someone else pushed) fails with a clear task error.
5. **M3** (Ruling 19) Close task keeps the PR open on GitHub; change the close copy to say so (e.g. "Task closed. The pull request stays open on GitHub. The next message starts a new branch."). No new GitHub write call. Update tests that pin the old copy (and tell the lane-C client owner nothing: the client renders server copy).
6. **M4** CI: also read check suites for the ref (`checks.listSuitesForRef`) and treat any suite not `completed` as pending; FakeGitHub gains suites. Test: all listed runs green but one suite queued → pending, no "Ready to merge".

## Ride-along rows of the triage table (all rows marked ride-along for T1-T8, T11-T21, plus "T2", "T17 (parked) → 502", "T18 (parked) Octokit timeout")
Do every ride-along row whose files are yours. Priorities first: T3 wildcard binds (reject `0`, `0.0.0.0`, `::`, `::0`, `[::]` and other all-interface spellings; Node binds `0` to all), T5 verifyPassphrase fail-closed on weak stored params / empty salt, T18 30 s `AbortSignal.timeout` on Octokit fetch, T17 Merge GitHub read failure → 502 "Could not reach GitHub.", T21 oneLine try/catch, T16 defaultBranch fail-closed when origin/HEAD is unset (use `ls-remote --symref origin HEAD` as fallback), T14 SIGKILL the process group on timeout/abort. Rows marked "stay parked" or "resolved" are not yours.

## Rules
- No secrets in argv; never set ANTHROPIC_API_KEY; no network in tests.
- Run `pnpm -F @hub/server test`, `pnpm -F @hub/protocol test`, `pnpm -r typecheck` before finishing; all green.
- Small commits grouped by area. Commit trailer: use the Co-Authored-By and Claude-Session lines your own harness gives you.
- Report file: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-wave-A-report.md (each item → done/skipped with reason, RED evidence, commit list, suite counts).
