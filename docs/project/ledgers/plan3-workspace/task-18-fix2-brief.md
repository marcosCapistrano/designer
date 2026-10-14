# Task 18 fix round 2 (from re-review a94d0b750a4bfab49)

Worktree /home/claude/wt-p3-18, branch p3-18. First `git merge --no-ff feat/hub-server` (the integration branch has moved). Run service.test.ts, the full server suite and `tsc --noEmit` at the end. The reviewer's probes are in /tmp/claude-0/-home-claude/d289a493-967d-56ba-9311-db4aba7933de/scratchpad/p3-18-harness (probe.test.ts has P1, P4, P6); turn the ones named below into suite tests.

1. Important: a Stop issued after the last check is dropped. During blockedReason()'s git calls (finish.ts:159) stop() returns true, yet the branch is pushed, a PR opens and the task ends in review. Fix: after finish.ts:160 add `if (signal.aborted) return fail('Stopped by you.');` (or the file's equivalent). Test (from P6): stop fires while blockedReason's git call is pending; final status failed with 'Stopped by you.', no branch on origin, no PR opened.

2. Important: cross-app coupling. send (service.ts:276) and state() (service.ts:194, 264) wait for the whole hub-wide poll, which is sequential over every app's review tasks, so one hung GitHub read in app B stalls send and state() for app A. Fix: drop the global `polling` gate as something sends/state wait on. The poll routes each per-task refresh through refreshOnce (the per-task single-flight map already prevents duplicate reads and announcements); state() and send wait only on their own task's in-flight refresh. A poll may still guard against two overlapping poll passes. Tests: (a) from P4: a send on app demo returns while another app's PR read hangs; (b) a poll and a state() on the same task announce a green PR once (keep the existing 962/973/995 meaning, adjusted to the new mechanism); (c) from P1: two state() calls on one task with no poll running read GitHub once and announce once.

3. Minor tests: rename test 1013 "shares a refresh between a send and state()" to what it proves (state() returns early while the send holds the app) or make it assert the GitHub read count; rename test 445 so it names the in-check stop it covers.

Parked (do not do): Octokit request timeout (github/octokit.ts) goes to the final wave.

Report: append a "Fix round 2" section to task-18-report.txt (same folder), including which tests fail on 54c9902 and pass after.
