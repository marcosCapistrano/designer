import { fitRectInset } from './geom.js';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_VIEWPORT_HEIGHT, DEVICE_WIDTH } from '@hub/protocol';
import type { CanvasFrame, Device, PageRender, RenderManifest } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { liveKeys } from './cache.js';
import { ApiError } from '../net/api.js';
import { SAVE_ERROR_MS, createCanvasRuntime } from './runtime.js';
import type { CanvasRuntimeOptions } from './runtime.js';
import type { TileSource } from './source.js';
import type { FrameLayout, FrameStore } from './frames.js';
import { fakeCtx, framesFor } from './test-utils.js';

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const render = (device: Device, hash: string): PageRender => ({
  device,
  hash,
  width: DEVICE_WIDTH[device],
  viewportHeight: DEVICE_VIEWPORT_HEIGHT[device],
  height: 1000,
  levels: [{ zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 }],
});

/** A one-page manifest whose tile keys all start with `tag`. */
const manifestOf = (tag: string): RenderManifest => ({
  version: 2,
  pages: [
    {
      pageId: tag,
      name: tag,
      route: '/' + tag,
      renders: { '1440x900': render('base', tag + 'b'), '834x1194': render('tablet', tag + 't'), '390x844': render('mobile', tag + 'm') },
    },
  ],
});

/** A source whose manifest and tiles are settled by the test; subscribers are driven with push(). */
function controlledSource() {
  let resolveManifest: (m: RenderManifest) => void = () => {};
  let rejectManifest: (e: unknown) => void = () => {};
  const manifestPromise = new Promise<RenderManifest>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });
  const subscribers = new Set<(m: RenderManifest) => void>();
  const tiles: Array<{ key: string; resolve: (b: Blob) => void }> = [];
  const source: TileSource = {
    manifest: () => manifestPromise,
    tile: (key, x, y) =>
      new Promise<Blob>((resolve) => {
        tiles.push({ key: `${key}/${x}_${y}`, resolve });
      }),
    hitMap: async () => [],
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
  // Like the server, the frames store lays out every page it knows: page 'a' to start with, then
  // every page of the manifests the test has delivered.
  const known: RenderManifest = { version: 2, pages: [...manifestOf('a').pages] };
  const seen = (m: unknown): void => {
    if (typeof m !== 'object' || m === null || !Array.isArray((m as RenderManifest).pages)) return;
    for (const page of (m as RenderManifest).pages) {
      if (!known.pages.some((p) => p.pageId === page.pageId)) known.pages.push(page);
    }
  };
  const frameStore = {
    load: vi.fn(async (): Promise<FrameLayout> => ({ frames: framesFor(known) })),
    save: vi.fn(async (f: readonly CanvasFrame[]) => [...f]),
  } satisfies FrameStore;
  const push = (m: RenderManifest) => {
    seen(m);
    for (const cb of [...subscribers]) cb(m);
  };
  return {
    source,
    resolveManifest: (m: RenderManifest) => {
      seen(m);
      resolveManifest(m);
    },
    rejectManifest,
    push,
    subscribers,
    tiles,
    frameStore,
  };
}

function harness(overrides: Partial<CanvasRuntimeOptions> = {}) {
  const src = controlledSource();
  const base = fakeCtx();
  const overlay = fakeCtx();
  const frames: Array<() => void> = [];
  const requestFrame = vi.fn((cb: () => void) => {
    frames.push(cb);
  });
  const onError = vi.fn();
  const gc = vi.fn(async (_live: ReadonlySet<string>) => 0);
  const cache: BlobCache = { get: async () => undefined, put: async () => {}, gc };
  const made: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const rt = createCanvasRuntime({
    base: base.ctx,
    overlay: overlay.ctx,
    source: src.source,
    frames: src.frameStore,
    cache,
    requestFrame,
    now: () => 0,
    onError,
    loader: {
      decode: async () => {
        const image = { width: 512, height: 512, close: vi.fn() };
        made.push(image);
        return image;
      },
    },
    ...overrides,
  });
  const runFrames = () => {
    for (const cb of frames.splice(0)) cb();
  };
  return { ...src, rt, base, overlay, frames, requestFrame, onError, gc, cache, made, runFrames };
}

