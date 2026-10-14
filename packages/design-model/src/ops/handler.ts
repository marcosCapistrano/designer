import type { DesignDoc, Op } from '../types.js';

// `validate` returns a reason, or null when the op may run. `mutate` runs only after validate
// passed, on a structuredClone of the doc, and edits that clone in place. A mutate must copy
// any object it takes from the op before storing it in the draft.
export interface OpHandler<K extends Op['op']> {
  validate(doc: DesignDoc, op: Extract<Op, { op: K }>): string | null;
  mutate(draft: DesignDoc, op: Extract<Op, { op: K }>): void;
}

export type HandlerMap = { [K in Op['op']]?: OpHandler<K> };

// The handler for an op whose kind is only known at runtime.
export type AnyOpHandler = OpHandler<Op['op']>;
