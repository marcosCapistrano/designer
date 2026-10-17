import { describe, expect, test } from 'vitest';
import { findNode } from './tree.js';
import { parseDoc, serializeDoc } from './files.js';
import { sampleDoc } from './fixtures.js';
import { MAX_DEPTH } from './shape.js';
import { validateDoc } from './validate.js';
import type { DesignDoc, DesignNode, ElementNode, InstanceNode } from './types.js';

// A fresh copy of the sample, so each test mutates its own doc.
function mutableDoc(): DesignDoc {
  return structuredClone(sampleDoc());
}

function at(doc: DesignDoc, id: string): DesignNode {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`fixture is missing node ${id}`);
  return hit.node;
}

function element(doc: DesignDoc, id: string): ElementNode {
  const node = at(doc, id);
  if (node.kind !== 'element') throw new Error(`fixture node ${id} is not an element`);
  return node;
}

function instance(doc: DesignDoc, id: string): InstanceNode {
  const node = at(doc, id);
  if (node.kind !== 'instance') throw new Error(`fixture node ${id} is not an instance`);
  return node;
}

// An element chain with `levels` nodes from the root down. The root is level 1.
function chain(levels: number, level = 1): ElementNode {
  return {
    id: `d${level}`,
    kind: 'element',
    tag: 'div',
    attrs: {},
    style: { base: {} },
    children: level < levels ? [chain(levels, level + 1)] : [],
  };
}

function withHomeRoot(root: ElementNode): DesignDoc {
  const doc = mutableDoc();
  doc.pages = { home: { id: 'home', name: 'Home', route: '/', root } };
  return doc;
}