describe('createCanvasRuntime manifests', () => {
  it('applies the initial manifest and collects garbage against its keys', async () => {
    const h = harness();
    const m = manifestOf('a');
    h.resolveManifest(m);
    await settle();

    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['a', 'a', 'a']);
    expect(h.gc).toHaveBeenCalledTimes(1);
    expect(h.gc).toHaveBeenCalledWith(liveKeys(m));
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('shows the error box when the manifest request is rejected', async () => {
    const h = harness();
    h.rejectManifest(new Error('HTTP 404'));
    await settle();

    expect(h.onError).toHaveBeenCalledWith('Could not load the render manifest: HTTP 404');
    expect(h.gc).not.toHaveBeenCalled();
  });

  it.each([
    ['an object without pages', {}],
    ['null', null],
    ['pages that is not an array', { version: 2, pages: 'nope' }],
  ])('shows the error box for %s and does not apply it', async (_name, bad) => {
    const h = harness();
    h.resolveManifest(bad as unknown as RenderManifest);
    await settle();

    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError.mock.calls[0]?.[0]).toMatch(/^Could not load the render manifest: /);
    expect(h.rt.controller.frames).toEqual([]);
    expect(h.gc).not.toHaveBeenCalled();
  });

  it('a subscribed manifest is applied, collected against and clears the error', async () => {
    const h = harness();
    h.rejectManifest(new Error('offline'));
    await settle();
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining('offline'));

    const m = manifestOf('b');
    h.push(m);
    await settle();

    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['b', 'b', 'b']);
    expect(h.gc).toHaveBeenCalledWith(liveKeys(m));
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('an invalid subscribed manifest shows the error and keeps the current one', async () => {
    const h = harness();
    h.resolveManifest(manifestOf('a'));
    await settle();

    h.push({ version: 1 } as unknown as RenderManifest);
    await settle();

    expect(h.onError).toHaveBeenLastCalledWith(expect.stringMatching(/^Could not load the render manifest: /));
    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['a', 'a', 'a']);
  });

  it('an older initial response does not overwrite a newer subscribed manifest', async () => {
    const h = harness();
    h.push(manifestOf('new'));
    h.resolveManifest(manifestOf('old'));
    await settle();

    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['new', 'new', 'new']);
    expect(h.gc).toHaveBeenCalledTimes(1);
    expect(h.gc).toHaveBeenCalledWith(liveKeys(manifestOf('new')));
  });

  it('an initial request that fails after a newer manifest was applied shows no error', async () => {
    const h = harness();
    h.push(manifestOf('new'));
    h.rejectManifest(new Error('late failure'));
    await settle();

    expect(h.onError).not.toHaveBeenCalledWith(expect.stringContaining('late failure'));
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('a cache whose gc rejects does not raise an unhandled rejection', async () => {
    const h = harness();
    h.gc.mockRejectedValueOnce(new Error('idb closed'));
    h.resolveManifest(manifestOf('a'));
    await settle();

    expect(h.rt.controller.frames).toHaveLength(3);
    expect(h.onError).not.toHaveBeenCalledWith(expect.stringContaining('idb closed'));
  });
});

