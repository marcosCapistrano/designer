import { describe, expect, it } from 'vitest';
import type { ImportResponse } from '@hub/protocol';
import { importNote } from './import-result.js';

const applied = (patch: Partial<Extract<ImportResponse, { ok: true }>>): Extract<ImportResponse, { ok: true }> => ({ ok: true, revision: 'r', rebuilt: ['/a'], reused: [], removed: [], failed: [], inlined: [], sourceOnlyRules: 0, manifest: null, warnings: [], ...patch });

describe('import result note', () => {
  it('summarizes pages without optional counts when there are none', () => {
    expect(importNote(applied({}))).toBe('Imported 1 pages; reused 0.');
  });
  it('counts failed routes, distinct inlined components and source-only rules in plain words', () => {
    const note = importNote(applied({
      removed: ['/old'],
      failed: [{ route: '/b', diagnostics: [{ file: 'b.tsx', message: 'Unsupported' }] }],
      inlined: [{ route: '/a', component: 'Card', file: 'card.tsx', reason: 'children' }, { route: '/c', component: 'Card', file: 'card.tsx', reason: 'children' }, { route: '/a', component: 'Chip', file: 'chip.tsx', reason: 'prop-css' }],
      sourceOnlyRules: 1,
    }));
    expect(note).toBe('Imported 1 pages; reused 0. Removed 1 source routes. 1 route failed to import. 2 inlined components. 1 hover/print rule not shown.');
    expect(importNote(applied({ failed: [{ route: '/b', diagnostics: [] }, { route: '/c', diagnostics: [] }], inlined: [{ route: '/a', component: 'Card', file: 'card.tsx', reason: 'children' }], sourceOnlyRules: 4 })))
      .toBe('Imported 1 pages; reused 0. 2 routes failed to import. 1 inlined component. 4 hover/print rules not shown.');
  });
});
