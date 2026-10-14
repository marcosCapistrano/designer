import { describe, expect, it, vi } from 'vitest';
import type { RenderManifest } from '@hub/protocol';
import { StaticTileSource } from './source.js';

function fakeFetch(body: BodyInit, status = 200) {
  const urls: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    urls.push(url);
    return new Response(body, { status });
  };
  return { urls, fetchFn };
}

const manifest: RenderManifest = { version: 1, pages: [] };

describe('StaticTileSource', () => {
  it('manifest fetches manifest.json and returns the parsed object', async () => {
    const { urls, fetchFn } = fakeFetch(JSON.stringify(manifest));
    const got = await new StaticTileSource('/dev-renders/', fetchFn).manifest();
    expect(urls).toEqual(['/dev-renders/manifest.json']);
    expect(got).toEqual(manifest);
  });

  it('tile fetches the tile path and resolves to a Blob', async () => {
    const { urls, fetchFn } = fakeFetch('webp-bytes');
    const blob = await new StaticTileSource('/dev-renders/', fetchFn).tile('k', 1, 2);
    expect(urls).toEqual(['/dev-renders/tiles/k/1_2.webp']);
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe('webp-bytes');
  });

  it('hitMap fetches the hit map path', async () => {
    const map = [{ nodeId: 'n1', x: 0, y: 0, w: 10, h: 10 }];
    const { urls, fetchFn } = fakeFetch(JSON.stringify(map));
    const got = await new StaticTileSource('/dev-renders/', fetchFn).hitMap('h');
    expect(urls).toEqual(['/dev-renders/hitmaps/h.json']);
    expect(got).toEqual(map);
  });

  it('a non-OK response rejects with the status and URL', async () => {
    const { fetchFn } = fakeFetch('nope', 404);
    await expect(new StaticTileSource('/dev-renders/', fetchFn).tile('k', 0, 0)).rejects.toThrow(
      'HTTP 404 for /dev-renders/tiles/k/0_0.webp',
    );
  });

  it('subscribe returns an unsubscribe function and never calls back', async () => {
    const { fetchFn } = fakeFetch('{}');
    const onManifest = vi.fn();
    const off = new StaticTileSource('/dev-renders/', fetchFn).subscribe(onManifest);
    expect(typeof off).toBe('function');
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    expect(onManifest).not.toHaveBeenCalled();
  });
});
