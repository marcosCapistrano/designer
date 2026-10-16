import { createHash } from 'node:crypto';
import { applyOp, canonicalStringify, validateDoc, type ComponentDef, type DesignDoc, type DesignNode, type Op, type Page } from '@hub/design-model';
import { componentName, extractPages, stableId, strongerReason } from './extract.js';
import type { ComponentRules, InlinedComponent, InlineReason, PreviewChoices, RouteEntry, RouteFailure, RouteInlining, SourceDiagnostic, SourceProject, TokenSource } from './types.js';
import { mergeTokens } from './tokens.js';
import { choicesProblem } from './choices.js';
import { ADAPTERS_FILE, adaptersIssue } from './adapters.js';

/** Bump whenever extraction semantics change, so cached baselines are rebuilt. */
export const SYNC_VERSION = 8;
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
  /** Per stylesheet the route loaded, the rules and blocks skipped as source-only (R2); stylesheets with none omitted. */
  sourceOnly?: Record<string, number>;
  /** R7: the route failed its latest import and this is its previous version, kept as is; it is never reused as fresh. */
  stale?: true;
}
export interface SyncBaseline {
  version: number;
  /** Import resolution also depends on which paths exist, not just file contents. */
  sourcePathsHash: string;
  pages: Record<string, PageBaseline>;
  choicesHash?: string;
  /** Adapters change extraction output, so their canonical hash is part of the page reuse key. */
  adaptersHash?: string;
  /** The components inlined on the routes the latest import extracted (Ruling F), for the design summary. */
  inlined?: InlinedComponent[];
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
  | { ok: true; state: SyncState; rebuilt: string[]; reused: string[]; removed: string[]; inlined: InlinedComponent[]; failed: RouteFailure[]; sourceOnlyRules: number }
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
  // Aliases change resolution like paths do; without aliases the hash stays what it was before they existed.
  const paths = Object.keys(project.files).sort();
  const sourcePathsHash = hash(canonicalStringify(project.aliases && Object.keys(project.aliases).length ? { paths, aliases: project.aliases } : paths));
  const baseline: SyncBaseline = { version: SYNC_VERSION, sourcePathsHash, choicesHash, adaptersHash, pages: {} };
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const rebuilt: string[] = [], reused: string[] = [];
  let tokenOrigins = new Map<string, TokenSource>();
  /** Which route's definition of each shared component the document holds, and the rules that styled it. */
  const owners = new Map<string, { route: string; rules: ComponentRules[string] | undefined }>();
  /** R7: adds one route's page, components and tokens to the document, or nothing and the reason. */
  function admit(route: string, page: PageBaseline, rules?: ComponentRules): SourceDiagnostic | null {
    for (const [name, definition] of Object.entries(page.components ?? {})) {
      const existing = doc.components[name];
      if (existing && canonicalStringify(existing) !== canonicalStringify(definition)) return mismatch(name, route, page, existing, definition, rules?.[name]);
    }
    const tokens = structuredClone(doc.tokens), origins = new Map(tokenOrigins);
    const conflict = mergeTokens(tokens, origins, page.tokens ?? []);
    if (conflict) return conflict;
    doc.tokens = tokens; tokenOrigins = origins;
    for (const [name, definition] of Object.entries(page.components ?? {})) {
      if (!owners.has(name)) owners.set(name, { route, rules: rules?.[name] });
      doc.components[name] = structuredClone(definition);
    }
    baseline.pages[route] = structuredClone(page);
    doc.pages[page.page.id] = structuredClone(page.page);
    return null;
  }
  /** A shared definition that differs between two routes, naming the component, its file, both routes and what differs. */
  function mismatch(name: string, route: string, page: PageBaseline, existing: ComponentDef, definition: ComponentDef, rules: ComponentRules[string] | undefined): SourceDiagnostic {
    const owner = owners.get(name)!;
    // A shared definition's id is derived from its source key, `<file>:<export>`, which the route recorded as rendered.
    const key = (page.inlining?.encountered ?? []).find((item) => `C${stableId(item)}` === name);
    const file = key ? key.slice(0, key.lastIndexOf(':')) : '';
    const label = key ? componentName(project, file, key.slice(key.lastIndexOf(':') + 1)) : name;
    const at = difference(existing.root, definition.root) ?? (canonicalStringify(existing.props) !== canonicalStringify(definition.props) ? { node: null, what: 'its props' } : null);
    let detail = '';
    if (at) {
      detail = at.node ? ` at node ${at.node} (${at.what})` : ` in ${at.what}`;
      const before = new Set(at.node ? owner.rules?.[at.node] ?? [] : []), now = new Set(at.node ? rules?.[at.node] ?? [] : []);
      const responsible = [...before, ...now].filter((item) => !before.has(item) || !now.has(item));
      if (responsible.length) detail += `; ${[...new Set(responsible)].join(', ')} match only one route`;
    }
    return { file, message: `Shared component ${label}${file ? ` in ${file}` : ''} differs between ${owner.route} and ${route}${detail}; provide a preview adapter` };
  }
  const sorted = [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
  // Ruling F: a component inlined on any route is inlined on every route. Pages are extracted separately, so the set
  // grows until every page, reused or rebuilt, was extracted with exactly the inlined components it renders.
  const inline = new Map<string, InlineReason>();
  /** Adds a page's own reasons; only a newly inlined component changes extraction. */
  const include = (inlining: RouteInlining): boolean => {
    let grew = false;
    for (const [key, reason] of Object.entries(inlining.reasons)) {
      const was = inline.get(key);
      inline.set(key, strongerReason(was, reason));
      grew ||= was === undefined;
    }
    return grew;
  };
  const fits = (inlining: RouteInlining | undefined): boolean => {
    if (!inlining) return false;
    const inlined = new Set(inlining.inline.map(({ key }) => key));
    return inlining.input.every((key) => inline.has(key)) && inlining.encountered.every((key) => !inline.has(key) || inlined.has(key));
  };
  type Outcome = { kind: 'reused' | 'rebuilt'; page: PageBaseline; rules?: ComponentRules } | { kind: 'failed'; diagnostics: SourceDiagnostic[]; size: number };
  const outcomes = new Map<string, Outcome>();
  for (;;) {
    let grew = false;
    for (const entry of sorted) {
      const saved = previous?.baseline.pages[entry.route];
      const unchanged = saved && !saved.stale && previous.baseline.version === SYNC_VERSION
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
      grew = include((outcomes.get(entry.route) as { page: PageBaseline }).page.inlining!) || grew;
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
      outcomes.set(entry.route, { kind: 'rebuilt', page: { entry: structuredClone(entry), commit, hashes, page, components: extracted.doc.components, ...(tokens.length ? { tokens } : {}), inlining, sourceOnly: extracted.sourceOnly[page.id] ?? {} }, rules: extracted.componentRules[page.id] });
      grew = include(inlining) || grew;
    }
    if (!grew) break;
  }
  // R7: each route is atomic. A route that fails extraction, or disagrees with a route admitted before it, keeps its
  // previous version (marked stale) or stays absent; the import as a whole fails only when nothing can be saved.
  const failures = new Map<string, SourceDiagnostic[]>();
  const fresh: { route: string; page: PageBaseline }[] = [];
  for (const entry of sorted) {
    const outcome = outcomes.get(entry.route)!;
    if (outcome.kind === 'failed') { failures.set(entry.route, outcome.diagnostics); continue; }
    const problem = admit(entry.route, outcome.page, outcome.rules);
    if (problem) { failures.set(entry.route, [problem]); continue; }
    fresh.push({ route: entry.route, page: outcome.page });
    (outcome.kind === 'reused' ? reused : rebuilt).push(entry.route);
  }
  const failed: RouteFailure[] = [...failures].map(([route, diagnostics]) => ({ route, diagnostics }));
  const allDiagnostics = () => failed.flatMap((failure) => failure.diagnostics);
  if (!fresh.length && !previous && failed.length) return { ok: false, kind: 'source', diagnostics: allDiagnostics() };
  for (const { route } of failed) {
    const saved = previous?.baseline.pages[route];
    if (!saved) continue;
    const problem = admit(route, { ...saved, stale: true });
    // Keeping it would make the saved design inconsistent, so nothing is applied.
    if (problem) return { ok: false, kind: 'source', diagnostics: [...allDiagnostics(), { file: problem.file, message: `The previous version of ${route} cannot be kept: ${problem.message}` }] };
  }
  // The reported reason merges the admitted pages' own reasons by fixed priority, never the order they were found in.
  const reasons = new Map<string, InlineReason>();
  for (const { page } of fresh) for (const [key, reason] of Object.entries(page.inlining!.reasons)) reasons.set(key, strongerReason(reasons.get(key), reason));
  const inlined: InlinedComponent[] = [];
  for (const { route, page } of fresh) {
    for (const { key, component, file } of page.inlining!.inline) inlined.push({ route, component, file, reason: reasons.get(key) ?? inline.get(key)! });
  }
  const sourceOnlyRules = countSourceOnly(fresh.map(({ page }) => page));
  if (inlined.length) baseline.inlined = inlined;
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
  return { ok: true, state: { baseline, doc: replayed, pending, ...(Object.keys(choices).length ? { choices: structuredClone(choices) } : {}), ...(previous?.batchLengths ? { batchLengths: [...previous.batchLengths] } : {}), ...(previous?.redo ? { redo: [] } : {}) }, rebuilt, reused, removed, inlined, failed, sourceOnlyRules };
}

/**
 * R2: the source-only rules and blocks over the pages' stylesheets, each stylesheet counted once however many routes
 * load it. Kept previous versions (stale) are skipped: they describe an older source.
 */
export function countSourceOnly(pages: Iterable<PageBaseline>): number {
  const files = new Map<string, number>();
  for (const page of pages) if (!page.stale) for (const [file, count] of Object.entries(page.sourceOnly ?? {})) files.set(file, count);
  let total = 0;
  for (const count of files.values()) total += count;
  return total;
}

/** The first node where two definitions differ, and what differs there. */
function difference(a: DesignNode, b: DesignNode): { node: string; what: string } | null {
  if (a.kind !== b.kind || a.id !== b.id) return { node: a.id, what: 'structure' };
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text ? null : { node: a.id, what: 'text' };
  if (a.kind !== 'element' || b.kind !== 'element') return canonicalStringify(a) === canonicalStringify(b) ? null : { node: a.id, what: 'instance props' };
  if (a.tag !== b.tag || a.children.length !== b.children.length) return { node: a.id, what: 'structure' };
  if (canonicalStringify(a.style) !== canonicalStringify(b.style)) {
    const props: string[] = [];
    for (const device of ['base', 'tablet', 'mobile'] as const) {
      const x: Record<string, string> = a.style[device] ?? {}, y: Record<string, string> = b.style[device] ?? {};
      for (const prop of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[prop] !== y[prop]) props.push(device === 'base' ? prop : `${device} ${prop}`);
    }
    return { node: a.id, what: `CSS ${props.sort().join(', ')}` };
  }
  if (canonicalStringify(a.attrs) !== canonicalStringify(b.attrs)) return { node: a.id, what: 'attributes' };
  for (let index = 0; index < a.children.length; index++) {
    const found = difference(a.children[index]!, b.children[index]!);
    if (found) return found;
  }
  return null;
}
