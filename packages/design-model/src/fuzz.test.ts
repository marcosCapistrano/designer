import * as fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { allIds, allocIds } from './tree.js';
import { DEVICES, type DesignDoc, type DesignNode, type ElementNode, type Op } from './types.js';
import { validateDoc } from './validate.js';

// Strings an attacker or a careless editor might send as a value or a name.
const HOSTILE = ['"', '<', '!important', '(', 'javascript:x', '__proto__', 'url(', '}', 'var(--x)', 'constructor'];
const text: fc.Arbitrary<string> = fc.oneof(fc.constantFrom(...HOSTILE), fc.string({ maxLength: 8 }));

// One op, described by random numbers. buildOp turns it into a real op against the doc at that point,
// so every id the op uses exists in that doc, is fresh, or is made up on purpose.
interface Spec {
  kind: number;
  a: number;
  b: number;
  c: number;
  s: string;
  v: string | null;
  prop: string;
  tag: string;
  attr: string;
  device: (typeof DEVICES)[number];
}

const spec: fc.Arbitrary<Spec> = fc.record({
  kind: fc.integer({ min: 0, max: 7 }),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
  s: text,
  v: fc.option(text, { nil: null }),
  prop: fc.constantFrom('padding', 'color', '--x', 'Bad Prop', 'margin', 'not-a-prop'),
  tag: fc.constantFrom('div', 'span', 'img', 'script', 'Div', 'section', 'br'),
  attr: fc.constantFrom('href', 'title', 'data-x', 'onclick', 'style', 'class', 'src', 'srcdoc', 'data-d-id'),
  device: fc.constantFrom(...DEVICES),
});

// An id from the doc, a fresh id, or one that is not in the doc.
function pickId(doc: DesignDoc, index: number): string {
  const pool = [...allIds(doc), ...allocIds(doc, 2), 'missing', 'n0'];
  return pool[index % pool.length] ?? 'missing';
}

function freshId(doc: DesignDoc): string {
  const [id] = allocIds(doc, 1);
  if (id === undefined) throw new Error('allocIds returned no id');
  return id;
}

function newNode(doc: DesignDoc, s: Spec): DesignNode {
  const id = s.c % 3 === 0 ? pickId(doc, s.c) : freshId(doc);
  if (s.b % 2 === 0) return { id, kind: 'text', text: s.s };
  return {
    id,
    kind: 'element',
    tag: s.tag,
    attrs: s.v === null ? {} : { [s.attr]: s.v },
    style: { base: {} },
    children: [],
  };
}

function buildOp(doc: DesignDoc, s: Spec): Op {
  const node = pickId(doc, s.a);
  switch (s.kind) {
    case 0:
      return { op: 'setStyle', node, device: s.device, prop: s.prop, value: s.v };
    case 1:
      return { op: 'setText', node, text: s.s };
    case 2:
      return { op: 'setAttr', node, name: s.attr, value: s.v };
    case 3:
      return { op: 'setName', node, name: s.v };
    case 4:
      return { op: 'insertNode', parent: node, index: s.b % 4, node: newNode(doc, s) };
    case 5:
      return { op: 'removeNode', node };
    case 6:
      return { op: 'moveNode', node, parent: pickId(doc, s.b), index: s.c % 4 };
    default: {
      const wrapper: ElementNode = { id: freshId(doc), kind: 'element', tag: s.tag, attrs: {}, style: { base: {} }, children: [] };
      const nodes = s.c % 2 === 0 ? [node] : [node, pickId(doc, s.b)];
      return { op: 'wrapNodes', nodes, wrapper };
    }
  }
}

describe('op fuzz', () => {
  test('random op sequences keep the doc valid and reloadable', () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 30 }), (specs) => {
        let doc = sampleDoc();
        for (const s of specs) {
          const result = applyOp(doc, buildOp(doc, s));
          if (!result.ok) continue;
          doc = result.value.doc;
          expect(validateDoc(doc)).toBeNull();
        }
        expect(validateDoc(doc)).toBeNull();
        expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
      }),
      { numRuns: 200 },
    );
  }, 20000);
});
