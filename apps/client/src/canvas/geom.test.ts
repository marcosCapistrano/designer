import { describe, expect, it } from 'vitest';
import {
  clampScale,
  expandRect,
  fitRect,
  intersectRect,
  normalizeRect,
  panBy,
  rectsIntersect,
  screenToWorld,
  snapCamera,
  viewRect,
  worldToDevice,
  worldToScreen,
  zoomAt,
  MAX_SCALE,
  MIN_SCALE,
} from './geom.js';

describe('geom', () => {
  it('screen/world roundtrip', () => {
    const c = { x: 10, y: 20, scale: 2 };
    expect(screenToWorld(c, worldToScreen(c, { x: 5, y: 7 }))).toEqual({ x: 5, y: 7 });
    expect(worldToScreen(c, { x: 15, y: 20 })).toEqual({ x: 10, y: 0 });
  });

  it('panBy', () => {
    expect(panBy({ x: 100, y: 50, scale: 2 }, 10, -4)).toEqual({ x: 95, y: 52, scale: 2 });
  });

  it('zoomAt keeps the anchor', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 100, y: 100 }, 2)).toEqual({
      x: 50,
      y: 50,
      scale: 2,
    });
  });

  it('zoomAt clamps', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 1000).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 0.00001).scale).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE * 10)).toBe(MAX_SCALE);
    expect(clampScale(MIN_SCALE / 10)).toBe(MIN_SCALE);
  });

  it('viewRect', () => {
    expect(viewRect({ x: 10, y: 20, scale: 0.5 }, { w: 800, h: 600 })).toEqual({
      x: 10,
      y: 20,
      w: 1600,
      h: 1200,
    });
  });

  it('snapCamera', () => {
    expect(snapCamera({ x: 10.3, y: 0, scale: 1 }, 2)).toEqual({ x: 10.5, y: 0, scale: 1 });
  });

  it('fitRect', () => {
    expect(fitRect({ x: 0, y: 0, w: 1000, h: 500 }, { w: 1100, h: 600 }, 50)).toEqual({
      x: -50,
      y: -50,
      scale: 1,
    });
  });

  it('rectsIntersect', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it('intersectRect', () => {
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({
      x: 5,
      y: 5,
      w: 5,
      h: 5,
    });
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 5, h: 5 })).toBeNull();
  });

  it('normalizeRect', () => {
    expect(normalizeRect({ x: 10, y: 5 }, { x: 2, y: 9 })).toEqual({ x: 2, y: 5, w: 8, h: 4 });
  });

  it('expandRect', () => {
    expect(expandRect({ x: 0, y: 0, w: 100, h: 40 }, 0.25)).toEqual({
      x: -25,
      y: -10,
      w: 150,
      h: 60,
    });
  });

  it('worldToDevice rounds edges', () => {
    expect(worldToDevice({ x: 1, y: 1, w: 3, h: 3 }, { x: 0, y: 0, scale: 0.5 }, 1)).toEqual({
      x: 1,
      y: 1,
      w: 1,
      h: 1,
    });
  });
});
