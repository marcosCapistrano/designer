import { createStore, delMany, get as idbGet, keys as idbKeys, set as idbSet, type UseStore } from 'idb-keyval';
import type { RenderManifest } from '@hub/protocol';

/**
 * Persistent cache of tile and hit map blobs. It is only an optimization: every
 * method swallows storage errors (quota, private mode) and degrades to a miss.
 */
export interface BlobCache {
  get(id: string): Promise<Blob | undefined>;
  put(id: string, blob: Blob): Promise<void>;
  /** Deletes ids whose hashOfId is not in `live`; returns the count deleted. */
  gc(live: ReadonlySet<string>): Promise<number>;
}

const HITMAP_PREFIX = 'hitmap/';

/** 'hitmap/<h>' -> '<h>'; '<key>/<x>_<y>' -> '<key>'. */
export function hashOfId(id: string): string {
  if (id.startsWith(HITMAP_PREFIX)) return id.slice(HITMAP_PREFIX.length);
  const slash = id.lastIndexOf('/');
  return slash < 0 ? id : id.slice(0, slash);
}

/** Every level key of every render; a hit map id's hash is its zoom-1 level key, so it is covered too. */
export function liveKeys(m: RenderManifest): Set<string> {
  const out = new Set<string>();
  for (const page of m.pages) {
    for (const render of Object.values(page.renders)) {
      if (!render) continue;
      for (const level of render.levels) out.add(level.key);
    }
  }
  return out;
}

export function createNullCache(): BlobCache {
  return {
    get: async () => undefined,
    put: async () => {},
    gc: async () => 0,
  };
}

export function createIdbCache(dbName = 'hub-tiles'): BlobCache {
  if (typeof indexedDB === 'undefined') return createNullCache();
  let store: UseStore;
  try {
    store = createStore(dbName, 'blobs');
  } catch {
    return createNullCache();
  }
  return {
    async get(id) {
      try {
        return await idbGet<Blob>(id, store);
      } catch {
        return undefined;
      }
    },
    async put(id, blob) {
      try {
        await idbSet(id, blob, store);
      } catch {
        // Quota or private mode: the blob is simply not cached.
      }
    },
    async gc(live) {
      try {
        const dead = (await idbKeys<string>(store)).filter((id) => !live.has(hashOfId(id)));
        if (dead.length > 0) await delMany(dead, store);
        return dead.length;
      } catch {
        return 0;
      }
    },
  };
}
