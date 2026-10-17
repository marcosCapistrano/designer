import { describe, expect, it, vi } from 'vitest';
import type { RenderManifest, ServerMsg } from '@hub/protocol';
import type { WsClient } from './ws.js';
import { ServerTileSource } from './tile-source.js';

/** A ws stand-in that keeps listeners in a set, so unsubscribing really removes them. */
function fakeWs() {
  const listeners = new Set<(msg: ServerMsg) => void>();
  const ws: Pick<WsClient, 'on'> = {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const emit = (msg: ServerMsg): void => {
    for (const listener of listeners) listener(msg);
  };
  return { ws, emit };
}

describe('ServerTileSource', () => {
  it("fetches under the app's render path", async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      urls.push(url);
      return new Response(url.endsWith('.json') ? '{"version":1,"pages":[]}' : 'webp-bytes', { status: 200 });
    };
    const source = new ServerTileSource('demo', fakeWs().ws, { fetchFn });
    await source.manifest();
    await source.tile('k', 1, 2);
    await source.hitMap('abc123');
    expect(urls).toEqual([
      '/api/apps/demo/render/manifest.json',
      '/api/apps/demo/render/tiles/k/1_2.webp',
      '/api/apps/demo/render/hitmaps/abc123.json',
    ]);
  });

  it('encodes the app name in the render path', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string): Promise<Response> => {
      urls.push(url);
      return new Response('{"version":1,"pages":[]}', { status: 200 });
    };
    await new ServerTileSource('my app', fakeWs().ws, { fetchFn }).manifest();
    expect(urls).toEqual(['/api/apps/my%20app/render/manifest.json']);
  });

  it('a 401 tells the shell the session is gone, and the load still fails', async () => {
    const onUnauthorized = vi.fn();
    const fetchFn = async (): Promise<Response> => new Response('{"error":"Not logged in"}', { status: 401 });
    const source = new ServerTileSource('demo', fakeWs().ws, { fetchFn, onUnauthorized });
    await expect(source.manifest()).rejects.toThrow('HTTP 401');
    await expect(source.tile('k', 0, 0)).rejects.toThrow('HTTP 401');
    await expect(source.hitMap('h')).rejects.toThrow('HTTP 401');
    expect(onUnauthorized).toHaveBeenCalledTimes(3);
  });

  it('other failures do not log the user out', async () => {
    const onUnauthorized = vi.fn();
    const fetchFn = async (): Promise<Response> => new Response('nope', { status: 404 });
    await expect(new ServerTileSource('demo', fakeWs().ws, { fetchFn, onUnauthorized }).manifest()).rejects.toThrow('HTTP 404');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('subscribe gets render.ready for this app only', () => {
    const { ws, emit } = fakeWs();
    const onManifest = vi.fn();
    const off = new ServerTileSource('demo', ws).subscribe(onManifest);
    const manifest: RenderManifest = { version: 2, pages: [] };
    emit({ type: 'render.ready', app: 'other', manifest });
    expect(onManifest).not.toHaveBeenCalled();
    emit({ type: 'render.ready', app: 'demo', manifest });
    expect(onManifest).toHaveBeenCalledWith(manifest);
    off();
    emit({ type: 'render.ready', app: 'demo', manifest });
    expect(onManifest).toHaveBeenCalledTimes(1);
  });
});
