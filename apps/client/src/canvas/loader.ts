import { tileId } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import type { TileSource } from './source.js';

/** A decoded tile. ImageBitmap satisfies it. */
export interface TileImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface TileWant {
  key: string;
  x: number;
  y: number;
}

export interface LoaderStats {
  images: number;
  inFlight: number;
  queued: number;
  failed: number;
}

interface Job {
  id: string;
  key: string;
  x: number;
  y: number;
}

export interface LoaderOptions {
  source: Pick<TileSource, 'tile'>;
  cache: BlobCache;
  onLoad: (key: string, x: number, y: number) => void;
  decode?: (blob: Blob) => Promise<TileImage>;
  maxImages?: number;
  maxInFlight?: number;
  retryAfterMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_IMAGES = 128;

/** At least 1; a value that is not a positive finite number is the default. */
function sanitizeMaxImages(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_MAX_IMAGES;
  return Math.max(1, Math.floor(n));
}

/**
 * Loads tiles on demand: IndexedDB first, then the source. Decoded images live
 * in a bounded LRU; a request replaces the queue so the latest viewport wins.
 * The last request is also the wanted set: it never exceeds `maxImages`, and
 * eviction takes images outside it first, so a wanted image is never evicted
 * for another one (that would load, evict and reload forever).
 */
export class TileLoader {
  private readonly source: Pick<TileSource, 'tile'>;
  private readonly cache: BlobCache;
  private readonly onLoad: (key: string, x: number, y: number) => void;
  private readonly decode: (blob: Blob) => Promise<TileImage>;
  private readonly maxImages: number;
  private readonly maxInFlight: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;

  /** Map iteration order is the LRU order: least recently used first. */
  private readonly images = new Map<string, TileImage>();
  /** Ids of the last request, truncated to `maxImages`. */
  private wanted = new Set<string>();
  private queue: Job[] = [];
  private readonly inFlight = new Set<string>();
  private readonly failed = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];

  constructor(opts: LoaderOptions) {
    this.source = opts.source;
    this.cache = opts.cache;
    this.onLoad = opts.onLoad;
    this.decode = opts.decode ?? ((b) => createImageBitmap(b));
    this.maxImages = sanitizeMaxImages(opts.maxImages);
    this.maxInFlight = opts.maxInFlight ?? 6;
    this.retryAfterMs = opts.retryAfterMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  get(key: string, x: number, y: number): TileImage | undefined {
    const id = tileId(key, x, y);
    const image = this.images.get(id);
    if (image !== undefined) {
      this.images.delete(id);
      this.images.set(id, image);
    }
    return image;
  }

  /**
   * `wants` is in priority order (visible, then coarse, then prefetch). Only the
   * first `maxImages` distinct ids are wanted; the rest are dropped.
   */
  request(wants: readonly TileWant[]): void {
    const wanted = new Set<string>();
    const queue: Job[] = [];
    const now = this.now();
    for (const { key, x, y } of wants) {
      if (wanted.size >= this.maxImages) break;
      const id = tileId(key, x, y);
      if (wanted.has(id)) continue;
      wanted.add(id);
      if (this.images.has(id) || this.inFlight.has(id)) continue;
      const failedAt = this.failed.get(id);
      if (failedAt !== undefined && now - failedAt < this.retryAfterMs) continue;
      queue.push({ id, key, x, y });
    }
    this.wanted = wanted;
    this.queue = queue;
    this.pump();
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stats(): LoaderStats {
    return {
      images: this.images.size,
      inFlight: this.inFlight.size,
      queued: this.queue.length,
      failed: this.failed.size,
    };
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.inFlight.size === 0;
  }

  private pump(): void {
    while (this.inFlight.size < this.maxInFlight) {
      const job = this.queue.shift();
      if (job === undefined) break;
      this.inFlight.add(job.id);
      void this.run(job);
    }
    if (this.isIdle() && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async run(job: Job): Promise<void> {
    const { id, key, x, y } = job;
    try {
      const cached = await this.cache.get(id);
      let image: TileImage;
      if (cached !== undefined) {
        image = await this.decode(cached);
      } else {
        const blob = await this.source.tile(key, x, y);
        [image] = await Promise.all([this.decode(blob), this.cache.put(id, blob)]);
      }
      const kept = this.insert(id, image);
      this.failed.delete(id);
      if (kept) this.onLoad(key, x, y);
    } catch {
      this.failed.set(id, this.now());
    } finally {
      this.inFlight.delete(id);
      this.pump();
    }
  }

  /**
   * Adds the image, evicting least recently used images that are not wanted. When
   * every other image is wanted the new one is the victim: it is closed, not
   * stored, and false is returned.
   */
  private insert(id: string, image: TileImage): boolean {
    const previous = this.images.get(id);
    if (previous !== undefined && previous !== image) previous.close();
    this.images.delete(id);
    this.images.set(id, image);
    while (this.images.size > this.maxImages) {
      let victim = id;
      for (const resident of this.images.keys()) {
        if (!this.wanted.has(resident)) {
          victim = resident;
          break;
        }
      }
      this.images.get(victim)?.close();
      this.images.delete(victim);
    }
    return this.images.get(id) === image;
  }
}
