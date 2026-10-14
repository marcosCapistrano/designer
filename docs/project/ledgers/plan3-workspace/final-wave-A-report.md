# Final wave A report (branch p3-fa, worktree /home/claude/wt-p3-fa)

Suites: server 1113 passed, 2 skipped (28 files); protocol 19 passed; `pnpm -r typecheck` clean.

## Commits
3ff99eb protocol: exhaustive SERVER_MSG_TYPES, finite ping t, manifest export tests
bb8d5b2 config: all-interface bind spellings, credential read errors, newer db schema refused
ded5f6a verifyPassphrase fails closed on weak stored params; auth test gaps
442e3f8 ws error paths, close(), unflaky heartbeat timings
d1a0525 push refspec pinned, hooks off for authed git, fail-closed defaultBranch (I1, T16)
006aa42 leftovers kept on finished task, fetch on continue, lease (I2, M1, M2, M3)
5470dcc CI waits for check suites, 502 when GitHub unreachable, 30 s request timeout (M4, T17, T18)
bfe9da7 Stop wins the finish message, SIGKILL the group, stale errors cleared (T14)
a0c4e37 tile names bounded, cut-off uploads not logged, static path fails closed
(last) safe errorText, close drains background ticks, startup failure after listen tears down (T21)

## Items
Done: I1, I2, M1, M2 (deviation below), M3, M4, T1-T6, T8, T11-T21 ride-alongs whose files are lane A.
Skipped: T9, T10 (src/claude lane), T22-T29 (client/ops lanes), T7 and the poll-only onMerged item (parked).

## RED evidence (old source restored, new tests failed, then new source restored)
config spellings and credential read errors; db downgrade and migration rollback; weak passphrase params;
git push refspec, hooks, leases, defaultBranch, isDirty, remoteUrl, configParameters, currentBranch with a tag;
service leftovers, fetch, close copy; finish stop/error clearing; ci 502, overlap, merged-during-read;
M4 suites (octokit/github/fake/ci); octokit timeout; commands SIGKILL; Grep/Glob truncation; aborted upload log;
tile-name 404; main.ts unprintable errors; server.ts failure-after-listen and in-flight tick drained before db.close.

## Tests NOT seen RED (characterization or already-correct behavior)
Empty salt (already rejected by the base64url regex); mayServe errno test (serveStatic already 404s);
checkout with a same-named file; close of a task with no PR; lease-mismatch test (also passes under a plain push);
several test-only gap rows (T8, T13 limits, T15, T18 and similar).

## Concerns
- M2 deviation: the brief says lease = task.headSha. refreshCi/prepare overwrite headSha with GitHub's current PR head,
  so that lease would always match GitHub and silently overwrite someone else's push. Used a separate `pushed_sha`
  column (db migration 2, written after each successful push). May conflict with plan 4 migrations at merge.
- M4 refinement: suites with zero runs are ignored (only open suites with runCount > 0 hold pending).
- M3: close copy is conditional on a PR existing; without a PR the old copy stays.
- "Rename test at :449" could not be pinpointed; renamed the finish test about origin-only default branch.
- IPv6 unavailable in the sandbox (EAFNOSUPPORT): only a hubUrl unit test, no IPv6 listen test.
- Sandbox runs as root: the chmod-unreadable-credential test is skipped.
- Test repo helpers set GIT_CONFIG_GLOBAL=/dev/null (sandbox-only `-c` environment note).
