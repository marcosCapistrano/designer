# Plan 3 final wave, lane B: guard and runner (apps/server/src/claude/**)

Worktree /home/claude/wt-p3-9, branch p3-9, based on c758a36. Only `apps/server/src/claude/**` was edited. Not pushed.

## Status

DONE_WITH_CONCERNS. Every required item is done, each with a RED→GREEN test. The optional WireMessage narrowing row was skipped (low value). The `disableAllHooks` probe needed no code.

## Commits

| Commit | What |
|---|---|
| `0727d4c` | fix(server): guard Ruling 16 carries, push-config writes, command tools, settings files |
| `d82aca2` | fix(server): runner guard hook fails closed, skip pre-aborted runs, quiet the shadowed warning |

## Test summary

- `pnpm -F @hub/server test`: 27 files, **1049 passed + 1 skipped** (c758a36: 981 + 1, so +68 tests).
- `pnpm -r typecheck`: all five packages clean (protocol, design-model, renderer, server, client).
- RED evidence:
  - With the new guard and lexer tests in place and `guard.ts` and `shell-lexer.ts` set back to c758a36, **37 tests fail** (35 guard rows, 2 lexer cases). With the changes, all pass.
  - With the SDK tests in place and `sdk.ts` at c758a36, **3 tests fail**: the throwing check, the pre-aborted signal and the warning filter. With the changes, all pass.
  - The Monitor case fails on c758a36 in `guard.test.ts`, where `checkToolUse` returned `null`.

## Corpora (reviewer's sets, allowed/denied)

| Set | Round 5 | Now |
|---|---|---|
| A, corpus.txt (289) | 285/4 | 285/4 |
| B, corpus3.txt (85) | 78/7 | 78/7 |
| C, corpus4.txt (44) | 41/3 | 41/3 |

I also diffed against the c758a36 guard on A, B, C and corpus2 (174). There are **0 commands that went from allowed to denied, and 0 from denied to allowed**, so these rules add no new false denies on the corpora. The remaining denials are the same ones listed in the round-5 report (task-9-report.txt, "Fix round 5").

## Items

### Ruling 16 carries (commit 0727d4c)

1. **I-1/R1 + R2: per-word `hidden` flag. Done.**
   - `LexWord` gets `hidden`. The lexer builds it from the word's literal parts only: plain, single- or double-quoted, escaped, and decoded `$'...'` text.
   - An expansion adds nothing to that text. So a `$(` or backtick in a quoted part is caught even when another part of the word is an expansion, and `\x24(` / `\140` inside `$'...'` decode to the characters they produce.
   - `hidesCommandSubstitution` (guard.ts) now returns `word.hidden || (old rule)`. It serves both call sites the ledger named: data-builtin arguments and assignment values in `findProgram`.
   - RED rows: the ledger's two repros, a hex-escaped variant, and an assignment-value variant.
   - Allowed rows: `declare "x=$(pwd)"`, `declare x=$'line\n'`.
2. **R3: quoted substitution in arithmetic. Done.**
   - `scanArith` now fails closed on a single-quoted or `$'...'` part that holds `$(` or a backtick.
   - Bash really runs it: checked locally with a harmless `touch`, and both `$(( ))` and `(( ))` run the substitution.
   - The ledger's original repro was already denied by round 5's subscript rule. The RED rows use a form without a subscript.
3. **R4: `$'...'` inside `${...}`. Done.** `scanParam` decodes a `$'...'` part and fails closed when it hides `$(` or a backtick. `echo ${x:-$'\n'}` stays allowed.
4. **I-2/R5: `--rcfile`/`--init-file` from stdin. Done.**
   - A shell whose rc or init file is `-`, `/dev/stdin`, `/dev/fd/N`, `/proc/self|thread-self|<pid>/fd/N`, or a run-time value is UNCLEAR. This covers both the separate-word and the `=` forms.
   - An rc file that is a real file stays allowed (the parked script-file class).
   - Note: a bare interactive shell with no `-c` was already UNCLEAR, because it has no operand. The RED rows therefore use `-ic :`.
5. **R7: `git config --file X "$K"`. Done.**
   - `gitConfigReason` skips the values of `-f`, `--file`, `--blob`, `--default`, `--type`, `--comment` and `--value` before it reads the key.
   - A dynamic key after them is UNCLEAR. A literal key with `--file` stays allowed.
6. **R8: push-shaped third-party subcommands. Done.**
   - These get the push reason:
     - `git annex sync|push|assist|export`
     - `git annex copy|move|mirror` with `--to` / `--to=`
     - a dynamic annex action (UNCLEAR rather than the push reason)
     - the dashed `git-annex …` forms, which go through round 5's `git-<x>` mapping
   - `git lfs push` stays denied. `git annex status|get|copy --from` and `git-annex info` stay allowed.

