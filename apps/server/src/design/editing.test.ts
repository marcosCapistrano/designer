import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '@hub/design-model';
import { synchronizePages, serializeSyncState, parseSyncState, type StoredSync, type SyncState } from '@hub/sync';
import type { NodeSelection } from '@hub/protocol';
import { DesignEditing } from './editing.js';
function setup(shared = false, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { ...extra, 'page.tsx': extra['page.tsx'] ?? (shared ? `import Button from './Button'; export default () => <main><Button label="Start" /><Button label="Go" /></main>` : `export default () => <main><button>Start</button><p>Other</p></main>`) };
  if (shared) files['Button.tsx'] = 'export default ({label}) => <button>{label}</button>';
  const result = synchronizePages({ project: { files }, entries: [{ route: '/', file: 'page.tsx' }], commit: 'one' });
  if (!result.ok) throw new Error(JSON.stringify(result));
  let saved: StoredSync = { state: result.state, revision: 'one' };
  let writes = 0, renders = 0, time = 0;
  const sync = {
    load: async () => structuredClone(saved),
    save: async (_app: string, state: SyncState, revision: string | null) => {
      if (revision !== saved.revision) throw new Error('stale');
      const decoded = parseSyncState(serializeSyncState(state));
      if (!decoded.ok) throw new Error(decoded.error);
      saved = { state: decoded.value, revision: `revision-${++writes}` }; return saved.revision;
    },
    preview: async (_app: string, _doc: unknown, publish = true) => { if (publish) renders++; return { manifest: { version: 2 as const, pages: [] }, warnings: [] }; },
  };
  const build = { withCheckout: async <T>(_app: string, action: () => Promise<T>) => action() };
  const editing = new DesignEditing(sync, build, () => time);
  const page = Object.values(saved.state.doc.pages)[0]!;
  const child = page.root.children[0]!;
  const selection: NodeSelection = { pageId: page.id, device: 'tablet', nodeIds: [child.id] };
  return { editing, sync, build, selection, page, child, saved: () => saved, renders: () => renders, expire: () => { time = 31 * 60_000; } };
}
describe('validated design editing', () => {
  it('applies one selected property to its device and persists undo/redo across service recreation', async () => {
    const s = setup();
    const out = await s.editing.edit('demo', 'one', [{ op: 'setStyle', node: s.child.id, device: 'tablet', prop: 'color', value: 'red' }], s.selection);
    expect(out.mode).toBe('applied');
    const edited = s.saved();
    expect(edited.state.batchLengths).toEqual([1]);
    expect(edited.state.doc.pages[s.page.id]!.root.children[0]).toMatchObject({ style: { base: {}, tablet: { color: 'red' } } });
    const restarted = new DesignEditing(s.sync, s.build);
    await restarted.history('demo', edited.revision, 'undo');
    expect(s.saved().state.pending).toEqual([]);
    expect(s.saved().state.redo).toHaveLength(1);
    await restarted.history('demo', s.saved().revision, 'redo');
    expect(s.saved().state.pending).toHaveLength(1);
    expect(s.renders()).toBe(3);
  });
  it('keeps baseline :root tokens through undo and redo replay, and the saved state parses', async () => {
    const s = setup(false, {
      'page.tsx': `import './globals.css'; export default () => <main className="c"><button>Start</button></main>`,
      'globals.css': ':root { --color-brand: #f00; --space-4: 1rem } .c { color: var(--color-brand); padding: var(--space-4) }',
    });
    const tokens = { color: { brand: '#f00' }, space: { '4': '1rem' } };
    expect(s.saved().state.doc.tokens).toEqual(tokens);
    await s.editing.edit('demo', 'one', [{ op: 'setStyle', node: s.child.id, device: 'tablet', prop: 'color', value: 'red' }], s.selection);
    for (const direction of ['undo', 'redo', 'undo'] as const) {
      await s.editing.history('demo', s.saved().revision, direction);
      expect(s.saved().state.doc.tokens).toEqual(tokens);
      const decoded = parseSyncState(serializeSyncState(s.saved().state));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.value.doc.tokens).toEqual(tokens);
    }
    expect(s.saved().state.pending).toEqual([]);
  });
  it('previews multiple properties without publishing, then applies an exact revision once', async () => {
    const s = setup();
    const old = canonicalStringify(s.saved());
    const out = await s.editing.edit('demo', 'one', [{ op: 'setStyle', node: s.child.id, device: 'base', prop: 'color', value: 'red' }, { op: 'setStyle', node: s.child.id, device: 'base', prop: 'padding', value: '4px' }], s.selection);
    expect(out.mode).toBe('preview');
    expect(canonicalStringify(s.saved())).toBe(old);
    expect(s.renders()).toBe(0);
    if (out.mode !== 'preview') return;
    expect(out.proposal.descriptions).toHaveLength(2);
    await s.editing.apply('demo', out.proposal.id);
    expect(s.saved().state.batchLengths).toEqual([2]);
    await expect(s.editing.apply('demo', out.proposal.id)).rejects.toMatchObject({ status: 409 });
    await s.editing.history('demo', s.saved().revision, 'undo');
    expect(s.saved().state.pending).toEqual([]);
  });
  it('rejects stale revisions, outside targets, internal restore ops and structural target escapes', async () => {
    const s = setup();
    const other = s.page.root.children[1]!;
    await expect(s.editing.edit('demo', 'stale', [{ op: 'removeNode', node: s.child.id }], s.selection)).rejects.toMatchObject({ status: 409 });
    await expect(s.editing.edit('demo', 'one', [{ op: 'setName', node: other.id, name: 'changed' }], s.selection)).rejects.toMatchObject({ status: 400 });
    await expect(s.editing.edit('demo', 'one', [{ op: 'moveNode', node: s.child.id, parent: other.id, index: 0 }], s.selection)).rejects.toMatchObject({ status: 400 });
    await expect(s.editing.edit('demo', 'one', [{ op: 'restore', seq: 0, entries: [] }], s.selection)).rejects.toMatchObject({ status: 400 });
    expect(s.saved().state.pending).toEqual([]);
  });
  it('resolves instance hit IDs and previews a shared definition edit', async () => {
    const s = setup(true);
    if (s.child.kind !== 'instance') throw new Error('missing instance');
    const def = s.saved().state.doc.components[s.child.component]!;
    const hit = { ...s.selection, nodeIds: [`${s.child.id}/${def.root.id}`] };
    const info = await s.editing.selection('demo', hit);
    expect(info.targets).toMatchObject([{ id: s.child.id, shared: false, declaredProps: { label: 'Start' } }, { id: def.root.id, shared: true }]);
    const preview = await s.editing.edit('demo', 'one', [{ op: 'setStyle', node: def.root.id, device: 'base', prop: 'color', value: 'red' }], hit);
    expect(preview.mode).toBe('preview');
    expect(s.saved().state.pending).toEqual([]);
    await expect(s.editing.selection('demo', { ...hit, nodeIds: [`${s.child.id}/vanished`] })).rejects.toMatchObject({ status: 409 });
  });
  it('refuses stale, expired or cancelled previews without losing edits', async () => {
    const s = setup();
    const ops = [{ op: 'setStyle', node: s.child.id, device: 'base', prop: 'color', value: 'red' }];
    const out = await s.editing.edit('demo', 'one', ops);
    if (out.mode !== 'preview') throw new Error('preview required');
    await s.editing.edit('demo', 'one', ops, s.selection);
    await expect(s.editing.apply('demo', out.proposal.id)).rejects.toMatchObject({ status: 409 });
    const next = await s.editing.edit('demo', s.saved().revision, ops);
    if (next.mode !== 'preview') throw new Error('preview required');
    s.expire();
    await expect(s.editing.apply('demo', next.proposal.id)).rejects.toMatchObject({ status: 409 });
    expect(s.saved().state.pending).toHaveLength(1);
  });
});
