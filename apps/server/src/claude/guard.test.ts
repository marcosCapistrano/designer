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

describe('deployDenyReason', () => {
  it.each(ALLOWED)('allows %s', (command) => {
    expect(deployDenyReason(command)).toBeNull();
  });

  it.each(DENIED)('denies %s', (command, reason) => {
    expect(deployDenyReason(command)).toBe(reason);
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
});
