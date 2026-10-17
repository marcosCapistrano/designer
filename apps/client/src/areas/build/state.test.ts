import { describe, expect, it } from 'vitest';
import type { BuildMessage, BuildState, BuildTask } from '@hub/protocol';
import { EMPTY_VIEW, MAX_VIEW_MESSAGES, applyServerMsg, applyState, isRunStatus, lastMessageId, prLink, summarizeTask } from './state.js';
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

  // The interpretations below were chosen in Task 23 and are pinned here so a refactor cannot flip them silently.
  describe('stale and overlapping updates', () => {
    it('a stale build.task is ignored whole: its running flag does not leak in', () => {
      const current = view([], { task: task({ id: 5, updatedAt: 50, status: 'working' }), running: true });
      const stale = applyServerMsg(current, APP, { type: 'build.task', app: APP, task: task({ id: 5, status: 'failed', updatedAt: 10 }), running: false });
      expect(stale).toBe(current);
      expect(stale.running).toBe(true);
    });

    it('applyState never regresses to an older task', () => {
      const current = view([], { task: task({ id: 5, updatedAt: 50 }) });
      expect(applyState(current, { running: false, task: task({ id: 4, updatedAt: 99 }), messages: [] }).task?.id).toBe(5);
      expect(applyState(current, { running: false, task: task({ id: 5, updatedAt: 40 }), messages: [] }).task?.updatedAt).toBe(50);
    });

    it('a snapshot with no task keeps the current task', () => {
      const current = view([], { task: task({ id: 5 }) });
      expect(applyState(current, { running: false, task: null, messages: [] }).task?.id).toBe(5);
    });

    it('a snapshot older than the task on screen does not touch running', () => {
      // A newer snapshot (review, idle) was applied first; the older one (still working) arrives late.
      const current = view([], { task: task({ id: 5, status: 'review', updatedAt: 50 }), running: false, loaded: true });
      const late = applyState(current, { running: true, task: task({ id: 5, status: 'working', updatedAt: 40 }), messages: [] });
      expect(late.task?.status).toBe('review');
      expect(late.running).toBe(false);
    });

    it('a snapshot with no task cannot set running over a task already on screen', () => {
      const current = view([], { task: task({ id: 5 }), running: false });
      expect(applyState(current, { running: true, task: null, messages: [] }).running).toBe(false);
    });

    it('a snapshot at least as new as the task on screen sets running, both ways', () => {
      const t = task({ id: 5, updatedAt: 50 });
      expect(applyState(view([], { task: t, running: false }), { running: true, task: t, messages: [] }).running).toBe(true);
      expect(applyState(view([], { task: t, running: true }), { running: false, task: { ...t, updatedAt: 60 }, messages: [] }).running).toBe(false);
      expect(applyState(view([], { task: task({ id: 4 }), running: true }), { running: false, task: t, messages: [] }).running).toBe(false);
      expect(applyState(EMPTY_VIEW, { running: true, task: null, messages: [] }).running).toBe(true);
    });

    it('a snapshot whose running flag a newer source already set can be applied without it', () => {
      const t = task({ id: 5, updatedAt: 50 });
      const next = applyState(view([], { task: t, running: false }), { running: true, task: t, messages: [msg(1)] }, { running: false });
      expect(next.running).toBe(false);
      expect(ids(next)).toEqual([1]);
    });
  });

  describe('live messages that change nothing', () => {
    it('returns the same view for render.ready and pong', () => {
      const v = view([msg(1)]);
      expect(applyServerMsg(v, APP, { type: 'render.ready', app: APP, manifest: { version: 2, pages: [] } })).toBe(v);
      expect(applyServerMsg(v, APP, { type: 'pong', t: 1 })).toBe(v);
    });

    it('returns the same view for a build.message already shown', () => {
      const v = view([msg(1), msg(2)]);
      expect(applyServerMsg(v, APP, { type: 'build.message', app: APP, message: msg(2) })).toBe(v);
    });
  });

  describe('isRunStatus', () => {
    it('is true only while a run owns the task', () => {
      expect(['working', 'verifying', 'pushing'].every((s) => isRunStatus(s as BuildTask['status']))).toBe(true);
      expect(['review', 'no_changes', 'failed', 'queued', 'merged', 'closed'].some((s) => isRunStatus(s as BuildTask['status']))).toBe(false);
    });
  });

  describe('prLink', () => {
    it('links an https pull request with its number', () => {
      expect(prLink(task({ prUrl: 'https://github.com/o/r/pull/7', prNumber: 7 }))).toEqual({ href: 'https://github.com/o/r/pull/7', label: 'PR #7' });
    });

    it('has no link without a URL', () => {
      expect(prLink(task())).toBeNull();
    });

    it('refuses a URL that is not https', () => {
      expect(prLink(task({ prUrl: 'javascript:alert(1)', prNumber: 7 }))).toBeNull();
      expect(prLink(task({ prUrl: 'http://github.com/o/r/pull/7', prNumber: 7 }))).toBeNull();
      expect(prLink(task({ prUrl: 'data:text/html,hi', prNumber: 7 }))).toBeNull();
      expect(prLink(task({ prUrl: 'not a url', prNumber: 7 }))).toBeNull();
    });

    it('does not print "PR #null" when the number is missing', () => {
      expect(prLink(task({ prUrl: 'https://github.com/o/r/pull/7', prNumber: null }))).toEqual({
        href: 'https://github.com/o/r/pull/7',
        label: 'Pull request',
      });
    });
  });
});
