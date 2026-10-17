import { describe, expect, it } from 'vitest';
import { canonicalStringify, exportPage } from '@hub/design-model';
import { choiceKey, extractPages, discoverNextRoutes } from './index.js';

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

  it('maps React SVG and DOM prop names to the attribute names the browser reads', () => {
    const page = `export default () => <div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" strokeWidth="2" preserveAspectRatio="none"><path strokeLinejoin="round" fillRule="evenodd" clipRule="evenodd" d="M0 0" /><circle cx="1" cy="1" r="1" strokeOpacity="0.5" /></svg><input readOnly tabIndex={0} defaultValue="v" autoComplete="off" /></div>`;
    const result = extractPages({ files: { 'page.tsx': page } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const exported = exportPage(result.doc, Object.keys(result.doc.pages)[0]!);
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.html).toContain('stroke-width="2" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"');
    expect(exported.value.html).toContain('preserveAspectRatio="none"');
    expect(exported.value.html).toContain('clip-rule="evenodd" d="M0 0" fill-rule="evenodd" stroke-linejoin="round"');
    expect(exported.value.html).toContain('stroke-opacity="0.5"');
    expect(exported.value.html).toContain('autocomplete="off" readonly="" tabindex="0" value="v"');
    for (const [source, message] of [
      ['<svg><use xlinkHref="#a" /></svg>', 'Unsupported JSX attribute xlinkHref'],
      ['<textarea defaultValue="x" />', 'Unsupported JSX attribute defaultValue on <textarea>'],
      ['<select value="x"><option>x</option></select>', 'Unsupported JSX attribute value on <select>'],
    ]) expect(extractPages({ files: { 'page.tsx': `export default () => ${source}` } }, [{ route: '/', file: 'page.tsx' }])).toMatchObject({ ok: false, diagnostics: [{ file: 'page.tsx', message: expect.stringContaining(message!) }] });
  });

  it('renders boolean JSX props as react-dom does, so attribute selectors match', () => {
    const page = `import './style.css'; export default () => <div><p className="a" data-empty={false} aria-selected={true} data-on draggable={false} hidden={false} title={true}>x</p><input disabled readOnly={false} /></div>`;
    const result = extractPages({ files: { 'page.tsx': page, 'style.css': '.a { color: black } .a[data-empty="false"][aria-selected="true"] { color: red }' } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const root = Object.values(result.doc.pages)[0]!.root;
    expect(root.children[0]).toMatchObject({ attrs: { 'data-empty': 'false', 'aria-selected': 'true', 'data-on': 'true', draggable: 'false' }, style: { base: { color: 'red' } } });
    expect(root.children[0]!.kind === 'element' && Object.keys(root.children[0]!.attrs).sort()).toEqual(['aria-selected', 'data-empty', 'data-on', 'draggable']);
    expect(root.children[1]).toMatchObject({ attrs: { disabled: '' } });
    expect(root.children[1]!.kind === 'element' && root.children[1]!.attrs).toEqual({ disabled: '' });
  });

  it('rejects ambiguous shorthand ordering rather than changing the appearance', () => {
    const result = extractPages({ files: { 'page.tsx': `import './style.css'; export default () => <p>Hi</p>`, 'style.css': 'p { margin-left: 2px; margin: 4px; }' } }, [{ route: '/', file: 'page.tsx' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]).toMatchObject({ file: 'style.css', message: 'Unsupported CSS declaration order: margin-left before margin in p' });
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

  it('discovers only included routes, without failing on routes outside the scope', () => {
    const files = { 'app/layout.tsx': '', 'app/login/page.tsx': '', 'app/page.tsx': '', 'app/(a)/x/page.tsx': '', 'app/(b)/x/page.tsx': '', 'app/@modal/y/page.tsx': '' };
    expect(discoverNextRoutes({ files }, 'app', ['/login'])).toEqual([{ route: '/login', file: 'app/login/page.tsx', layouts: ['app/layout.tsx'] }]);
    expect(() => discoverNextRoutes({ files }, 'app', ['/x'])).toThrow('Duplicate route /x');
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
    // Ruling P: the html-derived root is marked so the export propagates its font and the canvas background.
    expect(root).toMatchObject({ tag: 'div', attrs: { 'data-d-shell': 'html' }, style: { base: { color: 'black' } } });
    expect(Object.keys(root.attrs)).toEqual(['data-d-shell']);
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
    const plain = extractPages({ files: { 'page.tsx': `export default () => <main>x</main>` } }, [{ route: '/', file: 'page.tsx' }]);
    expect(plain.ok && Object.values(plain.doc.pages)[0]!.root.attrs).toEqual({});
  });

  it('exports the html root font-size and the body background on the real html element (Ruling P)', () => {
    const files = {
      'app/layout.tsx': `import './globals.css'; export default function Layout({ children }: { children: unknown }) { return <html lang="en"><body>{children}</body></html>; }`,
      'app/globals.css': 'html { font-size: 62.5%; color-scheme: dark } body { background: #111; margin: 0 } .x { font-size: 1.6rem }',
      'app/page.tsx': `export default () => <p className="x">Hi</p>`,
    };
    const result = extractPages({ files }, [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const page = Object.values(result.doc.pages)[0]!;
    const exported = exportPage(result.doc, page.id);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const body = page.root.children[0]!, x = body.kind === 'element' ? body.children[0]! : body;
    expect(exported.value.css.split('\n')).toEqual([
      'html{background:#111;color-scheme:dark;font-size:62.5%;}',
      `[data-d-id="${body.id}"]{margin:0;}`,
      `[data-d-id="${x.id}"]{font-size:1.6rem;}`,
    ]);
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

describe('clsx, async components and choice-backed calls', () => {
  const route = [{ route: '/', file: 'app/page.tsx' }];
  const css = { 'app/page.module.css': `.a { color: red; } .b { padding: 1px; }`, 'app/globals.css': `.ember { margin: 0; } .x { top: 0; } .y { left: 0; } .z { right: 0; }` };
  const pageRoot = (result: ReturnType<typeof extractPages>) => { if (!result.ok) throw new Error(JSON.stringify(result.diagnostics)); return Object.values(result.doc.pages)[0]!.root; };
  const gapOf = (result: ReturnType<typeof extractPages>) => { if (result.ok) throw new Error('gap expected'); return result.diagnostics[0]!.gap; };
  const val = (file: string, expression: string, value: unknown) => ({ [choiceKey(file, expression)]: { kind: 'value' as const, value: value as string } });

  it('evaluates clsx like the library: strings kept, falsy dropped, arrays flattened, object keys with truthy values', () => {
    const files = { ...css, 'app/page.tsx': `import { clsx } from "clsx"; import styles from './page.module.css'; import './globals.css';
      const cond = true; const off = false;
      export default () => <p className={clsx(styles.a, cond && styles.b, "ember", off && "nope", null, undefined, 0, ["x", [false, "y"]], { z: true, nope: false, [styles.b]: 1 })}>Hi</p>` };
    expect(pageRoot(extractPages({ files }, route)).style.base).toEqual({ color: 'red', padding: '1px', margin: '0', top: '0', left: '0', right: '0' });
    const off = { ...files, 'app/page.tsx': files['app/page.tsx'].replace('const cond = true', 'const cond = false') };
    expect(pageRoot(extractPages({ files: off }, route)).style.base).toEqual({ color: 'red', margin: '0', top: '0', left: '0', right: '0', padding: '1px' });
  });

  it('takes a clsx condition from a saved choice and raises the gap for that argument only', () => {
    const files = { ...css, 'app/page.tsx': `import clsx from "clsx"; import styles from './page.module.css';
      export default function Page() { const cond = isOn(); return <p className={clsx(styles.a, cond && styles.b)}>Hi</p>; }` };
    expect(gapOf(extractPages({ files }, route))).toMatchObject({ file: 'app/page.tsx', expression: 'isOn()', kind: 'value' });
    expect(pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'isOn()', true) })).style.base).toEqual({ color: 'red', padding: '1px' });
    expect(pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'isOn()', false) })).style.base).toEqual({ color: 'red' });
  });

  it('builds in only clsx from the module "clsx": other class helpers are calls with one gap for the whole call', () => {
    for (const [source, expression] of [
      [`import { cn } from './cn'; export default () => <p className={cn("a", missing)}>Hi</p>`, 'cn("a", missing)'],
      [`import { clsx } from 'classnames'; export default () => <p className={clsx("a")}>Hi</p>`, 'clsx("a")'],
    ]) {
      const result = extractPages({ files: { 'app/page.tsx': source!, 'app/cn.ts': 'export function cn() { return "a"; }' } }, route);
      expect(gapOf(result)).toMatchObject({ file: 'app/page.tsx', expression, kind: 'value' });
    }
  });

  it('renders async page components and reads awaited route props from the props.<name> choice of the entry file', () => {
    const files = { 'app/page.tsx': `export default async function LoginPage({ params, searchParams }: { params: Promise<{}>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
      const p = await searchParams;
      return <a href={p.next}>Go</a>;
    }` };
    expect(gapOf(extractPages({ files }, route))).toEqual({ key: choiceKey('app/page.tsx', 'props.searchParams'), file: 'app/page.tsx', expression: 'props.searchParams', kind: 'value' });
    const root = pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'props.searchParams', { next: '/home' }) }));
    expect(root).toMatchObject({ tag: 'a', attrs: { href: '/home' } });
    const arrow = { 'app/page.tsx': `const Page = async (props: { searchParams: Promise<{ next?: string }> }) => { const { next } = await props.searchParams; return <a href={next}>Go</a>; }; export default Page;` };
    expect(gapOf(extractPages({ files: arrow }, route))).toMatchObject({ expression: 'props.searchParams' });
    expect(pageRoot(extractPages({ files: arrow }, route, { choices: val('app/page.tsx', 'props.searchParams', { next: '/x' }) }))).toMatchObject({ attrs: { href: '/x' } });
  });

  it('raises entry props of layouts against the layout file and keeps shared component prop rules', () => {
    const files = { 'app/layout.tsx': `export default async function Layout({ children, params }: { children: unknown; params: Promise<{ id: string }> }) { const { id } = await params; return <section title={id}>{children}</section>; }`, 'app/page.tsx': `export default () => <p>Hi</p>` };
    const layouts = [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }];
    expect(gapOf(extractPages({ files }, layouts))).toMatchObject({ file: 'app/layout.tsx', expression: 'props.params' });
    expect(pageRoot(extractPages({ files }, layouts, { choices: val('app/layout.tsx', 'props.params', { id: '7' }) }))).toMatchObject({ tag: 'section', attrs: { title: '7' } });
    const child = extractPages({ files: { 'app/page.tsx': `function Card({ title }: { title: string }) { return <p>{title}</p>; } export default () => <Card />` } }, route);
    // Ruling G: a non-entry component's omitted prop without a default is undefined, which renders nothing.
    expect(pageRoot(child)).toMatchObject({ tag: 'p', children: [] });
  });

  it('raises a gap for a call to an imported source function without evaluating its arguments, and a saved value satisfies it', () => {
    const files = {
      'src/lib/auth.ts': `export function loginSettings() { return process.env.SECRET; } export function safeNext(x: unknown) { return x; }`,
      'src/app/page.tsx': `import { loginSettings, safeNext } from "@/lib/auth";
        const MESSAGES = { unset: "Login is not configured", bad: "Wrong password" };
        export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
          const params = await searchParams;
          const next = safeNext(typeof params.next === "string" ? params.next : undefined);
          const errorKey = params.error;
          const message = !loginSettings() ? MESSAGES.unset : errorKey ? MESSAGES[errorKey] : undefined;
          function unused() { return 1; }
          const handler = () => unused();
          return <main><input type="hidden" value={next} />{message && <p>{message}</p>}</main>;
        }`,
    };
    const project = { files, aliases: { '@/': 'src/' } };
    const entries = [{ route: '/', file: 'src/app/page.tsx' }];
    // The call is a gap before its argument (which reads the unresolved searchParams) is ever evaluated.
    expect(gapOf(extractPages(project, entries))).toMatchObject({ file: 'src/app/page.tsx', expression: 'safeNext(typeof params.next === "string" ? params.next : undefined)', kind: 'value' });
    const next = val('src/app/page.tsx', 'safeNext(typeof params.next === "string" ? params.next : undefined)', '/home');
    expect(gapOf(extractPages(project, entries, { choices: next }))).toMatchObject({ file: 'src/app/page.tsx', expression: 'loginSettings()', kind: 'value' });
    // An unset login never reads searchParams, so no route-prop gap arises.
    const unset = pageRoot(extractPages(project, entries, { choices: { ...next, ...val('src/app/page.tsx', 'loginSettings()', null) } }));
    expect(unset.children[1]).toMatchObject({ tag: 'p', children: [{ text: 'Login is not configured' }] });
    const settings = { ...next, ...val('src/app/page.tsx', 'loginSettings()', { password: 'x' }) };
    expect(gapOf(extractPages(project, entries, { choices: settings }))).toMatchObject({ file: 'src/app/page.tsx', expression: 'props.searchParams' });
    const configured = pageRoot(extractPages(project, entries, { choices: { ...settings, ...val('src/app/page.tsx', 'props.searchParams', { error: 'bad' }) } }));
    expect(configured.children.map((child) => child.kind === 'element' ? [child.tag, child.attrs['value'] ?? (child.children[0] as { text?: string })?.text] : null)).toEqual([['input', '/home'], ['p', 'Wrong password']]);
    // A field missing from a chosen object stays a gap for that member expression, as before.
    expect(gapOf(extractPages(project, entries, { choices: { ...settings, ...val('src/app/page.tsx', 'props.searchParams', {}) } }))).toMatchObject({ expression: 'params.error' });
    const clean = pageRoot(extractPages(project, entries, { choices: { ...settings, ...val('src/app/page.tsx', 'props.searchParams', { error: null }) } }));
    expect(clean.children).toHaveLength(1);
  });

  it('raises a gap for process.env members, not for the comparison or the global', () => {
    const files = { 'app/page.tsx': `export default () => <main>{process.env.NODE_ENV === "development" && <p>Dev</p>}<span>x</span></main>` };
    expect(gapOf(extractPages({ files }, route))).toEqual({ key: choiceKey('app/page.tsx', 'process.env.NODE_ENV'), file: 'app/page.tsx', expression: 'process.env.NODE_ENV', kind: 'value' });
    expect(pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'process.env.NODE_ENV', 'production') })).children).toHaveLength(1);
    expect(pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'process.env.NODE_ENV', 'development') })).children[0]).toMatchObject({ tag: 'p' });
    const bracket = { 'app/page.tsx': `export default () => <p title={process.env["TITLE"]}>x</p>` };
    expect(gapOf(extractPages({ files: bracket }, route))).toMatchObject({ expression: 'process.env["TITLE"]' });
  });

  it('evaluates local bindings lazily and keeps rejecting unsupported statements and bindings', () => {
    const files = { 'app/page.tsx': `export default function Page() { const unused = boom(); const { a, b: renamed, c = "dflt" } = data(); return <p title={c}>{a}{renamed}</p>; }` };
    expect(gapOf(extractPages({ files }, route))).toMatchObject({ expression: 'data()' });
    const root = pageRoot(extractPages({ files }, route, { choices: val('app/page.tsx', 'data()', { a: 'A', b: 'B' }) }));
    expect(root).toMatchObject({ attrs: { title: 'dflt' }, children: [{ text: 'A' }, { text: 'B' }] });
    for (const [source, message] of [
      [`export default function Page() { const { ...rest } = data(); return <p>x</p>; }`, 'Unsupported local binding'],
      [`export default function Page() { const [a] = data(); return <p>x</p>; }`, 'Unsupported local binding'],
      [`export default function Page() { if (x) return null; return <p>x</p>; }`, 'Component execution needs a saved preview choice'],
      [`export default function Page() { const a = b; const b = a; return <p>{a}</p>; }`, 'Cyclic local binding'],
    ]) expect(extractPages({ files: { 'app/page.tsx': source! } }, route)).toMatchObject({ ok: false, diagnostics: [{ file: 'app/page.tsx', message: expect.stringContaining(message!) }] });
  });
});
