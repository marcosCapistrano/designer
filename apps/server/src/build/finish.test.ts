import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildTask, ServerMsg } from '@hub/protocol';
import type { AppManifest } from '@hub/protocol/manifest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClaudeRunner, type FakeStep } from '../claude/fake.js';
import { type Db, openDb } from '../db.js';
import { openRepo } from '../git/git.js';
import { git, makeTestRepo, TEST_IDENTITY } from '../git/test-repo.js';
import { FakeGitHub } from '../github/fake.js';
import type { CommandResult, RunCommand } from './commands.js';
import type { BuildDeps } from './deps.js';
import { finishTask, MAX_FIX_ATTEMPTS } from './finish.js';
import { BuildStore } from './store.js';

const OK: CommandResult = { ok: true, code: 0, output: '', timedOut: false, aborted: false };

function failed(output = 'boom'): CommandResult {
  return { ok: false, code: 1, output, timedOut: false, aborted: false };
}

/**
 * A fake RunCommand. `decide(cmd, call)` answers the n-th call (1-based) of each command;
 * every command run is recorded.
 */
function commandRunner(decide: (cmd: string, call: number) => CommandResult = () => OK) {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const run: RunCommand = async (cmd) => {
    calls.push(cmd);
    const call = (counts.get(cmd) ?? 0) + 1;
    counts.set(cmd, call);
    return decide(cmd, call);
  };
  return { run, calls };
}

const manifest: AppManifest = {
  name: 'demo-app',
  template: 'base@1',
  design: { dir: 'design', routes: 'routes.json', devices: ['desktop'] },
  build: { install: 'i', typecheck: 'tc', test: 'pnpm test' },
  deploy: {
    image: 'ghcr.io/owner/demo-app',
    staging: { server: 'staging', url: 'https://staging.example.com' },
    production: { server: 'prod', url: 'https://example.com', domain: null },
  },
};

let t = 1000;
const opened: Db[] = [];
const roots: string[] = [];

