import * as css from 'css-tree';

/** One complex selector from css-tree. Structural matching only; state is resolved before matching (R2, R3). */
export type SelectorAst = css.Selector;
export interface TreeNode { tag: string; attrs: Record<string, string>; parent: TreeNode | null; index: number; siblings: number }
type Specificity = [number, number, number];

const STATE = /^(?:hover|focus.*|active|disabled|checked|placeholder-shown)$/;
const LOGICAL = new Set(['is', 'where', 'not']);
const STRUCTURAL = new Set(['first-child', 'last-child', 'root']);

export function parseSelector(text: string): SelectorAst {
  const list = css.parse(text, { context: 'selectorList' });
  const first = list.type === 'SelectorList' ? list.children.first : null;
  if (!first || first.type !== 'Selector' || list.type !== 'SelectorList' || list.children.size !== 1) throw new Error(`Unsupported CSS selector ${text}`);
  return first;
}

function args(node: css.PseudoClassSelector): SelectorAst[] {
  const list = node.children?.first;
  if (!list || list.type !== 'SelectorList') throw new Error(`Unsupported CSS selector :${node.name}()`);
  return list.children.toArray().map((item) => { if (item.type !== 'Selector') throw new Error(`Unsupported CSS selector :${node.name}()`); return item; });
}

/**
 * Validates a selector and reports whether it can only match in a non-resting state (R2).
 * `::before`/`::after` render nothing without `content`, so they are source-only unless the rule sets it.
 */
export function isSourceOnly(selector: SelectorAst, content = true): boolean {
  let state = false;
  selector.children.forEach((part) => {
    if (part.type === 'Combinator') { if (part.name !== ' ' && part.name !== '>') throw new Error(`Unsupported CSS combinator ${part.name}`); }
    else if (part.type === 'PseudoElementSelector') {
      if ((part.name === 'before' || part.name === 'after') && content) throw new Error(`Unsupported CSS pseudo-element ::${part.name} with content`);
      state = true;
    } else if (part.type === 'PseudoClassSelector') {
      if (STATE.test(part.name) && !part.children) state = true;
      else if (LOGICAL.has(part.name)) {
        const inner = args(part).map((item) => isSourceOnly(item));
        if (part.name === 'not') { if (inner.some(Boolean)) throw new Error('Unsupported CSS selector :not() with a state pseudo-class'); }
        else if (inner.every(Boolean)) state = true;
        else if (inner.some(Boolean)) throw new Error(`Unsupported CSS selector :${part.name}() mixing resting and state alternatives`);
      } else if (!STRUCTURAL.has(part.name) || part.children) throw new Error(`Unsupported CSS selector :${part.name}`);
    } else if (part.type === 'AttributeSelector') {
      if (part.flags || part.name.name.includes('|')) throw new Error(`Unsupported CSS attribute selector ${css.generate(part)}`);
    } else if (part.type === 'TypeSelector') { if (part.name.includes('|')) throw new Error(`Unsupported CSS selector ${part.name}`); }
    else if (part.type !== 'ClassSelector' && part.type !== 'IdSelector') throw new Error(`Unsupported CSS selector ${css.generate(part)}`);
  });
  return state;
}

export function specificity(selector: SelectorAst): Specificity {
  const result: Specificity = [0, 0, 0];
  selector.children.forEach((part) => {
    if (part.type === 'IdSelector') result[0]++;
    else if (part.type === 'ClassSelector' || part.type === 'AttributeSelector') result[1]++;
    else if (part.type === 'TypeSelector') { if (part.name !== '*') result[2]++; }
    else if (part.type === 'PseudoElementSelector') result[2]++;
    else if (part.type === 'PseudoClassSelector') {
      if (part.name === 'where') return;
      if (!LOGICAL.has(part.name)) { result[1]++; return; }
      const max = args(part).map(specificity).reduce((a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0 ? a : b);
      for (let i = 0; i < 3; i++) result[i]! += max[i]!;
    }
  });
  return result;
}

function attribute(node: TreeNode, part: css.AttributeSelector): boolean {
  if (!Object.hasOwn(node.attrs, part.name.name)) return false;
  const actual = node.attrs[part.name.name]!;
  if (!part.matcher) return true;
  const expected = part.value ? (part.value.type === 'String' ? part.value.value : part.value.name) : '';
  switch (part.matcher) {
    case '=': return actual === expected;
    case '~=': return actual.split(/\s+/).includes(expected);
    case '|=': return actual === expected || actual.startsWith(`${expected}-`);
    case '^=': return expected !== '' && actual.startsWith(expected);
    case '$=': return expected !== '' && actual.endsWith(expected);
    case '*=': return expected !== '' && actual.includes(expected);
    default: throw new Error(`Unsupported CSS attribute matcher ${part.matcher}`);
  }
}

function compound(node: TreeNode, parts: css.CssNode[]): boolean {
  return parts.every((part) => {
    switch (part.type) {
      case 'TypeSelector': return part.name === '*' || part.name.toLowerCase() === node.tag;
      case 'ClassSelector': return (node.attrs['class'] ?? '').split(/\s+/).includes(part.name);
      case 'IdSelector': return node.attrs['id'] === part.name;
      case 'AttributeSelector': return attribute(node, part);
      case 'PseudoElementSelector': return true;
      case 'PseudoClassSelector':
        if (part.name === 'root') return node.parent === null;
        if (part.name === 'first-child') return node.index === 0;
        if (part.name === 'last-child') return node.index === node.siblings - 1;
        if (part.name === 'not') return !args(part).some((inner) => matchSelector(node, inner));
        if (part.name === 'is' || part.name === 'where') return args(part).some((inner) => matchSelector(node, inner));
        if (STATE.test(part.name)) return false; // State pseudo-classes never match at rest (R2).
        throw new Error(`Unsupported CSS selector :${part.name}`);
      default: throw new Error(`Unsupported CSS selector ${css.generate(part)}`);
    }
  });
}

export function matchSelector(node: TreeNode, selector: SelectorAst): boolean {
  const compounds: css.CssNode[][] = [[]];
  const combinators: string[] = [];
  selector.children.forEach((part) => {
    if (part.type === 'Combinator') {
      if (part.name !== ' ' && part.name !== '>') throw new Error(`Unsupported CSS combinator ${part.name}`);
      combinators.push(part.name); compounds.push([]);
    }
    else compounds[compounds.length - 1]!.push(part);
  });
  function from(at: TreeNode, index: number): boolean {
    if (!compound(at, compounds[index]!)) return false;
    if (index === 0) return true;
    if (combinators[index - 1] === '>') return !!at.parent && from(at.parent, index - 1);
    for (let up = at.parent; up; up = up.parent) if (from(up, index - 1)) return true;
    return false;
  }
  return from(node, compounds.length - 1);
}
