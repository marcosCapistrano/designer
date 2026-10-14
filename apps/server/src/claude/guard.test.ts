import { describe, expect, it } from 'vitest';
import { checkToolUse, deployDenyReason } from './guard.js';

const GIT_PUSH = 'git push is done by the Hub after its checks pass.';
const MAIN = 'Stay on the task branch; the Hub manages main.';
const GH = 'Merges, releases and workflow runs go through the Hub.';
const PUBLISH = 'Publishing packages is not allowed in Build.';
const DEPLOY_SCRIPT = 'Deploying is a Hub action; deploy scripts are not allowed in Build.';
const HETZNER = 'Deploying is a Hub action; the Hetzner API is not allowed in Build.';
const ALIAS = 'Git and gh aliases can run deploys; they are not allowed in Build.';
const UNCLEAR = 'Build cannot tell which program this runs; name the program directly.';
const SETTINGS = 'Claude Code settings and MCP config are managed by the Hub; do not edit them in Build.';
const program = (name: string): string => `Deploying is a Hub action; ${name} is not allowed in Build.`;
const DOCKER = program('docker');
const SSH = program('ssh');
const SCP = program('scp');

/** Commands that must be allowed. */
const ALLOWED: string[] = [
  'pnpm test',
  'pnpm -F @hub/server test',
  'pnpm -F x build',
  'pnpm -F @hub/server exec vitest run',
  'npm run build',
  'npm test -- --filter x',
  'npx tsc --noEmit',
  'git status',
  'git commit -m "x"',
  'git commit -m "push the button"',
  'git commit -m "$(cat msg)"',
  'git log --oneline',
  'git checkout -b feature',
  'git checkout -b mainline',
  'git checkout -- src/a.ts',
  'grep -r docker .',
  'cat Dockerfile',
  'echo ssh is fine',
  'echo $HOME',
  'echo `date`',
  'ls >out',
  'cat a | grep b',
  'node -e "1"',
  'echo "git push"',
  'gh pr view 3',
  'gh pr create --title x',
  'timeout 60 pnpm test',
  'env -i FOO=1 pnpm test',
  'nice -n 5 pnpm test',
  'time pnpm test',
  'nohup pnpm dev',
  'xargs -I {} echo {}',
  '[ -f package.json ] && pnpm test',
  '{ git status; }',
  'command -v git',
  'command -V ssh',
  'ssh-keygen -t ed25519',
];

