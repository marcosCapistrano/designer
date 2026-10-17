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
    '@media (hover: none) { .a { color: blue } }',
    '.a:focus-visible { color: blue }',
    '.b::placeholder { color: blue }',
    '.a::selection { color: blue }',
  ])('%s is source-only', (text) => {
    const parsed = parse(`.a { color: red } .b {} ${text}`);
    expect(parsed.sourceOnly).toBe(1);
    expect(style(`.a { color: red } .b {} ${text}`)).toEqual({ base: { color: 'red' } });
  });

  it('evaluates (hover: hover) as true and (hover: none) as false for every frame, the renderer being desktop Chromium (Ruling Q)', () => {
    expect(style('@media (hover: hover) { .a { color: blue } }')).toEqual({ base: { color: 'blue' } });
    expect(style('@media (max-width: 1023px) { @media (hover: hover) { .a { color: blue } } }')).toEqual({ base: {}, tablet: { color: 'blue' }, mobile: { color: 'blue' } });
    expect(style('@media (hover: hover) and (max-width: 599px) { .a { color: blue } }')).toEqual({ base: {}, tablet: {}, mobile: { color: 'blue' } });
    const mixed = parse('.a { color: red } @media (hover: hover) { .a:hover { color: blue } .a { padding: 1px } } @media (hover: none) { .a:active { color: green } .a { margin: 0 } }');
    expect(mixed.sourceOnly).toBe(3);
    const node = el('p', 'a');
    applyStyles(node, mixed.rules, new Map());
    expect(node.style).toEqual({ base: { color: 'red', padding: '1px' } });
  });

  it('applies statically decidable states at rest and fails on resting-visible pseudo-elements of matched elements (Ruling Q)', () => {
    const input = (attrs: Record<string, string>): ElementNode => ({ ...el('input', 'f'), attrs: { class: 'f', ...attrs } });
    const css = '.f { color: black } .f:placeholder-shown { color: gray } .f:disabled { opacity: 0.5 } .f:hover { color: red }';
    const shown = input({ placeholder: 'Search' });
    applyStyles(shown, parse(css).rules, new Map());
    expect(shown.style.base).toEqual({ color: 'gray' });
    const filled = input({ placeholder: 'Search', value: 'x' });
    applyStyles(filled, parse(css).rules, new Map());
    expect(filled.style.base).toEqual({ color: 'black' });
    const button: ElementNode = { ...el('button', 'f'), attrs: { class: 'f', disabled: '' } };
    applyStyles(button, parse(css).rules, new Map());
    expect(button.style.base).toEqual({ color: 'black', opacity: '0.5' });
    for (const pseudo of ['placeholder', 'first-line', 'first-letter', 'marker']) {
      const error = (() => { try { applyStyles(input({ placeholder: 'Search' }), parse(`.f::${pseudo} { color: gray }`).rules, new Map()); } catch (caught) { return caught; } })();
      expect(error).toBeInstanceOf(CssError);
      expect(error).toMatchObject({ file: 'app/globals.css', message: `Unsupported CSS pseudo-element ::${pseudo} in .f::${pseudo}: it renders at rest on a matched element` });
    }
    expect(() => applyStyles(input({ type: 'file' }), parse('.f::file-selector-button { color: gray }').rules, new Map())).toThrow('Unsupported CSS pseudo-element ::file-selector-button');
    // Unknown and legacy pseudo-elements fail closed; only known non-resting ones stay source-only (M2).
    expect(() => applyStyles(input({ placeholder: 'Search' }), parse('.f::-webkit-input-placeholder { color: gray }').rules, new Map())).toThrow('Unsupported CSS pseudo-element ::-webkit-input-placeholder');
    expect(() => applyStyles(input({ type: 'file' }), parse('.f::-webkit-file-upload-button { color: gray }').rules, new Map())).toThrow('Unsupported CSS pseudo-element ::-webkit-file-upload-button');
    expect(() => applyStyles(el('summary', 'f'), parse('.f::-webkit-details-marker { display: none }').rules, new Map())).toThrow('Unsupported CSS pseudo-element ::-webkit-details-marker');
    const scrolled = el('div', 'f');
    const quiet = parse('.f { color: black } .f::-webkit-scrollbar { display: none } .f::-webkit-scrollbar-thumb { color: red } .f::selection { color: red } .f::-webkit-input-placeholder { color: red }');
    applyStyles(scrolled, quiet.rules, new Map());
    expect([quiet.sourceOnly, scrolled.style.base]).toEqual([4, { color: 'black' }]);
    const plain = input({});
    applyStyles(plain, parse('.f { color: black } .f::placeholder { color: gray } ::file-selector-button { color: red }').rules, new Map());
    expect(plain.style.base).toEqual({ color: 'black' });
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

  it('keeps animation longhands after the shorthand, and drops longhands a later shorthand resets', () => {
    expect(style('.a { animation: var(--animate-spin); animation-duration: 2s }').base).toEqual({ animation: 'var(--animate-spin)', 'animation-duration': '2s' });
    expect(style('.a { animation: var(--animate-spin) } p.a { animation-duration: 2s }').base).toEqual({ animation: 'var(--animate-spin)', 'animation-duration': '2s' });
    expect(style('.a { animation-duration: 2s; animation: var(--animate-spin) }').base).toEqual({ animation: 'var(--animate-spin)' });
    expect(style('.a { animation-duration: 2s } p.a { animation: var(--animate-spin) }').base).toEqual({ animation: 'var(--animate-spin)' });
  });

  // The design model sorts declarations on export, so every pair where one property resets the other must cascade in sorted order.
  it.each([
    ['.a { gap: 8px; column-gap: 16px }', 'gap before column-gap'],
    ['.a { border-top: 1px solid; border-color: red }', 'border-top before border-color'],
    ['.a { place-items: center; align-items: start }', 'place-items before align-items'],
    ['.a { place-content: center; justify-content: start }', 'place-content before justify-content'],
    ['.a { place-self: center; align-self: start }', 'place-self before align-self'],
    ['.a { flex-flow: row wrap; flex-direction: column }', 'flex-flow before flex-direction'],
    ['.a { inset: 0; bottom: 4px }', 'inset before bottom'],
    ['.a { all: unset; align-items: center }', 'all before align-items'],
    ['.a { white-space: nowrap; text-wrap: balance }', 'white-space before text-wrap'],
    ['.a { padding-right: 2px; padding-inline-start: 4px }', 'padding-right before padding-inline-start'],
    ['.a { margin-inline-start: 1px; margin-inline-end: 2px }', 'margin-inline-start before margin-inline-end'],
    ['.a { word-wrap: break-word } .a { overflow-wrap: normal } p.a { padding-inline: 1px; padding-left: 2px; padding-inline-start: 3px }', 'padding-left before padding-inline-start'],
  ])('rejects %s, whose sorted export would change the result', (text, order) => {
    expect(() => style(text)).toThrow(`Unsupported CSS declaration order: ${order} in `);
  });

  // A declaration whose every longhand a later declaration resets has no effect, so it is dropped and cannot misorder.
  it.each([
    ['.a { border-image: url(x.png) 30; border: 0 }', { border: '0' }],
    ['.a { margin-left: 2px; margin: 4px }', { margin: '4px' }],
    ['.a { padding-left: 2px; padding-inline: 4px }', { 'padding-inline': '4px' }],
    ['.a { width: 10px } p.a { inline-size: 20px }', { 'inline-size': '20px' }],
    ['.a { height: 10px; block-size: 20px }', { 'block-size': '20px' }],
    ['.a { max-height: 10px; max-block-size: 20px }', { 'max-block-size': '20px' }],
    ['.a { min-width: 10px; min-inline-size: 20px }', { 'min-inline-size': '20px' }],
    ['.a { word-wrap: break-word; overflow-wrap: normal }', { 'overflow-wrap': 'normal' }],
    ['.a { mask-image: none; -webkit-mask-image: url(x.png) }', { '-webkit-mask-image': 'url(x.png)' }],
    ['.a { appearance: none; -webkit-appearance: auto }', { '-webkit-appearance': 'auto' }],
    ['.a { font-synthesis-weight: none; font-synthesis: style }', { 'font-synthesis': 'style' }],
    ['.a { page-break-before: always; break-before: auto }', { 'break-before': 'auto' }],
    ['.a { gap: 16px } .a { row-gap: 0 } p.a { gap: 0 }', { gap: '0' }],
    ['.a { color: red; all: unset }', { all: 'unset' }],
    ['.a { padding-right: 1px; padding-inline: 2px }', { 'padding-inline': '2px' }],
  ])('drops the reset declaration in %s', (text, base) => {
    expect(style(text).base).toEqual(base);
  });

  it.each([
    ['.a { border-radius: 4px; border: 1px solid }', { border: '1px solid', 'border-radius': '4px' }],
    ['.a { outline-offset: 2px; outline: 1px solid }', { outline: '1px solid', 'outline-offset': '2px' }],
    ['.a { overflow-wrap: anywhere; overflow: hidden }', { overflow: 'hidden', 'overflow-wrap': 'anywhere' }],
    ['.a { flex-direction: column; flex: 1 }', { flex: '1', 'flex-direction': 'column' }],
    ['.a { grid-column: 1 / 3; grid: auto / 1fr }', { grid: 'auto / 1fr', 'grid-column': '1 / 3' }],
    ['.a { border: 1px solid; border-color: red }', { border: '1px solid', 'border-color': 'red' }],
    ['.a { all: unset; color: red }', { all: 'unset', color: 'red' }],
    ['.a { margin: 4px; margin-left: 2px }', { margin: '4px', 'margin-left': '2px' }],
    ['.a { column-gap: 16px; gap: 8px }', { gap: '8px' }],
    ['.a { inset: 0; left: 4px }', { inset: '0', left: '4px' }],
    ['.a { -webkit-appearance: none; appearance: none }', { appearance: 'none' }],
    ['.a { inline-size: 100%; block-size: auto; max-inline-size: 100% }', { 'inline-size': '100%', 'block-size': 'auto', 'max-inline-size': '100%' }],
    ['.a { width: 10px; height: 20px }', { width: '10px', height: '20px' }],
  ])('accepts %s, unrelated or in sorted order', (text, base) => {
    expect(style(text).base).toEqual(base);
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

  it('fails on a vertical writing-mode, which the logical property mapping assumes horizontal', () => {
    expect(() => style('.a { writing-mode: vertical-rl }')).toThrow('Unsupported CSS writing-mode vertical-rl in .a');
    expect(style('.a { writing-mode: horizontal-tb }').base).toEqual({ 'writing-mode': 'horizontal-tb' });
  });

  // R2-I1: only Chromium's real aliases share a property; a distinct or prefixed-only -webkit- property is kept.
  it('keeps -webkit- properties that Chromium does not alias to the standard name', () => {
    expect(style('.a { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden }').base)
      .toEqual({ display: '-webkit-box', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': '2', 'line-clamp': '2', overflow: 'hidden' });
    expect(style('.a { -webkit-border-image: url(a.png) 30; border-image: url(b.png) 30; -webkit-box-decoration-break: clone; box-decoration-break: slice }').base)
      .toEqual({ '-webkit-border-image': 'url(a.png) 30', 'border-image': 'url(b.png) 30', '-webkit-box-decoration-break': 'clone', 'box-decoration-break': 'slice' });
    expect(style('.a { -webkit-text-stroke: 1px red; text-stroke: 2px blue }').base).toEqual({ '-webkit-text-stroke': '1px red', 'text-stroke': '2px blue' });
    expect(style('.a { -webkit-user-select: none; user-select: text }').base).toEqual({ 'user-select': 'text' });
    expect(() => style('.a { -webkit-writing-mode: vertical-rl }')).toThrow('Unsupported CSS writing-mode vertical-rl in .a');
  });

  it('rejects !important in inline styles, as in stylesheets (R2-M2)', () => {
    const node = el('p', 'a');
    expect(() => applyStyles(node, parse('.a { color: red }').rules, new Map([[node.id, { 'margin-left': '2px !important', margin: '4px' }]]))).toThrow('Unsupported inline style margin-left: !important');
  });

  it('keeps vendor and transition-only pseudo-elements source-only (R2-M3)', () => {
    const parsed = parse('.a { color: red } .a::-moz-selection { color: blue } .a::-ms-clear { display: none } ::view-transition-old(root) { opacity: 0 } ::view-transition { color: red } .a::highlight(x) { color: red }');
    applyStyles(el('p', 'a'), parsed.rules, new Map());
    expect(parsed.sourceOnly).toBe(5);
  });
});
