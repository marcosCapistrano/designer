import type { Tokens } from '@hub/design-model';
import type { TokenSource } from './types.js';

// The design model emits a token as `--group-name`; these are the names it accepts.
export const TOKEN_GROUP = /^[a-z][a-z0-9]*$/;
export const TOKEN_NAME = /^[a-z0-9_][a-z0-9_-]*$/;

/**
 * Adds one route's resolved tokens to a document. Identical values merge; a conflicting value is an error naming
 * the token and both stylesheets. `origins` remembers where each token was first defined.
 */
export function mergeTokens(tokens: Tokens, origins: Map<string, TokenSource>, add: readonly TokenSource[]): { file: string; message: string } | null {
  for (const token of add) {
    const key = `--${token.group}-${token.name}`;
    if (!TOKEN_GROUP.test(token.group) || !TOKEN_NAME.test(token.name)) return { file: token.file, message: `Invalid token name ${key}` };
    const before = origins.get(key);
    if (before) {
      if (before.value !== token.value) return { file: token.file, message: `Token ${key} is ${before.value} in ${before.file} but ${token.value} in ${token.file} on another route` };
      continue;
    }
    origins.set(key, token);
    const group = Object.hasOwn(tokens, token.group) ? tokens[token.group]! : (tokens[token.group] = {});
    group[token.name] = token.value;
  }
  return null;
}
