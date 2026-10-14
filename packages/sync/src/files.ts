import { applyOp, canonicalStringify, decodeOpLog, encodeOpLog, parseDoc, serializeDoc, type DesignDoc, type Result } from '@hub/design-model';
import type { SyncBaseline, SyncState } from './synchronize.js';

const SHA = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const path = (value: unknown): value is string => typeof value === 'string' && !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
function fail(error: string): Result<SyncState> { return { ok: false, error }; }

/** The canonical design files, with source baselines and the pending log stored alongside them. */
export function serializeSyncState(state: SyncState): Record<string, string> {
  const files = { ...serializeDoc(state.doc), 'sync.json': canonicalStringify({ version: 1, baseline: state.baseline }), 'changes.jsonl': encodeOpLog(state.pending) };
  const checked = parseSyncState(files);
  if (!checked.ok) throw new Error(checked.error);
  return files;
}

/** External JSON is checked before it can enter the baseline cache or operation engine. */
export function parseSyncState(files: Record<string, string>): Result<SyncState> {
  try {
    if (!object(files) || !Object.values(files).every((value) => typeof value === 'string')) return fail('Snapshot files must be strings');
    const document = parseDoc(files);
    if (!document.ok) return document;
    if (!Object.hasOwn(files, 'changes.jsonl') || !Object.hasOwn(files, 'sync.json')) return fail('Snapshot requires sync.json and changes.jsonl');
    const log = decodeOpLog(files['changes.jsonl']!);
    if (!log.ok) return log;
    const metadata: unknown = JSON.parse(files['sync.json']!);
    if (!object(metadata) || metadata['version'] !== 1 || !object(metadata['baseline'])) return fail('Invalid sync snapshot version or baseline');
    const base = metadata['baseline'];
    if (!Number.isSafeInteger(base['version']) || (base['version'] as number) < 1 || typeof base['sourcePathsHash'] !== 'string' || !SHA.test(base['sourcePathsHash']) || !object(base['pages'])) return fail('Invalid baseline metadata');
    const clean: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
    for (const [route, value] of Object.entries(base['pages'])) {
      if (!route.startsWith('/') || !object(value) || !object(value['entry']) || !object(value['page']) || !object(value['hashes'])) return fail(`Invalid baseline for ${route}`);
      const entry = value['entry'];
      if (entry['route'] !== route || !path(entry['file']) || (entry['exportName'] !== undefined && typeof entry['exportName'] !== 'string') || (entry['layouts'] !== undefined && (!Array.isArray(entry['layouts']) || !entry['layouts'].every(path)))) return fail(`Invalid route entry for ${route}`);
      if (typeof value['commit'] !== 'string' || !value['commit'].trim()) return fail(`Missing baseline commit for ${route}`);
      const hashes = value['hashes'];
      if (!Object.entries(hashes).every(([file, digest]) => path(file) && typeof digest === 'string' && SHA.test(digest)) || !Object.hasOwn(hashes, entry['file']) || (entry['layouts'] as string[] | undefined)?.some((file) => !Object.hasOwn(hashes, file))) return fail(`Invalid dependency hashes for ${route}`);
      const page = value['page'];
      if (typeof page['id'] !== 'string' || !path(page['id']) || page['id'].includes('/') || page['route'] !== route || Object.hasOwn(clean.pages, page['id'])) return fail(`Invalid baseline page for ${route}`);
      // Reuse the design-model file decoder for every baseline node and field.
      const componentFiles: Record<string, string> = {};
      if (value['components'] !== undefined) {
        if (!object(value['components'])) return fail(`Invalid baseline components for ${route}`);
        for (const [name, definition] of Object.entries(value['components'])) {
          if (!path(name) || name.includes('/')) return fail('Invalid baseline component name');
          componentFiles[`components/${name}.json`] = canonicalStringify(definition);
        }
      }
      const parsed = parseDoc({ 'meta.json': canonicalStringify(clean.meta), 'tokens.json': '{}', [`pages/${page['id']}.json`]: canonicalStringify(page), ...componentFiles });
      if (!parsed.ok) return fail(`Baseline ${route}: ${parsed.error}`);
      Object.assign(clean.pages, parsed.value.pages);
      for (const [name, definition] of Object.entries(parsed.value.components)) {
        if (Object.hasOwn(clean.components, name) && canonicalStringify(clean.components[name]) !== canonicalStringify(definition)) return fail(`Inconsistent baseline component ${name}`);
        clean.components[name] = definition;
      }
    }
    const combined = parseDoc(serializeDoc(clean));
    if (!combined.ok) return fail(`Baseline: ${combined.error}`);
    let replayed = combined.value;
    for (const [index, op] of log.value.entries()) {
      const applied = applyOp(replayed, op);
      if (!applied.ok) return fail(`Pending operation ${index}: ${applied.error}`);
      replayed = applied.value.doc;
    }
    replayed.meta.seq = document.value.meta.seq;
    if (canonicalStringify(replayed) !== canonicalStringify(document.value)) return fail('Document does not match baseline plus pending operations');
    return { ok: true, value: { baseline: base as unknown as SyncBaseline, doc: document.value, pending: log.value } };
  } catch (error) { return fail(error instanceof Error ? error.message : 'Invalid sync snapshot'); }
}
