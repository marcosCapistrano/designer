import * as csstree from 'css-tree';

const KEBAB_CASE = /^-?-?[a-z][a-z0-9-]*$/;
const VAR_CALL = /var\(/i;
// Characters that could end a declaration or rule, or the <style> element that holds the CSS,
// and comment markers, which could hide the rest of the stylesheet.
const FORBIDDEN_VALUE_CHAR = /[{};<>\\\n\r\f]|\/\*|\*\//;
// Anywhere in the value, quoted or not, with optional whitespace after the !.
const IMPORTANT = /!\s*important/i;

// True when every quote is closed, and every ( and [ outside quotes has its matching closer.
// Quotes are not escaped (\ is already forbidden), so a quote ends at the next same quote.
function isBalanced(value: string): boolean {
  const open: string[] = [];
  let quote: string | null = null;
  for (const ch of value) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      open.push(ch);
    } else if (ch === ')') {
      if (open.pop() !== '(') return false;
    } else if (ch === ']') {
      if (open.pop() !== '[') return false;
    }
  }
  return quote === null && open.length === 0;
}

// Returns null when the declaration is valid, otherwise a reason naming the property.
export function validateStyle(prop: string, value: string): string | null {
  if (!KEBAB_CASE.test(prop)) {
    return `Property "${prop}" must be kebab-case`;
  }

  if (FORBIDDEN_VALUE_CHAR.test(value)) {
    return `Value for ${prop} contains a forbidden character`;
  }

  // These apply to every value, custom properties and values with var() included.
  if (IMPORTANT.test(value)) {
    return `Value for ${prop} must not use !important`;
  }
  if (!isBalanced(value)) {
    return `Value for ${prop} has unbalanced brackets or quotes`;
  }

  if (prop.startsWith('--')) {
    return value.trim() === '' ? `Invalid value "${value}" for ${prop}` : null;
  }

  if (csstree.lexer.getProperty(prop) === null) {
    return `Unknown CSS property "${prop}"`;
  }

  // csstree cannot match a tree that contains var(), so such values are accepted as-is.
  if (VAR_CALL.test(value)) {
    return null;
  }

  const invalid = `Invalid value "${value}" for ${prop}`;
  let tree: csstree.CssNode;
  try {
    tree = csstree.parse(value, { context: 'value' });
  } catch {
    return invalid;
  }

  return csstree.lexer.matchProperty(prop, tree).error ? invalid : null;
}
