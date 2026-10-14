import * as fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { exportPage } from './export.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { allIds, allocIds, findNode, walkDoc } from './tree.js';
import { DEVICES, type DesignDoc, type DesignNode, type ElementNode, type Op } from './types.js';
import { validateDoc } from './validate.js';

// Strings an attacker or a careless editor might send as a value or a name.
const HOSTILE = ['"', '<', '!important', '(', 'javascript:x', '__proto__', 'url(', '}', 'var(--x)', 'constructor'];
// Placeholders for the props of the Link component in templatedDoc, and values that read like a script URL.
const TEMPLATED = ['{{label}}', '{{url}}', 'x{{label}}', '{{url}}{{label}}', '{{missing}}'];
const SCRIPTY = ['JavaScript: The Good Parts', 'javascript:alert(1)', ' java\tscript:x', '/ok', 'Go'];
const text: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...HOSTILE) },
  { weight: 4, arbitrary: fc.constantFrom(...TEMPLATED) },
  { weight: 3, arbitrary: fc.constantFrom(...SCRIPTY) },
  { weight: 2, arbitrary: fc.string({ maxLength: 8 }) },
);

// The sample doc plus a Link component, <a href="{{url}}">{{label}}</a>, and an instance of it whose label
// reads like a script URL. That is valid, because the label only feeds text, until an op lets it reach an attribute.
function templatedDoc(): DesignDoc {
  const doc = sampleDoc();
  doc.components['Link'] = {
    name: 'Link',
    props: { url: { default: '/home' }, label: { default: 'Go' } },
    root: {
      id: 'n20',
      kind: 'element',
      tag: 'a',
      attrs: { href: '{{url}}' },
      style: { base: {} },
      children: [{ id: 'n21', kind: 'text', text: '{{label}}' }],
    },
  };
  doc.pages['home']?.root.children.push({
    id: 'n22',
    kind: 'instance',
    component: 'Link',
    props: { url: '/a', label: 'JavaScript: The Good Parts' },
    style: { base: {} },
  });
  doc.meta.seq = 23;
  return doc;
}

// One op, described by random numbers. buildOp turns it into a real op against the doc at that point,
// so every id the op uses exists in that doc, is fresh, or is made up on purpose.
interface Spec {
  kind: number;
  // Three times in four, ops aim at the component side of the doc (its elements and the instances).
  focus: number;
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
  kind: fc.integer({ min: 0, max: 10 }),
  focus: fc.integer({ min: 0, max: 3 }),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
  s: text,
  v: fc.option(text, { nil: null }),
  prop: fc.constantFrom('padding', 'color', '--x', 'Bad Prop', 'margin', 'not-a-prop'),
  tag: fc.constantFrom('div', 'span', 'img', 'script', 'Div', 'section', 'br'),
  attr: fc.constantFrom('href', 'title', 'data-x', 'alt', 'onclick', 'style', 'class', 'src', 'srcdoc', 'data-d-id'),
  device: fc.constantFrom(...DEVICES),
});

// An id from the doc, a fresh id, or one that is not in the doc.
function pickId(doc: DesignDoc, index: number): string {
  const pool = [...allIds(doc), ...allocIds(doc, 2), 'missing', 'n0'];
  return pool[index % pool.length] ?? 'missing';
}