describe('validateDoc', () => {
  test('sampleDoc() is valid', () => {
    expect(validateDoc(sampleDoc())).toBeNull();
  });

  test('rejects a page key that is not a valid page id', () => {
    const doc = mutableDoc();
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    doc.pages = { 'Home Page': { ...home, id: 'Home Page' } };
    expect(validateDoc(doc)).toContain('Invalid page id "Home Page"');
  });

  test('rejects a page whose id does not match its key', () => {
    const doc = mutableDoc();
    const home = doc.pages['home'];
    if (!home) throw new Error('fixture is missing the home page');
    doc.pages = { home: { ...home, id: 'other' } };
    expect(validateDoc(doc)).toBe('page home: page id "other" does not match its key');
  });

  test('rejects an invalid node id', () => {
    const doc = mutableDoc();
    at(doc, 'n4').id = 'bad id';
    expect(validateDoc(doc)).toContain('Invalid node id "bad id"');
  });

  test('rejects a node id used twice in one page', () => {
    const doc = mutableDoc();
    at(doc, 'n4').id = 'n2';
    expect(validateDoc(doc)).toBe('page home node n2: Duplicate node id n2');
  });

  test('rejects a node id that a component already uses', () => {
    const doc = mutableDoc();
    const card = doc.components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    card.root.id = 'n1';
    expect(validateDoc(doc)).toBe('component Card node n1: Duplicate node id n1');
  });

  test('rejects a tag that is not allowed', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'script';
    expect(validateDoc(doc)).toContain('Tag "script" is not allowed');
  });

  test('rejects a tag that is not a valid tag name', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'Div';
    expect(validateDoc(doc)).toContain('Invalid tag "Div"');
  });

  test('rejects an attribute name that is not allowed', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { onclick: 'x' };
    expect(validateDoc(doc)).toContain('Attribute "onclick" is not allowed');
  });

  test('rejects an unsafe attribute value', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { href: 'JavaScript:alert(1)' };
    expect(validateDoc(doc)).toContain('Unsafe URL in attribute href');
  });

  test('rejects srcdoc', () => {
    const doc = mutableDoc();
    element(doc, 'n2').attrs = { srcdoc: '<p>x</p>' };
    expect(validateDoc(doc)).toContain('Attribute srcdoc is not allowed');
  });

  test('rejects a void element that has children', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'img';
    expect(validateDoc(doc)).toContain('Void element img cannot have children');
  });

  test('rejects a style value with a forbidden character', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['padding'] = '8px}';
    expect(validateDoc(doc)).toContain('Value for padding contains a forbidden character');
  });

  test('rejects a style value that the property does not accept', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['padding'] = 'red';
    expect(validateDoc(doc)).toContain('Invalid value "red" for padding');
  });

  test('rejects an unknown style property', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.base['not-a-prop'] = '1px';
    expect(validateDoc(doc)).toContain('Unknown CSS property "not-a-prop"');
  });

  test('checks the style of every device, not only base', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style.mobile = { color: 'red', padding: '8px !important' };
    expect(validateDoc(doc)).toContain('Value for padding must not use !important');
  });

  test('rejects a device key that is not a device', () => {
    const doc = mutableDoc();
    element(doc, 'n3').style = { base: {}, desktop: {} } as unknown as ElementNode['style'];
    expect(validateDoc(doc)).toContain('Unknown device "desktop"');
  });

  test('rejects a token value that setToken would refuse', () => {
    const doc = mutableDoc();
    doc.tokens = { color: { primary: 'red}' } };
    expect(validateDoc(doc)).toBe('token color.primary: Value for --color-primary contains a forbidden character');
  });

  test('rejects a token name that setToken would refuse', () => {
    const doc = mutableDoc();
    doc.tokens = { Color: { primary: '#fff' } };
    expect(validateDoc(doc)).toContain('Invalid token name: group "Color", name "primary"');
  });

  test('rejects an instance of a component that does not exist', () => {
    const doc = mutableDoc();
    instance(doc, 'n5').component = 'Nope';
    expect(validateDoc(doc)).toContain('Component Nope not found');
  });

  test('rejects an instance prop that its component does not declare', () => {
    const doc = mutableDoc();
    instance(doc, 'n5').props = { title: 'Hello', color: 'red' };
    expect(validateDoc(doc)).toContain('Component Card has no prop "color"');
  });

  test('accepts a page tree exactly 64 levels deep', () => {
    expect(validateDoc(withHomeRoot(chain(MAX_DEPTH)))).toBeNull();
  });

  test('rejects a page tree deeper than 64 levels', () => {
    expect(validateDoc(withHomeRoot(chain(MAX_DEPTH + 1)))).toBe(
      'page home: Node tree deeper than 64 levels',
    );
  });

  test('rejects a component tree deeper than 64 levels', () => {
    const doc = mutableDoc();
    const card = doc.components['Card'];
    if (!card) throw new Error('fixture is missing the Card component');
    card.root = chain(MAX_DEPTH + 1);
    expect(validateDoc(doc)).toBe('component Card: Node tree deeper than 64 levels');
  });
});

// Ruling 21: a component must not contain itself, directly or through other components.
describe('validateDoc component cycles', () => {
  function inst(id: string, component: string): InstanceNode {
    return { id, kind: 'instance', component, props: {}, style: { base: {} } };
  }

  function component(name: string, rootId: string, children: DesignNode[]): DesignDoc['components'][string] {
    return {
      name,
      props: {},
      root: { id: rootId, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children },
    };
  }

  test('rejects a component that contains an instance of itself', () => {
    const doc = mutableDoc();
    doc.components['Loop'] = component('Loop', 'n30', [inst('n31', 'Loop')]);
    expect(validateDoc(doc)).toBe('component Loop: Component cycle at Loop');
  });

  test('rejects two components that contain each other', () => {
    const doc = mutableDoc();
    doc.components['Aa'] = component('Aa', 'n30', [inst('n31', 'Bb')]);
    doc.components['Bb'] = component('Bb', 'n32', [inst('n33', 'Aa')]);
    expect(validateDoc(doc)).toBe('component Aa: Component cycle at Aa');
  });

  test('rejects a cycle of three, found from the component that starts it', () => {
    const doc = mutableDoc();
    doc.components['Aa'] = component('Aa', 'n30', [component('x', 'n31', [inst('n32', 'Bb')]).root]);
    doc.components['Bb'] = component('Bb', 'n33', [inst('n34', 'Cc')]);
    doc.components['Cc'] = component('Cc', 'n35', [inst('n36', 'Aa')]);
    expect(validateDoc(doc)).toBe('component Aa: Component cycle at Aa');
  });

  test('a page that uses a cyclic component is refused', () => {
    const doc = mutableDoc();
    doc.components['Loop'] = component('Loop', 'n30', [inst('n31', 'Loop')]);
    element(doc, 'n2').children.push(inst('n32', 'Loop'));
    expect(validateDoc(doc)).toContain('Component cycle at Loop');
  });

  test('parseDoc refuses a cyclic component', () => {
    const doc = mutableDoc();
    doc.components['Aa'] = component('Aa', 'n30', [inst('n31', 'Bb')]);
    doc.components['Bb'] = component('Bb', 'n32', [inst('n33', 'Aa')]);
    expect(parseDoc(serializeDoc(doc))).toEqual({ ok: false, error: 'component Aa: Component cycle at Aa' });
  });

  test('accepts components that share a component without a cycle', () => {
    const doc = mutableDoc();
    doc.components['Leaf'] = component('Leaf', 'n30', []);
    doc.components['Left'] = component('Left', 'n31', [inst('n32', 'Leaf')]);
    doc.components['Right'] = component('Right', 'n33', [inst('n34', 'Leaf')]);
    doc.components['Top'] = component('Top', 'n35', [inst('n36', 'Left'), inst('n37', 'Right')]);
    expect(validateDoc(doc)).toBeNull();
  });
});

