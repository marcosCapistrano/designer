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
