import * as csstree from 'css-tree';

const KEBAB_CASE = /^-?-?[a-z][a-z0-9-]*$/;
const VAR_CALL = /var\(/i;

// Returns null when the declaration is valid, otherwise a reason naming the property.
export function validateStyle(prop: string, value: string): string | null {
  if (!KEBAB_CASE.test(prop)) {
    return `Property "${prop}" must be kebab-case`;
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
