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
import type { Camera, Insets, Point } from './geom.js';
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
  /** Screen space covered by the app's floating chrome; fits keep frames clear of it. */
  insets?: Insets;
  /** Where to start instead of fitting the first page, e.g. the camera of the canvas this one replaces. */
  initialCamera?: Camera;
  /** Called after every camera change (pan, zoom, fit). */
  onCamera?: (camera: Camera) => void;
  /** A tap on a frame's label band: the frame and the screen point tapped. */
  onFrameMenu?: (frameId: string, screen: Point) => void;
  /** Whether frames can be moved, resized or opened in the menu (default true); previews turn it off. */
  framesEditable?: boolean;
  /** The manifest or frames error to show, or null to clear it. */
  onError: (message: string | null) => void;
  /** Passed through to the TileLoader (tests inject a decoder). */
  loader?: Pick<LoaderOptions, 'decode' | 'maxImages'>;
}

export interface CanvasRuntime {
  readonly controller: CanvasController;
  readonly loader: TileLoader;
  /** Applies a layout chosen outside the canvas (the frame menu): shows it and queues the debounced save. */
  changeFrames(frames: readonly CanvasFrame[]): void;
  dispose(): void;
}

/** A changed layout is saved once it has been still this long; only the last of a burst is sent. */
export const SAVE_DEBOUNCE_MS = 300;
/** A refused save's message is shown this long (or until a later save lands). */
export const SAVE_ERROR_MS = 6000;

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
    onCamera: opts.onCamera,
    insets: opts.insets,
    onFramesChange: (frames) => framesChanged(frames),
    onFrameMenu: opts.onFrameMenu,
    framesEditable: opts.framesEditable,
  });
  if (opts.initialCamera) controller.setCamera(opts.initialCamera);

  // Every manifest, initial or subscribed, goes through apply(). A request's
  // ticket is taken when it starts, so a response that is older than the newest
  // applied manifest is dropped, and so is a failure of such a response.
  let tickets = 0;
  let applied = 0;
  let manifestError: string | null = null;
  let framesError: string | null = null;
  /** Kept until a later save lands, so the reload that follows a failed save does not hide it. */
  let saveError: string | null = null;
  const report = (): void => opts.onError(manifestError ?? framesError ?? saveError);

  // The layout comes from the frames store. A page that is new to the manifest (an import) has
  // frames only once the store has laid it out, so such a manifest reloads the layout. So does any
  // manifest while the layout is provisional (placed before the pages' heights were known), unless
  // the user has changed it since: their save makes it the stored layout. A manifest arriving while
  // a load runs is checked when that load lands, so each manifest costs at most one load.
  let manifest: RenderManifest | null = null;
  let layout: readonly CanvasFrame[] | null = null;
  let provisional = false;
  let loading = false;
  let recheck = false;
  const uncovered = (): boolean => {
    if (manifest === null || layout === null) return false;
    const covered = new Set(layout.map((f) => f.pageId));
    return manifest.pages.some((p) => !covered.has(p.pageId));
  };
  const stale = (): boolean => uncovered() || (provisional && unsaved === null && saveTimer === null);
  const loadFrames = (): void => {
    loading = true;
    recheck = false;
    opts.frames.load().then(
      (loaded) => {
        loading = false;
        if (disposed) return;
        layout = loaded.frames;
        provisional = loaded.provisional === true;
        controller.setFrames(loaded.frames);
        if (framesError !== null) {
          framesError = null;
          report();
        }
        if (recheck && stale()) loadFrames();
      },
      (e: unknown) => {
        loading = false;
        if (disposed) return;
        framesError = `Could not load the canvas frames: ${errorMessage(e)}`;
        report();
      },
    );
  };
  // Saves send the whole layout, debounced; last write wins. A refused save (a stale layout, say)
  // shows why and reloads the stored layout, dropping a change that was still waiting.
  let unsaved: CanvasFrame[] | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  const setSaveError = (message: string | null): void => {
    if (saveErrorTimer !== null) clearTimeout(saveErrorTimer);
    saveErrorTimer = null;
    saveError = message;
    if (message !== null) {
      saveErrorTimer = setTimeout(() => {
        saveErrorTimer = null;
        if (disposed) return;
        saveError = null;
        report();
      }, SAVE_ERROR_MS);
    }
    report();
  };
  const save = (): void => {
    saveTimer = null;
    const frames = unsaved;
    unsaved = null;
    if (frames === null) return;
    opts.frames.save(frames).then(
      () => {
        if (disposed || saveError === null) return;
        setSaveError(null);
      },
      (e: unknown) => {
        if (disposed) return;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        unsaved = null;
        setSaveError(`Could not save the canvas frames: ${errorMessage(e)}`);
        loadFrames();
      },
    );
  };
  const framesChanged = (frames: CanvasFrame[]): void => {
    layout = frames;
    // The save stores the whole layout, provisional frames included, as the user now sees it.
    provisional = false;
    unsaved = frames;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  const framesFor = (m: RenderManifest): void => {
    manifest = m;
    if (loading) recheck = true;
    else if (layout === null || stale()) loadFrames();
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
    changeFrames(frames) {
      if (disposed) return;
      const next = frames.map((f) => ({ ...f }));
      controller.setFrames(next);
      framesChanged(next);
    },
    dispose(): void {
      // A change still waiting is saved now rather than lost; its result no longer matters.
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        save();
      }
      disposed = true;
      if (saveErrorTimer !== null) clearTimeout(saveErrorTimer);
      unsubscribe();
      loader.dispose();
    },
  };
}
