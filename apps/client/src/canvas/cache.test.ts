import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { RenderManifest } from '@hub/protocol';
import { createIdbCache, hashOfId, liveKeys } from './cache.js';

describe('createIdbCache', () => {
  it('put then get', async () => {
    const c = createIdbCache('t-put-get');
    await c.put('k/0_0', new Blob(['abc']));
    const got = await c.get('k/0_0');
    expect(await got!.text()).toBe('abc');
  });

  it('missing is undefined', async () => {
    const c = createIdbCache('t-missing');
    expect(await c.get('nope/0_0')).toBeUndefined();
  });

  it('gc removes entries that are not live', async () => {
    const c = createIdbCache('t-gc');
    for (const id of ['a/0_0', 'b/0_0', 'hitmap/a', 'hitmap/c']) await c.put(id, new Blob(['x']));
    expect(await c.gc(new Set(['a']))).toBe(2);
    expect(await c.get('a/0_0')).toBeDefined();
    expect(await c.get('hitmap/a')).toBeDefined();
    expect(await c.get('b/0_0')).toBeUndefined();
    expect(await c.get('hitmap/c')).toBeUndefined();
  });

  it('no IndexedDB falls back to a null cache', async () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      const c = createIdbCache('x');
      await c.put('a/0_0', new Blob(['x']));
      expect(await c.get('a/0_0')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('hashOfId', () => {
  it('maps tile ids and hit map ids to the level key', () => {
    expect(hashOfId('abc/1_2')).toBe('abc');
    expect(hashOfId('hitmap/abc')).toBe('abc');
  });
});

describe('liveKeys', () => {
  it('collects every level key of every render', () => {
    const m: RenderManifest = {
      version: 2,
      pages: [
        {
          pageId: 'p',
          name: 'P',
          route: '/',
          renders: {
            '1440x900': {
              device: 'base',
              hash: 'h',
              width: 1440,
              viewportHeight: 900,
              height: 900,
              levels: [
                { zoom: 0.25, key: 'q', cols: 1, rows: 1 },
                { zoom: 0.5, key: 'k', cols: 1, rows: 1 },
                { zoom: 1, key: 'h', cols: 2, rows: 1 },
              ],
            },
          },
        },
      ],
    };
    expect(liveKeys(m)).toEqual(new Set(['q', 'k', 'h']));
  });
});
