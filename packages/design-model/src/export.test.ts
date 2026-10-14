import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { exportPage } from './export.js';
import { sampleDoc } from './fixtures.js';
import { findNode } from './tree.js';
import type {
  ComponentDef,
  DesignDoc,
  DesignNode,
  ElementNode,
  InstanceNode,
  Op,
  TextNode,
} from './types.js';

function applyOk(doc: DesignDoc, op: Op): DesignDoc {
  const result = applyOp(doc, op);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value.doc;
}

function exportOk(doc: DesignDoc, pageId = 'home'): { html: string; css: string } {
  const result = exportPage(doc, pageId);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

// Returns the node itself, so a test can edit it in place on a clone.
function find<T extends DesignNode>(doc: DesignDoc, id: string): T {
  const hit = findNode(doc, id);
  if (hit === null) throw new Error(`fixture is missing ${id}`);
  return hit.node as T;
}

function sample(): DesignDoc {
  return structuredClone(sampleDoc());
}

function el(id: string, tag: string, children: DesignNode[] = [], attrs: Record<string, string> = {}): ElementNode {
  return { id, kind: 'element', tag, attrs, style: { base: {} }, children };
}

function txt(id: string, text: string): TextNode {
  return { id, kind: 'text', text };
}

function inst(id: string, component: string, props: Record<string, string> = {}): InstanceNode {
  return { id, kind: 'instance', component, props, style: { base: {} } };
}

function comp(name: string, root: ElementNode, defaults: Record<string, string> = {}): ComponentDef {
  const props = Object.fromEntries(
    Object.entries(defaults).map(([key, value]): [string, { default: string }] => [key, { default: value }]),
  );
  return { name, props, root };
}

// A one-page doc whose page root is `root`.
function docWith(root: ElementNode, components: ComponentDef[] = []): DesignDoc {
  return {
    meta: { version: 1, seq: 100 },
    pages: { home: { id: 'home', name: 'Home', route: '/', root } },
    components: Object.fromEntries(components.map((c): [string, ComponentDef] => [c.name, c])),
    tokens: {},
  };
}

describe('exportPage', () => {
  test('exports sample page', () => {
    expect(exportOk(sampleDoc()).html).toBe(
      '<main data-d-id="n1"><header data-d-id="n2"><button data-d-id="n3">Log in</button></header><div data-d-id="n5/n6"><h2 data-d-id="n5/n7">Hello</h2></div></main>',
    );
  });

  test('css for sample', () => {
    expect(exportOk(sampleDoc()).css).toBe(
      [
        ':root{--color-primary:#3366ff;}',
        '[data-d-id="n3"]{padding:8px;}',
        '[data-d-id="n5/n6"]{padding:16px;}',
      ].join('\n'),
    );
  });

  test('mobile override goes in media block', () => {
    const doc = applyOk(sampleDoc(), {
      op: 'setStyle',
      node: 'n3',
      device: 'mobile',
      prop: 'padding',
      value: '4px',
    });
    expect(exportOk(doc).css).toBe(
      [
        ':root{--color-primary:#3366ff;}',
        '[data-d-id="n3"]{padding:8px;}',
        '[data-d-id="n5/n6"]{padding:16px;}',
        '@media (max-width: 599px){[data-d-id="n3"]{padding:4px;}}',
      ].join('\n'),
    );
  });

  test('tablet and mobile blocks follow the base rules, tablet first', () => {
    let doc = applyOk(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' });
    doc = applyOk(doc, { op: 'setStyle', node: 'n3', device: 'tablet', prop: 'padding', value: '6px' });
    doc = applyOk(doc, { op: 'setStyle', node: 'n5', device: 'tablet', prop: 'padding', value: '12px' });
    expect(exportOk(doc).css).toBe(
      [
        ':root{--color-primary:#3366ff;}',
        '[data-d-id="n3"]{padding:8px;}',
        '[data-d-id="n5/n6"]{padding:16px;}',
        '@media (max-width: 1023px){[data-d-id="n3"]{padding:6px;}[data-d-id="n5/n6"]{padding:12px;}}',
        '@media (max-width: 599px){[data-d-id="n3"]{padding:4px;}}',
      ].join('\n'),
    );
  });

  test('escapes text and attributes', () => {
    const doc = sample();
    find<TextNode>(doc, 'n4').text = '<b> & "x" 🎉';
    find<ElementNode>(doc, 'n3').attrs.title = 'a"b';
    const { html } = exportOk(doc);
    expect(html).toContain('&lt;b&gt; &amp; "x" 🎉');
    expect(html).toContain('title="a&quot;b"');
  });

  test('void tags', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n1').children.push(
      el('n9', 'img', [], { src: 'a.png' }),
    );
    const { html } = exportOk(doc);
    expect(html).toContain('<img data-d-id="n9" src="a.png"></main>');
    expect(html).not.toContain('</img>');
  });

  test('deterministic', () => {
    const doc = sampleDoc();
    expect(exportPage(doc, 'home')).toEqual(exportPage(doc, 'home'));
  });

  test('does not change the doc', () => {
    const doc = sampleDoc();
    const before = structuredClone(doc);
    exportPage(doc, 'home');
    expect(doc).toEqual(before);
  });

  test('attributes are written in sorted name order after data-d-id', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n3').attrs = { type: 'submit', name: 'go' };
    expect(exportOk(doc).html).toContain('<button data-d-id="n3" name="go" type="submit">Log in</button>');
  });

  test('placeholders on the page stay literal', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n2').attrs = { alt: '{{title}}' };
    find<TextNode>(doc, 'n4').text = '{{title}}';
    const { html } = exportOk(doc);
    expect(html).toContain('<header data-d-id="n2" alt="{{title}}">');
    expect(html).toContain('<button data-d-id="n3">{{title}}</button>');
  });

  test('placeholders in component text and attributes are substituted and escaped', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n6').attrs = { title: '{{title}}' };
    find<InstanceNode>(doc, 'n5').props = { title: '<i>&' };
    const { html } = exportOk(doc);
    expect(html).toContain('<div data-d-id="n5/n6" title="&lt;i&gt;&amp;">');
    expect(html).toContain('<h2 data-d-id="n5/n7">&lt;i&gt;&amp;</h2>');
  });

  test('instance style is merged over the component root style, instance wins', () => {
    const doc = sample();
    must(doc.components.Card, 'Card').root.style.base.color = 'red';
    const next = applyOk(doc, { op: 'setStyle', node: 'n5', device: 'base', prop: 'padding', value: '4px' });
    expect(exportOk(next).css).toContain('[data-d-id="n5/n6"]{color:red;padding:4px;}');
  });

  test('nested instances chain their ids', () => {
    const outer = comp(
      'Outer',
      el('o1', 'div', [inst('i2', 'Inner', { label: 'Nested' }), el('o3', 'p', [txt('o4', '{{title}}')])]),
      { title: 'Outer' },
    );
    const inner = comp('Inner', el('in1', 'span', [txt('in2', '{{label}}')]), { label: 'Default' });
    const doc = docWith(el('p1', 'main', [inst('p9', 'Outer', { title: 'Top' })]), [outer, inner]);
    expect(exportOk(doc).html).toBe(
      '<main data-d-id="p1"><div data-d-id="p9/o1"><span data-d-id="p9/i2/in1">Nested</span><p data-d-id="p9/o3">Top</p></div></main>',
    );
  });

  test('the same component can be used twice side by side', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n1').children.push(inst('n9', 'Card', { title: 'Second' }));
    expect(exportOk(doc).html).toContain(
      '<div data-d-id="n9/n6"><h2 data-d-id="n9/n7">Second</h2></div></main>',
    );
  });

  test('tokens are sorted by group, then name', () => {
    const doc = sample();
    doc.tokens = { spacing: { md: '8px' }, color: { primary: '#3366ff', accent: '#f00' } };
    expect(exportOk(doc).css.startsWith(':root{--color-accent:#f00;--color-primary:#3366ff;--spacing-md:8px;}\n')).toBe(true);
  });

  test('no :root block when there are no tokens', () => {
    const doc = sample();
    doc.tokens = {};
    expect(exportOk(doc).css).toBe('[data-d-id="n3"]{padding:8px;}\n[data-d-id="n5/n6"]{padding:16px;}');
  });

  test('returns an error for an unknown page', () => {
    expect(exportPage(sampleDoc(), 'nope')).toEqual({ ok: false, error: 'Page nope not found' });
  });

  test('returns an error for a missing component', () => {
    const doc = sample();
    find<InstanceNode>(doc, 'n5').component = 'Ghost';
    expect(exportPage(doc, 'home')).toEqual({ ok: false, error: 'Component Ghost not found' });
  });

  test('a component that contains itself is a cycle', () => {
    const card = comp('Card', el('c1', 'div', [inst('c2', 'Card')]));
    const doc = docWith(el('p1', 'main', [inst('p9', 'Card')]), [card]);
    expect(exportPage(doc, 'home')).toEqual({ ok: false, error: 'Component cycle at Card' });
  });

  test('an indirect cycle is reported at the component that repeats', () => {
    const a = comp('A', el('a1', 'div', [inst('a2', 'B')]));
    const b = comp('B', el('b1', 'div', [inst('b2', 'A')]));
    const doc = docWith(el('p1', 'main', [inst('p9', 'A')]), [a, b]);
    expect(exportPage(doc, 'home')).toEqual({ ok: false, error: 'Component cycle at A' });
  });
});

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture is missing ${what}`);
  return value;
}
