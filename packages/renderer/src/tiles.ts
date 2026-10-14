import sharp from 'sharp';
import { TILE_SIZE, ZOOMS, tilePath, type TileLevel, type Zoom } from '@hub/protocol';

export interface TileFile { key: string; x: number; y: number; path: string; data: Buffer }

export const WEBP_OPTIONS = { quality: 80, effort: 4 } as const;

/**
 * Slices a page PNG into TILE_SIZE x TILE_SIZE WebP tiles at each zoom in ZOOMS.
 * Levels follow ZOOMS order; tiles are row-major within a level. Edge tiles are
 * zero-padded (transparent) outside the page.
 */
export async function sliceTiles(
  png: Buffer,
  width: number,
  height: number,
  keyFor: (zoom: Zoom) => string,
): Promise<{ levels: TileLevel[]; tiles: TileFile[] }> {
  const levels: TileLevel[] = [];
  const tiles: TileFile[] = [];

  for (const zoom of ZOOMS) {
    const lw = Math.ceil(width * zoom);
    const lh = Math.ceil(height * zoom);
    const key = keyFor(zoom);
    const img = zoom === 1 ? sharp(png) : sharp(png).resize(lw, lh, { kernel: 'lanczos3', fit: 'fill' });
    const { data } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const cols = Math.ceil(lw / TILE_SIZE);
    const rows = Math.ceil(lh / TILE_SIZE);
    levels.push({ zoom, key, cols, rows });

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const buf = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
        const tw = Math.min(TILE_SIZE, lw - tx * TILE_SIZE);
        const th = Math.min(TILE_SIZE, lh - ty * TILE_SIZE);
        for (let row = 0; row < th; row++) {
          const srcStart = ((ty * TILE_SIZE + row) * lw + tx * TILE_SIZE) * 4;
          data.copy(buf, row * TILE_SIZE * 4, srcStart, srcStart + tw * 4);
        }
        const webp = await sharp(buf, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 } })
          .webp(WEBP_OPTIONS)
          .toBuffer();
        tiles.push({ key, x: tx, y: ty, path: tilePath(key, tx, ty), data: webp });
      }
    }
  }

  return { levels, tiles };
}
