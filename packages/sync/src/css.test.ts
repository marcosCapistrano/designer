import { describe, expect, it } from 'vitest';
import type { ElementNode } from '@hub/design-model';
import { applyStyles, cascadeTokens, CssError, parseStyles, type Rule } from './css.js';
import { parseSelector } from './selectors.js';

const el = (tag: string, cls = '', children: ElementNode[] = []): ElementNode => ({ id: `n${Math.random().toString(16).slice(2)}`, kind: 'element', tag, attrs: cls ? { class: cls } : {}, style: { base: {} }, children });
const parse = (text: string, files: Record<string, string> = {}, scope: string | null = null) => parseStyles(text, scope, {
  file: 'app/globals.css',
  resolveImport(spec) { const file = `app/${spec.replace(/^\.\//, '')}`; const found = files[file]; if (found === undefined) throw new Error(`Missing ${file}`); return { file, text: found }; },
});
function style(text: string, node = el('p', 'a'), files: Record<string, string> = {}) {
  applyStyles(node, parse(text, files).rules, new Map());
  return node.style;
}

describe('stylesheet parsing', () => {
  it('inlines relative @import in place', () => {
    const { rules } = parse('@layer reset, base; @import "./a.css"; .a { padding: 1px }', { 'app/a.css': '@import "./b.css"; .a { color: red }', 'app/b.css': '.a { margin: 0 }' });
    expect(rules.map((rule) => rule.declarations)).toEqual([{ margin: '0' }, { color: 'red' }, { padding: '1px' }]);
    expect(style('@import "./a.css"; .a { padding: 1px }', el('p', 'a'), { 'app/a.css': '.a { color: blue }' }).base).toEqual({ color: 'blue', padding: '1px' });
  });

  it('rejects bare package imports and import cycles', () => {
    expect(() => parse('@import "tailwindcss";')).toThrow('Unsupported CSS package import tailwindcss');
    expect(() => parse('@import "./a.css";', { 'app/a.css': '@import "./a.css";' })).toThrow('Cyclic CSS @import');
    expect(() => parse('.a { color: red } @import "./a.css";', { 'app/a.css': '' })).toThrow('Unsupported CSS @import after other rules');
  });

  it('orders cascade layers before specificity, unlayered last (R4)', () => {
    expect(style('@layer utilities { .a { color: red } } .a { color: blue }').base).toEqual({ color: 'blue' });
    expect(style('.a { color: blue } @layer utilities { .a { color: red } }').base).toEqual({ color: 'blue' });
    expect(style('@layer base { p.a { color: blue } } @layer utilities { .a { color: red } }').base).toEqual({ color: 'red' });
    expect(parse('@layer reset, theme, utilities; @layer theme { .a { color: red } }').rules[0]!.layer).toBe(1);
    expect(() => parse('@layer vendor { .a { color: red } }')).toThrow('Unsupported CSS layer vendor');
    expect(() => parse('@layer utilities, base;')).toThrow('Unsupported CSS layer order: utilities, base');
    expect(() => parse('@layer utilities { .a { color: red } } @layer base { p.a { color: blue } }')).toThrow('Unsupported CSS layer order: utilities, base');
    expect(() => parse('@layer reset, base, utilities; @layer theme { .a { color: red } }')).toThrow('Unsupported CSS layer order: reset, base, utilities, theme');
    expect(() => parse('@layer base { @layer utilities { .a { color: red } } }')).toThrow('Unsupported CSS nested @layer');
  });

  it('tracks layer first appearance across every stylesheet of a page', () => {
    const layers: string[] = [];
    const resolveImport = () => { throw new Error('none'); };
    parseStyles('@layer utilities { .a { color: red } }', null, { file: 'a.css', resolveImport, layers });
    expect(() => parseStyles('@layer base { .a { color: blue } }', null, { file: 'b.css', resolveImport, layers })).toThrow('Unsupported CSS layer order: utilities, base');
  });

  it('treats ::before/::after without content as source-only', () => {
    const parsed = parse('*, *::before, *::after { box-sizing: border-box }');
    expect(parsed.sourceOnly).toBe(2);
    const child = el('p');
    const root = el('main', '', [child]);
    applyStyles(root, parsed.rules, new Map());
    expect([root.style.base, child.style.base]).toEqual([{ 'box-sizing': 'border-box' }, { 'box-sizing': 'border-box' }]);
  });

  it('hover rule is source-only', () => {
    const parsed = parse('.a { color: red } @media (hover: hover) { .a:hover { color: blue } }');
    expect(parsed.sourceOnly).toBe(1);
    const node = el('p', 'a');
    applyStyles(node, parsed.rules, new Map());
    expect(node.style).toEqual({ base: { color: 'red' } });
  });

  it.each([
    '@media (min-width: 1536px) { .a { color: blue } }',
    '@media print { .a { color: blue } }',
    '@media (prefers-reduced-motion: reduce) { .a { color: blue } }',
    '@media (hover: none) and (max-width: 1023px) { .a { color: blue } }',
    '@media (max-width: 1023px) { @media (hover: hover) { .a { color: blue } } }',
    '.a:focus-visible { color: blue }',
    '.a::placeholder { color: blue }',
  ])('%s is source-only', (text) => {
    const parsed = parse(`.a { color: red } ${text}`);
    expect(parsed.sourceOnly).toBe(1);
    expect(style(`.a { color: red } ${text}`)).toEqual({ base: { color: 'red' } });
  });

  it('keeps device media and a class used only in source-only rules resolves', () => {
    expect(style('@media (max-width: 1023px) { .a { color: blue } } @media (max-width: 599px) { .a { color: green } }')).toEqual({ base: {}, tablet: { color: 'blue' }, mobile: { color: 'green' } });
    expect(style('.a:hover { color: blue }', el('p', 'a'))).toEqual({ base: {} });
    expect(() => style('.a:hover { color: blue }', el('p', 'b'))).toThrow('Unresolved CSS class b');
  });

  it('reads dashed :root custom properties as tokens split at the first dash, other :root properties as root rules (Ruling D)', () => {
    const parsed = parse(':root { --space-4: 1rem; --gap: 3px; color: red } @layer theme { :root { --space-0_5: 2px; --ember-text-primary: #fff; --text-xs-leading: 1.5 } }');
    expect(cascadeTokens(parsed.tokens)).toEqual({ space: { '4': '1rem', '0_5': '2px' }, ember: { 'text-primary': '#fff' }, text: { 'xs-leading': '1.5' } });
    const root = el('main', '', [el('p')]);
    applyStyles(root, parsed.rules, new Map());
    expect(root.style.base).toEqual({ color: 'red', '--gap': '3px' });
    expect((root.children[0] as ElementNode).style.base).toEqual({});
  });

  it('keeps custom properties outside a resting base :root as declarations', () => {
    const parsed = parse('.dark { --ember-bg: #000 } html { --space-9: 1px } @media (max-width: 1023px) { :root { --space-4: 2rem } }');
    expect(parsed.tokens).toEqual([]);
    const root = el('html', 'dark');
    applyStyles(root, parsed.rules, new Map());
    expect(root.style).toEqual({ base: { '--ember-bg': '#000', '--space-9': '1px' }, tablet: { '--ember-bg': '#000', '--space-9': '1px', '--space-4': '2rem' }, mobile: { '--ember-bg': '#000', '--space-9': '1px', '--space-4': '2rem' } });
  });

  it('cascades a token defined twice: layer order first, then source order', () => {
    const tokens = (text: string) => cascadeTokens(parse(text).tokens);
    expect(tokens(':root { --space-4: 1rem } :root { --space-4: 2rem }')).toEqual({ space: { '4': '2rem' } });
    expect(tokens(':root { --space-4: 1rem } @layer theme { :root { --space-4: 2rem } }')).toEqual({ space: { '4': '1rem' } });
    expect(tokens('@layer reset, theme; @layer theme { :root { --space-4: 2rem } } @layer reset { :root { --space-4: 1rem } }')).toEqual({ space: { '4': '2rem' } });
    expect(cascadeTokens([...parse(':root { --space-4: 1rem }').tokens, ...parseStyles('@layer theme { :root { --space-4: 2rem } }', null, { file: 'b.css', resolveImport: () => { throw new Error('none'); } }).tokens])).toEqual({ space: { '4': '1rem' } });
  });

  it.each(['--Space-4', '--space-Big', '--space--x', '--space-', '--sp_ace-4'])('rejects the unrepresentable token name %s', (name) => {
    expect(() => parse(`:root { ${name}: 1px }`)).toThrow(`Unsupported CSS token name ${name}`);
  });

  it('treats @keyframes and @property as source-only (Ruling E)', () => {
    const parsed = parse('@property --enter-opacity { syntax: "*"; inherits: false; } @keyframes spin { to { transform: rotate(360deg) } } @layer utilities { @keyframes ping { 75%, 100% { opacity: 0 } } } .a { animation: var(--animate-spin) }');
    expect(parsed.sourceOnly).toBe(3);
    expect(parsed.rules).toHaveLength(1);
  });

  it('keeps animation longhands after the shorthand, and still rejects a shorthand that resets earlier longhands', () => {
    expect(style('.a { animation: var(--animate-spin); animation-duration: 2s }').base).toEqual({ animation: 'var(--animate-spin)', 'animation-duration': '2s' });
    expect(style('.a { animation: var(--animate-spin) } p.a { animation-duration: 2s }').base).toEqual({ animation: 'var(--animate-spin)', 'animation-duration': '2s' });
    expect(() => style('.a { animation-duration: 2s; animation: var(--animate-spin) }')).toThrow('Unsupported CSS mixed shorthand and longhand: animation');
    expect(() => style('.a { animation-duration: 2s } p.a { animation: var(--animate-spin) }')).toThrow('Unsupported CSS mixed shorthand and longhand: animation');
    expect(() => style('.a { all: unset; color: red }')).toThrow('Unsupported CSS mixed shorthand and longhand: all');
  });

  it('matches structural selectors against the source tree', () => {
    const items = [el('li'), el('li'), el('li')];
    const root = el('ul', 'list', items);
    applyStyles(root, parse('.list > :not(:last-child) { margin-bottom: 4px } :where(.list) li { color: red } li:first-child { color: blue } [data-x] { color: green }').rules, new Map());
    expect(items.map((item) => item.style.base)).toEqual([{ color: 'blue', 'margin-bottom': '4px' }, { color: 'red', 'margin-bottom': '4px' }, { color: 'red' }]);
    expect(root.attrs['class']).toBeUndefined();
  });

  it('scopes CSS Module classes inside :where/:is/:not', () => {
    const { rules } = parse(':where(.a) .b:not(.c), .d:is(.e) {}', {}, 'cX');
    const node = el('p', 'cX__b', []);
    applyStyles(el('div', 'cX__a cX__d', [node]), rules, new Map());
    expect(() => applyStyles(el('p', 'b'), rules, new Map())).toThrow('Unresolved CSS class b');
    expect(() => parseStyles('@import "./x.css";', 'cX', { file: 'a.module.css', resolveImport: () => ({ file: 'x.css', text: '' }) })).toThrow('Unsupported CSS @import in a CSS Module');
  });

  it('attributes matching errors to the rule file and selector', () => {
    const rule: Rule = { selector: parseSelector('p:nth-child(2)'), text: 'p:nth-child(2)', file: 'x.css', device: 'base', layer: 5, declarations: {}, specificity: [0, 1, 1], sourceOnly: false };
    const error = (() => { try { applyStyles(el('p'), [rule], new Map()); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(CssError);
    expect(error).toMatchObject({ file: 'x.css', message: 'Unsupported CSS selector :nth-child in p:nth-child(2)' });
  });

  it.each([
    ['.a::before { content: "x" }', 'Unsupported CSS pseudo-element ::before with content'],
    ['.a + .b { color: red }', 'Unsupported CSS combinator +'],
    ['.a:nth-child(2) { color: red }', 'Unsupported CSS selector :nth-child'],
    ['.a:not(:hover) { color: red }', 'Unsupported CSS selector :not() with a state pseudo-class'],
    ['@media screen and (max-width: 1023px) { .a { color: red } }', 'Unsupported CSS at-rule @media'],
    ['@font-face { font-family: X; src: url(x.woff2) }', 'Unsupported CSS at-rule @font-face'],
    ['@-webkit-keyframes spin { from { color: red } }', 'Unsupported CSS at-rule @-webkit-keyframes'],
  ])('rejects %s', (text, message) => {
    expect(() => parse(text)).toThrow(message);
  });
});
