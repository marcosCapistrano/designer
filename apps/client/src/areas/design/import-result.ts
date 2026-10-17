import type { ImportResponse } from '@hub/protocol';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The status line for an applied import: pages, removed and failed routes, inlined components and hidden rules. */
export function importNote(out: Extract<ImportResponse, { ok: true }>): string {
  const parts = [`Imported ${out.rebuilt.length} pages; reused ${out.reused.length}.`];
  if (out.removed.length) parts.push(`Removed ${out.removed.length} source routes.`);
  if (out.failed.length) parts.push(`${count(out.failed.length, 'route', 'routes')} failed to import.`);
  const inlined = new Set(out.inlined.map(({ file, component }) => `${file}:${component}`)).size;
  if (inlined) parts.push(`${count(inlined, 'inlined component', 'inlined components')}.`);
  if (out.sourceOnlyRules) parts.push(`${count(out.sourceOnlyRules, 'hover/print rule', 'hover/print rules')} not shown.`);
  return parts.join(' ');
}
