import { expect, test } from 'vitest';
import { DEVICES, DEVICE_WIDTH, ZOOMS, TILE_SIZE, tileId, tilePath, hitMapPath } from './index.js';

test('device constants match the spec', () => {
  expect(DEVICES).toEqual(['base', 'tablet', 'mobile']);
  expect(DEVICE_WIDTH).toEqual({ base: 1440, tablet: 834, mobile: 390 });
  expect(ZOOMS).toEqual([0.25, 0.5, 1]);
  expect(TILE_SIZE).toBe(512);
});

test('path helpers', () => {
  expect(tileId('abc', 2, 3)).toBe('abc/2_3');
  expect(tilePath('abc', 2, 3)).toBe('tiles/abc/2_3.webp');
  expect(hitMapPath('h')).toBe('hitmaps/h.json');
});
