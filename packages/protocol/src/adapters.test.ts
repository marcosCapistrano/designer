import { expect, test } from 'vitest';
import { adaptersProblem, parseAdapters } from './adapters.js';

const EXAMPLE = {
  modules: {
    'next/link': { default: { kind: 'element', tag: 'a', attrs: { href: 'href' } } },
    'next/image': { default: { kind: 'element', tag: 'img', attrs: { src: 'src', alt: 'alt' } } },
    react: { Suspense: { kind: 'children' } },
    'lucide-react': { '*': { kind: 'element', tag: 'svg' } },
    '@radix-ui/react-select': { Trigger: { kind: 'element', tag: 'button', attrs: { 'aria-label': 'aria-label' } }, Portal: { kind: 'omit' } },
  },
  styles: { ignore: ['site/src/app/tailwind.css'] },
};

test('accepts the documented adapters file', () => {
  const result = parseAdapters(JSON.stringify(EXAMPLE));
  expect(result).toEqual({ ok: true, adapters: EXAMPLE });
});

test('accepts modules without styles', () => {
  expect(parseAdapters('{"modules":{}}')).toEqual({ ok: true, adapters: { modules: {} } });
});

test('rejects invalid JSON', () => {
  expect(parseAdapters('{')).toEqual({ ok: false, error: '.hub/adapters.json is not valid JSON' });
});

test('rejects unknown keys at every level', () => {
  for (const doc of [
    { ...EXAMPLE, extra: true },
    { modules: { react: { Suspense: { kind: 'children', fallback: 'x' } } } },
    { modules: { react: { Suspense: { kind: 'element', tag: 'a', html: '<b>' } } } },
    { modules: {}, styles: { ignore: [], extra: 1 } },
    { modules: { react: { Suspense: { kind: 'source', file: 'x.tsx' } } } },
  ]) expect(parseAdapters(JSON.stringify(doc)).ok, JSON.stringify(doc)).toBe(false);
});

test('rejects reserved keys', () => {
  for (const text of [
    '{"modules":{"__proto__":{"*":{"kind":"omit"}}}}',
    '{"modules":{"react":{"constructor":{"kind":"omit"}}}}',
    '{"modules":{"react":{"prototype":{"kind":"omit"}}}}',
    '{"modules":{"next/link":{"default":{"kind":"element","tag":"a","attrs":{"__proto__":"href"}}}}}',
  ]) {
    const result = parseAdapters(text);
    expect(result.ok, text).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved/i);
  }
});

test('rejects relative or aliased specifiers, bad tags, bad attribute mappings and bad ignore paths', () => {
  for (const doc of [
    { modules: { './local': { '*': { kind: 'omit' } } } },
    { modules: { '@/components/X': { '*': { kind: 'omit' } } } },
    { modules: { react: {} } },
    { modules: { react: { 'not-an-export': { kind: 'omit' } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'A' } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { onClick: 'onclick' } } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { className: 'class' } } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { css: 'style' } } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { tone: 'className' } } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { tone: 'children' } } } } },
    { modules: { 'next/link': { default: { kind: 'element', tag: 'a', attrs: { href: 'href', to: 'href' } } } } },
    { modules: {}, styles: { ignore: ['../tailwind.css'] } },
    { modules: {}, styles: { ignore: ['/abs/tailwind.css'] } },
    { modules: {}, styles: { ignore: ['app/tailwind.ts'] } },
  ]) expect(parseAdapters(JSON.stringify(doc)).ok, JSON.stringify(doc)).toBe(false);
});

test('bounds adapters to 500 entries and 64 KB', () => {
  const modules = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`pkg-${i}`, { '*': { kind: 'omit' } }]));
  expect(parseAdapters(JSON.stringify({ modules: modules(500) })).ok).toBe(true);
  const tooMany = parseAdapters(JSON.stringify({ modules: modules(501) }));
  expect(tooMany).toEqual({ ok: false, error: 'At most 500 adapters are supported' });
  const big = { modules: { react: { Suspense: { kind: 'children' } } }, styles: { ignore: Array.from({ length: 400 }, (_, i) => `app/${'x'.repeat(200)}-${i}.css`) } };
  expect(parseAdapters(JSON.stringify(big))).toEqual({ ok: false, error: '.hub/adapters.json exceeds 64 KB' });
  expect(adaptersProblem(big)).toBe('.hub/adapters.json exceeds 64 KB');
});
