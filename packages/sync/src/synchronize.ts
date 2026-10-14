import { createHash } from 'node:crypto';
import { applyOp, canonicalStringify, validateDoc, type ComponentDef, type DesignDoc, type Op, type Page } from '@hub/design-model';
import { extractPages } from './extract.js';
import type { RouteEntry, SourceDiagnostic, SourceProject } from './types.js';

/** Bump whenever extraction semantics change, so cached baselines are rebuilt. */
export const SYNC_VERSION = 2;
export interface PageBaseline {
  entry: RouteEntry;
  commit: string;
  hashes: Record<string, string>;
  page: Page;
  components?: Record<string, ComponentDef>;
}
export interface SyncBaseline {
  version: number;
  /** Import resolution also depends on which paths exist, not just file contents. */
  sourcePathsHash: string;
  pages: Record<string, PageBaseline>;
}
export interface SyncState {
  baseline: SyncBaseline;
  doc: DesignDoc;
  pending: Op[];
}
export interface SyncConflict { index: number; op: Op; message: string }
export type SyncResult =
  | { ok: true; state: SyncState; rebuilt: string[]; reused: string[]; removed: string[] }
  | { ok: false; kind: 'source'; diagnostics: SourceDiagnostic[] }
  | { ok: false; kind: 'replay'; conflicts: SyncConflict[]; blocked: number[] };

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** Pure preparation: callers commit a successful state atomically. Failure never mutates previous. */
export function synchronizePages(input: {
  project: SourceProject;
  entries: RouteEntry[];
  commit: string;
  previous?: SyncState;
}): SyncResult {
  const { project, entries, commit, previous } = input;
  const sourceFailure = (message: string): SyncResult => ({ ok: false, kind: 'source', diagnostics: [{ file: '', message }] });
  if (!commit.trim()) return sourceFailure('A source commit is required');
  if (new Set(entries.map((entry) => entry.route)).size !== entries.length) return sourceFailure('Duplicate routes');
  const sourcePathsHash = hash(canonicalStringify(Object.keys(project.files).sort()));
  const baseline: SyncBaseline = { version: SYNC_VERSION, sourcePathsHash, pages: {} };
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const rebuilt: string[] = [], reused: string[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  function mergeComponents(components: Record<string, ComponentDef>) {
    for (const [name, definition] of Object.entries(components)) {
      const existing = doc.components[name];
      if (existing && canonicalStringify(existing) !== canonicalStringify(definition)) diagnostics.push({ file: '', message: `Shared component ${name} has route-dependent props or CSS; provide a preview adapter` });
      else doc.components[name] = structuredClone(definition);
    }
  }
  for (const entry of [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0)) {
    const saved = previous?.baseline.pages[entry.route];
    const unchanged = saved && previous.baseline.version === SYNC_VERSION
      && previous.baseline.sourcePathsHash === sourcePathsHash
      && canonicalStringify(saved.entry) === canonicalStringify(entry)
      && Object.entries(saved.hashes).every(([file, digest]) => Object.hasOwn(project.files, file) && hash(project.files[file]!) === digest);
    if (unchanged) {
      baseline.pages[entry.route] = structuredClone(saved);
      doc.pages[saved.page.id] = structuredClone(saved.page);
      mergeComponents(saved.components ?? {});
      reused.push(entry.route);
      continue;
    }
    const extracted = extractPages(project, [entry], { sharedComponents: true });
    if (!extracted.ok) { diagnostics.push(...extracted.diagnostics); continue; }
    const page = Object.values(extracted.doc.pages)[0]!;
    const hashes = Object.fromEntries(extracted.dependencies[page.id]!.map((file) => [file, hash(project.files[file]!)]));
    baseline.pages[entry.route] = { entry: structuredClone(entry), commit, hashes, page: structuredClone(page), components: structuredClone(extracted.doc.components) };
    mergeComponents(extracted.doc.components);
    doc.pages[page.id] = page;
    rebuilt.push(entry.route);
  }
  if (diagnostics.length) return { ok: false, kind: 'source', diagnostics };
  const invalid = validateDoc(doc);
  if (invalid) return sourceFailure(invalid);
  const removed = Object.keys(previous?.baseline.pages ?? {}).filter((route) => !Object.hasOwn(baseline.pages, route)).sort();
  let replayed = doc;
  const pending = structuredClone(previous?.pending ?? []);
  for (const [index, op] of pending.entries()) {
    const applied = applyOp(replayed, op);
    if (!applied.ok) {
      // The remainder may depend on this operation. Do not skip it or guess a new order.
      return { ok: false, kind: 'replay', conflicts: [{ index, op, message: applied.error }], blocked: pending.slice(index + 1).map((_, offset) => index + offset + 1) };
    }
    replayed = applied.value.doc;
  }
  // Sync is one document revision. Replaying an unchanged log must not advance seq.
  replayed.meta.seq = previous?.doc.meta.seq ?? 0;
  if (previous && canonicalStringify(replayed) !== canonicalStringify(previous.doc)) replayed.meta.seq++;
  const replayInvalid = validateDoc(replayed);
  if (replayInvalid) return sourceFailure(replayInvalid);
  return { ok: true, state: { baseline, doc: replayed, pending }, rebuilt, reused, removed };
}
