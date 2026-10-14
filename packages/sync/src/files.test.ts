import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOp, canonicalStringify } from '@hub/design-model';
import { atomicWrite, FsSyncStore, parseSyncState, serializeSyncState, synchronizePages, type SyncState } from './index.js';

function fixture(): SyncState {
  const result = synchronizePages({ project: { files: { 'page.tsx': 'export default () => <main>Hello</main>' } }, entries: [{ route: '/', file: 'page.tsx' }], commit: 'abc123' });
  if (!result.ok) throw new Error(JSON.stringify(result));
  const op = { op: 'setAttr' as const, node: Object.values(result.state.doc.pages)[0]!.root.id, name: 'title', value: 'Edited' };
  const applied = applyOp(result.state.doc, op);
  if (!applied.ok) throw new Error(applied.error);
  return { ...result.state, doc: applied.value.doc, pending: [op] };
}

describe('sync snapshot decoder', () => {
  it('roundtrips canonical design files, baseline and pending log together', () => {
    const state = fixture();
    const files = serializeSyncState(state);
    expect(files['changes.jsonl']).toContain('setAttr');
    const parsed = parseSyncState(files);
    expect(parsed).toEqual({ ok: true, value: state });
    if (parsed.ok) expect(canonicalStringify(serializeSyncState(parsed.value))).toBe(canonicalStringify(files));
  });
  it('rejects a document that has edits missing from its log', () => {
    const files = serializeSyncState(fixture());
    files['changes.jsonl'] = '';
    expect(parseSyncState(files)).toMatchObject({ ok: false, error: expect.stringContaining('does not match') });
  });
  it.each(['version', 'hash', 'path', 'page', 'commit', 'missing-dependency'])('rejects corrupted %s metadata', (kind) => {
    const files = serializeSyncState(fixture());
    const metadata = JSON.parse(files['sync.json']!);
    const page = metadata.baseline.pages['/'];
    if (kind === 'version') metadata.version = 9;
    if (kind === 'hash') page.hashes['page.tsx'] = 'bad';
    if (kind === 'path') page.entry.file = '../secret';
    if (kind === 'page') page.page.root.tag = 'script';
    if (kind === 'commit') page.commit = '';
    if (kind === 'missing-dependency') page.hashes = {};
    files['sync.json'] = JSON.stringify(metadata);
    expect(parseSyncState(files).ok).toBe(false);
  });
  it('rejects missing metadata, malformed logs and invalid node targets', () => {
    const files = serializeSyncState(fixture());
    const missing = { ...files }; delete missing['sync.json'];
    expect(parseSyncState(missing).ok).toBe(false);
    expect(parseSyncState({ ...files, 'changes.jsonl': '{broken' }).ok).toBe(false);
    expect(parseSyncState({ ...files, 'changes.jsonl': '{"op":"removeNode","node":"vanished"}\n' }).ok).toBe(false);
  });
  it('rejects inconsistent undo batch boundaries and internal operations in redo history', () => {
    const files = serializeSyncState(fixture());
    const metadata = JSON.parse(files['sync.json']!);
    metadata.batchLengths = [2];
    expect(parseSyncState({ ...files, 'sync.json': JSON.stringify(metadata) })).toMatchObject({ ok: false, error: expect.stringContaining('boundaries') });
    metadata.batchLengths = [1];
    metadata.redo = [[{ op: 'restore', seq: 0, entries: [] }]];
    expect(parseSyncState({ ...files, 'sync.json': JSON.stringify(metadata) }).ok).toBe(false);
  });
});

describe('atomic single-writer snapshot storage', () => {
  it('persists a complete state across restarts and refuses stale revisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-sync-store-'));
    const store = new FsSyncStore(dir);
    expect(await store.load()).toBeNull();
    const state = fixture();
    const revision = await store.save(state, null);
    expect(await new FsSyncStore(dir).load()).toEqual({ state, revision });
    await expect(store.save(state, null)).rejects.toThrow('reload');
    expect(await store.save(state, revision)).toBe(revision);
    expect(await readdir(dir)).toEqual(['snapshot.json']);
  });
  it('leaves the complete previous snapshot readable after a failed write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-sync-failure-'));
    const store = new FsSyncStore(dir);
    const state = fixture();
    const revision = await store.save(state, null);
    const bytes = await readFile(join(dir, 'snapshot.json'), 'utf8');
    const failing = new FsSyncStore(dir, async () => { throw new Error('disk full'); });
    await expect(failing.save(state, revision)).rejects.toThrow('disk full');
    expect(await readFile(join(dir, 'snapshot.json'), 'utf8')).toBe(bytes);
    expect(await store.load()).toEqual({ state, revision });
  });
  it('refuses concurrent writes and reports corrupt storage without overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-sync-concurrent-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new FsSyncStore(dir, async (file, text) => { await gate; await atomicWrite(file, text); });
    const saving = store.save(fixture(), null);
    await expect(store.save(fixture(), null)).rejects.toThrow('in progress');
    release(); await saving;
    await writeFile(join(dir, 'snapshot.json'), '{broken');
    await expect(store.load()).rejects.toThrow();
    await expect(store.save(fixture(), null)).rejects.toThrow();
    expect(await readFile(join(dir, 'snapshot.json'), 'utf8')).toBe('{broken');
  });
});
