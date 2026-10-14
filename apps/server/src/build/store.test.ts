import type { BuildTask } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db.js';
import { BuildStore } from './store.js';

let t = 1000;
const opened: Db[] = [];

function setup(): BuildStore {
  const db = openDb(':memory:');
  opened.push(db);
  return new BuildStore(db, () => t);
}

beforeEach(() => {
  t = 1000;
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe('BuildStore', () => {
  it('creates a task in working state', () => {
    const store = setup();
    const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    expect(task).toEqual<BuildTask>({
      id: 1,
      app: 'demo',
      title: 'T',
      branch: 'build/t-1',
      base: 'main',
      status: 'working',
      prNumber: null,
      prUrl: null,
      headSha: null,
      ci: 'none',
      mergeSha: null,
      error: null,
      retryAt: null,
      createdAt: t,
      updatedAt: t,
    });
    expect(store.task(task.id)).toEqual(task);
    expect(store.task(99)).toBeNull();
  });

  it('openTask returns the newest open task', () => {
    const store = setup();
    const first = store.createTask({ app: 'demo', title: 'one', branch: 'build/one-1', base: 'main' });
    store.updateTask(first.id, { status: 'merged' });
    const second = store.createTask({ app: 'demo', title: 'two', branch: 'build/two-2', base: 'main' });
    expect(store.openTask('demo')?.id).toBe(second.id);
    expect(store.openTask('other')).toBeNull();
    store.updateTask(second.id, { status: 'closed' });
    expect(store.openTask('demo')).toBeNull();
  });

  it('updateTask patches only the given fields', () => {
    const store = setup();
    const created = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    t = 2000;
    const updated = store.updateTask(created.id, { status: 'review', prNumber: 3 });
    expect(updated).toEqual({ ...created, status: 'review', prNumber: 3, updatedAt: 2000 });
    expect(updated.title).toBe('T');
    expect(updated.updatedAt).toBe(t);
    expect(store.task(created.id)).toEqual(updated);
  });

  it('chat session round-trips', () => {
    const store = setup();
    expect(store.chatSession('demo')).toBeNull();
    store.setChatSession('demo', 'abc');
    expect(store.chatSession('demo')).toBe('abc');
    store.setChatSession('demo', null);
    expect(store.chatSession('demo')).toBeNull();
  });

  it('messages are ordered and paged by app', () => {
    const store = setup();
    for (let i = 0; i < 3; i++) {
      store.addMessage({ app: 'demo', taskId: null, kind: 'user', text: `m${i}` });
    }
    store.addMessage({ app: 'other', taskId: null, kind: 'user', text: 'elsewhere' });
    const page = store.messages('demo');
    const ids = page.map((message) => message.id);
    expect(page).toHaveLength(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(page.every((message) => message.app === 'demo' && message.at === t)).toBe(true);
    expect(store.messages('demo', ids[0])).toHaveLength(2);
  });

  it('default page is the newest 500', () => {
    const store = setup();
    for (let i = 0; i < 502; i++) {
      store.addMessage({ app: 'demo', taskId: null, kind: 'assistant', text: String(i) });
    }
    const page = store.messages('demo');
    expect(page).toHaveLength(500);
    expect(page[0]?.id).toBe(3);
  });

  it('userPrompts lists the task user messages', () => {
    const store = setup();
    const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    const other = store.createTask({ app: 'demo', title: 'O', branch: 'build/o-2', base: 'main' });
    store.addMessage({ app: 'demo', taskId: task.id, kind: 'user', text: 'first' });
    store.addMessage({ app: 'demo', taskId: task.id, kind: 'assistant', text: 'reply' });
    store.addMessage({ app: 'demo', taskId: other.id, kind: 'user', text: 'elsewhere' });
    store.addMessage({ app: 'demo', taskId: task.id, kind: 'user', text: 'second' });
    expect(store.userPrompts(task.id)).toEqual(['first', 'second']);
  });

  it('pending prompt round-trips through updateTask', () => {
    const store = setup();
    const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    expect(store.pendingPrompt(task.id)).toBeNull();
    store.updateTask(task.id, { pendingPrompt: 'do it' });
    expect(store.pendingPrompt(task.id)).toBe('do it');
    expect(store.task(task.id)).not.toHaveProperty('pendingPrompt');
    store.updateTask(task.id, { pendingPrompt: null });
    expect(store.pendingPrompt(task.id)).toBeNull();
  });

  it('tasksWithStatus and latestTask', () => {
    const store = setup();
    const a = store.createTask({ app: 'demo', title: 'a', branch: 'build/a-1', base: 'main' });
    const b = store.createTask({ app: 'demo', title: 'b', branch: 'build/b-2', base: 'main' });
    const c = store.createTask({ app: 'demo', title: 'c', branch: 'build/c-3', base: 'main' });
    store.updateTask(a.id, { status: 'queued' });
    store.updateTask(b.id, { status: 'merged' });
    store.updateTask(c.id, { status: 'failed' });
    expect(store.tasksWithStatus(['queued', 'failed']).map((task) => task.id)).toEqual([a.id, c.id]);
    expect(store.tasksWithStatus([])).toEqual([]);
    expect(store.latestTask('demo')?.id).toBe(c.id);
    expect(store.latestTask('none')).toBeNull();
  });

  it('updateTask throws on an unknown id and changes nothing', () => {
    const store = setup();
    const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    expect(() => store.updateTask(99, { status: 'closed' })).toThrow('build task 99 not found');
    expect(store.task(task.id)).toEqual(task);
  });

  it('messages: limit applies with and without afterId', () => {
    const store = setup();
    for (let i = 1; i <= 6; i++) {
      store.addMessage({ app: 'demo', taskId: null, kind: 'user', text: `m${i}` });
    }
    // Without afterId: the newest `limit`, ascending.
    expect(store.messages('demo', undefined, 2).map((m) => m.text)).toEqual(['m5', 'm6']);
    // With afterId: the first `limit` after it, ascending.
    expect(store.messages('demo', 2, 2).map((m) => m.text)).toEqual(['m3', 'm4']);
    expect(store.messages('demo', 5, 10).map((m) => m.text)).toEqual(['m6']);
    expect(store.messages('demo', 6, 10)).toEqual([]);
    expect(store.messages('demo', undefined, 100)).toHaveLength(6);
  });

  it('taskForBranch finds the newest task on a branch of one app, whatever its status', () => {
    const store = setup();
    const a = store.createTask({ app: 'demo', title: 'a', branch: 'build/a-1', base: 'main' });
    store.createTask({ app: 'other', title: 'a', branch: 'build/a-1', base: 'main' });
    store.updateTask(a.id, { status: 'merged' });
    expect(store.taskForBranch('demo', 'build/a-1')?.id).toBe(a.id);
    expect(store.taskForBranch('demo', 'build/a-1')?.status).toBe('merged');
    expect(store.taskForBranch('demo', 'build/zzz-9')).toBeNull();
    expect(store.taskForBranch('none', 'build/a-1')).toBeNull();
  });

  it('pushed sha round-trips through updateTask and is not part of the task', () => {
    const store = setup();
    const task = store.createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' });
    expect(store.pushedSha(task.id)).toBeNull();
    store.updateTask(task.id, { pushedSha: 'abc123' });
    expect(store.pushedSha(task.id)).toBe('abc123');
    expect(store.task(task.id)).not.toHaveProperty('pushedSha');
    // headSha follows GitHub and is a different record.
    store.updateTask(task.id, { headSha: 'def456' });
    expect(store.pushedSha(task.id)).toBe('abc123');
    expect(store.pushedSha(404)).toBeNull();
  });
});
