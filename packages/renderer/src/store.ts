import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MANIFEST_PATH, hitMapPath, tilePath, type HitBox, type RenderManifest } from '@hub/protocol';
import type { TileFile } from './tiles.js';

export interface TileStore {
  /** True when tile 0_0 of that level exists. */
  hasLevel(key: string): Promise<boolean>;
  /** Levels that already exist are left untouched. */
  putTiles(tiles: readonly TileFile[]): Promise<void>;
  putHitMap(hash: string, hitMap: readonly HitBox[]): Promise<void>;
  /** null when missing, unparsable, or version !== 1. */
  readManifest(): Promise<RenderManifest | null>;
  writeManifest(m: RenderManifest): Promise<void>;
}

let seq = 0;
function tmpSuffix(): string {
  return `tmp-${process.pid}-${seq++}`;
}

function parseManifest(text: string): RenderManifest | null {
  try {
    const m: unknown = JSON.parse(text);
    return typeof m === 'object' && m !== null && (m as { version?: unknown }).version === 1
      ? (m as RenderManifest)
      : null;
  } catch {
    return null;
  }
}

function groupByKey(tiles: readonly TileFile[]): Map<string, TileFile[]> {
  const groups = new Map<string, TileFile[]>();
  for (const t of tiles) {
    const group = groups.get(t.key);
    if (group) group.push(t);
    else groups.set(t.key, [t]);
  }
  return groups;
}

function isExistsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

/** Filesystem store rooted at `dir`. Every write is atomic (temp name, then rename). */
export class FsTileStore implements TileStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async hasLevel(key: string): Promise<boolean> {
    try {
      await stat(join(this.dir, tilePath(key, 0, 0)));
      return true;
    } catch {
      return false;
    }
  }

  async putTiles(tiles: readonly TileFile[]): Promise<void> {
    const tilesRoot = join(this.dir, 'tiles');
    for (const [key, group] of groupByKey(tiles)) {
      if (await this.hasLevel(key)) continue;
      const target = join(tilesRoot, key);
      const tmp = join(tilesRoot, `${key}.${tmpSuffix()}`);
      await mkdir(tmp, { recursive: true });
      try {
        for (const t of group) await writeFile(join(tmp, `${t.x}_${t.y}.webp`), t.data);
        await rename(tmp, target);
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        if (!isExistsError(e)) throw e;
      }
    }
  }

  async putHitMap(hash: string, hitMap: readonly HitBox[]): Promise<void> {
    await writeAtomic(join(this.dir, hitMapPath(hash)), JSON.stringify(hitMap));
  }

  async readManifest(): Promise<RenderManifest | null> {
    let text: string;
    try {
      text = await readFile(join(this.dir, MANIFEST_PATH), 'utf8');
    } catch {
      return null;
    }
    return parseManifest(text);
  }

  async writeManifest(m: RenderManifest): Promise<void> {
    await writeAtomic(join(this.dir, MANIFEST_PATH), JSON.stringify(m) + '\n');
  }
}

async function writeAtomic(target: string, data: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${tmpSuffix()}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** In-memory store with the same relative paths as FsTileStore. */
export class MemoryTileStore implements TileStore {
  readonly files = new Map<string, Buffer>();

  async hasLevel(key: string): Promise<boolean> {
    return this.files.has(tilePath(key, 0, 0));
  }

  async putTiles(tiles: readonly TileFile[]): Promise<void> {
    for (const [key, group] of groupByKey(tiles)) {
      if (await this.hasLevel(key)) continue;
      for (const t of group) this.files.set(tilePath(key, t.x, t.y), t.data);
    }
  }

  async putHitMap(hash: string, hitMap: readonly HitBox[]): Promise<void> {
    this.files.set(hitMapPath(hash), Buffer.from(JSON.stringify(hitMap)));
  }

  async readManifest(): Promise<RenderManifest | null> {
    const data = this.files.get(MANIFEST_PATH);
    return data === undefined ? null : parseManifest(data.toString('utf8'));
  }

  async writeManifest(m: RenderManifest): Promise<void> {
    this.files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(m) + '\n'));
  }
}