// I1/N1: validateDoc reports a malformed header field or token group, and never throws on it.
describe('validateDoc shapes', () => {
  function asDoc(patch: (doc: Record<string, any>) => void): DesignDoc {
    const doc: Record<string, any> = mutableDoc();
    patch(doc);
    return doc as DesignDoc;
  }

  test.each<[string, (doc: Record<string, any>) => void, string]>([
    ['a component without props', (d) => { delete d['components'].Card.props; }, 'component Card: props must be an object'],
    ['a component with null props', (d) => { d['components'].Card.props = null; }, 'component Card: props must be an object'],
    ['a prop declared as null', (d) => { d['components'].Card.props = { title: null }; }, 'component Card: props.title must be an object with a string default'],
    ['a prop without a default', (d) => { d['components'].Card.props = { title: {} }; }, 'component Card: props.title must be an object with a string default'],
    ['a null token group', (d) => { d['tokens'] = { color: null }; }, 'tokens: token group "color" must be an object of strings'],
    ['a non-string token value', (d) => { d['tokens'] = { color: { primary: 3 } }; }, 'tokens: token group "color" must be an object of strings'],
    ['a page name that is a number', (d) => { d['pages'].home.name = 3; }, 'page home: name must be a string'],
    ['a page route that is missing', (d) => { delete d['pages'].home.route; }, 'page home: route must be a string'],
  ])('returns an error for %s', (_label, patch, error) => {
    expect(validateDoc(asDoc(patch))).toBe(error);
  });
});

describe('parseDoc uses validateDoc', () => {
  test('rejects a doc that validateDoc rejects, with the same message', () => {
    const doc = mutableDoc();
    element(doc, 'n2').tag = 'script';
    expect(parseDoc(serializeDoc(doc))).toEqual({
      ok: false,
      error: 'page home node n2: Tag "script" is not allowed',
    });
  });
});

