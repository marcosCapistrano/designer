import { describe, expect, it } from 'vitest';
import {
  clampScale,
  expandRect,
  fitRect,
  fitRectInset,
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

describe('fitRectInset', () => {
  it('fits a rect inside the view minus the chrome around it', () => {
    const r = { x: 100, y: 200, w: 2000, h: 1000 };
    const view = { w: 1280, h: 800 };
    const insets = { top: 56, right: 0, bottom: 136, left: 0 };
    const cam = fitRectInset(r, view, 40, insets);
    const topLeft = worldToScreen(cam, { x: r.x, y: r.y });
    const bottomRight = worldToScreen(cam, { x: r.x + r.w, y: r.y + r.h });
    expect(topLeft.y).toBeGreaterThanOrEqual(56 + 40 - 1e-6);
    expect(bottomRight.y).toBeLessThanOrEqual(800 - 136 - 40 + 1e-6);
    expect(topLeft.x).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(bottomRight.x).toBeLessThanOrEqual(1280 - 40 + 1e-6);
    // Centered in the free area.
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(56 + (800 - 56 - 136) / 2, 6);
  });
  it('equals fitRect with no insets', () => {
    const r = { x: 0, y: 0, w: 500, h: 500 };
    expect(fitRectInset(r, { w: 800, h: 600 }, 40, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual(fitRect(r, { w: 800, h: 600 }, 40));
  });
});
