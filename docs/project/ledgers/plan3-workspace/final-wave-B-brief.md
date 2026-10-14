# Plan 3 final wave, lane B: guard + runner (apps/server/src/claude/** only)

Worktree: /home/claude/wt-p3-9 (branch p3-9, now at c758a36 = current feat/hub-server). Your files: apps/server/src/claude/** only.

Source of truth: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-review-report.md ("Ledger triage" rows T9 / Ruling 16 and T10) and your own round-5 re-review residuals (I-1, I-2, R2, R3, R4, R7, R8) in that ledger's Ruling 16 line. Each change gets a RED→GREEN test.

## Ruling 16 carries (one rule + one RED test each)
1. I-1/R1 + R2: per-word lexer `hidden` flag (quoted `$(`/backtick that bash would not substitute but that sits in a data-builtin word) used at guard.ts:154 and :688 instead of the `expanded` flag. Repros: `declare $'a[$(ssh h)]'=1`, `declare 'a[$(ssh h)]'$E=1`.
2. R3: single-quoted `$(` in arithmetic (scanArith skips quotes, shell-lexer.ts:787-789).
3. R4: `$'...'` inside `${...}`.
4. I-2/R5: UNCLEAR when a shell's `--rcfile` / `--init-file` value is a stdin path (/dev/stdin, /dev/fd/0, /proc/self/fd/0, /proc/thread-self/fd/0, `-`).
5. R7: `git config --file X "$K"` (dynamic key with --file/-f) → treat like the dynamic-key rule.
6. R8: deny push-shaped third-party git subcommands (`git annex sync|copy --to|push`, `git-annex …`, and the same for the dashed forms); `git lfs push` is already denied — keep it.
Then re-run your corpora A/B/C and report the counts vs round 5 (285/4, 78/7, 41/3); no new false denies beyond the ones these rules imply.

## T10 ride-along rows
7. (priority) Any tool input with a string `command` field (Monitor and any future tool) goes through deployDenyReason, not only Bash. RED: `checkToolUse('Monitor', {command:'git push origin HEAD:main'})` currently null.
8. (priority) guardHook fails closed: try/catch → deny with a reason, plus a test that a throwing check denies.
9. Block Edit/Write/NotebookEdit/MultiEdit to `.claude/settings.json`, `.claude/settings.local.json`, `.claude/settings*.json` and `.mcp.json` (any depth under the checkout). Also probe once whether a project `disableAllHooks: true` disables the SDK callback hook; write the finding in the report (no code if it doesn't).
10. Env test over every SECRET_ENV_KEYS entry, oauthToken null, queryFn args, no hook matcher; filter the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` stderr warning; skip queryFn on a pre-aborted signal. The WireMessage narrowing row is optional.
Also (from I1 in the report): deny `git config` writes to `remote.<name>.push`, `remote.<name>.pushurl`, `remote.<name>.url` and `url.<x>.insteadOf` / `pushInsteadOf` (one rule, RED test); lane A pins the hub's refspec, this closes the config path too.

## Rules
- Run `pnpm -F @hub/server test` and `pnpm -r typecheck` before finishing; all green.
- Small commits. Commit trailer: use the Co-Authored-By and Claude-Session lines your own harness gives you.
- Report file: /home/claude/wt-p3/.superpowers/sdd/2026-10-14-hub-server-build/final-wave-B-report.md (each item → done/skipped, RED evidence, corpora counts, commit list, suite counts).
