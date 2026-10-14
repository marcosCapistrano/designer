import { describe, expect, it } from 'vitest';
import { checkToolUse, deployDenyReason } from './guard.js';

const GIT_PUSH = 'git push is done by the Hub after its checks pass.';
const DOCKER = 'Deploying is a Hub action; docker is not allowed in Build.';
const SSH = 'Deploying is a Hub action; ssh is not allowed in Build.';
const UNCLEAR = 'Build cannot tell which program this runs; name the program directly.';

describe('deployDenyReason', () => {
  it('allows ordinary work', () => {
    const commands = [
      'pnpm test',
      'pnpm -F @hub/server test',
      'npm run build',
      'git status',
      'git commit -m "push the button"',
      'git checkout -b feature',
      'git checkout -b mainline',
      'git checkout -- src/a.ts',
      'grep -r docker .',
      'cat Dockerfile',
      'echo ssh is fine',
      'timeout 60 pnpm test',
      'env -i FOO=1 pnpm test',
      'nice -n 5 pnpm test',
      'time pnpm test',
      'nohup pnpm dev',
      'xargs -I {} echo {}',
      '[ -f package.json ] && pnpm test',
      '{ git status; }',
    ];
    for (const command of commands) {
      expect(deployDenyReason(command), command).toBeNull();
    }
  });

  it('denies composed and path-qualified deploy commands', () => {
    const commands = [
      'git push',
      'git push origin build/x',
      'cd web && git push',
      'git -C web push',
      '/usr/bin/git push',
      'FOO=1 git push',
      'sudo docker compose up',
      'bash -c "ssh deploy@1.2.3.4"',
      'echo hi; scp a b:/c',
      'x=$(ssh host)',
      'gh pr merge 3',
      'pnpm publish',
      'npm run deploy:prod',
      'curl -X POST https://api.hetzner.cloud/v1/servers',
      'git switch main',
      'git checkout master',
    ];
    for (const command of commands) {
      expect(deployDenyReason(command), command).not.toBeNull();
    }
  });

  it('push reason is exact', () => {
    expect(deployDenyReason('git push')).toBe(GIT_PUSH);
  });

  it('names the denied program', () => {
    expect(deployDenyReason('/usr/bin/docker run x')).toBe(DOCKER);
  });

  it('denies bypass shapes beyond the listed examples', () => {
    const commands = [
      'git --git-dir .git push',
      'git push>log.txt',
      'env -i ssh host',
      'sudo -E docker ps',
      '\\git push',
      '(git push)',
      'cat <(ssh host)',
      'if true; then git push; fi',
      'gh -R owner/repo pr merge 1',
      'pnpm -F web run deploy',
      'HCLOUD_TOKEN=x hcloud server create',
      'echo `ssh host`',
    ];
    for (const command of commands) {
      expect(deployDenyReason(command), command).not.toBeNull();
    }
  });

  it('sees through wrapper commands and their options', () => {
    const commands = [
      'sudo -u root docker ps',
      'timeout 60 git push',
      'timeout -s KILL 60 git push',
      'timeout -s9 60 git push',
      'env -i FOO=1 git push',
      'nice -n 5 nohup ssh host',
      'nice -n5 nohup ssh host',
      'xargs git push < x',
      'stdbuf -oL ssh host',
      'ionice -c 3 scp a b:/c',
      'time -p rsync a b:/c',
      'doas -u root kubectl apply -f x',
      'command -- git push',
      'exec -a x docker ps',
      'setsid -w ssh host',
    ];
    for (const command of commands) {
      expect(deployDenyReason(command), command).not.toBeNull();
    }
    expect(deployDenyReason('sudo -u root docker ps')).toBe(DOCKER);
    expect(deployDenyReason('timeout 60 git push')).toBe(GIT_PUSH);
    expect(deployDenyReason('env -i FOO=1 git push')).toBe(GIT_PUSH);
    expect(deployDenyReason('nice -n 5 nohup ssh host')).toBe(SSH);
    expect(deployDenyReason('xargs git push < x')).toBe(GIT_PUSH);
  });

  it('sees through quoting and backslash escapes in program names', () => {
    expect(deployDenyReason('g"it" push')).toBe(GIT_PUSH);
    expect(deployDenyReason("'git' push")).toBe(GIT_PUSH);
    expect(deployDenyReason('gi\\t push')).toBe(GIT_PUSH);
    expect(deployDenyReason('"/usr/bin/docker" ps')).toBe(DOCKER);
  });

  it('reads quoted assignment values and quoted command strings whole', () => {
    expect(deployDenyReason('FOO="x y" git push')).toBe(GIT_PUSH);
    expect(deployDenyReason('eval "git push"')).toBe(GIT_PUSH);
    expect(deployDenyReason('bash -c "ssh deploy@1.2.3.4"')).toBe(SSH);
  });

  it('fails closed when the program cannot be named', () => {
    expect(deployDenyReason('sudo --bogus docker ps')).toBe(UNCLEAR);
    expect(deployDenyReason('$GIT push')).toBe(UNCLEAR);
    expect(deployDenyReason('g?t push')).toBe(UNCLEAR);
    expect(deployDenyReason("$'git' push")).toBe(UNCLEAR);
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
