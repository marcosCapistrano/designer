import { canonicalStringify } from './canonical.js';
import { basicHandlers } from './ops/basic.js';
import type { AnyOpHandler, HandlerMap } from './ops/handler.js';
import { structureHandlers } from './ops/structure.js';
import { ownValue } from './ops/util.js';
import { nextSeq } from './tree.js';
import type { DesignDoc, Op, Result, RestoreEntry } from './types.js';

// Later tasks add componentHandlers and pageHandlers to this spread.
const handlers: HandlerMap = { ...basicHandlers, ...structureHandlers };

type RestoreOp = Extract<Op, { op: 'restore' }>;

function handlerFor(op: Op): AnyOpHandler | null {
  if (!Object.hasOwn(handlers, op.op)) return null;
  return (handlers[op.op] as AnyOpHandler | undefined) ?? null;
}

function unknownOp(op: Op): string {
  return `Unknown op "${op.op}"`;
}

export function validateOp(doc: DesignDoc, op: Op): string | null {
  const handler = handlerFor(op);
  return handler === null ? unknownOp(op) : handler.validate(doc, op);
}

// Pure: the input doc is never changed. The inverse is a restore op that puts back every
// page, component and token group the op changed, and the seq the doc had before the op.
export function applyOp(doc: DesignDoc, op: Op): Result<{ doc: DesignDoc; inverse: RestoreOp }> {
  const handler = handlerFor(op);
  if (handler === null) return { ok: false, error: unknownOp(op) };

  const error = handler.validate(doc, op);
  if (error !== null) return { ok: false, error };

  const draft: DesignDoc = structuredClone(doc);
  handler.mutate(draft, op);
  draft.meta.seq = nextSeq(draft);

  return {
    ok: true,
    value: {
      doc: draft,
      inverse: { op: 'restore', seq: doc.meta.seq, entries: changedEntries(doc, draft) },
    },
  };
}

// Entries for every page, component and token group whose canonical JSON differs.
// Each value is the copy from `before`, or null when the key did not exist there.
function changedEntries(before: DesignDoc, after: DesignDoc): RestoreEntry[] {
  const entries: RestoreEntry[] = [
    ...changedKeys(before.pages, after.pages).map((key): RestoreEntry => ({
      kind: 'page',
      key,
      value: snapshot(ownValue(before.pages, key)),
    })),
    ...changedKeys(before.components, after.components).map((key): RestoreEntry => ({
      kind: 'component',
      key,
      value: snapshot(ownValue(before.components, key)),
    })),
    ...changedKeys(before.tokens, after.tokens).map((key): RestoreEntry => ({
      kind: 'tokens',
      key,
      value: snapshot(ownValue(before.tokens, key)),
    })),
  ];
  return entries.sort(compareEntries);
}

function changedKeys<T>(before: Record<string, T>, after: Record<string, T>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) => canonicalStringify(ownValue(before, key)) !== canonicalStringify(ownValue(after, key)),
  );
}

function snapshot<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}

const KIND_ORDER: Record<RestoreEntry['kind'], number> = { page: 0, component: 1, tokens: 2 };

function compareEntries(a: RestoreEntry, b: RestoreEntry): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
