import { describe, expect, test } from 'vitest';

// The runtime exports of index.ts, sorted. A new export must be added here on purpose.
const PUBLIC_EXPORTS = [
  'DEVICES',
  'DesignSession',
  'allIds',
  'allocIds',
  'applyBatch',
  'applyOp',
  'canonicalStringify',
  'classifyBatch',
  'decodeOpLog',
  'describeOp',
  'encodeOpLog',
  'exportPage',
  'findNode',
  'parseDoc',
  'sampleDoc',
  'serializeDoc',
  'validateDoc',
  'validateOp',
  'validateStyle',
  'walkDoc',
];

const INTERNAL_EXPORTS = ['validateOpInternal', 'applyOpInternal', 'opProblem'];

describe('public surface', () => {
  test('exports exactly the public surface', async () => {
    const names = Object.keys(await import('./index.js')).sort();
    expect(names).toEqual(PUBLIC_EXPORTS);
  });

  test('does not export the internal validators, appliers or op shape check', async () => {
    const names = Object.keys(await import('./index.js'));
    for (const internal of INTERNAL_EXPORTS) expect(names).not.toContain(internal);
  });
});
