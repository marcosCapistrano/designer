import { describe, expect, it, vi } from 'vitest';
import type { HitBox } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { HitMapStore } from './hitmaps.js';
import type { TileSource } from './source.js';

const map: HitBox[] = [
  { nodeId: 'n1', x: 0, y: 0, w: 100, h: 50 },
  { nodeId: 'n2', x: 10, y: 60, w: 20, h: 20 },
];

function mapBackedCache() {
  const store = new Map<string, Blob>();
  const cache: BlobCache = {
    get: async (id) => store.get(id),
    put: async (id, blob) => {
      store.set(id, blob);
    },
    gc: async () => 0,
  };
  return { store, cache };
}

function fakeSource(result: HitBox[] = map) {
  return { hitMap: vi.fn(async (_hash: string) => result) } satisfies Pick<TileSource, 'hitMap'>;
}

describe('HitMapStore', () => {
  it('loads from source and caches', async () => {
    const source = fakeSource();
    const { store, cache } = mapBackedCache();
    const hits = new HitMapStore(source, cache);

    expect(await hits.load('h')).toEqual(map);
    expect(hits.get('h')).toEqual(map);
    expect(source.hitMap).toHaveBeenCalledTimes(1);
    expect(store.has('hitmap/h')).toBe(true);
    expect(JSON.parse(await store.get('hitmap/h')!.text())).toEqual(map);
  });

  it('uses the cache before the source', async () => {
    const source = fakeSource();
    const { store, cache } = mapBackedCache();
    store.set('hitmap/h', new Blob([JSON.stringify(map)], { type: 'application/json' }));
    const hits = new HitMapStore(source, cache);

    expect(await hits.load('h')).toEqual(map);
    expect(source.hitMap).not.toHaveBeenCalled();
  });

  it('dedupes concurrent loads', async () => {
    const source = fakeSource();
    const { cache } = mapBackedCache();
    const hits = new HitMapStore(source, cache);

    const [a, b] = await Promise.all([hits.load('h'), hits.load('h')]);
    expect(a).toEqual(map);
    expect(b).toEqual(map);
    expect(source.hitMap).toHaveBeenCalledTimes(1);
  });

  it('keeps at most max maps and evicts the least recently used', async () => {
    const source = fakeSource();
    const { cache } = mapBackedCache();
    const hits = new HitMapStore(source, cache, 2);

    await hits.load('a');
    await hits.load('b');
    hits.get('a'); // touch a so b is the least recently used
    await hits.load('c');

    expect(hits.get('a')).toBeDefined();
    expect(hits.get('b')).toBeUndefined();
    expect(hits.get('c')).toBeDefined();
  });
});
