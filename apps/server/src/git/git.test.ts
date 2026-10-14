import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authConfig, authedEnv, configParameters, gitEnv, openRepo } from './git.js';
import { TEST_IDENTITY, TEST_REMOTE, git, makeTestRepo, type TestRepo } from './test-repo.js';

const created: TestRepo[] = [];

function newRepo(): TestRepo {
  const repo = makeTestRepo();
  created.push(repo);
  return repo;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const repo of created.splice(0)) {
    rmSync(dirname(repo.origin), { recursive: true, force: true });
  }
});

describe('openRepo', () => {
  it('knows the default and current branch', async () => {
    const { work } = newRepo();
    const repo = openRepo(work, { identity: TEST_IDENTITY });
    expect(await repo.defaultBranch()).toBe('main');
    expect(await repo.currentBranch()).toBe('main');
  });

  it('creates a branch from origin', async () => {
    const { work } = newRepo();
    const repo = openRepo(work, { identity: TEST_IDENTITY });
    await repo.createBranchFrom('build/x-1', 'main');
    expect(await repo.currentBranch()).toBe('build/x-1');
  });

  it('commitAll commits everything or returns null', async () => {
    const { work } = newRepo();
    const repo = openRepo(work, { identity: TEST_IDENTITY });
    expect(await repo.commitAll('nothing to do')).toBeNull();

    writeFileSync(join(work, 'a.txt'), 'a\n');
    expect(await repo.isDirty()).toBe(true);
    const sha = await repo.commitAll('add a');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).toBe(await repo.headSha());
    expect(await repo.isDirty()).toBe(false);
    expect(await repo.commitsAhead('main')).toBe(1);
  });

  it('push publishes the branch', async () => {
    const { origin, work } = newRepo();
    const repo = openRepo(work, { identity: TEST_IDENTITY });
    await repo.createBranchFrom('build/x-1', 'main');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    await repo.commitAll('add b');
    await repo.push('build/x-1');
    expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(await repo.headSha());
  });

  it('token never lands in git config', async () => {
    const { work } = newRepo();
    const plain = openRepo(work, { identity: TEST_IDENTITY });
    await plain.createBranchFrom('build/x-1', 'main');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    await plain.commitAll('add b');

    await openRepo(work, { token: 'secret-token', identity: TEST_IDENTITY }).push('build/x-1');

    const config = readFileSync(join(work, '.git', 'config'), 'utf8');
    expect(config).not.toContain('secret-token');
    expect(config).not.toContain(Buffer.from('x-access-token:secret-token').toString('base64'));
  });

  it('keeps the token out of git argv and passes the header through the environment', async () => {
    const { origin, work } = newRepo();
    const root = dirname(origin);
    const token = 'secret-token';
    const base64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

    // A git wrapper first on PATH: logs each invocation's argv and GIT_CONFIG_PARAMETERS, then runs the real git.
    const bin = join(root, 'bin');
    const log = join(root, 'git-calls.log');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        '{',
        "  printf 'argv:'",
        '  for a in "$@"; do printf " [%s]" "$a"; done',
        '  printf "\\n"',
        '  printf "GIT_CONFIG_PARAMETERS:%s\\n" "$GIT_CONFIG_PARAMETERS"',
        `} >> '${log}'`,
        `exec '${realGit}' "$@"`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);

    await openRepo(work, { token, identity: TEST_IDENTITY }).fetch();

    const lines = readFileSync(log, 'utf8').split('\n');
    const argvLines = lines.filter((line) => line.startsWith('argv:'));
    const envLines = lines.filter((line) => line.startsWith('GIT_CONFIG_PARAMETERS:'));
    expect(argvLines.some((line) => line.includes('[fetch]'))).toBe(true);
    for (const line of argvLines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(base64);
    }
    expect(envLines).toContain(
      `GIT_CONFIG_PARAMETERS:'core.hooksPath=/dev/null' 'http.https://github.com/.extraheader=AUTHORIZATION: basic ${base64}'`,
    );
  });

  describe('push', () => {
    /** A repo on build/x-1 with one commit ahead of main, and a way to add another commit. */
    async function branchWithCommit() {
      const fixture = newRepo();
      const repo = openRepo(fixture.work, { identity: TEST_IDENTITY });
      await repo.createBranchFrom('build/x-1', 'main');
      writeFileSync(join(fixture.work, 'b.txt'), 'b\n');
      await repo.commitAll('add b');
      return { ...fixture, repo };
    }

    it('pins the refspec: a remote.origin.push written into .git/config cannot redirect it', async () => {
      const { origin, work, repo } = await branchWithCommit();
      const mainBefore = git(origin, 'rev-parse', 'refs/heads/main');
      git(work, 'config', 'remote.origin.push', 'refs/heads/build/x-1:refs/heads/main');

      await repo.push('build/x-1');

      expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
      expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(await repo.headSha());
    });

    it('pins the refspec against push.default and a wildcard remote.origin.push too', async () => {
      const { origin, work, repo } = await branchWithCommit();
      const mainBefore = git(origin, 'rev-parse', 'refs/heads/main');
      git(work, 'config', 'push.default', 'matching');
      git(work, 'config', '--add', 'remote.origin.push', 'HEAD:refs/heads/main');
      git(work, 'config', '--add', 'remote.origin.push', 'refs/heads/*:refs/heads/*');

      await repo.push('build/x-1');

      expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
      expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(await repo.headSha());
    });

    it('does not run a pre-push hook from the checkout', async () => {
      const { work, repo } = await branchWithCommit();
      const marker = join(work, 'pre-push-ran');
      const hook = join(work, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
      chmodSync(hook, 0o755);

      await repo.push('build/x-1');

      expect(existsSync(marker)).toBe(false);
    });

    it('control: git itself runs that hook, so the test above proves something', async () => {
      const { origin, work } = await branchWithCommit();
      const marker = join(work, 'pre-push-ran');
      const hook = join(work, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
      chmodSync(hook, 0o755);

      git(work, 'push', origin, 'build/x-1');

      expect(existsSync(marker)).toBe(true);
    });

    it('a plain push refuses to rewrite a pushed branch', async () => {
      const { work, repo } = await branchWithCommit();
      await repo.push('build/x-1');
      git(work, 'commit', '--amend', '-m', 'add b, amended');

      await expect(repo.push('build/x-1')).rejects.toThrow();
    });

    it('with a lease on the pushed head, an amended branch can be pushed again', async () => {
      const { origin, work, repo } = await branchWithCommit();
      await repo.push('build/x-1');
      const pushed = await repo.headSha();
      git(work, 'commit', '--amend', '-m', 'add b, amended');

      await repo.push('build/x-1', { leaseSha: pushed });

      expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(await repo.headSha());
      expect(await repo.headSha()).not.toBe(pushed);
    });

    it('a lease fails when someone else moved the branch since the pushed head', async () => {
      const { origin, work, repo } = await branchWithCommit();
      await repo.push('build/x-1');
      const pushed = await repo.headSha();
      // Someone else pushes to build/x-1 from another clone.
      const other = join(dirname(origin), 'other');
      git(dirname(origin), 'clone', '-b', 'build/x-1', origin, other);
      writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'their change');
      git(other, 'push', 'origin', 'build/x-1');
      const theirs = git(origin, 'rev-parse', 'refs/heads/build/x-1');
      git(work, 'commit', '--amend', '-m', 'add b, amended');

      await expect(repo.push('build/x-1', { leaseSha: pushed })).rejects.toThrow(/stale info|rejected/);

      expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(theirs);
    });

    it('a lease never touches another branch', async () => {
      const { origin, work, repo } = await branchWithCommit();
      await repo.push('build/x-1');
      const pushed = await repo.headSha();
      const mainBefore = git(origin, 'rev-parse', 'refs/heads/main');
      git(work, 'config', 'remote.origin.push', 'refs/heads/build/x-1:refs/heads/main');
      git(work, 'commit', '--amend', '-m', 'add b, amended');

      await repo.push('build/x-1', { leaseSha: pushed });

      expect(git(origin, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
      expect(git(origin, 'rev-parse', 'refs/heads/build/x-1')).toBe(await repo.headSha());
    });

    it('rejects a lease that is not a commit id, and a branch that looks like an option', async () => {
      const { repo } = await branchWithCommit();

      await expect(repo.push('build/x-1', { leaseSha: 'head-1' })).rejects.toThrow(/Invalid lease/);
      await expect(repo.push('build/x-1', { leaseSha: '--delete' })).rejects.toThrow(/Invalid lease/);
      await expect(repo.push('--delete')).rejects.toThrow(/Invalid branch name/);
      await expect(repo.checkout('-f')).rejects.toThrow(/Invalid branch name/);
      await expect(repo.createBranchFrom('-f', 'main')).rejects.toThrow(/Invalid branch name/);
    });
  });

  it('fetch does not run a reference-transaction hook from the checkout', async () => {
    const { origin, work } = newRepo();
    // origin/main moves, so the fetch updates a ref and would trigger the hook.
    const other = join(dirname(origin), 'other');
    git(dirname(origin), 'clone', origin, other);
    writeFileSync(join(other, 'new.txt'), 'new\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'new');
    git(other, 'push', 'origin', 'main');
    const marker = join(work, 'hook-ran');
    const hook = join(work, '.git', 'hooks', 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(hook, 0o755);

    await openRepo(work, { token: 'secret-token', identity: TEST_IDENTITY }).fetch();

    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(origin, 'rev-parse', 'refs/heads/main'));
    expect(existsSync(marker)).toBe(false);
  });

  describe('defaultBranch', () => {
    it('reads the local origin/HEAD', async () => {
      const { work } = newRepo();
      expect(await openRepo(work, { identity: TEST_IDENTITY }).defaultBranch()).toBe('main');
    });

    it('asks origin when origin/HEAD is not set, instead of guessing main', async () => {
      const { origin, work } = newRepo();
      // origin's real default branch is trunk, and the clone has no origin/HEAD.
      git(origin, 'branch', 'trunk', 'main');
      git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
      git(work, 'remote', 'set-head', 'origin', '-d');
      git(work, 'fetch', 'origin');

      expect(await openRepo(work, { identity: TEST_IDENTITY }).defaultBranch()).toBe('trunk');
    });

    it('throws when origin/HEAD is not set and origin cannot be asked', async () => {
      const { origin, work } = newRepo();
      git(work, 'remote', 'set-head', 'origin', '-d');
      git(work, 'remote', 'set-url', 'origin', join(dirname(origin), 'gone.git'));

      await expect(openRepo(work, { identity: TEST_IDENTITY }).defaultBranch()).rejects.toThrow();
    });
  });

  it('isDirty sees untracked files even when .git/config hides them', async () => {
    const { work } = newRepo();
    git(work, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(work, 'left-over.txt'), 'x\n');

    const repo = openRepo(work, { identity: TEST_IDENTITY });

    expect(await repo.isDirty()).toBe(true);
    expect(await repo.commitAll('keep it')).toMatch(/^[0-9a-f]{40}$/);
    expect(git(work, 'ls-files', 'left-over.txt')).toBe('left-over.txt');
  });

  it('checkout and commitsAhead treat the branch as a branch even when a file has its name', async () => {
    const { work } = newRepo();
    const repo = openRepo(work, { identity: TEST_IDENTITY });
    await repo.createBranchFrom('build/x-1', 'main');
    await repo.checkout('main');
    mkdirSync(join(work, 'build'));
    writeFileSync(join(work, 'build', 'x-1'), 'a file named like the branch\n');

    await repo.checkout('build/x-1');

    expect(await repo.currentBranch()).toBe('build/x-1');
    expect(await repo.commitsAhead('main')).toBe(0);
  });

  it('remote url is null when there is no origin', async () => {
    const { work } = newRepo();
    git(work, 'remote', 'remove', 'origin');
    expect(await openRepo(work, { identity: TEST_IDENTITY }).remoteUrl()).toBeNull();
  });

  it('remote url is the configured one', async () => {
    const { work } = newRepo();
    expect(await openRepo(work, { identity: TEST_IDENTITY }).remoteUrl()).toBe(TEST_REMOTE);
  });
});

describe('configParameters', () => {
  /** Reads a key back through git itself, with the entries handed over as GIT_CONFIG_PARAMETERS. */
  function readBack(dir: string, entries: string[], key: string): string[] {
    const out = execFileSync('git', ['config', '--get-all', key], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_PARAMETERS: configParameters(entries) },
    });
    return out.split('\n').filter((line) => line !== '');
  }

  it('round-trips values with quotes, spaces and equals signs through git', () => {
    const { work } = newRepo();
    const value = `it's a "value" with = and spaces`;
    expect(readBack(work, [`test.one=${value}`, 'test.two=plain'], 'test.one')).toEqual([value]);
    expect(readBack(work, [`test.one=${value}`, 'test.two=plain'], 'test.two')).toEqual(['plain']);
  });

  it('carries the auth header and the hooks switch together', () => {
    const { work } = newRepo();
    const env = authedEnv(gitEnv(), 'tok');
    const header = `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`;
    const read = (key: string): string =>
      execFileSync('git', ['config', '--get', key], {
        cwd: work,
        encoding: 'utf8',
        env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' },
      }).trim();
    expect(read('http.https://github.com/.extraheader')).toBe(header);
    expect(read('core.hooksPath')).toBe('/dev/null');
  });

  it('turns hooks off even without a token', () => {
    expect(authedEnv(gitEnv(), null).GIT_CONFIG_PARAMETERS).toBe("'core.hooksPath=/dev/null'");
  });
});

describe('authConfig', () => {
  it('builds the basic auth extraheader from the token', () => {
    expect(authConfig('t')).toEqual([
      'http.https://github.com/.extraheader=AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==',
    ]);
    expect(authConfig(null)).toEqual([]);
  });
});

describe('gitEnv', () => {
  it('is minimal', () => {
    vi.stubEnv('PAGER', 'less');
    vi.stubEnv('GITHUB_TOKEN', 'g');
    expect(Object.keys(gitEnv()).sort()).toEqual(['GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
  });
});