/** Commands that must be denied, with the exact reason. */
const DENIED: Array<[string, string]> = [
  // Composed and path-qualified deploys.
  ['git push', GIT_PUSH],
  ['git push origin build/x', GIT_PUSH],
  ['cd web && git push', GIT_PUSH],
  ['git -C web push', GIT_PUSH],
  ['/usr/bin/git push', GIT_PUSH],
  ['FOO=1 git push', GIT_PUSH],
  ['sudo docker compose up', DOCKER],
  ['bash -c "ssh deploy@1.2.3.4"', SSH],
  ['echo hi; scp a b:/c', SCP],
  ['x=$(ssh host)', SSH],
  ['gh pr merge 3', GH],
  ['pnpm publish', PUBLISH],
  ['npm run deploy:prod', DEPLOY_SCRIPT],
  ['curl -X POST https://api.hetzner.cloud/v1/servers', HETZNER],
  ['git switch main', MAIN],
  ['git checkout master', MAIN],
  ['git send-pack origin x', GIT_PUSH],
  ['git http-push http://x', GIT_PUSH],
  ['git --git-dir .git push', GIT_PUSH],
  ['git push>log.txt', GIT_PUSH],
  ['env -i ssh host', SSH],
  ['sudo -E docker ps', DOCKER],
  ['\\git push', GIT_PUSH],
  ['(git push)', GIT_PUSH],
  ['cat <(ssh host)', SSH],
  ['if true; then git push; fi', GIT_PUSH],
  ['gh -R owner/repo pr merge 1', GH],
  ['pnpm -F web run deploy', DEPLOY_SCRIPT],
  ['HCLOUD_TOKEN=x hcloud server create', program('hcloud')],
  ['echo `ssh host`', SSH],

  // Wrapper commands and their options.
  ['sudo -u root docker ps', DOCKER],
  ['timeout 60 git push', GIT_PUSH],
  ['timeout -s KILL 60 git push', GIT_PUSH],
  ['timeout -s9 60 git push', GIT_PUSH],
  ['env -i FOO=1 git push', GIT_PUSH],
  ['nice -n 5 nohup ssh host', SSH],
  ['nice -n5 nohup ssh host', SSH],
  ['xargs git push < x', GIT_PUSH],
  ['stdbuf -oL ssh host', SSH],
  ['ionice -c 3 scp a b:/c', SCP],
  ['time -p rsync a b:/c', program('rsync')],
  ['doas -u root kubectl apply -f x', program('kubectl')],
  ['command -- git push', GIT_PUSH],
  ['exec -a x docker ps', DOCKER],
  ['setsid -w ssh host', SSH],
  ['taskset 0x1 git push', GIT_PUSH],
  ['busybox ssh host', SSH],

  // Quoting and backslash escapes.
  ['g"it" push', GIT_PUSH],
  ["'git' push", GIT_PUSH],
  ['gi\\t push', GIT_PUSH],
  ['"/usr/bin/docker" ps', DOCKER],
  ['FOO="x y" git push', GIT_PUSH],
  ['eval "git push"', GIT_PUSH],

  // Leading redirections hide the program.
  ['>/dev/null git push', GIT_PUSH],
  ['2>&1 git push', GIT_PUSH],
  ['2>&1 ssh host', SSH],
  ['</dev/null git push', GIT_PUSH],
  ['>out git push', GIT_PUSH],
  ['FOO=1 >out git push', GIT_PUSH],
  ['>/dev/null sudo docker ps', DOCKER],

  // Program or rule word built at run time: fail closed.
  ['S=push; git $S', UNCLEAR],
  ['git "$S"', UNCLEAR],
  ['git $(echo push)', UNCLEAR],
  ['git `echo push`', UNCLEAR],
  ['git pu{sh,}', UNCLEAR],
  ['gh pr $B 3', UNCLEAR],
  ['npm run $S', UNCLEAR],
  ['git "$@"', UNCLEAR],
  ['g() { git "$@"; }; g push', UNCLEAR],
  ['echo push | xargs git', UNCLEAR],
  ['$(echo git) push', UNCLEAR],
  ['"`echo git` push"', UNCLEAR],
  ['eval "$(echo git push)"', UNCLEAR],
  ['sh -c "$(echo \'git push\')"', UNCLEAR],
  ['sudo --bogus docker ps', UNCLEAR],
  ['$GIT push', UNCLEAR],
  ['g?t push', UNCLEAR],
  ["$'git' push", UNCLEAR],
  ['git -C web', UNCLEAR],
  ['curl "$URL"', UNCLEAR],
  ['curl https://api.hetzner.[c]loud/v1', UNCLEAR],

  // Option placement for git, gh and npm.
  ['git --config-env core.x=HOME push', GIT_PUSH],
  ['git --attr-source HEAD push', GIT_PUSH],
  ['gh pr -R o/r merge 3', GH],
  ['gh pr --repo=o/r merge 3', GH],
  ['gh workflow -R o/r run w.yml', GH],
  ['npm run -s deploy', DEPLOY_SCRIPT],
  ['npm run --silent deploy', DEPLOY_SCRIPT],
  ['npm run --if-present deploy', DEPLOY_SCRIPT],
  ['npm run -w web deploy', DEPLOY_SCRIPT],
  ['npm run -- deploy', DEPLOY_SCRIPT],
  ['pnpm run -r deploy', DEPLOY_SCRIPT],
  ['npm run-script deploy', DEPLOY_SCRIPT],
  ['npm rum deploy', DEPLOY_SCRIPT],
  ['npm urn deploy', DEPLOY_SCRIPT],
  ['pnpm deploy:prod', DEPLOY_SCRIPT],
  ['yarn deploy:prod', DEPLOY_SCRIPT],

  // Package-manager runners and npx-style runners.
  ['pnpm exec git push', GIT_PUSH],
  ['pnpm -F x exec docker ps', DOCKER],
  ['npm exec -- git push', GIT_PUSH],
  ['npx docker ps', DOCKER],
  ['yarn exec ssh host', SSH],
  ['bunx git push', GIT_PUSH],
  ['pnpm dlx docker ps', DOCKER],
  ['pnpx git push', GIT_PUSH],

  // Aliases.
  ['git -c alias.p=push p', ALIAS],
  ['git config alias.p push', ALIAS],
  ['GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p', ALIAS],
  ['gh alias set x "pr merge"', ALIAS],

  // Shells, including busybox sh.
  ['dash -c "git push"', GIT_PUSH],
  ['ksh -c "ssh host"', SSH],
  ['fish -c "git push"', GIT_PUSH],
  ['busybox sh -c "git push"', GIT_PUSH],
  ['zsh -c "docker ps"', DOCKER],
  ["csh -c 'scp a b:/c'", SCP],
  ['tcsh -c "git push"', GIT_PUSH],
  ['ash -c "ssh h"', SSH],
  ['echo "git push" | sh', UNCLEAR],
  ['bash -s', UNCLEAR],
  ['bash < x.sh', UNCLEAR],

  // Wrappers that are not modelled fail closed.
  ['su -c "git push" root', UNCLEAR],
  ['runuser -u root -- git push', UNCLEAR],
  ['flock /tmp/x git push', UNCLEAR],
  ['watch -n 1 git push', UNCLEAR],
  ['script -c "git push" /dev/null', UNCLEAR],
  ['strace -f git push', UNCLEAR],
  ['chroot /x git push', UNCLEAR],
  ['unshare -r git push', UNCLEAR],
  ['nsenter -t 1 git push', UNCLEAR],
  ['parallel git push ::: x', UNCLEAR],
  ['find . -exec ssh host {} \\;', UNCLEAR],
  ['find . -execdir git push ;', UNCLEAR],

  // Functions and coprocesses fail closed.
  ['function f { git push; }', UNCLEAR],
  ['f() { git push; }', UNCLEAR],
  ['coproc git push', UNCLEAR],

  // Backslash-newline: removed only when the backslash is not itself escaped.
  ['echo \\\\\ngit push', GIT_PUSH],
  ['git \\\npush', GIT_PUSH],

  // Hetzner matching ignores case.
  ['curl https://API.HETZNER.CLOUD/v1', HETZNER],
];

// ---------------------------------------------------------------------------------------------
// Fix round 3: one quote-aware lexer decides where words, separators and bodies are.
// ---------------------------------------------------------------------------------------------

/** A commit body full of punctuation that must never be read as commands. */
const BODY_LINES = [
  'fix: handle render() and foo()',
  '',
  '* bullet',
  '**Note:** careful',
  '- [x] done',
  '[WIP] x',
  '$ cmd',
  '{"a":1}',
  '[Bulleted markdown checklist...]',
  'ssh host',
  'docker & ssh docs',
];
const BODY = BODY_LINES.join('\n');
const BODY_DQ = BODY.replace('{"a":1}', '{a:1}');

