import { describe, expect, it } from 'vitest';
import { checkToolUse, deployDenyReason } from './guard.js';

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
    expect(deployDenyReason('git push')).toBe('git push is done by the Hub after its checks pass.');
  });

  it('names the denied program', () => {
    expect(deployDenyReason('/usr/bin/docker run x')).toBe(
      'Deploying is a Hub action; docker is not allowed in Build.',
    );
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
    ];
    for (const command of commands) {
      expect(deployDenyReason(command), command).not.toBeNull();
    }
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

  it('a file whose name starts with two dots is inside the checkout', () => {
    expect(checkToolUse('/repo', 'Write', { file_path: '..notes.md' })).toBeNull();
  });

  it('other tools are checked by their own rules', () => {
    expect(checkToolUse('/repo', 'Read', { file_path: '/etc/hosts' })).toBeNull();
    expect(checkToolUse('/repo', 'Bash', { command: 'git push' })).toBe(
      'git push is done by the Hub after its checks pass.',
    );
    expect(checkToolUse('/repo', 'Bash', { command: 'pnpm test' })).toBeNull();
  });
});