describe('createCanvasRuntime dispose', () => {
  it('unsubscribes from the source', () => {
    const h = harness();
    expect(h.subscribers.size).toBe(1);
    h.rt.dispose();
    expect(h.subscribers.size).toBe(0);
  });

  it('ignores manifests and errors that arrive after dispose', async () => {
    const h = harness();
    h.rt.dispose();
    h.resolveManifest(manifestOf('a'));
    h.push(manifestOf('b'));
    await settle();

    expect(h.rt.controller.frames).toEqual([]);
    expect(h.gc).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('requests no frame after dispose, whatever the cause', async () => {
    const h = harness();
    h.rt.controller.resize(800, 600, 1);
    h.resolveManifest(manifestOf('a'));
    await settle();
    h.runFrames();
    const before = h.requestFrame.mock.calls.length;

    h.rt.dispose();
    h.rt.controller.panBy(10, 10);
    h.rt.controller.zoomAt(10, 10, 1.1);
    h.rt.controller.setCamera({ x: 5, y: 5, scale: 0.5 });
    h.rt.controller.tileLoaded('aq', 0, 0);
    h.rt.controller.resize(400, 300, 2);
    h.rt.controller.setFrames([]);

    expect(h.requestFrame.mock.calls.length).toBe(before);
  });

  it('does not run a frame that was requested before dispose', async () => {
    const h = harness();
    h.rt.controller.resize(800, 600, 1);
    h.resolveManifest(manifestOf('a'));
    await settle();
    expect(h.frames).toHaveLength(1);
    const painted = h.base.calls.length;

    h.rt.dispose();
    h.runFrames();

    expect(h.base.calls.length).toBe(painted);
    expect(h.rt.controller.stats().framesPainted).toBe(0);
  });

  it('closes loaded images, and a tile that finishes loading afterwards is closed and not reported', async () => {
    const h = harness();
    h.rt.controller.resize(800, 600, 1);
    h.resolveManifest(manifestOf('a'));
    await settle();
    h.runFrames();
    await settle();
    // The first frame asked for tiles; finish one before dispose and leave the rest in flight.
    expect(h.tiles.length).toBeGreaterThan(1);
    h.tiles[0]!.resolve(new Blob(['x']));
    await settle();
    expect(h.made).toHaveLength(1);
    const early = h.made[0]!;
    const framesBefore = h.requestFrame.mock.calls.length;

    h.rt.dispose();
    expect(early.close).toHaveBeenCalledTimes(1);

    h.tiles[1]!.resolve(new Blob(['y']));
    await settle();

    expect(h.made.length).toBeLessThanOrEqual(2);
    for (const image of h.made) expect(image.close).toHaveBeenCalledTimes(1);
    expect(h.rt.loader.stats().images).toBe(0);
    expect(h.requestFrame.mock.calls.length).toBe(framesBefore);
  });
});

describe('createCanvasRuntime layers', () => {
  it('hands the back buffer and the layer transform to the controller', async () => {
    const back = fakeCtx();
    const present = vi.fn();
    const show = vi.fn();
    const h = harness({ baseBack: { ctx: back.ctx, present }, setLayerTransform: show });
    h.resolveManifest(manifestOf('a'));
    await settle();
    const c = h.rt.controller;
    c.resize(800, 600, 1);
    c.setCamera({ x: 0, y: 0, scale: 0.5 });
    h.runFrames();

    c.panBy(10, 0);
    h.runFrames();
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith(back.ctx);
    expect(back.ctx.canvas.width).toBe(800);

    c.zoomAt(100, 100, 1.2);
    h.runFrames();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toMatchObject({ scale: expect.closeTo(1.2, 10) });
    h.rt.dispose();
  });
});

describe('createCanvasRuntime frames', () => {
  it('lays the manifest out from the frames store', async () => {
    const h = harness();
    h.resolveManifest(manifestOf('a'));
    await settle();
    expect(h.frameStore.load).toHaveBeenCalledTimes(1);
    expect(h.rt.controller.frames.map((f) => f.frameId)).toEqual(framesFor(manifestOf('a')).map((f) => f.id));
  });

  it('reloads the frames when a manifest brings a page they do not cover', async () => {
    const h = harness();
    h.resolveManifest(manifestOf('a'));
    await settle();
    h.push(manifestOf('a'));
    await settle();
    expect(h.frameStore.load).toHaveBeenCalledTimes(1);

    h.push(manifestOf('b'));
    await settle();
    expect(h.frameStore.load).toHaveBeenCalledTimes(2);
    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['b', 'b', 'b']);
  });

  it('reloads a provisional layout on each manifest until the store returns a saved one', async () => {
    const frames = framesFor(manifestOf('a'));
    const store = {
      load: vi
        .fn(async (): Promise<FrameLayout> => ({ frames: frames.map((f) => ({ ...f, y: f.y + 5000 })), provisional: false }))
        .mockResolvedValueOnce({ frames, provisional: true })
        .mockResolvedValueOnce({ frames, provisional: true }),
      save: vi.fn(async (f: readonly CanvasFrame[]) => [...f]),
    };
    const h = harness({ frames: store });
    await settle();
    expect(store.load).toHaveBeenCalledTimes(1);
    // The pages are covered, so only the provisional flag asks for the layout again.
    h.resolveManifest(manifestOf('a'));
    await settle();
    expect(store.load).toHaveBeenCalledTimes(2);

    // Renders landed: the store now saves and returns the layout stacked from the real heights.
    h.push(manifestOf('a'));
    await settle();
    expect(store.load).toHaveBeenCalledTimes(3);
    expect(h.rt.controller.frames.map((f) => f.y)).toEqual(frames.map((f) => f.y + 5000));

    h.push(manifestOf('a'));
    await settle();
    expect(store.load).toHaveBeenCalledTimes(3);
  });

  it('does not reload a provisional layout over a change the user made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const frames = framesFor(manifestOf('a'));
      const store = {
        load: vi.fn(async (): Promise<FrameLayout> => ({ frames, provisional: true })),
        save: vi.fn(async (f: readonly CanvasFrame[]) => [...f]),
      };
      const h = harness({ frames: store });
      await vi.advanceTimersByTimeAsync(0);
      h.resolveManifest(manifestOf('a'));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.load).toHaveBeenCalledTimes(2); // the first manifest re-checks the provisional layout
      h.rt.changeFrames(frames.map((f) => ({ ...f, x: f.x + 8 })));
      h.push(manifestOf('a'));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300);
      expect(store.save).toHaveBeenCalledTimes(1);
      // The saved change is the layout now; it is not provisional any more.
      h.push(manifestOf('a'));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error when the frames cannot be loaded, and a manifest does not hide it', async () => {
    const failing: FrameStore = {
      load: async () => {
        throw new Error('HTTP 500');
      },
      save: async (f) => [...f],
    };
    const h = harness({ frames: failing });
    h.resolveManifest(manifestOf('a'));
    await settle();
    expect(h.onError).toHaveBeenLastCalledWith('Could not load the canvas frames: HTTP 500');
    expect(h.rt.controller.frames).toEqual([]);
  });

  it('a frames load that finishes after dispose is ignored', async () => {
    const h = harness();
    h.rt.dispose();
    h.resolveManifest(manifestOf('a'));
    await settle();
    expect(h.rt.controller.frames).toEqual([]);
  });
});

