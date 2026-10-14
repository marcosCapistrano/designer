import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildTask, BuildTaskStatus, ServerMsg } from '@hub/protocol';
import type { AppManifest } from '@hub/protocol/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEntry } from '../apps/registry.js';
import { FakeClaudeRunner, type FakeStep } from '../claude/fake.js';
import type { AgentEvent, ClaudeRunner, RunOptions } from '../claude/runner.js';
import { type Db, openDb } from '../db.js';
import { type GitRepo, openRepo } from '../git/git.js';
import { git, makeTestRepo, TEST_IDENTITY } from '../git/test-repo.js';
import { FakeGitHub } from '../github/fake.js';
import { BuildError } from './ci.js';
import type { CommandResult, RunCommand } from './commands.js';
import type { BuildDeps } from './deps.js';
import { BuildService, MAX_MESSAGE_CHARS } from './service.js';
import { BuildStore } from './store.js';

const OK: CommandResult = { ok: true, code: 0, output: '', timedOut: false, aborted: false };
const ABORTED: CommandResult = { ok: false, code: null, output: '', timedOut: false, aborted: true };
const IN_FLIGHT: BuildTaskStatus[] = ['working', 'verifying', 'pushing'];
const GREEN = [{ name: 'ci', status: 'completed', conclusion: 'success' }];

function manifestFor(name: string): AppManifest {
  return {
    name,
    template: 'vite-hono-pg@1',
    design: { dir: 'design', routes: 'web/src/routes.tsx', devices: ['desktop', 'tablet', 'mobile'] },
    build: { install: 'pnpm i', test: 'pnpm test', typecheck: 'pnpm typecheck' },
    deploy: {
      image: 'ghcr.io/marco/myapp',
      staging: { server: 'shared-staging', url: 'http://myapp.staging.tail1234.ts.net' },
      production: { server: 'shared-production', url: 'https://myapp.203.0.113.7.sslip.io', domain: null },
    },
  };
}

/** A script step that writes a file into the checkout, as Claude would. */
const write = (name: string) => (o: RunOptions) => {
  writeFileSync(join(o.cwd, name), 'x');
};

const text = (s: string): FakeStep => ({ type: 'text', text: s });
const done = (sessionId: string): FakeStep => ({ type: 'done', sessionId, ok: true });

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A script step that blocks until the run is aborted. */
const untilAborted = (o: RunOptions) =>
  new Promise<void>((r) => {
    o.signal?.addEventListener('abort', () => r());
  });

let t = 1000;
const opened: Db[] = [];
const roots: string[] = [];

