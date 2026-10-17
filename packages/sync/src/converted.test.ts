import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportPage, type DesignNode, type ElementNode } from '@hub/design-model';
import { parseStyles } from './css.js';
import { baselineTokens, extractPages, parseSyncState, serializeSyncState, synchronizePages, type RouteEntry, type SourceProject } from './index.js';

// A hand-written miniature of the codemod's output (CSS plan D4, D6, D8, D9, D11): read as text, never executed.
const ROOT = fileURLToPath(new URL('./fixtures/converted/', import.meta.url));
function load(dir: string, files: Record<string, string> = {}): Record<string, string> {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) load(full, files);
    else files[relative(ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
  }
  return files;
}
const files = load(ROOT);
const route: RouteEntry = { route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] };
const BOX = { 'box-sizing': 'border-box' };

function element(node: DesignNode | undefined): ElementNode {
  if (node?.kind !== 'element') throw new Error(`expected an element, got ${JSON.stringify(node)}`);
  return node;
}
function sourceOnly(file: string): number {
  return parseStyles(files[file]!, file.endsWith('.module.css') ? 'cX' : null, {
    file,
    resolveImport(spec, from) { const target = posix.normalize(posix.join(posix.dirname(from), spec)); return { file: target, text: files[target]! }; },
  }).sourceOnly;
}

describe('converted CSS Modules output', () => {
  it('imports the fixture with resting styles per element and device', () => {
    const result = extractPages({ files }, [route]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const html = element(Object.values(result.doc.pages)[0]!.root);
    // Undashed :root custom properties and .dark custom properties stay declarations on the root (Ruling D).
    expect(html.style).toEqual({ base: { '--background': '240 10% 3.9%', '--radius': '0.5rem', '--foreground': '0 0% 98%', ...BOX } });
    const body = element(html.children[0]);
    expect(body.style).toEqual({ base: { '--ember-text-primary': '#fafafa', '--ember-text-muted': '#a1a1aa', '--ember-accent-default': '#f59e0b', color: 'var(--ember-text-primary)', 'background-color': 'hsl(var(--background))', ...BOX } });
    const main = element(body.children[0]);
    expect(main.style).toEqual({ base: { padding: 'var(--space-4)', ...BOX } });
    const card = element(main.children[0]);
    const cardTablet = { display: 'grid', gap: 'var(--space-0_5)', ...BOX };
    expect(card.style).toEqual({ base: { display: 'grid', gap: 'var(--space-2)', ...BOX }, tablet: cardTablet, mobile: cardTablet });
    const [title, small, chip] = card.children.map(element);
    // .title:is(:where(.card):hover *) is a hover state: the resting title keeps its own color.
    expect(title!.style).toEqual({ base: { color: 'var(--ember-text-muted)', ...BOX } });
    // A literal global class from ember.css, loaded through the layout's globals.css.
    expect(small!.style).toEqual({ base: { font: '400 var(--text-xs) / var(--text-xs-leading) sans-serif', 'letter-spacing': '0.01em', ...BOX } });
    // The caller's .chip (0,1,0) beats the component's :where(.root) and :where(.rootWhen1); .chip.chip:hover is a state.
    const chipBase = { display: 'inline-flex', 'padding-inline': 'var(--space-3)', color: 'var(--color-amber-300)', ...BOX };
    expect(chip!.style).toEqual({ base: chipBase, tablet: chipBase, mobile: { ...chipBase, 'padding-inline': 'var(--space-2)' } });
    expect(element(chip!.children[0]).style).toEqual({ base: { width: 'var(--space-3)', height: 'var(--space-3)', animation: 'var(--animate-spin)', 'animation-duration': '2s', ...BOX } });
    expect(chip!.children[1]).toMatchObject({ kind: 'text', text: 'New' });
  });

  it('turns dashed :root custom properties into model tokens, following the cascade', () => {
    const result = extractPages({ files }, [route]);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.doc.tokens).toEqual({
      space: { '0_5': '0.125rem', '2': '0.5rem', '3': '0.75rem', '4': '1rem' },
      color: { 'amber-300': '#fcd34d', 'amber-400': '#fbbf24' },
      text: { xs: '0.75rem', 'xs-leading': 'calc(1 / 0.75)' },
      // Unlayered globals.css beats @layer theme in tokens.css.
      radius: { md: 'calc(var(--radius) - 2px)' },
      animate: { spin: 'spin 1s linear infinite' },
    });
    expect(result.dependencies[Object.keys(result.doc.pages)[0]!]).toEqual(['app/globals.css', 'app/layout.tsx', 'app/page.module.css', 'app/page.tsx', 'components/Chip.module.css', 'components/Chip.tsx', 'styles/animations.css', 'styles/ember.css', 'styles/reset.css', 'styles/tokens.css']);
    const exported = exportPage(result.doc, Object.keys(result.doc.pages)[0]!);
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(exported.value.css).toContain('--space-0_5:0.125rem;');
  });

  it('counts hover, keyframes, @property and contentless pseudo-element rules as source-only', () => {
    // @property, two @keyframes, ::before and ::after.
    expect(sourceOnly('app/globals.css')).toBe(5);
    // .root:hover
    expect(sourceOnly('components/Chip.module.css')).toBe(1);
    // .title:is(:where(.card):hover *) and .chip.chip:hover
    expect(sourceOnly('app/page.module.css')).toBe(2);
  });

  it('still rejects unconverted Tailwind classes next to converted ones', () => {
    const page = files['app/page.tsx']!.replace('className="ember-type-body-small"', 'className="ember-type-body-small text-xs"');
    const result = extractPages({ files: { ...files, 'app/page.tsx': page } }, [route]);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ message: expect.stringContaining('Unresolved CSS class text-xs') }] });
  });

  it('persists tokens in the sync baseline and reuses them unchanged', () => {
    // Sync shares components; the Chip, given className and children by its caller, is inlined (Ruling F).
    const project = { files };
    const first = synchronizePages({ project, entries: [route], commit: 'c1' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(first.state.doc.tokens['space']).toEqual({ '0_5': '0.125rem', '2': '0.5rem', '3': '0.75rem', '4': '1rem' });
    const reparsed = parseSyncState(serializeSyncState(first.state));
    expect(reparsed).toEqual({ ok: true, value: first.state });
    const again = synchronizePages({ project, entries: [route], commit: 'c2', previous: first.state });
    expect(again).toMatchObject({ ok: true, reused: ['/'] });
    if (again.ok) expect(again.state.doc).toEqual(first.state.doc);
    expect(baselineTokens(first.state.baseline)).toEqual(first.state.doc.tokens);
    const tampered = serializeSyncState(first.state);
    const metadata = JSON.parse(tampered['sync.json']!);
    metadata.baseline.pages['/'].tokens[0].value = '9rem';
    expect(parseSyncState({ ...tampered, 'sync.json': JSON.stringify(metadata) })).toMatchObject({ ok: false, error: expect.stringContaining('does not match') });
    metadata.baseline.pages['/'].tokens[0].group = '__proto__';
    expect(parseSyncState({ ...tampered, 'sync.json': JSON.stringify(metadata) })).toMatchObject({ ok: false, error: expect.stringContaining('Invalid token name') });
  });
});

