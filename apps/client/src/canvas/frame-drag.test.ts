import { describe, expect, it } from 'vitest';
import type { CanvasFrame } from '@hub/protocol';
import { HANDLE_PX, dragFrame, hitHandle, settleFrame } from './frame-drag.js';
import type { Frame } from './layout.js';

const frame = (over: Partial<Frame> = {}): Frame => ({
  frameId: 'fa',
  pageId: 'p',
  name: 'P',
  device: 'base',
  x: 0,
  y: 0,
  w: 1440,
  h: 1000,
  viewportHeight: 900,
  render: null,
  stale: null,
  pending: false,
  ...over,
});

const cf: CanvasFrame = { id: 'f0000000000000001', pageId: 'p', x: 0, y: 0, width: 1440, viewportHeight: 900 };

describe('hitHandle', () => {
  const frames = [frame()];

  it('at scale 1: the label band moves, the right band resizes, the tab at the viewport line sets the height', () => {
    expect(HANDLE_PX).toBe(24);
    expect(hitHandle(frames, { x: 100, y: -10 }, 1)).toEqual({ frameId: 'fa', kind: 'move' });
    expect(hitHandle(frames, { x: 100, y: -21 }, 1)).toBeNull();
    expect(hitHandle(frames, { x: 1450, y: 500 }, 1)).toEqual({ frameId: 'fa', kind: 'width' });
    expect(hitHandle(frames, { x: 1450, y: 910 }, 1)).toEqual({ frameId: 'fa', kind: 'height' });
    expect(hitHandle(frames, { x: 1450, y: 880 }, 1)).toEqual({ frameId: 'fa', kind: 'height' });
    expect(hitHandle(frames, { x: 1450, y: 930 }, 1)).toEqual({ frameId: 'fa', kind: 'width' });
    expect(hitHandle(frames, { x: 1465, y: 500 }, 1)).toBeNull();
    expect(hitHandle(frames, { x: 1450, y: 1100 }, 1)).toBeNull();
  });

  it('at scale 0.25 the bands are four times as wide in world px', () => {
    expect(hitHandle(frames, { x: 100, y: -70 }, 0.25)).toEqual({ frameId: 'fa', kind: 'move' });
    expect(hitHandle(frames, { x: 100, y: -90 }, 0.25)).toBeNull();
    expect(hitHandle(frames, { x: 1530, y: 500 }, 0.25)).toEqual({ frameId: 'fa', kind: 'width' });
    expect(hitHandle(frames, { x: 1530, y: 990 }, 0.25)).toEqual({ frameId: 'fa', kind: 'height' });
    expect(hitHandle(frames, { x: 1540, y: 500 }, 0.25)).toBeNull();
  });

  it('a point inside a frame is never a handle, even inside another frame\'s band', () => {
    expect(hitHandle(frames, { x: 100, y: 100 }, 1)).toBeNull();
    const two = [frame(), frame({ frameId: 'fb', x: 1520 })];
    // At scale 0.25 the first frame's right band (96 world px) reaches into the second frame.
    expect(hitHandle(two, { x: 1530, y: 500 }, 0.25)).toBeNull();
  });
});

describe('dragFrame', () => {
  it('moves by dx and dy', () => {
    expect(dragFrame(cf, 'move', 13.4, -5.6)).toEqual({ ...cf, x: 13, y: -6 });
  });

  it('a width drag changes the width only, clamped to the limits', () => {
    expect(dragFrame(cf, 'width', 200, 50)).toEqual({ ...cf, width: 1640 });
    expect(dragFrame(cf, 'width', 3000, 0).width).toBe(3840);
    expect(dragFrame(cf, 'width', -5000, 0).width).toBe(240);
  });

  it('a height drag changes the viewport height only, clamped to the limits', () => {
    expect(dragFrame(cf, 'height', 50, 100)).toEqual({ ...cf, viewportHeight: 1000 });
    expect(dragFrame(cf, 'height', 0, -1000).viewportHeight).toBe(320);
    expect(dragFrame(cf, 'height', 0, 9000).viewportHeight).toBe(4000);
  });

  it('a move is clamped to the coordinate limits', () => {
    expect(dragFrame(cf, 'move', 2_000_000, -2_000_000)).toMatchObject({ x: 1_000_000, y: -1_000_000 });
  });
});

describe('settleFrame', () => {
  it('snaps x and y to the 8 px grid', () => {
    expect(settleFrame({ ...cf, x: 13, y: -5 })).toEqual({ ...cf, x: 16, y: -8 });
    expect(settleFrame({ ...cf, x: 3, y: -3 })).toEqual({ ...cf, x: 0, y: 0 });
  });
});