beforeEach(() => {
  t = 1000;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface SetupOptions {
  scripts?: FakeStep[][];
  runner?: ClaudeRunner;
  runCommand?: RunCommand;
  openRepo?: (dir: string) => GitRepo;
  onMerged?: BuildDeps['onMerged'];
}

function setup(opts: SetupOptions = {}) {
  const { origin, work } = makeTestRepo({ files: { '.hub/app.json': JSON.stringify(manifestFor('demo')) } });
  roots.push(dirname(origin));
  const entry: AppEntry = { name: 'demo', dir: work, adopted: true, manifest: manifestFor('demo'), manifestError: null };

  const db = openDb(':memory:');
  opened.push(db);
  const store = new BuildStore(db, () => t);
  const sent: ServerMsg[] = [];
  const hub = {
    broadcast(m: ServerMsg): void {
      sent.push(m);
    },
  };
  const fake = new FakeClaudeRunner(opts.scripts ?? [[write('notes.md'), text('Done.'), done('s1')]]);
  const github = new FakeGitHub();
  const deps: BuildDeps = {
    store,
    runner: opts.runner ?? fake,
    hub,
    registry: { get: async (n) => (n === 'demo' ? entry : null) },
    openRepo: opts.openRepo ?? ((dir) => openRepo(dir, { identity: TEST_IDENTITY })),
    github,
    runCommand: opts.runCommand ?? (async () => OK),
    now: () => t,
    onMerged: opts.onMerged,
  };
  const svc = new BuildService(deps);
  return { svc, deps, store, sent, runner: fake, github, origin, work, entry };
}

type Setup = ReturnType<typeof setup>;

/** Repo whose methods can be overridden, so a test can make one git step fail or wait. */
function repoWith(override: (real: GitRepo) => Partial<GitRepo>): (dir: string) => GitRepo {
  return (dir) => {
    const real = openRepo(dir, { identity: TEST_IDENTITY });
    return { ...real, ...override(real) };
  };
}

function latest(s: Setup): BuildTask {
  const task = s.store.latestTask('demo');
  if (task === null) throw new Error('no task');
  return task;
}

/** Sends one prompt and waits for the run to end. */
async function run(s: Setup, prompt = 'Add a notes file'): Promise<BuildTask> {
  await s.svc.send('demo', prompt);
  await s.svc.idle('demo');
  return latest(s);
}

function lastTaskMsg(s: Setup): Extract<ServerMsg, { type: 'build.task' }> {
  const msgs = s.sent.filter((m): m is Extract<ServerMsg, { type: 'build.task' }> => m.type === 'build.task');
  const last = msgs[msgs.length - 1];
  if (last === undefined) throw new Error('no build.task message');
  return last;
}

function feed(s: Setup): [string, string][] {
  return s.store.messages('demo').map((m) => [m.kind, m.text]);
}

describe('BuildService.send', () => {
  it('runs Claude on a new build branch and opens a PR', async () => {
    const s = setup();
    const mainBefore = git(s.origin, 'rev-parse', 'main');

    const task = await s.svc.send('demo', 'Add a notes file');
    expect(task).toMatchObject({ status: 'working', branch: 'build/add-a-notes-file-1' });
    await s.svc.idle('demo');

    const final = latest(s);
    expect(final).toMatchObject({ status: 'review', prNumber: 1, error: null });
    const kinds = s.store.messages('demo').map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['user', 'assistant', 'status']));
    expect(s.runner.calls[0]?.cwd).toBe(s.work);
    expect(git(s.work, 'branch', '--show-current')).toBe('build/add-a-notes-file-1');
    expect(git(s.origin, 'rev-parse', 'main')).toBe(mainBefore);
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s).running).toBe(false);
  });

  it('reports running while Claude works and broadcasts the task as running', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[() => gate.promise, done('s1')]] });

    await s.svc.send('demo', 'Hold on');
    expect(s.svc.isRunning('demo')).toBe(true);
    expect(s.svc.latestStatus('demo')).toBe('working');
    expect(lastTaskMsg(s).running).toBe(true);

    gate.resolve();
    await s.svc.idle('demo');
    expect(s.svc.isRunning('demo')).toBe(false);
  });

  it('continues the open task on a second prompt', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    const first = await run(s);

    await s.svc.send('demo', 'And a second file');
    await s.svc.idle('demo');

    const second = latest(s);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('review');
    expect(s.runner.calls[1]?.resume).toBe('s1');
    expect(s.github.prs.size).toBe(1);
  });

  it('refuses a concurrent prompt', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[() => gate.promise, done('s1')]] });
    await s.svc.send('demo', 'First');

    const second = s.svc.send('demo', 'Second');
    await expect(second).rejects.toBeInstanceOf(BuildError);
    await expect(second).rejects.toMatchObject({
      status: 409,
      message: 'Claude is already working on this app. Wait or tap Stop.',
    });

    gate.resolve();
    await s.svc.idle('demo');
  });

  it('lets only one of two simultaneous prompts through', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[() => gate.promise, done('s1')]] });

    const results = await Promise.allSettled([s.svc.send('demo', 'One'), s.svc.send('demo', 'Two')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(s.runner.calls).toHaveLength(1);

    gate.resolve();
    await s.svc.idle('demo');
  });

  it('blocks a new task on a dirty checkout', async () => {
    const s = setup();
    writeFileSync(join(s.work, 'stray.txt'), 'stray');

    const sending = s.svc.send('demo', 'Add a notes file');
    await expect(sending).rejects.toMatchObject({ status: 409, message: expect.stringContaining('uncommitted changes') });

    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.store.latestTask('demo')).toBeNull();
    expect(s.runner.calls).toHaveLength(0);
  });

  it('rejects empty, oversized and unknown-app messages', async () => {
    const s = setup();
    await expect(s.svc.send('demo', '   \n ')).rejects.toMatchObject({ status: 400, message: 'Message is empty.' });
    await expect(s.svc.send('demo', 'x'.repeat(MAX_MESSAGE_CHARS + 1))).rejects.toMatchObject({
      status: 400,
      message: 'Message is longer than 20000 characters.',
    });
    await expect(s.svc.send('nope', 'hello')).rejects.toMatchObject({ status: 404, message: 'Unknown app' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.store.latestTask('demo')).toBeNull();
  });

  it('trims the prompt and accepts the maximum length', async () => {
    const s = setup();
    await s.svc.send('demo', `  ${'x'.repeat(MAX_MESSAGE_CHARS)}\n`);
    await s.svc.idle('demo');
    expect(s.runner.calls[0]?.prompt).toHaveLength(MAX_MESSAGE_CHARS);
    expect(s.store.userPrompts(latest(s).id)).toEqual(['x'.repeat(MAX_MESSAGE_CHARS)]);
  });

  it('starts a new task on the next prompt after the PR was merged', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    const first = await run(s);
    expect(first.status).toBe('review');
    s.github.markMerged(1);

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');

    const second = latest(s);
    expect(second.id).toBe(2);
    expect(second.branch).toBe('build/add-a-notes-file-2');
    expect(s.store.task(first.id)?.status).toBe('merged');
    expect(s.runner.calls[1]?.resume).toBe('s1');
    expect(git(s.work, 'branch', '--show-current')).toBe('build/add-a-notes-file-2');
  });

  it('checks out the task branch before continuing', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    const first = await run(s);
    git(s.work, 'checkout', 'main');

    await s.svc.send('demo', 'More');
    await s.svc.idle('demo');

    expect(latest(s).id).toBe(first.id);
    expect(git(s.work, 'branch', '--show-current')).toBe(first.branch);
  });

  it('answers a git failure on an existing task with 409 and releases the app', async () => {
    const s = setup({
      scripts: [[write('a.txt'), done('s1')]],
      openRepo: repoWith((real) => ({
        checkout: async (branch: string) => {
          if (branch === 'build/first-1') throw new Error('checkout exploded');
          return real.checkout(branch);
        },
      })),
    });
    await run(s, 'First');
    git(s.work, 'checkout', 'main');

    await expect(s.svc.send('demo', 'Second')).rejects.toMatchObject({
      status: 409,
      message: 'Git: checkout exploded',
    });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.runner.calls).toHaveLength(1);
  });

  it('creates no task when the fetch fails', async () => {
    const s = setup({
      openRepo: repoWith(() => ({
        fetch: async () => {
          throw new Error('network down');
        },
      })),
    });

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toMatchObject({
      status: 409,
      message: 'Git: network down',
    });
    expect(s.store.latestTask('demo')).toBeNull();
    expect(s.svc.isRunning('demo')).toBe(false);
  });

  it('fails the new task when the branch cannot be created', async () => {
    const s = setup({
      openRepo: repoWith(() => ({
        createBranchFrom: async () => {
          throw new Error('cannot branch');
        },
      })),
    });

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toMatchObject({
      status: 409,
      message: 'Git: cannot branch',
    });
    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Git: cannot branch' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.runner.calls).toHaveLength(0);
  });
});

