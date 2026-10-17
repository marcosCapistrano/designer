import { describe, expect, it } from 'vitest';
import {
  DEVICE_VIEWPORT_HEIGHT,
  DEVICE_WIDTH,
  type CanvasFrame,
  type Device,
  type PageRender,
  type RenderManifest,
} from '@hub/protocol';
import { frameAt, layoutBounds, layoutFrames } from './layout.js';

function render(device: Device, height: number, hash = 'h'): PageRender {
  return { device, hash, width: DEVICE_WIDTH[device], viewportHeight: DEVICE_VIEWPORT_HEIGHT[device], height, levels: [] };
}

const manifest: RenderManifest = {
  version: 2,
  pages: [
    {
      pageId: 'p1',
      name: 'Home',
      route: '/',
      renders: {
        '1440x900': render('base', 2000),
        '834x1194': render('tablet', 600),
        '390x844': render('mobile', 3000),
      },
    },
    {
      pageId: 'p2',
      name: 'About',
      route: '/about',
      renders: { '1440x900': render('base', 1000) },
    },
  ],
};

const cf = (id: string, pageId: string, x: number, y: number, width: number, viewportHeight: number): CanvasFrame => ({
  id,
  pageId,
  x,
  y,
  width,
  viewportHeight,
});

const FRAMES: CanvasFrame[] = [
  cf('fa', 'p1', 100, -50, 1440, 900),
  cf('fb', 'p1', 1700, 40, 834, 1194),
  cf('fc', 'p2', -400, 3000, 1440, 900),
  cf('fd', 'p2', 1200, 3000, 1600, 900),
];

describe('layoutFrames', () => {
  it('places frames at their saved positions with their page and tier', () => {
    const frames = layoutFrames(FRAMES, manifest);
    expect(frames.map((f) => [f.frameId, f.pageId, f.name, f.device, f.x, f.y, f.w, f.viewportHeight])).toEqual([
      ['fa', 'p1', 'Home', 'base', 100, -50, 1440, 900],
      ['fb', 'p1', 'Home', 'tablet', 1700, 40, 834, 1194],
      ['fc', 'p2', 'About', 'base', -400, 3000, 1440, 900],
      ['fd', 'p2', 'About', 'base', 1200, 3000, 1600, 900],
    ]);
  });

  it('is as tall as the render or the viewport, whichever is taller', () => {
    const [fa, fb] = layoutFrames(FRAMES, manifest);
    expect(fa?.h).toBe(2000);
    expect(fb?.h).toBe(1194);
  });

  it('skips a frame whose page is not in the manifest', () => {
    const frames = layoutFrames([...FRAMES, cf('fz', 'gone', 0, 0, 1440, 900)], manifest);
    expect(frames.map((f) => f.frameId)).toEqual(['fa', 'fb', 'fc', 'fd']);
  });

  it('a size with no render is pending, with the frame\'s last render as stale and as tall as it', () => {
    const last = render('base', 4200, 'old');
    const frames = layoutFrames(FRAMES, manifest, new Map([['fd', last], ['fa', render('base', 5, 'x')]]));
    const fd = frames.find((f) => f.frameId === 'fd');
    // The stale tiles keep their size, so the page does not vanish below the fold while it re-renders.
    expect(fd).toMatchObject({ render: null, pending: true, stale: last, h: 4200 });
    const fa = frames.find((f) => f.frameId === 'fa');
    expect(fa).toMatchObject({ pending: false, stale: null });
    expect(fa?.render).toBe(manifest.pages[0]!.renders['1440x900']);
    // With no last render, a pending frame is its viewport height.
    expect(layoutFrames(FRAMES, manifest).find((f) => f.frameId === 'fd')).toMatchObject({ stale: null, h: 900 });
  });
});

describe('frameAt', () => {
  it('finds the frame under a point and returns null in a gap', () => {
    const frames = layoutFrames(FRAMES, manifest);
    expect(frameAt(frames, { x: 1700, y: 50 })).toMatchObject({ frameId: 'fb' });
    expect(frameAt(frames, { x: 1600, y: 50 })).toBeNull();
  });

  it('where frames overlap, returns the one painted on top (the later one)', () => {
    const over: CanvasFrame[] = [
      { id: 'fa', pageId: FRAMES[0]!.pageId, x: 0, y: 0, width: 1440, viewportHeight: 900 },
      { id: 'fb', pageId: FRAMES[0]!.pageId, x: 100, y: 100, width: 1440, viewportHeight: 900 },
    ];
    const frames = layoutFrames(over, manifest);
    expect(frameAt(frames, { x: 200, y: 200 })).toMatchObject({ frameId: 'fb' });
    expect(frameAt(frames, { x: 50, y: 50 })).toMatchObject({ frameId: 'fa' });
  });
});

describe('layoutBounds', () => {
  it('is the union of all frames', () => {
    expect(layoutBounds(layoutFrames(FRAMES, manifest))).toEqual({ x: -400, y: -50, w: 3200, h: 4050 });
  });
});
