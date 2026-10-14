import * as fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { exportPage } from './export.js';
import { parseDoc, serializeDoc } from './files.js';
import { applyBatch, DesignSession } from './session.js';
import { sampleDoc } from './fixtures.js';
import { cycleError } from './ops/util.js';
import { allocIds, findNode, isDescendant, walkDoc, type Container } from './tree.js';
import { DEVICES, type DesignDoc, type DesignNode, type Op } from './types.js';

const RUNS = 200;
// The brief's values, each paired with a prop it is valid for. Pairing them freely would make invalid ops.
const STYLE_CHOICES: { prop: 'padding' | 'color'; value: string | null }[] = [
  { prop: 'padding', value: '4px' },
  { prop: 'padding', value: '8px' },
  { prop: 'padding', value: '1rem' },
  { prop: 'padding', value: null },
  { prop: 'color', value: 'red' },
  { prop: 'color', value: '#000' },
  { prop: 'color', value: null },
];

function containerKey(container: Container): string {
  return `${container.kind}:${container.key}`;
}

function freshId(doc: DesignDoc): string {
  const [id] = allocIds(doc, 1);
  if (id === undefined) throw new Error('allocIds returned no id');
  return id;
}

// What a random op can target in one doc. Every entry is valid against that doc.
interface Facts {
  styled: string[]; // element and instance ids
  texts: string[];
  elements: { id: string; childCount: number }[];
  removable: string[]; // non-root nodes
  moves: { node: string; parent: string; maxIndex: number }[];
}

function factsOf(doc: DesignDoc): Facts {
  const roots = new Set([
    ...Object.values(doc.pages).map((page) => page.root.id),
    ...Object.values(doc.components).map((def) => def.root.id),
  ]);
  const nodes: { node: DesignNode; container: Container }[] = [];
  walkDoc(doc, (node, container) => {
    nodes.push({ node, container });
  });

  const facts: Facts = { styled: [], texts: [], elements: [], removable: [], moves: [] };
  for (const { node } of nodes) {
    if (node.kind === 'text') {
      facts.texts.push(node.id);
      continue;
    }
    facts.styled.push(node.id);
    if (node.kind === 'element') facts.elements.push({ id: node.id, childCount: node.children.length });
  }

  for (const { node, container } of nodes) {
    if (roots.has(node.id)) continue;
    facts.removable.push(node.id);

    const hit = findNode(doc, node.id);
    if (hit === null || hit.parent === null) continue;
    if (cycleError(doc, container, [node]) !== null) continue;

    for (const target of nodes) {
      if (target.node.kind !== 'element') continue;
      if (containerKey(target.container) !== containerKey(container)) continue;
      if (isDescendant(node, target.node.id)) continue;
      // The index counts the target's children after the node is detached from them.
      const detached = hit.parent.id === target.node.id ? 1 : 0;
      facts.moves.push({
        node: node.id,
        parent: target.node.id,
        maxIndex: target.node.children.length - detached,
      });
    }
  }
  return facts;
}

// One arbitrary over every op kind that can be valid against doc. Each value is valid against doc.
function opArbitrary(doc: DesignDoc): fc.Arbitrary<Op> {
  const facts = factsOf(doc);
  const arbs: fc.Arbitrary<Op>[] = [];

  if (facts.styled.length > 0) {
    arbs.push(
      fc
        .record({
          node: fc.constantFrom(...facts.styled),
          device: fc.constantFrom(...DEVICES),
          style: fc.constantFrom(...STYLE_CHOICES),
        })
        .map(
          ({ node, device, style }): Op => ({
            op: 'setStyle',
            node,
            device,
            prop: style.prop,
            value: style.value,
          }),
        ),
    );
  }

  if (facts.texts.length > 0) {
    arbs.push(
      fc
        .record({ node: fc.constantFrom(...facts.texts), text: fc.string({ maxLength: 12 }) })
        .map((fields): Op => ({ op: 'setText', ...fields })),
    );
  }

  if (facts.elements.length > 0) {
    const id = freshId(doc);
    arbs.push(
      fc.constantFrom(...facts.elements).chain((parent) =>
        fc
          .record({
            index: fc.integer({ min: 0, max: parent.childCount }),
            text: fc.string({ maxLength: 12 }),
          })
          .map((fields): Op => ({
            op: 'insertNode',
            parent: parent.id,
            index: fields.index,
            node: { id, kind: 'text', text: fields.text },
          })),
      ),
    );
  }

  if (facts.removable.length > 0) {
    arbs.push(fc.constantFrom(...facts.removable).map((node): Op => ({ op: 'removeNode', node })));
  }

  if (facts.moves.length > 0) {
    arbs.push(
      fc.constantFrom(...facts.moves).chain((move) =>
        fc
          .integer({ min: 0, max: move.maxIndex })
          .map((index): Op => ({ op: 'moveNode', node: move.node, parent: move.parent, index })),
      ),
    );
  }

  return fc.oneof(...arbs);
}