// An element inside a component, or an instance: what an edit on the component side aims at.
function pickFocus(doc: DesignDoc, index: number): string {
  const pool: string[] = [];
  walkDoc(doc, (node, container) => {
    if (node.kind === 'instance' || (node.kind === 'element' && container.kind === 'component')) {
      pool.push(node.id);
    }
  });
  return pool[index % Math.max(pool.length, 1)] ?? 'missing';
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
  const node = s.focus > 0 ? pickFocus(doc, s.a) : pickId(doc, s.a);
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
    case 7: {
      const attrs = s.v === null ? {} : { [s.attr]: s.v };
      const wrapper: ElementNode = { id: freshId(doc), kind: 'element', tag: s.tag, attrs, style: { base: {} }, children: [] };
      const nodes = s.c % 2 === 0 ? [node] : [node, pickId(doc, s.b)];
      return { op: 'wrapNodes', nodes, wrapper };
    }
    case 8:
      return { op: 'setInstanceProp', node: pickId(doc, s.a), prop: s.c % 3 === 0 ? 'url' : 'label', value: s.v };
    case 9:
      return { op: 'detachInstance', node, idMap: idMapFor(doc, node) };
    default:
      return { op: 'extractComponent', node, component: `Ex${s.c % 3}`, instanceId: freshId(doc) };
  }
}

// An id map for detaching `node`: every node of its component, each mapped to a fresh id. Empty when `node`
// is not an instance, which makes the op fail, as it should.
function idMapFor(doc: DesignDoc, node: string): Record<string, string> {
  const hit = findNode(doc, node);
  if (hit?.node.kind !== 'instance') return {};
  const def = doc.components[hit.node.component];
  if (!def) return {};
  const ids: string[] = [];
  const visit = (n: DesignNode): void => {
    ids.push(n.id);
    if (n.kind === 'element') n.children.forEach(visit);
  };
  visit(def.root);
  const fresh = allocIds(doc, ids.length);
  return Object.fromEntries(ids.map((id, i) => [id, fresh[i] ?? id]));
}

describe('op fuzz', () => {
  test('random op sequences keep the doc valid and reloadable', () => {
    fc.assert(
      fc.property(fc.array(spec, { minLength: 1, maxLength: 30 }), (specs) => {
        let doc = templatedDoc();
        for (const s of specs) {
          const result = applyOp(doc, buildOp(doc, s));
          if (!result.ok) continue;
          doc = result.value.doc;
          expect(validateDoc(doc)).toBeNull();
        }
        expect(validateDoc(doc)).toBeNull();
        expect(parseDoc(serializeDoc(doc))).toEqual({ ok: true, value: doc });
      }),
      { numRuns: 500, seed: 0xf6 },
    );
  }, 60000);
});

// Mutates a JSON value at a path chosen by `steps`: each step picks a child by index. Returns a new value.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const JUNK: Json[] = [
  null, null, true, 0, -1, 1.5, '', 'x', '{{title}}', 'javascript:alert(1)', '__proto__', [], {}, [null],
  { default: null }, { default: 3 }, { default: 'ok' }, { color: null }, 'x'.repeat(5000), 'url(a "b) c")',
  JSON.parse('{"__proto__":{"x":1}}') as Json,
];

function childKeys(value: Json): (string | number)[] {
  if (Array.isArray(value)) return value.map((_, i) => i);
  if (typeof value === 'object' && value !== null) return Object.keys(value);
  return [];
}

function mutateAt(value: Json, steps: number[], mode: 'replace' | 'delete', junk: Json): Json {
  const [step, ...rest] = steps;
  const keys = childKeys(value);
  const key = step === undefined || keys.length === 0 ? undefined : keys[step % keys.length];
  if (key === undefined) return mode === 'replace' ? structuredClone(junk) : value;
  if (rest.length === 0 && mode === 'delete') {
    if (Array.isArray(value)) return value.filter((_, i) => i !== key);
    const copy = { ...(value as { [key: string]: Json }) };
    delete copy[String(key)];
    return copy;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => (i === key ? mutateAt(item, rest, mode, junk) : item));
  }
  const object = value as { [key: string]: Json };
  return { ...object, [String(key)]: mutateAt(object[String(key)] as Json, rest, mode, junk) };
}

interface FileMutation {
  kind: number;
  file: number;
  steps: number[];
  junk: number;
  pos: number;
  ch: number;
}

