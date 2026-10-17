import { describe, expect, test } from 'vitest';
import { applyOp } from './apply.js';
import { EXPORT_NODE_LIMIT, exportPage } from './export.js';
import { sampleDoc } from './fixtures.js';
import { VOID_TAGS } from './rules.js';
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

  test('an instance prop value takes placeholders from the enclosing component', () => {
    // Page -> Layout -> Card: Card's title is written in Layout's terms, so {{pageTitle}} is Layout's prop.
    const layout = comp(
      'Layout',
      el('l1', 'section', [inst('l2', 'Card', { title: '{{pageTitle}}' })]),
      { pageTitle: 'Untitled' },
    );
    const card = comp('Card', el('c1', 'div', [txt('c2', '{{title}}')]), { title: 'Title' });
    const doc = docWith(
      el('p1', 'main', [inst('p9', 'Layout', { pageTitle: 'Home' }), inst('p10', 'Layout')]),
      [layout, card],
    );
    expect(exportOk(doc).html).toBe(
      '<main data-d-id="p1">' +
        '<section data-d-id="p9/l1"><div data-d-id="p9/l2/c1">Home</div></section>' +
        '<section data-d-id="p10/l1"><div data-d-id="p10/l2/c1">Untitled</div></section>' +
        '</main>',
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

  test('escapes <, >, newline, quote and backslash in ids used as CSS selector strings', () => {
    const node: ElementNode = { ...el('x', 'div'), id: 'a<b>\nc"d\\e', style: { base: { padding: '8px' } } };
    const { css, html } = exportOk(docWith(el('p1', 'main', [node])));
    expect(css).toBe('[data-d-id="a\\3C b\\3E \\A c\\"d\\\\e"]{padding:8px;}');
    expect(html).toContain('<div data-d-id="a&lt;b&gt;\nc&quot;d\\e"></div>');
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

  test('exportPage never throws on a corrupted doc', () => {
    // Each corruption bypasses validation: the doc is edited directly, not through applyOp.
    const corruptions: [string, (doc: DesignDoc) => void][] = [
      ['a node with kind banana', (doc) => {
        (find<DesignNode>(doc, 'n2') as { kind: string }).kind = 'banana';
      }],
      ['an element whose children is undefined', (doc) => {
        find<ElementNode>(doc, 'n2').children = undefined as unknown as DesignNode[];
      }],
      ['an instance whose component is missing from doc.components', (doc) => {
        delete doc.components.Card;
      }],
    ];
    for (const [label, corrupt] of corruptions) {
      const doc = sample();
      corrupt(doc);
      let result: ReturnType<typeof exportPage> | undefined;
      expect(() => {
        result = exportPage(doc, 'home');
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(false);
    }
  });

  test('an error thrown during export is reported as an export failure', () => {
    const doc = sample();
    find<ElementNode>(doc, 'n2').children = undefined as unknown as DesignNode[];
    expect(exportPage(doc, 'home')).toEqual({ ok: false, error: expect.stringMatching(/^Export failed: .+/) });
  });

  test('escapes CR and form feed in ids used as CSS selector strings', () => {
    const node: ElementNode = { ...el('x', 'div'), id: 'a\rb\fc', style: { base: { padding: '8px' } } };
    const { css } = exportOk(docWith(el('p1', 'main', [node])));
    expect(css).toBe('[data-d-id="a\\D b\\C c"]{padding:8px;}');
    expect(css).not.toMatch(/[\r\f]/);
  });

  test('every shared void tag is written without a closing tag', () => {
    for (const tag of VOID_TAGS) {
      const { html } = exportOk(docWith(el('p1', 'main', [el('x', tag)])));
      expect(html, tag).toBe(`<main data-d-id="p1"><${tag} data-d-id="x"></main>`);
    }
  });
});

// C0 is a div with one text child, so 2 nodes. Each C_k is a div holding two instances of
// C_(k-1), so C_k expands to 3 * 2^k - 1 nodes: C5 is 95 nodes and C14 is 49151.
function ladder(levels: number): ComponentDef[] {
  const defs = [comp('C0', el('c0', 'div', [txt('c0t', 'leaf')]))];
  for (let k = 1; k <= levels; k++) {
    defs.push(comp(`C${k}`, el(`d${k}`, 'div', [inst(`a${k}`, `C${k - 1}`), inst(`b${k}`, `C${k - 1}`)])));
  }
  return defs;
}

describe('export node budget', () => {
  test('refuses a page that expands past the limit, without building the output', () => {
    const doc = docWith(el('p1', 'main', [inst('p9', 'C14')]), ladder(14));
    const started = performance.now();
    expect(exportPage(doc, 'home')).toEqual({ ok: false, error: 'Page home exceeds 20000 nodes' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('a page within the limit still exports', () => {
    const doc = docWith(el('p1', 'main', [inst('p9', 'C5')]), ladder(5));
    expect(exportPage(doc, 'home').ok).toBe(true);
  });

  test('the limit is inclusive: exactly EXPORT_NODE_LIMIT nodes exports, one more is refused', () => {
    const texts = (count: number): TextNode[] => Array.from({ length: count }, (_, i) => txt(`t${i}`, 'x'));
    // The page root counts as one node.
    expect(exportPage(docWith(el('p1', 'main', texts(EXPORT_NODE_LIMIT - 1))), 'home').ok).toBe(true);
    expect(exportPage(docWith(el('p1', 'main', texts(EXPORT_NODE_LIMIT))), 'home')).toEqual({
      ok: false,
      error: `Page home exceeds ${EXPORT_NODE_LIMIT} nodes`,
    });
  });
});

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture is missing ${what}`);
  return value;
}

// Ruling P: a page root marked data-d-shell="html" stands for the source document's html element.
describe('document shell propagation', () => {
  function shellDoc(rootStyle: ElementNode['style'], bodyStyle: ElementNode['style']): DesignDoc {
    const body = { ...el('b', 'div', [el('x', 'p', [txt('t', 'Hi')])]), style: bodyStyle };
    return docWith({ ...el('h', 'div', [body], { 'data-d-shell': 'html' }), style: rootStyle });
  }

  test('moves the root font and color-scheme to the real html element, so rem resolves as in the browser', () => {
    const { css } = exportOk(shellDoc(
      { base: { 'color-scheme': 'dark', color: 'white', 'font-size': '62.5%' }, mobile: { 'font-size': '50%' } },
      { base: { margin: '0' } },
    ));
    expect(css).toBe([
      'html{color-scheme:dark;font-size:62.5%;}',
      '[data-d-id="h"]{color:white;}',
      '[data-d-id="b"]{margin:0;}',
      '@media (max-width: 599px){html{font-size:50%;}}',
    ].join('\n'));
  });

  test('paints the canvas with the html background when set, else the body background', () => {
    const own = exportOk(shellDoc({ base: { 'background-color': 'navy' } }, { base: { background: 'red' } })).css;
    expect(own.split('\n')).toEqual(['html{background-color:navy;}', '[data-d-id="b"]{background:red;}']);
    const body = exportOk(shellDoc({ base: { 'background-color': 'transparent' } }, { base: { background: 'red', padding: '8px' } })).css;
    expect(body.split('\n')).toEqual(['html{background:red;}', '[data-d-id="h"]{background-color:transparent;}', '[data-d-id="b"]{padding:8px;}']);
  });

  test('copies the canvas background per device when the propagating element differs between devices', () => {
    const { css } = exportOk(shellDoc({ base: {}, tablet: { 'background-color': 'navy' } }, { base: { 'background-color': 'red' } }));
    // The propagated background is painted by the canvas only, never again by its div (M4).
    expect(css.split('\n')).toEqual([
      'html{background-color:red;}',
      '@media (max-width: 1023px){html{background:initial;background-color:navy;}[data-d-id="b"]{background-color:red;}}',
    ]);
  });

  test('a background shorthand in a device block resets the earlier background longhands (R2-M1)', () => {
    const { css } = exportOk(shellDoc({ base: { 'background-color': 'red' }, tablet: { background: 'none' } }, { base: { background: 'blue' } }));
    expect(css.split('\n')).toEqual([
      'html{background-color:red;}',
      '[data-d-id="b"]{background:blue;}',
      '@media (max-width: 1023px){html{background:blue;}[data-d-id="h"]{background:none;}[data-d-id="b"]{background:initial;}}',
    ]);
  });

  test('treats zero-alpha background colors as not painting', () => {
    for (const clear of ['rgba(0, 0, 0, 0)', '#0000', '#ff000000', 'rgb(0 0 0 / 0%)', 'hsla(0, 0%, 0%, 0.0)']) {
      const { css } = exportOk(shellDoc({ base: { 'background-color': clear } }, { base: { background: 'red' } }));
      expect(css.split('\n')).toEqual(['html{background:red;}', `[data-d-id="h"]{background-color:${clear};}`]);
    }
    for (const opaque of ['rgb(10, 20, 0)', 'rgba(1, 2, 3, 0.5)', 'rgb(0 0 0)', '#000']) {
      const { css } = exportOk(shellDoc({ base: { 'background-color': opaque } }, { base: { background: 'red' } }));
      expect(css.split('\n')).toEqual([`html{background-color:${opaque};}`, '[data-d-id="b"]{background:red;}']);
    }
  });

  test('a page root without the marker exports no html rule', () => {
    const doc = shellDoc({ base: { 'font-size': '62.5%' } }, { base: {} });
    delete doc.pages['home']!.root.attrs['data-d-shell'];
    expect(exportOk(doc).css).toBe('[data-d-id="h"]{font-size:62.5%;}');
  });
});
