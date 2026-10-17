import { describe, expect, it, vi } from 'vitest';
import { DEVICE_VIEWPORT_HEIGHT, DEVICE_WIDTH } from '@hub/protocol';
import type { CanvasFrame, Device, HitBox, PageRender, RenderManifest } from '@hub/protocol';
import type { ControllerDeps } from './controller.js';
import { CanvasController } from './controller.js';
import { createNullCache } from './cache.js';
import { fitRect } from './geom.js';
import { layoutBounds } from './layout.js';
import type { PointerIn } from './gestures.js';
import { TileLoader } from './loader.js';
import type { TileWant } from './loader.js';
import { visibleTiles } from './tiles.js';
import { fakeCtx, framesFor } from './test-utils.js';
import type { Call } from './test-utils.js';

const render = (device: Device, hash: string): PageRender => ({
  device,
  hash,
  width: DEVICE_WIDTH[device],
  viewportHeight: DEVICE_VIEWPORT_HEIGHT[device],
  height: 1000,
  levels: [
    { zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 },
    { zoom: 0.5, key: hash + 'h', cols: 2, rows: 1 },
    { zoom: 1, key: hash, cols: 3, rows: 2 },
  ],
});

const M: RenderManifest = {
  version: 2,
  pages: [
    {
      pageId: 'home',
      name: 'Home',
      route: '/',
      renders: { '1440x900': render('base', 'hb'), '834x1194': render('tablet', 'ht'), '390x844': render('mobile', 'hm') },
    },
  ],
};

/** The home page with its base render keyed by `hash`, so each hash names its own hit-map load. */
const withBaseHash = (hash: string): RenderManifest => ({
  version: 2,
  pages: [
    {
      pageId: 'home',
      name: 'Home',
      route: '/',
      renders: { '1440x900': render('base', hash), '834x1194': render('tablet', 'ht'), '390x844': render('mobile', 'hm') },
    },
  ],
});

/** M's default layout: base at x 0, tablet at x 1520, mobile at x 2434, all at y 0. */
const MF: CanvasFrame[] = framesFor(M);

const maps: Record<string, HitBox[]> = {
  hb: [
    { nodeId: 'n1', x: 0, y: 0, w: 1440, h: 1000 },
    { nodeId: 'n2', x: 0, y: 0, w: 1440, h: 80 },
    { nodeId: 'n3', x: 20, y: 20, w: 100, h: 40 },
  ],
};

const defaultHitMaps: ControllerDeps['hitMaps'] = {
  get: (h: string) => maps[h],
  load: async (h: string) => maps[h] ?? [],
};

/** Hit maps whose loads stay pending until a test settles them, one per hash. */
function deferredMaps() {
  const cache = new Map<string, HitBox[]>();
  const pending = new Map<string, { ok: (m: HitBox[]) => void; fail: (e: Error) => void }>();
  const hitMaps: ControllerDeps['hitMaps'] = {
    get: (h: string) => cache.get(h),
    load: (h: string) =>
      new Promise<HitBox[]>((ok, fail) => {
        pending.set(h, {
          ok: (m) => {
            cache.set(h, m);
            ok(m);
          },
          fail,
        });
      }),
  };
  return { hitMaps, pending };
}

function harness(now: () => number = () => 0, hitMaps: ControllerDeps['hitMaps'] = defaultHitMaps, extra: Partial<ControllerDeps> = {}) {
  const q: (() => void)[] = [];
  const flush = () => {
    while (q.length) q.shift()!();
  };
  const base = fakeCtx();
  const overlay = fakeCtx();
  const tiles = { get: () => undefined, request: vi.fn() };
  const onSelect = vi.fn();
  const onFramesChange = vi.fn();
  const onFrameMenu = vi.fn();
  const c = new CanvasController({
    base: base.ctx,
    overlay: overlay.ctx,
    tiles,
    hitMaps,
    requestFrame: (cb) => {
      q.push(cb);
    },
    now,
    onSelect,
    onFramesChange,
    onFrameMenu,
    ...extra,
  });
  return { c, q, flush, base, overlay, tiles, onSelect, onFramesChange, onFrameMenu };
}

function ready(now: () => number = () => 0, hitMaps?: ControllerDeps['hitMaps'], extra?: Partial<ControllerDeps>) {
  const h = harness(now, hitMaps, extra);
  h.c.resize(800, 600, 1);
  h.c.setManifest(M);
  h.c.setFrames(MF);
  h.flush();
  h.c.setCamera({ x: 0, y: 0, scale: 0.5 });
  h.flush();
  return h;
}

