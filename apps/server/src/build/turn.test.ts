import type { BuildTask, ServerMsg } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClaudeRunner, type FakeStep } from '../claude/fake.js';
import { type Db, openDb } from '../db.js';
import type { BuildDeps } from './deps.js';
import { BuildStore } from './store.js';
import { queueAfterLimit, runTurn, type TurnInput } from './turn.js';

let t = 1000;
const opened: Db[] = [];

beforeEach(() => {
  t = 1000;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function setup(scripts: FakeStep[][]) {
  const db = openDb(':memory:');
  opened.push(db);
  const store = new BuildStore(db, () => t);
  const hub = {
    sent: [] as ServerMsg[],
    broadcast(m: ServerMsg): void {
      this.sent.push(m);
    },
  };
  const runner = new FakeClaudeRunner(scripts);
  const deps: BuildDeps = {
    store,
    runner,
    hub,
    registry: { get: async () => null },
    openRepo: () => {
      throw new Error('unused');
    },
    github: null,
    runCommand: async () => ({ ok: true, code: 0, output: '', timedOut: false, aborted: false }),
    now: () => t,
  };
  const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/x-1', base: 'main' });
  return { deps, store, hub, runner, task };
}

function turnInput(taskId: number): TurnInput {
  return {
    app: 'demo',
    taskId,
    cwd: '/r',
    branch: 'build/x-1',
    prompt: 'p',
    signal: new AbortController().signal,
  };
}

describe('runTurn', () => {
  it('streams text and tools as messages', async () => {
    const { deps, store, hub, task } = setup([
      [
        { type: 'text', text: 'Looking' },
        { type: 'tool', name: 'Edit', input: { file_path: '/r/a.ts' } },
        { type: 'done', sessionId: 's1', ok: true },
      ],
    ]);

    const result = await runTurn(deps, turnInput(task.id));

    expect(store.messages('demo').map((m) => [m.kind, m.text])).toEqual([
      ['assistant', 'Looking'],
      ['tool', 'Edit a.ts'],
    ]);
    expect(hub.sent.filter((m) => m.type === 'build.message')).toHaveLength(2);
    expect(result).toEqual({ ok: true, error: null, limited: false, resetsAtMs: null });
    expect(store.chatSession('demo')).toBe('s1');
  });

  it('resumes the chat session', async () => {
    const { deps, store, runner, task } = setup([[{ type: 'done', sessionId: 's1', ok: true }]]);
    store.setChatSession('demo', 's0');

    await runTurn(deps, turnInput(task.id));

    expect(runner.calls[0]?.resume).toBe('s0');
    expect(runner.calls[0]?.systemPrompt).toContain('build/x-1');
  });

  it('stale session falls back to a fresh one', async () => {
    const { deps, store, runner, task } = setup([
      [{ type: 'done', sessionId: '', ok: false, error: 'No conversation found' }],
      [
        { type: 'text', text: 'Hi' },
        { type: 'done', sessionId: 's2', ok: true },
      ],
    ]);
    store.setChatSession('demo', 'old');

    const result = await runTurn(deps, turnInput(task.id));

    expect(runner.calls[0]?.resume).toBe('old');
    expect(runner.calls[1]?.resume).toBeUndefined();
    expect(
      store.messages('demo').some((m) => m.kind === 'status' && m.text.includes('starting a new one')),
    ).toBe(true);
    expect(store.chatSession('demo')).toBe('s2');
    expect(result.ok).toBe(true);
  });

  it('does not retry after real work', async () => {
    const { deps, store, runner, task } = setup([
      [
        { type: 'text', text: 'x' },
        { type: 'done', sessionId: '', ok: false, error: 'boom' },
      ],
    ]);
    store.setChatSession('demo', 'old');

    const result = await runTurn(deps, turnInput(task.id));

    expect(runner.calls).toHaveLength(1);
    expect(result).toEqual({ ok: false, error: 'boom', limited: false, resetsAtMs: null });
  });

  it('usage limit is reported, not retried', async () => {
    const { deps, store, runner, task } = setup([
      [{ type: 'done', sessionId: '', ok: false, error: 'usage_limit:1760000000000' }],
    ]);
    store.setChatSession('demo', 'old');

    const result = await runTurn(deps, turnInput(task.id));

    expect(result).toEqual({
      ok: false,
      error: 'usage_limit:1760000000000',
      limited: true,
      resetsAtMs: 1760000000000,
    });
    expect(runner.calls).toHaveLength(1);
  });

  it('queueAfterLimit queues with the reset time', () => {
    const { deps, store, hub, task } = setup([]);

    const queued = queueAfterLimit(deps, task, 'p', {
      ok: false,
      error: 'usage_limit:1760000000000',
      limited: true,
      resetsAtMs: 1760000000000,
    });

    expect(queued.status).toBe('queued');
    expect(queued.retryAt).toBe(1760000000000);
    expect(store.pendingPrompt(task.id)).toBe('p');
    expect(store.messages('demo').at(-1)?.text).toContain('retry at');
    expect(hub.sent.at(-1)).toEqual({ type: 'build.task', app: 'demo', task: queued, running: false });

    const fallback: BuildTask = queueAfterLimit(deps, task, 'p', {
      ok: false,
      error: 'usage_limit',
      limited: true,
      resetsAtMs: null,
    });
    expect(fallback.retryAt).toBe(901000);
  });
});
