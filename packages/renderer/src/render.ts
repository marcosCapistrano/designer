import { exportPage, type DesignDoc } from '@hub/design-model';
import {
  sizeKey,
  tierForWidth,
  type FrameSize,
  type HitBox,
  type ManifestPage,
  type PageRender,
  type RenderManifest,
} from '@hub/protocol';
import { capturePage } from './capture.js';
import { cssForDevice } from './html.js';
import { tileKey } from './keys.js';
import type { BrowserPool } from './pool.js';
import type { TileStore } from './store.js';
import { sliceTiles, type TileFile } from './tiles.js';

export interface RenderJob {
  pageId: string;
  size: FrameSize;
  html: string;
  /** Already reduced with cssForDevice(css, tierForWidth(size.width)). */
  css: string;
}

export interface JobResult {
  render: PageRender;
  tiles: TileFile[];
  hitMap: HitBox[];
}

/** Captures one page at one size and slices it into tiles. Output depends only on html, css and size. */
export async function renderJob(pool: BrowserPool, job: RenderJob): Promise<JobResult> {
  const capture = await pool.withPage((page) => capturePage(page, job));
  const { levels, tiles } = await sliceTiles(capture.png, capture.width, capture.height, (zoom) =>
    tileKey(job.html, job.css, job.size, zoom),
  );
  return {
    render: {
      device: tierForWidth(job.size.width),
      hash: tileKey(job.html, job.css, job.size, 1),
      width: capture.width,
      viewportHeight: job.size.viewportHeight,
      height: capture.height,
      levels,
    },
    tiles,
    hitMap: capture.hitMap,
  };
}

export interface RenderDocOptions {
  /** Sizes to render for a page; duplicates render once. */
  sizes: (pageId: string) => readonly FrameSize[];
  prev: RenderManifest | null;
  store: TileStore;
  /** Maximum render jobs in flight. Default 2. */
  concurrency?: number;
}

export interface RenderDocResult {
  manifest: RenderManifest;
  /** Entries `${pageId}@${sizeKey}`, each sorted. */
  rendered: string[];
  reused: string[];
  failed: string[];
}

interface QueuedJob {
  entry: string;
  job: RenderJob;
  prevRender: PageRender | undefined;
}

/**
 * Renders every page at every requested size, reusing renders whose content hash and tile
 * levels are unchanged. A page whose export or render fails keeps its last good render, with
 * `error` set. The manifest lists exactly the requested sizes. A prev manifest that is not
 * version 2 is ignored. Never writes the store's manifest; the caller does that.
 */
export async function renderDoc(
  pool: BrowserPool,
  doc: DesignDoc,
  opts: RenderDocOptions,
): Promise<RenderDocResult> {
  const { store } = opts;
  const concurrency = opts.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('renderDoc concurrency must be a positive integer');
  }
  const pages = Object.values(doc.pages).sort(
    (a, b) => byCodePoint(a.route, b.route) || byCodePoint(a.id, b.id),
  );
  const prevManifest = opts.prev?.version === 2 ? opts.prev : null;
  const prevByPage = new Map((prevManifest?.pages ?? []).map((p) => [p.pageId, p] as const));

  const results = new Map<string, PageRender>();
  const rendered: string[] = [];
  const reused: string[] = [];
  const failed: string[] = [];
  const queued: QueuedJob[] = [];
  const requested = new Map<string, string[]>();

  for (const page of pages) {
    const exported = exportPage(doc, page.id);
    const prev = prevByPage.get(page.id);
    const seen = new Set<string>();
    const keys: string[] = [];
    requested.set(page.id, keys);
    for (const size of opts.sizes(page.id)) {
      const key = sizeKey(size);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      const entry = entryOf(page.id, key);
      const prevRender = prev?.renders[key];
      if (!exported.ok) {
        results.set(entry, failedRender(size, prevRender, exported.error));
        failed.push(entry);
        continue;
      }
      const html = exported.value.html;
      const css = cssForDevice(exported.value.css, tierForWidth(size.width));
      const hash = tileKey(html, css, size, 1);
      if (prevRender && prevRender.hash === hash && (await hasAllLevels(store, prevRender))) {
        results.set(entry, withoutError(prevRender));
        reused.push(entry);
        continue;
      }
      queued.push({ entry, job: { pageId: page.id, size, html, css }, prevRender });
    }
  }

  await runLimited(queued, concurrency, async (q) => {
    try {
      const out = await renderJob(pool, q.job);
      await store.putTiles(out.tiles);
      await store.putHitMap(out.render.hash, out.hitMap);
      results.set(q.entry, out.render);
      rendered.push(q.entry);
    } catch (err) {
      results.set(q.entry, failedRender(q.job.size, q.prevRender, messageOf(err)));
      failed.push(q.entry);
    }
  });

  const manifestPages: ManifestPage[] = pages.map((page) => {
    const renders: Record<string, PageRender> = {};
    for (const key of requested.get(page.id) ?? []) {
      const render = results.get(entryOf(page.id, key));
      if (render) renders[key] = render;
    }
    return { pageId: page.id, name: page.name, route: page.route, renders };
  });

  return {
    manifest: { version: 2, pages: manifestPages },
    rendered: rendered.sort(),
    reused: reused.sort(),
    failed: failed.sort(),
  };
}

function entryOf(pageId: string, key: string): string {
  return `${pageId}@${key}`;
}

// A copy with its own levels array, so a new manifest never shares mutable state with prev.
function copyRender(render: PageRender): PageRender {
  return { ...render, levels: render.levels.map((level) => ({ ...level })) };
}

// Keeps the last good render's levels and hash; a page never rendered gets an empty placeholder.
function failedRender(size: FrameSize, prev: PageRender | undefined, error: string): PageRender {
  if (prev) return { ...copyRender(prev), error };
  return {
    device: tierForWidth(size.width),
    hash: '',
    width: size.width,
    viewportHeight: size.viewportHeight,
    height: 0,
    levels: [],
    error,
  };
}

function withoutError(render: PageRender): PageRender {
  const copy = copyRender(render);
  delete copy.error;
  return copy;
}

// A store that cannot answer counts as a miss, so the size re-renders instead of failing the call.
async function hasAllLevels(store: TileStore, render: PageRender): Promise<boolean> {
  for (const level of render.levels) {
    try {
      if (!(await store.hasLevel(level.key))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Code-point order. UTF-8 byte order matches code point order, unlike UTF-16 unit order.
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs `run` over `items` with at most `limit` calls in flight. `run` must not reject.
async function runLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const remaining = items.values();
  const worker = async (): Promise<void> => {
    for (let next = remaining.next(); !next.done; next = remaining.next()) {
      await run(next.value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
