import { describe, expect, it } from 'vitest';
import type { Zoom } from '@hub/protocol';
import { BasePainter, type PaintInput } from './painter.js';
import { fakeCtx, img, type Call } from './test-utils.js';
import type { Frame } from './layout.js';

const lv = (zoom: Zoom, key: string, cols: number, rows: number) => ({ zoom, key, cols, rows });
const frame = (over: Partial<Frame> = {}): Frame => ({ pageId: 'p', name: 'P', device: 'base', x: 0, y: 0, w: 1440, h: 1000,
  render: { device: 'base', hash: 'h', width: 1440, height: 1000, levels: [lv(0.25, 'q', 1, 1), lv(0.5, 'k', 2, 1), lv(1, 'h', 3, 2)] }, ...over });
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
    expect(label?.a).toEqual(['P · Desktop', 0, 14]);
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

  it('failed render shows a badge', () => {
    const { ctx, calls } = fakeCtx();
    const painter = new BasePainter(ctx, tilesOf());
    const failed = frame({ render: { ...frame().render!, error: 'boom' } });
    painter.paint(input([failed]));
    expect(calls.filter(c => c.m === 'fillRect' && c.fill === '#d93025').map(c => c.a)).toContainEqual([696, 8, 16, 16]);
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
    expect(calls.filter(c => c.m === 'fillText').map(c => c.a)).toEqual([['Narrow · Mobile', 0, 14]]);
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
