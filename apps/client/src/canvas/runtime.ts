// The non-DOM half of the canvas component: builds the tile loader, hit map
// store and controller, feeds the controller manifests and frame layouts, and
// tears it all down.
// CanvasView owns the DOM (canvases, events, toolbar) and delegates here, so the
// lifecycle can be tested without a browser.

import type { CanvasFrame, NodeSelection, RenderManifest } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { liveKeys } from './cache.js';
import { CanvasController } from './controller.js';
import type { LayerTransform } from './controller.js';
import type { FrameStore } from './frames.js';
import { HitMapStore } from './hitmaps.js';
import { TileLoader } from './loader.js';
import type { LoaderOptions } from './loader.js';
import type { BackBuffer } from './painter.js';
import type { TileSource } from './source.js';

export interface CanvasRuntimeOptions {
  base: CanvasRenderingContext2D;
  /** A second base canvas for ping-pong blits (see BasePainter). */
  baseBack?: BackBuffer;
  overlay: CanvasRenderingContext2D;
  /** Shows the painted layers moved and scaled while a zoom settles (see ControllerDeps). */
  setLayerTransform?: (t: LayerTransform | null) => void;
  source: TileSource;
  /** The frame layout the canvas is drawn from. */
  frames: FrameStore;
  cache: BlobCache;
  requestFrame: (cb: () => void) => void;
  now: () => number;
  onSelect?: (s: NodeSelection | null) => void;
  /** The manifest or frames error to show, or null to clear it. */
  onError: (message: string | null) => void;
  /** Passed through to the TileLoader (tests inject a decoder). */
  loader?: Pick<LoaderOptions, 'decode' | 'maxImages'>;
}

export interface CanvasRuntime {
  readonly controller: CanvasController;
  readonly loader: TileLoader;
  dispose(): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The sources parse JSON without checking it, so the one shape the layout relies on is checked here. */
function assertManifest(m: unknown): asserts m is RenderManifest {
  if (typeof m !== 'object' || m === null || !Array.isArray((m as { pages?: unknown }).pages)) {
    throw new Error('the manifest has no pages');
  }
}

export function createCanvasRuntime(opts: CanvasRuntimeOptions): CanvasRuntime {
  const { source, cache } = opts;
  let disposed = false;

  const loader = new TileLoader({
    source,
    cache,
    onLoad: (key, x, y) => {
      if (!disposed) controller.tileLoaded(key, x, y);
    },
    ...opts.loader,
  });
  const hitMaps = new HitMapStore(source, cache);
  const controller = new CanvasController({
    base: opts.base,
    baseBack: opts.baseBack,
    overlay: opts.overlay,
    setLayerTransform: opts.setLayerTransform,
    tiles: loader,
    hitMaps,
    requestFrame: (cb) => {
      if (disposed) return;
      opts.requestFrame(() => {
        if (!disposed) cb();
      });
    },
    now: opts.now,
    onSelect: opts.onSelect,
  });

  // Every manifest, initial or subscribed, goes through apply(). A request's
  // ticket is taken when it starts, so a response that is older than the newest
  // applied manifest is dropped, and so is a failure of such a response.
  let tickets = 0;
  let applied = 0;
  let manifestError: string | null = null;
  let framesError: string | null = null;
  const report = (): void => opts.onError(manifestError ?? framesError);

  // The layout comes from the frames store. A page that is new to the manifest (an import) has
  // frames only once the store has laid it out, so such a manifest reloads the layout. A manifest
  // arriving while a load runs is checked when that load lands, so each manifest costs at most one load.
  let manifest: RenderManifest | null = null;
  let layout: readonly CanvasFrame[] | null = null;
  let loading = false;
  let recheck = false;
  const uncovered = (): boolean => {
    if (manifest === null || layout === null) return false;
    const covered = new Set(layout.map((f) => f.pageId));
    return manifest.pages.some((p) => !covered.has(p.pageId));
  };
  const loadFrames = (): void => {
    loading = true;
    recheck = false;
    opts.frames.load().then(
      (frames) => {
        loading = false;
        if (disposed) return;
        layout = frames;
        controller.setFrames(frames);
        if (framesError !== null) {
          framesError = null;
          report();
        }
        if (recheck && uncovered()) loadFrames();
      },
      (e: unknown) => {
        loading = false;
        if (disposed) return;
        framesError = `Could not load the canvas frames: ${errorMessage(e)}`;
        report();
      },
    );
  };
  const framesFor = (m: RenderManifest): void => {
    manifest = m;
    if (loading) recheck = true;
    else if (layout === null || uncovered()) loadFrames();
  };

  const apply = (m: unknown, ticket: number): void => {
    if (disposed || ticket < applied) return;
    assertManifest(m);
    controller.setManifest(m);
    applied = ticket;
    // The cache is an optimization; a failed collection is not worth an error.
    cache.gc(liveKeys(m)).catch(() => {});
    manifestError = null;
    report();
    framesFor(m);
  };
  const fail = (e: unknown, ticket: number): void => {
    if (disposed || ticket < applied) return;
    manifestError = `Could not load the render manifest: ${errorMessage(e)}`;
    report();
  };

  loadFrames();

  const initial = ++tickets;
  source
    .manifest()
    .then((m) => apply(m, initial))
    .catch((e: unknown) => fail(e, initial));
  const unsubscribe = source.subscribe((m) => {
    const ticket = ++tickets;
    try {
      apply(m, ticket);
    } catch (e) {
      fail(e, ticket);
    }
  });

  return {
    controller,
    loader,
    dispose(): void {
      disposed = true;
      unsubscribe();
      loader.dispose();
    },
  };
}