describe('tokens across routes', () => {
  const project = (b: string): SourceProject => ({ files: {
    'a/page.tsx': `import './a.css'; export default () => <p>a</p>`,
    'a/a.css': ':root { --space-4: 1rem; --color-x: red }',
    'b/page.tsx': `import './b.css'; export default () => <p>b</p>`,
    'b/b.css': b,
  } });
  const entries = [{ route: '/a', file: 'a/page.tsx' }, { route: '/b', file: 'b/page.tsx' }];

  it('merges identical values', () => {
    const result = extractPages(project(':root { --space-4: 1rem }'), entries);
    expect(result).toMatchObject({ ok: true, doc: { tokens: { space: { '4': '1rem' }, color: { x: 'red' } } } });
    const synced = synchronizePages({ project: project(':root { --space-4: 1rem }'), entries, commit: 'c' });
    expect(synced).toMatchObject({ ok: true, state: { doc: { tokens: { space: { '4': '1rem' }, color: { x: 'red' } } } } });
  });

  it('fails a conflicting value naming the token and both files', () => {
    const message = 'Token --space-4 is 1rem in a/a.css but 2rem in b/b.css on another route';
    expect(extractPages(project(':root { --space-4: 2rem }'), entries)).toMatchObject({ ok: false, diagnostics: [{ file: 'b/b.css', message }] });
    expect(synchronizePages({ project: project(':root { --space-4: 2rem }'), entries, commit: 'c' })).toMatchObject({ ok: true, rebuilt: ['/a'], failed: [{ route: '/b', diagnostics: [{ file: 'b/b.css', message }] }] });
  });

  it('fails an unrepresentable token name naming the file and property', () => {
    expect(extractPages(project(':root { --space-Big: 1px }'), entries)).toMatchObject({ ok: false, diagnostics: [{ file: 'b/b.css', message: expect.stringContaining('Unsupported CSS token name --space-Big') }] });
  });
});
