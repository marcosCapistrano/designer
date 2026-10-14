import type { HitBox } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import type { TileSource } from './source.js';

const DEFAULT_MAX = 64;

/**
 * Hit maps by hash: an in-memory LRU in front of the blob cache and the source.
 * Concurrent loads of one hash share a single request.
 */
export class HitMapStore {
  /** Insertion order is recency order: the first key is the least recently used. */
  private readonly maps = new Map<string, readonly HitBox[]>();
  private readonly inflight = new Map<string, Promise<readonly HitBox[]>>();
  private readonly source: Pick<TileSource, 'hitMap'>;
  private readonly cache: BlobCache;
  private readonly max: number;

  constructor(source: Pick<TileSource, 'hitMap'>, cache: BlobCache, max = DEFAULT_MAX) {
    this.source = source;
    this.cache = cache;
    this.max = max;
  }

  /** Memory only. A hit counts as a use for the LRU. */
  get(hash: string): readonly HitBox[] | undefined {
    const map = this.maps.get(hash);
    if (map !== undefined) {
      this.maps.delete(hash);
      this.maps.set(hash, map);
    }
    return map;
  }

  /** Memory, then the blob cache, then the source (the result is cached). */
  load(hash: string): Promise<readonly HitBox[]> {
    const known = this.get(hash);
    if (known !== undefined) return Promise.resolve(known);
    const pending = this.inflight.get(hash);
    if (pending !== undefined) return pending;
    const request = this.fetchMap(hash).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, request);
    return request;
  }

  private async fetchMap(hash: string): Promise<readonly HitBox[]> {
    const id = `hitmap/${hash}`;
    const cached = await this.readCache(id);
    if (cached !== undefined) {
      this.remember(hash, cached);
      return cached;
    }
    const map = await this.source.hitMap(hash);
    this.remember(hash, map);
    await this.cache.put(id, new Blob([JSON.stringify(map)], { type: 'application/json' }));
    return map;
  }

  /** A malformed or missing cache entry is a miss. */
  private async readCache(id: string): Promise<readonly HitBox[] | undefined> {
    const blob = await this.cache.get(id);
    if (blob === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(await blob.text());
      return Array.isArray(parsed) ? (parsed as HitBox[]) : undefined;
    } catch {
      return undefined;
    }
  }

  private remember(hash: string, map: readonly HitBox[]): void {
    this.maps.delete(hash);
    this.maps.set(hash, map);
    while (this.maps.size > this.max) {
      const oldest = this.maps.keys().next().value;
      if (oldest === undefined) break;
      this.maps.delete(oldest);
    }
  }
}
