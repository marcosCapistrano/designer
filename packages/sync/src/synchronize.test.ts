import { describe, expect, it } from 'vitest';
import { applyOp, canonicalStringify, type Op } from '@hub/design-model';
import { SYNC_VERSION, synchronizePages, type SyncState } from './index.js';

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
    const previous = initial();
    const result = sync({ ...files, 'Button.jsx': 'export default () => <p>Other</p>' }, previous);
    expect(result).toMatchObject({ ok: true, rebuilt: [], reused: [], failed: [{ route: '/a', diagnostics: [{ message: expect.stringContaining('ambiguous') }] }, { route: '/b', diagnostics: [{ message: expect.stringContaining('ambiguous') }] }] });
    expect(result.ok && result.state.doc).toEqual(previous.doc);
  });

  it('rebuilds after entry configuration or extractor version changes', () => {
    const previous = initial();
    const changed = sync(files, previous, [{ route: '/a', file: 'b.tsx' }, entries[1]!]);
    expect(changed.ok && changed.rebuilt).toEqual(['/a']);
    previous.baseline.version = 0;
    const version = sync(files, previous);
    expect(version.ok && version.rebuilt).toEqual(['/a', '/b']);
  });

  // Bump SYNC_VERSION (and this pin) whenever extraction output changes for the same source. 9: Ruling P shell marker,
  // Ruling Q static states and hover media, React prop-name mapping, aria/data booleans, declaration-order and
  // resting pseudo-element failures. 10: Chromium's explicit alias list (no blanket -webkit- stripping), inline
  // !important rejected, vendor/transition pseudo-elements source-only. A saved baseline from the version before is never reused.
  it('SYNC_VERSION is 10, and a baseline from an earlier version is rebuilt with the current semantics', () => {
    expect(SYNC_VERSION).toBe(10);
    const shell = {
      'app/layout.tsx': `import './globals.css'; export default ({ children }: { children: unknown }) => <html><body>{children}</body></html>;`,
      'app/globals.css': 'html { font-size: 62.5% } @media (hover: hover) { .x { color: red } }',
      'app/page.tsx': `export default () => <p className="x" data-on={true}>x</p>`,
    };
    const routes = [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }];
    const first = synchronizePages({ project: { files: shell }, entries: routes, commit: 'one' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(synchronizePages({ project: { files: shell }, entries: routes, commit: 'two', previous: first.state })).toMatchObject({ ok: true, reused: ['/'], rebuilt: [] });
    // Simulate a baseline saved before this version: an unmarked root and dropped hover/boolean semantics.
    const old = structuredClone(first.state);
    old.baseline.version = SYNC_VERSION - 1;
    const page = Object.values(old.baseline.pages)[0]!.page;
    page.root.attrs = {};
    const again = synchronizePages({ project: { files: shell }, entries: routes, commit: 'two', previous: old });
    expect(again).toMatchObject({ ok: true, reused: [], rebuilt: ['/'] });
    if (!again.ok) return;
    const root = Object.values(again.state.doc.pages)[0]!.root;
    expect(root.attrs).toEqual({ 'data-d-shell': 'html' });
    const p = root.children[0]!.kind === 'element' ? root.children[0]!.children[0]! : null;
    expect(p).toMatchObject({ attrs: { 'data-on': 'true' }, style: { base: { color: 'red' } } });
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

  it('keeps the previous version of routes with unsupported or deleted source, leaving old edits untouched', () => {
    const previous = initial();
    const snapshot = canonicalStringify(previous);
    const unsupported = sync({ ...files, 'b.tsx': 'export default () => <p>{fetch("/")}</p>' }, previous);
    expect(unsupported).toMatchObject({ ok: true, reused: ['/a'], failed: [{ route: '/b', diagnostics: [{ file: 'b.tsx' }] }] });
    expect(unsupported.ok && unsupported.state.doc).toEqual(previous.doc);
    const missing = { ...files };
    delete (missing as Partial<typeof files>)['Button.tsx'];
    const deleted = sync(missing, previous);
    expect(deleted).toMatchObject({ ok: true, failed: [{ route: '/a' }, { route: '/b' }] });
    expect(deleted.ok && deleted.state.doc).toEqual(previous.doc);
    expect(canonicalStringify(previous)).toBe(snapshot);
  });

  it('is deterministic for reordered inputs and rejects duplicate routes', () => {
    const first = sync();
    const reordered = sync(Object.fromEntries(Object.entries(files).reverse()) as typeof files, undefined, [...entries].reverse());
    expect(canonicalStringify(reordered)).toBe(canonicalStringify(first));
    expect(sync(files, initial(), [entries[0]!, entries[0]!])).toMatchObject({ ok: false, kind: 'source' });
  });

  it('partial import keeps good routes and the old failed route', () => {
    const previous = initial();
    const changed = { ...files, 'a.css': 'main { color: blue; }', 'b.tsx': 'export default () => <aside>{fetch("/")}</aside>' };
    const result = sync(changed, previous);
    expect(result).toMatchObject({ ok: true, rebuilt: ['/a'], reused: [], removed: [], failed: [{ route: '/b', diagnostics: [{ file: 'b.tsx', message: expect.any(String) }] }] });
    if (!result.ok) return;
    const a = previous.baseline.pages['/a']!.page.id, b = previous.baseline.pages['/b']!.page.id;
    expect(result.state.doc.pages[a]!.root.style.base).toEqual({ color: 'blue' });
    expect(result.state.doc.pages[b]).toEqual(previous.doc.pages[b]);
    expect(result.state.baseline.pages['/b']).toEqual({ ...previous.baseline.pages['/b'], stale: true });
    // The kept version is never mistaken for a fresh import: the route keeps failing until its source is fixed.
    expect(sync(changed, result.state)).toMatchObject({ ok: true, reused: ['/a'], failed: [{ route: '/b' }] });
    const fixed = sync({ ...changed, 'b.tsx': files['b.tsx'] }, result.state);
    expect(fixed).toMatchObject({ ok: true, reused: ['/a'], rebuilt: ['/b'], failed: [] });
    expect(fixed.ok && fixed.state.baseline.pages['/b']!.stale).toBeUndefined();
  });

  it('saves the good routes of a first import, and fails only when no route succeeds', () => {
    const broken = { ...files, 'b.tsx': 'export default () => <aside>{fetch("/")}</aside>' };
    const partial = sync(broken);
    expect(partial).toMatchObject({ ok: true, rebuilt: ['/a'], failed: [{ route: '/b' }] });
    expect(partial.ok && Object.keys(partial.state.baseline.pages)).toEqual(['/a']);
    expect(sync({ ...broken, 'a.tsx': 'export default () => <main>{fetch("/")}</main>' })).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: 'a.tsx' }, { file: 'b.tsx' }] });
  });

  it('keeps replay conflicts all-or-nothing even when a route fails', () => {
    let previous = initial();
    const button = previous.baseline.pages['/a']!.page.root.children[0]!;
    previous = edit(previous, { op: 'setStyle', node: button.id, device: 'base', prop: 'color', value: 'green' });
    const result = sync({ ...files, 'a.tsx': 'export default () => <main />', 'b.tsx': 'export default () => <aside>{fetch("/")}</aside>' }, previous);
    expect(result).toMatchObject({ ok: false, kind: 'replay' });
  });

  it('names the component, routes, file and selector of a cross-route shared definition mismatch', () => {
    const result = sync({ ...files, 'a.css': 'button { color: red; }' });
    expect(result).toMatchObject({ ok: true, rebuilt: ['/a'], failed: [{ route: '/b', diagnostics: [{ file: 'Button.tsx', message: expect.stringMatching(/Shared component Button .*\/a.*\/b/) }] }] });
    if (result.ok) expect(result.failed[0]!.diagnostics[0]!.message).toContain('button (a.css)');
  });

  it('counts source-only rules per route and keeps the count for reused routes', () => {
    const hover = { ...files, 'a.css': 'main { color: red; } main:hover { color: blue; } @media print { main { color: black; } }' };
    const first = sync(hover);
    expect(first).toMatchObject({ ok: true, sourceOnlyRules: 2 });
    expect(first.ok && sync(hover, first.state)).toMatchObject({ ok: true, reused: ['/a', '/b'], sourceOnlyRules: 2 });
  });

  it('counts a stylesheet shared by several routes once', () => {
    const shared = { ...files, 'shared.css': 'p:hover { color: blue; } @media print { p { color: black; } }', 'a.css': 'main:focus { color: red; }',
      'a.tsx': `import './shared.css'; import './a.css'; export default () => <main><p>A</p></main>`, 'b.tsx': `import './shared.css'; export default () => <aside><p>B</p></aside>` };
    const first = sync(shared);
    expect(first).toMatchObject({ ok: true, sourceOnlyRules: 3 });
    expect(first.ok && sync(shared, first.state)).toMatchObject({ ok: true, reused: ['/a', '/b'], sourceOnlyRules: 3 });
  });

  it('fails the whole import when a kept previous version disagrees with a fresh route', () => {
    const previous = initial();
    const result = sync({ ...files, 'Button.tsx': 'export default () => <button>Go</button>', 'b.tsx': 'import Button from \'./Button\'; export default () => <aside><Button />{fetch("/")}</aside>' }, previous);
    expect(result).toMatchObject({ ok: false, kind: 'source', diagnostics: [{ file: 'b.tsx' }, { file: 'Button.tsx', message: expect.stringContaining('The previous version of /b cannot be kept: Shared component Button in Button.tsx differs between /a and /b') }] });
  });

  it('rebuilds when path aliases change, since they change resolution without changing any file', () => {
    const aliased = { ...files, 'a.tsx': `import Button from '@/Button'; export default () => <main><Button /></main>`, 'lib/Button.tsx': 'export default () => <button>Lib</button>' };
    const first = synchronizePages({ project: { files: aliased, aliases: { '@/': '' } }, entries, commit: 'c1' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const moved = synchronizePages({ project: { files: aliased, aliases: { '@/': 'lib/' } }, entries, commit: 'c2', previous: first.state });
    expect(moved).toMatchObject({ ok: true, rebuilt: ['/a', '/b'] });
    expect(JSON.stringify(moved.ok && moved.state.doc.pages)).not.toBe(JSON.stringify(first.state.doc.pages));
  });
});
