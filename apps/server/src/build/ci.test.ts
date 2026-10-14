import type { BuildTask, ServerMsg } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClaudeRunner } from '../claude/fake.js';
import { type Db, openDb } from '../db.js';
import type { GitRepo } from '../git/git.js';
import { FakeGitHub } from '../github/fake.js';
import { BuildError, mergeTask, pollCi, refreshCi } from './ci.js';
import type { BuildDeps } from './deps.js';
import { BuildStore } from './store.js';

let t = 1000;
const opened: Db[] = [];

beforeEach(() => {
  t = 1000;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  vi.restoreAllMocks();
});

function setup() {
  const db = openDb(':memory:');
  opened.push(db);
  const store = new BuildStore(db, () => t);
  const sent: ServerMsg[] = [];
  const hub = {
    broadcast(m: ServerMsg): void {
      sent.push(m);
    },
  };
  const github = new FakeGitHub();
  const onMerged = vi.fn();
  const deps: BuildDeps = {
    store,
    runner: new FakeClaudeRunner([]),
    hub,
    registry: {
      get: async (name: string) =>
        name === 'demo' ? { name: 'demo', dir: '/w', adopted: true, manifest: null, manifestError: null } : null,
    },
    openRepo: () => ({ remoteUrl: async () => 'https://github.com/acme/demo.git' }) as unknown as GitRepo,
    github,
    runCommand: async () => {
      throw new Error('unused');
    },
    now: () => t,
    onMerged,
  };
  return { deps, store, sent, github, onMerged };
}

type Setup = ReturnType<typeof setup>;

/** A review task whose PR is number 1, with its head at `h1` and CI pending. */
async function reviewTask(s: Setup): Promise<BuildTask> {
  const pr = await s.github.createPr(
    { owner: 'acme', repo: 'demo' },
    { head: 'build/demo-1', base: 'main', title: 'Demo', body: '' },
  );
  s.github.movePrHead(pr.number, 'h1');
  s.github.calls.splice(0); // setup calls are not part of the behaviour under test
  const task = s.store.createTask({ app: 'demo', title: 'T', branch: 'build/demo-1', base: 'main' });
  return s.store.updateTask(task.id, {
    status: 'review',
    prNumber: pr.number,
    prUrl: pr.url,
    headSha: 'h1',
    ci: 'pending',
  });
}

function messagesOf(s: Setup): [string, string][] {
  return s.store.messages('demo').map((m) => [m.kind, m.text]);
}

async function caught(promise: Promise<unknown>): Promise<BuildError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BuildError) return err;
    throw err;
  }
  throw new Error('expected a BuildError');
}

const GREEN = [{ name: 'test', status: 'completed', conclusion: 'success' }];
const PENDING = [{ name: 'test', status: 'in_progress', conclusion: null }];

describe('refreshCi', () => {
  it('records green CI and announces it', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);

    const refreshed = await refreshCi(s.deps, task.id);

    expect(refreshed?.ci).toBe('success');
    expect(s.store.task(task.id)?.ci).toBe('success');
    expect(messagesOf(s)).toEqual([['status', 'CI passed. Ready to merge.']]);
  });

  it('names failed checks', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', [{ name: 'test', status: 'completed', conclusion: 'failure' }]);

    await refreshCi(s.deps, task.id);

    expect(s.store.task(task.id)?.ci).toBe('failure');
    expect(messagesOf(s)).toEqual([['error', 'CI failed: test']]);
  });

  it('detects a PR merged on GitHub', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.markMerged(1);

    const refreshed = await refreshCi(s.deps, task.id);

    expect(refreshed).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.store.task(task.id)).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(messagesOf(s)).toEqual([['status', 'Pull request #1 was merged on GitHub.']]);
    expect(s.onMerged).toHaveBeenCalledWith({ app: 'demo', taskId: task.id, prNumber: 1, sha: 'merged-1' });
  });

  it('detects a closed PR', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.closePr(1);

    await refreshCi(s.deps, task.id);

    expect(s.store.task(task.id)?.status).toBe('closed');
    expect(messagesOf(s)).toEqual([['status', 'Pull request #1 was closed.']]);
    expect(s.onMerged).not.toHaveBeenCalled();
  });

  it('leaves the task unchanged when GitHub is not configured', async () => {
    const s = setup();
    const task = await reviewTask(s);

    const refreshed = await refreshCi({ ...s.deps, github: null }, task.id);

    expect(refreshed).toEqual(task);
    expect(s.github.calls).toEqual([]);
  });

  it('leaves the task unchanged when its app has no GitHub remote entry', async () => {
    const s = setup();
    const task = await reviewTask(s);

    const refreshed = await refreshCi({ ...s.deps, registry: { get: async () => null } }, task.id);

    expect(refreshed).toEqual(task);
    expect(s.github.calls).toEqual([]);
  });

  it('returns null for a missing task and leaves a task that is not in review alone', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.store.updateTask(task.id, { status: 'working' });

    expect(await refreshCi(s.deps, 999)).toBeNull();
    expect(await refreshCi(s.deps, task.id)).toMatchObject({ status: 'working' });
    expect(s.github.calls).toEqual([]);
  });

  it('keeps the stored task when GitHub errors', async () => {
    const s = setup();
    const task = await reviewTask(s);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(s.github, 'getPr').mockRejectedValueOnce(new Error('Bad credentials'));

    const refreshed = await refreshCi(s.deps, task.id);

    expect(refreshed).toEqual(task);
    expect(warn).toHaveBeenCalled();
    expect(messagesOf(s)).toEqual([]);
  });
});

