import { describe, expect, it } from 'vitest';
import { applyOp, canonicalStringify, type Op } from '@hub/design-model';
import { synchronizePages, type SyncState } from './index.js';

const files = {
  'a.tsx': `import './a.css'; import Button from './Button'; export default () => <main><Button /></main>`,
  'b.tsx': `import Button from './Button'; export default () => <aside><Button /></aside>`,
  'Button.tsx': `export default () => <button>Start</button>`,
  'a.css': `main { color: red; }`,
  'unused.ts': 'export const value = 1;',
};
const entries = [{ route: '/a', file: 'a.tsx' }, { route: '/b', file: 'b.tsx' }];
function sync(projectFiles: Record<string, string> = files, previous?: SyncState, routes = entries) {
  return synchronizePages({ project: { files: projectFiles }, entries: routes, commit: 'commit-2', previous });
}
function initial(): SyncState {
  const result = synchronizePages({ project: { files }, entries, commit: 'commit-1' });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.state;
}
function edit(state: SyncState, op: Op) {
  const result = applyOp(state.doc, op);
  if (!result.ok) throw new Error(result.error);
  return { ...state, doc: result.value.doc, pending: [...state.pending, op] };
}

describe('incremental source synchronization', () => {
  it('records content hashes and per-page commits; ignores unrelated content changes', () => {
    const previous = initial();
    expect(previous.baseline.pages['/a']!.hashes).toEqual({
      'Button.tsx': expect.stringMatching(/^[a-f0-9]{64}$/),
      'a.css': expect.stringMatching(/^[a-f0-9]{64}$/),
      'a.tsx': expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const result = sync({ ...files, 'unused.ts': 'This is deliberately invalid source' }, previous);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toEqual(['/a', '/b']);
    expect(result.rebuilt).toEqual([]);
    expect(result.state.baseline).toEqual(previous.baseline);
    expect(result.state.doc).toEqual(previous.doc);
    expect(result.state.doc.pages).not.toBe(previous.doc.pages);
  });

  it('rebuilds only pages dependent on changed CSS and every user of a changed component', () => {
    const previous = initial();
    const css = sync({ ...files, 'a.css': 'main { color: blue; }' }, previous);
    expect(css.ok).toBe(true);
    if (!css.ok) return;
    expect(css.rebuilt).toEqual(['/a']);
    expect(css.reused).toEqual(['/b']);
    expect(css.state.baseline.pages['/a']!.commit).toBe('commit-2');
    expect(css.state.baseline.pages['/b']!.commit).toBe('commit-1');
    const shared = sync({ ...files, 'Button.tsx': 'export default () => <button>Go</button>' }, previous);
    expect(shared.ok && shared.rebuilt).toEqual(['/a', '/b']);
  });

  it('invalidates cached resolution when a new path makes an import ambiguous', () => {
    const result = sync({ ...files, 'Button.jsx': 'export default () => <p>Other</p>' }, initial());
    expect(result).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ message: expect.stringContaining('ambiguous') }, { message: expect.stringContaining('ambiguous') }] });
  });

  it('rebuilds after entry configuration or extractor version changes', () => {
    const previous = initial();
    const changed = sync(files, previous, [{ route: '/a', file: 'b.tsx' }, entries[1]!]);
    expect(changed.ok && changed.rebuilt).toEqual(['/a']);
    previous.baseline.version = 0;
    const version = sync(files, previous);
    expect(version.ok && version.rebuilt).toEqual(['/a', '/b']);
  });

  it('replays from the clean baseline even on unchanged pages, without duplicating inserts', () => {
    let previous = initial();
    const root = previous.baseline.pages['/a']!.page.root.id;
    previous = edit(previous, { op: 'insertNode', parent: root, index: 0, node: { id: 'new-text', kind: 'text', text: 'Added' } });
    previous = edit(previous, { op: 'setText', node: 'new-text', text: 'Edited' });
    const snapshot = canonicalStringify(previous);
    const result = sync({ ...files, 'a.css': 'main { color: blue; }' }, previous);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.state.doc.pages[previous.baseline.pages['/a']!.page.id]!;
    expect(page.root.children[0]).toEqual({ id: 'new-text', kind: 'text', text: 'Edited' });
    expect(page.root.style.base['color']).toBe('blue');
    expect(result.state.pending).toEqual(previous.pending);
    expect(result.state.baseline.pages['/a']!.page.root.children).toHaveLength(1);
    const again = sync({ ...files, 'a.css': 'main { color: blue; }' }, result.state);
    expect(again.ok && Object.values(again.state.doc.pages)[0]!.root.children).toHaveLength(2);
    expect(again.ok && again.state.doc).toEqual(result.state.doc);
    expect(result.state.doc.meta.seq).toBe(previous.doc.meta.seq + 1);
    expect(canonicalStringify(previous)).toBe(snapshot);
  });

  it('preserves all old state and reports a vanished target plus the blocked tail', () => {
    let previous = initial();
    const button = previous.baseline.pages['/a']!.page.root.children[0]!;
    previous = edit(previous, { op: 'setStyle', node: button.id, device: 'base', prop: 'color', value: 'green' });
    previous = edit(previous, { op: 'setStyle', node: button.id, device: 'base', prop: 'background', value: 'blue' });
    const snapshot = canonicalStringify(previous);
    const result = sync({ ...files, 'a.tsx': 'export default () => <main />' }, previous);
    expect(result).toMatchObject({ ok: false, kind: 'replay', conflicts: [{ index: 0, op: previous.pending[0], message: expect.any(String) }], blocked: [1] });
    expect(canonicalStringify(previous)).toBe(snapshot);
  });

  it('reports route removal and preserves pending page edits as conflicts', () => {
    const previous = initial();
    const removed = sync(files, previous, [entries[1]!]);
    expect(removed.ok && removed.removed).toEqual(['/a']);
    const edited = edit(previous, { op: 'setAttr', node: previous.baseline.pages['/a']!.page.root.id, name: 'title', value: 'saved' });
    expect(sync(files, edited, [entries[1]!])).toMatchObject({ ok: false, kind: 'replay' });
  });

  it('preserves design-only pages and tokens by replaying their operations', () => {
    let previous = initial();
    previous = edit(previous, { op: 'setToken', group: 'colors', name: 'brand', value: 'red' });
    previous = edit(previous, { op: 'addPage', page: { id: 'custom', route: '/custom', name: 'Custom', root: { id: 'custom-root', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] } } });
    const result = sync(files, previous);
    expect(result.ok && result.state.doc).toEqual(previous.doc);
    expect(result.ok && Object.keys(result.state.baseline.pages)).toEqual(['/a', '/b']);
  });

  it('adds new source routes without copying edits from another occurrence', () => {
    const previous = edit(initial(), { op: 'setToken', group: 'colors', name: 'brand', value: 'red' });
    const result = sync(files, previous, [...entries, { route: '/new', file: 'b.tsx' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rebuilt).toEqual(['/new']);
    expect(result.reused).toEqual(['/a', '/b']);
    expect(Object.values(result.state.doc.pages).map((page) => page.route)).toEqual(['/a', '/b', '/new']);
    expect(result.state.doc.tokens).toEqual(previous.doc.tokens);
  });

  it('fails the entire preparation on unsupported or deleted source, leaving old edits untouched', () => {
    const previous = initial();
    const snapshot = canonicalStringify(previous);
    expect(sync({ ...files, 'b.tsx': 'export default () => <p>{fetch("/")}</p>' }, previous)).toMatchObject({ ok: false, kind: 'source' });
    const missing = { ...files };
    delete (missing as Partial<typeof files>)['Button.tsx'];
    expect(sync(missing, previous)).toMatchObject({ ok: false, kind: 'source' });
    expect(canonicalStringify(previous)).toBe(snapshot);
  });

  it('is deterministic for reordered inputs and rejects duplicate routes', () => {
    const first = sync();
    const reordered = sync(Object.fromEntries(Object.entries(files).reverse()) as typeof files, undefined, [...entries].reverse());
    expect(canonicalStringify(reordered)).toBe(canonicalStringify(first));
    expect(sync(files, initial(), [entries[0]!, entries[0]!])).toMatchObject({ ok: false, kind: 'source' });
  });
});