// F6: the cycle check is linear in the components and their instances.
describe('validateDoc cycle check at scale', () => {
  const name = (i: number): string => `C${String(i).padStart(4, '0')}`;

  // C0000 contains C0001, which contains C0002, and so on. With `closed`, the last contains C0000 again.
  function chainDoc(length: number, closed: boolean): DesignDoc {
    const doc = mutableDoc();
    for (let i = 0; i < length; i++) {
      const next = i + 1 < length ? name(i + 1) : closed ? name(0) : null;
      doc.components[name(i)] = {
        name: name(i),
        props: {},
        root: {
          id: `c${i}`,
          kind: 'element',
          tag: 'div',
          attrs: {},
          style: { base: {} },
          children:
            next === null
              ? []
              : [{ id: `i${i}`, kind: 'instance', component: next, props: {}, style: { base: {} } }],
        },
      };
    }
    doc.meta.seq = 1000000;
    return doc;
  }

  test('a chain of 5000 components is valid and checked in under 500 ms', () => {
    const doc = chainDoc(5000, false);
    const started = performance.now();
    const problem = validateDoc(doc);
    const elapsed = performance.now() - started;
    expect(problem).toBeNull();
    expect(elapsed).toBeLessThan(500);
  }, 60_000);

  test('the same chain closed into a ring is refused, also in under 500 ms', () => {
    const doc = chainDoc(5000, true);
    const started = performance.now();
    const problem = validateDoc(doc);
    const elapsed = performance.now() - started;
    expect(problem).toBe('component C0000: Component cycle at C0000');
    expect(elapsed).toBeLessThan(500);
  }, 60_000);

  test('names the first component of the cycle when something before it only leads into it', () => {
    const doc = chainDoc(3, false);
    const last = doc.components[name(2)];
    if (!last) throw new Error('fixture is missing the last component');
    last.root.children = [
      { id: 'back', kind: 'instance', component: name(1), props: {}, style: { base: {} } },
    ];
    expect(validateDoc(doc)).toBe('component C0001: Component cycle at C0001');
  });
});

// F6: validateDoc answers with a message, and never throws, whatever it is given.
describe('validateDoc on values that are not docs', () => {
  const valid = (): Record<string, unknown> => structuredClone(sampleDoc()) as unknown as Record<string, unknown>;

  test.each<[string, unknown, string]>([
    ['null', null, 'doc must be an object'],
    ['undefined', undefined, 'doc must be an object'],
    ['a string', 'doc', 'doc must be an object'],
    ['an array', [], 'doc must be an object'],
    ['an empty object', {}, 'meta must be an object with version 1 and a non-negative integer seq'],
  ])('%s gives a message', (_label, doc, message) => {
    expect(validateDoc(doc as DesignDoc)).toBe(message);
  });

  test.each<[string, (doc: Record<string, any>) => void, string]>([
    ['meta of the wrong version', (d) => { d['meta'] = { version: 2, seq: 1 }; }, 'meta must be an object with version 1 and a non-negative integer seq'],
    ['meta with a bad seq', (d) => { d['meta'] = { version: 1, seq: -1 }; }, 'meta must be an object with version 1 and a non-negative integer seq'],
    ['pages that is null', (d) => { d['pages'] = null; }, 'pages must be an object'],
    ['components that is an array', (d) => { d['components'] = []; }, 'components must be an object'],
    ['tokens that is missing', (d) => { delete d['tokens']; }, 'tokens: expected an object'],
    ['a page that is null', (d) => { d['pages'].home = null; }, 'page home: page must be an object'],
    ['a page without a root', (d) => { delete d['pages'].home.root; }, 'page home: root must be an element node'],
    ['a page root that is a text node', (d) => { d['pages'].home.root = { id: 'n1', kind: 'text', text: 'x' }; }, 'page home: root must be an element node'],
    ['a page whose children is not an array', (d) => { d['pages'].home.root.children = null; }, 'page home: node n1: children must be an array'],
    ['a component that is a string', (d) => { d['components'].Card = 'Card'; }, 'component Card: component must be an object'],
    ['a component without a root', (d) => { delete d['components'].Card.root; }, 'component Card: root must be an element node'],
    ['a node that is null', (d) => { d['pages'].home.root.children[0] = null; }, 'page home: node must be an object'],
  ])('%s gives a message', (_label, patch, message) => {
    const doc = valid();
    patch(doc);
    expect(validateDoc(doc as unknown as DesignDoc)).toBe(message);
  });

  test('allows data-d-shell="html" only on a page root', () => {
    const doc = mutableDoc();
    const page = Object.values(doc.pages)[0]!;
    page.root.attrs['data-d-shell'] = 'html';
    expect(validateDoc(doc)).toBeNull();
    page.root.attrs['data-d-shell'] = 'body';
    expect(validateDoc(doc)).toContain('Attribute data-d-shell must be "html"');
    delete page.root.attrs['data-d-shell'];
    const child = page.root.children.find((node) => node.kind === 'element')!;
    if (child.kind === 'element') child.attrs['data-d-shell'] = 'html';
    expect(validateDoc(doc)).toContain('Attribute "data-d-shell" is only allowed on a page root');
  });
});
