# Task 9 fix round 5 (final round; from re-review a30ed37c79304456c)

Worktree /home/claude/wt-p3-9, branch p3-9 (head 2cffa51). `git merge --no-ff feat/hub-server` first if it moved. This is the last fix round for Task 9: whatever the next re-review finds that needs deeper bash modelling is parked to plan 4 (Ruling 14). Same rules as round 4: test-first, every existing test passes unflipped unless this brief names it, exported names and reason strings unchanged. The reviewer's scratch (corpora, narrowing patch, fuzzers) is in /tmp/claude-0/-home-claude/d289a493-967d-56ba-9311-db4aba7933de/scratchpad/p9r4/ — reuse it, especially the three false-deny corpora (Set A 289, Set B 85, Set C 44 commands) and narrow/.

## Important: false denies of ordinary commands
I1. The data-builtin `$(`/backtick rule (guard.ts:970 `hasCommandSubstitutionText`) fires on real substitutions the lexer already scans, denying `[ -z "$(git status --porcelain)" ]`, `export SHA=$(git rev-parse HEAD)`, `local x=$(pwd)`, `[[ $(uname) == Linux ]]` and similar. Narrow it to `hidesCommandSubstitution(w)` (guard.ts:154, already used for assignment values) so only a `$(`/backtick that survives lexing (single-quoted or escaped) fails closed. Ruling 15: this deliberately reverses the round-4 brief's "quoted or not" wording for real substitutions — the lexer already checks what they run — cost if wrong: none, the substitution body is checked as a command. Tests: the 12 commands the re-review lists as new false denies in Sets A and B are allowed; every N9 repro stays denied.

## Cheap closes (one rule each)
C1. N6 sibling: throw LexUnclear on a `<` or `<<` operator while inside `[[ ]]`. Repros: `[[ x =~ (a <<E\n) ]]; ssh h` and the `<<'E'`, `<<-E`, `a(<<E\n)` variants → denied.
C2. N8: in `git config`, skip a leading `set`/`get`/`unset`/`list`/`get-regexp`/`rename-section`/`remove-section` subcommand word before reading the key. Repro: `git config set "$K" push` → denied.
C3. N9a: clustered flags: `mapfile`/`readarray` with C in any short-flag cluster (e.g. `-tC`), `compgen`/`complete` with C or F in a cluster (e.g. `-fC`) → UNCLEAR.
C4. N9b: a quote followed by `$(` or a backtick inside a `${...}` expansion (subscript or offset) → UNCLEAR. Repros: `echo ${a['$(ssh h)']}`, `echo ${a['$(ssh h)']:-d}`, `x=abc; echo ${x:0:'$(ssh h)'}`, `echo ${@:'$(ssh h)'}`, `echo ${!a['$(ssh h)']}` → denied.
C5. N10: `/proc/thread-self/fd/0` counts as stdin (and `/proc/<pid>/fd/0` if cheap).

## Minor false denies (fix)
M1. The `ENV=`/`PS4=`/`BASH_ENV=` rule (guard.ts:1016) applies only to assignment words (prefix assignments, `export`/`declare`/`local`/`readonly` operands, `env` operands), not to every word. Allowed after: `echo "ENV=prod" >> .env`, `grep ENV= .env`, `git commit -m "ENV=prod config"`, `echo "PS4=x"`. Still denied: `ENV=x bash -c :`, `export BASH_ENV=f`, `PS4='$(ssh h)' bash -x s.sh`.
M2. Arithmetic: allow `${...}` parameter expansions (e.g. `${#arr[@]}`) and subscripts whose index is digits, a plain `$name`, or `@`/`*` (e.g. `arr[0]`, `arr[$i]`); keep failing closed on a bare variable name operand and on any other subscript. Allowed after: `echo $((${#arr[@]} - 1))`, `for ((i=0;i<${#a[@]};i++)); do :; done`, `$(( arr[0] + 1 ))`. Still denied: `x='a[$(ssh h)]'; echo $((x))`, `(( x ))`, `let x`.
M3. git `-c`: only a dynamic KEY fails closed; a dynamic value after a literal key is fine, and `-c` after the subcommand (e.g. `git commit -c "$SHA"`, `git show -c "$SHA"`) is that subcommand's own option. Allowed after: `git -c user.name="$NAME" commit -m m`, `git commit -c "$SHA"`, `git show -c "$SHA"`. Still denied: `git -c "$K=push" p`, `git -c "ali$E.p=push" p`.
M4. `git-<sub>` programs: map `git-lfs`, `git-crypt` and any other `git-<x>` basename to `git <x>` and run the normal git rules (so `git-lfs push` keeps the push reason and `git-lfs status` is allowed); a `./scripts/git-*.sh` path that is not a git basename on PATH stays a normal script (parked class).
M5. `<<<`: the heredoc flag from `<<<` only feeds the stdin-script checks (shell operands, source/.); `xargs -n1 echo <<< "a b"` is allowed again. `bash script.sh <<< x` stays parked (script file). `bash -c 'pnpm test' <<< x` and `source .env <<< x`: allow if the stdin-script check doesn't apply (bash -c doesn't read stdin as script; source reads the named file).

Run the three corpora before and after and report counts (allowed/denied) and each remaining denial with its reason. Run the reviewer's fuzzers for a bounded time (≤ 7 minutes total) and report misses. Full server suite and server typecheck at the end. Leave no processes running.

Report: append a "Fix round 5" section to task-9-report.txt.
