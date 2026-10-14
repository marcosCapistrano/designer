import { describe, expect, it } from 'vitest';
import type { BuildMessage, BuildState, BuildTask, ServerMsg } from '@hub/protocol';
import { ApiError } from '../../net/api.js';
import type { WsStatus } from '../../net/ws.js';
import { BuildSync, PAGE_SIZE } from './sync.js';
import type { BuildSyncSnapshot } from './sync.js';

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

const state = (messages: BuildMessage[], extra: Partial<BuildState> = {}): BuildState => ({
  running: false,
  task: null,
  messages,
  ...extra,
});

/** A hub where every buildState call waits until the test answers it, so tests control the order. */
function harness() {
  interface Pending {
    after: number | undefined;
    resolve: (s: BuildState) => void;
    reject: (e: unknown) => void;
  }
  const requests: Pending[] = [];
  const messageListeners = new Set<(m: ServerMsg) => void>();
  const statusListeners = new Set<(s: WsStatus) => void>();
  const emitted: BuildSyncSnapshot[] = [];

  const api = {
    buildState(_app: string, after?: number): Promise<BuildState> {
      return new Promise((resolve, reject) => requests.push({ after, resolve, reject }));
    },
  };
  const ws = {
    on(l: (m: ServerMsg) => void) {
      messageListeners.add(l);
      return () => void messageListeners.delete(l);
    },
    onStatus(l: (s: WsStatus) => void) {
      statusListeners.add(l);
      return () => void statusListeners.delete(l);
    },
  };
  const sync = new BuildSync({ app: APP, api, ws, onChange: (s) => void emitted.push(s) });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    sync,
    requests,
    emitted,
    ws: {
      live: (m: ServerMsg) => void [...messageListeners].forEach((l) => l(m)),
      status: (s: WsStatus) => void [...statusListeners].forEach((l) => l(s)),
      listenerCount: () => messageListeners.size + statusListeners.size,
    },
    /** Answers the oldest unanswered request. */
    async answer(s: BuildState): Promise<void> {
      requests.shift()!.resolve(s);
      await flush();
    },
    async fail(e: unknown = new TypeError('Failed to fetch')): Promise<void> {
      requests.shift()!.reject(e);
      await flush();
    },
    flush,
    afters: () => requests.map((r) => r.after),
    last: () => emitted.at(-1)!,
  };
}

const liveMessage = (m: BuildMessage): ServerMsg => ({ type: 'build.message', app: APP, message: m });
const liveTask = (t: BuildTask, running: boolean): ServerMsg => ({ type: 'build.task', app: APP, task: t, running });
const ids = (h: ReturnType<typeof harness>) => h.sync.snapshot.view.messages.map((m) => m.id);

