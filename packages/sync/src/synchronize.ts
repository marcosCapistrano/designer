import { createHash } from 'node:crypto';
import { applyOp, canonicalStringify, validateDoc, type ComponentDef, type DesignDoc, type Op, type Page } from '@hub/design-model';
import { extractPages } from './extract.js';
import type { InlinedComponent, InlineReason, PreviewChoices, RouteEntry, RouteInlining, SourceDiagnostic, SourceProject, TokenSource } from './types.js';
import { mergeTokens } from './tokens.js';
import { choicesProblem } from './choices.js';
import { ADAPTERS_FILE, adaptersIssue } from './adapters.js';

/** Bump whenever extraction semantics change, so cached baselines are rebuilt. */
export const SYNC_VERSION = 5;
export interface PageBaseline {
  entry: RouteEntry;
  commit: string;
  hashes: Record<string, string>;
  page: Page;
  components?: Record<string, ComponentDef>;
  /** The route's resolved `:root` tokens, with the stylesheet that defined each. */
  tokens?: TokenSource[];
  /** Which components the route rendered and inlined (Ruling F), so a cached page is reused only if still consistent. */
  inlining?: RouteInlining;
}
export interface SyncBaseline {
  version: number;
  /** Import resolution also depends on which paths exist, not just file contents. */
  sourcePathsHash: string;
  pages: Record<string, PageBaseline>;
  choicesHash?: string;
  /** Adapters change extraction output, so their canonical hash is part of the page reuse key. */
  adaptersHash?: string;
}
export interface SyncState {
  baseline: SyncBaseline;
  doc: DesignDoc;
  pending: Op[];
  batchLengths?: number[];
  redo?: Op[][];
  choices?: PreviewChoices;
}
export interface SyncConflict { index: number; op: Op; message: string }
export type SyncResult =
  | { ok: true; state: SyncState; rebuilt: string[]; reused: string[]; removed: string[]; inlined: InlinedComponent[] }
  | { ok: false; kind: 'source'; diagnostics: SourceDiagnostic[] }
  | { ok: false; kind: 'replay'; conflicts: SyncConflict[]; blocked: number[] };

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
const EMPTY_ADAPTERS_HASH = hash(canonicalStringify({ modules: {} }));

