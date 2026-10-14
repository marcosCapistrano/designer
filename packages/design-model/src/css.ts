import * as csstree from 'css-tree';

const KEBAB_CASE = /^-?-?[a-z][a-z0-9-]*$/;
const VAR_CALL = /var\(/i;
// Characters that could end a declaration or rule, or the <style> element that holds the CSS,
// and comment markers, which could hide the rest of the stylesheet.
const FORBIDDEN_VALUE_CHAR = /[{};<>\\\n\r\f]|\/\*|\*\//;
// Anywhere in the value, quoted or not, with optional whitespace after the !.
const IMPORTANT = /!\s*important/i;

const TOKEN = csstree.tokenTypes;

// What the CSS tokenizer makes of a value, as far as the stylesheet around it is concerned.
type TokenIssue = 'malformed' | 'unbalanced' | null;

// Tokenizes the value the way a browser does, so a quote or url the tokenizer cannot close is found
// here and not by a character scan that guesses. A bad-url or bad-string token swallows the text that
// follows it, including the end of the rule. A string or url that runs to the end of the value, and
// a bracket without its partner, would do the same to the declaration and rule that follow.
// Backslash is already forbidden, so no quote or bracket is escaped.
function tokenIssue(value: string): TokenIssue {
  const tokens: { type: number; text: string }[] = [];
  csstree.tokenize(value, (type, start, end) => {
    tokens.push({ type, text: value.slice(start, end) });
  });

  const open: number[] = [];
  for (const { type, text } of tokens) {
    if (type === TOKEN.BadUrl || type === TOKEN.BadString) return 'malformed';
    if (type === TOKEN.String) {
      // A string that reaches the end of the value without its closing quote has no closer.
      if (text.length < 2 || !text.endsWith(text.charAt(0))) return 'unbalanced';
    } else if (type === TOKEN.Url) {
      if (!text.endsWith(')')) return 'unbalanced';
    } else if (type === TOKEN.Function || type === TOKEN.LeftParenthesis) {
      open.push(TOKEN.LeftParenthesis);
    } else if (type === TOKEN.LeftSquareBracket) {
      open.push(TOKEN.LeftSquareBracket);
    } else if (type === TOKEN.RightParenthesis) {
      if (open.pop() !== TOKEN.LeftParenthesis) return 'unbalanced';
    } else if (type === TOKEN.RightSquareBracket) {
      if (open.pop() !== TOKEN.LeftSquareBracket) return 'unbalanced';
    }
  }
  return open.length > 0 ? 'unbalanced' : null;
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
  const issue = tokenIssue(value);
  if (issue === 'malformed') return `Value for ${prop} has a malformed url or string`;
  if (issue === 'unbalanced') return `Value for ${prop} has unbalanced brackets or quotes`;

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
