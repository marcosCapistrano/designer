import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authConfig, gitEnv, openRepo } from './git.js';
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
      `GIT_CONFIG_PARAMETERS:'http.https://github.com/.extraheader=AUTHORIZATION: basic ${base64}'`,
    );
  });

  it('remote url is the configured one', async () => {
    const { work } = newRepo();
    expect(await openRepo(work, { identity: TEST_IDENTITY }).remoteUrl()).toBe(TEST_REMOTE);
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