const lastFill = (calls: Call[]) => calls.filter((c) => c.m === 'fillRect').at(-1);
const tileId = (w: TileWant) => `${w.key}/${w.x}_${w.y}`;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('CanvasController', () => {
  it('fits the first page on the first frame', () => {
    const { c, flush } = harness();
    c.resize(800, 600, 1);
    c.setManifest(M);
    c.setFrames(MF);
    flush();
    // The tablet frame is its viewport tall (1194), taller than its 1000 px render.
    expect(c.camera).toEqual(fitRect({ x: 0, y: 0, w: 2824, h: 1194 }, { w: 800, h: 600 }, 40));
  });

  it('tap selects the topmost node', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    const want = { pageId: 'home', device: 'base', nodeIds: ['n3'] };
    expect(c.selection).toEqual(want);
    expect(onSelect).toHaveBeenCalledWith(want);
  });

  it('tap on empty canvas clears the selection', async () => {
    const { c } = ready();
    await c.tap(15, 15);
    await c.tap(790, 590);
    expect(c.selection).toBeNull();
  });

  it('box select picks outermost contained nodes', async () => {
    const { c } = ready();
    await c.selectBox({ x: 0, y: 0 }, { x: 730, y: 45 });
    expect(c.selection?.nodeIds).toEqual(['n2']);
  });

  it('marquee starting outside frames uses the frame it overlaps most', async () => {
    const { c } = ready();
    await c.selectBox({ x: -10, y: -10 }, { x: 730, y: 45 });
    expect(c.selection?.nodeIds).toEqual(['n2']);
  });

  it('marquee gesture in select tool', async () => {
    const { c } = ready();
    c.setTool('select');
    const at = (kind: PointerIn['kind'], x: number, y: number): PointerIn => ({
      id: 1,
      kind,
      x,
      y,
      pointerType: 'touch',
      button: 0,
    });
    c.pointer(at('down', 0, 0));
    c.pointer(at('move', 730, 45));
    c.pointer(at('up', 730, 45));
    await settle();
    expect(c.selection?.nodeIds).toEqual(['n2']);
  });

  it('pans coalesce into one frame', () => {
    const { c, q } = ready();
    c.panBy(10, 0);
    c.panBy(10, 0);
    expect(q.length).toBe(1);
    expect(c.camera.x).toBe(-40);
  });

  it('requests visible tiles, then the coarse level, then the prefetch margin', () => {
    const { c, tiles, flush } = ready();
    c.frame();
    const wants = tiles.request.mock.lastCall?.[0] as readonly TileWant[];
    expect(wants.slice(0, 5).map(tileId)).toEqual(['hbh/0_0', 'hbh/1_0', 'hth/0_0', 'hbq/0_0', 'htq/0_0']);

    // Scale 1 at x=600: the viewport covers base columns 1-2 only. The 25% margin (200 px sideways,
    // 150 px vertically) reaches base column 0 and the tablet, so those tiles appear only in the
    // prefetch segment, which is the last 8 entries.
    c.setCamera({ x: 600, y: 0, scale: 1 });
    flush();
    const margin = tiles.request.mock.lastCall?.[0] as readonly TileWant[];
    expect(margin.map(tileId)).toEqual([
      'hb/1_0',
      'hb/2_0',
      'hb/1_1',
      'hb/2_1',
      'hbq/0_0',
      'hb/0_0',
      'hb/1_0',
      'hb/2_0',
      'hb/0_1',
      'hb/1_1',
      'hb/2_1',
      'ht/0_0',
      'ht/0_1',
    ]);
  });

  it('removing the selected frame clears the selection', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setFrames(MF.slice(1));
    expect(c.selection).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(c.frames.length).toBe(2);
  });

  it('setFrames keeps a selection whose frame still exists', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setFrames(MF.map((f) => ({ ...f, y: f.y + 400 })));
    await settle();
    expect(c.selection).toEqual({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it('setManifest keeps a selection whose frame still exists', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setManifest(M);
    await settle();
    expect(c.selection).toEqual({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it('setManifest clears a selection whose page is gone', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setManifest({
      version: 2,
      pages: [{ pageId: 'other', name: 'Other', route: '/other', renders: { '1440x900': render('base', 'ob') } }],
    });
    expect(c.selection).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('setManifest clears a selection whose device render is gone', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setManifest({
      version: 2,
      pages: [{ pageId: 'home', name: 'Home', route: '/', renders: { '834x1194': render('tablet', 'ht') } }],
    });
    expect(c.selection).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('a stale hit-map rejection does not clear a newer selection', async () => {
    const d = deferredMaps();
    const { c, onSelect } = ready(undefined, d.hitMaps);
    const tap = c.tap(15, 15);
    d.pending.get('hb')!.ok(maps.hb!);
    await tap;
    expect(c.selection?.nodeIds).toEqual(['n3']);

    c.setManifest(withBaseHash('hB'));
    const stale = d.pending.get('hB')!;
    c.setManifest(withBaseHash('hC'));
    d.pending.get('hC')!.ok(maps.hb!);
    stale.fail(new Error('stale load failed'));
    await settle();

    expect(c.selection).toEqual({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it('a tap still loading its hit map is dropped by setFrames', async () => {
    const d = deferredMaps();
    const { c, onSelect } = ready(undefined, d.hitMaps);
    const tap = c.tap(15, 15);
    c.setFrames(MF.slice(1));
    d.pending.get('hb')!.ok(maps.hb!);
    await tap;
    expect(onSelect).not.toHaveBeenCalled();
    expect(c.selection).toBeNull();
  });

  it('a tap still loading its hit map is dropped by setManifest', async () => {
    const d = deferredMaps();
    const { c, onSelect } = ready(undefined, d.hitMaps);
    const tap = c.tap(15, 15);
    c.setManifest(M);
    d.pending.get('hb')!.ok(maps.hb!);
    await tap;
    expect(onSelect).not.toHaveBeenCalled();
    expect(c.selection).toBeNull();
  });

  it('zoom paints without smoothing until settled', () => {
    let t = 1000;
    const { c, q, flush, base } = ready(() => t);
    c.zoomAt(100, 100, 2);
    q.shift()!(); // one frame only: an unsettled frame schedules the next one itself
    expect(lastFill(base.calls)?.smooth).toBe(false);
    expect(q.length).toBe(1);
    t = 1200;
    flush();
    expect(lastFill(base.calls)?.smooth).toBe(true);
    expect(c.stats().lastMode).toBe('full');
  });

  it('tileLoaded repaints part of the canvas', () => {
    const { c, q, flush } = ready();
    c.tileLoaded('hbh', 0, 0);
    expect(q.length).toBe(1);
    flush();
    expect(c.stats().lastMode).toBe('partial');
  });

  it('tileLoaded after setFrames repaints the frame at its moved position', () => {
    const { c, flush, base } = ready();
    // The tablet frame moves to x=0, so its tile is no longer at x=1520.
    c.setFrames(MF.slice(1).map((f, i) => (i === 0 ? { ...f, x: 0 } : f)));
    flush();
    const from = base.calls.length;
    c.tileLoaded('hth', 0, 0);
    flush();
    expect(c.stats().lastMode).toBe('partial');
    const rects = base.calls.slice(from).filter((call) => call.m === 'rect');
    expect(rects.at(-1)?.a).toEqual([0, 0, 512, 512]);
  });

  it('a resize to the same size repaints in full', () => {
    const { c, flush } = ready();
    c.resize(800, 600, 1);
    flush();
    expect(c.stats().lastMode).toBe('full');
  });

  it('a zero pan from a pinch schedules no frame', () => {
    const { c, q } = ready();
    const at = (id: number, kind: PointerIn['kind'], x: number, y: number): PointerIn => ({
      id,
      kind,
      x,
      y,
      pointerType: 'touch',
      button: 0,
    });
    c.pointer(at(1, 'down', 100, 100));
    c.pointer(at(2, 'down', 200, 100));
    c.pointer(at(1, 'move', 100, 100));
    expect(q.length).toBe(0);
  });

  it('resetGestures drops a ghost contact, so the next one-finger drag pans instead of zooming', () => {
    const { c } = ready();
    const at = (id: number, kind: PointerIn['kind'], x: number, y: number): PointerIn => ({
      id,
      kind,
      x,
      y,
      pointerType: 'touch',
      button: 0,
    });
    c.pointer(at(1, 'down', 100, 100));
    c.pointer(at(1, 'move', 120, 100));
    // The pointer-up of finger 1 is lost; the window loses focus.
    c.resetGestures();

    const before = c.camera;
    c.pointer(at(2, 'down', 300, 300));
    c.pointer(at(2, 'move', 320, 300));
    expect(c.camera.scale).toBe(before.scale);
    expect(c.camera.x).toBe(before.x - 20 / before.scale);
  });

  it('resetGestures clears a marquee in progress', async () => {
    const { c, flush, overlay } = ready();
    c.setTool('select');
    const at = (kind: PointerIn['kind'], x: number, y: number): PointerIn => ({
      id: 1,
      kind,
      x,
      y,
      pointerType: 'touch',
      button: 0,
    });
    c.pointer(at('down', 0, 0));
    c.pointer(at('move', 200, 100));
    flush();
    expect(overlay.calls.some((call) => call.m === 'strokeRect')).toBe(true);
    overlay.calls.length = 0;

    c.resetGestures();
    flush();
    // The overlay was repainted without the marquee, and the late pointer-up selects nothing.
    expect(overlay.calls.some((call) => call.m === 'clearRect')).toBe(true);
    expect(overlay.calls.filter((call) => call.m === 'strokeRect')).toEqual([]);
    c.pointer(at('up', 200, 100));
    await settle();
    expect(c.selection).toBeNull();
  });

  it('a camera set after the manifest but before the first frame survives the deferred fit', () => {
    const { c, flush } = harness();
    c.resize(800, 600, 1);
    c.setManifest(M);
    c.setCamera({ x: 120, y: -40, scale: 0.02 });
    flush();
    expect(c.camera).toEqual({ x: 120, y: -40, scale: 0.02 });
  });

  it('a camera set before the manifest arrives survives the first fit', () => {
    const { c, flush } = harness();
    c.resize(800, 600, 1);
    c.setCamera({ x: 120, y: -40, scale: 0.5 });
    c.setManifest(M);
    flush();
    expect(c.camera).toEqual({ x: 120, y: -40, scale: 0.5 });
  });

  it('defers the first fit until a frame exists', () => {
    const { c, flush } = harness();
    c.resize(800, 600, 1);
    c.setManifest(M);
    flush();
    expect(c.frames).toEqual([]);
    expect(c.camera).toEqual({ x: 0, y: 0, scale: 1 });
    c.setFrames(MF);
    flush();
    expect(c.camera).toEqual(fitRect({ x: 0, y: 0, w: 2824, h: 1194 }, { w: 800, h: 600 }, 40));
  });
});

describe('CanvasController with a real TileLoader', () => {
  // 50 one-screen-tall pages on the Tab S6 Lite in portrait, at MIN_SCALE: every frame is in view and
  // each has one 0.25 tile, so 150 tiles are visible and the 128-image cache cannot hold them all.
  const render1 = (device: Device, hash: string): PageRender => ({
    device,
    hash,
    width: DEVICE_WIDTH[device],
    viewportHeight: DEVICE_VIEWPORT_HEIGHT[device],
    height: 1000,
    levels: [
      { zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 },
      { zoom: 0.5, key: hash + 'h', cols: 1, rows: 1 },
      { zoom: 1, key: hash, cols: 3, rows: 2 },
    ],
  });
  const BIG: RenderManifest = {
    version: 2,
    pages: Array.from({ length: 50 }, (_, i) => ({
      pageId: `p${i}`,
      name: `Page ${i}`,
      route: `/p${i}`,
      renders: {
        '1440x900': render1('base', `b${i}`),
        '834x1194': render1('tablet', `t${i}`),
        '390x844': render1('mobile', `m${i}`),
      },
    })),
  };

  it('a still camera at MIN_SCALE with more visible tiles than maxImages settles with bounded source calls', async () => {
    const q: (() => void)[] = [];
    const tick = async () => {
      for (const cb of q.splice(0)) cb();
      await settle();
    };
    const source = { tile: vi.fn(async (key: string, x: number, y: number) => new Blob([`${key}/${x}_${y}`])) };
    const closed = vi.fn();
    const loader = new TileLoader({
      source,
      cache: createNullCache(),
      onLoad: (key, x, y) => c.tileLoaded(key, x, y),
      decode: async () => ({ width: 512, height: 512, close: closed }),
    });
    const c = new CanvasController({
      base: fakeCtx().ctx,
      overlay: fakeCtx().ctx,
      tiles: loader,
      hitMaps: defaultHitMaps,
      requestFrame: (cb) => {
        q.push(cb);
      },
      now: () => 0,
    });
    c.resize(800, 1333, 1.5);
    c.setManifest(BIG);
    c.setFrames(framesFor(BIG));
    await tick();
    const fitCalls = source.tile.mock.calls.length;
    c.setCamera({ x: 0, y: 0, scale: 0.02 });
    // 150 ids are visible; make sure the scenario really exceeds the cache.
    const area = { x: 0, y: 0, w: 800 / 0.02, h: 1333 / 0.02 };
    expect(visibleTiles(c.frames, area, 0.25).length).toBeGreaterThan(128);

    const N = 40;
    for (let i = 0; i < N; i++) await tick();
    expect(q.length).toBe(0);
    const calls = source.tile.mock.calls.length;
    // The cache is 128 images; the first page's fit view loaded a few tiles of its own before the zoom out.
    expect(calls).toBeLessThanOrEqual(128 + fitCalls);
    expect(loader.stats().images).toBeLessThanOrEqual(128);

    for (let i = 0; i < N; i++) await tick();
    expect(q.length).toBe(0);
    expect(source.tile.mock.calls.length).toBe(calls);
  });
});

describe('CanvasController zoom preview', () => {
  /** A ready controller whose layers can be moved: `show` records each transform the controller asks for. */
  function previewReady(now: () => number) {
    const q: (() => void)[] = [];
    const flush = () => {
      while (q.length) q.shift()!();
    };
    const base = fakeCtx();
    const overlay = fakeCtx();
    const show = vi.fn();
    const c = new CanvasController({
      base: base.ctx,
      overlay: overlay.ctx,
      setLayerTransform: show,
      tiles: { get: () => undefined, request: vi.fn() },
      hitMaps: defaultHitMaps,
      requestFrame: (cb) => {
        q.push(cb);
      },
      now,
    });
    c.resize(800, 600, 1);
    c.setManifest(M);
    c.setFrames(MF);
    flush();
    c.setCamera({ x: 0, y: 0, scale: 0.5 });
    flush();
    show.mockClear();
    return { c, q, flush, base, overlay, show };
  }

  it('scales the painted layers instead of repainting while the zoom is unsettled', () => {
    let t = 1000;
    const { c, q, base, show } = previewReady(() => t);
    const painted = c.stats().framesPainted;
    const calls = base.calls.length;
    c.zoomAt(100, 100, 1.2);
    q.shift()!(); // one frame only: an unsettled frame schedules the next one itself
    expect(base.calls.length).toBe(calls);
    expect(show).toHaveBeenCalledTimes(1);
    const shown = show.mock.calls[0]![0] as { x: number; y: number; scale: number };
    // The image was painted at (0, 0) x0.5; the point at screen (100, 100) stays put under the zoom.
    expect(shown.scale).toBeCloseTo(1.2, 10);
    expect(shown.x).toBeCloseTo(-20, 8);
    expect(shown.y).toBeCloseTo(-20, 8);
    expect(c.stats()).toMatchObject({ lastMode: 'preview', previewFrames: 1, framesPainted: painted + 1 });
    expect(q.length).toBe(1);
  });

  it('follows a pan made during the zoom', () => {
    const { c, q, show } = previewReady(() => 1000);
    c.zoomAt(100, 100, 1.2);
    c.panBy(-30, -10);
    q.shift()!();
    // Painted at (0, 0) x0.5; the camera is now at (83.3, 50) x0.6, so the image sits at (-50, -30) x1.2.
    const shown = show.mock.calls[0]![0] as { x: number; y: number; scale: number };
    expect(shown.x).toBeCloseTo(-50, 8);
    expect(shown.y).toBeCloseTo(-30, 8);
    expect(shown.scale).toBeCloseTo(1.2, 10);
  });

  it('repaints in full, smoothed, and clears the transform once the camera has settled', () => {
    let t = 1000;
    const { c, q, flush, base, show } = previewReady(() => t);
    c.zoomAt(100, 100, 1.2);
    q.shift()!();
    show.mockClear();
    const calls = base.calls.length;
    t = 1200;
    flush();
    expect(c.stats().lastMode).toBe('full');
    expect(base.calls.length).toBeGreaterThan(calls);
    expect(lastFill(base.calls)?.smooth).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(null);
    // Later frames do not touch the layers again.
    c.panBy(-5, 0);
    flush();
    expect(c.stats().lastMode).toBe('partial');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('repaints at once when the scale leaves the preview range, and previews again from there', () => {
    let t = 1000;
    const { c, q, show, base } = previewReady(() => t);
    c.zoomAt(100, 100, 1.5);
    q.shift()!();
    expect(c.stats().lastMode).toBe('preview');
    show.mockClear();
    c.zoomAt(100, 100, 1.5); // 2.25x the painted scale
    q.shift()!();
    expect(c.stats().lastMode).toBe('full');
    expect(lastFill(base.calls)?.smooth).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith(null);
    show.mockClear();
    c.zoomAt(100, 100, 1.1);
    q.shift()!();
    expect(c.stats().lastMode).toBe('preview');
    expect(show.mock.calls[0]![0]).toMatchObject({ scale: expect.closeTo(1.1, 10) });
  });

  it('repaints at once when zooming out past half the painted scale', () => {
    const t = 1000;
    const { c, q } = previewReady(() => t);
    c.zoomAt(100, 100, 0.6);
    q.shift()!();
    expect(c.stats().lastMode).toBe('preview');
    c.zoomAt(100, 100, 0.7); // 0.42x the painted scale
    q.shift()!();
    expect(c.stats().lastMode).toBe('full');
  });

  it('a change that needs the overlay at the current camera repaints instead of previewing', async () => {
    const t = 1000;
    const { c, q, show, overlay } = previewReady(() => t);
    c.zoomAt(100, 100, 1.2);
    q.shift()!();
    show.mockClear();
    const overlayCalls = overlay.calls.length;
    await c.tap(15, 15); // selects n3: the highlight is drawn at the camera the user sees
    q.shift()!();
    expect(c.stats().lastMode).toBe('full');
    expect(show).toHaveBeenCalledWith(null);
    expect(overlay.calls.length).toBeGreaterThan(overlayCalls);
  });

  it('a resize repaints instead of previewing a cleared canvas', () => {
    const t = 1000;
    const { c, q, show } = previewReady(() => t);
    c.zoomAt(100, 100, 1.2);
    q.shift()!();
    show.mockClear();
    c.resize(800, 600, 1);
    q.shift()!();
    expect(c.stats().lastMode).toBe('full');
    expect(show).toHaveBeenCalledWith(null);
  });

  it('a frames change repaints instead of previewing stale frames', () => {
    const t = 1000;
    const { c, q, show } = previewReady(() => t);
    c.zoomAt(100, 100, 1.2);
    q.shift()!();
    show.mockClear();
    c.setFrames(MF.slice(1));
    q.shift()!();
    expect(c.stats().lastMode).toBe('full');
    expect(show).toHaveBeenCalledWith(null);
  });

  it('does not preview the first frame, which has nothing painted yet', () => {
    const q: (() => void)[] = [];
    const show = vi.fn();
    const c = new CanvasController({
      base: fakeCtx().ctx,
      overlay: fakeCtx().ctx,
      setLayerTransform: show,
      tiles: { get: () => undefined, request: vi.fn() },
      hitMaps: defaultHitMaps,
      requestFrame: (cb) => {
        q.push(cb);
      },
      now: () => 0,
    });
    c.resize(800, 600, 1);
    c.setManifest(M);
    c.setFrames(MF);
    c.zoomAt(100, 100, 1.2);
    // The clock never moves, so the zoom stays unsettled and each frame schedules the next.
    q.shift()!();
    expect(c.stats()).toMatchObject({ lastMode: 'full', previewFrames: 0 });
    expect(show).not.toHaveBeenCalled();
    q.shift()!();
    expect(c.stats()).toMatchObject({ lastMode: 'preview', previewFrames: 1 });
  });
});

describe('CanvasController frames of any size', () => {
  const hit = (nodeId: string): HitBox[] => [{ nodeId, x: 20, y: 20, w: 100, h: 40 }];
  const sized = (device: Device, hash: string, width: number, viewportHeight: number): PageRender => ({
    ...render(device, hash),
    width,
    viewportHeight,
  });
  const P1: RenderManifest = {
    version: 2,
    pages: [
      {
        pageId: 'p1',
        name: '/ads',
        route: '/ads',
        renders: {
          '1440x900': sized('base', 'w14', 1440, 900),
          '1600x900': sized('base', 'w16', 1600, 900),
          '700x1000': sized('tablet', 'w7', 700, 1000),
        },
      },
    ],
  };
  const frames: CanvasFrame[] = [
    { id: 'f0000000000001440', pageId: 'p1', x: 0, y: 0, width: 1440, viewportHeight: 900 },
    { id: 'f0000000000001600', pageId: 'p1', x: 2000, y: 0, width: 1600, viewportHeight: 900 },
    { id: 'f0000000000000700', pageId: 'p1', x: 4000, y: 0, width: 700, viewportHeight: 1000 },
  ];
  const sizedMaps: Record<string, HitBox[]> = { w14: hit('a14'), w16: hit('a16'), w7: hit('a7') };
  const hitMaps: ControllerDeps['hitMaps'] = { get: (h) => sizedMaps[h], load: async (h) => sizedMaps[h] ?? [] };

  function sizedReady() {
    const h = harness(() => 0, hitMaps);
    h.c.resize(800, 600, 1);
    h.c.setManifest(P1);
    h.c.setFrames(frames);
    h.flush();
    return h;
  }

  it('a tap in the 1600 frame selects from its render and highlights in that frame only', async () => {
    const { c, flush, overlay, onSelect } = sizedReady();
    c.setCamera({ x: 2000, y: 0, scale: 0.5 });
    flush();
    await c.tap(15, 15);
    expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'base', nodeIds: ['a16'] });
    expect(c.selection).toEqual({ pageId: 'p1', device: 'base', nodeIds: ['a16'] });
    overlay.calls.length = 0;
    flush();
    // The box at (20, 20) in the frame at world x 2000, seen from camera x 2000 at scale 0.5.
    expect(overlay.calls.filter((call) => call.m === 'strokeRect').map((call) => call.a)).toEqual([[10, 10, 50, 20]]);
  });

  it('a tap in a 700 wide frame selects with tablet styles', async () => {
    const { c, flush, onSelect } = sizedReady();
    c.setCamera({ x: 4000, y: 0, scale: 0.5 });
    flush();
    await c.tap(15, 15);
    expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'tablet', nodeIds: ['a7'] });
  });

  it('a resized frame with no render yet is pending, with its last render as stale', () => {
    const { c } = sizedReady();
    const before = c.frames.find((f) => f.frameId === 'f0000000000001600')!.render;
    c.setFrames(frames.map((f) => (f.width === 1600 ? { ...f, width: 1680 } : f)));
    const moved = c.frames.find((f) => f.frameId === 'f0000000000001600')!;
    expect(moved).toMatchObject({ pending: true, render: null, w: 1680 });
    expect(moved.stale).toBe(before);
  });

  it('where frames overlap, a tap and a marquee select in the frame drawn on top', async () => {
    const { c, flush, onSelect } = sizedReady();
    // The 1600 frame (later, so painted on top) moved over the 1440 frame.
    c.setFrames(frames.map((f) => (f.width === 1600 ? { ...f, x: 0 } : f)));
    c.setCamera({ x: 0, y: 0, scale: 0.5 });
    flush();
    await c.tap(15, 15);
    expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'base', nodeIds: ['a16'] });
    await c.selectBox({ x: 5, y: 5 }, { x: 70, y: 40 });
    expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'base', nodeIds: ['a16'] });
  });

  it('requests the stale tiles of a pending frame', () => {
    const { c, tiles, flush } = sizedReady();
    c.setFrames(frames.map((f) => (f.width === 1600 ? { ...f, width: 1680 } : f)));
    flush();
    const wants = tiles.request.mock.lastCall?.[0] as readonly TileWant[];
    expect(wants.some((w) => w.key.startsWith('w16'))).toBe(true);
  });
});

describe('CanvasController frame drags', () => {
  const pen = (kind: PointerIn['kind'], x: number, y: number, id = 7): PointerIn => ({
    id,
    kind,
    x,
    y,
    pointerType: 'pen',
    button: 0,
  });
  const baseOf = (c: CanvasController) => c.frames.find((f) => f.frameId === MF[0]!.id)!;
  const texts = (calls: Call[]) => calls.filter((call) => call.m === 'fillText').map((call) => call.a[0] as string);

  /** Scale 1 with the base frame's right edge at screen x 440 and its top at screen y 40. */
  function atRightEdge() {
    const h = ready();
    h.c.setCamera({ x: 1000, y: -40, scale: 1 });
    h.flush();
    h.onSelect.mockClear();
    return h;
  }

  it('a pen drag on the right band in select tool resizes live, draws the readout, and reports the layout once on release', async () => {
    const { c, flush, base, overlay, onSelect, onFramesChange } = atRightEdge();
    c.setTool('select');
    const cam = c.camera;
    c.pointer(pen('down', 450, 500));
    c.pointer(pen('move', 550, 500));
    c.pointer(pen('move', 650, 500));
    expect(baseOf(c).w).toBe(1640);
    base.calls.length = 0;
    overlay.calls.length = 0;
    flush();
    expect(texts(base.calls)).toContain('1640 × 900 · Desktop');
    // No marquee, no pan, no selection.
    expect(overlay.calls.filter((call) => call.m === 'strokeRect')).toEqual([]);
    expect(c.camera).toEqual(cam);
    expect(onFramesChange).not.toHaveBeenCalled();

    c.pointer(pen('up', 650, 500));
    await settle();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFramesChange).toHaveBeenCalledTimes(1);
    const saved = onFramesChange.mock.calls[0]![0] as CanvasFrame[];
    expect(saved).toEqual(MF.map((f, i) => (i === 0 ? { ...f, width: 1640 } : f)));
    base.calls.length = 0;
    flush();
    expect(texts(base.calls).some((t) => t.startsWith('1640 × 900 ·'))).toBe(false);

    // Once the new size has a render, a tap inside the frame still selects a node.
    c.setManifest({
      version: 2,
      pages: [{ ...M.pages[0]!, renders: { ...M.pages[0]!.renders, '1640x900': { ...render('base', 'hb'), width: 1640 } } }],
    });
    c.pointer(pen('down', -970, 70));
    c.pointer(pen('up', -970, 70));
    await settle();
    expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
  });

  it('a resized frame keeps its pre-drag render as stale while it has none', () => {
    const { c } = atRightEdge();
    const before = baseOf(c).render;
    c.pointer(pen('down', 450, 500));
    c.pointer(pen('move', 650, 500));
    expect(baseOf(c)).toMatchObject({ pending: true, render: null });
    expect(baseOf(c).stale).toBe(before);
  });

  it('a touch drag on a handle in pan tool resizes instead of panning', () => {
    const { c, onFramesChange } = atRightEdge();
    const cam = c.camera;
    const touch = (kind: PointerIn['kind'], x: number, y: number): PointerIn => ({ ...pen(kind, x, y), pointerType: 'touch' });
    c.pointer(touch('down', 450, 500));
    c.pointer(touch('move', 550, 500));
    expect(baseOf(c).w).toBe(1540);
    c.pointer(touch('up', 550, 500));
    expect(c.camera).toEqual(cam);
    expect(onFramesChange).toHaveBeenCalledTimes(1);
    expect((onFramesChange.mock.calls[0]![0] as CanvasFrame[])[0]).toMatchObject({ width: 1540 });
  });

  it('below the scale where handles are drawn, a touch drag in a label band pans and leaves the frames alone', () => {
    const { c, flush, onFramesChange } = ready();
    // Scale 0.03: the base frame's label band (20 CSS px, 667 world px) would start at screen y 10.
    c.setCamera({ x: 0, y: -1000, scale: 0.03 });
    flush();
    const before = c.frames.map((f) => ({ ...f }));
    const touch = (kind: PointerIn['kind'], x: number, y: number): PointerIn => ({ ...pen(kind, x, y), pointerType: 'touch' });
    c.pointer(touch('down', 15, 21));
    c.pointer(touch('move', 115, 21));
    c.pointer(touch('up', 115, 21));
    expect(c.camera.x).toBeCloseTo(-100 / 0.03);
    expect(c.frames.map((f) => ({ ...f }))).toEqual(before);
    expect(onFramesChange).not.toHaveBeenCalled();
  });

  it('the height tab changes the viewport height', () => {
    const { c, onFramesChange } = atRightEdge();
    // The viewport line of the base frame is at world y 900, screen y 940.
    c.pointer(pen('down', 450, 940));
    c.pointer(pen('move', 450, 1040));
    c.pointer(pen('up', 450, 1040));
    expect((onFramesChange.mock.calls[0]![0] as CanvasFrame[])[0]).toMatchObject({ width: 1440, viewportHeight: 1000 });
  });

  it('a label drag moves the frame and snaps it to the grid on release', () => {
    const { c, onFramesChange } = atRightEdge();
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('move', 113, 25));
    expect(baseOf(c)).toMatchObject({ x: 13, y: -5 });
    c.pointer(pen('up', 113, 25));
    expect(baseOf(c)).toMatchObject({ x: 16, y: -8 });
    expect((onFramesChange.mock.calls[0]![0] as CanvasFrame[])[0]).toMatchObject({ x: 16, y: -8, width: 1440 });
  });

  it('a tap on the label without movement leaves the frame where it is and selects nothing', async () => {
    const { c, onSelect, onFramesChange } = atRightEdge();
    c.setTool('select');
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('move', 103, 31));
    c.pointer(pen('up', 103, 31));
    await settle();
    expect(baseOf(c)).toMatchObject({ x: 0, y: 0 });
    expect(onFramesChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a tap on the label band opens the frame menu at the tap; a drag on it moves the frame and does not', () => {
    const { c, onFrameMenu } = atRightEdge();
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('move', 103, 31));
    c.pointer(pen('up', 103, 31));
    expect(onFrameMenu).toHaveBeenCalledTimes(1);
    expect(onFrameMenu).toHaveBeenCalledWith(MF[0]!.id, { x: 103, y: 31 });

    onFrameMenu.mockClear();
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('move', 160, 30));
    c.pointer(pen('up', 160, 30));
    expect(onFrameMenu).not.toHaveBeenCalled();
    expect(baseOf(c)).toMatchObject({ x: 64 });
  });

  it('with frames not editable, handles pan instead, a label tap opens no menu, and no handles are drawn', () => {
    const h = ready(() => 0, undefined, { framesEditable: false });
    h.c.setCamera({ x: 1000, y: -40, scale: 1 });
    h.flush();
    const { c, flush, base, onFramesChange, onFrameMenu } = h;
    const before = c.frames.map((f) => ({ ...f }));
    const touch = (kind: PointerIn['kind'], x: number, y: number): PointerIn => ({ ...pen(kind, x, y), pointerType: 'touch' });
    c.pointer(touch('down', 450, 500));
    c.pointer(touch('move', 550, 500));
    c.pointer(touch('up', 550, 500));
    expect(c.camera.x).toBe(900);
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('up', 100, 30));
    expect(onFrameMenu).not.toHaveBeenCalled();
    expect(onFramesChange).not.toHaveBeenCalled();
    expect(c.frames.map((f) => ({ ...f }))).toEqual(before);
    base.calls.length = 0;
    c.setCamera({ x: 1000, y: -40, scale: 1 });
    c.panBy(1, 0);
    flush();
    expect(base.calls.filter((call) => call.m === 'fillRect' && call.fill === '#9aa0a6')).toEqual([]);
  });

  it('a tap on a resize handle or a cancelled press does not open the menu', () => {
    const { c, onFrameMenu } = atRightEdge();
    c.pointer(pen('down', 450, 500));
    c.pointer(pen('up', 450, 500));
    c.pointer(pen('down', 100, 30));
    c.pointer(pen('cancel', 100, 30));
    expect(onFrameMenu).not.toHaveBeenCalled();
  });

  it('pointercancel restores the pre-drag frame and reports nothing', async () => {
    const { c, onSelect, onFramesChange } = atRightEdge();
    c.pointer(pen('down', 450, 500));
    c.pointer(pen('move', 650, 500));
    c.pointer(pen('cancel', 650, 500));
    await settle();
    expect(baseOf(c)).toMatchObject({ w: 1440, pending: false });
    expect(onFramesChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('resetGestures restores a frame being dragged', () => {
    const { c, onFramesChange } = atRightEdge();
    c.pointer(pen('down', 450, 500));
    c.pointer(pen('move', 650, 500));
    c.resetGestures();
    expect(baseOf(c).w).toBe(1440);
    c.pointer(pen('up', 650, 500));
    expect(onFramesChange).not.toHaveBeenCalled();
  });

  it('a second finger during a drag is ignored', () => {
    const { c, onFramesChange } = atRightEdge();
    const cam = c.camera;
    const touch = (kind: PointerIn['kind'], x: number, y: number, id: number): PointerIn => ({ ...pen(kind, x, y, id), pointerType: 'touch' });
    c.pointer(touch('down', 450, 500, 1));
    c.pointer(touch('down', 100, 300, 2));
    c.pointer(touch('move', 650, 500, 1));
    c.pointer(touch('move', 200, 300, 2));
    c.pointer(touch('up', 650, 500, 1));
    c.pointer(touch('up', 200, 300, 2));
    expect(c.camera).toEqual(cam);
    expect((onFramesChange.mock.calls[0]![0] as CanvasFrame[])[0]).toMatchObject({ width: 1640 });
  });

  describe('across a tier boundary', () => {
    const hit = (nodeId: string): HitBox[] => [{ nodeId, x: 0, y: 0, w: 1023, h: 768 }];
    const sized = (device: Device, hash: string, width: number): PageRender => ({ ...render(device, hash), width, viewportHeight: 768 });
    const T: RenderManifest = {
      version: 2,
      pages: [
        {
          pageId: 'p1',
          name: '/',
          route: '/',
          renders: { '1024x768': sized('base', 'd1024', 1024), '1023x768': sized('tablet', 't1023', 1023) },
        },
      ],
    };
    const F: CanvasFrame[] = [{ id: 'f0000000000001024', pageId: 'p1', x: 0, y: 0, width: 1024, viewportHeight: 768 }];
    const tierMaps: Record<string, HitBox[]> = { d1024: hit('a'), t1023: hit('a') };
    const hitMaps: ControllerDeps['hitMaps'] = { get: (hh) => tierMaps[hh], load: async (hh) => tierMaps[hh] ?? [] };

    function tierReady() {
      const h = harness(() => 0, hitMaps);
      h.c.resize(800, 600, 1);
      h.c.setManifest(T);
      h.c.setFrames(F);
      h.flush();
      // The right edge is at screen x 524.
      h.c.setCamera({ x: 500, y: -40, scale: 1 });
      h.flush();
      return h;
    }

    it('a width drag from 1024 to 1023 then a tap selects with tablet styles', async () => {
      const { c, onSelect, onFramesChange } = tierReady();
      c.setTool('select');
      c.pointer(pen('down', 530, 300));
      c.pointer(pen('move', 510, 300));
      c.pointer(pen('move', 529, 300));
      c.pointer(pen('up', 529, 300));
      expect((onFramesChange.mock.calls[0]![0] as CanvasFrame[])[0]).toMatchObject({ width: 1023 });
      expect(c.frames[0]).toMatchObject({ w: 1023, device: 'tablet', pending: false });
      c.pointer(pen('down', 30, 80));
      c.pointer(pen('up', 30, 80));
      await settle();
      expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'tablet', nodeIds: ['a'] });
    });

    it('a kept selection whose frame changes tier is reported again with the new tier', async () => {
      const { c, onSelect } = tierReady();
      await c.tap(30, 80);
      expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'base', nodeIds: ['a'] });
      c.setFrames([{ ...F[0]!, width: 1023 }]);
      expect(onSelect).toHaveBeenLastCalledWith({ pageId: 'p1', device: 'tablet', nodeIds: ['a'] });
      expect(c.selection).toEqual({ pageId: 'p1', device: 'tablet', nodeIds: ['a'] });
      const calls = onSelect.mock.calls.length;
      // A relayout that does not change the tier reports nothing.
      c.setFrames([{ ...F[0]!, width: 1023, x: 8 }]);
      expect(onSelect.mock.calls.length).toBe(calls);
    });
  });
});