describe('BuildSync', () => {
  it('loads the newest page first, with no cursor', async () => {
    const h = harness();
    h.sync.start();
    expect(h.afters()).toEqual([undefined]);
    await h.answer(state([msg(1), msg(2)], { running: true, task: task() }));
    expect(h.last().view).toMatchObject({ loaded: true, running: true });
    expect(ids(h)).toEqual([1, 2]);
    expect(h.last().loadError).toBeNull();
  });

  it('applies live messages for this app and ignores other apps', async () => {
    const h = harness();
    h.sync.start();
    await h.answer(state([msg(1)]));
    h.ws.live(liveMessage(msg(2)));
    h.ws.live({ type: 'build.message', app: 'other', message: msg(3, 'other') });
    expect(ids(h)).toEqual([1, 2]);
  });

  it('catches up after the newest synced message each time the socket opens', async () => {
    const h = harness();
    h.sync.start();
    await h.answer(state([msg(1), msg(2)]));
    h.ws.status('open');
    expect(h.afters()).toEqual([2]);
    await h.answer(state([msg(3)]));
    h.ws.status('open');
    expect(h.afters()).toEqual([3]);
    await h.answer(state([]));
    expect(ids(h)).toEqual([1, 2, 3]);
  });

  it('keeps paging while the pages come back full', async () => {
    const h = harness();
    h.sync.start();
    await h.answer(state([msg(1)]));
    h.ws.status('open');
    const page = (from: number) => Array.from({ length: PAGE_SIZE }, (_, i) => msg(from + i));
    await h.answer(state(page(2)));
    expect(h.afters()).toEqual([PAGE_SIZE + 1]);
    await h.answer(state([msg(PAGE_SIZE + 2)]));
    expect(h.afters()).toEqual([]);
    expect(h.sync.snapshot.view.messages.at(-1)?.id).toBe(PAGE_SIZE + 2);
  });

  describe('a failed fetch', () => {
    it('shows the error and clears it when a later fetch succeeds', async () => {
      const h = harness();
      h.sync.start();
      await h.fail(new ApiError(500, 'Internal error'));
      expect(h.last().loadError).toBe('Internal error');
      h.sync.refresh();
      await h.answer(state([msg(1)]));
      expect(h.last().loadError).toBeNull();
      expect(ids(h)).toEqual([1]);
    });

    it('does not move the cursor past history that was never fetched', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1), msg(2), msg(3)]));
      // The socket drops and returns; messages 4 to 8 are missed and the catch-up fails.
      h.ws.status('open');
      await h.fail();
      // A live message arrives before anything else is fetched.
      h.ws.live(liveMessage(msg(9)));
      expect(ids(h)).toEqual([1, 2, 3, 9]);
      // The live message triggers a retry; make it fail too, then the next open must still start at 3.
      await h.fail();
      h.ws.status('open');
      expect(h.afters()).toEqual([3]);
      await h.answer(state([msg(4), msg(5), msg(6), msg(7), msg(8), msg(9)]));
      expect(ids(h)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('a live message after a failed catch-up fetches the missed history', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1), msg(2), msg(3)]));
      h.ws.status('open');
      await h.fail();
      h.ws.live(liveMessage(msg(9)));
      expect(h.afters()).toEqual([3]);
      await h.answer(state([msg(4), msg(5), msg(6), msg(7), msg(8), msg(9)]));
      expect(ids(h)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(h.last().loadError).toBeNull();
    });

    it('after a failed first load, a live message does not become the cursor', async () => {
      const h = harness();
      h.sync.start();
      await h.fail();
      h.ws.live(liveMessage(msg(21)));
      // The retry asks for the newest page, not for "after 21".
      expect(h.afters()).toEqual([undefined]);
      await h.answer(state([msg(19), msg(20), msg(21)]));
      expect(ids(h)).toEqual([19, 20, 21]);
    });

    it('a live message while nothing has failed does not fetch', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1)]));
      h.ws.live(liveMessage(msg(2)));
      h.ws.live(liveTask(task({ updatedAt: 5 }), true));
      expect(h.requests).toHaveLength(0);
    });

    it('a retry is not stacked on one already in flight', async () => {
      const h = harness();
      h.sync.start();
      await h.fail();
      h.ws.live(liveMessage(msg(2)));
      h.ws.live(liveMessage(msg(3)));
      expect(h.requests).toHaveLength(1);
    });
  });

  describe('overlapping requests', () => {
    it('never runs two at once: an open during the first load waits for it', async () => {
      const h = harness();
      h.sync.start();
      h.ws.status('open');
      expect(h.requests).toHaveLength(1);
      await h.answer(state([msg(1), msg(2)]));
      // The queued catch-up starts from what the first load covered.
      expect(h.afters()).toEqual([2]);
      await h.answer(state([]));
    });

    it('a snapshot does not set running over a live build.task that arrived while it was in flight', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1)]));
      h.ws.status('open');
      // The server answered while the run was still going, so the snapshot says running: true ...
      const t = task({ status: 'review', updatedAt: 50 });
      h.ws.live(liveTask(t, false));
      // ... and the same task at the same updatedAt arrives live with the run finished.
      await h.answer(state([], { running: true, task: t }));
      expect(h.last().view.running).toBe(false);
    });

    it('a snapshot issued after the live message does set running', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1)]));
      const t = task({ status: 'working', updatedAt: 50 });
      h.ws.live(liveTask(t, false));
      h.ws.status('open');
      await h.answer(state([], { running: true, task: t }));
      expect(h.last().view.running).toBe(true);
    });
  });

  describe('applyTask', () => {
    it('a new working task from send turns running on at once', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([], { task: task({ id: 1, status: 'review', updatedAt: 5 }) }));
      h.sync.applyTask(task({ id: 2, status: 'working', updatedAt: 6 }));
      expect(h.last().view).toMatchObject({ running: true, task: { id: 2 } });
    });

    it('a merged or closed task turns running off', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([], { running: true, task: task({ status: 'working', updatedAt: 5 }) }));
      h.sync.applyTask(task({ status: 'merged', updatedAt: 6 }));
      expect(h.last().view).toMatchObject({ running: false, task: { status: 'merged' } });
    });

    it('an older task from a slow reply changes nothing', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([], { task: task({ id: 2, status: 'review', updatedAt: 9 }) }));
      const before = h.sync.snapshot.view;
      h.sync.applyTask(task({ id: 1, status: 'working', updatedAt: 1 }));
      expect(h.sync.snapshot.view).toBe(before);
    });

    it('a snapshot issued before the reply does not undo its running flag', async () => {
      const h = harness();
      h.sync.start();
      await h.answer(state([msg(1)]));
      h.ws.status('open');
      const t = task({ id: 2, status: 'working', updatedAt: 6 });
      h.sync.applyTask(t);
      await h.answer(state([], { running: false, task: t }));
      expect(h.last().view.running).toBe(true);
    });
  });

  describe('stop', () => {
    it('removes its listeners and ignores responses that arrive later', async () => {
      const h = harness();
      h.sync.start();
      expect(h.ws.listenerCount()).toBe(2);
      h.sync.stop();
      expect(h.ws.listenerCount()).toBe(0);
      const count = h.emitted.length;
      await h.answer(state([msg(1)]));
      expect(h.emitted).toHaveLength(count);
    });

    it('a failure after stop is ignored', async () => {
      const h = harness();
      h.sync.start();
      h.sync.stop();
      const count = h.emitted.length;
      await h.fail();
      expect(h.emitted).toHaveLength(count);
    });

    it('applyTask after stop does nothing', async () => {
      const h = harness();
      h.sync.start();
      h.sync.stop();
      const count = h.emitted.length;
      h.sync.applyTask(task());
      expect(h.emitted).toHaveLength(count);
    });
  });
});
