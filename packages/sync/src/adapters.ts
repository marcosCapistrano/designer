import { validateTag } from '@hub/design-model';
import { ADAPTERS_FILE, adaptersProblem, type Adapter, type Adapters } from '@hub/protocol/adapters';

export { ADAPTERS_FILE };
export type { Adapter, Adapters };

/** The problem with a project's adapters, naming the offending adapter key, or null. Checked before any source is read. */
export function adaptersIssue(adapters: unknown): string | null {
  const problem = adaptersProblem(adapters);
  if (problem) return problem;
  for (const [specifier, exports] of Object.entries((adapters as Adapters).modules)) {
    for (const [name, adapter] of Object.entries(exports)) {
      if (adapter.kind !== 'element') continue;
      // The model forbids document, script and frame tags; an adapter cannot introduce one.
      const tag = validateTag(adapter.tag);
      if (tag) return `Adapter modules["${specifier}"]["${name}"]: ${tag}`;
    }
  }
  return null;
}

/** `modules[specifier][exportName]`, falling back to `modules[specifier]["*"]`; null when unmapped. */
export function findAdapter(adapters: Adapters | undefined, specifier: string, exportName: string): Adapter | null {
  const exports = adapters && Object.hasOwn(adapters.modules, specifier) ? adapters.modules[specifier]! : null;
  if (!exports) return null;
  if (Object.hasOwn(exports, exportName)) return exports[exportName]!;
  return Object.hasOwn(exports, '*') ? exports['*']! : null;
}

/** Exact source-relative stylesheet paths the importer skips (ledger Ruling A). */
export function ignoresStyle(adapters: Adapters | undefined, file: string): boolean {
  return adapters?.styles?.ignore.includes(file) ?? false;
}
