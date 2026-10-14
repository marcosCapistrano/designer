# Task 9 fix round 3: quote-aware lexer for the deploy guard

Worktree /home/claude/wt-p3-9, branch p3-9, HEAD 1a83401. File: apps/server/src/claude/guard.ts (+ guard.test.ts). Read the original brief (task-9-brief.md, same directory) and the current guard first. Keep every exported name, signature and exact reason string, and keep all 190 existing tests passing unless a test asserts one of the false denies listed below (then flip it and say so).

Ruling 10 still holds: the guard is defense in depth; fail closed with UNCLEAR_REASON when unsure. Ruling 13: the round-2 re-review showed the remaining bypasses and false denies share one root cause — separators, parentheses and globs are found by text scans that ignore quoting. Replace those scans with ONE quote-aware lexer pass, then evaluate rules on its output.

## Lexer
A single left-to-right scan that tracks single quotes, double quotes, backslash escapes, `$(...)`, backticks (nested), `${...}`, and heredocs (`<<WORD`, `<<-WORD`, `<<'WORD'`). Output: a list of simple commands, each a list of words, where each word carries its dequoted text and a `dynamic` flag (true if any unquoted or double-quoted part contains `$`, a backtick, a substitution, an unquoted glob char `* ? [` or an unquoted brace expansion). Separators (`; & && || | |& newline`), grouping `( ) { }`, and redirections (`<`, `>`, `>>`, `>|`, `&>`, `&>>`, `N>`, `N>&M`, `<<<`, `<<`) count only outside quotes. Substitution bodies (`$(...)`, backticks, `<(...)`, `>(...)`) are lexed recursively as their own command lists and checked too; a word whose program position comes from a substitution is dynamic. Heredoc bodies are NOT commands — skip them — unless the heredoc feeds a shell or interpreter that runs stdin (`bash`, `sh`, the shell list, `xargs`, `at`), in which case fail closed. Nesting depth over 32 fails closed. Wrap the whole guard entry in try/catch → UNCLEAR_REASON (a 2,500-deep `$(` currently throws RangeError).

## Bypasses to close (each a failing test first; assert exact reason strings)
- B1 append assignment prefixes: `FOO+=1 git push`, `A=1 B+=2 git push`, `FOO+=1 >x git push`.
- B2 separators inside quotes/escapes: `FOO="a;b" git push`, `FOO='a;b' git push`, `FOO="a(b" git push`, `FOO="a|b" git push`, `FOO=a\;b git push`, `env "FOO=a;b" git push`, `>"a;b" git push`, `sudo -u "a;b" git push`, `A="1;2" B="3;4" git push`, and the same prefix before `ssh h`, `docker ps`, `pnpm exec git push`, `npm run deploy`, `gh pr merge 3`.
- B3 pnpm `-w` is boolean (`--workspace-root`) but npm `-w` takes a value: evaluate both readings and deny if either denies: `pnpm -w exec git push`, `pnpm -w exec ssh h` deny; `pnpm -w test`, `pnpm -w install`, `pnpm -w lint` allowed.
- B4 unknown `--opt` without `=` after `run` fails closed: `npm run --loglevel silent deploy`, `npm run --registry http://x deploy`, `npm run --script-shell /bin/sh deploy`, `pnpm run --reporter silent deploy`.
- B5 corepack is a wrapper and `@version` is stripped from the next word: `corepack pnpm exec git push`, `corepack pnpm@9 exec git push`, `corepack npm run deploy`, `corepack pnpm deploy:prod`, `corepack yarn exec ssh h`, `corepack npm publish`, `corepack pnpm publish`.
- B6 `xargs -I X sh -c X` and `xargs -I X env X push`: words equal to the -I/-i/--replace string are dynamic.
- B7 pnpm regex script selectors fail closed: `pnpm run '/^dep/'`, `pnpm -r run '/deploy/'`.
- B8 runner subcommands: `npm explore foo -- git push`, `pnpm recursive exec git push`, `pnpm m exec git push`, `pnpm multi run deploy`, `yarn workspace web run deploy`, `yarn workspaces foreach -A exec git push`, `yarn workspaces run deploy`.
- B9 versioned package specs: strip `@…` before matching DEPLOY_PROGRAMS: `npx vercel@latest deploy`, `pnpm dlx vercel@latest`.
- Cheap extras: alias denial case-insensitive (`git config ALIAS.p push`, `git -c Alias.p=push p`, `GIT_CONFIG_KEY_0=ALIAS.p`) and `GIT_CONFIG_GLOBAL=`/`GIT_CONFIG_SYSTEM=` prefixes fail closed; wrappers pkexec, run0, systemd-run, ssh-agent, sshpass, tmux (fail closed), fakeroot, numactl, at (fail closed); shells rbash, mksh; builtins `trap`, `source`/`.` with a substitution, `alias`, `shopt -s expand_aliases` fail closed; git `submodule foreach`, `rebase -x/--exec`, `subtree push`, `lfs push` deny with the push reason.

## False denies to remove (each an allowed-regression test)
- Empty parentheses inside quotes or heredoc bodies: `git commit -m "fix: handle foo() returning null"`, a heredoc commit body containing `render()`, `grep -rn "foo()" src`, `sed -i 's/foo()/bar()/g' f.ts`, `node -e "fn()"`, `git grep "foo()"`, `pnpm test -- -t "calls render()"`, `psql -c "select now()"`. (Unquoted `f() { …; }` and `function f` still fail closed.)
- Version/help: `npm -v`, `npm --version`, `pnpm -v`, `pnpm --version`, `yarn --version`, `bun --version`, `pnpm --help`, `pnpm -h`, bare `npm`/`pnpm`.
- Heredoc/quoted bodies with lines starting `* bullet`, `**Note:**`, `- [x] done`, `[WIP] x`, `$ cmd`, `{"a":1}`, `[Bulleted markdown checklist...]`, and a line starting with `ssh `.
- Quoted separators before program words: `git commit -m "fix: docker & ssh docs"`, `-m "chore: bump (docker) base image"`, `-m "feat(docker): x"`, `-m "feat(ssh): x"`.
- `sqlite3 db "select count(*) from t"`; `git checkout -b feat/x-{a,b}` may stay denied (brace expansion in a git word) — say which.
- Keep every currently allowed ordinary command allowed (pnpm test, pnpm -F x build, git status, git commit -m "x", git log --oneline, npm run build, ls >out, echo $HOME, cat a | grep b, node -e "1", git diff -- src, rg foo src, sed -n 1,5p f, git checkout -b feat/x, git add -A, mkdir -p a/b, pnpm -F @hub/server exec vitest run, tsc --noEmit, git stash list, find . -name '*.ts').

Also: write the private-use substitution marker as an escape (''), not a literal invisible character.

Run pnpm -F @hub/server test and pnpm -r typecheck. Commit. Append a "Fix round 3" section to task-9-report.txt with RED evidence (count of new tests failing before the rewrite).
