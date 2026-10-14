import { describe, expect, it } from 'vitest';
import type { BuildMessage, BuildState, BuildTask } from '@hub/protocol';
import { EMPTY_VIEW, MAX_VIEW_MESSAGES, applyServerMsg, applyState, lastMessageId, summarizeTask } from './state.js';
import type { BuildView } from './state.js';

const APP = 'demo';

function msg(id: number, app = APP): BuildMessage {
  return { id, app, taskId: null, kind: 'assistant', text: `m${id}`, at: id };
}

function task(overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id: 1,
    app: APP,
    title: 'Fix',
    branch: 'build/demo-1',
    base: 'main',
    status: 'working',
    prNumber: null,
    prUrl: null,
    headSha: null,
    ci: 'none',
    mergeSha: null,
    error: null,
    retryAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function view(messages: BuildMessage[] = [], extra: Partial<BuildView> = {}): BuildView {
  return { ...EMPTY_VIEW, messages, ...extra };
}

const ids = (v: BuildView) => v.messages.map((m) => m.id);

describe('Build view state', () => {
  it('applyState dedupes messages already shown', () => {
    const s: BuildState = { running: true, task: null, messages: [msg(2), msg(3)] };
    const next = applyState(view([msg(1), msg(2)]), s);
    expect(ids(next)).toEqual([1, 2, 3]);
    expect(next.loaded).toBe(true);
    expect(next.running).toBe(true);
  });

  it('out-of-order messages are sorted', () => {
    let v = applyServerMsg(EMPTY_VIEW, APP, { type: 'build.message', app: APP, message: msg(3) });
    v = applyServerMsg(v, APP, { type: 'build.message', app: APP, message: msg(2) });
    expect(ids(v)).toEqual([2, 3]);
  });

  it('other apps are ignored', () => {
    const v = view([msg(1)]);
    expect(applyServerMsg(v, APP, { type: 'build.message', app: 'other', message: msg(2, 'other') })).toBe(v);
    expect(applyServerMsg(v, APP, { type: 'build.task', app: 'other', task: task({ app: 'other', id: 9 }), running: true })).toBe(v);
  });

  it('an older task update is ignored, and a newer task id replaces it', () => {
    const current = view([], { task: task({ id: 5, updatedAt: 50 }) });

    const older = applyServerMsg(current, APP, { type: 'build.task', app: APP, task: task({ id: 4, status: 'merged', updatedAt: 99 }), running: false });
    expect(older.task?.id).toBe(5);

    const sameIdStale = applyServerMsg(current, APP, { type: 'build.task', app: APP, task: task({ id: 5, status: 'failed', updatedAt: 10 }), running: false });
    expect(sameIdStale.task?.status).toBe('working');

    const sameIdFresh = applyServerMsg(current, APP, { type: 'build.task', app: APP, task: task({ id: 5, status: 'review', updatedAt: 50 }), running: false });
    expect(sameIdFresh.task?.status).toBe('review');

    const newer = applyServerMsg(current, APP, { type: 'build.task', app: APP, task: task({ id: 6, status: 'review' }), running: false });
    expect(newer.task?.id).toBe(6);
  });

  it('build.task sets running', () => {
    const v = applyServerMsg(EMPTY_VIEW, APP, { type: 'build.task', app: APP, task: task(), running: true });
    expect(v.running).toBe(true);
    expect(v.task?.id).toBe(1);
    const done = applyServerMsg(v, APP, { type: 'build.task', app: APP, task: task({ updatedAt: 2 }), running: false });
    expect(done.running).toBe(false);
  });

  it('keeps the newest 1000 messages', () => {
    const all = Array.from({ length: MAX_VIEW_MESSAGES + 5 }, (_, i) => msg(i + 1));
    const v = applyState(EMPTY_VIEW, { running: false, task: null, messages: all });
    expect(v.messages).toHaveLength(1000);
    expect(v.messages[0]?.id).toBe(6);
    expect(lastMessageId(v)).toBe(MAX_VIEW_MESSAGES + 5);
  });

  it('lastMessageId is 0 when empty', () => {
    expect(lastMessageId(EMPTY_VIEW)).toBe(0);
    expect(lastMessageId(view([msg(1), msg(4)]))).toBe(4);
  });

  it('summarizeTask table', () => {
    expect(summarizeTask(task({ status: 'review', ci: 'success' }), false)).toEqual({ label: 'Ready to merge', tone: 'ok', canMerge: true, mergeHint: null });
    expect(summarizeTask(task({ status: 'review', ci: 'pending' }), false)).toEqual({
      label: 'Waiting for CI',
      tone: 'warn',
      canMerge: false,
      mergeHint: 'Merge unlocks when CI is green.',
    });
    expect(summarizeTask(task({ status: 'review', ci: 'success' }), true)).toMatchObject({ canMerge: false, mergeHint: 'Wait for Claude to finish.' });
    expect(summarizeTask(task({ status: 'review', ci: 'failure' }), false)).toEqual({
      label: 'CI failed',
      tone: 'error',
      canMerge: false,
      mergeHint: 'Fix CI before merging.',
    });
    expect(summarizeTask(task({ status: 'review', ci: 'none' }), false)).toEqual({
      label: 'No CI checks',
      tone: 'warn',
      canMerge: false,
      mergeHint: 'This repo reports no CI checks, so the Hub cannot merge it.',
    });
    expect(summarizeTask(task({ status: 'queued' }), false)).toMatchObject({ label: 'Queued (usage limit)', tone: 'warn' });
    expect(summarizeTask(task({ status: 'merged' }), false)).toMatchObject({ tone: 'done' });
    expect(summarizeTask(task({ status: 'working' }), true)).toMatchObject({ label: 'Claude is working', tone: 'busy', mergeHint: 'Wait for Claude to finish.' });
  });
});
