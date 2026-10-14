import { describe, expect, test } from 'vitest';
import { applyOp, applyOpInternal } from '../apply.js';
import { canonicalStringify } from '../canonical.js';
import { sampleDoc } from '../fixtures.js';
import { nodeProblem } from '../shape.js';
import type { DesignDoc, DesignNode, ElementNode, Op, Page } from '../types.js';

type DuplicatePage = Extract<Op, { op: 'duplicatePage' }>;

const TOO_DEEP = 'Node tree deeper than 64 levels';

function applied(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

// Undo applies a restore op, which only the internal path accepts.
function undoneBy(doc: DesignDoc, inverse: Op): DesignDoc {
  const result = applyOpInternal(doc, inverse);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function rejected(doc: DesignDoc, op: Op): string {
  const result = applyOp(doc, op);
  if (result.ok) throw new Error('expected the op to be rejected');
  return result.error;
}

function pageOf(doc: DesignDoc, id: string): Page {
  const page = doc.pages[id];
  if (page === undefined) throw new Error(`fixture is missing page ${id}`);
  return page;
}

// Everything an op can change, in canonical form. meta.seq is left out: undo never lowers it.
function content(doc: DesignDoc): string[] {
  return [doc.pages, doc.components, doc.tokens].map((part) => canonicalStringify(part));
}

function element(id: string, children: DesignNode[] = [], tag = 'section'): ElementNode {
  return { id, kind: 'element', tag, attrs: {}, style: { base: {} }, children };
}

function text(id: string, value = 'x'): DesignNode {
  return { id, kind: 'text', text: value };
}

// A chain of `height` levels: element nodes down to one text leaf. Ids are `${prefix}1` to `${prefix}${height}`.
function chain(height: number, prefix: string): DesignNode {
  let node: DesignNode = text(`${prefix}${height}`);
  for (let level = height - 1; level >= 1; level--) {
    node = element(`${prefix}${level}`, [node]);
  }
  return node;
}

const pricing: Page = {
  id: 'pricing',
  name: 'Pricing',
  route: '/pricing',
  root: element('n9', [text('n10', 'Plans')], 'main'),
};

// Maps every node id of the sample home page (n1 to n5) to a new id.
const HOME_IDS: Record<string, string> = { n1: 'n10', n2: 'n11', n3: 'n12', n4: 'n13', n5: 'n14' };

function homeCopy(idMap: Record<string, string> = { ...HOME_IDS }): DuplicatePage {
  return {
    op: 'duplicatePage',
    source: 'home',
    page: { id: 'home-b', name: 'Home B', route: '/b' },
    idMap,
  };
}

describe('addPage', () => {
  test('adds a page at a new route', () => {
    const next = applied(sampleDoc(), { op: 'addPage', page: pricing });
    expect(Object.keys(next.pages)).toEqual(['home', 'pricing']);
    expect(pageOf(next, 'pricing')).toEqual(pricing);
    expect(next.meta.seq).toBe(11);
  });

  test('stores a copy, not the page object from the op', () => {
    const next = applied(sampleDoc(), { op: 'addPage', page: pricing });
    expect(pageOf(next, 'pricing')).not.toBe(pricing);
    expect(pageOf(next, 'pricing').root).not.toBe(pricing.root);
  });

  test('rejects a page id that is already used', () => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, id: 'home', route: '/other' },
    })).toBe('Page home already exists');
  });

  test('rejects a duplicate route', () => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, route: '/' },
    })).toBe('Route / already used');
  });

  test.each(['Pricing', 'Home', 'a/b', 'pricing_page', 'pricing page', ''])('rejects the page id %j', (id) => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, id },
    })).toBe(`Invalid page id "${id}"`);
  });

  test('rejects a route without a leading slash', () => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, route: 'pricing' },
    })).toBe('Route pricing must start with /');
  });

  test.each(['constructor', 'prototype'])('rejects the page id %s, an Object.prototype member', (id) => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, id, route: '/c' },
    })).toBe(`Invalid page id "${id}"`);
  });

  test('rejects a root id that is already in the document', () => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, root: element('n2') },
    })).toBe('Id n2 already exists');
  });

  test('rejects an invalid tag in the page', () => {
    expect(rejected(sampleDoc(), {
      op: 'addPage', page: { ...pricing, root: element('n9', [], 'Main') },
    })).toBe('Invalid tag "Main"');
  });

  test('undo removes the page', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'addPage', page: pricing });
    if (!result.ok) throw new Error(result.error);
    expect(content(undoneBy(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });
});

