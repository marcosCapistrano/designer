import { describe, expect, it } from 'vitest';
import type { DesignNode, ElementNode } from '@hub/design-model';
import { extractPages, parseSyncState, serializeSyncState, synchronizePages, type SourceProject } from './index.js';

type Adapters = NonNullable<SourceProject['adapters']>;
const ADAPTERS: Adapters = {
  modules: {
    'next/link': { default: { kind: 'element', tag: 'a', attrs: { href: 'href' } } },
    react: { Suspense: { kind: 'children' } },
    'lucide-react': { '*': { kind: 'element', tag: 'svg' } },
    'next/script': { default: { kind: 'omit' } },
    '@radix-ui/react-select': { Trigger: { kind: 'element', tag: 'button', attrs: { 'aria-label': 'aria-label' } }, '*': { kind: 'element', tag: 'div' } },
  },
};

function page(files: Record<string, string>, adapters: Adapters | undefined = ADAPTERS, extra: Partial<SourceProject> = {}) {
  return extractPages({ files, ...(adapters ? { adapters } : {}), ...extra }, [{ route: '/', file: 'page.tsx' }]);
}
function root(result: ReturnType<typeof extractPages>): ElementNode {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return Object.values(result.doc.pages)[0]!.root;
}
function el(node: DesignNode | undefined): ElementNode {
  if (node?.kind !== 'element') throw new Error(`Expected an element, got ${JSON.stringify(node)}`);
  return node;
}