beforeEach(() => {
  t = 1000;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  deps: BuildDeps;
  store: BuildStore;
  github: FakeGitHub;
  runner: FakeClaudeRunner;
  hub: { sent: ServerMsg[] };
  commands: string[];
  origin: string;
  work: string;
  task: BuildTask;
}

/** A demo checkout on build/notes-1 with one user request, a fake runner and a fake GitHub. */
function setup(
  opts: {
    scripts?: FakeStep[][];
    decide?: (cmd: string, call: number) => CommandResult;
    command?: RunCommand;
    noGitHub?: boolean;
  } = {},
): Harness {
  const { origin, work } = makeTestRepo();
  roots.push(dirname(origin));
  git(work, 'checkout', '-b', 'build/notes-1');

  const db = openDb(':memory:');
  opened.push(db);
  const store = new BuildStore(db, () => t);
  const task = store.createTask({ app: 'demo', title: 'Add notes', branch: 'build/notes-1', base: 'main' });
  store.addMessage({ app: 'demo', taskId: task.id, kind: 'user', text: 'add notes' });

  const hub = {
    sent: [] as ServerMsg[],
    broadcast(m: ServerMsg): void {
      this.sent.push(m);
    },
  };
  const runner = new FakeClaudeRunner(opts.scripts ?? [[{ type: 'done', sessionId: 's', ok: true }]]);
  const commands = commandRunner(opts.decide);
  const github = new FakeGitHub();
  const deps: BuildDeps = {
    store,
    runner,
    hub,
    registry: { get: async () => null },
    openRepo: (dir) => openRepo(dir, { identity: TEST_IDENTITY }),
    github: opts.noGitHub ? null : github,
    runCommand: opts.command ?? commands.run,
    now: () => t,
  };
  return { deps, store, github, runner, hub, commands: commands.calls, origin, work, task };
}

function finish(h: Harness, task: BuildTask): Promise<BuildTask> {
  return finishTask(h.deps, { task, dir: h.work, manifest, signal: new AbortController().signal });
}

function texts(store: BuildStore): string[] {
  return store.messages('demo').map((m) => m.text);
}

function writeNotes(work: string): void {
  writeFileSync(join(work, 'notes.md'), 'notes\n');
}

function remoteHasBranch(origin: string, branch: string): boolean {
  try {
    git(origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/** Wraps the checkout so a test can see every commit and push the finish step makes. */
function recordGitWrites(
  deps: BuildDeps,
  opts: { rejectPush?: string } = {},
): { deps: BuildDeps; commits: string[]; pushes: string[] } {
  const commits: string[] = [];
  const pushes: string[] = [];
  const wrapped: BuildDeps['openRepo'] = (dir) => {
    const repo = deps.openRepo(dir);
    return {
      ...repo,
      async commitAll(message) {
        commits.push(message);
        return repo.commitAll(message);
      },
      async push(branch) {
        pushes.push(branch);
        if (opts.rejectPush !== undefined) throw new Error(opts.rejectPush);
        return repo.push(branch);
      },
    };
  };
  return { deps: { ...deps, openRepo: wrapped }, commits, pushes };
}

/** Finishes the checkout with git writes recorded. */
async function finishRecorded(h: Harness, task: BuildTask, signal = new AbortController().signal) {
  const { deps, commits, pushes } = recordGitWrites(h.deps);
  const result = await finishTask(deps, { task, dir: h.work, manifest, signal });
  return { result, commits, pushes };
}

describe('finishTask', () => {
  it('pushes and opens a PR when checks pass', async () => {
    const h = setup();
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(result).toMatchObject({ status: 'review', prNumber: 1, ci: 'pending', error: null });
    expect(h.github.prs.get(1)).toMatchObject({ headRef: 'build/notes-1' });
    expect(h.github.prs.get(1)?.body).toContain('1. add notes');
    const head = git(h.work, 'rev-parse', 'HEAD');
    expect(result.headSha).toBe(head);
    expect(git(h.origin, 'rev-parse', 'refs/heads/build/notes-1')).toBe(head);
    expect(texts(h.store)).toEqual(
      expect.arrayContaining(['Committed changes Claude left uncommitted.', 'Opened pull request #1.']),
    );
  });

  it('no commits means no PR', async () => {
    const h = setup();

    const result = await finish(h, h.task);

    expect(result.status).toBe('no_changes');
    expect(texts(h.store)).toContain('No code changes, so no pull request.');
    expect(h.github.calls).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it('failing test is fixed by Claude, then passes', async () => {
    const h = setup({
      decide: (cmd, call) => (cmd === 'pnpm test' && call === 1 ? failed('1 test failing') : OK),
      scripts: [
        [
          (o) => {
            writeFileSync(join(o.cwd, 'fix.txt'), 'x');
          },
          { type: 'done', sessionId: 's', ok: true },
        ],
      ],
    });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(h.runner.calls[0]?.prompt).toContain('exit code 1');
    expect(h.runner.calls[0]?.prompt).toContain('`pnpm test`');
    expect(result.status).toBe('review');
    expect(git(h.origin, 'ls-tree', '-r', '--name-only', 'refs/heads/build/notes-1')).toContain('fix.txt');
  });

  it('gives up after two fix attempts', async () => {
    const h = setup({ decide: (cmd) => (cmd === 'pnpm test' ? failed() : OK) });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(h.runner.calls).toHaveLength(MAX_FIX_ATTEMPTS);
    expect(result).toMatchObject({ status: 'failed', error: 'test still fails after 2 fix attempts.' });
    expect(h.github.calls).toEqual([]);
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('switching branches fails the task', async () => {
    const h = setup();
    writeNotes(h.work);
    git(h.work, 'checkout', 'main');

    const result = await finish(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('switched to branch main');
    expect(h.commands).toEqual([]);
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('a fix turn that switches to the default branch fails the task instead of committing there', async () => {
    const h = setup({
      decide: (cmd, call) => (cmd === 'pnpm test' && call === 1 ? failed() : OK),
      scripts: [
        [
          (o) => {
            git(o.cwd, 'checkout', 'main');
            writeFileSync(join(o.cwd, 'fix.txt'), 'x');
          },
          { type: 'done', sessionId: 's', ok: true },
        ],
      ],
    });
    writeNotes(h.work);
    git(h.work, 'add', '-A');
    git(h.work, 'commit', '-m', 'notes');
    const localMain = git(h.work, 'rev-parse', 'main');
    const originMain = git(h.origin, 'rev-parse', 'refs/heads/main');

    const { result, commits, pushes } = await finishRecorded(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('switched to branch main');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
    expect(h.runner.calls).toHaveLength(1);
    expect(git(h.work, 'rev-parse', 'main')).toBe(localMain);
    expect(git(h.origin, 'rev-parse', 'refs/heads/main')).toBe(originMain);
  });

  it('a fix turn that switches to another branch fails the task instead of committing elsewhere', async () => {
    const h = setup({
      decide: (cmd, call) => (cmd === 'pnpm test' && call === 1 ? failed() : OK),
      scripts: [
        [
          (o) => {
            git(o.cwd, 'checkout', '-b', 'elsewhere');
            writeFileSync(join(o.cwd, 'fix.txt'), 'x');
          },
          { type: 'done', sessionId: 's', ok: true },
        ],
      ],
    });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('switched to branch elsewhere');
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('a build command that switches branches fails before the push', async () => {
    const h = setup({
      command: async (cmd, opts) => {
        if (cmd === 'pnpm test') git(opts.cwd, 'checkout', '-b', 'other');
        return OK;
      },
    });
    writeNotes(h.work);

    const { result, pushes } = await finishRecorded(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('switched to branch other');
    expect(pushes).toEqual([]);
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('stops before the push when stopped after the last command', async () => {
    const controller = new AbortController();
    const h = setup({
      command: async (cmd) => {
        if (cmd === 'pnpm test') controller.abort();
        return OK;
      },
    });
    writeNotes(h.work);

    const { result, pushes } = await finishRecorded(h, h.task, controller.signal);

    expect(result).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(pushes).toEqual([]);
    expect(h.github.calls).toEqual([]);
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('stops before the push when stopped during the branch check just before it', async () => {
    const controller = new AbortController();
    const h = setup({
      command: async () => OK,
    });
    writeNotes(h.work);
    let checks = 0;
    const pushes: string[] = [];
    const deps: BuildDeps = {
      ...h.deps,
      openRepo: (dir) => {
        const repo = h.deps.openRepo(dir);
        return {
          ...repo,
          async currentBranch() {
            const branch = await repo.currentBranch();
            checks += 1;
            // The 1st read is the start check; the 2nd is the check made right before the push.
            if (checks === 2) controller.abort();
            return branch;
          },
          async push(branch) {
            pushes.push(branch);
            return repo.push(branch);
          },
        };
      },
    };

    const result = await finishTask(deps, { task: h.task, dir: h.work, manifest, signal: controller.signal });

    expect(checks).toBe(2);
    expect(result).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(pushes).toEqual([]);
    expect(h.github.calls).toEqual([]);
    expect(remoteHasBranch(h.origin, 'build/notes-1')).toBe(false);
  });

  it('a rejected push fails the task and opens no pull request', async () => {
    const h = setup();
    writeNotes(h.work);
    const { deps } = recordGitWrites(h.deps, { rejectPush: 'remote rejected' });

    const result = await finishTask(deps, {
      task: h.task,
      dir: h.work,
      manifest,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: 'failed', error: 'git push failed: remote rejected' });
    expect(h.github.calls).toEqual([]);
    expect(h.github.prs.size).toBe(0);
  });

  it('publishes running only while the task is being worked on', async () => {
    const h = setup({ decide: (cmd, call) => (cmd === 'pnpm test' && call === 1 ? failed() : OK) });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    const published = h.hub.sent.flatMap((m) =>
      m.type === 'build.task' ? [{ status: m.task.status, running: m.running }] : [],
    );
    expect(result.status).toBe('review');
    expect(published).toEqual(
      expect.arrayContaining([
        { status: 'working', running: true },
        { status: 'verifying', running: true },
        { status: 'pushing', running: true },
      ]),
    );
    expect(published.filter((p) => p.status === 'review')).toEqual([{ status: 'review', running: false }]);
    expect(published.at(-1)).toEqual({ status: 'review', running: false });
  });

  it('existing PR is updated, not duplicated', async () => {
    const h = setup();
    writeNotes(h.work);
    const first = await finish(h, h.task);
    writeFileSync(join(h.work, 'more.md'), 'more\n');
    git(h.work, 'add', '-A');
    git(h.work, 'commit', '-m', 'more notes');

    const second = await finish(h, first);

    expect(second).toMatchObject({ status: 'review', prNumber: 1 });
    expect(texts(h.store)).toContain('Updated pull request #1.');
    expect(h.github.prs.size).toBe(1);
  });

  it('follow-up without changes keeps the PR as is', async () => {
    const h = setup();
    writeNotes(h.work);
    const first = await finish(h, h.task);
    const commandsBefore = h.commands.length;

    const second = await finish(h, first);

    expect(second).toMatchObject({ status: 'review', prNumber: 1 });
    expect(texts(h.store)).toContain('No new changes.');
    expect(h.commands).toHaveLength(commandsBefore);
    expect(h.runner.calls).toHaveLength(0);
    expect(h.github.calls.filter((call) => call === 'createPr')).toHaveLength(1);
    expect(h.github.prs.size).toBe(1);
  });

  it('missing GitHub client fails after pushing', async () => {
    const h = setup({ noGitHub: true });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^GITHUB_TOKEN is not set/),
    });
    expect(git(h.origin, 'rev-parse', 'refs/heads/build/notes-1')).toBe(git(h.work, 'rev-parse', 'HEAD'));
  });

  it('usage limit during a fix queues the task', async () => {
    const h = setup({
      decide: (cmd) => (cmd === 'pnpm test' ? failed() : OK),
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:99' }]],
    });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(result).toMatchObject({ status: 'queued', retryAt: 99 });
    expect(h.store.pendingPrompt(h.task.id)).toContain('exit code 1');
  });

  it('refuses to commit or push the default branch', async () => {
    const h = setup();
    git(h.work, 'checkout', 'main');
    const task = h.store.createTask({ app: 'demo', title: 'Add notes', branch: 'main', base: 'main' });
    writeNotes(h.work);
    const { deps, commits, pushes } = recordGitWrites(h.deps);
    const head = git(h.work, 'rev-parse', 'HEAD');
    const originMain = git(h.origin, 'rev-parse', 'refs/heads/main');

    const result = await finishTask(deps, { task, dir: h.work, manifest, signal: new AbortController().signal });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('default branch');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
    expect(git(h.work, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(h.origin, 'rev-parse', 'refs/heads/main')).toBe(originMain);
    expect(git(h.work, 'status', '--porcelain')).toContain('notes.md');
    expect(h.commands).toEqual([]);
    expect(h.github.calls).toEqual([]);
  });

  it('refuses to commit or push a default branch that origin/HEAD does not name', async () => {
    const h = setup();
    git(h.work, 'checkout', '-b', 'trunk');
    git(h.work, 'push', 'origin', 'trunk');
    git(h.origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    git(h.work, 'remote', 'set-head', 'origin', '-d');
    const task = h.store.createTask({ app: 'demo', title: 'Add notes', branch: 'trunk', base: 'trunk' });
    writeNotes(h.work);
    const trunkBefore = git(h.origin, 'rev-parse', 'refs/heads/trunk');

    const { result, commits, pushes } = await finishRecorded(h, task);

    expect(result.status).toBe('failed');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
    expect(git(h.origin, 'rev-parse', 'refs/heads/trunk')).toBe(trunkBefore);
    expect(git(h.work, 'status', '--porcelain')).toContain('notes.md');
    expect(h.github.calls).toEqual([]);
  });

  it('refuses to commit or push a branch outside build/', async () => {
    const h = setup();
    git(h.work, 'checkout', '-b', 'feature/x');
    const task = h.store.createTask({ app: 'demo', title: 'Add notes', branch: 'feature/x', base: 'main' });
    writeNotes(h.work);

    const { result, commits, pushes } = await finishRecorded(h, task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('build/ branches');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
    expect(h.github.calls).toEqual([]);
  });

  it('refuses to commit or push a detached HEAD', async () => {
    const h = setup();
    git(h.work, 'checkout', '--detach');
    writeNotes(h.work);

    const { result, commits, pushes } = await finishRecorded(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('not on a named branch');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it('compares the base branch after stripping refs/heads/ and ignoring case', async () => {
    const h = setup();
    const task = h.store.createTask({
      app: 'demo',
      title: 'Add notes',
      branch: 'build/notes-1',
      base: 'refs/heads/Build/Notes-1',
    });
    writeNotes(h.work);

    const { result, commits, pushes } = await finishRecorded(h, task);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('base branch');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it('refuses to commit or push an empty branch name', async () => {
    const h = setup();
    const task = h.store.createTask({ app: 'demo', title: 'Add notes', branch: '', base: 'main' });
    writeNotes(h.work);
    const { deps, commits, pushes } = recordGitWrites(h.deps);

    const result = await finishTask(deps, { task, dir: h.work, manifest, signal: new AbortController().signal });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no work branch');
    expect(commits).toEqual([]);
    expect(pushes).toEqual([]);
    expect(git(h.work, 'status', '--porcelain')).toContain('notes.md');
  });

  it('a failing commit fails the task instead of throwing', async () => {
    const h = setup();
    mkdirSync(join(h.work, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(h.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook rejected" >&2\nexit 1\n', {
      mode: 0o755,
    });
    writeNotes(h.work);

    const result = await finish(h, h.task);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^Could not finish the task: /);
    expect(h.github.calls).toEqual([]);
  });
});
