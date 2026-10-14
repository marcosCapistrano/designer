import { describe, expect, it, vi } from 'vitest';
import { tileId } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { TileLoader } from './loader.js';

const decode = async (b: Blob) => ({ id: await b.text(), width: 512, height: 512, close: vi.fn() });

/** Lets every pending microtask and resolved promise run before the next assertion. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mapCache(entries: Array<[string, Blob]> = []) {
  const store = new Map<string, Blob>(entries);
  const cache: BlobCache = {
    get: async (id) => store.get(id),
    put: async (id, blob) => {
      store.set(id, blob);
    },
    gc: async () => 0,
  };
  return { cache, store };
}

/** A source whose tile() calls stay pending until the test resolves or rejects them. */
function deferredSource() {
  const calls: Array<{ key: string; x: number; y: number; resolve: (b: Blob) => void; reject: (e: unknown) => void }> = [];
  const source = {
    tile: vi.fn(
      (key: string, x: number, y: number) =>
        new Promise<Blob>((resolve, reject) => {
          calls.push({ key, x, y, resolve, reject });
        }),
    ),
  };
  return { source, calls };
}

function instantSource() {
  return {
    tile: vi.fn(async (key: string, x: number, y: number) => new Blob([tileId(key, x, y)])),
  };
}

describe('TileLoader', () => {
  it('loads from source, stores in cache, then serves from memory', async () => {
    const { cache, store } = mapCache();
    const source = instantSource();
    const onLoad = vi.fn();
    const loader = new TileLoader({ source, cache, onLoad, decode });

    loader.request([{ key: 'k', x: 0, y: 0 }]);
    await loader.whenIdle();

    expect(onLoad).toHaveBeenCalledWith('k', 0, 0);
    expect(loader.get('k', 0, 0)).toMatchObject({ id: 'k/0_0' });
    expect(store.has('k/0_0')).toBe(true);

    loader.request([{ key: 'k', x: 0, y: 0 }]);
    await loader.whenIdle();
    expect(source.tile).toHaveBeenCalledTimes(1);
  });

  it('uses the cache before the source', async () => {
    const { cache } = mapCache([['k/0_0', new Blob(['k/0_0'])]]);
    const source = instantSource();
    const loader = new TileLoader({ source, cache, onLoad: vi.fn(), decode });

    loader.request([{ key: 'k', x: 0, y: 0 }]);
    await loader.whenIdle();

    expect(source.tile).not.toHaveBeenCalled();
    expect(loader.get('k', 0, 0)).toMatchObject({ id: 'k/0_0' });
  });

  it('limits in-flight requests', async () => {
    const { cache } = mapCache();
    const { source, calls } = deferredSource();
    const loader = new TileLoader({ source, cache, onLoad: vi.fn(), decode, maxInFlight: 2 });

    loader.request([0, 1, 2, 3, 4].map((x) => ({ key: 'k', x, y: 0 })));
    await tick();
    expect(source.tile).toHaveBeenCalledTimes(2);

    calls[0]!.resolve(new Blob(['k/0_0']));
    await tick();
    expect(source.tile).toHaveBeenCalledTimes(3);
    expect(calls[2]).toMatchObject({ key: 'k', x: 2, y: 0 });
  });

  it('request replaces the queue', async () => {
    const { cache } = mapCache();
    const { source, calls } = deferredSource();
    const loader = new TileLoader({ source, cache, onLoad: vi.fn(), decode, maxInFlight: 1 });
    const want = (key: string) => ({ key, x: 0, y: 0 });

    loader.request([want('a'), want('b'), want('c'), want('d')]);
    await tick();
    expect(calls.map((c) => c.key)).toEqual(['a']);

    loader.request([want('d')]);
    calls[0]!.resolve(new Blob(['a/0_0']));
    await tick();

    expect(calls.map((c) => c.key)).toEqual(['a', 'd']);

    calls[1]!.resolve(new Blob(['d/0_0']));
    await loader.whenIdle();
    expect(calls.map((c) => c.key)).toEqual(['a', 'd']);
  });

  it('evicts the least recently used image and closes it', async () => {
    const { cache } = mapCache();
    const loader = new TileLoader({ source: instantSource(), cache, onLoad: vi.fn(), decode, maxImages: 2 });

    loader.request([{ key: 'a', x: 0, y: 0 }, { key: 'b', x: 0, y: 0 }]);
    await loader.whenIdle();
    const b = loader.get('b', 0, 0)!;

    expect(loader.get('a', 0, 0)).toBeDefined();

    loader.request([{ key: 'c', x: 0, y: 0 }]);
    await loader.whenIdle();

    expect(loader.get('b', 0, 0)).toBeUndefined();
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(loader.get('a', 0, 0)).toBeDefined();
  });

  it('failed tile is not retried until retryAfterMs', async () => {
    const { cache } = mapCache();
    let t = 0;
    const source = { tile: vi.fn(async (): Promise<Blob> => { throw new Error('offline'); }) };
    const loader = new TileLoader({
      source,
      cache,
      onLoad: vi.fn(),
      decode,
      retryAfterMs: 5000,
      now: () => t,
    });
    const want = [{ key: 'k', x: 0, y: 0 }];

    loader.request(want);
    await loader.whenIdle();
    expect(source.tile).toHaveBeenCalledTimes(1);
    expect(loader.stats().failed).toBe(1);

    t = 1000;
    loader.request(want);
    await loader.whenIdle();
    expect(source.tile).toHaveBeenCalledTimes(1);

    t = 6000;
    loader.request(want);
    await loader.whenIdle();
    expect(source.tile).toHaveBeenCalledTimes(2);
  });

  it('request dedupes', async () => {
    const { cache } = mapCache();
    const source = instantSource();
    const loader = new TileLoader({ source, cache, onLoad: vi.fn(), decode });

    loader.request([{ key: 'k', x: 0, y: 0 }, { key: 'k', x: 0, y: 0 }, { key: 'k', x: 0, y: 0 }]);
    await loader.whenIdle();

    expect(source.tile).toHaveBeenCalledTimes(1);
  });
});
