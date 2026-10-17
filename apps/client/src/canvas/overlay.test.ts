import { describe, expect, it } from 'vitest';
import type { HitBox } from '@hub/protocol';
import type { Camera } from './geom.js';
import type { Frame } from './layout.js';
import { paintOverlay, type OverlayInput } from './overlay.js';
import { fakeCtx } from './test-utils.js';

const camera: Camera = { x: 0, y: 0, scale: 0.5 };
const frame: Frame = { frameId: 'f', pageId: 'p', name: 'P', device: 'base', x: 0, y: 0, w: 1440, h: 1000, viewportHeight: 900, render: null, stale: null, pending: true };
const box: HitBox = { nodeId: 'n3', x: 20, y: 20, w: 100, h: 40 };
const input = (over: Partial<OverlayInput> = {}): OverlayInput =>
  ({ camera, dpr: 2, selection: { frame, boxes: [box] }, marquee: null, ...over });

describe('paintOverlay', () => {
  it('clears the whole canvas', () => {
    const { ctx, calls } = fakeCtx(1600, 1200);
    paintOverlay(ctx, input());
    expect(calls[0]).toMatchObject({ m: 'setTransform', a: [1, 0, 0, 1, 0, 0] });
    expect(calls[1]).toMatchObject({ m: 'clearRect', a: [0, 0, 1600, 1200] });
  });

  it('outlines selected boxes', () => {
    const { ctx, calls } = fakeCtx(1600, 1200);
    paintOverlay(ctx, input());
    expect(calls.find(c => c.m === 'strokeRect')).toMatchObject({
      a: [20, 20, 100, 40],
      stroke: '#1a73e8',
      lw: 4,
    });
  });

  it('draws the marquee', () => {
    const { ctx, calls } = fakeCtx(1600, 1200);
    paintOverlay(ctx, input({ selection: null, marquee: { x: 10, y: 10, w: 50, h: 30 } }));
    expect(calls.find(c => c.m === 'fillRect')).toMatchObject({
      a: [20, 20, 100, 60],
      fill: 'rgba(26,115,232,0.12)',
    });
    expect(calls.find(c => c.m === 'strokeRect')).toMatchObject({ a: [20, 20, 100, 60], lw: 2 });
  });

  it('nothing selected only clears', () => {
    const { ctx, calls } = fakeCtx(1600, 1200);
    paintOverlay(ctx, input({ selection: null, marquee: null }));
    expect(calls.filter(c => c.m === 'strokeRect')).toEqual([]);
    expect(calls.map(c => c.m)).toEqual(['setTransform', 'clearRect']);
  });
});