describe('mergeTask', () => {
  it('merges a green PR and pins the PR head sha', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);

    const merged = await mergeTask(s.deps, 'demo', task.id, false);

    expect(s.github.merges).toEqual([{ number: 1, sha: 'h1' }]);
    expect(merged).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.store.task(task.id)).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.onMerged).toHaveBeenCalledWith({ app: 'demo', taskId: task.id, prNumber: 1, sha: 'merged-1' });
  });

  it('refuses while CI is pending', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', PENDING);

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toContain('pending');
    expect(s.github.merges).toEqual([]);
  });

  it('refuses with no checks', async () => {
    const s = setup();
    const task = await reviewTask(s);

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toContain('not reporting any checks');
    expect(s.github.merges).toEqual([]);
  });

  it('rechecks CI on the current head', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    s.github.movePrHead(1, 'h2');
    s.github.setChecks('h2', PENDING);

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(s.github.merges).toEqual([]);
    expect(s.store.task(task.id)?.headSha).toBe('h2');
  });

  it('merges the current head when the stored head is stale', async () => {
    const s = setup();
    const task = await reviewTask(s); // stored head is h1
    s.github.movePrHead(1, 'h2');
    s.github.setChecks('h2', GREEN);

    const merged = await mergeTask(s.deps, 'demo', task.id, false);

    expect(s.github.merges).toEqual([{ number: 1, sha: 'h2' }]);
    expect(merged).toMatchObject({ status: 'merged' });
  });

  it('refuses when a push lands between the CI read and the merge', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    const realCheckStatus = s.github.checkStatus.bind(s.github);
    vi.spyOn(s.github, 'checkStatus').mockImplementationOnce(async (r, sha) => {
      const status = await realCheckStatus(r, sha);
      s.github.movePrHead(1, 'h2'); // a push lands after CI was read for h1
      return status;
    });

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toContain('GitHub refused the merge');
    expect(s.github.merges).toEqual([]);
    expect(s.store.task(task.id)?.status).toBe('review');
  });

  it('refuses while Claude is running', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);

    const err = await caught(mergeTask(s.deps, 'demo', task.id, true));

    expect(err.status).toBe(409);
    expect(err.message).toBe('Claude is still working on this app.');
    expect(s.github.merges).toEqual([]);
  });

  it('is 404 for an unknown task or a task of another app', async () => {
    const s = setup();
    const task = await reviewTask(s);

    expect((await caught(mergeTask(s.deps, 'demo', 999, false))).status).toBe(404);
    expect((await caught(mergeTask(s.deps, 'other', task.id, false))).status).toBe(404);
  });

  it('returns a merged task unchanged without merging again', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    await mergeTask(s.deps, 'demo', task.id, false);

    const again = await mergeTask(s.deps, 'demo', task.id, false);

    expect(again).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.github.merges).toHaveLength(1);
  });

  it('records a PR merged on GitHub without merging again', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.markMerged(1);

    const merged = await mergeTask(s.deps, 'demo', task.id, false);

    expect(merged).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.github.merges).toEqual([]);
    expect(s.onMerged).toHaveBeenCalledWith({ app: 'demo', taskId: task.id, prNumber: 1, sha: 'merged-1' });
  });

  it('marks a closed PR closed and refuses', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.closePr(1);

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toBe('The pull request is closed.');
    expect(s.store.task(task.id)?.status).toBe('closed');
  });

  it('refuses when GitHub refuses the merge', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    vi.spyOn(s.github, 'merge').mockResolvedValueOnce({
      merged: false,
      sha: null,
      message: 'Required status check is expected.',
    });

    const err = await caught(mergeTask(s.deps, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toBe('GitHub refused the merge: Required status check is expected.');
    expect(s.store.task(task.id)).toMatchObject({ status: 'review' });
    expect(s.onMerged).not.toHaveBeenCalled();
  });

  it('refuses without GitHub', async () => {
    const s = setup();
    const task = await reviewTask(s);

    const err = await caught(mergeTask({ ...s.deps, github: null }, 'demo', task.id, false));

    expect(err.status).toBe(409);
    expect(err.message).toBe('GITHUB_TOKEN is not set.');
  });
});