describe('createCanvasRuntime frame saves', () => {
  /** A width drag of `dx` CSS px on the last (rightmost) frame's right edge (the camera is at x 1000, scale 1). */
  const widen = (h: ReturnType<typeof harness>, dx: number): void => {
    const c = h.rt.controller;
    const f = c.frames.at(-1)!;
    const x0 = f.x + f.w - 1000 + 10;
    const at = (kind: 'down' | 'move' | 'up', x: number) => c.pointer({ id: 1, kind, x, y: 300, pointerType: 'pen', button: 0 });
    at('down', x0);
    at('move', x0 + dx);
    at('up', x0 + dx);
  };

  async function ready(overrides: Partial<CanvasRuntimeOptions> = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness(overrides);
    h.resolveManifest(manifestOf('a'));
    await vi.advanceTimersByTimeAsync(0);
    h.rt.controller.resize(800, 600, 1);
    h.rt.controller.setCamera({ x: 1000, y: -40, scale: 1 });
    return h;
  }

  it('three quick changes produce one save of the last layout, 300 ms after the last', async () => {
    try {
      const h = await ready();
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(100);
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(100);
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(299);
      expect(h.frameStore.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.frameStore.save).toHaveBeenCalledTimes(1);
      expect(h.frameStore.save.mock.calls[0]![0][2]).toMatchObject({ width: 690 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected save shows the message, reloads the layout, and the message stays after the reload', async () => {
    try {
      const h = await ready();
      h.frameStore.save.mockRejectedValueOnce(new Error('HTTP 409'));
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.onError).toHaveBeenLastCalledWith('Could not save the canvas frames: HTTP 409');
      expect(h.frameStore.load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.rt.controller.frames.at(-1)).toMatchObject({ w: 390 });
      expect(h.onError).toHaveBeenLastCalledWith('Could not save the canvas frames: HTTP 409');

      // The next save that lands clears it.
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.onError).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save error clears by itself after SAVE_ERROR_MS', async () => {
    try {
      const h = await ready();
      h.frameStore.save.mockRejectedValueOnce(new Error('HTTP 409'));
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.onError).toHaveBeenLastCalledWith('Could not save the canvas frames: HTTP 409');
      await vi.advanceTimersByTimeAsync(SAVE_ERROR_MS - 1);
      expect(h.onError).toHaveBeenLastCalledWith('Could not save the canvas frames: HTTP 409');
      await vi.advanceTimersByTimeAsync(1);
      expect(h.onError).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a menu change goes to the controller and the save; a stale-layout refusal shows its message, reloads, and the next change saves', async () => {
    try {
      const h = await ready();
      const stale = new ApiError(400, 'frames[0].pageId is not a page of this app');
      h.frameStore.save.mockRejectedValueOnce(stale);
      const add = (): CanvasFrame[] => {
        const now = h.rt.controller.canvasLayout;
        const f = now[0]!;
        return [...now, { ...f, id: 'f' + String(now.length).padStart(16, '0'), x: f.x + 5000 }];
      };
      h.rt.changeFrames(add());
      expect(h.rt.controller.frames).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.onError).toHaveBeenLastCalledWith(
        'Could not save the canvas frames: frames[0].pageId is not a page of this app',
      );
      expect(h.frameStore.load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.rt.controller.frames).toHaveLength(3);

      h.rt.changeFrames(add());
      await vi.advanceTimersByTimeAsync(300);
      expect(h.frameStore.save).toHaveBeenCalledTimes(2);
      expect(h.frameStore.save.mock.calls[1]![0]).toHaveLength(4);
      expect(h.onError).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with frames not editable, a handle drag changes and saves nothing', async () => {
    try {
      const h = await ready({ framesEditable: false });
      const before = h.rt.controller.canvasLayout.map((f) => ({ ...f }));
      widen(h, 100);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.rt.controller.canvasLayout).toEqual(before);
      expect(h.frameStore.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change still waiting for its save is saved on dispose', async () => {
    try {
      const h = await ready();
      widen(h, 100);
      h.rt.dispose();
      expect(h.frameStore.save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(h.frameStore.save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createCanvasRuntime camera reports', () => {
  it('forwards camera changes to onCamera', () => {
    const onCamera = vi.fn();
    const h = harness({ onCamera });
    h.rt.controller.resize(800, 600, 1);
    h.rt.controller.panBy(5, 0);
    expect(onCamera).toHaveBeenCalledWith(h.rt.controller.camera);
    h.rt.dispose();
  });
});

describe('createCanvasRuntime insets', () => {
  it('passes the chrome insets to the controller’s fits', () => {
    const insets = { top: 56, right: 0, bottom: 136, left: 0 };
    const h = harness({ insets });
    h.rt.controller.resize(800, 600, 1);
    h.rt.controller.setFrames([{ id: 'f0000000000000001', pageId: 'p', x: 0, y: 0, width: 1440, viewportHeight: 900 }]);
    h.rt.controller.setManifest({ version: 2, pages: [{ pageId: 'p', name: '/', route: '/', renders: {} }] });
    h.rt.controller.fitAll();
    expect(h.rt.controller.camera).toEqual(fitRectInset({ x: 0, y: 0, w: 1440, h: 900 }, { w: 800, h: 600 }, 40, insets));
    expect(h.rt.controller.camera).not.toEqual(fitRectInset({ x: 0, y: 0, w: 1440, h: 900 }, { w: 800, h: 600 }, 40, { top: 0, right: 0, bottom: 0, left: 0 }));
    h.rt.dispose();
  });
});
