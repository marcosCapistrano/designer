import { describe, expect, test } from 'vitest';
import { canonicalStringify } from './canonical.js';
import { decodeOpLog, encodeOpLog, parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import type { DesignDoc, Op } from './types.js';

function sampleOps(): Op[] {
  return [
    { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: null },
    { op: 'setText', node: 'n4', text: 'Sign in' },
    {
      op: 'insertNode', parent: 'n1', index: 0,
      node: {
        id: 'n9', kind: 'element', tag: 'p', attrs: { title: 'hi' }, style: { base: {}, tablet: { color: 'red' } },
        children: [{ id: 'n10', kind: 'text', text: 'Hello' }],
      },
    },
    { op: 'removeNode', node: 'n2' },
  ];
}

// The serialized sample with the home page's root replaced by `root`.
function filesWithHomeRoot(root: unknown): Record<string, string> {
  const files = serializeDoc(sampleDoc());
  files['pages/home.json'] = canonicalStringify({ id: 'home', name: 'Home', route: '/', root });
  return files;
}

function homeRoot(children: unknown[]): unknown {
  return { id: 'n1', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children };
}

describe('serializeDoc and parseDoc', () => {
  test('roundtrip', () => {
    const d = sampleDoc();
    expect(parseDoc(serializeDoc(d))).toEqual({ ok: true, value: d });
  });

  test('byte-stable', () => {
    const d = sampleDoc();
    expect(serializeDoc(d)).toEqual(serializeDoc(d));
  });

  test('writes one file per page and component, plus meta and tokens', () => {
    expect(Object.keys(serializeDoc(sampleDoc())).sort()).toEqual([
      'components/Card.json', 'meta.json', 'pages/home.json', 'tokens.json',
    ]);
  });

  test('rejects id mismatch', () => {
    const files = serializeDoc(sampleDoc());
    const home = sampleDoc().pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    files['pages/home.json'] = canonicalStringify({ ...home, id: 'x' });
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('pages/home.json');
  });

  test('rejects component name mismatch', () => {
    const files = serializeDoc(sampleDoc());
    files['components/Card.json'] = canonicalStringify({ ...sampleDoc().components['Card'], name: 'Panel' });
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('components/Card.json');
  });

  test('rejects duplicate ids across files', () => {
    const d: DesignDoc = sampleDoc();
    const card = d.components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    card.root.id = 'n2';
    const result = parseDoc(serializeDoc(d));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('n2');
      expect(result.error).toContain('pages/home.json');
      expect(result.error).toContain('components/Card.json');
    }
  });

  test('rejects missing meta.json', () => {
    const files = serializeDoc(sampleDoc());
    delete files['meta.json'];
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('meta.json');
  });

  test('rejects version other than 1', () => {
    const files = serializeDoc(sampleDoc());
    files['meta.json'] = canonicalStringify({ version: 2, seq: 9 });
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version');
  });

  test('rejects missing tokens.json', () => {
    const files = serializeDoc(sampleDoc());
    delete files['tokens.json'];
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('tokens.json');
  });

  test('rejects a null child node', () => {
    expect(parseDoc(filesWithHomeRoot(homeRoot([null])))).toEqual({
      ok: false,
      error: 'pages/home.json: node must be an object',
    });
  });

  test('rejects an element without children', () => {
    const root = { id: 'n1', kind: 'element', tag: 'main', attrs: {}, style: { base: {} } };
    expect(parseDoc(filesWithHomeRoot(root))).toEqual({
      ok: false,
      error: 'pages/home.json: node n1: children must be an array',
    });
  });

  test('rejects a root that is not an element', () => {
    expect(parseDoc(filesWithHomeRoot({ id: 'n1', kind: 'text', text: 'x' }))).toEqual({
      ok: false,
      error: 'pages/home.json: root must be an element node',
    });
  });

  test.each<[string, unknown, string]>([
    ['an empty id', { id: '', kind: 'text', text: 'x' }, 'node id must be a non-empty string'],
    ['an unknown kind', { id: 'n9', kind: 'span' }, 'node n9: kind must be element, text or instance'],
    ['an element without a tag', { id: 'n9', kind: 'element', attrs: {}, style: { base: {} }, children: [] }, 'node n9: tag must be a string'],
    ['an element with array attrs', { id: 'n9', kind: 'element', tag: 'p', attrs: [], style: { base: {} }, children: [] }, 'node n9: attrs must be an object'],
    ['an element style without base', { id: 'n9', kind: 'element', tag: 'p', attrs: {}, style: {}, children: [] }, 'node n9: style must be an object with a base object'],
    ['a null child inside an element', { id: 'n9', kind: 'element', tag: 'p', attrs: {}, style: { base: {} }, children: [null] }, 'node must be an object'],
    ['a text node without text', { id: 'n9', kind: 'text' }, 'node n9: text must be a string'],
    ['an instance without a component', { id: 'n9', kind: 'instance', props: {}, style: { base: {} } }, 'node n9: component must be a string'],
    ['an instance without props', { id: 'n9', kind: 'instance', component: 'Card', style: { base: {} } }, 'node n9: props must be an object'],
    ['an instance without style', { id: 'n9', kind: 'instance', component: 'Card', props: {} }, 'node n9: style must be an object with a base object'],
  ])('rejects %s', (_label, child, reason) => {
    expect(parseDoc(filesWithHomeRoot(homeRoot([child])))).toEqual({
      ok: false,
      error: `pages/home.json: ${reason}`,
    });
  });

  test('ignores changes.jsonl, sync.json and archive/ entries', () => {
    const d = sampleDoc();
    const files = {
      ...serializeDoc(d),
      'changes.jsonl': 'not json at all',
      'sync.json': '{ broken',
      'archive/2026-10-01/pages/home.json': '{ broken',
    };
    expect(parseDoc(files)).toEqual({ ok: true, value: d });
  });

  test('rejects other unrecognised top-level files', () => {
    const files = serializeDoc(sampleDoc());
    files['notes.txt'] = 'hello';
    expect(parseDoc(files)).toEqual({ ok: false, error: 'unexpected file "notes.txt"' });
  });

  test.each(['__proto__', 'constructor', 'prototype'])('rejects the reserved page key %s', (key) => {
    const home = sampleDoc().pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    const files = serializeDoc(sampleDoc());
    files[`pages/${key}.json`] = canonicalStringify({ ...home, id: key });
    expect(parseDoc(files)).toEqual({
      ok: false,
      error: `pages/${key}.json: "${key}" is a reserved name`,
    });
  });

  test('rejects the reserved component name __proto__', () => {
    const card = sampleDoc().components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    const files = serializeDoc(sampleDoc());
    files['components/__proto__.json'] = canonicalStringify({ ...card, name: '__proto__' });
    expect(parseDoc(files)).toEqual({
      ok: false,
      error: 'components/__proto__.json: "__proto__" is a reserved name',
    });
  });

  test.each<[number | string]>([[-1], [1.5], [2 ** 53], ['9']])('rejects seq %s', (seq) => {
    const files = serializeDoc(sampleDoc());
    files['meta.json'] = canonicalStringify({ version: 1, seq });
    expect(parseDoc(files)).toEqual({
      ok: false,
      error: 'meta.json: seq must be a non-negative integer',
    });
  });

  test('rejects a file it does not recognise', () => {
    const files = serializeDoc(sampleDoc());
    files['pages/nested/home.json'] = files['pages/home.json'] ?? '';
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('pages/nested/home.json');
  });

  test('rejects invalid JSON and names the file', () => {
    const files = serializeDoc(sampleDoc());
    files['tokens.json'] = '{ not json';
    const result = parseDoc(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('tokens.json');
  });
});

describe('encodeOpLog and decodeOpLog', () => {
  test('oplog roundtrip', () => {
    const ops = sampleOps();
    expect(decodeOpLog(encodeOpLog(ops))).toEqual({ ok: true, value: ops });
  });

  test('encodes one sorted single-line JSON object per op', () => {
    expect(encodeOpLog([{ op: 'setText', node: 'n4', text: 'Hi' }])).toBe(
      '{"node":"n4","op":"setText","text":"Hi"}\n',
    );
  });

  test('empty log encodes to empty string', () => {
    expect(encodeOpLog([])).toBe('');
    expect(decodeOpLog('')).toEqual({ ok: true, value: [] });
  });

  test('ignores blank lines', () => {
    expect(decodeOpLog('\n{"op":"removeNode","node":"n2"}\n\n  \n')).toEqual({
      ok: true,
      value: [{ op: 'removeNode', node: 'n2' }],
    });
  });

  test('oplog bad line', () => {
    const result = decodeOpLog('{}\nnot json\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('line 2');
  });

  test('rejects a line without a string op field and names its line', () => {
    const result = decodeOpLog('{"op":"removeNode","node":"n2"}\n{"op":3}\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('line 2');
  });
});
