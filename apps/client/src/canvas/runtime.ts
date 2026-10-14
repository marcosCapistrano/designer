// The non-DOM half of the canvas component: builds the tile loader, hit map
// store and controller, feeds the controller manifests, and tears it all down.
// CanvasView owns the DOM (canvases, events, toolbar) and delegates here, so the
// lifecycle can be tested without a browser.

import type { NodeSelection, RenderManifest } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { liveKeys } from './cache.js';
import { CanvasController } from './controller.js';
import type { LayerTransform } from './controller.js';
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
  cache: BlobCache;
  requestFrame: (cb: () => void) => void;
  now: () => number;
  onSelect?: (s: NodeSelection | null) => void;
  /** The manifest error to show, or null to clear it. */
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

  const apply = (m: unknown, ticket: number): void => {
    if (disposed || ticket < applied) return;
    assertManifest(m);
    controller.setManifest(m);
    applied = ticket;
    // The cache is an optimization; a failed collection is not worth an error.
    cache.gc(liveKeys(m)).catch(() => {});
    opts.onError(null);
  };
  const fail = (e: unknown, ticket: number): void => {
    if (disposed || ticket < applied) return;
    opts.onError(`Could not load the render manifest: ${errorMessage(e)}`);
  };

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