describe('duplicatePage', () => {
  test('copies home at /b with every id remapped', () => {
    const next = applied(sampleDoc(), homeCopy());
    expect(pageOf(next, 'home-b')).toEqual({
      id: 'home-b',
      name: 'Home B',
      route: '/b',
      root: {
        id: 'n10', kind: 'element', tag: 'main', attrs: {}, style: { base: {} },
        children: [
          {
            id: 'n11', kind: 'element', name: 'Header', tag: 'header', attrs: {}, style: { base: {} },
            children: [
              {
                id: 'n12', kind: 'element', name: 'LoginButton', tag: 'button', attrs: {},
                style: { base: { padding: '8px' } },
                children: [{ id: 'n13', kind: 'text', text: 'Log in' }],
              },
            ],
          },
          {
            id: 'n14', kind: 'instance', name: 'Card', component: 'Card',
            props: { title: 'Hello' }, style: { base: {} },
          },
        ],
      },
    });
  });

  test('leaves the original page and the components unchanged', () => {
    const doc = sampleDoc();
    const before = canonicalStringify(doc);
    const next = applied(doc, homeCopy());
    expect(canonicalStringify(doc)).toBe(before);
    expect(pageOf(next, 'home')).toEqual(pageOf(doc, 'home'));
    expect(next.components).toEqual(doc.components);
  });

  test('the copy shares no objects with the source page', () => {
    const next = applied(sampleDoc(), homeCopy());
    expect(pageOf(next, 'home-b').root).not.toBe(pageOf(next, 'home').root);
  });

  test('rejects an incomplete idMap', () => {
    expect(rejected(sampleDoc(), homeCopy({ n1: 'n10', n2: 'n11', n3: 'n12', n4: 'n13' })))
      .toBe('idMap has no entry for n5');
  });

  test('rejects an idMap value that is already in use', () => {
    expect(rejected(sampleDoc(), homeCopy({ ...HOME_IDS, n5: 'n2' }))).toBe('Id n2 already exists');
  });

  test('rejects two nodes mapped to the same new id', () => {
    expect(rejected(sampleDoc(), homeCopy({ ...HOME_IDS, n5: 'n10' }))).toBe('Id n10 already exists');
  });

  test('rejects an entry for a node outside the source page', () => {
    expect(rejected(sampleDoc(), homeCopy({ ...HOME_IDS, n6: 'n15' })))
      .toBe('idMap has an entry for n6 that is not in the page');
  });

  test('rejects a missing source page', () => {
    expect(rejected(sampleDoc(), { ...homeCopy(), source: 'about' })).toBe('Page about not found');
  });

  test('rejects a page id that is already used', () => {
    expect(rejected(sampleDoc(), {
      ...homeCopy(), page: { id: 'home', name: 'Copy', route: '/copy' },
    })).toBe('Page home already exists');
  });

  test('rejects a route that is already used', () => {
    expect(rejected(sampleDoc(), {
      ...homeCopy(), page: { id: 'home-b', name: 'Home B', route: '/' },
    })).toBe('Route / already used');
  });

  test('rejects an invalid page id', () => {
    expect(rejected(sampleDoc(), {
      ...homeCopy(), page: { id: 'Home B', name: 'Home B', route: '/b' },
    })).toBe('Invalid page id "Home B"');
  });

  test.each(['constructor', 'a/b'])('rejects the page id %j', (id) => {
    expect(rejected(sampleDoc(), {
      ...homeCopy(), page: { id, name: 'Copy', route: '/c' },
    })).toBe(`Invalid page id "${id}"`);
  });

  test('undo removes the copy', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, homeCopy());
    if (!result.ok) throw new Error(result.error);
    expect(content(undoneBy(result.value.doc, result.value.inverse))).toEqual(content(doc));
  });
});

// Every id under `node`, in walk order.
function idsOf(node: DesignNode): string[] {
  return node.kind === 'element' ? [node.id, ...node.children.flatMap(idsOf)] : [node.id];
}

describe('duplicatePage whole-tree depth', () => {
  // The home root gains a chain of 63 levels, so the root itself is 64 levels tall.
  function homeWithDeepRoot(): DesignDoc {
    return applied(sampleDoc(), { op: 'insertNode', parent: 'n1', index: 0, node: chain(63, 'd') });
  }

  function copyOfHome(doc: DesignDoc): DuplicatePage {
    const ids = idsOf(pageOf(doc, 'home').root);
    return {
      op: 'duplicatePage',
      source: 'home',
      page: { id: 'home-b', name: 'Home B', route: '/b' },
      idMap: Object.fromEntries(ids.map((id, i) => [id, `x${i}`])),
    };
  }

  test('applies a copy whose root is exactly 64 levels tall', () => {
    const doc = homeWithDeepRoot();
    const next = applied(doc, copyOfHome(doc));
    expect(nodeProblem(pageOf(next, 'home-b').root)).toBeNull();
  });

  test('rejects a copy whose root would be 65 levels tall', () => {
    // The source is already past the limit, which the ops never allow. Only the copy's check can stop it.
    const doc = sampleDoc();
    pageOf(doc, 'home').root.children.push(chain(64, 'd'));
    expect(rejected(doc, copyOfHome(doc))).toBe(TOO_DEEP);
  });
});

describe('removePage', () => {
  test('removes home, and undo restores it', () => {
    const doc = sampleDoc();
    const result = applyOp(doc, { op: 'removePage', page: 'home' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.doc.pages).toEqual({});

    const undone = undoneBy(result.value.doc, result.value.inverse);
    expect(content(undone)).toEqual(content(doc));
  });

  test('keeps the other pages', () => {
    const withPricing = applied(sampleDoc(), { op: 'addPage', page: pricing });
    const next = applied(withPricing, { op: 'removePage', page: 'home' });
    expect(Object.keys(next.pages)).toEqual(['pricing']);
  });

  test.each(['about', 'constructor'])('rejects a missing page %s', (id) => {
    expect(rejected(sampleDoc(), { op: 'removePage', page: id })).toBe(`Page ${id} not found`);
  });
});
