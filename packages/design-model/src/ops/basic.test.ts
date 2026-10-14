import { describe, expect, test } from 'vitest';
import { applyOp } from '../apply.js';
import { sampleDoc } from '../fixtures.js';
import { findNode } from '../tree.js';
import type { DesignDoc, Op } from '../types.js';

function applied(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error('expected the op to be rejected');
  return result.error;
}

function attrsOf(doc: DesignDoc, id: string): Record<string, string> {
  const node = findNode(doc, id)?.node;
  if (node?.kind !== 'element') throw new Error(`${id} is not an element`);
  return node.attrs;
}

describe('setAttr values', () => {
  test.each(['javascript:alert(1)', ' JaVa\tscript:x', 'data:text/html,x'])(
    'rejects the unsafe href %j',
    (value) => {
      expect(rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'href', value }))
        .toBe('Unsafe URL in attribute href');
    },
  );

  test('accepts an https href', () => {
    const next = applied(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'href', value: 'https://x' });
    expect(attrsOf(next, 'n3')).toEqual({ href: 'https://x' });
  });

  test('rejects a value that is not a string, as decoded from an op log', () => {
    expect(rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'title', value: 5 as unknown as string }))
      .toBe('Malformed op: setAttr.value must be a string or null');
  });

  test('rejects srcdoc', () => {
    expect(rejected(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'srcdoc', value: '<p>x</p>' }))
      .toBe('Attribute srcdoc is not allowed');
  });

  test('removing an attribute skips the value check', () => {
    const next = applied(sampleDoc(), { op: 'setAttr', node: 'n3', name: 'srcdoc', value: null });
    expect(attrsOf(next, 'n3')).toEqual({});
  });
});
