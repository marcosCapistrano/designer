import {
  allIds,
  applyOp,
  canonicalStringify,
  exportPage,
  sampleDoc,
  type DesignDoc,
  type Page,
} from '@hub/design-model';
import { describe, expect, it } from 'vitest';
import { generateDoc } from './generate.js';

describe('generateDoc', () => {
  it('sample home plus generated pages', () => {
    expect(Object.keys(generateDoc({ pages: 5, seed: 1 }).pages).sort()).toEqual([
      'gen-02',
      'gen-03',
      'gen-04',
      'gen-05',
      'home',
    ]);
  });

  it('pages: 1 is just home', () => {
    expect(Object.keys(generateDoc({ pages: 1, seed: 1 }).pages)).toEqual(['home']);
  });

  it('deterministic per seed', () => {
    const a = canonicalStringify(generateDoc({ pages: 5, seed: 1 }));
    const b = canonicalStringify(generateDoc({ pages: 5, seed: 1 }));
    const c = canonicalStringify(generateDoc({ pages: 5, seed: 2 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('prefix-stable', () => {
    expect(generateDoc({ pages: 3, seed: 1 }).pages['gen-02']).toEqual(
      generateDoc({ pages: 50, seed: 1 }).pages['gen-02'],
    );
  });

  it('valid as addPage ops', () => {
    const generated = generateDoc({ pages: 10, seed: 1 });
    let doc: DesignDoc = sampleDoc();
    const ids = Object.keys(generated.pages)
      .filter((id) => id !== 'home')
      .sort();
    for (const id of ids) {
      const page = generated.pages[id] as Page;
      const result = applyOp(doc, { op: 'addPage', page });
      expect(result.ok).toBe(true);
      if (result.ok) doc = result.value.doc;
    }
    expect(Object.keys(doc.pages).sort()).toEqual(Object.keys(generated.pages).sort());
  });

  it('every page exports', () => {
    const doc = generateDoc({ pages: 10, seed: 1 });
    for (const id of Object.keys(doc.pages)) {
      expect(exportPage(doc, id).ok, id).toBe(true);
    }
  });

  it('ids unique and below meta.seq', () => {
    const doc = generateDoc({ pages: 10, seed: 1 });
    const ids = allIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const match = /^n(\d+)$/.exec(id);
      if (match) expect(Number(match[1])).toBeLessThan(doc.meta.seq);
    }
  });
});