/** False denies that round 2 left behind. Each must be allowed. */
const ALLOWED_3: string[] = [
  // Empty parentheses and other punctuation inside quotes are text.
  'git commit -m "fix: handle foo() returning null"',
  'grep -rn "foo()" src',
  "sed -i 's/foo()/bar()/g' f.ts",
  'node -e "fn()"',
  'git grep "foo()"',
  'pnpm test -- -t "calls render()"',
  'psql -c "select now()"',
  'sqlite3 db "select count(*) from t"',
  // Separators and keywords inside quotes are text.
  'git commit -m "fix: docker & ssh docs"',
  'git commit -m "chore: bump (docker) base image"',
  'git commit -m "feat(docker): x"',
  'git commit -m "feat(ssh): x"',
  'echo "a;b" && echo \'c|d\'',
  'echo "a\\"; git push; echo \\"b"',
  'echo \'"; git push; echo "\'',
  "echo $'it\\'s; git push' ok",
  'echo \\; git push',
  // Heredoc and quoted bodies are data.
  `git commit -F - <<'EOF'\n${BODY}\nEOF`,
  `git commit -m "$(cat <<'EOF'\n${BODY}\nEOF\n)"`,
  `cat <<EOF > notes.md\n${BODY}\nEOF`,
  `cat <<-EOF\n${BODY_LINES.map((l) => `\t${l}`).join('\n')}\n\tEOF`,
  `cat > notes.md <<"EOF"\n${BODY}\nEOF\ngit status`,
  `git commit -m "${BODY_DQ}"`,
  `git commit -m '${BODY}'`,
  "cat <<'EOF'\n$(ssh host)\nEOF",
  'echo hi # it\'s fine',
  'pnpm test # ssh docs',
  // Version and help flags run nothing.
  'npm -v',
  'npm --version',
  'pnpm -v',
  'pnpm --version',
  'yarn --version',
  'bun --version',
  'pnpm --help',
  'pnpm -h',
  'npm',
  'pnpm',
  // pnpm -w is a boolean, npm -w takes a value: both readings must allow these.
  'pnpm -w test',
  'pnpm -w install',
  'pnpm -w lint',
  // Ordinary commands stay allowed.
  'pnpm test',
  'pnpm -F x build',
  'git status',
  'git commit -m "x"',
  'git log --oneline',
  'npm run build',
  'ls >out',
  'echo $HOME',
  'cat a | grep b',
  'node -e "1"',
  'git diff -- src',
  'rg foo src',
  'sed -n 1,5p f',
  'git checkout -b feat/x',
  'git add -A',
  'mkdir -p a/b',
  'pnpm -F @hub/server exec vitest run',
  'tsc --noEmit',
  'git stash list',
  "find . -name '*.ts'",
  'git stash show stash@{0}',
  'git checkout HEAD@{1} -- a.ts',
  "curl -d '{\"a\":1.5}' http://localhost:8787/x",
  "curl -s 'http://localhost:8787/health?x=1'",
  'echo $((1 + 2))',
  'echo $(( $i + 1 ))',
  'x=$(( 1 << 2 )); echo $x',
  'echo "$(date)"',
  'corepack enable',
  'corepack prepare pnpm@9 --activate',
  'git bisect run pnpm test',
  'git rebase main',
  'git rebase -Xours main',
  'git submodule update --init',
  'git subtree split --prefix=x',
  'git lfs pull',
  'source .env',
  '. ./env.sh',
  'shopt -s nullglob',
  'ls | xargs wc -l',
  'ls | xargs',
  'ls | xargs -I {} echo {}',
  // case patterns are not commands.
  'case "$1" in\n  a) echo a ;;\n  *) echo other ;;\nesac',
  'case x in a|b) echo ab ;; (c) echo c ;; [d]*) echo d ;; esac',
  'case x in a) echo a;; esac; echo done',
];

/** Parts used to build prefix cases. */
const PREFIXES = [
  'FOO="a;b" ',
  "FOO='a;b' ",
  'FOO="a(b" ',
  'FOO="a|b" ',
  'FOO=a\\;b ',
  'A="1;2" B="3;4" ',
  'FOO+=1 ',
  'A=1 B+=2 ',
  'FOO+=1 >x ',
];
const TARGETS: Array<[string, string]> = [
  ['git push', GIT_PUSH],
  ['ssh h', SSH],
  ['docker ps', DOCKER],
  ['pnpm exec git push', GIT_PUSH],
  ['npm run deploy', DEPLOY_SCRIPT],
  ['gh pr merge 3', GH],
];
const PREFIX_CASES: Array<[string, string]> = PREFIXES.flatMap((prefix) =>
  TARGETS.map(([target, reason]): [string, string] => [`${prefix}${target}`, reason]),
);

const VERCEL = program('vercel');

