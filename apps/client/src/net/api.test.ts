import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildTask } from '@hub/protocol';
import { ApiClient, ApiError, type FetchFn } from './api.js';

function fakeFetch(status: number, body?: unknown) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push([url, init]);
    const text = body === undefined ? null : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchFn };
}

const task: BuildTask = {
  id: 1,
  app: 'demo',
  title: 'Add a header',
  branch: 'build/add-a-header-1',
  base: 'main',
  status: 'review',
  prNumber: 7,
  prUrl: 'https://example.com/pr/7',
  headSha: 'abc',
  ci: 'pending',
  mergeSha: null,
  error: null,
  retryAt: null,
  createdAt: 1,
  updatedAt: 2,
};

describe('ApiClient', () => {
  it('login posts the passphrase', async () => {
    const { calls, fetchFn } = fakeFetch(204);
    await new ApiClient({ fetchFn }).login('p');
    const [url, init] = calls[0]!;
    expect(url).toBe('/api/login');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"passphrase":"p"}');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init?.credentials).toBe('same-origin');
  });

  it('wrong passphrase throws the server message', async () => {
    const { fetchFn } = fakeFetch(401, { error: 'Wrong passphrase' });
    const onUnauthorized = vi.fn();
    const err = await new ApiClient({ fetchFn, onUnauthorized }).login('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Wrong passphrase' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('401 elsewhere calls onUnauthorized', async () => {
    const { fetchFn } = fakeFetch(401, { error: 'Not logged in' });
    const onUnauthorized = vi.fn();
    await expect(new ApiClient({ fetchFn, onUnauthorized }).apps()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('session is false on 401', async () => {
    const { fetchFn } = fakeFetch(401, { error: 'Not logged in' });
    expect(await new ApiClient({ fetchFn }).session()).toBe(false);
  });

  it('buildState encodes the app and passes after', async () => {
    const { calls, fetchFn } = fakeFetch(200, { running: false, task: null, messages: [] });
    const api = new ApiClient({ fetchFn });
    await api.buildState('my app', 5);
    await api.buildState('my app');
    expect(calls.map(([url]) => url)).toEqual(['/api/apps/my%20app/build?after=5', '/api/apps/my%20app/build']);
  });

  it('sendBuild returns the task', async () => {
    const { fetchFn } = fakeFetch(202, { task });
    expect(await new ApiClient({ fetchFn }).sendBuild('demo', 'Add a header')).toEqual(task);
  });

  it('logout posts, and a 401 there still reports the lost session', async () => {
    const ok = fakeFetch(204);
    await new ApiClient({ fetchFn: ok.fetchFn }).logout();
    expect(ok.calls[0]![0]).toBe('/api/logout');
    expect(ok.calls[0]![1]?.method).toBe('POST');

    const lost = fakeFetch(401, { error: 'Not logged in' });
    const onUnauthorized = vi.fn();
    await expect(new ApiClient({ fetchFn: lost.fetchFn, onUnauthorized }).logout()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('session is true on 200 and sends the cookie', async () => {
    const { calls, fetchFn } = fakeFetch(200, {});
    expect(await new ApiClient({ fetchFn }).session()).toBe(true);
    expect(calls[0]![0]).toBe('/api/session');
    expect(calls[0]![1]?.credentials).toBe('same-origin');
  });

  it('session throws on a server error instead of answering false', async () => {
    const { fetchFn } = fakeFetch(502, { error: 'Bad gateway' });
    await expect(new ApiClient({ fetchFn }).session()).rejects.toMatchObject({ status: 502, message: 'Bad gateway' });
  });

  it('session gives up when the hub never answers, so the shell can leave "checking"', async () => {
    // A fetch that only ends when its signal aborts, as the browser's does.
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const err = await new ApiClient({ fetchFn, sessionTimeoutMs: 20 }).session().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
  });

  it('a non-JSON error body falls back to the HTTP status', async () => {
    const fetchFn: FetchFn = async () => new Response('<html>Bad gateway</html>', { status: 502 });
    await expect(new ApiClient({ fetchFn }).apps()).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('a 200 that is not JSON is an ApiError, not a SyntaxError', async () => {
    const fetchFn: FetchFn = async () => new Response('<html>captive portal</html>', { status: 200 });
    const err = await new ApiClient({ fetchFn }).apps().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 200, message: 'The hub sent a reply that could not be read.' });
  });

  it('a network failure stays a network failure', async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(new ApiClient({ fetchFn }).apps()).rejects.toBeInstanceOf(TypeError);
  });

  it('buildState sends after=0 when asked for it', async () => {
    const { calls, fetchFn } = fakeFetch(200, { running: false, task: null, messages: [] });
    await new ApiClient({ fetchFn }).buildState('demo', 0);
    expect(calls[0]![0]).toBe('/api/apps/demo/build?after=0');
  });

  it('stopBuild returns whether a run was stopped', async () => {
    const stopped = fakeFetch(200, { stopped: true });
    expect(await new ApiClient({ fetchFn: stopped.fetchFn }).stopBuild('demo')).toBe(true);
    expect(stopped.calls[0]![0]).toBe('/api/apps/demo/build/stop');
    expect(stopped.calls[0]![1]?.method).toBe('POST');
    const idle = fakeFetch(200, { stopped: false });
    expect(await new ApiClient({ fetchFn: idle.fetchFn }).stopBuild('demo')).toBe(false);
  });

  it('merge and closeTask post to the task and return it', async () => {
    const merge = fakeFetch(200, { task });
    expect(await new ApiClient({ fetchFn: merge.fetchFn }).merge('demo', 7)).toEqual(task);
    expect(merge.calls[0]![0]).toBe('/api/apps/demo/build/tasks/7/merge');
    expect(merge.calls[0]![1]?.method).toBe('POST');
    const close = fakeFetch(200, { task });
    expect(await new ApiClient({ fetchFn: close.fetchFn }).closeTask('demo', 7)).toEqual(task);
    expect(close.calls[0]![0]).toBe('/api/apps/demo/build/tasks/7/close');
  });

  it('sendBuild posts the text as JSON', async () => {
    const { calls, fetchFn } = fakeFetch(202, { task });
    await new ApiClient({ fetchFn }).sendBuild('demo', 'Add a header');
    expect(calls[0]![0]).toBe('/api/apps/demo/build/messages');
    expect(calls[0]![1]?.body).toBe('{"text":"Add a header"}');
  });

  it('reportUnauthorized calls the handler', () => {
    const onUnauthorized = vi.fn();
    new ApiClient({ onUnauthorized }).reportUnauthorized();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  describe('the default fetch', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is not called with the client as `this`', async () => {
      let seen: unknown = 'unset';
      vi.stubGlobal('fetch', function (this: unknown) {
        seen = this;
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      const client = new ApiClient();
      await client.login('p');
      expect(seen).not.toBe(client);
    });
  });
});
