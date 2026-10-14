import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildState, BuildTask, BuildTaskStatus, ServerMsg } from '@hub/protocol';
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
  /** More app names the registry knows; all share the demo checkout, which is enough for CI reads. */
  extraApps?: string[];
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
  const hold: { next: Promise<void> | null } = { next: null };
  const fake = new FakeClaudeRunner(opts.scripts ?? [[write('notes.md'), text('Done.'), done('s1')]]);
  const github = new FakeGitHub();
  const deps: BuildDeps = {
    store,
    runner: opts.runner ?? fake,
    hub,
    registry: {
      get: async (n) => {
        const held = hold.next;
        hold.next = null;
        if (held !== null) await held;
        if (n === 'demo') return entry;
        return opts.extraApps?.includes(n) ? { ...entry, name: n } : null;
      },
    },
    openRepo: opts.openRepo ?? ((dir) => openRepo(dir, { identity: TEST_IDENTITY })),
    github,
    runCommand: opts.runCommand ?? (async () => OK),
    now: () => t,
    onMerged: opts.onMerged,
  };
  const svc = new BuildService(deps);
  return { svc, deps, store, sent, runner: fake, github, origin, work, entry, hold };
}

type Setup = ReturnType<typeof setup>;

describe('checkout reservation', () => {
  it('blocks Build and duplicate imports until the checkout action finishes', async () => {
    const s = setup();
    const gate = deferred();
    const importing = s.svc.withCheckout('demo', () => gate.promise);
    await expect(s.svc.send('demo', 'Build during import')).rejects.toMatchObject({ status: 409 });
    await expect(s.svc.withCheckout('demo', async () => {})).rejects.toMatchObject({ status: 409 });
    expect(s.runner.calls).toHaveLength(0);
    gate.resolve(); await importing;
    await s.svc.send('demo', 'Build after import');
    await s.svc.idle('demo');
    expect(s.runner.calls).toHaveLength(1);
  });
  it('releases failed actions and refuses import while Build owns the checkout', async () => {
    const s = setup({ scripts: [[untilAborted]] });
    await expect(s.svc.withCheckout('demo', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await s.svc.send('demo', 'Build');
    await expect(s.svc.withCheckout('demo', async () => {})).rejects.toMatchObject({ status: 409 });
    await s.svc.stopAll();
  });
});

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

  it('closes the new task when the branch cannot be created, so the next prompt starts fresh', async () => {
    let broken = true;
    const s = setup({
      openRepo: repoWith((real) => ({
        createBranchFrom: async (branch: string, base: string) => {
          if (broken) throw new Error('cannot branch');
          return real.createBranchFrom(branch, base);
        },
      })),
    });

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toMatchObject({
      status: 409,
      message: 'Git: cannot branch',
    });
    const dead = latest(s);
    expect(dead).toMatchObject({ status: 'closed', error: null });
    expect(feed(s)).toContainEqual(['error', 'Git: cannot branch']);
    expect(lastTaskMsg(s)).toMatchObject({ running: false, task: { id: dead.id, status: 'closed' } });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.runner.calls).toHaveLength(0);

    broken = false;
    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');
    expect(latest(s)).toMatchObject({ id: dead.id + 1, status: 'review' });
  });

  it('fails the new task when the user message cannot be stored', async () => {
    const s = setup();
    vi.spyOn(s.store, 'addMessage').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toThrow('disk full');

    expect(latest(s)).toMatchObject({ status: 'failed', error: 'disk full' });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(s.runner.calls).toHaveLength(0);
    expect(lastTaskMsg(s)).toMatchObject({ running: false, task: { status: 'failed' } });
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

    // The push cannot be cancelled, so it completes and the PR opens: review, not stuck in pushing.
    expect(latest(s)).toMatchObject({ status: 'review', prNumber: 1 });
    expect(s.svc.isRunning('demo')).toBe(false);
    expect(lastTaskMsg(s).running).toBe(false);
  });

  it('a stop issued during the last check fails the task without pushing', async () => {
    const s: Setup = setup({
      runCommand: async (cmd) => {
        if (cmd === 'pnpm test') s.svc.stop('demo');
        return OK;
      },
    });

    const task = await run(s);

    expect(task).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(git(s.origin, 'branch', '--list', 'build/*')).toBe('');
    expect(s.github.prs.size).toBe(0);
    expect(s.github.calls).not.toContain('createPr');
    expect(s.svc.isRunning('demo')).toBe(false);
  });

  it('a stop issued during the branch check before the push fails the task without pushing', async () => {
    let armed = false;
    let stopReturned: boolean | null = null;
    const s: Setup = setup({
      runCommand: async () => {
        armed = true;
        return OK;
      },
      openRepo: repoWith((real) => ({
        currentBranch: async () => {
          const branch = await real.currentBranch();
          // The first branch read after the last check is the one made just before the push.
          if (armed && stopReturned === null) stopReturned = s.svc.stop('demo');
          return branch;
        },
      })),
    });

    const task = await run(s);

    expect(stopReturned).toBe(true);
    expect(task).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    expect(git(s.origin, 'branch', '--list', 'build/*')).toBe('');
    expect(s.github.prs.size).toBe(0);
    expect(s.github.calls).not.toContain('createPr');
    expect(s.svc.isRunning('demo')).toBe(false);
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
      if (m.type === 'build.task' && !m.running && !s.svc.isRunning('demo')) throw new Error('socket gone');
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

  it('retryQueued re-reads the task: one closed while the registry answered is not restarted', async () => {
    const s = setup({ scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }]] });
    const queued = await run(s);
    t = 6000;
    const registry = deferred();
    s.hold.next = registry.promise;

    const retrying = s.svc.retryQueued();
    await s.svc.close('demo', queued.id);
    registry.resolve();

    expect(await retrying).toBe(0);
    expect(s.runner.calls).toHaveLength(1);
    expect(s.store.task(queued.id)?.status).toBe('closed');
    expect(s.svc.isRunning('demo')).toBe(false);
  });

  it('retryQueued does not start a second run when a send took the app meanwhile', async () => {
    const checkingOut = deferred();
    const gate = deferred();
    let armed = false;
    const s = setup({
      scripts: [[{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:5000' }], [write('a.txt'), done('s2')]],
      openRepo: repoWith((real) => ({
        checkout: async (branch: string) => {
          if (armed) {
            armed = false;
            checkingOut.resolve();
            await gate.promise;
          }
          return real.checkout(branch);
        },
      })),
    });
    const queued = await run(s);
    git(s.work, 'checkout', 'main');
    t = 6000;
    const registry = deferred();
    s.hold.next = registry.promise;
    const retrying = s.svc.retryQueued();

    // The send reserves the app and waits in its checkout; the task is still `queued`.
    armed = true;
    const sending = s.svc.send('demo', 'Continue please');
    await checkingOut.promise;
    expect(s.store.task(queued.id)?.status).toBe('queued');
    registry.resolve();

    expect(await retrying).toBe(0);
    gate.resolve();
    await sending;
    await s.svc.idle('demo');
    expect(s.runner.calls).toHaveLength(2);
    expect(latest(s)).toMatchObject({ id: queued.id, status: 'review' });
  });
});

/** Waits until a script step has written `name` into the checkout. */
async function written(s: Setup, name: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(join(s.work, name))).toBe(true));
}