describe('BuildService stop and failures', () => {
  it('stop aborts the run', async () => {
    const s = setup({ scripts: [[untilAborted, done('s1')]] });
    await s.svc.send('demo', 'Add a notes file');

    expect(s.svc.stop('demo')).toBe(true);
    await s.svc.idle('demo');

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s).running).toBe(false);
    expect(feed(s)).toContainEqual(['error', 'Stopped by you.']);
  });

  it('stop returns false when nothing runs', () => {
    const s = setup();
    expect(s.svc.stop('demo')).toBe(false);
    expect(s.svc.stop('nope')).toBe(false);
  });

  it('stop while verifying fails the task instead of leaving it verifying', async () => {
    const started = deferred();
    const s = setup({
      runCommand: (_cmd, o) =>
        new Promise<CommandResult>((resolve) => {
          started.resolve();
          o.signal?.addEventListener('abort', () => resolve(ABORTED));
        }),
    });
    await s.svc.send('demo', 'Add a notes file');
    await started.promise;
    expect(latest(s).status).toBe('verifying');

    expect(s.svc.stop('demo')).toBe(true);
    await s.svc.idle('demo');

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(s.svc.isRunning('demo')).toBe(false);
  });

  it('stop while pushing does not leave the task pushing', async () => {
    const pushing = deferred();
    const release = deferred();
    const s = setup({
      openRepo: repoWith((real) => ({
        push: async (branch: string) => {
          pushing.resolve();
          await release.promise;
          return real.push(branch);
        },
      })),
    });
    await s.svc.send('demo', 'Add a notes file');
    await pushing.promise;
    expect(latest(s).status).toBe('pushing');

    expect(s.svc.stop('demo')).toBe(true);
    release.resolve();
    await s.svc.idle('demo');

    expect(IN_FLIGHT).not.toContain(latest(s).status);
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s).running).toBe(false);
  });

  it('stopAll aborts every run and waits for them to end', async () => {
    const s = setup({ scripts: [[untilAborted, done('s1')]] });
    await s.svc.send('demo', 'Add a notes file');

    await s.svc.stopAll();

    expect(s.svc.isRunning('demo')).toBe(false);
    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
  });

  it('stopAll also ends a run that is still preparing git', async () => {
    const fetching = deferred();
    const gate = deferred();
    const s = setup({
      openRepo: repoWith((real) => ({
        fetch: async () => {
          fetching.resolve();
          await gate.promise;
          return real.fetch();
        },
      })),
    });
    const sending = s.svc.send('demo', 'Add a notes file');
    await fetching.promise;
    expect(s.svc.isRunning('demo')).toBe(true);

    const stopping = s.svc.stopAll();
    gate.resolve();
    await sending;
    await stopping;

    expect(s.svc.isRunning('demo')).toBe(false);
    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
  });

  it.each([
    ['throws before streaming', 'sync'],
    ['throws mid-stream', 'stream'],
  ] as const)('a runner that %s fails the task and ends the run', async (_name, when) => {
    const runner: ClaudeRunner = {
      run(): AsyncIterable<AgentEvent> {
        if (when === 'sync') throw new Error('boom');
        return (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', text: 'partial' };
          throw new Error('boom');
        })();
      },
    };
    const s = setup({ runner });

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Unexpected error: boom' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s)).toMatchObject({ running: false, task: { status: 'failed' } });
    expect(feed(s)).toContainEqual(['error', 'Unexpected error: boom']);
    expect(s.svc.stop('demo')).toBe(false);
  });

  it('fails the task when finishing throws', async () => {
    let opens = 0;
    const s = setup({
      openRepo: (dir) => {
        opens += 1;
        if (opens > 1) throw new Error('disk gone');
        return openRepo(dir, { identity: TEST_IDENTITY });
      },
    });

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Unexpected error: disk gone' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s).running).toBe(false);
  });

  it('a failed Claude run fails the task with its error', async () => {
    const s = setup({ scripts: [[{ type: 'done', sessionId: 's1', ok: false, error: 'model overloaded' }]] });
    const task = await run(s);
    expect(task).toMatchObject({ status: 'failed', error: 'model overloaded' });
    expect(feed(s)).toContainEqual(['error', 'model overloaded']);
  });

  it('ends the run even when the hub cannot broadcast the final state', async () => {
    const s = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broadcast = s.deps.hub.broadcast.bind(s.deps.hub);
    vi.spyOn(s.deps.hub, 'broadcast').mockImplementation((m) => {
      if (m.type === 'build.task' && !m.running) throw new Error('socket gone');
      broadcast(m);
    });

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');

    expect(s.svc.isRunning('demo')).toBe(false);
    expect(latest(s).status).toBe('review');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket gone'));
  });
});

