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
    const source = new ServerTileSource('demo', fakeWs().ws, fetchFn);
    await source.manifest();
    await source.tile('k', 1, 2);
    expect(urls).toEqual(['/api/apps/demo/render/manifest.json', '/api/apps/demo/render/tiles/k/1_2.webp']);
  });

  it('subscribe gets render.ready for this app only', () => {
    const { ws, emit } = fakeWs();
    const onManifest = vi.fn();
    const off = new ServerTileSource('demo', ws).subscribe(onManifest);
    const manifest: RenderManifest = { version: 1, pages: [] };
    emit({ type: 'render.ready', app: 'other', manifest });
    expect(onManifest).not.toHaveBeenCalled();
    emit({ type: 'render.ready', app: 'demo', manifest });
    expect(onManifest).toHaveBeenCalledWith(manifest);
    off();
    emit({ type: 'render.ready', app: 'demo', manifest });
    expect(onManifest).toHaveBeenCalledTimes(1);
  });
});
