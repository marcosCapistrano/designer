import * as css from 'css-tree';

/** One complex selector from css-tree. Structural matching only; state is resolved before matching (R2, R3). */
export type SelectorAst = css.Selector;
/** `tags` lists the tags of the element children and `text` the direct text content, where a state reads them. */
export interface TreeNode { tag: string; attrs: Record<string, string>; parent: TreeNode | null; index: number; siblings: number; tags?: readonly string[]; text?: string }
type Specificity = [number, number, number];

// States the resting frame never shows (R2). States decidable from static attributes are matched structurally (Ruling Q).
const STATE = /^(?:hover|focus.*|active|visited|target)$/;
const STATIC_STATE = new Set(['disabled', 'enabled', 'checked', 'required', 'optional', 'read-only', 'read-write', 'placeholder-shown']);
// Pseudo-elements that render at rest; a rule for one fails when it applies to an element in the tree (Ruling Q).
const RESTING_PSEUDO = new Set(['placeholder', 'marker', 'first-line', 'first-letter', 'file-selector-button']);
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
      } else if ((!STRUCTURAL.has(part.name) && !STATIC_STATE.has(part.name)) || part.children) throw new Error(`Unsupported CSS selector :${part.name}`);
    } else if (part.type === 'AttributeSelector') {
      if (part.flags || part.name.name.includes('|')) throw new Error(`Unsupported CSS attribute selector ${css.generate(part)}`);
    } else if (part.type === 'TypeSelector') { if (part.name.includes('|')) throw new Error(`Unsupported CSS selector ${part.name}`); }
    else if (part.type !== 'ClassSelector' && part.type !== 'IdSelector') throw new Error(`Unsupported CSS selector ${css.generate(part)}`);
  });
  return state;
}

/** The resting-visible pseudo-element a selector styles, or null (Ruling Q). */
export function restingPseudoElement(selector: SelectorAst): string | null {
  let found: string | null = null;
  selector.children.forEach((part) => { if (part.type === 'PseudoElementSelector' && RESTING_PSEUDO.has(part.name)) found = part.name; });
  return found;
}

/** Whether `pseudo` exists on the element: ::placeholder needs a placeholder text, ::file-selector-button a file input. */
export function hasPseudoElement(node: TreeNode, pseudo: string): boolean {
  if (pseudo === 'placeholder') return (node.tag === 'input' || node.tag === 'textarea') && !!node.attrs['placeholder'];
  if (pseudo === 'file-selector-button') return node.tag === 'input' && node.attrs['type']?.toLowerCase() === 'file';
  return true;
}

const has = (node: TreeNode, name: string) => Object.hasOwn(node.attrs, name);
const inputType = (node: TreeNode) => (node.attrs['type'] ?? 'text').toLowerCase();
const DISABLEABLE = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);
const READ_WRITE_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);
const PLACEHOLDER_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
const REQUIRED_NOT_APPLICABLE = new Set(['hidden', 'range', 'color', 'submit', 'image', 'reset', 'button']);

/** HTML's "actually disabled": a disabled attribute, a disabled optgroup, or a disabled fieldset outside its first legend. */
function isDisabled(node: TreeNode): boolean {
  if (!DISABLEABLE.has(node.tag)) return false;
  if (has(node, 'disabled')) return true;
  if (node.tag === 'option') return node.parent?.tag === 'optgroup' && has(node.parent, 'disabled');
  if (node.tag === 'optgroup') return false;
  for (let child = node, up = node.parent; up; child = up, up = up.parent) {
    if (up.tag !== 'fieldset' || !has(up, 'disabled')) continue;
    if (child.tag === 'legend' && (up.tags ? up.tags.indexOf('legend') === child.index : child.index === 0)) return false;
    return true;
  }
  return false;
}

function isEditable(node: TreeNode): boolean {
  for (let up: TreeNode | null = node; up; up = up.parent) {
    const value = up.attrs['contenteditable']?.toLowerCase();
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    if (value === 'false') return false;
  }
  return false;
}

/** A state pseudo-class decided from static attributes, as the browser decides it on the unmodified page. */
function staticState(node: TreeNode, name: string): boolean {
  switch (name) {
    case 'disabled': return isDisabled(node);
    case 'enabled': return DISABLEABLE.has(node.tag) && !isDisabled(node);
    case 'checked': return (node.tag === 'input' && ['checkbox', 'radio'].includes(inputType(node)) && has(node, 'checked')) || (node.tag === 'option' && has(node, 'selected'));
    case 'required':
    case 'optional': {
      const applies = node.tag === 'select' || node.tag === 'textarea' || (node.tag === 'input' && !REQUIRED_NOT_APPLICABLE.has(inputType(node)));
      const form = node.tag === 'select' || node.tag === 'textarea' || node.tag === 'input';
      return name === 'required' ? applies && has(node, 'required') : form && !(applies && has(node, 'required'));
    }
    case 'read-write':
    case 'read-only': {
      const control = (node.tag === 'textarea' || (node.tag === 'input' && READ_WRITE_INPUTS.has(inputType(node)))) && !has(node, 'readonly') && !isDisabled(node);
      return (control || isEditable(node)) === (name === 'read-write');
    }
    case 'placeholder-shown': {
      const field = node.tag === 'textarea' || (node.tag === 'input' && PLACEHOLDER_INPUTS.has(inputType(node)));
      const value = node.tag === 'textarea' ? node.text ?? '' : node.attrs['value'] ?? '';
      return field && !!node.attrs['placeholder'] && value === '';
    }
    default: throw new Error(`Unsupported CSS selector :${name}`);
  }
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
        if (STATIC_STATE.has(part.name)) return staticState(node, part.name);
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