describe('BuildService usage limit', () => {
  it('queues the task and retryQueued resumes it', async () => {
    const s = setup({
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }], [write('a.txt'), done('s2')]],
    });
    const queued = await run(s);
    expect(queued).toMatchObject({ status: 'queued', retryAt: 5000 });
    expect(s.svc.isRunning('demo')).toBe(false);

    t = 4000;
    expect(await s.svc.retryQueued()).toBe(0);
    expect(s.runner.calls).toHaveLength(1);

    t = 6000;
    expect(await s.svc.retryQueued()).toBe(1);
    expect(s.svc.isRunning('demo')).toBe(true);
    await s.svc.idle('demo');

    const final = latest(s);
    expect(final).toMatchObject({ status: 'review', retryAt: null, error: null });
    expect(s.runner.calls[1]?.prompt).toBe('Add a notes file');
    expect(s.store.pendingPrompt(final.id)).toBeNull();
    expect(feed(s)).toContainEqual(['status', 'Retrying after the usage limit.']);
  });

  it('retryQueued skips an app that is running', async () => {
    const gate = deferred();
    const s = setup({
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }], [() => gate.promise, done('s2')]],
    });
    const queued = await run(s);
    t = 6000;
    expect(await s.svc.retryQueued()).toBe(1);

    // A queued row for an app that is mid-run (here forced) must not start a second run.
    s.store.updateTask(queued.id, { status: 'queued', retryAt: 5000 });
    expect(await s.svc.retryQueued()).toBe(0);
    expect(s.runner.calls).toHaveLength(2);

    gate.resolve();
    await s.svc.idle('demo');
  });

  it('retryQueued skips a task that was closed while queued', async () => {
    const s = setup({ scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }]] });
    const queued = await run(s);
    await s.svc.close('demo', queued.id);
    t = 6000;

    expect(await s.svc.retryQueued()).toBe(0);
    expect(s.runner.calls).toHaveLength(1);
  });

  it('retryQueued falls back to a generic prompt', async () => {
    const s = setup({
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }], [write('a.txt'), done('s2')]],
    });
    const queued = await run(s);
    s.store.updateTask(queued.id, { pendingPrompt: null });
    t = 6000;

    await s.svc.retryQueued();
    await s.svc.idle('demo');

    expect(s.runner.calls[1]?.prompt).toBe('Continue where you left off.');
  });

  it('retryQueued fails a task whose branch cannot be checked out', async () => {
    let failCheckout = false;
    const s = setup({
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }]],
      openRepo: repoWith((real) => ({
        checkout: async (branch: string) => {
          if (failCheckout) throw new Error('no such branch');
          return real.checkout(branch);
        },
      })),
    });
    await run(s);
    failCheckout = true;
    t = 6000;

    expect(await s.svc.retryQueued()).toBe(0);

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'Git: no such branch' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.runner.calls).toHaveLength(1);
  });
});

