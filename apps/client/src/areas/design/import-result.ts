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

export interface Details { title: string; items: string[] }
export interface Outcome { toast: { kind: 'ok' | 'warning' | 'error'; text: string; sticky?: boolean }; details: Details | null }

const PRESERVED = 'Import was not applied. Your previous design and edits are preserved.';

/** The toasts an import result shows, each with the details a "Details" action opens. */
export function importOutcome(out: ImportResponse): Outcome[] {
  if (!out.ok) {
    const items = out.kind === 'source'
      ? out.diagnostics.map((d) => (d.file ? `${d.file}: ${d.message}` : d.message))
      : [...out.conflicts.map((c) => `Edit ${c.index + 1}: ${c.message}`), `${count(out.blocked.length, 'later edit is', 'later edits are')} blocked.`];
    return [{ toast: { kind: 'error', text: PRESERVED, sticky: true }, details: { title: 'Why the import was not applied', items } }];
  }
  const outcomes: Outcome[] = [];
  if (out.failed.length) {
    const items = out.failed.flatMap((f) => f.diagnostics.map((d) => `${f.route} — ${d.file ? `${d.file}: ` : ''}${d.message}`));
    outcomes.push({ toast: { kind: 'warning', text: importNote(out), sticky: true }, details: { title: 'Routes not imported', items } });
  } else {
    outcomes.push({ toast: { kind: 'ok', text: importNote(out) }, details: null });
  }
  if (out.warnings.length) outcomes.push({ toast: { kind: 'warning', text: out.warnings.join(' '), sticky: true }, details: null });
  return outcomes;
}
