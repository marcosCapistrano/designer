import { describe, expect, it } from 'vitest';
import { canonicalStringify, exportPage } from '@hub/design-model';
import { extractPages, discoverNextRoutes } from './index.js';

const fixture = {
  'web/page.tsx': `import styles from './page.module.css'; import { Button } from './Button';
    export default function Page() { return <main className={styles.page}><h1>Hello</h1><Button label="Start" /></main>; }`,
  'web/Button.tsx': `export function Button({ label }: { label: string }) { return <button>{label}</button>; }`,
  'web/page.module.css': `.page { color: red; padding: 20px; } button { border-radius: 8px; }
    @media (max-width: 1023px) { .page { padding: 12px; } }
    @media (max-width: 599px) { .page { padding: 8px; } }`,
};

describe('static import', () => {
  it('extracts modules, nested components, text, CSS and all dependency files deterministically', () => {
    const project = { files: fixture };
    const routes = [{ route: '/', file: 'web/page.tsx' }];
    const result = extractPages(project, routes);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(canonicalStringify(extractPages(project, routes))).toBe(canonicalStringify(result));
    const page = Object.values(result.doc.pages)[0]!;
    expect(result.dependencies[page.id]).toEqual(Object.keys(fixture).sort());
    const exported = exportPage(result.doc, page.id);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.html).toContain('Hello');
    expect(exported.value.html).toContain('Start');
    expect(exported.value.css).toContain('padding:20px');
    expect(exported.value.css).toContain('padding:12px');
    expect(exported.value.css).toContain('padding:8px');
  });

  it('keeps node IDs across whitespace, unrelated declarations and unrelated pages', () => {
    const entries = [{ route: '/', file: 'web/page.tsx' }];
    const first = extractPages({ files: fixture }, entries);
    const next = extractPages({ files: { ...fixture, 'web/page.tsx': '\n// comment\nconst unused = 4;\n' + fixture['web/page.tsx'], 'other.tsx': 'export default () => <p>Other</p>' } }, [...entries, { route: '/other', file: 'other.tsx' }]);
    expect(first.ok && next.ok).toBe(true);
    if (first.ok && next.ok) expect(next.doc.pages[Object.keys(first.doc.pages)[0]!]).toEqual(Object.values(first.doc.pages)[0]);
  });

  it('namespaces component occurrences across pages', () => {
    const result = extractPages({ files: fixture }, [{ route: '/', file: 'web/page.tsx' }, { route: '/copy', file: 'web/page.tsx' }]);
    expect(result.ok).toBe(true); // validateDoc catches any duplicate IDs.
  });

  it('handles specificity across media queries and inline style precedence', () => {
    const result = extractPages({ files: {
      'page.tsx': `import './style.css'; export default () => <p id="title" className="title" style={{ padding: '10px' }}>Hi</p>`,
      'style.css': `#title { color: red; } @media (max-width: 1023px) { .title { color: blue; padding: 4px; } }`,
    } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = Object.values(result.doc.pages)[0]!.root;
    expect(node.kind).toBe('element');
    if (node.kind === 'element') {
      expect(node.style.tablet?.['color']).toBe('red');
      expect(node.style.tablet?.['padding']).toBe('10px');
    }
  });

  it.each([
    ['dynamic', `export default () => <p>{fetch('/api')}</p>`, 'preview choice'],
    ['external component', `import Widget from 'some-library'; export default () => <Widget />`, 'preview adapter'],
    ['unsafe markup', `export default () => <script>oops</script>`, 'not allowed'],
    ['syntax', `export default () => <p>`, 'syntax'],
  ])('rejects %s without returning partial pages', (_, source, message) => {
    const result = extractPages({ files: { 'page.tsx': source } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.message).toContain(message);
    expect(result).not.toHaveProperty('doc');
  });

  it.each(['.title::before { content: "x"; }', '.title + p { color: red; }', '@media (max-width: 700px) { p { color: red; } }', 'p { color: red !important; }'])('rejects unsupported CSS: %s', (css) => {
    const result = extractPages({ files: { 'page.tsx': `import './style.css'; export default () => <p>Hi</p>`, 'style.css': css } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.message).toContain('Unsupported CSS');
  });

  it('inlines relative CSS @import against the importing file, tracks it as a dependency and names it in diagnostics', () => {
    const files = {
      'app/page.tsx': `import './globals.css'; export default () => <ul className="list"><li>A</li><li>B</li></ul>`,
      'app/globals.css': `@import "./styles/base.css"; .list > :not(:last-child) { margin-bottom: 4px; }`,
      'app/styles/base.css': `@import "./tokens.css"; @layer base { .list li { color: red; } }`,
      'app/styles/tokens.css': `:root { --gap: 4px; }`,
    };
    const result = extractPages({ files }, [{ route: '/', file: 'app/page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const root = Object.values(result.doc.pages)[0]!.root;
      expect(root.children.map((child) => child.kind === 'element' && child.style.base)).toEqual([{ color: 'red', 'margin-bottom': '4px' }, { color: 'red' }]);
      expect(Object.values(result.dependencies)[0]).toEqual(['app/globals.css', 'app/page.tsx', 'app/styles/base.css', 'app/styles/tokens.css']);
    }
    const broken = extractPages({ files: { ...files, 'app/styles/tokens.css': '.x::after { content: ""; }' } }, [{ route: '/', file: 'app/page.tsx' }]);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.diagnostics[0]).toMatchObject({ file: 'app/styles/tokens.css', message: 'Unsupported CSS pseudo-element ::after with content' });
  });

  it('parses a stylesheet reached from TSX and @import once, at its first occurrence, and orders layers across files', () => {
    const files = {
      'page.tsx': `import './globals.css'; import './a.css'; export default () => <p className="x">Hi</p>`,
      'globals.css': `@import "./a.css"; .x { color: blue; }`,
      'a.css': `.x { color: red; }`,
    };
    const result = extractPages({ files }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(Object.values(result.doc.pages)[0]!.root.style.base).toEqual({ color: 'blue' });
    const layered = extractPages({ files: { ...files, 'globals.css': '@layer utilities { .x { color: blue; } }', 'a.css': '@layer base { .x { color: red; } }' } }, [{ route: '/', file: 'page.tsx' }]);
    expect(layered).toMatchObject({ ok: false, diagnostics: [{ file: 'a.css', message: 'Unsupported CSS layer order: utilities, base' }] });
  });

  it('rejects unresolved utility classes and side-effect code', () => {
    for (const source of [`export default () => <p className="flex p-4">Hi</p>`, `import './setup'; export default () => <p>Hi</p>`]) {
      expect(extractPages({ files: { 'page.tsx': source } }, [{ route: '/', file: 'page.tsx' }]).ok).toBe(false);
    }
  });

  it('decodes JSX text and attribute entities exactly once', () => {
    const result = extractPages({ files: { 'page.tsx': `export default () => <p title="A &amp; B">A &amp; B &#x1F600;</p>` } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const node = Object.values(result.doc.pages)[0]!.root;
      if (node.kind === 'element') {
        expect(node.attrs['title']).toBe('A & B');
        expect(node.children[0]).toMatchObject({ text: 'A & B 😀' });
      }
    }
  });

  it('rejects ambiguous shorthand ordering rather than changing the appearance', () => {
    const result = extractPages({ files: { 'page.tsx': `import './style.css'; export default () => <p>Hi</p>`, 'style.css': 'p { margin-left: 2px; margin: 4px; }' } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.message).toContain('mixed shorthand');
  });

  it('keeps the source root and does not apply CSS to a synthetic fragment wrapper', () => {
    const files = { 'page.tsx': `import './style.css'; export default () => <><div>One</div><div>Two</div></>`, 'style.css': 'div { padding: 8px; }' };
    const result = extractPages({ files }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const root = Object.values(result.doc.pages)[0]!.root;
      expect(root.style.base).toEqual({});
      expect(root.children[0]).toMatchObject({ style: { base: { padding: '8px' } } });
    }
    const single = extractPages({ files: { ...files, 'page.tsx': `import './style.css'; export default () => <div>One</div>` } }, [{ route: '/', file: 'page.tsx' }]);
    expect(single.ok).toBe(true);
    if (single.ok) expect(Object.values(single.doc.pages)[0]!.root.children[0]).toMatchObject({ kind: 'text', text: 'One' });
  });
});

describe('Next routes', () => {
  it('discovers groups, dynamic routes and layouts in nesting order', () => {
    const files = { 'app/layout.tsx': '', 'app/(account)/layout.tsx': '', 'app/(account)/users/[id]/page.tsx': '', 'app/page.tsx': '', 'app/api/route.ts': '' };
    expect(discoverNextRoutes({ files })).toEqual([
      { route: '/users/[id]', file: 'app/(account)/users/[id]/page.tsx', layouts: ['app/layout.tsx', 'app/(account)/layout.tsx'] },
      { route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] },
    ]);
  });

  it('extracts static nested layouts with children', () => {
    const project = { files: {
      'app/layout.tsx': `export default function Layout({children}: {children: unknown}) { return <section>{children}</section> }`,
      'app/page.tsx': `export default () => <p>Hello</p>`,
    } };
    const result = extractPages(project, discoverNextRoutes(project));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const exported = exportPage(result.doc, Object.keys(result.doc.pages)[0]!);
      expect(exported.ok).toBe(true);
      if (exported.ok) expect(exported.value.html).toMatch(/<section[^>]*><p/);
    }
  });

  it('rejects route collisions and parallel routes', () => {
    expect(() => discoverNextRoutes({ files: { 'app/(a)/page.tsx': '', 'app/(b)/page.tsx': '' } })).toThrow('Duplicate route');
    expect(() => discoverNextRoutes({ files: { 'app/@modal/page.tsx': '' } })).toThrow('preview choice');
  });
});
