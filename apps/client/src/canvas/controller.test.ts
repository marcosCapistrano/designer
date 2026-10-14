import { describe, expect, it, vi } from 'vitest';
import { DEVICES, DEVICE_WIDTH } from '@hub/protocol';
import type { Device, HitBox, PageRender, RenderManifest } from '@hub/protocol';
import { CanvasController } from './controller.js';
import { fitRect } from './geom.js';
import type { PointerIn } from './gestures.js';
import type { TileWant } from './loader.js';
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

const maps: Record<string, HitBox[]> = {
  hb: [
    { nodeId: 'n1', x: 0, y: 0, w: 1440, h: 1000 },
    { nodeId: 'n2', x: 0, y: 0, w: 1440, h: 80 },
    { nodeId: 'n3', x: 20, y: 20, w: 100, h: 40 },
  ],
};

function harness(now: () => number = () => 0) {
  const q: (() => void)[] = [];
  const flush = () => {
    while (q.length) q.shift()!();
  };
  const base = fakeCtx();
  const overlay = fakeCtx();
  const tiles = { get: () => undefined, request: vi.fn() };
  const hitMaps = {
    get: (h: string) => maps[h],
    load: async (h: string) => maps[h] ?? [],
  };
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

function ready(now: () => number = () => 0) {
  const h = harness(now);
  h.c.resize(800, 600, 1);
  h.c.setManifest(M);
  h.flush();
  h.c.setCamera({ x: 0, y: 0, scale: 0.5 });
  h.flush();
  return h;
}

const lastFill = (calls: Call[]) => calls.filter((c) => c.m === 'fillRect').at(-1);

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
    await new Promise((r) => setTimeout(r, 0));
    expect(c.selection?.nodeIds).toEqual(['n2']);
  });

  it('pans coalesce into one frame', () => {
    const { c, q } = ready();
    c.panBy(10, 0);
    c.panBy(10, 0);
    expect(q.length).toBe(1);
    expect(c.camera.x).toBe(-40);
  });

  it('requests visible tiles, then the coarse level', () => {
    const { c, tiles } = ready();
    c.frame();
    const wants = tiles.request.mock.lastCall?.[0] as readonly TileWant[];
    expect(wants.slice(0, 5).map((w) => `${w.key}/${w.x}_${w.y}`)).toEqual([
      'hbh/0_0',
      'hbh/1_0',
      'hth/0_0',
      'hbq/0_0',
      'htq/0_0',
    ]);
  });

  it('hiding a device clears a selection on it', async () => {
    const { c } = ready();
    await c.tap(15, 15);
    c.setDevices(new Set<Device>(['tablet', 'mobile']));
    expect(c.selection).toBeNull();
    expect(c.frames.length).toBe(2);
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
