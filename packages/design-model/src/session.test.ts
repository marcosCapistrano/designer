import { describe, expect, test } from 'vitest';
import { canonicalStringify } from './canonical.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import { applyBatch, classifyBatch, DesignSession, type BatchResult } from './session.js';
import type { DesignDoc, Op } from './types.js';

const PAD_N3: Op = { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12px' };
const PAD_N3_AGAIN: Op = { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '4px' };
const TEXT_N4: Op = { op: 'setText', node: 'n4', text: 'Sign in' };
const NAME_N2: Op = { op: 'setName', node: 'n2', name: 'Top bar' };
const ACCENT: Op = { op: 'setToken', group: 'color', name: 'accent', value: '#ff0000' };
const BAD_PAD: Op = { op: 'setStyle', node: 'n3', device: 'base', prop: 'padding', value: '12' };
const PAD_N7: Op = { op: 'setStyle', node: 'n7', device: 'base', prop: 'padding', value: '8px' };

function canon(doc: DesignDoc): string {
  return canonicalStringify(doc);
}

function okDoc(result: BatchResult): DesignDoc {
  if (!result.ok) throw new Error(`expected ok, got op ${result.index}: ${result.error}`);
  return result.doc;
}

// Applies ops to a doc with the batch function, for building the starting state of a test.
function withOps(doc: DesignDoc, ops: Op[]): DesignDoc {
  const result = applyBatch(doc, ops);
  if (!result.ok) throw new Error(result.error);
  return result.value.doc;
}

describe('applyBatch', () => {
  test('applies every op in order', () => {
    const result = applyBatch(sampleDoc(), [PAD_N3, TEXT_N4]);
    if (!result.ok) throw new Error(result.error);
    expect(findNode(result.value.doc, 'n3')?.node).toMatchObject({ style: { base: { padding: '12px' } } });
    expect(findNode(result.value.doc, 'n4')?.node).toEqual({ id: 'n4', kind: 'text', text: 'Sign in' });
  });

  test('reports the failing op index in the error', () => {
    const result = applyBatch(sampleDoc(), [PAD_N3, BAD_PAD]);
    if (result.ok) throw new Error('expected the batch to be rejected');
    expect(result.error).toMatch(/^op 1: /);
  });

  test('inverse restores the starting doc when applied in order', () => {
    const doc = sampleDoc();
    const result = applyBatch(doc, [PAD_N3, TEXT_N4, NAME_N2]);
    if (!result.ok) throw new Error(result.error);
    const undone = applyBatch(result.value.doc, result.value.inverse);
    if (!undone.ok) throw new Error(undone.error);
    expect(canon(undone.value.doc)).toBe(canon(doc));
  });

  test('inverse is in undo order when two ops touch the same page', () => {
    const doc = sampleDoc();
    const result = applyBatch(doc, [PAD_N3, PAD_N3_AGAIN]);
    if (!result.ok) throw new Error(result.error);
    const undone = applyBatch(result.value.doc, result.value.inverse);
    if (!undone.ok) throw new Error(undone.error);
    expect(canon(undone.value.doc)).toBe(canon(doc));
  });

  test('accepts restore ops, which undo relies on', () => {
    const restore: Op = { op: 'restore', seq: 9, entries: [] };
    const result = applyBatch(sampleDoc(), [restore]);
    expect(result.ok).toBe(true);
  });

  test('an empty batch returns an equal doc and no inverse', () => {
    const doc = sampleDoc();
    const result = applyBatch(doc, []);
    if (!result.ok) throw new Error(result.error);
    expect(canon(result.value.doc)).toBe(canon(doc));
    expect(result.value.inverse).toEqual([]);
  });

  test('never mutates the input doc', () => {
    const doc = sampleDoc();
    const before = canon(doc);
    applyBatch(doc, [PAD_N3, TEXT_N4]);
    applyBatch(doc, [PAD_N3, BAD_PAD]);
    expect(canon(doc)).toBe(before);
  });
});

describe('classifyBatch', () => {
  test.each<[string, Op]>([
    ['setStyle on a page node', PAD_N3],
    ['setText on a page text node', TEXT_N4],
    ['setAttr on a page node', { op: 'setAttr', node: 'n3', name: 'type', value: 'submit' }],
    ['setName on a page node', NAME_N2],
    ['setInstanceProp on a page instance', { op: 'setInstanceProp', node: 'n5', prop: 'title', value: 'Hi' }],
  ])('single %s is immediate', (_label, op) => {
    expect(classifyBatch(sampleDoc(), [op])).toBe('immediate');
  });

  test('component edits need preview', () => {
    expect(classifyBatch(sampleDoc(), [PAD_N7])).toBe('preview');
  });

  test('multi-op batch needs preview', () => {
    expect(classifyBatch(sampleDoc(), [PAD_N3, TEXT_N4])).toBe('preview');
  });

  test('empty batch needs preview', () => {
    expect(classifyBatch(sampleDoc(), [])).toBe('preview');
  });

  test('setToken needs preview', () => {
    expect(classifyBatch(sampleDoc(), [ACCENT])).toBe('preview');
  });

  test('removeNode needs preview', () => {
    expect(classifyBatch(sampleDoc(), [{ op: 'removeNode', node: 'n3' }])).toBe('preview');
  });

  test('an unknown node needs preview', () => {
    expect(classifyBatch(sampleDoc(), [{ ...PAD_N3, node: 'n99' }])).toBe('preview');
  });
});

describe('DesignSession', () => {
  test('a failing batch changes nothing', () => {
    const session = new DesignSession(sampleDoc());
    const result = session.apply([PAD_N3, TEXT_N4, BAD_PAD, NAME_N2]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the batch to be rejected');
    expect(result.index).toBe(2);
    expect(result.error).toContain('padding');
    expect(canon(session.doc)).toBe(canon(sampleDoc()));
    expect(session.changelist()).toEqual([]);
    expect(session.undo()).toBe(false);
  });

  test('a failing batch leaves the redo stack alone', () => {
    const session = new DesignSession(sampleDoc());
    okDoc(session.apply([PAD_N3]));
    const afterFirst = canon(session.doc);
    expect(session.undo()).toBe(true);
    expect(session.apply([TEXT_N4, BAD_PAD]).ok).toBe(false);
    expect(session.redo()).toBe(true);
    expect(canon(session.doc)).toBe(afterFirst);
  });

  test('undo and redo move the doc and the changelist', () => {
    const batchA = [PAD_N3];
    const batchB = [TEXT_N4, NAME_N2];
    const session = new DesignSession(sampleDoc());

    okDoc(session.apply(batchA));
    const afterA = canon(session.doc);
    okDoc(session.apply(batchB));
    const afterB = canon(session.doc);
    expect(afterB).not.toBe(afterA);

    expect(session.undo()).toBe(true);
    expect(canon(session.doc)).toBe(afterA);
    expect(session.changelist()).toEqual(batchA);

    expect(session.redo()).toBe(true);
    expect(canon(session.doc)).toBe(afterB);
    expect(session.changelist()).toEqual([...batchA, ...batchB]);
  });

  test('undo all the way returns to the starting doc', () => {
    const session = new DesignSession(sampleDoc());
    okDoc(session.apply([PAD_N3]));
    okDoc(session.apply([TEXT_N4]));
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false);
    expect(canon(session.doc)).toBe(canon(sampleDoc()));
    expect(session.changelist()).toEqual([]);
  });

  test('a new apply clears redo', () => {
    const batchA = [PAD_N3];
    const batchC = [TEXT_N4];
    const session = new DesignSession(sampleDoc());
    okDoc(session.apply(batchA));
    okDoc(session.apply([NAME_N2]));
    expect(session.undo()).toBe(true);
    okDoc(session.apply(batchC));
    expect(session.redo()).toBe(false);
    expect(session.changelist()).toEqual([...batchA, ...batchC]);
  });

  test('undo and redo on an empty history return false', () => {
    const session = new DesignSession(sampleDoc());
    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(false);
  });

  test('changelist includes loaded changes first, and they are not undoable', () => {
    const loaded: Op[][] = [[TEXT_N4], [NAME_N2]];
    const start = withOps(sampleDoc(), loaded.flat());
    const session = new DesignSession(start, loaded);

    okDoc(session.apply([PAD_N3]));
    expect(session.changelist()).toEqual([TEXT_N4, NAME_N2, PAD_N3]);

    expect(session.undo()).toBe(true);
    expect(session.changelist()).toEqual([TEXT_N4, NAME_N2]);
    expect(session.undo()).toBe(false);
    expect(canon(session.doc)).toBe(canon(start));
  });

  test('keeps its own copies of the doc, the loaded changes and the batches', () => {
    const doc = sampleDoc();
    const loaded: Op[][] = [[TEXT_N4]];
    const session = new DesignSession(doc, loaded);
    const batch: Op[] = [PAD_N3];
    okDoc(session.apply(batch));
    const before = canon(session.doc);

    doc.tokens.color = { primary: 'changed' };
    loaded.push([NAME_N2]);
    batch.push(TEXT_N4);

    expect(canon(session.doc)).toBe(before);
    expect(session.changelist()).toEqual([TEXT_N4, PAD_N3]);
  });

  test('an empty batch changes nothing and leaves history alone', () => {
    const session = new DesignSession(sampleDoc());
    okDoc(session.apply([PAD_N3]));
    expect(session.undo()).toBe(true);
    const before = canon(session.doc);
    okDoc(session.apply([]));
    expect(canon(session.doc)).toBe(before);
    expect(session.redo()).toBe(true);
  });

  test('preview returns the result without committing', () => {
    const session = new DesignSession(sampleDoc());
    const previewed = okDoc(session.preview([PAD_N3, TEXT_N4]));
    expect(canon(previewed)).not.toBe(canon(sampleDoc()));
    expect(canon(session.doc)).toBe(canon(sampleDoc()));
    expect(session.changelist()).toEqual([]);
    expect(session.undo()).toBe(false);

    const committed = okDoc(session.apply([PAD_N3, TEXT_N4]));
    expect(canon(committed)).toBe(canon(previewed));
  });

  test('preview reports a failing op like apply does', () => {
    const session = new DesignSession(sampleDoc());
    const result = session.preview([PAD_N3, BAD_PAD]);
    expect(result).toMatchObject({ ok: false, index: 1 });
  });

  test.each(['apply', 'preview'] as const)('%s rejects restore ops', (method) => {
    const session = new DesignSession(sampleDoc());
    const restore: Op = { op: 'restore', seq: 9, entries: [] };
    expect(session[method]([PAD_N3, restore])).toEqual({
      ok: false,
      index: 1,
      error: 'restore ops are internal',
    });
    expect(canon(session.doc)).toBe(canon(sampleDoc()));
    expect(session.changelist()).toEqual([]);
  });
});
