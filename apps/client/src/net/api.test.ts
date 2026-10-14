import { describe, expect, it, vi } from 'vitest';
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
});
