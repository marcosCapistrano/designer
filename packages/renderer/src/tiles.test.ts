import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Zoom } from '@hub/protocol';
import { sliceTiles } from './tiles.js';

const keyFor = (z: Zoom) => 'k' + z;

async function fixture(): Promise<Buffer> {
  return sharp({ create: { width: 1440, height: 1100, channels: 3, background: '#336699' } }).png().toBuffer();
}

describe('sliceTiles', () => {
  it('levels for a 1440x1100 page', async () => {
    const png = await fixture();
    const r = await sliceTiles(png, 1440, 1100, keyFor);
    expect(r.levels).toEqual([
      { zoom: 0.25, key: 'k0.25', cols: 1, rows: 1 },
      { zoom: 0.5, key: 'k0.5', cols: 2, rows: 2 },
      { zoom: 1, key: 'k1', cols: 3, rows: 3 },
    ]);
    expect(r.tiles.length).toBe(14);
  });

  it('row-major order', async () => {
    const png = await fixture();
    const r = await sliceTiles(png, 1440, 1100, keyFor);
    expect(r.tiles.filter((t) => t.key === 'k1').map((t) => `${t.x}_${t.y}`)).toEqual([
      '0_0', '1_0', '2_0', '0_1', '1_1', '2_1', '0_2', '1_2', '2_2',
    ]);
  });

  it('every tile is a 512x512 webp', async () => {
    const png = await fixture();
    const r = await sliceTiles(png, 1440, 1100, keyFor);
    for (const t of r.tiles) {
      const m = await sharp(t.data).metadata();
      expect(m.format).toBe('webp');
      expect(m.width).toBe(512);
      expect(m.height).toBe(512);
    }
  });

  it('edge tiles are transparent outside the page', async () => {
    const png = await fixture();
    const r = await sliceTiles(png, 1440, 1100, keyFor);
    const t = r.tiles.find((tile) => tile.key === 'k1' && tile.x === 2 && tile.y === 0);
    expect(t).toBeDefined();
    const { data } = await sharp(t!.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(0 * 512 + 415) * 4 + 3]).toBe(255);
    expect(data[(0 * 512 + 416) * 4 + 3]).toBe(0);
  });

  it('paths', async () => {
    const png = await fixture();
    const r = await sliceTiles(png, 1440, 1100, keyFor);
    const t = r.tiles.find((tile) => tile.key === 'k1' && tile.x === 2 && tile.y === 0);
    expect(t?.path).toBe('tiles/k1/2_0.webp');
  });

  it('deterministic', async () => {
    const png = await fixture();
    const a = await sliceTiles(png, 1440, 1100, keyFor);
    const b = await sliceTiles(png, 1440, 1100, keyFor);
    expect(b.tiles.length).toBe(a.tiles.length);
    a.tiles.forEach((t, i) => {
      expect(Buffer.compare(t.data, b.tiles[i]!.data)).toBe(0);
    });
  });
});