/** Bypasses that round 2 left behind, plus the new fail-closed rules. Each has an exact reason. */
const DENIED_3: Array<[string, string]> = [
  ...PREFIX_CASES,
  ['env "FOO=a;b" git push', GIT_PUSH],
  ['>"a;b" git push', GIT_PUSH],
  ['sudo -u "a;b" git push', GIT_PUSH],

  // pnpm -w is boolean, npm -w takes a value: deny when either reading denies.
  ['pnpm -w exec git push', GIT_PUSH],
  ['pnpm -w exec ssh h', SSH],

  // Unknown --opt without = after run fails closed.
  ['npm run --loglevel silent deploy', UNCLEAR],
  ['npm run --registry http://x deploy', UNCLEAR],
  ['npm run --script-shell /bin/sh deploy', UNCLEAR],
  ['pnpm run --reporter silent deploy', UNCLEAR],

  // corepack is a wrapper, and @version is not part of the program name.
  ['corepack pnpm exec git push', GIT_PUSH],
  ['corepack pnpm@9 exec git push', GIT_PUSH],
  ['corepack npm run deploy', DEPLOY_SCRIPT],
  ['corepack pnpm deploy:prod', DEPLOY_SCRIPT],
  ['corepack yarn exec ssh h', SSH],
  ['corepack npm publish', PUBLISH],
  ['corepack pnpm publish', PUBLISH],
  ['npx vercel@latest deploy', VERCEL],
  ['pnpm dlx vercel@latest', VERCEL],

  // xargs -I: words with the replace string are filled in at run time.
  ['xargs -I X sh -c X', UNCLEAR],
  ['xargs -I X env X push', UNCLEAR],
  ['xargs -IX sh -c X', UNCLEAR],
  ['xargs -i sh -c {}', UNCLEAR],
  ['xargs --replace=X sh -c X', UNCLEAR],
  ['echo publish | xargs pnpm', UNCLEAR],
  ['echo "merge 3" | xargs gh pr', UNCLEAR],
  ['echo main | xargs git checkout', UNCLEAR],
  ['echo "ssh h" | xargs env', UNCLEAR],
  ['echo "ssh h" | xargs nice', UNCLEAR],
  ['echo "ssh h" | xargs timeout 5', UNCLEAR],

  // Script selectors that can match deploy scripts.
  ["pnpm run '/^dep/'", UNCLEAR],
  ["pnpm -r run '/deploy/'", UNCLEAR],
  ["pnpm run 'dep*'", UNCLEAR],
  ["pnpm run '*'", UNCLEAR],

  // Runner subcommands.
  ['npm explore foo -- git push', GIT_PUSH],
  ['npm explore foo', UNCLEAR],
  ['pnpm recursive exec git push', GIT_PUSH],
  ['pnpm m exec git push', GIT_PUSH],
  ['pnpm multi run deploy', DEPLOY_SCRIPT],
  ['yarn workspace web run deploy', DEPLOY_SCRIPT],
  ['yarn workspaces foreach -A exec git push', GIT_PUSH],
  ['yarn workspaces run deploy', DEPLOY_SCRIPT],

  // Alias denial ignores case; git config files from the environment are not trusted.
  ['git config ALIAS.p push', ALIAS],
  ['git -c Alias.p=push p', ALIAS],
  ['GIT_CONFIG_KEY_0=ALIAS.p GIT_CONFIG_VALUE_0=push git p', ALIAS],
  ['GIT_CONFIG_GLOBAL=/tmp/c git p', UNCLEAR],
  ['GIT_CONFIG_SYSTEM=/tmp/c git status', UNCLEAR],
  ['env GIT_CONFIG_GLOBAL=/tmp/c git p', UNCLEAR],

  // More wrappers and shells.
  ['pkexec git push', GIT_PUSH],
  ['pkexec --user root git push', GIT_PUSH],
  ['run0 git push', GIT_PUSH],
  ['run0 -u root git push', GIT_PUSH],
  ['systemd-run git push', GIT_PUSH],
  ['systemd-run -u job git push', GIT_PUSH],
  ['ssh-agent git push', GIT_PUSH],
  ['ssh-agent -t 60 git push', GIT_PUSH],
  ['sshpass -p x git push', GIT_PUSH],
  ['sshpass -p x ssh h', SSH],
  ['fakeroot git push', GIT_PUSH],
  ['numactl -N 0 git push', GIT_PUSH],
  ['numactl --cpunodebind=0 git push', GIT_PUSH],
  ["tmux new-session -d 'git push'", UNCLEAR],
  ['at now', UNCLEAR],
  ['rbash -c "git push"', GIT_PUSH],
  ['mksh -c "ssh h"', SSH],
  ['sudo -s', UNCLEAR],
  ['sudo -i', UNCLEAR],

  // Builtins that run code later or read it from somewhere else.
  ["trap 'git push' EXIT", UNCLEAR],
  ['source <(echo x)', UNCLEAR],
  ['. $(echo f)', UNCLEAR],
  ['source "$F"', UNCLEAR],
  ['source /dev/stdin <<< x', UNCLEAR],
  ["alias gp='git push'", UNCLEAR],
  ['shopt -s expand_aliases', UNCLEAR],

  // More git subcommands that push or run commands.
  ["git submodule foreach 'echo hi'", GIT_PUSH],
  ['git rebase -x make main', GIT_PUSH],
  ['git rebase --exec make main', GIT_PUSH],
  ['git rebase --exec=make main', GIT_PUSH],
  ["git rebase -i -x 'pnpm test' main", GIT_PUSH],
  ['git subtree push --prefix=x origin main', GIT_PUSH],
  ['git lfs push origin main', GIT_PUSH],
  ['git for-each-repo --config=x.y push', GIT_PUSH],
  ['git bisect run git push', GIT_PUSH],
  ['git bisect run', UNCLEAR],

  // Brace expansion in a git word stays denied.
  ['git checkout -b feat/x-{a,b}', UNCLEAR],

  // A line that is not a command in bash must not hide the commands after it.
  ["echo hi # it's\ngit push", GIT_PUSH],
  ['echo $((1 << 2))\ngit push', GIT_PUSH],
  ['(( x = 1 << 2 ))\ngit push', GIT_PUSH],
  ['for ((i=0; i<(1<<2); i++)); do :; done\ngit push', GIT_PUSH],
  ['echo $[1 << 2]\ngit push', GIT_PUSH],
  ["echo $'\\'' ; git push", GIT_PUSH],
  // bash 5 reads the ' as a quote here and older bash does not, so the guard will not guess.
  ['echo "${x:-\'}" ; git push ; echo "\'"', UNCLEAR],
  ['echo "${x:-\'a\'}"', UNCLEAR],
  ['echo "${x:-"a;b"}" ; git push', GIT_PUSH],
  ['echo "$(case x in a) echo hi;; esac; git push)"', GIT_PUSH],
  ["echo 'a'; git push; echo 'b'", GIT_PUSH],
  ['echo \'"\'; git push; echo \'"\'', GIT_PUSH],
  ['echo "\'"; git push; echo "\'"', GIT_PUSH],

  // case: patterns are skipped, clause bodies are commands.
  ['case x in a) git push ;; esac', GIT_PUSH],
  ['case x in a) echo ;; *) git push ;; esac', GIT_PUSH],
  ['case x in a) echo; esac; git push', GIT_PUSH],
  ['case x in $(ssh h)) echo ;; esac', SSH],
  ['case x in a) case y in b) git push ;; esac ;; esac', GIT_PUSH],
  ['echo "$(case x in a) echo hi;; esac)"; git push', GIT_PUSH],

  // ((...)) that is not arithmetic is read by bash in its own way, so the guard will not guess.
  ['((cat <<EOF\ngit push\nEOF\n)\n)', UNCLEAR],
  ['((echo a) && (echo b))', UNCLEAR],
  ['echo $((echo a) )', UNCLEAR],

  // Substitutions are commands wherever they are.
  ['echo "$(echo "$(ssh h)")"', SSH],
  ['echo `echo \\`ssh h\\``', SSH],
  ['diff <(ls) <(ssh h)', SSH],
  ['echo ${x:-$(ssh h)}', SSH],
  ['echo $(( $(ssh h) + 1 ))', SSH],
  ['cat > >(ssh h)', SSH],
  ['echo "${x:-`ssh h`}"', SSH],

  // Heredocs: bodies are data, but substitutions in unquoted bodies run.
  ['cat <<EOF\n$(ssh host)\nEOF', SSH],
  ['cat <<EOF\n`ssh host`\nEOF', SSH],
  ['cat <<EOF\nbody\nEOF\ngit push', GIT_PUSH],
  ['cat <<EOF && git push\nbody\nEOF', GIT_PUSH],
  ['cat <<-EOF\n\tbody\n\tEOF\ngit push', GIT_PUSH],
  ['echo "$(cat <<\'EOF\'\nx\nEOF\n)"; git push', GIT_PUSH],
  ["cat <<'EOF' | sh\ngit push\nEOF", UNCLEAR],
  ['bash <<EOF\ngit push\nEOF', UNCLEAR],
  ["sh <<'EOF'\nssh h\nEOF", UNCLEAR],
  ['bash script.sh <<EOF\nx\nEOF', UNCLEAR],
  ['xargs echo <<EOF\nx\nEOF', UNCLEAR],
  ['at now <<EOF\ngit push\nEOF', UNCLEAR],
  ['sudo bash <<EOF\nx\nEOF', UNCLEAR],
  ['bash <<< "git push"', UNCLEAR],
  ['. /dev/stdin <<EOF\ngit push\nEOF', UNCLEAR],

  // The operand of sh -c is read again by the inner shell, so quotes and escapes in it still hide nothing.
  ['bash -c "s\\sh"', SSH],
  ['sh -c "\'ssh\'"', SSH],
  ["bash -c 'ss\"\"h'", SSH],
  ['bash -c ssh', SSH],
  ['bash -c "git"', UNCLEAR],

  // for ((...)) may be followed by do with no separator.
  ['for ((i=0; i<2; i++)) do git push; done', GIT_PUSH],
  ['for ((i=0; i<2; i++)) do ssh h; done', SSH],

  // eval re-parses its expanded arguments.
  ['eval "echo $X"', UNCLEAR],
  ['eval echo *', UNCLEAR],
];

