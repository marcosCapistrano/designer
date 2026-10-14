import { describe, expect, it, vi } from 'vitest';
import { DEVICES, DEVICE_WIDTH } from '@hub/protocol';
import type { Device, HitBox, PageRender, RenderManifest } from '@hub/protocol';
import type { ControllerDeps } from './controller.js';
import { CanvasController } from './controller.js';
import { createNullCache } from './cache.js';
import { fitRect } from './geom.js';
import type { PointerIn } from './gestures.js';
import { TileLoader } from './loader.js';
import type { TileWant } from './loader.js';
import { visibleTiles } from './tiles.js';
import { fakeCtx } from './test-utils.js';
import type { Call } from './test-utils.js';

const render = (device: Device, hash: string): PageRender => ({
  device,
  hash,
  width: DEVICE_WIDTH[device],
  height: 1000,
  levels: [
    { zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 },
    { zoom: 0.5, key: hash + 'h', cols: 2, rows: 1 },
    { zoom: 1, key: hash, cols: 3, rows: 2 },
  ],
});

const M: RenderManifest = {
  version: 1,
  pages: [
    {
      pageId: 'home',
      name: 'Home',
      route: '/',
      renders: { base: render('base', 'hb'), tablet: render('tablet', 'ht'), mobile: render('mobile', 'hm') },
    },
  ],
};

/** The home page with its base render keyed by `hash`, so each hash names its own hit-map load. */
const withBaseHash = (hash: string): RenderManifest => ({
  version: 1,
  pages: [
    {
      pageId: 'home',
      name: 'Home',
      route: '/',
      renders: { base: render('base', hash), tablet: render('tablet', 'ht'), mobile: render('mobile', 'hm') },
    },
  ],
});

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

function harness(now: () => number = () => 0, hitMaps: ControllerDeps['hitMaps'] = defaultHitMaps) {
  const q: (() => void)[] = [];
  const flush = () => {
    while (q.length) q.shift()!();
  };
  const base = fakeCtx();
  const overlay = fakeCtx();
  const tiles = { get: () => undefined, request: vi.fn() };
  const onSelect = vi.fn();
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
  });
  return { c, q, flush, base, overlay, tiles, onSelect };
}

function ready(now: () => number = () => 0, hitMaps?: ControllerDeps['hitMaps']) {
  const h = harness(now, hitMaps);
  h.c.resize(800, 600, 1);
  h.c.setManifest(M);
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
    flush();
    expect(c.camera).toEqual(fitRect({ x: 0, y: 0, w: 2824, h: 1000 }, { w: 800, h: 600 }, 40));
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

  it('hiding a device clears a selection on it', async () => {
    const { c } = ready();
    await c.tap(15, 15);
    c.setDevices(new Set<Device>(['tablet', 'mobile']));
    expect(c.selection).toBeNull();
    expect(c.frames.length).toBe(2);
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
      version: 1,
      pages: [{ pageId: 'other', name: 'Other', route: '/other', renders: { base: render('base', 'ob') } }],
    });
    expect(c.selection).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('setManifest clears a selection whose device render is gone', async () => {
    const { c, onSelect } = ready();
    await c.tap(15, 15);
    c.setManifest({
      version: 1,
      pages: [{ pageId: 'home', name: 'Home', route: '/', renders: { tablet: render('tablet', 'ht') } }],
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

  it('a tap still loading its hit map is dropped by setDevices', async () => {
    const d = deferredMaps();
    const { c, onSelect } = ready(undefined, d.hitMaps);
    const tap = c.tap(15, 15);
    c.setDevices(new Set<Device>(['tablet', 'mobile']));
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

  it('tileLoaded after setDevices repaints the frame at its moved position', () => {
    const { c, flush, base } = ready();
    // Hiding base moves the tablet frame to x=0, so its tile is no longer at x=1520.
    c.setDevices(new Set<Device>(['tablet', 'mobile']));
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

  it('defers the first fit until a frame exists', () => {
    const { c, flush } = harness();
    c.resize(800, 600, 1);
    c.setDevices(new Set<Device>());
    c.setManifest(M);
    flush();
    expect(c.frames).toEqual([]);
    expect(c.camera).toEqual({ x: 0, y: 0, scale: 1 });
    c.setDevices(new Set<Device>(DEVICES));
    flush();
    expect(c.camera).toEqual(fitRect({ x: 0, y: 0, w: 2824, h: 1000 }, { w: 800, h: 600 }, 40));
  });
});

describe('CanvasController with a real TileLoader', () => {
  // 50 one-screen-tall pages on the Tab S6 Lite in portrait, at MIN_SCALE: every frame is in view and
  // each has one 0.25 tile, so 150 tiles are visible and the 128-image cache cannot hold them all.
  const render1 = (device: Device, hash: string): PageRender => ({
    device,
    hash,
    width: DEVICE_WIDTH[device],
    height: 1000,
    levels: [
      { zoom: 0.25, key: hash + 'q', cols: 1, rows: 1 },
      { zoom: 0.5, key: hash + 'h', cols: 1, rows: 1 },
      { zoom: 1, key: hash, cols: 3, rows: 2 },
    ],
  });
  const BIG: RenderManifest = {
    version: 1,
    pages: Array.from({ length: 50 }, (_, i) => ({
      pageId: `p${i}`,
      name: `Page ${i}`,
      route: `/p${i}`,
      renders: {
        base: render1('base', `b${i}`),
        tablet: render1('tablet', `t${i}`),
        mobile: render1('mobile', `m${i}`),
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
