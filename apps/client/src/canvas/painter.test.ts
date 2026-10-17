import { describe, expect, it, vi } from 'vitest';
import type { Zoom } from '@hub/protocol';
import { BasePainter, type PaintInput } from './painter.js';
import { fakeCtx, img, type Call } from './test-utils.js';
import type { Frame } from './layout.js';

const lv = (zoom: Zoom, key: string, cols: number, rows: number) => ({ zoom, key, cols, rows });
const frame = (over: Partial<Frame> = {}): Frame => ({ frameId: 'f', pageId: 'p', name: 'P', device: 'base', x: 0, y: 0, w: 1440, h: 1000,
  viewportHeight: 900, stale: null, pending: false,
  render: { device: 'base', hash: 'h', width: 1440, viewportHeight: 900, height: 1000, levels: [lv(0.25, 'q', 1, 1), lv(0.5, 'k', 2, 1), lv(1, 'h', 3, 2)] }, ...over });
const tilesOf = (...ids: string[]) => { const m = new Map(ids.map(id => [id, img(id)])); return { get: (k: string, x: number, y: number) => m.get(`${k}/${x}_${y}`) }; };
const input = (frames: Frame[], over: Partial<PaintInput> = {}): PaintInput =>
  ({ camera: { x: 0, y: 0, scale: 0.5 }, viewport: { w: 800, h: 600 }, dpr: 1, frames, zoom: 0.5, smoothing: true, ...over });
const draws = (calls: Call[]) => calls.filter(c => c.m === 'drawImage' && (c.a[0] as { id?: string }).id).map(c => [(c.a[0] as { id: string }).id, ...c.a.slice(1)]);

