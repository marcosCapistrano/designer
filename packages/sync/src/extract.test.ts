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

describe('path aliases and the document shell', () => {
  it('resolves aliased imports through the longest matching prefix and the usual extension/index resolution', () => {
    const files = {
      'site/src/app/page.tsx': `import { X } from "@/components/X"; import { Y } from "@/ui"; import "@/app/globals.css"; export default () => <main className="m"><X /><Y /></main>`,
      'site/src/components/X.tsx': `import { label } from '@/lib/label'; export function X() { return <p>{label}</p>; }`,
      'site/src/lib/label.ts': `export const label = 'From alias';`,
      'site/src/ui/index.tsx': `export function Y() { return <span>Index</span>; }`,
      'site/src/app/globals.css': `.m { color: red; }`,
      'other/ui/index.tsx': `export function Y() { return <span>Wrong</span>; }`,
    };
    const result = extractPages({ files, aliases: { '@/': 'site/src/', '@/ui': 'other/ui' } }, [{ route: '/', file: 'site/src/app/page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const exported = exportPage(result.doc, Object.keys(result.doc.pages)[0]!);
    expect(exported.ok && exported.value.html).toMatch(/From alias.*Wrong/);
    expect(Object.values(result.dependencies)[0]).toEqual(['other/ui/index.tsx', 'site/src/app/globals.css', 'site/src/app/page.tsx', 'site/src/components/X.tsx', 'site/src/lib/label.ts']);
  });

  it('keeps failing unaliased bare specifiers and aliases that escape the source root', () => {
    const page = (spec: string) => ({ 'site/src/app/page.tsx': `import { X } from "${spec}"; export default () => <X />` });
    const bare = extractPages({ files: page('some-lib'), aliases: { '@/': 'site/src/' } }, [{ route: '/', file: 'site/src/app/page.tsx' }]);
    expect(bare).toMatchObject({ ok: false, diagnostics: [{ file: 'site/src/app/page.tsx', message: 'External import some-lib needs a preview adapter' }] });
    const escape = extractPages({ files: page('@/../../../etc/X'), aliases: { '@/': 'site/src/' } }, [{ route: '/', file: 'site/src/app/page.tsx' }]);
    expect(escape).toMatchObject({ ok: false, diagnostics: [{ file: 'site/src/app/page.tsx', message: 'Import escapes source root' }] });
    const partial = extractPages({ files: page('@/uix'), aliases: { '@/ui': 'ui' } }, [{ route: '/', file: 'site/src/app/page.tsx' }]);
    expect(partial).toMatchObject({ ok: false, diagnostics: [{ message: 'External import @/uix needs a preview adapter' }] });
  });

  const shell = {
    'app/layout.tsx': `"use client";
      import type { Metadata } from 'next';
      import styles from './layout.module.css';
      import './globals.css';
      export const metadata: Metadata = { title: process.env.TITLE, description: \`x \${1}\` };
      export const dynamic = "force-dynamic";
      export const revalidate = 0;
      export async function generateMetadata() { return await fetch('/x'); }
      export default function RootLayout({ children }: { children: unknown }) {
        return <html lang="pt-BR" className="dark"><body className={styles.body}>{children}</body></html>;
      }`,
    'app/layout.module.css': `.body { margin: 0; }`,
    'app/globals.css': `:root { --c: red; color: black; } .dark .t { color: white; } html > body > main { padding: 4px; } :root > body { font-size: 14px; }`,
    'app/page.tsx': `'use client'; export const dynamic = "force-dynamic"; export default () => <main><p className="t">Hi</p></main>`,
  };

  it('matches selectors against html/body, then emits them as plain divs (R5)', () => {
    const result = extractPages({ files: shell }, [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const root = Object.values(result.doc.pages)[0]!.root;
    expect(root).toMatchObject({ tag: 'div', attrs: {}, style: { base: { color: 'black' } } });
    const body = root.children[0]!;
    expect(body).toMatchObject({ kind: 'element', tag: 'div', attrs: {}, style: { base: { margin: '0', 'font-size': '14px' } } });
    if (body.kind !== 'element') return;
    expect(body.children).toHaveLength(1);
    const main = body.children[0]!;
    expect(main).toMatchObject({ tag: 'main', style: { base: { padding: '4px' } } });
    if (main.kind === 'element') expect(main.children[0]).toMatchObject({ tag: 'p', style: { base: { color: 'white' } } });
    const exported = exportPage(result.doc, Object.keys(result.doc.pages)[0]!);
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(exported.value.html).not.toMatch(/<html|<body|lang=/);
  });

  it('rejects html/body anywhere but the outermost two elements of the root layout', () => {
    const route = [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }];
    const cases: [Record<string, string>, string, string][] = [
      [{ 'app/page.tsx': `export default () => <div><body>x</body></div>` }, 'app/page.tsx', '<body> is only supported'],
      [{ 'app/page.tsx': `export default () => <html><body>x</body></html>` }, 'app/page.tsx', '<html> is only supported'],
      [{ 'app/layout.tsx': `export default ({ children }: { children: unknown }) => <html><main><body>{children}</body></main></html>` }, 'app/layout.tsx', '<body> is only supported'],
      [{ 'app/layout.tsx': `export default ({ children }: { children: unknown }) => <div><html><body>{children}</body></html></div>` }, 'app/layout.tsx', '<html> is only supported'],
      [{ 'app/layout.tsx': `export default ({ children }: { children: unknown }) => <body>{children}</body>` }, 'app/layout.tsx', '<body> is only supported'],
    ];
    for (const [overrides, file, message] of cases) {
      const result = extractPages({ files: { ...shell, ...overrides } }, route);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]).toMatchObject({ file, message: expect.stringContaining(message) });
    }
    const pageOnly = extractPages({ files: { 'page.tsx': `export default () => <html><body>x</body></html>` } }, [{ route: '/', file: 'page.tsx' }]);
    expect(pageOnly).toMatchObject({ ok: false, diagnostics: [{ file: 'page.tsx', message: expect.stringContaining('<html> is only supported') }] });
  });
});