describe('declarative preview adapters', () => {
  it('renders next/link Link as an anchor with its href and children', () => {
    const main = root(page({ 'page.tsx': `import Link from 'next/link'; export default () => <main><Link href="/x" prefetch={somethingDynamic()} onClick={go}>Go</Link></main>` }));
    const link = el(main.children[0]);
    expect(link.tag).toBe('a');
    expect(link.attrs).toEqual({ href: '/x' });
    expect(link.children).toMatchObject([{ kind: 'text', text: 'Go' }]);
  });

  it('copies a choice-resolved prop value to the mapped attribute', () => {
    const files = { 'page.tsx': `import Link from 'next/link'; const target = '/y'; export default () => <main><Link href={target}>Go</Link></main>` };
    expect(el(root(page(files)).children[0]).attrs).toEqual({ href: '/y' });
  });

  it('renders react Suspense as its children and drops fallback', () => {
    const main = root(page({ 'page.tsx': `import { Suspense } from 'react'; export default () => <main><Suspense fallback={<Spinner />}><p>Body</p></Suspense></main>` }));
    expect(main.children).toHaveLength(1);
    expect(el(main.children[0]).tag).toBe('p');
  });

  it('renders a lucide-react icon through the * adapter as an empty svg that keeps className styling', () => {
    const main = root(page({
      'page.tsx': `import styles from './page.module.css'; import { ArrowRight } from 'lucide-react'; export default () => <main><ArrowRight className={styles.icon} size={16} strokeWidth={dynamic()} /></main>`,
      'page.module.css': `.icon { width: 16px; color: red; }`,
    }));
    const icon = el(main.children[0]);
    expect(icon.tag).toBe('svg');
    expect(icon.children).toEqual([]);
    expect(icon.attrs).toEqual({});
    expect(icon.style.base).toMatchObject({ width: '16px', color: 'red' });
  });

  it('keeps Unresolved CSS class for an adapted element class', () => {
    const result = page({ 'page.tsx': `import { X } from 'lucide-react'; export default () => <main><X className="h-4 w-4" /></main>` });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ message: expect.stringContaining('Unresolved CSS class h-4') }] });
  });

  it('renders nothing for an omit adapter, without evaluating its props or children', () => {
    const main = root(page({ 'page.tsx': `import Script from 'next/script'; export default () => <main><Script src={dynamic()}>{more()}</Script><p>Kept</p></main>` }));
    expect(main.children).toHaveLength(1);
    expect(el(main.children[0]).tag).toBe('p');
  });

  it('resolves member tags of a namespace import by export name, falling back to *', () => {
    const main = root(page({ 'page.tsx': `import * as Select from '@radix-ui/react-select'; export default () => <main><Select.Root open={state}><Select.Trigger aria-label="Pick">Choose</Select.Trigger></Select.Root></main>` }));
    const select = el(main.children[0]);
    expect(select.tag).toBe('div');
    const trigger = el(select.children[0]);
    expect(trigger.tag).toBe('button');
    expect(trigger.attrs).toEqual({ 'aria-label': 'Pick' });
  });

  it('adapter tag must be model-safe', () => {
    for (const tag of ['script', 'html', 'body', 'head', 'style', 'iframe']) {
      const result = page({ 'page.tsx': `export default () => <main />` }, { modules: { 'next/link': { default: { kind: 'element', tag } } } });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ file: '.hub/adapters.json', message: expect.stringMatching(new RegExp(`next/link.*default.*${tag}`)) }] });
    }
  });

  it('rejects malformed adapter data before traversing source', () => {
    const unknownKey = page({ 'page.tsx': `export default () => <main />` }, { modules: { react: { Suspense: { kind: 'children', extra: 1 } } } } as unknown as Adapters);
    expect(unknownKey).toMatchObject({ ok: false, diagnostics: [{ file: '.hub/adapters.json' }] });
    const reserved = page({ 'page.tsx': `export default () => <main />` }, JSON.parse('{"modules":{"react":{"__proto__":{"kind":"omit"}}}}'));
    expect(reserved).toMatchObject({ ok: false, diagnostics: [{ file: '.hub/adapters.json' }] });
  });

  it('still fails an unmapped external import', () => {
    const result = page({ 'page.tsx': `import Image from 'next/image'; export default () => <main><Image src="/a.png" /></main>` });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ file: 'page.tsx', message: expect.stringMatching(/^External import next\/image needs a preview adapter/) }] });
  });

  it('never uses adapters for aliased source imports', () => {
    const result = page({ 'page.tsx': `import { X } from '@/X'; export default () => <main><X /></main>`, 'src/X.tsx': `export function X() { return <b>Source</b>; }` },
      { modules: { '@/X': { '*': { kind: 'omit' } } } } as Adapters, { aliases: { '@/': 'src/' } });
    // '@/X' is not a package specifier, so the schema refuses it; aliases always resolve as source.
    expect(result.ok).toBe(false);
    const ok = page({ 'page.tsx': `import { X } from '@/X'; export default () => <main><X /></main>`, 'src/X.tsx': `export function X() { return <b>Source</b>; }` }, ADAPTERS, { aliases: { '@/': 'src/' } });
    expect(el(root(ok).children[0]).tag).toBe('b');
  });

  it('adapted elements are host elements, not shared components', () => {
    const result = extractPages({ files: { 'page.tsx': `import Link from 'next/link'; export default () => <main><Link href="/x">Go</Link></main>` }, adapters: ADAPTERS }, [{ route: '/', file: 'page.tsx' }], { sharedComponents: true });
    expect(el(root(result).children[0]).tag).toBe('a');
    if (result.ok) expect(result.doc.components).toEqual({});
  });

  it('styles.ignore skips an imported stylesheet while utility classes still fail', () => {
    const files = {
      'app/layout.tsx': `import './globals.css'; import './tailwind.css'; export default function Layout({ children }) { return <div className="shell">{children}</div>; }`,
      'app/globals.css': `.shell { color: red; }`,
      'app/tailwind.css': `@import "tailwindcss"; @theme { --color-x: red; }`,
      'app/page.tsx': `export default () => <main>Hi</main>`,
      'app/utility.tsx': `export default () => <main className="flex">Hi</main>`,
    };
    const adapters: Adapters = { modules: {}, styles: { ignore: ['app/tailwind.css'] } };
    const without = extractPages({ files }, [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }]);
    expect(without.ok).toBe(false);
    const result = extractPages({ files, adapters }, [{ route: '/', file: 'app/page.tsx', layouts: ['app/layout.tsx'] }]);
    expect(root(result).style.base).toMatchObject({ color: 'red' });
    if (result.ok) expect(Object.values(result.dependencies)[0]).not.toContain('app/tailwind.css');
    const utility = extractPages({ files, adapters }, [{ route: '/', file: 'app/utility.tsx', layouts: ['app/layout.tsx'] }]);
    expect(utility).toMatchObject({ ok: false, diagnostics: [{ message: expect.stringContaining('Unresolved CSS class flex') }] });
  });

  it('styles.ignore applies to CSS @import targets', () => {
    const files = {
      'page.tsx': `import './globals.css'; export default () => <main className="m">Hi</main>`,
      'globals.css': `@import "./tailwind.css"; .m { color: blue; }`,
      'tailwind.css': `@import "tailwindcss";`,
    };
    const result = page(files, { modules: {}, styles: { ignore: ['tailwind.css'] } });
    expect(root(result).style.base).toMatchObject({ color: 'blue' });
    if (result.ok) expect(Object.values(result.dependencies)[0]).toEqual(['globals.css', 'page.tsx']);
  });

  it('changing adapters rebuilds pages', () => {
    const files = { 'page.tsx': `import Link from 'next/link'; export default () => <main><Link href="/x">Go</Link></main>` };
    const entries = [{ route: '/', file: 'page.tsx' }];
    const first = synchronizePages({ project: { files, adapters: ADAPTERS }, entries, commit: 'c1' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const same = synchronizePages({ project: { files, adapters: structuredClone(ADAPTERS) }, entries, commit: 'c2', previous: first.state });
    expect(same).toMatchObject({ ok: true, reused: ['/'], rebuilt: [] });
    const changed: Adapters = { modules: { ...ADAPTERS.modules, 'next/link': { default: { kind: 'element', tag: 'span' } } } };
    const next = synchronizePages({ project: { files, adapters: changed }, entries, commit: 'c3', previous: first.state });
    expect(next).toMatchObject({ ok: true, reused: [], rebuilt: ['/'] });
    if (next.ok) expect(el(Object.values(next.state.doc.pages)[0]!.root.children[0]).tag).toBe('span');
  });

  it('persists the adapters hash with the baseline and rejects a malformed one', () => {
    const files = { 'page.tsx': `import Link from 'next/link'; export default () => <main><Link href="/x">Go</Link></main>` };
    const entries = [{ route: '/', file: 'page.tsx' }];
    const first = synchronizePages({ project: { files, adapters: ADAPTERS }, entries, commit: 'c1' });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const stored = serializeSyncState(first.state);
    const parsed = parseSyncState(stored);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(synchronizePages({ project: { files, adapters: ADAPTERS }, entries, commit: 'c2', previous: parsed.value })).toMatchObject({ ok: true, reused: ['/'] });
    const meta = JSON.parse(stored['sync.json']!);
    meta.baseline.adaptersHash = 'not-a-hash';
    expect(parseSyncState({ ...stored, 'sync.json': JSON.stringify(meta) })).toMatchObject({ ok: false, error: 'Invalid adapters hash' });
  });
});