describe('CanvasController fit-all and camera reports', () => {
  it('fits every frame of every page into the view, not just the first page', () => {
    const two: RenderManifest = { ...M, pages: [...M.pages, { ...M.pages[0]!, pageId: 'p2', name: '/two', route: '/two' }] };
    const h = harness();
    h.c.resize(800, 600, 1);
    h.c.setManifest(two);
    h.c.setFrames(framesFor(two));
    h.flush();
    const firstPage = h.c.camera;
    h.c.fitAll();
    expect(new Set(h.c.frames.map((f) => f.pageId)).size).toBe(2);
    expect(h.c.camera).toEqual(fitRect(layoutBounds(h.c.frames), { w: 800, h: 600 }, 40));
    expect(h.c.camera.scale).toBeLessThan(firstPage.scale);
  });

  it('leaves the camera alone when there are no frames', () => {
    const onCamera = vi.fn();
    const h = harness(undefined, undefined, { onCamera });
    h.c.resize(800, 600, 1);
    const before = h.c.camera;
    h.c.fitAll();
    expect(h.c.camera).toEqual(before);
    expect(onCamera).not.toHaveBeenCalled();
  });

  it('reports the camera after a pan, a zoom, a fit and an explicit camera', () => {
    const onCamera = vi.fn();
    const h = ready(undefined, undefined, { onCamera });
    onCamera.mockClear();
    h.c.panBy(10, 0);
    h.c.zoomAt(100, 100, 2);
    h.c.fitAll();
    h.c.setCamera({ x: 1, y: 2, scale: 0.3 });
    expect(onCamera).toHaveBeenCalledTimes(4);
    expect(onCamera.mock.calls[0]![0].x).not.toBe(onCamera.mock.calls[1]![0].x);
    expect(onCamera.mock.calls[1]![0].scale).toBeGreaterThan(onCamera.mock.calls[0]![0].scale);
    expect(onCamera.mock.calls[2]![0]).toEqual(fitRect(layoutBounds(h.c.frames), { w: 800, h: 600 }, 40));
    expect(onCamera.mock.calls[3]![0]).toEqual({ x: 1, y: 2, scale: 0.3 });
  });

  it('reports the first-page fit', () => {
    const onCamera = vi.fn();
    const h = harness(undefined, undefined, { onCamera });
    h.c.resize(800, 600, 1);
    h.c.setManifest(M);
    h.c.setFrames(MF);
    h.flush();
    expect(onCamera).toHaveBeenCalledWith(h.c.camera);
  });
});
