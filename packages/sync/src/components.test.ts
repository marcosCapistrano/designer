import { describe, expect, it } from 'vitest';
import { applyOp, exportPage, type DesignDoc } from '@hub/design-model';
import { extractPages, parseSyncState, serializeSyncState, synchronizePages } from './index.js';

const files = {
  'page.tsx': `import Button from './Button'; export default () => <main><Button label="Start" /><Button label="Go" /></main>`,
  'Button.tsx': `import './button.css'; export default function Button({ label = 'Default' }) { return <button title={label}>{label}</button>; }`,
  'button.css': `button { color: red; }`,
};
const entries = [{ route: '/a', file: 'page.tsx' }, { route: '/b', file: 'page.tsx' }];
function extract(projectFiles: Record<string, string> = files): DesignDoc {
  const result = extractPages({ files: projectFiles }, entries, { sharedComponents: true });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.doc;
}
describe('shared source components', () => {
  it('links occurrences across pages to one styled definition with declared text/attribute props', () => {
    const doc = extract();
    const definitions = Object.values(doc.components);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.props).toEqual({ label: { default: 'Default' } });
    expect(definitions[0]!.root.attrs['title']).toBe('{{label}}');
    expect(definitions[0]!.root.children[0]).toMatchObject({ text: '{{label}}' });
    expect(definitions[0]!.root.style.base['color']).toBe('red');
    for (const page of Object.values(doc.pages)) {
      expect(page.root.children.map((node) => node.kind)).toEqual(['instance', 'instance']);
      const out = exportPage(doc, page.id);
      expect(out.ok && out.value.html).toContain('title="Start"');
      expect(out.ok && out.value.html).toContain('title="Go"');
    }
  });
  it('reuses default props and supports nested prop forwarding without executing source', () => {
    const doc = extract({ ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button /><Button label="Go" /></main>` });
    const out = exportPage(doc, Object.keys(doc.pages)[0]!);
    expect(out.ok && out.value.html).toContain('Default');
    const nested = extract({ ...files, 'Button.tsx': `import Inner from './Inner'; export default ({ label = 'Default' }) => <section><Inner text={label} /></section>`, 'Inner.tsx': 'export default ({text}) => <strong>{text}</strong>' });
    expect(Object.keys(nested.components)).toHaveLength(2);
    const rendered = exportPage(nested, Object.keys(nested.pages)[0]!);
    expect(rendered.ok && rendered.value.html).toContain('Start');
    expect(rendered.ok && rendered.value.html).toContain('Go');
  });
  it('applies shared edits to every occurrence and replays them against changed source', () => {
    const first = synchronizePages({ project: { files }, entries, commit: 'one' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const definition = Object.values(first.state.doc.components)[0]!;
    const op = { op: 'setStyle' as const, node: definition.root.id, device: 'base' as const, prop: 'padding', value: '12px' };
    const edited = applyOp(first.state.doc, op);
    if (!edited.ok) throw new Error(edited.error);
    const previous = { ...first.state, doc: edited.value.doc, pending: [op] };
    const synced = synchronizePages({ project: { files: { ...files, 'button.css': 'button { color: blue; }' } }, entries, commit: 'two', previous });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.rebuilt).toEqual(['/a', '/b']);
    const root = synced.state.doc.components[definition.name]!.root;
    expect(root.style.base).toEqual({ color: 'blue', padding: '12px' });
    expect(parseSyncState(serializeSyncState(synced.state))).toEqual({ ok: true, value: synced.state });
    for (const page of Object.values(synced.state.doc.pages)) {
      const out = exportPage(synced.state.doc, page.id);
      expect(out.ok && out.value.css.match(/padding:12px/g)).toHaveLength(2);
    }
  });
  it('rejects route-dependent shared CSS instead of guessing a definition', () => {
    const project = { files: { ...files, 'b.tsx': `import './other.css'; import Button from './Button'; export default () => <main><Button label="Other" /></main>`, 'other.css': 'button { padding: 20px; }' } };
    const result = extractPages(project, [entries[0]!, { route: '/b', file: 'b.tsx' }], { sharedComponents: true });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ message: expect.stringContaining('route-dependent') }] });
  });
  it.each([
    ['children slots', `import Button from './Button'; export default () => <main><Button label="X"><p>Child</p></Button></main>`],
    ['non-string props', `import Button from './Button'; export default () => <main><Button label={4} /></main>`],
  ])('fails explicitly on unsupported %s', (_name, page) => {
    expect(extractPages({ files: { ...files, 'page.tsx': page } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
  it('refuses prop-driven CSS and recursive definitions', () => {
    expect(extractPages({ files: { ...files, 'Button.tsx': 'export default ({label}) => <button className={label}>Hi</button>' } }, entries, { sharedComponents: true }).ok).toBe(false);
    expect(extractPages({ files: { ...files, 'Button.tsx': 'export default function Button({label}) { return <main><Button label={label} /></main>; }' } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
  it('does not invent missing required props or interpret literal placeholder syntax', () => {
    const project = { files: { ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button label="X" /><Button /></main>`, 'Button.tsx': 'export default ({label}) => <button>{label}</button>' } };
    expect(extractPages(project, entries, { sharedComponents: true })).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([{ file: expect.any(String), message: expect.stringContaining('Missing preview prop') }]) });
    expect(extractPages({ files: { ...files, 'Button.tsx': `export default ({label}) => <button>{'{{label}}'}</button>` } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
});
