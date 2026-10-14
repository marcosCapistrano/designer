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

/**
 * Loads tiles on demand: IndexedDB first, then the source. Decoded images live
 * in a bounded LRU; a request replaces the queue so the latest viewport wins.
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
  private queue: Job[] = [];
  private readonly inFlight = new Set<string>();
  private readonly failed = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];

  constructor(opts: LoaderOptions) {
    this.source = opts.source;
    this.cache = opts.cache;
    this.onLoad = opts.onLoad;
    this.decode = opts.decode ?? ((b) => createImageBitmap(b));
    this.maxImages = opts.maxImages ?? 128;
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

  request(wants: readonly TileWant[]): void {
    const seen = new Set<string>();
    const queue: Job[] = [];
    const now = this.now();
    for (const { key, x, y } of wants) {
      const id = tileId(key, x, y);
      if (seen.has(id) || this.images.has(id) || this.inFlight.has(id)) continue;
      const failedAt = this.failed.get(id);
      if (failedAt !== undefined && now - failedAt < this.retryAfterMs) continue;
      seen.add(id);
      queue.push({ id, key, x, y });
    }
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
      this.insert(id, image);
      this.failed.delete(id);
      this.onLoad(key, x, y);
    } catch {
      this.failed.set(id, this.now());
    } finally {
      this.inFlight.delete(id);
      this.pump();
    }
  }

  private insert(id: string, image: TileImage): void {
    const previous = this.images.get(id);
    if (previous !== undefined && previous !== image) previous.close();
    this.images.delete(id);
    this.images.set(id, image);
    while (this.images.size > this.maxImages) {
      const oldest = this.images.keys().next().value as string;
      this.images.get(oldest)?.close();
      this.images.delete(oldest);
    }
  }
}
