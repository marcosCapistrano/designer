import { describe, expect, it } from 'vitest';
import { isSourceOnly, matchSelector, parseSelector, specificity, type TreeNode } from './selectors.js';

function tree(tag: string, attrs: Record<string, string>, parent: TreeNode | null = null, index = 0, siblings = 1): TreeNode {
  return { tag, attrs, parent, index, siblings };
}

describe('selectors', () => {
  it(':where(.a > :not(:last-child)) matches the first of two children of .a with zero specificity', () => {
    const parent = tree('div', { class: 'a' });
    const selector = parseSelector(':where(.a > :not(:last-child))');
    expect(matchSelector(tree('p', {}, parent, 0, 2), selector)).toBe(true);
    expect(matchSelector(tree('p', {}, parent, 1, 2), selector)).toBe(false);
    expect(matchSelector(tree('p', {}, tree('div', { class: 'b' }), 0, 2), selector)).toBe(false);
    expect(specificity(selector)).toEqual([0, 0, 0]);
  });

  it('.card:hover .t is source-only', () => {
    expect(isSourceOnly(parseSelector('.card:hover .t'))).toBe(true);
    expect(isSourceOnly(parseSelector('.t:is(:where(.card):hover *)'))).toBe(true);
    expect(isSourceOnly(parseSelector('.card .t'))).toBe(false);
  });

  it('[data-state="open"] matches a static attribute', () => {
    const selector = parseSelector('[data-state="open"]');
    expect(matchSelector(tree('div', { 'data-state': 'open' }), selector)).toBe(true);
    expect(matchSelector(tree('div', { 'data-state': 'closed' }), selector)).toBe(false);
    expect(matchSelector(tree('div', {}), selector)).toBe(false);
    expect(matchSelector(tree('div', {}), parseSelector('[constructor]'))).toBe(false);
  });

  it('.a .b does not match a .b outside .a', () => {
    const selector = parseSelector('.a .b');
    const outer = tree('section', { class: 'a' });
    expect(matchSelector(tree('p', { class: 'b' }, tree('div', {}, outer)), selector)).toBe(true);
    expect(matchSelector(tree('p', { class: 'b' }, tree('div', { class: 'c' }, tree('main', {}))), selector)).toBe(false);
  });

  it('computes Selectors Level 4 specificity', () => {
    expect(specificity(parseSelector('#x .a:is(.b, p#y) > li[href]::placeholder'))).toEqual([2, 2, 3]);
    expect(specificity(parseSelector('.x.x:hover'))).toEqual([0, 3, 0]);
    expect(specificity(parseSelector('*:not(.a, .b)'))).toEqual([0, 1, 0]);
  });

  it('matches :root only at the tree root', () => {
    const selector = parseSelector(':root');
    const root = tree('main', {});
    expect(matchSelector(root, selector)).toBe(true);
    expect(matchSelector(tree('p', {}, root), selector)).toBe(false);
  });
});