describe('deployDenyReason', () => {
  it.each(ALLOWED)('allows %s', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });

  it.each(DENIED)('denies %s', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
  });

  it.each(ALLOWED_3)('round 3 allows %j', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });

  it.each(DENIED_3)('round 3 denies %j', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
  });

  it('fails closed on pathological nesting instead of throwing', () => {
    expect(deployDenyReason('$('.repeat(2500))).toBe(UNCLEAR);
    expect(deployDenyReason('$(('.repeat(2500))).toBe(UNCLEAR);
    expect(deployDenyReason('`'.repeat(2501))).toBe(UNCLEAR);
    expect(deployDenyReason(`echo ${'$(echo '.repeat(40)}x${')'.repeat(40)}`)).toBe(UNCLEAR);
    expect(deployDenyReason(`${'eval '.repeat(40)}ls`)).toBe(UNCLEAR);
    expect(deployDenyReason(`echo ${'$(echo '.repeat(5)}x${')'.repeat(5)}`)).toBeNull();
    expect(deployDenyReason(`${'eval '.repeat(3)}ls`)).toBeNull();
    expect(deployDenyReason(`${'('.repeat(5000)}ls${')'.repeat(5000)}`)).toBeNull();
    expect(deployDenyReason(`${'(('.repeat(5000)}ls`)).toBe(UNCLEAR);
  });

  it('fails closed on input it cannot finish reading', () => {
    expect(deployDenyReason('echo "unterminated')).toBe(UNCLEAR);
    expect(deployDenyReason("echo 'unterminated")).toBe(UNCLEAR);
    expect(deployDenyReason('echo `unterminated')).toBe(UNCLEAR);
    expect(deployDenyReason('echo $(unterminated')).toBe(UNCLEAR);
    expect(deployDenyReason('echo ${unterminated')).toBe(UNCLEAR);
  });

  it('reads long commands in linear time', () => {
    expect(deployDenyReason('echo a '.repeat(50_000))).toBeNull();
    expect(deployDenyReason(`echo "${'x'.repeat(500_000)}"`)).toBeNull();
    expect(deployDenyReason(`${'echo a;'.repeat(20_000)} git push`)).toBe(GIT_PUSH);
  });

  it('push reason is exact', () => {
    expect(deployDenyReason('git push')).toBe('git push is done by the Hub after its checks pass.');
  });

  it('names the denied program', () => {
    expect(deployDenyReason('/usr/bin/docker run x')).toBe(
      'Deploying is a Hub action; docker is not allowed in Build.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 4 (re-review N1-N13): fail closed on the constructs below (Ruling 14).
// ---------------------------------------------------------------------------------------------

/** The re-review's repros, one per row, with the exact reason the guard must give. */
const DENIED_4: Array<[string, string]> = [
  // N1 heredoc + multi-line substitution: the substitution body is still commands.
  ['cat <<EOF $(echo hi\nssh h\nEOF\n)\nEOF', SSH],

  // N2 case/for state machine.
  ['for case in a; do ssh h; done', SSH],
  ['>/dev/null case x in ; ssh h', SSH],
  ['>f case x; for i in a; do ssh h; done', SSH],
  ['select case in a; do git push; break; done', GIT_PUSH],

  // N3 {name}> / {name}< variable-fd redirections are redirections, not the program word.
  ['{fd}>/dev/null ssh h', SSH],
  ['env {fd}>/dev/null ssh h', SSH],
  ['X=1 {fd}>f git push', GIT_PUSH],
  ['exec {fd}>/dev/null; ssh h', SSH],

  // N4 a command word starting with NAME[ fails closed.
  ['a[x y]=1 ssh h', UNCLEAR],
  ['a[x;y]=1 git push', UNCLEAR],
  ['a[(]=1 ssh h', UNCLEAR],
  ['FOO=1 a[x y]=1 ssh h', UNCLEAR],

  // N5 env skips every word that contains '='; -S / --split-string stay unclear.
  ['env X}=1 git push', GIT_PUSH],
  ['env a-b=1 ssh h', SSH],
  ["env 'a b=1' ssh h", SSH],
  ['env =x git push', GIT_PUSH],
  ['xargs env a-b=1 ssh', SSH],
  ['env -S "git push"', UNCLEAR],
  ['env --split-string="git push"', UNCLEAR],

  // N6 '#' is not a comment inside [[ ]].
  ['[[ x =~ (a #) ]]; ssh h', UNCLEAR],
  ['[[ x =~ (#) ]]; git push', UNCLEAR],

  // N7 extglob.
  ['shopt -s extglob\ngit @(push)', UNCLEAR],
  ["bash -O extglob -c '@(g)it push'", UNCLEAR],
  ['shopt -s extglob', UNCLEAR],

  // N8 dynamic git config keys.
  ['K=alias.p; git -c "$K=push" p', UNCLEAR],
  ['git -c "ali$E.p=push" p', UNCLEAR],
  ['git config "$K" push', UNCLEAR],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=ali$E.p GIT_CONFIG_VALUE_0=push git p', UNCLEAR],

  // N9 data evaluated as code.
  ["declare 'a[$(ssh h)]=1'", UNCLEAR],
  ["printf -v 'a[$(ssh h)]' x", UNCLEAR],
  ["read 'a[$(ssh h)]' <<< 1", UNCLEAR],
  ["[[ -v 'a[$(ssh h)]' ]]", UNCLEAR],
  ["test -v 'a[$(ssh h)]'", UNCLEAR],
  ["[ 'a[$(ssh h)]' -eq 1 ]", UNCLEAR],
  ["compgen -C 'ssh h'", UNCLEAR],
  ['mapfile -C ssh -c 1 a <<< x', UNCLEAR],
  ["x='$(ssh h)'; echo ${x@P}", UNCLEAR],
  ["PS4='$(ssh h) '; set -x; echo hi", UNCLEAR],
  ["x='a[$(ssh h)]'; (( x ))", UNCLEAR],
  ['let x', UNCLEAR],
  ['echo $((x))', UNCLEAR],
  ['(( x ))', UNCLEAR],
  ['echo ${!x}', UNCLEAR],
  ['BASH_ENV=/dev/stdin bash -c : <<< x', UNCLEAR],

  // N10 stdin scripts.
  ["bash /dev/stdin <<< 'ssh h'", UNCLEAR],
  ['sh /dev/fd/0 <<< x', UNCLEAR],
  ['. /dev//stdin <<< x', UNCLEAR],
  ['source /dev/../dev/stdin <<< x', UNCLEAR],
  ["echo 'ssh h' | bash /dev/stdin", UNCLEAR],

  // N11 xargs with stdin-supplied arguments.
  ['echo https://api.hetzner.cloud/v1/servers | xargs curl', UNCLEAR],
  ["printf '%s\\n' -exec ssh h ';' | xargs find .", UNCLEAR],
  ['echo ssh h | xargs xargs', UNCLEAR],

  // N12 git dashed builtins.
  ['/usr/lib/git-core/git-push origin HEAD', GIT_PUSH],
  ['PATH=/usr/lib/git-core:$PATH git-push origin HEAD', GIT_PUSH],

  // N13 wrappers.
  ['prlimit --nofile=100 git push', UNCLEAR],
  ['setarch x86_64 git push', UNCLEAR],
  ['linux64 git push', UNCLEAR],
  ['chrt -o 0 git push', UNCLEAR],
  ['dbus-run-session -- git push', UNCLEAR],
];

/** The minor: git/gh version and help, and bare git, must stay allowed. */
const ALLOWED_4: string[] = [
  'git --version',
  'git --help',
  'git',
  'gh --version',
  'gh --help',
  'gh',
  // Arithmetic that is a real expression, not a bare re-evaluated name, stays allowed.
  'echo $((1 + 2))',
  'echo $(( $i + 1 ))',
  'x=$(( 1 << 2 )); echo $x',
  // env with a normal assignment still finds the program.
  'env NODE_ENV=test pnpm test',
  // ${!arr[@]} is array keys, not indirect bare-name expansion.
  'echo "${!arr[@]}"',
];

describe('deployDenyReason fix round 4', () => {
  it.each(DENIED_4)('denies %j', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
  });

  it.each(ALLOWED_4)('allows %j', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 5 (round-4 re-review): narrow the data-builtin $( rule (Ruling 15), close the N6/N8/N9
// siblings cheaply, and lift the minor false denies the re-review listed.
// ---------------------------------------------------------------------------------------------

/** I1 (Ruling 15): a real substitution the lexer already scans is not a data-builtin bypass. */
const ALLOWED_5_I1: string[] = [
  '[ -z "$(git status --porcelain)" ]',
  'if [ -n "$(git status --porcelain)" ]; then git add -A; fi',
  'test -z "$(git diff --name-only)"',
  '[[ -n $(git status -s) ]] && echo dirty',
  'export VERSION=$(node -p "require(\'./package.json\').version")',
  'export SHA=$(git rev-parse HEAD)',
  "printf '%s\\n' \"$(git rev-parse HEAD)\"",
  'local x=$(pwd)',
  '[[ $(uname) == Linux ]] && echo linux',
  '[[ "$(git branch --show-current)" == build/* ]] && echo onbranch',
  '[ "$(id -u)" = 0 ] && echo root',
  '[ "$(uname)" = Linux ]',
];

/** The minor false denies the re-review listed: all now allowed. */
const ALLOWED_5: string[] = [
  // M1: ENV=/PS4=/BASH_ENV= only matters as an assignment, not as plain text.
  'echo "ENV=prod" >> .env',
  'grep ENV= .env',
  'git commit -m "ENV=prod config"',
  'echo "PS4=x"',
  // M2: parameter expansions and simple subscripts in arithmetic.
  'echo $((${#arr[@]} - 1))',
  'for ((i=0;i<${#a[@]};i++)); do :; done',
  'echo $(( arr[0] + 1 ))',
  // M3: a dynamic value after a literal -c key, and -c as a subcommand option.
  'git -c user.name="$NAME" commit -m m',
  'git commit -c "$SHA"',
  'git show -c "$SHA"',
  // M4: git-<x> runs the normal git rules, so a non-pushing subcommand is allowed.
  'git-lfs status',
  'git-crypt status',
  // M5: a here-string that does not feed a program's script input.
  'xargs -n1 echo <<< "a b"',
  "bash -c 'pnpm test' <<< x",
  'source .env <<< x',
  'bash script.sh <<< x',
  // C2: a literal config key after a config subcommand.
  'git config set user.name x',
  'git config get user.name',
  // C3: callback builtins without a C/F callback flag.
  'mapfile -t arr',
  'readarray -t lines',
  'compgen -A function',
];

const DENIED_5: Array<[string, string]> = [
  // C1: a < or << operator inside [[ ]] (N6 sibling) fails closed.
  ['[[ x =~ (a <<E\n) ]]; ssh h', UNCLEAR],
  ["[[ x =~ (a <<'E'\n) ]]; ssh h", UNCLEAR],
  ['[[ x =~ (a <<-E\n) ]]; ssh h', UNCLEAR],
  ['[[ x =~ a(<<E\n) ]]; ssh h', UNCLEAR],
  // C2: a dynamic key after a git config subcommand word.
  ['git config set "$K" push', UNCLEAR],
  // C3: a clustered callback flag.
  ['mapfile -tC id a', UNCLEAR],
  ['compgen -fC id', UNCLEAR],
  ['complete -fF id x', UNCLEAR],
  // C4: a quoted $( inside a ${...} subscript or offset.
  ["echo ${a['$(ssh h)']}", UNCLEAR],
  ["echo ${a['$(ssh h)']:-d}", UNCLEAR],
  ["x=abc; echo ${x:0:'$(ssh h)'}", UNCLEAR],
  ["echo ${@:'$(ssh h)'}", UNCLEAR],
  ["echo ${!a['$(ssh h)']}", UNCLEAR],
  // C5: /proc/thread-self/fd/0 and /proc/<pid>/fd/0 read this process's stdin.
  ['sh /proc/thread-self/fd/0', UNCLEAR],
  ['bash /proc/123/fd/0', UNCLEAR],
  // M1: an assignment to PS4/BASH_ENV/ENV still fails closed.
  ['ENV=x bash -c :', UNCLEAR],
  ['export BASH_ENV=f', UNCLEAR],
  ["PS4='$(ssh h)' bash -x s.sh", UNCLEAR],
  // M2: a bare-name arithmetic operand still fails closed.
  ["x='a[$(ssh h)]'; echo $((x))", UNCLEAR],
  ['(( x ))', UNCLEAR],
  ['let x', UNCLEAR],
  // M3: a dynamic -c key still fails closed.
  ['git -c "$K=push" p', UNCLEAR],
  // M4: git-<x> keeps the push reason.
  ['git-lfs push', GIT_PUSH],
  // M5: a real heredoc into a shell or xargs still fails closed.
  ['bash script.sh <<EOF\nx\nEOF', UNCLEAR],
  ['xargs echo <<EOF\nx\nEOF', UNCLEAR],
];

describe('deployDenyReason fix round 5', () => {
  it.each(ALLOWED_5_I1)('I1 allows %j', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });

  it.each(ALLOWED_5)('allows %j', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });

  it.each(DENIED_5)('denies %j', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
  });
});

// ---------------------------------------------------------------------------------------------
// Plan 3 final wave, lane B: the Ruling 16 carries (one rule each) and the push-config rule.
// ---------------------------------------------------------------------------------------------

const DENIED_FW: Array<[string, string]> = [
  // 1. I-1/R1, R2: a quoted or ANSI-C `$(` hidden in a word whose `expanded` flag is set for another reason.
  ["declare $'a[$(ssh h)]'=1", UNCLEAR],
  ["declare 'a[$(ssh h)]'$E=1", UNCLEAR],
  ["declare $'a[\\x24(ssh h)]'=1", UNCLEAR],
  ["x='$(ssh h)'$E; declare -p x", UNCLEAR],
  // 2. R3: a single-quoted `$(` or backtick inside arithmetic.
  ["echo $(( '$(ssh h)' + 1 ))", UNCLEAR],
  ["(( '`ssh h`' + 1 ))", UNCLEAR],
  // 3. R4: `$'...'` that hides a substitution inside `${...}`.
  ["echo ${a[$'$(ssh h)']}", UNCLEAR],
  ["echo ${a[$'\\x24(ssh h)']}", UNCLEAR],
  // 4. I-2/R5: a shell's rc/init file read from stdin.
  ['bash --rcfile /dev/stdin -ic : <<< x', UNCLEAR],
  ['bash --init-file=- -ic :', UNCLEAR],
  ['bash --rcfile /proc/thread-self/fd/0 -ic :', UNCLEAR],
  ['bash --rcfile "$F" -ic :', UNCLEAR],
  // 5. R7: a dynamic key after --file / -f.
  ['git config --file .git/config "$K" push', UNCLEAR],
  ['git config -f x "$K"', UNCLEAR],
  // 6. R8: push-shaped third-party subcommands, plain and dashed.
  ['git annex sync', GIT_PUSH],
  ['git annex copy --to origin .', GIT_PUSH],
  ['git annex move x --to=r', GIT_PUSH],
  ['git annex push', GIT_PUSH],
  ['git-annex sync', GIT_PUSH],
  ['git lfs push origin main', GIT_PUSH],
  // Final-review I1: config writes that redirect the hub's own push.
  ["git config remote.origin.push 'refs/heads/build/x:refs/heads/main'", GIT_PUSH],
  ['git config --add remote.origin.push x', GIT_PUSH],
  ['git config --file .git/config remote.origin.pushurl x', GIT_PUSH],
  ['git config set remote.origin.url x', GIT_PUSH],
  ['git config url.x.insteadOf y', GIT_PUSH],
  ['git config URL.x.PushInsteadOf y', GIT_PUSH],
  ['git remote set-url origin x', GIT_PUSH],
  ['git remote set-url --push origin x', GIT_PUSH],
];

const ALLOWED_FW: string[] = [
  // Real substitutions and plain ANSI-C strings in data builtins.
  'declare "x=$(pwd)"',
  "declare x=$'line\\n'",
  "echo ${x:-$'\\n'}",
  'echo $(( 1 + 2 ))',
  // A shell rc file that is a real file is the parked script-file class.
  "bash --rcfile .bashrc.test -ic 'echo hi'",
  // Reads, and writes to other keys.
  'git config --get remote.origin.url',
  'git config remote.origin.url',
  'git config get remote.origin.url',
  'git config --list',
  'git config --file .gitmodules submodule.x.path',
  'git config -f x user.name y',
  'git remote -v',
  'git remote get-url origin',
  // Pull-shaped and read-only git-annex.
  'git annex status',
  'git annex get x',
  'git annex copy --from origin x',
  'git-annex info',
];

describe('deployDenyReason final wave B', () => {
  it.each(DENIED_FW)('denies %j', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
  });

  it.each(ALLOWED_FW)('allows %j', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });
});

describe('checkToolUse', () => {
  it('edits stay in the checkout', () => {
    expect(checkToolUse('/repo', 'Write', { file_path: '/repo/src/a.ts' })).toBeNull();
    expect(checkToolUse('/repo', 'Write', { file_path: '/etc/passwd' })).toContain('inside the app checkout');
    expect(checkToolUse('/repo', 'Edit', { file_path: '../other/x' })).toContain('inside the app checkout');
    const notebook = { notebook_path: '/elsewhere/n.ipynb' };
    expect(checkToolUse('/repo', 'NotebookEdit', notebook)).toContain('inside the app checkout');
    expect(checkToolUse('/repo', 'Write', { file_path: '.git/config' })).toBe('Do not edit .git directly.');
    const nested = { file_path: 'src/../.git/HEAD' };
    expect(checkToolUse('/repo', 'Edit', nested)).toBe('Do not edit .git directly.');
  });

  it('MultiEdit is checked the same way as Edit', () => {
    expect(checkToolUse('/repo', 'MultiEdit', { file_path: '/repo/src/a.ts' })).toBeNull();
    const outside = { file_path: '/etc/passwd' };
    expect(checkToolUse('/repo', 'MultiEdit', outside)).toContain('inside the app checkout');
    const git = { file_path: '.git/config' };
    expect(checkToolUse('/repo', 'MultiEdit', git)).toBe('Do not edit .git directly.');
  });

  it('a file whose name starts with two dots is inside the checkout', () => {
    expect(checkToolUse('/repo', 'Write', { file_path: '..notes.md' })).toBeNull();
  });

  it('other tools are checked by their own rules', () => {
    expect(checkToolUse('/repo', 'Read', { file_path: '/etc/hosts' })).toBeNull();
    expect(checkToolUse('/repo', 'Bash', { command: 'git push' })).toBe(GIT_PUSH);
    expect(checkToolUse('/repo', 'Bash', { command: 'pnpm test' })).toBeNull();
  });

  it('any tool with a string command is checked like Bash (Monitor and future tools)', () => {
    expect(checkToolUse('/repo', 'Monitor', { command: 'git push origin HEAD:main' })).toBe(GIT_PUSH);
    expect(checkToolUse('/repo', 'SomeFutureTool', { command: 'git push' })).toBe(GIT_PUSH);
    expect(checkToolUse('/repo', 'Monitor', { command: 'tail -f build.log' })).toBeNull();
    expect(checkToolUse('/repo', 'Monitor', { command: ['git', 'push'] })).toBeNull();
  });

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/settings.backup.json',
    'apps/web/.claude/settings.json',
    '/repo/.claude/settings.local.json',
    '.mcp.json',
    'apps/web/.mcp.json',
  ])('blocks edits to Claude Code settings and MCP config: %s', (file) => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(checkToolUse('/repo', tool, { file_path: file })).toBe(SETTINGS);
    }
    expect(checkToolUse('/repo', 'NotebookEdit', { notebook_path: file })).toBe(SETTINGS);
  });

  it.each(['.claude/commands/ship.md', '.claude/agents/a.md', 'src/settings.json', 'mcp.json', 'docs/.mcp.json.md'])(
    'other files near them stay editable: %s',
    (file) => {
      expect(checkToolUse('/repo', 'Write', { file_path: file })).toBeNull();
    },
  );
});
