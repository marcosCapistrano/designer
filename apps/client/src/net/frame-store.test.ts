import { describe, expect, it } from 'vitest';
import type { CanvasFrame } from '@hub/protocol';
import { ApiClient, ApiError, type FetchFn } from './api.js';
import { ServerFrameStore } from './frame-store.js';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchFn };
}

const frame: CanvasFrame = { id: 'f0123456789abcdef', pageId: 'p1', x: 0, y: 0, width: 1600, viewportHeight: 900 };

describe('ServerFrameStore', () => {
  it("load GETs the app's frames", async () => {
    const { calls, fetchFn } = fakeFetch(200, { frames: [frame] });
    const store = new ServerFrameStore('my app', new ApiClient({ fetchFn }));
    expect(await store.load()).toEqual({ frames: [frame], provisional: false });
    expect(calls[0]![0]).toBe('/api/apps/my%20app/design/frames');
    expect(calls[0]![1]?.method).toBe('GET');
  });

  it('load passes on a provisional layout', async () => {
    const { fetchFn } = fakeFetch(200, { frames: [frame], provisional: true });
    expect(await new ServerFrameStore('demo', new ApiClient({ fetchFn })).load()).toEqual({ frames: [frame], provisional: true });
  });

  it('save PUTs { frames } and returns the list the server kept', async () => {
    const kept = { ...frame, x: 8 };
    const { calls, fetchFn } = fakeFetch(200, { frames: [kept] });
    const store = new ServerFrameStore('demo', new ApiClient({ fetchFn }));
    expect(await store.save([frame])).toEqual([kept]);
    const [url, init] = calls[0]!;
    expect(url).toBe('/api/apps/demo/design/frames');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ frames: [frame] });
  });

  it('a refused save rejects with an ApiError carrying the server message', async () => {
    const { fetchFn } = fakeFetch(400, { error: 'frames[0].pageId is not a page of this app' });
    const store = new ServerFrameStore('demo', new ApiClient({ fetchFn }));
    const err = await store.save([frame]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, message: 'frames[0].pageId is not a page of this app' });
  });
});