/** Pure preparation: callers commit a successful state atomically. Failure never mutates previous. */
export function synchronizePages(input: {
  project: SourceProject;
  entries: RouteEntry[];
  commit: string;
  previous?: SyncState;
  choices?: PreviewChoices;
}): SyncResult {
  const { project, entries, commit, previous } = input;
  const sourceFailure = (message: string): SyncResult => ({ ok: false, kind: 'source', diagnostics: [{ file: '', message }] });
  if (!commit.trim()) return sourceFailure('A source commit is required');
  const choices = input.choices ?? previous?.choices ?? {};
  const choiceError = choicesProblem(choices);
  if (choiceError) return sourceFailure(choiceError);
  const choicesHash = hash(canonicalStringify(choices));
  const adapterError = project.adapters !== undefined ? adaptersIssue(project.adapters) : null;
  if (adapterError) return { ok: false, kind: 'source', diagnostics: [{ file: ADAPTERS_FILE, message: adapterError }] };
  // No adapters hashes like an empty adapters file, so baselines written before adapters existed stay reusable.
  const adaptersHash = hash(canonicalStringify(project.adapters ?? { modules: {} }));
  if (new Set(entries.map((entry) => entry.route)).size !== entries.length) return sourceFailure('Duplicate routes');
  const sourcePathsHash = hash(canonicalStringify(Object.keys(project.files).sort()));
  const baseline: SyncBaseline = { version: SYNC_VERSION, sourcePathsHash, choicesHash, adaptersHash, pages: {} };
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const rebuilt: string[] = [], reused: string[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const tokenOrigins = new Map<string, TokenSource>();
  function addTokens(tokens: TokenSource[] | undefined) {
    const conflict = mergeTokens(doc.tokens, tokenOrigins, tokens ?? []);
    if (conflict) diagnostics.push(conflict);
  }
  function mergeComponents(components: Record<string, ComponentDef>) {
    for (const [name, definition] of Object.entries(components)) {
      const existing = doc.components[name];
      if (existing && canonicalStringify(existing) !== canonicalStringify(definition)) diagnostics.push({ file: '', message: `Shared component ${name} has route-dependent props or CSS; provide a preview adapter` });
      else doc.components[name] = structuredClone(definition);
    }
  }
  const sorted = [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
  // Ruling F: a component inlined on any route is inlined on every route. Pages are extracted separately, so the set
  // grows until every page, reused or rebuilt, was extracted with exactly the inlined components it renders.
  const inline = new Map<string, InlineReason>();
  const include = ({ key, reason }: RouteInlining['inline'][number]): boolean => {
    const was = inline.get(key);
    // Prefer one reason regardless of route order; only a new component changes extraction.
    if (was !== reason && was !== 'prop-css') inline.set(key, reason);
    return was === undefined;
  };
  const fits = (inlining: RouteInlining | undefined): boolean => {
    if (!inlining) return false;
    const inlined = new Set(inlining.inline.map(({ key }) => key));
    return inlining.input.every((key) => inline.has(key)) && inlining.encountered.every((key) => !inline.has(key) || inlined.has(key));
  };
  type Outcome = { kind: 'reused' | 'rebuilt'; page: PageBaseline } | { kind: 'failed'; diagnostics: SourceDiagnostic[]; size: number };
  const outcomes = new Map<string, Outcome>();
  for (;;) {
    let grew = false;
    for (const entry of sorted) {
      const saved = previous?.baseline.pages[entry.route];
      const unchanged = saved && previous.baseline.version === SYNC_VERSION
        && previous.baseline.sourcePathsHash === sourcePathsHash
        && previous.baseline.choicesHash === choicesHash
        && (previous.baseline.adaptersHash ?? EMPTY_ADAPTERS_HASH) === adaptersHash
        && canonicalStringify(saved.entry) === canonicalStringify(entry)
        && Object.entries(saved.hashes).every(([file, digest]) => Object.hasOwn(project.files, file) && hash(project.files[file]!) === digest);
      const current = outcomes.get(entry.route);
      if (current?.kind === 'failed' || !(current && fits(current.page.inlining))) {
        if (unchanged && fits(saved.inlining)) outcomes.set(entry.route, { kind: 'reused', page: saved });
        else continue;
      }
      for (const item of (outcomes.get(entry.route) as { page: PageBaseline }).page.inlining!.inline) grew = include(item) || grew;
    }
    if (grew) continue;
    for (const entry of sorted) {
      const current = outcomes.get(entry.route);
      if (current?.kind === 'failed' ? current.size === inline.size : current && fits(current.page.inlining)) continue;
      const extracted = extractPages(project, [entry], { sharedComponents: true, choices, inline: Object.fromEntries(inline) });
      if (!extracted.ok) { outcomes.set(entry.route, { kind: 'failed', diagnostics: extracted.diagnostics, size: inline.size }); continue; }
      const page = Object.values(extracted.doc.pages)[0]!;
      const hashes = Object.fromEntries(extracted.dependencies[page.id]!.map((file) => [file, hash(project.files[file]!)]));
      const tokens = extracted.tokens[page.id] ?? [];
      const inlining = extracted.inlining[page.id]!;
      outcomes.set(entry.route, { kind: 'rebuilt', page: { entry: structuredClone(entry), commit, hashes, page, components: extracted.doc.components, ...(tokens.length ? { tokens } : {}), inlining } });
      for (const item of inlining.inline) grew = include(item) || grew;
    }
    if (!grew) break;
  }
  const inlined: InlinedComponent[] = [];
  for (const entry of sorted) {
    const outcome = outcomes.get(entry.route)!;
    if (outcome.kind === 'failed') { diagnostics.push(...outcome.diagnostics); continue; }
    const { page } = outcome;
    baseline.pages[entry.route] = structuredClone(page);
    doc.pages[page.page.id] = structuredClone(page.page);
    mergeComponents(page.components ?? {});
    addTokens(page.tokens);
    for (const { key, component, file } of page.inlining!.inline) inlined.push({ route: entry.route, component, file, reason: inline.get(key)! });
    (outcome.kind === 'reused' ? reused : rebuilt).push(entry.route);
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
  return { ok: true, state: { baseline, doc: replayed, pending, ...(Object.keys(choices).length ? { choices: structuredClone(choices) } : {}), ...(previous?.batchLengths ? { batchLengths: [...previous.batchLengths] } : {}), ...(previous?.redo ? { redo: [] } : {}) }, rebuilt, reused, removed, inlined };
}
