import { describe, expect, it } from 'vitest';
import {
  DEVICE_WIDTH,
  type Device,
  type PageRender,
  type RenderManifest,
} from '@hub/protocol';
import { frameAt, layoutBounds, layoutFrames } from './layout.js';

function render(device: Device, height: number): PageRender {
  return { device, hash: 'h', width: DEVICE_WIDTH[device], height, levels: [] };
}

const manifest: RenderManifest = {
  version: 1,
  pages: [
    {
      pageId: 'p1',
      name: 'Home',
      route: '/',
      renders: {
        base: render('base', 2000),
        tablet: render('tablet', 2400),
        mobile: render('mobile', 3000),
      },
    },
    {
      pageId: 'p2',
      name: 'About',
      route: '/about',
      renders: { base: render('base', 1000) },
    },
  ],
};

const ALL = new Set<Device>(['base', 'tablet', 'mobile']);

describe('layoutFrames', () => {
  it('a row per page, devices side by side', () => {
    const frames = layoutFrames(manifest, ALL);
    expect(frames.map((f) => [f.pageId, f.device, f.x, f.y, f.w, f.h])).toEqual([
      ['p1', 'base', 0, 0, 1440, 2000],
      ['p1', 'tablet', 1520, 0, 834, 2400],
      ['p1', 'mobile', 2434, 0, 390, 3000],
      ['p2', 'base', 0, 3200, 1440, 1000],
      ['p2', 'tablet', 1520, 3200, 834, 1194],
      ['p2', 'mobile', 2434, 3200, 390, 844],
    ]);
    const p2Tablet = frames.find((f) => f.pageId === 'p2' && f.device === 'tablet');
    expect(p2Tablet?.render).toBeNull();
  });

  it('hidden devices collapse', () => {
    const frames = layoutFrames(manifest, new Set<Device>(['base', 'mobile']));
    expect(frames).toHaveLength(4);
    const p1Mobile = frames.find((f) => f.pageId === 'p1' && f.device === 'mobile');
    expect(p1Mobile?.x).toBe(1520);
  });

  it('no visible device', () => {
    expect(layoutFrames(manifest, new Set<Device>())).toEqual([]);
  });
});

describe('frameAt', () => {
  it('finds the frame under a point and returns null in a gap', () => {
    const frames = layoutFrames(manifest, ALL);
    expect(frameAt(frames, { x: 1520, y: 10 })).toMatchObject({ pageId: 'p1', device: 'tablet' });
    expect(frameAt(frames, { x: 1500, y: 10 })).toBeNull();
  });
});

describe('layoutBounds', () => {
  it('is the union of all frames', () => {
    expect(layoutBounds(layoutFrames(manifest, ALL))).toEqual({ x: 0, y: 0, w: 2824, h: 4394 });
  });
});
