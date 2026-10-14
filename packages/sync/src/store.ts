import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalStringify } from '@hub/design-model';
import { parseSyncState, serializeSyncState } from './files.js';
import type { SyncState } from './synchronize.js';

export interface StoredSync { state: SyncState; revision: string }
export interface SyncStore {
  load(): Promise<StoredSync | null>;
  save(state: SyncState, expectedRevision: string | null): Promise<string>;
}
export type AtomicWrite = (file: string, text: string) => Promise<void>;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Flush the complete bundle before publication. A failed pre-publication step leaves the old file intact. */
export const atomicWrite: AtomicWrite = async (file, text) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    // Only our private temporary file. Never remove a committed snapshot or source file.
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
};

/** A single-writer store owned by the hub, outside the app checkout. */
export class FsSyncStore implements SyncStore {
  private saving = false;
  constructor(private readonly dir: string, private readonly write: AtomicWrite = atomicWrite) {}
  async load(): Promise<StoredSync | null> {
    let text: string;
    try { text = await readFile(join(this.dir, 'snapshot.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const parsed = parseSyncState(JSON.parse(text) as Record<string, string>);
    if (!parsed.ok) throw new Error(`Invalid stored design: ${parsed.error}`);
    return { state: parsed.value, revision: digest(text) };
  }
  async save(state: SyncState, expectedRevision: string | null): Promise<string> {
    if (this.saving) throw new Error('Design write already in progress');
    this.saving = true;
    try {
      const text = canonicalStringify(serializeSyncState(state));
      const current = await this.load();
      if ((current?.revision ?? null) !== expectedRevision) throw new Error('Design changed; reload before saving');
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.write(join(this.dir, 'snapshot.json'), text);
      return digest(text);
    } finally { this.saving = false; }
  }
}