describe('BasePainter', () => {
  it('full paint draws background, frame and tiles', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0', 'k/1_0'));
    const stats = painter.paint(input([frame()]));
    expect(stats).toMatchObject({ mode: 'full', blit: false, regions: 1, tilesDrawn: 2, missing: 0 });
    const fills = calls.filter(c => c.m === 'fillRect');
    expect(fills[0]).toMatchObject({ a: [0, 0, 800, 600], fill: '#e9e9ec' });
    expect(calls.filter(c => c.m === 'fillRect' && c.fill === '#ffffff').map(c => c.a)).toContainEqual([0, 0, 720, 500]);
    expect(draws(calls)).toEqual([['k/0_0', 0, 0, 512, 512], ['k/1_0', 512, 0, 512, 512]]);
  });

  it('labels frames above their top edge', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    painter.paint(input([frame()], { camera: { x: 0, y: -40, scale: 0.5 } }));
    const label = calls.find(c => c.m === 'fillText');
    expect(label).toMatchObject({ fill: '#5f6368' });
    expect(label?.a).toEqual(['P · 1440 × 900 · Desktop styles', 0, 14]);
  });

  it('labels a frame with its page, size and style tier', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    painter.paint(input([frame({ name: '/ads', w: 1600 })], { camera: { x: 0, y: -40, scale: 0.5 } }));
    expect(calls.find(c => c.m === 'fillText')?.a[0]).toBe('/ads · 1600 × 900 · Desktop styles');
  });

  it('labels a frame whose size has no render yet as rendering', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    painter.paint(input([frame({ name: '/ads', w: 700, device: 'tablet', h: 900, render: null, pending: true })], { camera: { x: 0, y: -40, scale: 0.5 } }));
    expect(calls.find(c => c.m === 'fillText')?.a[0]).toBe('/ads · 700 × 900 · Tablet styles · Rendering…');
  });

  it('draws a pending frame\'s stale tiles at their own size from its top-left, clipped to the frame', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0', 'k/1_0'));
    const stale = frame().render!;
    const pending = frame({ x: 100, y: 100, w: 700, h: 900, device: 'tablet', render: null, stale, pending: true });
    const stats = painter.paint(input([pending]));
    // The second column starts past the frame's right edge, so it is not drawn.
    expect(draws(calls)).toEqual([['k/0_0', 50, 50, 512, 512]]);
    expect(stats.tilesDrawn).toBe(1);
    const clipAt = calls.findIndex(c => c.m === 'rect' && (c.a as number[]).join() === '50,50,350,450');
    expect(clipAt).toBeGreaterThan(-1);
    expect(calls[clipAt + 1]?.m).toBe('clip');
  });

  it('draws a dashed fold line at the viewport height of a frame taller than it', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    painter.paint(input([frame()]));
    expect(calls.some(c => c.m === 'setLineDash' && (c.a[0] as number[]).length > 0)).toBe(true);
    expect(calls.filter(c => c.m === 'moveTo').map(c => c.a)).toEqual([[0, 450]]);
    expect(calls.filter(c => c.m === 'lineTo').map(c => c.a)).toEqual([[720, 450]]);

    const short = fakeCtx();
    new BasePainter(short.ctx, tilesOf()).paint(input([frame({ h: 900 })]));
    expect(short.calls.filter(c => c.m === 'moveTo')).toEqual([]);
  });

  it('pan blits and repaints only the exposed strip', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0'));
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 400, y: 0, scale: 0.5 } }));
    calls.length = 0;
    const stats = painter.paint(input(frames, { camera: { x: 380, y: 0, scale: 0.5 } }));
    expect(stats).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    const blit = calls.find(c => c.m === 'drawImage');
    expect(blit?.a[0]).toBe(ctx.canvas);
    expect(blit?.a[1]).toBe(10);
    expect(blit?.a[2]).toBe(0);
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 10, 600]]);
    expect(draws(calls)).toContainEqual(['k/0_0', -190, 0, 512, 512]);
  });

  it('pan left blits and repaints the right strip', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 0, y: 0, scale: 0.5 } }));
    calls.length = 0;
    const stats = painter.paint(input(frames, { camera: { x: 400, y: 0, scale: 0.5 } }));
    expect(stats).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    const blit = calls.find(c => c.m === 'drawImage');
    expect(blit?.a[0]).toBe(ctx.canvas);
    expect(blit?.a[1]).toBe(-200);
    expect(blit?.a[2]).toBe(0);
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[600, 0, 200, 600]]);
  });

  it('vertical pans blit and repaint the exposed top or bottom strip', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 0, y: 0, scale: 0.5 } }));
    calls.length = 0;
    // Camera moves up (y decreases): content moves down, so dy > 0 and the top strip is exposed.
    expect(painter.paint(input(frames, { camera: { x: 0, y: -100, scale: 0.5 } }))).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    const down = calls.find(c => c.m === 'drawImage');
    expect(down?.a[1]).toBe(0);
    expect(down?.a[2]).toBe(50);
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 800, 50]]);
    calls.length = 0;
    // Camera moves back down: dy < 0 and the bottom strip is exposed.
    expect(painter.paint(input(frames, { camera: { x: 0, y: 0, scale: 0.5 } }))).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    const up = calls.find(c => c.m === 'drawImage');
    expect(up?.a[1]).toBe(0);
    expect(up?.a[2]).toBe(-50);
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 550, 800, 50]]);
  });

  it('no change paints nothing', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0'));
    const frames = [frame()];
    painter.paint(input(frames));
    calls.length = 0;
    const stats = painter.paint(input(frames));
    expect(stats).toMatchObject({ mode: 'none', regions: 0 });
    expect(calls.filter(c => c.m === 'drawImage')).toEqual([]);
  });

  it('scale change repaints fully', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    expect(painter.paint(input(frames, { camera: { x: 0, y: 0, scale: 0.6 } }))).toMatchObject({ mode: 'full' });
  });

  it('large pan repaints fully', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    expect(painter.paint(input(frames, { camera: { x: 2000, y: 0, scale: 0.5 } }))).toMatchObject({ mode: 'full' });
  });

  it('invalidateWorld repaints that rect', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    painter.invalidateWorld({ x: 0, y: 0, w: 100, h: 100 });
    calls.length = 0;
    const stats = painter.paint(input(frames));
    expect(stats).toMatchObject({ mode: 'partial', blit: false, regions: 1 });
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 50, 50]]);
  });

  it('missing tile uses a coarser fallback', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('q/0_0'));
    const stats = painter.paint(input([frame()], { zoom: 1, camera: { x: 0, y: 0, scale: 1 } }));
    expect(stats).toMatchObject({ tilesDrawn: 0, missing: 4 });
    expect(draws(calls)).toContainEqual(['q/0_0', 128, 128, 128, 128, 512, 512, 512, 512]);
  });

  it('a failed render shows a badge on every frame of that size', () => {
    const { ctx, calls } = fakeCtx(800, 1200);
    const painter = new BasePainter(ctx, tilesOf());
    const render = { ...frame().render!, error: 'boom' };
    const failed = [frame({ frameId: 'a', render }), frame({ frameId: 'b', y: 1100, render })];
    painter.paint(input(failed, { viewport: { w: 800, h: 1200 } }));
    expect(calls.filter(c => c.m === 'fillRect' && c.fill === '#d93025').map(c => c.a)).toEqual([[696, 8, 16, 16], [696, 558, 16, 16]]);
  });

  it('smoothing off during interaction', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0'));
    painter.paint(input([frame()], { smoothing: false }));
    const tileDraws = calls.filter(c => c.m === 'drawImage' && (c.a[0] as { id?: string }).id !== undefined);
    expect(tileDraws.length).toBeGreaterThan(0);
    for (const c of tileDraws) expect(c.smooth).toBe(false);
  });

  it('smoothing back on repaints fully', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { smoothing: false }));
    expect(painter.paint(input(frames, { smoothing: true }))).toMatchObject({ mode: 'full' });
  });

  it('new frames array repaints fully', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    painter.paint(input([frame()]));
    expect(painter.paint(input([frame()]))).toMatchObject({ mode: 'full' });
  });

  it('dpr change repaints fully even at the same canvas size', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { dpr: 1 }));
    expect(painter.paint(input(frames, { dpr: 2 }))).toMatchObject({ mode: 'full' });
  });

  it('invalidate() repaints fully once, then paints are incremental again', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    painter.invalidate();
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'full', regions: 1 });
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'none' });
  });

  it('a canvas width or height change repaints fully', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    ctx.canvas.width = 640;
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'full' });
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'none' });
    ctx.canvas.height = 500;
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'full' });
  });

  it('a label wider than its frame is redrawn when a strip touches only its overhang', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const narrow = [frame({ name: 'Narrow', device: 'mobile', w: 100 })];
    painter.paint(input(narrow, { camera: { x: -400, y: -40, scale: 0.5 } }));
    calls.length = 0;
    // The frame moves to device x 0..50; the exposed right strip (600..800) lies past its right edge.
    const stats = painter.paint(input(narrow, { camera: { x: 0, y: -40, scale: 0.5 } }));
    expect(stats).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    expect(calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[600, 0, 200, 600]]);
    expect(calls.filter(c => c.m === 'fillText').map(c => c.a)).toEqual([['Narrow · 100 × 900 · Mobile styles', 0, 14]]);
  });

  it('a missing tile falls back to zoom 0.5 before zoom 0.25 when both are loaded', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf('k/0_0', 'q/0_0'));
    painter.paint(input([frame()], { zoom: 1, camera: { x: 0, y: 0, scale: 1 } }));
    const drawn = draws(calls);
    expect(drawn).toContainEqual(['k/0_0', 0, 0, 256, 256, 0, 0, 512, 512]);
    expect(drawn.filter(d => d[0] === 'q/0_0')).toEqual([]);
  });

  it('a paint that throws mid-way forces a full repaint next time', () => {
    const { ctx, saveDepth } = fakeCtx();
    const loaded = tilesOf('k/0_0', 'k/1_0');
    let failing = false;
    const tiles = {
      get: (k: string, x: number, y: number) => {
        if (failing) throw new Error('boom');
        return loaded.get(k, x, y);
      },
    };
    const painter = new BasePainter(ctx, tiles);
    const frames = [frame({ w: 2000 })];
    painter.paint(input(frames));
    // The pan blits the canvas, then the exposed strip's tile lookup throws.
    failing = true;
    expect(() => painter.paint(input(frames, { camera: { x: 20, y: 0, scale: 0.5 } }))).toThrow('boom');
    // The region's save() is matched by a restore() in finally, so no clip leaks.
    expect(saveDepth()).toBe(0);
    failing = false;
    // Without a full repaint this would blit the already-shifted canvas a second time.
    expect(painter.paint(input(frames, { camera: { x: 20, y: 0, scale: 0.5 } }))).toMatchObject({ mode: 'full' });
  });
});

