import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tilePath, type HitBox, type RenderManifest } from '@hub/protocol';
import { FsTileStore, MemoryTileStore } from './store.js';
import type { TileFile } from './tiles.js';

const t = (key: string, x: number, y: number): TileFile => ({
  key,
  x,
  y,
  path: tilePath(key, x, y),
  data: Buffer.from(`${key}${x}${y}`),
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tiles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FsTileStore', () => {
  it('writes a level and reports it', async () => {
    const store = new FsTileStore(dir);
    await store.putTiles([t('k1', 0, 0), t('k1', 1, 0)]);
    expect(await readFile(join(dir, 'tiles/k1/1_0.webp'))).toEqual(Buffer.from('k110'));
    expect(await store.hasLevel('k1')).toBe(true);
    expect(await store.hasLevel('k2')).toBe(false);
    expect(await readdir(join(dir, 'tiles'))).toEqual(['k1']);
  });

  it('an existing level is left untouched', async () => {
    const store = new FsTileStore(dir);
    await store.putTiles([t('k1', 0, 0)]);
    await store.putTiles([{ ...t('k1', 0, 0), data: Buffer.from('other') }]);
    expect((await readFile(join(dir, 'tiles/k1/0_0.webp'))).toString()).toBe('k100');
  });

  it('hit map json', async () => {
    const store = new FsTileStore(dir);
    const hitMap: HitBox[] = [{ nodeId: 'a', x: 0, y: 0, w: 1, h: 1 }];
    await store.putHitMap('h', hitMap);
    expect(JSON.parse(await readFile(join(dir, 'hitmaps/h.json'), 'utf8'))).toEqual(hitMap);
  });

  it('manifest roundtrip', async () => {
    const store = new FsTileStore(dir);
    const m: RenderManifest = { version: 1, pages: [] };
    await store.writeManifest(m);
    expect(await store.readManifest()).toEqual(m);
  });

  it('missing manifest is null', async () => {
    const store = new FsTileStore(dir);
    expect(await store.readManifest()).toBeNull();
  });

  it('corrupt manifest is null', async () => {
    const store = new FsTileStore(dir);
    await writeFile(join(dir, 'manifest.json'), 'nope');
    expect(await store.readManifest()).toBeNull();
  });

  it('wrong version is null', async () => {
    const store = new FsTileStore(dir);
    await writeFile(join(dir, 'manifest.json'), '{"version":2,"pages":[]}');
    expect(await store.readManifest()).toBeNull();
  });
});

describe('MemoryTileStore', () => {
  it('memory store uses the same paths', async () => {
    const store = new MemoryTileStore();
    await store.putTiles([t('k1', 0, 0)]);
    await store.putHitMap('h', []);
    expect([...store.files.keys()].sort()).toEqual(['hitmaps/h.json', 'tiles/k1/0_0.webp']);
    expect(await store.hasLevel('k1')).toBe(true);
  });
});