function originHasBranch(s: Setup, branch: string): boolean {
  try {
    git(s.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

describe('BuildService leftovers of a finished task', () => {
  it('Stop then Close then a new message starts task 2 on a new branch and keeps the leftovers locally', async () => {
    const s = setup({
      scripts: [
        [
          async (o) => {
            write('half-done.ts')(o);
            await untilAborted(o);
          },
          done('s1'),
        ],
        [write('b.txt'), done('s1')],
      ],
    });
    const mainBefore = git(s.origin, 'rev-parse', 'main');
    await s.svc.send('demo', 'Add a half done feature');
    await written(s, 'half-done.ts');
    s.svc.stop('demo');
    await s.svc.idle('demo');
    const first = latest(s);
    expect(first).toMatchObject({ status: 'failed', error: 'Stopped by you.' });
    await s.svc.close('demo', first.id);
    expect(git(s.work, 'status', '--porcelain')).toBe('?? half-done.ts');

    const second = await s.svc.send('demo', 'Something else');
    await s.svc.idle('demo');

    expect(second).toMatchObject({ id: 2, branch: 'build/something-else-2' });
    expect(git(s.work, 'branch', '--show-current')).toBe('build/something-else-2');
    // The old branch holds the leftovers as one local commit...
    expect(git(s.work, 'log', '-1', '--format=%s', first.branch)).toBe('Uncommitted work left by task #1');
    expect(git(s.work, 'ls-tree', '-r', '--name-only', first.branch)).toContain('half-done.ts');
    // ...which the new branch, cut from origin/main, does not have.
    expect(git(s.work, 'ls-tree', '-r', '--name-only', 'build/something-else-2')).not.toContain('half-done.ts');
    expect(git(s.work, 'status', '--porcelain')).toBe('');
    // Nothing of it reached GitHub.
    expect(originHasBranch(s, first.branch)).toBe(false);
    expect(git(s.origin, 'rev-parse', 'main')).toBe(mainBefore);
    expect(feed(s)).toContainEqual([
      'status',
      `Kept the changes task #1 left uncommitted as a commit on ${first.branch}. It stays on the server and is not pushed.`,
    ]);
    expect(latest(s)).toMatchObject({ id: 2, status: 'review' });
  });

  it('keeps untracked files a verify command left behind after the task merged', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    const first = await run(s);
    s.github.markMerged(1);
    // What a verify command leaves: untracked, not in .gitignore (a rewritten next-env.d.ts, a test report).
    mkdirSync(join(s.work, 'reports'));
    writeFileSync(join(s.work, 'reports', 'junit.xml'), '<testsuites/>');
    writeFileSync(join(s.work, 'next-env.d.ts'), '// generated');

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');

    expect(s.store.task(first.id)?.status).toBe('merged');
    expect(latest(s)).toMatchObject({ id: 2, status: 'review' });
    expect(git(s.work, 'log', '-1', '--format=%s', first.branch)).toBe('Uncommitted work left by task #1');
    const kept = git(s.work, 'ls-tree', '-r', '--name-only', first.branch);
    expect(kept).toContain('reports/junit.xml');
    expect(kept).toContain('next-env.d.ts');
  });

  it('still refuses a dirty default branch', async () => {
    const s = setup();
    writeFileSync(join(s.work, 'mine.txt'), 'my own work');

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toMatchObject({
      status: 409,
      message: 'The checkout has uncommitted changes on main. Commit or discard them first.',
    });

    expect(git(s.work, 'status', '--porcelain')).toBe('?? mine.txt');
    expect(s.store.latestTask('demo')).toBeNull();
  });

  it('still refuses a dirty branch that is not a build/ branch, even after a task closed', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')]] });
    const first = await run(s);
    await s.svc.close('demo', first.id);
    git(s.work, 'checkout', '-b', 'feature/mine', 'main');
    writeFileSync(join(s.work, 'mine.txt'), 'my own work');

    await expect(s.svc.send('demo', 'Another')).rejects.toMatchObject({
      status: 409,
      message: 'The checkout has uncommitted changes on feature/mine. Commit or discard them first.',
    });

    expect(git(s.work, 'status', '--porcelain')).toBe('?? mine.txt');
    expect(git(s.work, 'branch', '--show-current')).toBe('feature/mine');
  });

  it('still refuses a dirty build/ branch that belongs to no task', async () => {
    const s = setup();
    git(s.work, 'checkout', '-b', 'build/unknown-7', 'main');
    writeFileSync(join(s.work, 'mine.txt'), 'my own work');

    await expect(s.svc.send('demo', 'Add a notes file')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('uncommitted changes on build/unknown-7'),
    });

    expect(git(s.work, 'status', '--porcelain')).toBe('?? mine.txt');
  });

  it('a failed commit of the leftovers is a 409 and starts no task', async () => {
    let rejecting = false;
    const s = setup({
      scripts: [[write('a.txt'), done('s1')]],
      openRepo: repoWith((real) => ({
        async commitAll(message) {
          if (rejecting) throw new Error('hook rejected the commit');
          return real.commitAll(message);
        },
      })),
    });
    const first = await run(s);
    s.github.markMerged(1);
    writeFileSync(join(s.work, 'left.txt'), 'x');
    rejecting = true;

    await expect(s.svc.send('demo', 'More')).rejects.toMatchObject({
      status: 409,
      message: 'Git: hook rejected the commit',
    });

    expect(latest(s).id).toBe(first.id);
    expect(s.svc.isRunning('demo')).toBe(false);
  });
});