// Draws the rest of a sequence on top of doc. Each op is valid against the doc the ops before it produce.
function sequenceFrom(doc: DesignDoc, length: number): fc.Arbitrary<Op[]> {
  if (length === 0) return fc.constant<Op[]>([]);
  return opArbitrary(doc).chain((op) => {
    const next = applyBatch(doc, [op]);
    if (!next.ok) throw new Error(`generator produced an invalid op: ${next.error}`);
    return sequenceFrom(next.value.doc, length - 1).map((rest): Op[] => [op, ...rest]);
  });
}

// 1 to 15 ops, each valid against the doc that precedes it, starting from sampleDoc().
const opSequence: fc.Arbitrary<Op[]> = fc
  .integer({ min: 1, max: 15 })
  .chain((length) => sequenceFrom(sampleDoc(), length));

// One op per batch. A rejected op means the generator or a handler is wrong.
function applyOne(session: DesignSession, op: Op): void {
  const result = session.apply([op]);
  if (!result.ok) throw new Error(`op rejected: ${result.error}`);
}

function withoutMeta(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'meta.json'));
}

function expectRoundtrip(doc: DesignDoc): void {
  expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
}

describe('op sequence properties', () => {
  test('undo all returns the original', () => {
    fc.assert(
      fc.property(opSequence, (ops) => {
        const start = sampleDoc();
        const session = new DesignSession(start);
        for (const op of ops) applyOne(session, op);
        for (let i = 0; i < ops.length; i++) expect(session.undo()).toBe(true);
        expect(session.undo()).toBe(false);
        expect(withoutMeta(serializeDoc(session.doc))).toEqual(withoutMeta(serializeDoc(start)));
      }),
      { numRuns: RUNS },
    );
  });

  test('replay is deterministic', () => {
    fc.assert(
      fc.property(opSequence, (ops) => {
        const session = new DesignSession(sampleDoc());
        for (const op of ops) applyOne(session, op);

        const replay = new DesignSession(sampleDoc());
        for (const op of session.changelist()) applyOne(replay, op);
        expect(serializeDoc(replay.doc)).toEqual(serializeDoc(session.doc));
      }),
      { numRuns: RUNS },
    );
  });

  test('serialize roundtrip', () => {
    fc.assert(
      fc.property(opSequence, (ops) => {
        const session = new DesignSession(sampleDoc());
        expectRoundtrip(session.doc);
        for (const op of ops) {
          applyOne(session, op);
          expectRoundtrip(session.doc);
        }
      }),
      { numRuns: RUNS },
    );
  });

  test('export never throws', () => {
    fc.assert(
      fc.property(opSequence, (ops) => {
        const session = new DesignSession(sampleDoc());
        expect(exportPage(session.doc, 'home').ok).toBe(true);
        for (const op of ops) {
          applyOne(session, op);
          expect(exportPage(session.doc, 'home').ok).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('structural undo and redo', () => {
  test('undo then redo of insert, move and remove restores the edited doc', () => {
    const session = new DesignSession(sampleDoc());
    applyOne(session, { op: 'insertNode', parent: 'n2', index: 1, node: { id: 'n9', kind: 'text', text: 'Hi' } });
    applyOne(session, { op: 'moveNode', node: 'n5', parent: 'n2', index: 0 });
    applyOne(session, { op: 'removeNode', node: 'n3' });
    const edited = serializeDoc(session.doc);

    for (let i = 0; i < 3; i++) expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false);
    expect(withoutMeta(serializeDoc(session.doc))).toEqual(withoutMeta(serializeDoc(sampleDoc())));

    for (let i = 0; i < 3; i++) expect(session.redo()).toBe(true);
    expect(session.redo()).toBe(false);
    expect(serializeDoc(session.doc)).toEqual(edited);
  });
});
