import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tilePath, type HitBox, type RenderManifest } from '@hub/protocol';
import { FsTileStore, MemoryTileStore, type StoreFs } from './store.js';
import type { TileFile } from './tiles.js';

const t = (key: string, x: number, y: number): TileFile => ({
  key,
  x,
  y,
  path: tilePath(key, x, y),
  data: Buffer.from(`${key}${x}${y}`),
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

// The real fs functions, with `over` replacing some of them.
const fsWith = (over: Partial<StoreFs>): Partial<StoreFs> => over;

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

  it('a writeFile failure propagates and leaves no temp directory', async () => {
    const store = new FsTileStore(
      dir,
      fsWith({
        writeFile: async () => {
          throw errno('EPERM');
        },
      }),
    );
    await expect(store.putTiles([t('k1', 0, 0)])).rejects.toMatchObject({ code: 'EPERM' });
    expect(await store.hasLevel('k1')).toBe(false);
    expect(await readdir(join(dir, 'tiles'))).toEqual([]);
  });

  it.each(['EEXIST', 'ENOTEMPTY', 'EPERM'])('a %s rename collision with the level in place is not an error', async (code) => {
    const store = new FsTileStore(
      dir,
      fsWith({
        // Another writer finishes the level between our pre-check and our rename.
        rename: async () => {
          await mkdir(join(dir, 'tiles/k1'), { recursive: true });
          await writeFile(join(dir, 'tiles/k1/0_0.webp'), 'winner');
          throw errno(code);
        },
      }),
    );
    await store.putTiles([t('k1', 0, 0)]);
    expect((await readFile(join(dir, 'tiles/k1/0_0.webp'))).toString()).toBe('winner');
    expect(await readdir(join(dir, 'tiles'))).toEqual(['k1']);
  });

  it.each(['EEXIST', 'ENOTEMPTY', 'EPERM'])('a %s rename error without the level in place propagates', async (code) => {
    const store = new FsTileStore(
      dir,
      fsWith({
        rename: async () => {
          throw errno(code);
        },
      }),
    );
    await expect(store.putTiles([t('k1', 0, 0)])).rejects.toMatchObject({ code });
    expect(await store.hasLevel('k1')).toBe(false);
    expect(await readdir(join(dir, 'tiles'))).toEqual([]);
  });

  it('a real rename onto a non-empty level is swallowed', async () => {
    const store = new FsTileStore(
      dir,
      fsWith({
        rename: async (from, to) => {
          await mkdir(String(to), { recursive: true });
          await writeFile(join(String(to), '0_0.webp'), 'winner');
          await rename(from, to);
        },
      }),
    );
    await store.putTiles([t('k1', 0, 0)]);
    expect((await readFile(join(dir, 'tiles/k1/0_0.webp'))).toString()).toBe('winner');
    expect(await readdir(join(dir, 'tiles'))).toEqual(['k1']);
  });

  it('hit map json', async () => {
    const store = new FsTileStore(dir);
    const hitMap: HitBox[] = [{ nodeId: 'a', x: 0, y: 0, w: 1, h: 1 }];
    await store.putHitMap('h', hitMap);
    expect(JSON.parse(await readFile(join(dir, 'hitmaps/h.json'), 'utf8'))).toEqual(hitMap);
  });

  it('manifest roundtrip', async () => {
    const store = new FsTileStore(dir);
    const m: RenderManifest = { version: 2, pages: [] };
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

  it.each([
    ['missing', '{"version":2}'],
    ['a string', '{"version":2,"pages":"nope"}'],
    ['an object', '{"version":2,"pages":{}}'],
    ['null', '{"version":2,"pages":null}'],
  ])('pages that is %s is null', async (_name, text) => {
    const store = new FsTileStore(dir);
    await writeFile(join(dir, 'manifest.json'), text);
    expect(await store.readManifest()).toBeNull();
    const memory = new MemoryTileStore();
    memory.files.set('manifest.json', Buffer.from(text));
    expect(await memory.readManifest()).toBeNull();
  });

  it('wrong version is null', async () => {
    const store = new FsTileStore(dir);
    await writeFile(join(dir, 'manifest.json'), '{"version":1,"pages":[]}');
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
