import { describe, expect, it } from 'vitest';
import type { PageRender } from '@hub/protocol';
import { fallbackFor, frameTiles, pickZoom, visibleTiles, type TileRef } from './tiles.js';
import type { Frame } from './layout.js';

const render: PageRender = {
  device: 'base',
  hash: 'h',
  width: 1440,
  height: 3000,
  levels: [
    { zoom: 0.25, key: 'q', cols: 1, rows: 2 },
    { zoom: 0.5, key: 'k', cols: 2, rows: 3 },
    { zoom: 1, key: 'h', cols: 3, rows: 6 },
  ],
};

const F: Frame = {
  pageId: 'p1',
  name: 'Home',
  device: 'base',
  x: 0,
  y: 0,
  w: 1440,
  h: 3000,
  render,
};

function keys(tiles: TileRef[]): [string, number, number][] {
  return tiles.map((t) => [t.key, t.x, t.y]);
}

describe('tiles', () => {
  it('pickZoom picks the smallest zoom that covers scale * dpr', () => {
    expect(pickZoom(0.1, 1)).toBe(0.25);
    expect(pickZoom(0.25, 1)).toBe(0.25);
    expect(pickZoom(0.3, 1)).toBe(0.5);
    expect(pickZoom(0.2, 2)).toBe(0.5);
    expect(pickZoom(0.3, 2)).toBe(1);
    expect(pickZoom(0.6, 1)).toBe(1);
    expect(pickZoom(3, 1)).toBe(1);
  });

  it('tiles in a small area', () => {
    expect(keys(frameTiles(F, 0.5, { x: 0, y: 0, w: 1000, h: 1000 }))).toEqual([['k', 0, 0]]);
  });

  it('area straddling a tile edge', () => {
    expect(keys(frameTiles(F, 0.5, { x: 1020, y: 0, w: 10, h: 10 }))).toEqual([
      ['k', 0, 0],
      ['k', 1, 0],
    ]);
  });

  it('edge exactly on a boundary is exclusive', () => {
    expect(keys(frameTiles(F, 0.5, { x: 0, y: 0, w: 1024, h: 10 }))).toEqual([['k', 0, 0]]);
  });

  it('clamped to the level grid', () => {
    const tiles = frameTiles(F, 0.5, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 });
    expect(tiles).toHaveLength(6);
    expect(tiles[5]?.world).toEqual({ x: 1024, y: 2048, w: 1024, h: 1024 });
  });

  it('no level, no tiles', () => {
    const noRender: Frame = { ...F, render: null };
    expect(frameTiles(noRender, 0.5, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual([]);
  });

  it('visibleTiles skips frames outside the area', () => {
    const far: Frame = { ...F, pageId: 'p2', x: 5000 };
    const tiles = visibleTiles([F, far], { x: 0, y: 0, w: 1000, h: 1000 }, 0.5);
    expect(keys(tiles)).toEqual([['k', 0, 0]]);
  });

  it('fallback to a coarser level', () => {
    const ref: TileRef = {
      key: 'h',
      x: 2,
      y: 5,
      zoom: 1,
      world: { x: 1024, y: 2560, w: 512, h: 512 },
    };
    expect(fallbackFor(F, ref, 0.25)).toMatchObject({
      ref: { key: 'q', x: 0, y: 1, zoom: 0.25 },
      sx: 256,
      sy: 128,
      sw: 128,
      sh: 128,
    });
    expect(fallbackFor(F, ref, 1)).toBeNull();
  });
});