describe('a merge is recorded once', () => {
  it('fires onMerged once for a PR already recorded merged', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.markMerged(1);

    await refreshCi(s.deps, task.id);
    await mergeTask(s.deps, 'demo', task.id, false);
    await refreshCi(s.deps, task.id);

    expect(s.onMerged).toHaveBeenCalledTimes(1);
  });

  it('fires onMerged once when a poll records the merge while the merge is in flight', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    const realMerge = s.github.merge.bind(s.github);
    vi.spyOn(s.github, 'merge').mockImplementationOnce(async (r, n, sha) => {
      const out = await realMerge(r, n, sha);
      await refreshCi(s.deps, task.id); // a poll reads the merge from GitHub first
      return out;
    });

    const merged = await mergeTask(s.deps, 'demo', task.id, false);

    expect(merged).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.onMerged).toHaveBeenCalledTimes(1);
  });

  it('fires onMerged once when a merge lands while a poll reads GitHub', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', GREEN);
    const realGetPr = s.github.getPr.bind(s.github);
    vi.spyOn(s.github, 'getPr').mockImplementationOnce(async (r, n) => {
      await mergeTask(s.deps, 'demo', task.id, false); // the merge lands during the poll's read
      return realGetPr(r, n);
    });

    await refreshCi(s.deps, task.id);

    expect(s.store.task(task.id)).toMatchObject({ status: 'merged', mergeSha: 'merged-1' });
    expect(s.onMerged).toHaveBeenCalledTimes(1);
  });
});

describe('pollCi', () => {
  it('skips running apps', async () => {
    const s = setup();
    await reviewTask(s);

    await pollCi(s.deps, () => true);

    expect(s.github.calls).toEqual([]);
  });

  it('stops checking a status that stays pending after 120 polls', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', PENDING);

    for (let poll = 0; poll < 120; poll += 1) {
      await pollCi(s.deps, () => false);
    }
    expect(s.github.calls.filter((call) => call === 'checkStatus')).toHaveLength(120);

    await pollCi(s.deps, () => false);
    await pollCi(s.deps, () => false);

    expect(s.github.calls.filter((call) => call === 'checkStatus')).toHaveLength(120);
    expect(s.store.task(task.id)).toMatchObject({ status: 'review', ci: 'pending', headSha: 'h1' });
  });

  it('resumes polling when the task gets a new head', async () => {
    const s = setup();
    const task = await reviewTask(s);
    s.github.setChecks('h1', PENDING);
    for (let poll = 0; poll < 120; poll += 1) {
      await pollCi(s.deps, () => false);
    }

    // A new turn's finish stores the new head and pending CI.
    s.github.movePrHead(1, 'h2');
    s.store.updateTask(task.id, { headSha: 'h2', ci: 'pending' });
    s.github.setChecks('h2', GREEN);
    await pollCi(s.deps, () => false);

    expect(s.store.task(task.id)).toMatchObject({ ci: 'success', headSha: 'h2' });
  });
});
