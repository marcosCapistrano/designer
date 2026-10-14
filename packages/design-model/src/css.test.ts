import * as csstree from 'css-tree';
import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { validateStyle } from './css.js';
import { sampleDoc } from './fixtures.js';

describe('validateStyle', () => {
  test.each([
    ['padding', '8px'],
    ['padding', '8px 12px'],
    ['color', '#fff'],
    ['color', 'var(--color-primary)'],
    ['display', 'flex'],
    ['--brand', 'anything'],
  ])('accepts %s: %s', (prop, value) => {
    expect(validateStyle(prop, value)).toBeNull();
  });

  test('rejects unitless padding', () => {
    const reason = validateStyle('padding', '12');
    expect(reason).not.toBeNull();
    expect(reason).toContain('padding');
  });

  test('rejects bad color', () => {
    expect(validateStyle('color', 'blu')).not.toBeNull();
  });

  test('rejects unknown property', () => {
    const reason = validateStyle('colr', 'red');
    expect(reason).toContain('Unknown CSS property');
    expect(reason).toContain('colr');
  });

  test('rejects camelCase', () => {
    expect(validateStyle('backgroundColor', 'red')).not.toBeNull();
  });

  test('rejects an empty custom property value', () => {
    expect(validateStyle('--brand', '')).not.toBeNull();
  });

  test('accepts var() inside a known property value', () => {
    expect(validateStyle('padding', 'var(--gap) 12px')).toBeNull();
  });

  test('reports malformed values instead of throwing', () => {
    const reason = validateStyle('padding', '12px;}');
    expect(reason).toContain('padding');
  });

  test.each([
    ['padding', '1px}body{color:red'],
    ['padding', '1px;color:red'],
    ['color', 'red</style>'],
    ['--x', 'a</style>'],
    ['--x', 'a\\b'],
    ['padding', '1px\n2px'],
    ['color', 'var(--x)}'],
    ['--x', 'a>b'],
    ['--x', 'a\rb'],
    ['--x', 'a\fb'],
  ])('rejects a forbidden character in %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toContain('forbidden character');
  });

  test('rejects CSS comment markers in a value', () => {
    expect(validateStyle('padding', '1px /*')).toContain('forbidden character');
    expect(validateStyle('--x', 'a */ b')).toContain('forbidden character');
  });

  test.each([
    ['color', 'red !important'],
    ['--x', '1 ! IMPORTANT'],
    ['padding', '1px!important'],
    ['--x', '1 !\timportant'],
    ['--x', '"a !important"'],
  ])('rejects !important in %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toBe(`Value for ${prop} must not use !important`);
  });

  test.each([
    ['color', 'var(--a'],
    ['--x', '"abc'],
    ['--x', '\'abc'],
    ['--x', `"a'`],
    ['--x', '('],
    ['--x', '[[['],
    ['--x', ')'],
    ['--x', 'a(b]'],
    ['--x', 'var(--a))'],
  ])('rejects unbalanced brackets or quotes in %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toBe(`Value for ${prop} has unbalanced brackets or quotes`);
  });

  test.each([
    ['--x', '"a(b"'],
    ['--x', `'a"b'`],
    ['color', 'var(--a, rgb(0 0 0))'],
    ['content', '"[x]"'],
  ])('accepts balanced brackets and quotes in %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toBeNull();
  });
});

// C2 residual: a value whose url or string the CSS tokenizer cannot close swallows the rest of the stylesheet.
const BAD_URL = 'url(a "b) c")';
const BAD_URL_FUZZ = `url(#'")-')`;

describe('bad-url and bad-string tokens', () => {
  test.each([
    ['--x', BAD_URL],
    ['--x', BAD_URL_FUZZ],
    ['--x', 'url(a(b)'],
    ['--x', 'url(a"b)'],
    ['--x', "url(a'b)"],
    ['--x', 'url(a b)'],
    ['--x', 'url(a\u0001b)'],
    ['background-image', BAD_URL],
    ['background-image', `url(a "b) c") var(--x)`],
    ['--x', 'var(--y) url(a "b)'],
  ])('rejects %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).not.toBeNull();
  });

  test('rejects a url that is never closed', () => {
    expect(validateStyle('--x', 'url(a')).toBe('Value for --x has unbalanced brackets or quotes');
    expect(validateStyle('--x', 'url(')).toBe('Value for --x has unbalanced brackets or quotes');
  });

  test('reports a bad url as malformed', () => {
    expect(validateStyle('--x', BAD_URL)).toBe('Value for --x has a malformed url or string');
  });

  test.each([
    ['--x', 'url(a.png)'],
    ['--x', 'url( a.png )'],
    ['--x', 'url("a b.png")'],
    ['--x', `url('a)b.png')`],
    ['--x', 'url("a") url(\'b\')'.replace(/\\'/g, "'")],
    ['background-image', 'url(a.png)'],
    ['--x', '"a)" ")"'],
    ['--x', 'f(g([h]))'],
  ])('still accepts %s: %j', (prop, value) => {
    expect(validateStyle(prop, value)).toBeNull();
  });

  test('setStyle refuses the bad url', () => {
    const doc = sampleDoc();
    const bad = applyOp(doc, { op: 'setStyle', node: 'n2', device: 'base', prop: '--x', value: BAD_URL });
    expect(bad.ok).toBe(false);
    const fuzz = applyOp(doc, { op: 'setStyle', node: 'n2', device: 'base', prop: '--x', value: BAD_URL_FUZZ });
    expect(fuzz.ok).toBe(false);
  });

  test('setToken refuses the bad url', () => {
    const doc = sampleDoc();
    for (const value of [BAD_URL, BAD_URL_FUZZ]) {
      const result = applyOp(doc, { op: 'setToken', group: 'color', name: 'x', value });
      expect(result.ok).toBe(false);
    }
  });
});

function rulesIn(css: string): number {
  let count = 0;
  csstree.walk(csstree.parse(css), {
    visit: 'Rule',
    enter() {
      count += 1;
    },
  });
  return count;
}

// A seeded PRNG, so a failure reproduces.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'url(', 'URL(', 'var(', 'f(', '(', ')', '[', ']', '"', "'", ' ', ' ', 'a', 'b', 'c', '-', '--x', '#', '!', ',',
  '/', '*', ':', '@', '.', '1', '2px', 'url(a)', 'url("a")', "url('a')", '"a"', "'a'", ')"', '")', "')", '"b)',
  '!important', 'important', '&', '%', '=', '\u0001',
];

describe('accepted values never break the stylesheet', () => {
  test('2000 accepted custom property values leave exactly 2 rules', () => {
    const random = mulberry32(0xc55);
    const accepted: string[] = [];
    for (let attempts = 0; accepted.length < 2000 && attempts < 400_000; attempts++) {
      const parts = Array.from({ length: 1 + Math.floor(random() * 9) }, () => {
        return FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
      });
      const value = parts.join('');
      if (validateStyle('--x', value) === null) accepted.push(value);
    }
    expect(accepted.length).toBe(2000);
    // The generator must reach the interesting inputs, or the property proves little.
    expect(accepted.some((v) => v.includes('url(') && v.includes('"'))).toBe(true);
    expect(accepted.some((v) => v.includes("'"))).toBe(true);

    for (const value of accepted) {
      expect(rulesIn(`a{--x:${value};}b{c:d}`), JSON.stringify(value)).toBe(2);
      const sheet = csstree.parse(`a{--x:${value};}b{c:d}`) as csstree.StyleSheet;
      expect(sheet.children.size, JSON.stringify(value)).toBe(2);
    }
  });
});
