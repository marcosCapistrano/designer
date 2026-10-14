import { describe, expect, it, vi } from 'vitest';
import { DEVICE_WIDTH } from '@hub/protocol';
import type { Device, PageRender, RenderManifest } from '@hub/protocol';
import type { BlobCache } from './cache.js';
import { liveKeys } from './cache.js';
import { createCanvasRuntime } from './runtime.js';
import type { CanvasRuntimeOptions } from './runtime.js';
import type { TileSource } from './source.js';
import { fakeCtx } from './test-utils.js';

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const render = (device: Device, hash: string): PageRender => ({
  device,
  hash,
  width: DEVICE_WIDTH[device],
  height: 1000,
  levels: [{ zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 }],
});

/** A one-page manifest whose tile keys all start with `tag`. */
const manifestOf = (tag: string): RenderManifest => ({
  version: 1,
  pages: [
    {
      pageId: tag,
      name: tag,
      route: '/' + tag,
      renders: { base: render('base', tag + 'b'), tablet: render('tablet', tag + 't'), mobile: render('mobile', tag + 'm') },
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
  const push = (m: RenderManifest) => {
    for (const cb of [...subscribers]) cb(m);
  };
  return { source, resolveManifest, rejectManifest, push, subscribers, tiles };
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
    ['pages that is not an array', { version: 1, pages: 'nope' }],
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

    expect(h.rt.controller.frames.map((f) => f.pageId)).toEqual(['b', 'b', 'b']);
    expect(h.gc).toHaveBeenCalledWith(liveKeys(m));
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('an invalid subscribed manifest shows the error and keeps the current one', async () => {
    const h = harness();
    h.resolveManifest(manifestOf('a'));
    await settle();

    h.push({ version: 1 } as unknown as RenderManifest);

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
    h.rt.controller.setDevices(new Set<Device>(['base']));

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
