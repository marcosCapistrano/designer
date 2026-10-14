import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyOp, exportPage, type DesignDoc, type DesignNode, type ElementNode } from '@hub/design-model';
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
    expect(result).toMatchObject({ ok: false, diagnostics: [{ file: 'other.css', message: expect.stringContaining('context-dependent CSS: button (other.css)') }] });
  });
  it('styles occurrences in their real ancestor context before deriving the definition (R3)', () => {
    const shared = {
      'globals.css': '.ember .label { color: red; }',
      'Label.tsx': `export default function Label({ text = 'x' }) { return <span className="label">{text}</span>; }`,
      'a.tsx': `import './globals.css'; import Label from './Label'; export default () => <div className="ember"><Label text="A" /></div>`,
    };
    const routes = [{ route: '/a', file: 'a.tsx' }, { route: '/b', file: 'a.tsx' }];
    const result = extractPages({ files: shared }, routes, { sharedComponents: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const definition = Object.values(result.doc.components)[0]!;
      expect(definition.root.style.base).toEqual({ color: 'red' });
      expect(definition.root.attrs['class']).toBeUndefined();
    }
    const mixed = { ...shared, 'a.tsx': `import './globals.css'; import Label from './Label'; export default () => <main><div className="ember"><Label text="A" /></div><Label text="B" /></main>` };
    expect(extractPages({ files: mixed }, [routes[0]!], { sharedComponents: true })).toMatchObject({ ok: false, diagnostics: [{ file: 'globals.css', message: 'Shared component default in Label.tsx has context-dependent CSS: .ember .label (globals.css) match only some occurrences; provide a preview adapter' }] });
    const split = { ...shared, 'b.tsx': `import './globals.css'; import Label from './Label'; export default () => <main><Label text="B" /></main>` };
    expect(extractPages({ files: split }, [routes[0]!, { route: '/b', file: 'b.tsx' }], { sharedComponents: true })).toMatchObject({ ok: false, diagnostics: [{ file: 'globals.css', message: expect.stringContaining('.ember .label (globals.css)') }] });
  });
  it('fails explicitly on unsupported non-string props', () => {
    expect(extractPages({ files: { ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button label={4} /></main>` } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
  it('inlines children slots and prop-driven CSS instead of sharing them (Ruling F)', () => {
    const slot = extractPages({ files: { ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button label="X"><p>Child</p></Button></main>` } }, entries, { sharedComponents: true });
    expect(slot).toMatchObject({ ok: true, doc: { components: {} }, inlined: [{ route: '/a', component: 'Button', file: 'Button.tsx', reason: 'children' }, { route: '/b', component: 'Button', file: 'Button.tsx', reason: 'children' }] });
    const css = extractPages({ files: { ...files, 'Button.tsx': `import './button.css'; export default ({label}) => <button className={label}>Hi</button>`, 'button.css': '.Start, .Go { color: red; }' } }, entries, { sharedComponents: true });
    expect(css).toMatchObject({ ok: true, doc: { components: {} }, inlined: [{ route: '/a', component: 'Button', reason: 'prop-css' }, { route: '/b', component: 'Button', reason: 'prop-css' }] });
    if (css.ok) for (const page of Object.values(css.doc.pages)) expect(page.root.children).toMatchObject([{ name: 'Button', tag: 'button', style: { base: { color: 'red' } } }, { name: 'Button', tag: 'button' }]);
  });
  it('refuses recursive definitions', () => {
    expect(extractPages({ files: { ...files, 'Button.tsx': 'export default function Button({label}) { return <main><Button label={label} /></main>; }' } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
  it('does not invent missing required props or interpret literal placeholder syntax', () => {
    const project = { files: { ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button label="X" /><Button /></main>`, 'Button.tsx': 'export default ({label}) => <button>{label}</button>' } };
    expect(extractPages(project, entries, { sharedComponents: true })).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([{ file: expect.any(String), message: expect.stringContaining('Missing preview prop') }]) });
    expect(extractPages({ files: { ...files, 'Button.tsx': `export default ({label}) => <button>{'{{label}}'}</button>` } }, entries, { sharedComponents: true }).ok).toBe(false);
  });
});

describe('inline fallback for components that cannot be shared yet (Ruling F)', () => {
  const ROOT = fileURLToPath(new URL('./fixtures/converted/', import.meta.url));
  function load(dir: string, out: Record<string, string> = {}): Record<string, string> {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) load(full, out);
      else out[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
    return out;
  }
  function element(node: DesignNode | undefined): ElementNode {
    if (node?.kind !== 'element') throw new Error(`expected an element, got ${JSON.stringify(node)}`);
    return node;
  }
  const card = {
    'Card.tsx': `import './card.css'; import Button from './Button'; export default function Card({ children }) { return <section className="card"><Button label="In" />{children}</section>; }`,
    'card.css': '.card { padding: 4px; }',
    'Button.tsx': files['Button.tsx'],
    'button.css': files['button.css'],
    'a.tsx': `import Card from './Card'; export default () => <main><Card><p>One</p></Card><Card><p>Two</p></Card></main>`,
    'b.tsx': `import Card from './Card'; export default () => <main><Card /></main>`,
  };
  const cardRoutes = [{ route: '/a', file: 'a.tsx' }, { route: '/b', file: 'b.tsx' }];

  it('imports the converted fixture Chip, whose callers pass className and children, inline per route', () => {
    const fixture = load(ROOT);
    const routes = [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }, { route: '/again', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }];
    const synced = synchronizePages({ project: { files: fixture }, entries: routes, commit: 'c1' });
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    if (!synced.ok) return;
    expect(synced.inlined).toEqual([
      { route: '/', component: 'Chip', file: 'components/Chip.tsx', reason: 'prop-css' },
      { route: '/again', component: 'Chip', file: 'components/Chip.tsx', reason: 'prop-css' },
    ]);
    expect(synced.state.doc.components).toEqual({});
    for (const page of Object.values(synced.state.doc.pages)) {
      const article = element(element(element(element(page.root).children[0]).children[0]).children[0]);
      const chip = element(article.children[2]);
      expect(chip).toMatchObject({ name: 'Chip', tag: 'span' });
      expect(chip.style.base).toMatchObject({ display: 'inline-flex', color: 'var(--color-amber-300)' });
      expect(chip.children[1]).toMatchObject({ kind: 'text', text: 'New' });
    }
  });

  it('inlines a component with a children slot at every occurrence, naming its root, with nested shared instances', () => {
    const synced = synchronizePages({ project: { files: card }, entries: cardRoutes, commit: 'c1' });
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    if (!synced.ok) return;
    // One entry per route per component; /b passes no children but is inlined for consistency.
    expect(synced.inlined).toEqual([
      { route: '/a', component: 'Card', file: 'Card.tsx', reason: 'children' },
      { route: '/b', component: 'Card', file: 'Card.tsx', reason: 'children' },
    ]);
    // Only the shareable Button is a definition.
    expect(Object.values(synced.state.doc.components).map((definition) => definition.root.tag)).toEqual(['button']);
    const pages = Object.values(synced.state.doc.pages).sort((x, y) => x.route < y.route ? -1 : 1);
    const cards = element(pages[0]!.root).children.map(element);
    expect(cards).toHaveLength(2);
    const ids = new Set<string>();
    for (const [index, occurrence] of cards.entries()) {
      expect(occurrence).toMatchObject({ name: 'Card', tag: 'section', style: { base: { padding: '4px' } } });
      expect(occurrence.children[0]).toMatchObject({ kind: 'instance' });
      expect(element(occurrence.children[1]).children[0]).toMatchObject({ text: index ? 'Two' : 'One' });
      for (const node of [occurrence, ...occurrence.children]) { expect(ids.has(node.id)).toBe(false); ids.add(node.id); }
    }
    expect(element(element(pages[1]!.root).children[0])).toMatchObject({ name: 'Card', tag: 'section' });
    for (const page of pages) {
      const out = exportPage(synced.state.doc, page.id);
      expect(out.ok && out.value.html).toContain('title="In"');
    }
    const again = synchronizePages({ project: { files: card }, entries: cardRoutes, commit: 'c2', previous: synced.state });
    expect(again).toMatchObject({ ok: true, reused: ['/a', '/b'], rebuilt: [] });
    if (again.ok) { expect(again.state.doc).toEqual(synced.state.doc); expect(again.inlined).toEqual(synced.inlined); }
    expect(parseSyncState(serializeSyncState(synced.state))).toEqual({ ok: true, value: synced.state });
    const stored = serializeSyncState(synced.state);
    const metadata = JSON.parse(stored['sync.json']!);
    metadata.baseline.pages['/a'].inlining.inline[0].reason = 'unknown';
    expect(parseSyncState({ ...stored, 'sync.json': JSON.stringify(metadata) })).toMatchObject({ ok: false, error: 'Invalid baseline inlining for /a' });
    // Once no route passes children, Card is shared on every route, including the unchanged /b.
    const shared = synchronizePages({ project: { files: { ...card, 'a.tsx': `import Card from './Card'; export default () => <main><Card /></main>` } }, entries: cardRoutes, commit: 'c3', previous: synced.state });
    expect(shared).toMatchObject({ ok: true, inlined: [], rebuilt: ['/a', '/b'] });
    if (shared.ok) {
      expect(Object.keys(shared.state.doc.components)).toHaveLength(2);
      for (const page of Object.values(shared.state.doc.pages)) expect(element(page.root).children.map((node) => node.kind)).toEqual(['instance']);
    }
  });

  it('inlines a component everywhere once one unchanged route forces it, regardless of the cache', () => {
    const plain = { ...card, 'a.tsx': `import Card from './Card'; export default () => <main><Card /></main>` };
    const first = synchronizePages({ project: { files: plain }, entries: cardRoutes, commit: 'c1' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.inlined).toEqual([]);
    const forced = synchronizePages({ project: { files: card }, entries: cardRoutes, commit: 'c2', previous: first.state });
    expect(forced).toMatchObject({ ok: true, rebuilt: ['/a', '/b'], inlined: [{ route: '/a', reason: 'children' }, { route: '/b', reason: 'children' }] });
    const fresh = synchronizePages({ project: { files: card }, entries: cardRoutes, commit: 'c2' });
    if (forced.ok && fresh.ok) expect({ ...forced.state.doc, meta: fresh.state.doc.meta }).toEqual(fresh.state.doc);
  });

  it('inlines a slotted component inside a shared definition, and a parent passing its prop into inlined CSS', () => {
    const nested = {
      'Box.tsx': `export default function Box({ children }) { return <div className="box">{children}</div>; }`,
      'Panel.tsx': `import './panel.css'; import Box from './Box'; export default function Panel({ label }) { return <section><Box><b>{label}</b></Box></section>; }`,
      'panel.css': '.box { margin: 2px; }',
      'page.tsx': `import Panel from './Panel'; export default () => <main><Panel label="A" /><Panel label="B" /></main>`,
    };
    const result = extractPages({ files: nested }, [{ route: '/', file: 'page.tsx' }], { sharedComponents: true });
    expect(result).toMatchObject({ ok: true, inlined: [{ route: '/', component: 'Box', file: 'Box.tsx', reason: 'children' }] });
    if (!result.ok) return;
    const panel = Object.values(result.doc.components)[0]!;
    expect(panel.root.children[0]).toMatchObject({ name: 'Box', tag: 'div', style: { base: { margin: '2px' } }, children: [{ tag: 'b', children: [{ text: '{{label}}' }] }] });
    // Panel forwards its own prop into the inlined Box's class, so Panel is inlined too.
    const forwarding = { ...nested, 'Box.tsx': `export default function Box({ tone, children }) { return <div className={tone}>{children}</div>; }`, 'Panel.tsx': `import './panel.css'; import Box from './Box'; export default function Panel({ label }) { return <section><Box tone={label}><b>{label}</b></Box></section>; }`, 'panel.css': '.A, .B { margin: 2px; }' };
    expect(extractPages({ files: forwarding }, [{ route: '/', file: 'page.tsx' }], { sharedComponents: true })).toMatchObject({ ok: true, doc: { components: {} }, inlined: [{ component: 'Box', reason: 'children' }, { component: 'Panel', reason: 'prop-css' }] });
  });

  it('re-extracts earlier routes when a later route inlines a component they rendered', () => {
    const files = { ...card, 'a.tsx': `import Card from './Card'; export default () => <main><Card /></main>`, 'b.tsx': `import Card from './Card'; export default () => <main><Card><p>B</p></Card></main>` };
    const result = extractPages({ files }, cardRoutes, { sharedComponents: true });
    expect(result).toMatchObject({ ok: true, inlined: [{ route: '/a', component: 'Card', reason: 'children' }, { route: '/b', component: 'Card', reason: 'children' }] });
    if (result.ok) expect(Object.values(result.doc.components).map((definition) => definition.root.tag)).toEqual(['button']);
  });

  it('still shares a component with no slot and no prop-driven CSS', () => {
    const synced = synchronizePages({ project: { files }, entries, commit: 'c1' });
    expect(synced).toMatchObject({ ok: true, inlined: [] });
    if (!synced.ok) return;
    expect(Object.keys(synced.state.doc.components)).toHaveLength(1);
    for (const page of Object.values(synced.state.doc.pages)) expect(page.root.children.map((node) => node.kind)).toEqual(['instance', 'instance']);
  });

  it('still fails every other shared-definition problem', () => {
    const project = { files: { ...files, 'b.tsx': `import './other.css'; import Button from './Button'; export default () => <main><Button label="Other" /></main>`, 'other.css': 'button { padding: 20px; }' } };
    expect(synchronizePages({ project, entries: [entries[0]!, { route: '/b', file: 'b.tsx' }], commit: 'c1' })).toMatchObject({ ok: false, kind: 'source' });
    expect(synchronizePages({ project: { files: { ...files, 'page.tsx': `import Button from './Button'; export default () => <main><Button label={4} /></main>` } }, entries, commit: 'c1' })).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ message: 'Shared component preview props must be strings' })]) });
    expect(synchronizePages({ project: { files: { ...files, 'Button.tsx': 'export default function Button({label}) { return <main><Button label={label} /></main>; }' } }, entries, commit: 'c1' })).toMatchObject({ ok: false });
  });
});