describe('BuildService recover', () => {
  it('marks interrupted tasks failed', async () => {
    const s = setup();
    for (const status of ['working', 'verifying', 'pushing'] as const) {
      const task = s.store.createTask({ app: 'demo', title: status, branch: `build/${status}-1`, base: 'main' });
      s.store.updateTask(task.id, { status });
    }
    const review = s.store.createTask({ app: 'demo', title: 'r', branch: 'build/r-1', base: 'main' });
    s.store.updateTask(review.id, { status: 'review' });

    const fresh = new BuildService(s.deps);
    expect(fresh.recover()).toBe(3);

    const failed = s.store.tasksWithStatus(['failed']);
    expect(failed).toHaveLength(3);
    for (const task of failed) {
      expect(task.error).toContain('Hub restarted');
      expect(task.error).toBe('Interrupted because the Hub restarted. Send a message to continue.');
    }
    expect(s.store.task(review.id)?.status).toBe('review');
    expect(s.store.messages('demo').filter((m) => m.kind === 'error')).toHaveLength(3);
    expect(fresh.recover()).toBe(0);
  });

  it('leaves a task alone while its app is running', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[() => gate.promise, done('s1')]] });
    await s.svc.send('demo', 'Add a notes file');

    expect(s.svc.recover()).toBe(0);
    expect(latest(s).status).toBe('working');

    gate.resolve();
    await s.svc.idle('demo');
  });
});

describe('BuildService close and merge', () => {
  it('close ends the task so the next prompt starts a new branch', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    const first = await run(s);

    const closed = await s.svc.close('demo', first.id);
    expect(closed).toMatchObject({ status: 'closed', error: null });
    expect(feed(s)).toContainEqual(['status', 'Task closed. The next message starts a new branch.']);
    expect(lastTaskMsg(s)).toMatchObject({ running: false, task: { id: first.id, status: 'closed' } });

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');
    expect(latest(s)).toMatchObject({ id: 2, branch: 'build/add-a-notes-file-2' });
  });

  it('close returns merged and closed tasks as they are', async () => {
    const s = setup();
    const first = await run(s);
    s.store.updateTask(first.id, { status: 'merged' });
    const before = s.store.messages('demo').length;

    expect((await s.svc.close('demo', first.id)).status).toBe('merged');
    expect(s.store.messages('demo')).toHaveLength(before);
  });

  it('close refuses a missing task, another app and a running app', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[() => gate.promise, done('s1')]] });
    const task = await s.svc.send('demo', 'Add a notes file');

    await expect(s.svc.close('demo', 999)).rejects.toMatchObject({ status: 404, message: 'Task not found' });
    await expect(s.svc.close('other', task.id)).rejects.toMatchObject({ status: 404, message: 'Task not found' });
    await expect(s.svc.close('demo', task.id)).rejects.toMatchObject({
      status: 409,
      message: 'Claude is still working on this app.',
    });

    gate.resolve();
    await s.svc.idle('demo');
  });

  it('merge squash-merges a task whose CI is green', async () => {
    const onMerged = vi.fn();
    const s = setup({ onMerged });
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);

    const merged = await s.svc.merge('demo', task.id);

    expect(merged).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(onMerged).toHaveBeenCalledWith({ app: 'demo', taskId: task.id, prNumber: 1, sha: 'merged-1' });
    expect(s.svc.latestStatus('demo')).toBe('merged');
  });

  it('merge is refused while Claude runs', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [() => gate.promise, done('s1')]] });
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);
    await s.svc.send('demo', 'More work');

    await expect(s.svc.merge('demo', task.id)).rejects.toMatchObject({
      status: 409,
      message: 'Claude is still working on this app.',
    });
    expect(s.github.merges).toHaveLength(0);

    gate.resolve();
    await s.svc.idle('demo');
  });
});

