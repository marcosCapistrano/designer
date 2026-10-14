import {
  sampleDoc,
  type DesignDoc,
  type DesignNode,
  type ElementNode,
  type InstanceNode,
  type NodeStyle,
  type Page,
  type TextNode,
} from '@hub/design-model';

// Standard mulberry32. Returns a generator of numbers in [0, 1).
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lowercase only, so generated text never needs escaping.
const WORDS = [
  'amber', 'anchor', 'atlas', 'beacon', 'birch', 'bramble', 'cedar', 'clover', 'cobalt', 'coral',
  'drift', 'dune', 'echo', 'ember', 'fern', 'frost', 'glacier', 'granite', 'harbor', 'hollow',
  'indigo', 'juniper', 'kestrel', 'lantern', 'maple', 'meadow', 'nickel', 'orchid', 'pebble',
  'quartz', 'raven', 'saffron', 'thistle', 'tundra', 'umber', 'violet', 'willow', 'zephyr',
];

const CARD_BACKGROUNDS = ['#f1f3f4', '#e8f0fe', '#fce8e6', '#e6f4ea', '#fef7e0'];

interface Gen {
  rng: () => number;
  // Next unused node number. Node ids are `n${seq}`.
  seq: number;
}

// Inclusive at both ends.
function int(gen: Gen, a: number, b: number): number {
  return a + Math.floor(gen.rng() * (b - a + 1));
}

function pick<T>(gen: Gen, items: readonly T[]): T {
  const item = items[int(gen, 0, items.length - 1)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function words(gen: Gen, count: number): string {
  return Array.from({ length: count }, () => pick(gen, WORDS)).join(' ');
}

function nextId(gen: Gen): string {
  const id = `n${gen.seq}`;
  gen.seq += 1;
  return id;
}

function textNode(gen: Gen, value: string): TextNode {
  return { id: nextId(gen), kind: 'text', text: value };
}

// The id is allocated before the children are built, so ids follow document order.
function element(
  gen: Gen,
  tag: string,
  style: NodeStyle,
  children: () => DesignNode[],
  attrs: Record<string, string> = {},
): ElementNode {
  const id = nextId(gen);
  return { id, kind: 'element', tag, attrs, style, children: children() };
}

function headerNode(gen: Gen): ElementNode {
  return element(
    gen,
    'header',
    { base: { display: 'flex', gap: '16px', 'align-items': 'center' } },
    () => [
      element(gen, 'strong', { base: {} }, () => [textNode(gen, words(gen, 2))]),
      ...Array.from({ length: int(gen, 3, 6) }, () =>
        element(gen, 'a', { base: { color: '#1a73e8' } }, () => [textNode(gen, words(gen, 1))], {
          href: '#',
        }),
      ),
    ],
  );
}

function heroNode(gen: Gen): ElementNode {
  return element(
    gen,
    'section',
    { base: { display: 'flex', 'flex-direction': 'column', gap: '12px' } },
    () => [
      element(
        gen,
        'h1',
        { base: { 'font-size': '40px', margin: '0' }, mobile: { 'font-size': '28px' } },
        () => [textNode(gen, words(gen, int(gen, 3, 6)))],
      ),
      element(gen, 'p', { base: { margin: '0', 'line-height': '1.5' } }, () => [
        textNode(gen, words(gen, int(gen, 12, 30))),
      ]),
      element(
        gen,
        'button',
        { base: { padding: '12px 20px', 'border-radius': '8px' } },
        () => [textNode(gen, words(gen, 2))],
      ),
      cardInstance(gen),
    ],
  );
}

function cardInstance(gen: Gen): InstanceNode {
  return {
    id: nextId(gen),
    kind: 'instance',
    component: 'Card',
    props: { title: words(gen, 3) },
    style: { base: {} },
  };
}

function gridCard(gen: Gen): ElementNode {
  return element(
    gen,
    'div',
    {
      base: {
        padding: '16px',
        border: '1px solid #dddddd',
        'border-radius': '8px',
        background: pick(gen, CARD_BACKGROUNDS),
        'min-height': `${int(gen, 80, 240)}px`,
      },
    },
    () => [
      element(gen, 'h3', { base: { margin: '0 0 8px 0' } }, () => [
        textNode(gen, words(gen, int(gen, 2, 4))),
      ]),
      element(gen, 'p', { base: { margin: '0' } }, () => [
        textNode(gen, words(gen, int(gen, 10, 40))),
      ]),
    ],
  );
}

function gridNode(gen: Gen): ElementNode {
  return element(
    gen,
    'section',
    {
      base: { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)', gap: '16px' },
      tablet: { 'grid-template-columns': 'repeat(2, 1fr)' },
      mobile: { 'grid-template-columns': '1fr' },
    },
    () => Array.from({ length: int(gen, 3, 12) }, () => gridCard(gen)),
  );
}

function footerNode(gen: Gen): ElementNode {
  return element(
    gen,
    'footer',
    { base: { 'border-top': '1px solid #dddddd', 'padding-top': '16px' } },
    () => [
      element(gen, 'p', { base: { margin: '0', color: '#5f6368' } }, () => [
        textNode(gen, words(gen, 6)),
      ]),
    ],
  );
}

function generatePage(gen: Gen, index: number): Page {
  const num = String(index).padStart(2, '0');
  const id = `gen-${num}`;
  return {
    id,
    name: `Generated ${num}`,
    route: `/${id}`,
    root: element(
      gen,
      'main',
      {
        base: {
          display: 'flex',
          'flex-direction': 'column',
          gap: '24px',
          padding: '32px',
          'font-family': 'system-ui, sans-serif',
        },
        mobile: { padding: '16px' },
      },
      () => [headerNode(gen), heroNode(gen), gridNode(gen), footerNode(gen)],
    ),
  };
}

// Starts from sampleDoc() and adds pages gen-02 .. gen-<pages>. Pages are drawn in order from one
// seeded stream, so a smaller page count yields the same leading pages.
export function generateDoc(opts: { pages: number; seed: number }): DesignDoc {
  const doc = sampleDoc();
  const gen: Gen = { rng: mulberry32(opts.seed), seq: doc.meta.seq };
  for (let index = 2; index <= opts.pages; index += 1) {
    const page = generatePage(gen, index);
    doc.pages[page.id] = page;
  }
  doc.meta.seq = gen.seq;
  return doc;
}