// Most mutations replace or delete a value near the top of a file, where the fields the loader reads sit.
const fileMutation: fc.Arbitrary<FileMutation> = fc.record({
  kind: fc.constantFrom(0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 6),
  file: fc.nat(),
  steps: fc.array(fc.nat(), { maxLength: 3 }),
  junk: fc.nat(),
  pos: fc.nat(),
  ch: fc.nat(),
});

const BREAKERS = ['{', '}', '[', ']', '"', ',', ':', 'null', '0', '\\'];
const EXTRA_NAMES = ['pages/other.json', 'components/Other.json', 'pages/constructor.json', 'components/__proto__.json', 'pages/Bad Name.json', 'notes.txt', 'archive/x.json'];

function mutateFiles(files: Record<string, string>, m: FileMutation): Record<string, string> {
  const next = { ...files };
  const names = Object.keys(next).sort();
  const name = names[m.file % names.length] ?? 'meta.json';
  const text = next[name] ?? '';
  switch (m.kind) {
    case 0:
    case 1: {
      let parsed: Json;
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        return next;
      }
      const junk = JUNK[m.junk % JUNK.length] ?? null;
      next[name] = JSON.stringify(mutateAt(parsed, m.steps, m.kind === 0 ? 'replace' : 'delete', junk));
      return next;
    }
    case 2:
      next[name] = text.slice(0, m.pos % (text.length + 1));
      return next;
    case 3: {
      const at = m.pos % (text.length + 1);
      next[name] = text.slice(0, at) + (BREAKERS[m.ch % BREAKERS.length] ?? '') + text.slice(at + 1);
      return next;
    }
    case 4:
      delete next[name];
      return next;
    case 5:
      next[EXTRA_NAMES[m.junk % EXTRA_NAMES.length] ?? 'x.json'] = text;
      return next;
    default: {
      const other = names[m.pos % names.length] ?? name;
      next[name] = next[other] ?? '';
      next[other] = text;
      return next;
    }
  }
}

describe('file fuzz', () => {
  test('parseDoc never throws on mutated file sets, and accepted docs export', () => {
    const base = serializeDoc(sampleDoc());
    fc.assert(
      fc.property(fc.array(fileMutation, { minLength: 1, maxLength: 6 }), (mutations) => {
        const files = mutations.reduce(mutateFiles, base);
        const result = parseDoc(files);
        if (!result.ok) {
          expect(typeof result.error).toBe('string');
          expect(result.error).not.toBe('');
          return;
        }
        expect(validateDoc(result.value)).toBeNull();
        for (const id of Object.keys(result.value.pages)) {
          const exported = exportPage(result.value, id);
          expect(typeof exported.ok).toBe('boolean');
        }
      }),
      { numRuns: 500, seed: 0x5eed },
    );
  }, 60000);
});

function childValues(value: Json): Json[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'object' && value !== null ? Object.values(value) : [];
}

// Every key path of `value` down to `depth` levels, as the index steps mutateAt follows.
function stepsOf(value: Json, depth: number): number[][] {
  if (depth === 0) return [];
  return childValues(value).flatMap((child, index): number[][] => [
    [index],
    ...stepsOf(child, depth - 1).map((rest) => [index, ...rest]),
  ]);
}

describe('file sweep', () => {
  test('replacing or deleting any value near the top of any file never makes parseDoc throw', () => {
    const base = serializeDoc(sampleDoc());
    let tried = 0;
    for (const [name, text] of Object.entries(base)) {
      const parsed = JSON.parse(text) as Json;
      for (const steps of stepsOf(parsed, 3)) {
        for (const junk of JUNK) {
          for (const mode of ['replace', 'delete'] as const) {
            const files = { ...base, [name]: JSON.stringify(mutateAt(parsed, steps, mode, junk)) };
            const result = parseDoc(files);
            expect(typeof result.ok, `${name} ${steps.join('.')} ${mode} ${JSON.stringify(junk)?.slice(0, 40)}`).toBe('boolean');
            tried += 1;
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(1000);
  });
});
