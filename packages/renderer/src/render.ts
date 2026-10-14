import { exportPage, type DesignDoc } from '@hub/design-model';
import {
  DEVICE_WIDTH,
  DEVICES,
  type Device,
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
  device: Device;
  html: string;
  /** Already reduced with cssForDevice. */
  css: string;
}

export interface JobResult {
  render: PageRender;
  tiles: TileFile[];
  hitMap: HitBox[];
}

/** Captures one page at one device and slices it into tiles. Output depends only on html, css and device. */
export async function renderJob(pool: BrowserPool, job: RenderJob): Promise<JobResult> {
  const capture = await pool.withPage((page) => capturePage(page, job));
  const { levels, tiles } = await sliceTiles(capture.png, capture.width, capture.height, (zoom) =>
    tileKey(job.html, job.css, job.device, zoom),
  );
  return {
    render: {
      device: job.device,
      hash: tileKey(job.html, job.css, job.device, 1),
      width: capture.width,
      height: capture.height,
      levels,
    },
    tiles,
    hitMap: capture.hitMap,
  };
}

export interface RenderDocOptions {
  devices: readonly Device[];
  prev: RenderManifest | null;
  store: TileStore;
  /** Maximum render jobs in flight. Default 2. */
  concurrency?: number;
}

export interface RenderDocResult {
  manifest: RenderManifest;
  /** Entries `${pageId}@${device}`, each sorted. */
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
 * Renders every page at every requested device, reusing renders whose content hash and tile
 * levels are unchanged. A page whose export or render fails keeps its last good render, with
 * `error` set. Never writes the store's manifest; the caller does that.
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
  const devices = DEVICES.filter((device) => opts.devices.includes(device));
  const pages = Object.values(doc.pages).sort(
    (a, b) => byCodePoint(a.route, b.route) || byCodePoint(a.id, b.id),
  );
  const prevByPage = new Map((opts.prev?.pages ?? []).map((p) => [p.pageId, p] as const));

  const results = new Map<string, PageRender>();
  const rendered: string[] = [];
  const reused: string[] = [];
  const failed: string[] = [];
  const queued: QueuedJob[] = [];

  for (const page of pages) {
    const exported = exportPage(doc, page.id);
    const prev = prevByPage.get(page.id);
    for (const device of devices) {
      const entry = entryOf(page.id, device);
      const prevRender = prev?.renders[device];
      if (!exported.ok) {
        results.set(entry, failedRender(device, prevRender, exported.error));
        failed.push(entry);
        continue;
      }
      const html = exported.value.html;
      const css = cssForDevice(exported.value.css, device);
      const hash = tileKey(html, css, device, 1);
      if (prevRender && prevRender.hash === hash && (await hasAllLevels(store, prevRender))) {
        results.set(entry, withoutError(prevRender));
        reused.push(entry);
        continue;
      }
      queued.push({ entry, job: { pageId: page.id, device, html, css }, prevRender });
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
      results.set(q.entry, failedRender(q.job.device, q.prevRender, messageOf(err)));
      failed.push(q.entry);
    }
  });

  const manifestPages: ManifestPage[] = pages.map((page) => {
    const prev = prevByPage.get(page.id);
    const renders: Partial<Record<Device, PageRender>> = {};
    for (const device of DEVICES) {
      if (devices.includes(device)) {
        const render = results.get(entryOf(page.id, device));
        if (render) renders[device] = render;
      } else {
        // Devices this call did not render keep their previous render, error included.
        const carried = prev?.renders[device];
        if (carried) renders[device] = copyRender(carried);
      }
    }
    return { pageId: page.id, name: page.name, route: page.route, renders };
  });

  return {
    manifest: { version: 1, pages: manifestPages },
    rendered: rendered.sort(),
    reused: reused.sort(),
    failed: failed.sort(),
  };
}

function entryOf(pageId: string, device: Device): string {
  return `${pageId}@${device}`;
}

// A copy with its own levels array, so a new manifest never shares mutable state with prev.
function copyRender(render: PageRender): PageRender {
  return { ...render, levels: render.levels.map((level) => ({ ...level })) };
}

// Keeps the last good render's levels and hash; a page never rendered gets an empty placeholder.
function failedRender(device: Device, prev: PageRender | undefined, error: string): PageRender {
  if (prev) return { ...copyRender(prev), error };
  return { device, hash: '', width: DEVICE_WIDTH[device], height: 0, levels: [], error };
}

function withoutError(render: PageRender): PageRender {
  const copy = copyRender(render);
  delete copy.error;
  return copy;
}

// A store that cannot answer counts as a miss, so the device re-renders instead of failing the call.
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