describe('BuildService.state', () => {
  it('returns running, the latest task and messages', async () => {
    const s = setup();
    expect(await s.svc.state('demo')).toEqual({ running: false, task: null, messages: [] });

    const task = await run(s);
    const state = await s.svc.state('demo');
    expect(state.running).toBe(false);
    expect(state.task?.id).toBe(task.id);
    expect(state.messages.length).toBeGreaterThan(2);
  });

  it('returns messages after an id', async () => {
    const s = setup();
    await run(s);
    const all = (await s.svc.state('demo')).messages;
    const after = all[1]?.id;
    if (after === undefined) throw new Error('expected messages');

    const rest = await s.svc.state('demo', after);

    expect(rest.messages.map((m) => m.id)).toEqual(all.slice(2).map((m) => m.id));
  });

  it('rejects an unknown app', async () => {
    const s = setup();
    await expect(s.svc.state('nope')).rejects.toMatchObject({ status: 404, message: 'Unknown app' });
  });

  it('refreshes a review task whose stored CI is pending', async () => {
    const s = setup();
    const task = await run(s);
    expect(task).toMatchObject({ status: 'review', ci: 'pending' });
    s.github.setChecks('head-1', GREEN);

    const state = await s.svc.state('demo');

    expect(state.task).toMatchObject({ id: task.id, status: 'review', ci: 'success' });
    expect(s.store.task(task.id)?.ci).toBe('success');
  });

  it('shows a PR merged on GitHub as merged', async () => {
    const s = setup();
    const task = await run(s);
    s.github.markMerged(1);

    const state = await s.svc.state('demo');

    expect(state.task).toMatchObject({ id: task.id, status: 'merged' });
  });

  it('does not ask GitHub while Claude runs, or when CI is already known', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [() => gate.promise, done('s1')]] });
    await run(s);

    await s.svc.send('demo', 'More work');
    const calls = s.github.calls.length;
    const running = await s.svc.state('demo');
    expect(running.running).toBe(true);
    expect(s.github.calls).toHaveLength(calls);

    gate.resolve();
    await s.svc.idle('demo');
    s.github.setChecks('head-1', GREEN);
    await s.svc.state('demo');
    const known = s.github.calls.length;
    await s.svc.state('demo');
    expect(s.github.calls).toHaveLength(known);
  });

  it('returns the stored snapshot and logs when the refresh throws', async () => {
    const s = setup();
    const task = await run(s);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(s.github, 'getPr').mockRejectedValue(new Error('GitHub is down'));

    const state = await s.svc.state('demo');

    expect(state.task).toMatchObject({ id: task.id, status: 'review', ci: 'pending' });
    expect(warn).toHaveBeenCalled();
  });

  it('logs and returns the snapshot when the refresh itself rejects', async () => {
    const s = setup();
    const task = await run(s);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(s.deps.store, 'task').mockImplementation(() => {
      throw new Error('db locked');
    });

    const state = await s.svc.state('demo');

    expect(state.task).toMatchObject({ id: task.id, status: 'review' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db locked'));
  });
});

describe('BuildService.pollCi', () => {
  it('refreshes review tasks whose app is idle and skips a running app', async () => {
    const gate = deferred();
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [() => gate.promise, done('s1')]] });
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);

    await s.svc.send('demo', 'More work');
    const calls = s.github.calls.length;
    await s.svc.pollCi();
    expect(s.github.calls).toHaveLength(calls);

    gate.resolve();
    await s.svc.idle('demo');
    await s.svc.pollCi();
    expect(s.store.task(task.id)?.ci).toBe('success');
  });
});