describe('BuildService fetch on a continued task', () => {
  /** Moves origin/main on GitHub's side, from another clone. Returns the new tip. */
  function advanceOriginMain(s: Setup): string {
    const other = join(dirname(s.origin), 'other');
    git(dirname(s.origin), 'clone', s.origin, other);
    writeFileSync(join(other, 'upstream.txt'), 'upstream\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'upstream change');
    git(other, 'push', 'origin', 'main');
    return git(s.origin, 'rev-parse', 'main');
  }

  it('refreshes origin/<base> before Claude continues, so Claude sees the real base', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    await run(s);
    const tip = advanceOriginMain(s);
    expect(git(s.work, 'rev-parse', 'origin/main')).not.toBe(tip);

    await s.svc.send('demo', 'More');
    await s.svc.idle('demo');

    expect(git(s.work, 'rev-parse', 'origin/main')).toBe(tip);
  });

  it('a failed fetch is logged in one line and does not fail the send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let failFetch = false;
    const s = setup({
      scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]],
      openRepo: repoWith(() => ({
        async fetch() {
          if (failFetch) throw new Error('could not resolve host');
        },
      })),
    });
    const first = await run(s);
    failFetch = true;

    await s.svc.send('demo', 'More');
    await s.svc.idle('demo');

    expect(latest(s)).toMatchObject({ id: first.id, status: 'review' });
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('fetch'))).toEqual(['Build fetch for demo failed: could not resolve host']);
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
    expect(feed(s)).toContainEqual([
      'status',
      'Task closed. The pull request stays open on GitHub. The next message starts a new branch.',
    ]);
    expect(lastTaskMsg(s)).toMatchObject({ running: false, task: { id: first.id, status: 'closed' } });
    // Closing is local: it does not touch the pull request.
    expect(s.github.calls).not.toContain('closePr');
    expect(s.github.prs.get(1)?.state).toBe('open');

    await s.svc.send('demo', 'Add a notes file');
    await s.svc.idle('demo');
    expect(latest(s)).toMatchObject({ id: 2, branch: 'build/add-a-notes-file-2' });
  });

  it('close of a task that never opened a pull request does not mention one', async () => {
    const s = setup({ scripts: [[untilAborted, done('s1')]] });
    await s.svc.send('demo', 'Add a notes file');
    s.svc.stop('demo');
    await s.svc.idle('demo');
    const task = latest(s);
    expect(task.prNumber).toBeNull();

    await s.svc.close('demo', task.id);

    expect(feed(s)).toContainEqual(['status', 'Task closed. The next message starts a new branch.']);
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

  it('does not ask GitHub while a send has the app, even before Claude starts', async () => {
    const checkingOut = deferred();
    const gate = deferred();
    let slow = false;
    const s = setup({
      scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]],
      openRepo: repoWith((real) => ({
        checkout: async (branch: string) => {
          if (slow) {
            checkingOut.resolve();
            await gate.promise;
          }
          return real.checkout(branch);
        },
      })),
    });
    await run(s);
    s.github.setChecks('head-1', [{ name: 'ci', status: 'in_progress', conclusion: null }]);
    git(s.work, 'checkout', 'main');
    slow = true;

    // The task is still `review` with pending CI while the send checks out its branch.
    const sending = s.svc.send('demo', 'More work');
    await checkingOut.promise;
    expect(s.store.openTask('demo')).toMatchObject({ status: 'review', ci: 'pending' });
    const calls = s.github.calls.length;
    const snapshot = await s.svc.state('demo');

    expect(snapshot).toMatchObject({ running: true, task: { status: 'review', ci: 'pending' } });
    expect(s.github.calls).toHaveLength(calls);

    gate.resolve();
    await sending;
    await s.svc.idle('demo');
  });

  it('does not ask GitHub again once CI is known', async () => {
    const s = setup();
    await run(s);
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

const PASSED = 'CI passed. Ready to merge.';

function passes(s: Setup): number {
  return s.store.messages('demo').filter((m) => m.text === PASSED).length;
}

/** Makes GitHub's PR read wait for `gate`, and returns the spy that counts the reads. */
function gatePrReads(s: Setup, gate: Deferred) {
  const getPr = s.github.getPr.bind(s.github);
  return vi.spyOn(s.github, 'getPr').mockImplementation(async (r, n) => {
    await gate.promise;
    return getPr(r, n);
  });
}

/** A review task of another app with a pending PR 2 whose GitHub read can be held. */
function otherAppReview(s: Setup): BuildTask {
  const other = s.store.createTask({ app: 'other', title: 'other', branch: 'build/other-1', base: 'main' });
  return s.store.updateTask(other.id, { status: 'review', prNumber: 2, headSha: 'head-2', ci: 'pending' });
}

describe('BuildService CI refresh', () => {
  it('announces a green PR once for concurrent state() calls and a poll', async () => {
    const s = setup();
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);

    await Promise.all([s.svc.state('demo'), s.svc.state('demo'), s.svc.pollCi()]);

    expect(passes(s)).toBe(1);
    expect(s.store.task(task.id)?.ci).toBe('success');
  });

  it('reads GitHub once for two state() calls on one task and announces once', async () => {
    const s = setup();
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);
    const gate = deferred();
    const reads = gatePrReads(s, gate);

    const first = s.svc.state('demo');
    const second = s.svc.state('demo');
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.task?.ci).toBe('success');
    expect(b.task?.ci).toBe('success');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(passes(s)).toBe(1);
    expect(s.store.task(task.id)?.ci).toBe('success');
  });

  it('shares one GitHub read between two state() calls and a poll that starts during it', async () => {
    const s = setup();
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);
    const gate = deferred();
    const reads = gatePrReads(s, gate);

    const first = s.svc.state('demo');
    const second = s.svc.state('demo');
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    const poll = s.svc.pollCi();
    gate.resolve();
    const [a, b] = await Promise.all([first, second, poll]);

    expect(a.task?.ci).toBe('success');
    expect(b.task?.ci).toBe('success');
    expect(passes(s)).toBe(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(s.store.task(task.id)?.ci).toBe('success');
  });

  it('shares the poll\'s read with a state() call that arrives while it is in flight', async () => {
    const s = setup();
    await run(s);
    s.github.setChecks('head-1', GREEN);
    const gate = deferred();
    const reads = gatePrReads(s, gate);

    const poll = s.svc.pollCi();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    const state = s.svc.state('demo');
    gate.resolve();
    const [snapshot] = await Promise.all([state, poll]);

    expect(snapshot.task?.ci).toBe('success');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(passes(s)).toBe(1);
  });

  it('a second poll pass joins the one in flight', async () => {
    const s = setup();
    await run(s);
    s.github.setChecks('head-1', GREEN);
    const gate = deferred();
    const reads = gatePrReads(s, gate);

    const first = s.svc.pollCi();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    const second = s.svc.pollCi();
    gate.resolve();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(passes(s)).toBe(1);
    // The pass is over, so the next one starts fresh.
    await s.svc.pollCi();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('a send on one app is not held up by a hung GitHub read for another app', async () => {
    const s = setup({
      scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]],
      extraApps: ['other'],
    });
    await run(s);
    otherAppReview(s);
    const hang = deferred();
    const getPr = s.github.getPr.bind(s.github);
    const reads = vi.spyOn(s.github, 'getPr').mockImplementation(async (r, n) => {
      if (n === 2) {
        await hang.promise;
        throw new Error('released');
      }
      return getPr(r, n);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const poll = s.svc.pollCi();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(expect.anything(), 2));
    // A flag, not a timed race: the send must finish while the poll is still hung, however slow the machine is.
    let sent = false;
    const sending = s.svc.send('demo', 'More work').then(() => {
      sent = true;
    });
    await vi.waitFor(() => expect(sent).toBe(true), { timeout: 10_000 });
    const snapshot = await s.svc.state('demo');

    expect(snapshot.running).toBe(true);
    await sending;
    hang.resolve();
    await poll;
    await s.svc.idle('demo');
    expect(latest(s)).toMatchObject({ app: 'demo', status: 'review' });
  });

  it('a state() call on one app is not held up by a hung GitHub read for another app', async () => {
    const s = setup({ extraApps: ['other'] });
    const task = await run(s);
    s.github.setChecks('head-1', [{ name: 'ci', status: 'in_progress', conclusion: null }]);
    otherAppReview(s);
    const hang = deferred();
    const getPr = s.github.getPr.bind(s.github);
    const reads = vi.spyOn(s.github, 'getPr').mockImplementation(async (r, n) => {
      if (n === 2) {
        await hang.promise;
        throw new Error('released');
      }
      return getPr(r, n);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The poll refreshes demo first, then hangs on the other app.
    const poll = s.svc.pollCi();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(expect.anything(), 2));
    // A flag, not a timed race: state() must answer while the poll is still hung, however slow the machine is.
    let snapshot: BuildState | null = null;
    const reading = s.svc.state('demo').then((answer) => {
      snapshot = answer;
    });
    await vi.waitFor(() => expect(snapshot).not.toBeNull(), { timeout: 10_000 });

    // CI is still pending, so state() reads GitHub itself while the poll is stuck on the other app:
    // one read from the poll, one from state().
    expect((snapshot as BuildState | null)?.task).toMatchObject({ id: task.id, status: 'review', ci: 'pending' });
    expect(reads.mock.calls.filter(([, n]) => n === 1)).toHaveLength(2);
    await reading;
    hang.resolve();
    await poll;
  });

  it('a refresh that fails leaves no flight behind, so the next call reads GitHub again', async () => {
    const s = setup();
    const task = await run(s);
    s.github.setChecks('head-1', GREEN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The flight itself rejects (the store throws before any read); refreshCi's own errors are caught inside it.
    vi.spyOn(s.store, 'task').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const failed = await s.svc.state('demo');

    expect(failed.task?.ci).toBe('pending');
    expect(warn).toHaveBeenCalledWith('Build state refresh for demo failed: database is locked');

    const retried = await s.svc.state('demo');

    expect(retried.task?.ci).toBe('success');
    expect(s.store.task(task.id)?.ci).toBe('success');
  });

  it('a send that refreshes the task keeps state() from reading GitHub, and reads once', async () => {
    const s = setup({ scripts: [[write('a.txt'), done('s1')], [write('b.txt'), done('s1')]] });
    await run(s);
    s.github.setChecks('head-1', GREEN);
    const gate = deferred();
    const reads = gatePrReads(s, gate);

    const sending = s.svc.send('demo', 'More work');
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    // The send holds the app, so state() answers from the store without a read of its own.
    const snapshot = await s.svc.state('demo');
    expect(snapshot.running).toBe(true);
    gate.resolve();
    await sending;
    await s.svc.idle('demo');

    expect(reads).toHaveBeenCalledTimes(1);
    expect(passes(s)).toBe(1);
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