describe('BasePainter with a back buffer', () => {
  function pair() {
    const front = fakeCtx();
    const back = fakeCtx();
    const present = vi.fn();
    return { front, back, present, buffer: { ctx: back.ctx, present } };
  }
  const selfDraws = (calls: Call[], canvas: unknown) => calls.filter(c => c.m === 'drawImage' && c.a[0] === canvas);

  it('paints the first frame on the shown canvas and does not present', () => {
    const { front, back, present, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf('k/0_0'), buffer);
    painter.paint(input([frame()]));
    expect(front.calls.filter(c => c.m === 'fillRect').length).toBeGreaterThan(0);
    expect(back.calls).toEqual([]);
    expect(present).not.toHaveBeenCalled();
  });

  it('a pan blits the shown canvas into the other one, repaints the strip there and shows it', () => {
    const { front, back, present, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf('k/0_0'), buffer);
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 400, y: 0, scale: 0.5 } }));
    front.calls.length = 0;
    const stats = painter.paint(input(frames, { camera: { x: 380, y: 0, scale: 0.5 } }));
    expect(stats).toMatchObject({ mode: 'partial', blit: true, regions: 1 });
    const blit = back.calls.find(c => c.m === 'drawImage');
    expect(blit?.a.slice(0, 3)).toEqual([front.ctx.canvas, 10, 0]);
    expect(back.calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 10, 600]]);
    expect(draws(back.calls)).toContainEqual(['k/0_0', -190, 0, 512, 512]);
    // The canvas that was shown is only read.
    expect(front.calls.filter(c => c.m !== 'setTransform')).toEqual([]);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith(back.ctx);
  });

  it('successive pans alternate between the two canvases and never draw a canvas onto itself', () => {
    const { front, back, present, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf(), buffer);
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 400, y: 0, scale: 0.5 } }));
    painter.paint(input(frames, { camera: { x: 380, y: 0, scale: 0.5 } }));
    painter.paint(input(frames, { camera: { x: 360, y: 0, scale: 0.5 } }));
    painter.paint(input(frames, { camera: { x: 340, y: 0, scale: 0.5 } }));
    expect(present.mock.calls.map(c => c[0])).toEqual([back.ctx, front.ctx, back.ctx]);
    expect(selfDraws(front.calls, front.ctx.canvas)).toEqual([]);
    expect(selfDraws(back.calls, back.ctx.canvas)).toEqual([]);
    // Each blit reads the canvas the previous frame ended on.
    expect(selfDraws(back.calls, front.ctx.canvas)).toHaveLength(2);
    expect(selfDraws(front.calls, back.ctx.canvas)).toHaveLength(1);
  });

  it('a paint without a blit stays on the shown canvas', () => {
    const { front, back, present, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf(), buffer);
    const frames = [frame()];
    painter.paint(input(frames));
    painter.invalidateWorld({ x: 0, y: 0, w: 100, h: 100 });
    front.calls.length = 0;
    expect(painter.paint(input(frames))).toMatchObject({ mode: 'partial', blit: false });
    expect(front.calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 50, 50]]);
    expect(back.calls).toEqual([]);
    expect(present).not.toHaveBeenCalled();
  });

  it('a pan with a dirty rect repaints it in the canvas that is shown next', () => {
    const { front, back, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf(), buffer);
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 400, y: 0, scale: 0.5 } }));
    painter.invalidateWorld({ x: 500, y: 100, w: 100, h: 100 });
    painter.paint(input(frames, { camera: { x: 380, y: 0, scale: 0.5 } }));
    expect(back.calls.filter(c => c.m === 'rect').map(c => c.a)).toEqual([[0, 0, 10, 600], [60, 50, 50, 50]]);
  });

  it('a full repaint paints the shown canvas', () => {
    const { front, back, present, buffer } = pair();
    const painter = new BasePainter(front.ctx, tilesOf(), buffer);
    const frames = [frame()];
    painter.paint(input(frames));
    front.calls.length = 0;
    expect(painter.paint(input(frames, { camera: { x: 0, y: 0, scale: 0.6 } }))).toMatchObject({ mode: 'full' });
    expect(front.calls.some(c => c.m === 'fillRect')).toBe(true);
    expect(back.calls).toEqual([]);
    expect(present).not.toHaveBeenCalled();
  });

  it('a paint that throws after the blit leaves the shown canvas as it was and repaints it fully next', () => {
    const { front, back, present, buffer } = pair();
    const loaded = tilesOf('k/0_0', 'k/1_0');
    let failing = false;
    const tiles = {
      get: (k: string, x: number, y: number) => {
        if (failing) throw new Error('boom');
        return loaded.get(k, x, y);
      },
    };
    const painter = new BasePainter(front.ctx, tiles, buffer);
    const frames = [frame({ w: 2000 })];
    painter.paint(input(frames));
    front.calls.length = 0;
    failing = true;
    expect(() => painter.paint(input(frames, { camera: { x: 20, y: 0, scale: 0.5 } }))).toThrow('boom');
    expect(present).not.toHaveBeenCalled();
    expect(front.calls.filter(c => c.m !== 'setTransform')).toEqual([]);
    failing = false;
    back.calls.length = 0;
    expect(painter.paint(input(frames, { camera: { x: 20, y: 0, scale: 0.5 } }))).toMatchObject({ mode: 'full' });
    expect(front.calls.some(c => c.m === 'fillRect')).toBe(true);
    expect(back.calls).toEqual([]);
  });
});