### Final review I1, config path (commit 0727d4c)

- **Done.** The push reason now applies to:
  - `git config` **writes** to `remote.<name>.push|pushurl|url` and `url.<x>.insteadOf|pushInsteadOf`, case-insensitive. A write is a modern `set`/`unset` subcommand, a key with a value, or `--add`, `--replace-all`, `--unset` or `--unset-all`. This includes writes with `--file .git/config`.
  - `git remote set-url|rename|remove|rm`.
- Reads stay allowed: `--get`, `get`, a key with no value, `--list`, `git remote -v`, `git remote get-url`.
- Lane A pins the hub's refspec. This closes the path that goes through Claude's Bash tool.

### T10 ride-alongs

7. **Command-bearing tools. Done (0727d4c).**
   - `checkToolUse` sends any tool input that has a **string** `command` field through `deployDenyReason`, not only Bash. That covers Monitor and any future tool.
   - RED: `checkToolUse('/repo', 'Monitor', {command: 'git push origin HEAD:main'})` was `null`, and is now the push reason.
   - A non-string `command` is ignored. There is also a hook-level test in `sdk.test.ts`.
8. **guardHook fails closed. Done (d82aca2).**
   - `guardHook(cwd, check = checkToolUse)` wraps the check in try/catch.
   - A throw is a deny with `GUARD_ERROR_REASON` ("The Hub could not check this tool call, so it is denied. …").
   - RED: the test with a throwing check.
9. **Settings and MCP files. Done (0727d4c).**
   - Edit, Write, MultiEdit and NotebookEdit are denied for `.claude/settings*.json` (`settings.json`, `settings.local.json`, any `settings*.json` directly under a `.claude` directory) and for `.mcp.json`, at any depth under the checkout.
   - The new reason is "Claude Code settings and MCP config are managed by the Hub; do not edit them in Build." The existing reason strings are unchanged.
   - `.claude/commands/*`, `.claude/agents/*` and an unrelated `settings.json` stay editable.
   - **`disableAllHooks` probe: it does not disable the SDK callback hook.**
     - I ran the real SDK (0.3.299) offline: the API pointed at a closed localhost port, a dummy key, and temporary HOME and CLAUDE_CONFIG_DIR.
     - The project `.claude/settings.json` was tested with and without `disableAllHooks: true`, plus a settings-file hook as a positive control.
     - Control: the settings hook ran, and the SDK `UserPromptSubmit` callback fired.
     - With `disableAllHooks: true`: the settings hook **did not** run, and the SDK callback **still fired**.
     - PreToolUse could not be seen directly, because offline there is no model to call a tool. It is registered through the same SDK callback channel. No code change needed.
10. **Runner tests and fixes. Done (d82aca2).**
    - Tests pin:
      - the env: every `SECRET_ENV_KEYS` entry dropped, only the hub token added, and no token when `oauthToken` is null, even if the hub's own env has one
      - the `queryFn` arguments: prompt, cwd, resume, allowedTools, abortController, env
      - one PreToolUse hook with no matcher
    - The pinning tests already passed; the ledger asked for tests, not fixes.
    - Fixes (RED first):
      - `run()` with an already-aborted signal does not call `queryFn` and yields `done(aborted)` (it keeps the resume session id).
      - The SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning is dropped by a one-time `process.emitWarning` filter that handles both the options and the positional forms. Every other warning passes through, and the test checks both.
    - The **WireMessage narrowing** row was **skipped**: it is optional and of low value, and stays parked.

## Concerns

1. **Writing these files through Bash is not modelled.**
   - The settings/MCP block and the `.git` block cover only the file-edit tools.
   - A shell redirect into `.claude/settings.json`, `.mcp.json` or `.git/config` is not seen by this text guard.
   - This is the same parked class as script files: plan 4's OS boundary.
   - The config rule here closes the `git config` / `git remote` porcelain path only.
2. **New false-deny classes, by design.**
   - These are now denied:
     - `git remote rename|remove`
     - `git remote set-url` and `git config` writes to remote URLs
     - git-annex push-shaped commands
     - a shell rc file named by a variable
     - a data-builtin word or assignment value whose literal text holds `$(`/backtick, even next to an expansion
     - a `$'...'` with an escape that decodes to `$` or a backtick, inside arithmetic or `${...}`
   - None of these appear in corpora A, B, C or corpus2.
3. **The `disableAllHooks` result is an inference for PreToolUse** (see item 9). If the team wants it checked directly, the `HUB_LIVE_CLAUDE` live test could add a project `disableAllHooks` and assert that the hook denies.
4. **The warning filter patches `process.emitWarning` once, for the whole process.** It drops only that one code.
