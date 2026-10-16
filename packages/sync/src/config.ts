import ts from '@typescript/typescript6';
import type { SourceDiagnostic } from './types.js';

export type AliasesResult = { ok: true; aliases: Record<string, string> } | { ok: false; diagnostic: SourceDiagnostic };

/** Joins and normalizes a POSIX path relative to the source root, or null if it leaves the root. */
function normalize(...parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '..') { if (!out.length) return null; out.pop(); }
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

/**
 * Path aliases for an import rooted at `fromDir`, read from the nearest tracked `tsconfig.json` at or above it. The file
 * is parsed as JSONC data, never evaluated. Each `"<prefix>*": ["<dir>/*"]` entry maps `<prefix>` to `<dir>/`, resolved
 * against the tsconfig directory and its `baseUrl`. `extends` and any other `paths` shape fail, naming file and entry.
 */
export function projectAliases(configs: Record<string, string>, fromDir: string): AliasesResult {
  const parts = fromDir.split('/').filter(Boolean);
  let file: string | undefined;
  for (let depth = parts.length; depth >= 0 && !file; depth--) {
    const candidate = [...parts.slice(0, depth), 'tsconfig.json'].join('/');
    if (Object.hasOwn(configs, candidate)) file = candidate;
  }
  if (!file) return { ok: true, aliases: {} };
  const fail = (message: string): AliasesResult => ({ ok: false, diagnostic: { file: file!, message } });
  const parsed = ts.parseConfigFileTextToJson(file, configs[file]!);
  const config: unknown = parsed.config;
  if (parsed.error || !config || typeof config !== 'object' || Array.isArray(config)) return fail(`Invalid tsconfig: ${parsed.error ? ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ') : 'not an object'}`);
  const record = config as Record<string, unknown>;
  if (record['extends'] !== undefined) return fail(`Unsupported tsconfig extends ${typeof record['extends'] === 'string' ? record['extends'] : JSON.stringify(record['extends'])}; declare compilerOptions.paths in ${file} itself`);
  const options = record['compilerOptions'];
  if (options === undefined) return { ok: true, aliases: {} };
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fail('Invalid tsconfig compilerOptions');
  const { baseUrl, paths } = options as Record<string, unknown>;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') return fail('Invalid tsconfig compilerOptions.baseUrl');
  if (paths === undefined) return { ok: true, aliases: {} };
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return fail('Invalid tsconfig compilerOptions.paths');
  const dir = file.split('/').slice(0, -1).join('/');
  const base = normalize(dir, baseUrl ?? '.');
  if (base === null) return fail(`tsconfig baseUrl ${baseUrl} leaves the source root`);
  const aliases: Record<string, string> = {};
  for (const [pattern, targets] of Object.entries(paths)) {
    const unsupported = (why: string) => fail(`Unsupported tsconfig paths entry "${pattern}": ${why}; the importer supports only "<prefix>*": ["<dir>/*"]`);
    if (!/^[^*]+\*$/.test(pattern)) return unsupported('the key must be a non-empty prefix ending in a single *');
    if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') return unsupported('it must have exactly one target');
    const target = targets[0] as string;
    if (!/^[^*]*\/\*$/.test(target) || target.startsWith('/')) return unsupported(`the target ${target} must be a relative directory ending in /*`);
    const resolved = normalize(base, target.slice(0, -2));
    if (resolved === null) return unsupported(`the target ${target} leaves the source root`);
    aliases[pattern.slice(0, -1)] = resolved ? `${resolved}/` : '';
  }
  return { ok: true, aliases };
}