describe('BasePainter frame handles', () => {
  it('draws the height tab outside the right edge at the viewport line', () => {
    const { ctx, calls } = fakeCtx();
    new BasePainter(ctx, tilesOf()).paint(input([frame()], { camera: { x: 0, y: 0, scale: 0.5 } }));
    // Right edge at device x 720, viewport line at device y 450; the tab is 24 CSS px wide.
    expect(calls.filter(c => c.m === 'fillRect' && c.fill === '#9aa0a6').map(c => c.a)).toContainEqual([720, 438, 24, 24]);
  });

  it('draws the readout next to the handle being dragged', () => {
    const { ctx, calls } = fakeCtx();
    const f = frame({ w: 1640, render: null, pending: true, h: 900 });
    new BasePainter(ctx, tilesOf()).paint(input([f], { camera: { x: 0, y: -40, scale: 0.5 }, readout: { frameId: 'f', kind: 'width' } }));
    const text = calls.find(c => c.m === 'fillText' && c.a[0] === '1640 × 900 · Desktop');
    expect(text).toBeDefined();
    expect(text!.a[1]).toBeGreaterThan(820);
  });

  it('a readout change repaints in full, so the old readout is not left behind', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { readout: { frameId: 'f', kind: 'width' } }));
    expect(painter.paint(input(frames, { readout: null })).mode).toBe('full');
    expect(painter.paint(input(frames)).mode).toBe('none');
  });
});

describe('BasePainter.previewOf', () => {
  it('is null before the first paint', () => {
    const { ctx } = fakeCtx();
    expect(new BasePainter(ctx, tilesOf()).previewOf(input([frame()]))).toBeNull();
  });

  it('returns the snapped camera of the painted image, whatever the new camera, zoom or smoothing', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames, { camera: { x: 100.2, y: 50, scale: 0.5 } }));
    expect(painter.previewOf(input(frames, { camera: { x: 700, y: 90, scale: 0.9 }, zoom: 1, smoothing: false })))
      .toEqual({ x: 100, y: 50, scale: 0.5 });
  });

  it('is null once the painted image no longer matches', () => {
    const { ctx } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const frames = [frame()];
    painter.paint(input(frames));
    expect(painter.previewOf(input([frame()]))).toBeNull();
    expect(painter.previewOf(input(frames, { dpr: 2 }))).toBeNull();
    ctx.canvas.width = 640;
    expect(painter.previewOf(input(frames))).toBeNull();
    painter.paint(input(frames));
    expect(painter.previewOf(input(frames))).not.toBeNull();
    painter.invalidate();
    expect(painter.previewOf(input(frames))).toBeNull();
  });
});
