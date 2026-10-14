import { applyOpInternal } from './apply.js';
import { opProblem } from './shape.js';
import { findNode } from './tree.js';
import type { DesignDoc, Op, Result } from './types.js';

export type BatchResult = { ok: true; doc: DesignDoc } | { ok: false; index: number; error: string };

type Run =
  | { ok: true; doc: DesignDoc; inverse: Op[] }
  | { ok: false; index: number; error: string };

// The first op that is malformed, or that is a restore op (produced by undo, never supplied), or null.
function refuseOps(ops: Op[]): { index: number; error: string } | null {
  for (const [index, op] of ops.entries()) {
    const problem = opProblem(op);
    if (problem !== null) return { index, error: problem };
  }
  return null;
}

// Runs the ops in order. The first failing op stops the run, and the input is untouched: applyOpInternal
// copies the doc before it edits it, so the run does not copy it again. Only an empty batch has no op to make
// that copy, so it is made here, and the doc returned is never the one passed in.
// Callers check the ops with refuseOps first, except undo and redo, which run restore ops.
function run(doc: DesignDoc, ops: Op[]): Run {
  let current = ops.length === 0 ? structuredClone(doc) : doc;
  const inverses: Op[] = [];
  for (const [index, op] of ops.entries()) {
    const result = applyOpInternal(current, op);
    if (!result.ok) return { ok: false, index, error: result.error };
    current = result.value.doc;
    inverses.push(result.value.inverse);
  }
  // Undo must run the inverses newest first, so the last op's inverse is applied first.
  return { ok: true, doc: current, inverse: inverses.reverse() };
}

export function applyBatch(doc: DesignDoc, ops: Op[]): Result<{ doc: DesignDoc; inverse: Op[] }> {
  const refused = refuseOps(ops);
  if (refused !== null) return { ok: false, error: `op ${refused.index}: ${refused.error}` };
  const result = run(doc, ops);
  if (!result.ok) return { ok: false, error: `op ${result.index}: ${result.error}` };
  return { ok: true, value: { doc: result.doc, inverse: result.inverse } };
}

// The node an op edits, for the kinds that can be edited immediately.
function immediateTarget(op: Op): string | null {
  switch (op.op) {
    case 'setStyle':
    case 'setText':
    case 'setAttr':
    case 'setName':
    case 'setInstanceProp':
      return op.node;
    default:
      return null;
  }
}

export function classifyBatch(doc: DesignDoc, ops: Op[]): 'immediate' | 'preview' {
  const [op] = ops;
  if (ops.length !== 1 || op === undefined || opProblem(op) !== null) return 'preview';
  const node = immediateTarget(op);
  if (node === null) return 'preview';
  return findNode(doc, node)?.container.kind === 'page' ? 'immediate' : 'preview';
}

interface Batch {
  ops: Op[];
  inverse: Op[];
}

// Freezes the value and everything in it, and returns it. A doc is plain JSON data, so walking the
// object values reaches all of it.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// The batches already applied, checked like any other ops (a restore op is refused) and copied, or
// why they cannot be loaded.
function loadChanges(changes: unknown): Result<Op[][]> {
  const refuse = (reason: string): Result<Op[][]> => ({ ok: false, error: `DesignSession: ${reason}` });
  if (!Array.isArray(changes)) return refuse('changes must be an array of batches');
  for (const [b, batch] of changes.entries()) {
    if (!Array.isArray(batch)) return refuse(`changes[${b}] must be an array of ops`);
    for (const [i, op] of batch.entries()) {
      const problem = opProblem(op);
      if (problem !== null) return refuse(`changes[${b}][${i}]: ${problem}`);
    }
  }
  try {
    return { ok: true, value: structuredClone(changes) as Op[][] };
  } catch {
    // A well-formed op can still carry an extra field that cannot be copied, such as a function.
    return refuse('changes must be plain data');
  }
}

// Holds the current doc and its history. The doc is frozen: callers read it, and a change to it throws
// a TypeError, so it can be handed out without a copy. Each edit makes a new doc and leaves the old
// one as it was. Docs from preview and applyBatch are the caller's own and are not frozen.
export class DesignSession {
  #doc: DesignDoc;
  readonly #loaded: Op[][];
  #undo: Batch[] = [];
  #redo: Batch[] = [];

  // `doc` already includes the `changes` batches, which are part of the changelist but cannot be undone.
  // A constructor cannot return a Result, so it throws a TypeError when `changes` is not an array of
  // batches of well-formed ops, or holds a restore op. DesignSession.create reports that as an error value.
  constructor(doc: DesignDoc, changes: Op[][] = []) {
    const loaded = loadChanges(changes);
    if (!loaded.ok) throw new TypeError(loaded.error);
    this.#doc = deepFreeze(structuredClone(doc));
    this.#loaded = loaded.value;
  }

  // The same as the constructor, except that bad `changes` come back as an error and nothing is thrown.
  static create(doc: DesignDoc, changes: Op[][] = []): Result<DesignSession> {
    try {
      return { ok: true, value: new DesignSession(doc, changes) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'DesignSession: could not be created' };
    }
  }

  get doc(): DesignDoc {
    return this.#doc;
  }

  // Atomic: on failure the doc, the history and the redo stack are unchanged.
  apply(ops: Op[]): BatchResult {
    const refused = refuseOps(ops);
    if (refused !== null) return { ok: false, ...refused };
    if (ops.length === 0) return { ok: true, doc: this.#doc };
    const result = run(this.#doc, ops);
    if (!result.ok) return { ok: false, index: result.index, error: result.error };
    this.#undo.push({ ops: structuredClone(ops), inverse: result.inverse });
    this.#redo = [];
    this.#doc = deepFreeze(result.doc);
    return { ok: true, doc: this.#doc };
  }

  // Same checks as apply, but the session is never changed.
  preview(ops: Op[]): BatchResult {
    const refused = refuseOps(ops);
    if (refused !== null) return { ok: false, ...refused };
    const result = run(this.#doc, ops);
    if (!result.ok) return { ok: false, index: result.index, error: result.error };
    return { ok: true, doc: result.doc };
  }

  // Throws only if a stored inverse fails, which cannot happen for history this session recorded.
  undo(): boolean {
    const batch = this.#undo.at(-1);
    if (batch === undefined) return false;
    const result = run(this.#doc, batch.inverse);
    if (!result.ok) throw new Error(`undo failed: op ${result.index}: ${result.error}`);
    this.#undo.pop();
    this.#redo.push(batch);
    this.#doc = deepFreeze(result.doc);
    return true;
  }

  // Throws only if replaying a recorded batch fails, which cannot happen for history this session recorded.
  redo(): boolean {
    const batch = this.#redo.at(-1);
    if (batch === undefined) return false;
    const result = run(this.#doc, batch.ops);
    if (!result.ok) throw new Error(`redo failed: op ${result.index}: ${result.error}`);
    this.#redo.pop();
    this.#undo.push(batch);
    this.#doc = deepFreeze(result.doc);
    return true;
  }

  // Loaded changes first, then the applied batches that are not undone, in order.
  changelist(): Op[] {
    return structuredClone([...this.#loaded.flat(), ...this.#undo.flatMap((batch) => batch.ops)]);
  }
}
