import { ownValue, SHELL_ATTR } from './ops/util.js';
import { resolveProps, substituteProps } from './props.js';
import { validateAttrValue, VOID_TAGS } from './rules.js';
import type {
  DesignDoc,
  DesignNode,
  Device,
  ElementNode,
  InstanceNode,
  NodeStyle,
  Result,
  StyleMap,
} from './types.js';

// Written in this order, so the tablet block comes before the mobile block.
const BREAKPOINTS: readonly [Exclude<Device, 'base'>, string][] = [
  ['tablet', '(max-width: 1023px)'],
  ['mobile', '(max-width: 599px)'],
];

interface Styles {
  base: StyleMap;
  tablet: StyleMap;
  mobile: StyleMap;
}

// Most nodes one page may expand to. Components are expanded, so a small page can hold a
// large tree; the count runs while expanding, so an oversized page is refused before any output is built.
export const EXPORT_NODE_LIMIT = 20000;

// The tree after expansion: component instances are replaced by their elements, and ids,
// attribute values and text are final. Only the HTML and CSS renderers read this.
interface TextOut {
  kind: 'text';
  text: string;
}

interface ElementOut {
  kind: 'element';
  id: string;
  tag: string;
  attrs: [string, string][];
  styles: Styles;
  children: Out[];
}

type Out = TextOut | ElementOut;

interface Scope {
  doc: DesignDoc;
  // Written before each node id: '' on the page, 'n5/' inside instance n5, 'n5/n9/' inside n9 within n5.
  prefix: string;
  // Values for {{name}} placeholders. Empty on the page, so page text is never substituted.
  props: Record<string, string>;
  // Components being expanded, outermost first. Used to detect a component that contains itself.
  components: string[];
  // Shared by every scope of one page's expansion.
  budget: Budget;
}

interface Budget {
  pageId: string;
  used: number;
}

// Counts one expanded node. Returns an error once the page has more than EXPORT_NODE_LIMIT.
function takeNode(scope: Scope): Result<null> {
  scope.budget.used += 1;
  if (scope.budget.used > EXPORT_NODE_LIMIT) {
    return { ok: false, error: `Page ${scope.budget.pageId} exceeds ${EXPORT_NODE_LIMIT} nodes` };
  }
  return { ok: true, value: null };
}

// Never throws (Ruling 39): a doc that bypasses validation is reported as a failed export.
export function exportPage(
  doc: DesignDoc,
  pageId: string,
): Result<{ html: string; css: string }> {
  try {
    return buildPage(doc, pageId);
  } catch (err) {
    return { ok: false, error: `Export failed: ${messageOf(err)}` };
  }
}

function buildPage(doc: DesignDoc, pageId: string): Result<{ html: string; css: string }> {
  const page = ownValue(doc.pages, pageId);
  if (page === undefined) return { ok: false, error: `Page ${pageId} not found` };

  const root = expandElement(page.root, {
    doc,
    prefix: '',
    props: {},
    components: [],
    budget: { pageId, used: 0 },
  });
  if (!root.ok) return root;
  const shell = page.root.attrs[SHELL_ATTR] === 'html';
  return {
    ok: true,
    value: { html: renderHtml(root.value), css: renderCss(doc, root.value, shell) },
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

function expandNode(node: DesignNode, scope: Scope): Result<Out> {
  if (node.kind === 'text') {
    const counted = takeNode(scope);
    if (!counted.ok) return counted;
    return { ok: true, value: { kind: 'text', text: substituteProps(node.text, scope.props) } };
  }
  if (node.kind === 'element') return expandElement(node, scope);
  return expandInstance(node, scope);
}

function expandElement(
  node: ElementNode,
  scope: Scope,
  styles: Styles = layerStyles(node.style),
): Result<ElementOut> {
  const counted = takeNode(scope);
  if (!counted.ok) return counted;
  const id = scope.prefix + node.id;
  const attrs = expandAttrs(node, id, scope);
  if (!attrs.ok) return attrs;
  const children = expandAll(node.children, scope);
  if (!children.ok) return children;
  return {
    ok: true,
    value: { kind: 'element', id, tag: node.tag, attrs: attrs.value, styles, children: children.value },
  };
}

// Attribute values after prop substitution. A prop can turn a safe template into an unsafe value
// (href="{{url}}" with url set to javascript:...), so each final value is checked here and the
// page is refused: no unsafe value is ever written out.
function expandAttrs(node: ElementNode, id: string, scope: Scope): Result<[string, string][]> {
  const attrs: [string, string][] = [];
  for (const [name, template] of sortedEntries(node.attrs)) {
    const value = substituteProps(template, scope.props);
    const problem = validateAttrValue(name, value);
    if (problem !== null) {
      return { ok: false, error: `Page ${scope.budget.pageId} node ${id}: ${problem}` };
    }
    attrs.push([name, value]);
  }
  return { ok: true, value: attrs };
}

// The expanded root takes the instance's id prefix, and its style is the component root's
// style with the instance's style layered over it. The instance's prop values are written in
// the enclosing component's terms, so placeholders in them are resolved against scope.props first.
function expandInstance(node: InstanceNode, scope: Scope): Result<ElementOut> {
  const def = ownValue(scope.doc.components, node.component);
  if (def === undefined) return { ok: false, error: `Component ${node.component} not found` };
  if (scope.components.includes(node.component)) {
    return { ok: false, error: `Component cycle at ${node.component}` };
  }
  const passed: InstanceNode = {
    ...node,
    props: Object.fromEntries(
      Object.entries(node.props).map(([name, value]): [string, string] => [
        name,
        substituteProps(value, scope.props),
      ]),
    ),
  };
  return expandElement(
    def.root,
    {
      doc: scope.doc,
      prefix: `${scope.prefix}${node.id}/`,
      props: resolveProps(def, passed),
      components: [...scope.components, node.component],
      budget: scope.budget,
    },
    layerStyles(node.style, def.root.style),
  );
}

function expandAll(nodes: DesignNode[], scope: Scope): Result<Out[]> {
  const out: Out[] = [];
  for (const node of nodes) {
    const result = expandNode(node, scope);
    if (!result.ok) return result;
    out.push(result.value);
  }
  return { ok: true, value: out };
}

// Per device and per prop, `over` wins over `under`.
function layerStyles(over: NodeStyle, under: NodeStyle = { base: {} }): Styles {
  return {
    base: { ...under.base, ...over.base },
    tablet: { ...under.tablet, ...over.tablet },
    mobile: { ...under.mobile, ...over.mobile },
  };
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => byKey(a, b));
}

const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeChar(ch: string): string {
  return ESCAPED[ch] ?? ch;
}

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, escapeChar);
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, escapeChar);
}

function renderHtml(out: Out): string {
  if (out.kind === 'text') return escapeText(out.text);
  const attrs = [
    `data-d-id="${escapeAttr(out.id)}"`,
    ...out.attrs.map(([name, value]) => `${name}="${escapeAttr(value)}"`),
  ];
  const open = `<${out.tag} ${attrs.join(' ')}>`;
  const inner = out.children.map(renderHtml).join('');
  return VOID_TAGS.has(out.tag) ? `${open}${inner}` : `${open}${inner}</${out.tag}>`;
}

// Blocks are joined with '\n' and nothing else. `shell` marks a page root that stands for the source html element.
function renderCss(doc: DesignDoc, root: ElementOut, shell: boolean): string {
  const blocks: string[] = [];
  const tokens = tokenDeclarations(doc);
  if (tokens.length > 0) blocks.push(`:root{${tokens.join('')}}`);

  const html = shell ? propagateShell(root) : null;
  const elements = preorderElements(root);
  const base = elements.filter((el) => hasEntries(el.styles.base)).map((el) => ruleFor(el.id, el.styles.base));
  if (html !== null && hasEntries(html.base)) base.unshift(`html{${declarations(html.base)}}`);
  blocks.push(...base);
  for (const [device, query] of BREAKPOINTS) {
    const rules = elements
      .filter((el) => hasEntries(el.styles[device]))
      .map((el) => ruleFor(el.id, el.styles[device]));
    if (html !== null && hasEntries(html[device])) rules.unshift(`html{${declarations(html[device])}}`);
    if (rules.length > 0) blocks.push(`@media ${query}{${rules.join('')}}`);
  }
  return blocks.join('\n');
}

// Ruling P: the page root stands for the source html element and its first element child for body, but both are
// exported as divs. What the browser takes from them for the whole document is moved to the real html element: the
// root's font and color-scheme (so rem and relative font sizes resolve as in the source), and the canvas background,
// which is html's background when it paints, else body's. Returns the declarations for html, per device block.
function propagateShell(root: ElementOut): Styles {
  const html: Styles = { base: {}, tablet: {}, mobile: {} };
  const devices = ['base', 'tablet', 'mobile'] as const;
  const move = (from: ElementOut, test: (prop: string) => boolean) => {
    for (const device of devices) {
      for (const [prop, value] of Object.entries(from.styles[device])) {
        if (!test(prop)) continue;
        html[device][prop] = value;
        delete from.styles[device][prop];
      }
    }
  };
  move(root, (prop) => prop === 'color-scheme' || prop === 'font' || prop.startsWith('font-'));
  const body = root.children.find((child): child is ElementOut => child.kind === 'element');
  // Effective maps per device: a device block cascades over the blocks before it.
  const effective = (el: ElementOut | undefined) => {
    const out: StyleMap[] = [];
    let acc: StyleMap = {};
    for (const device of devices) {
      const map = el?.styles[device] ?? {};
      // A background shorthand resets the background longhands set in earlier blocks.
      if (Object.hasOwn(map, 'background')) acc = Object.fromEntries(Object.entries(acc).filter(([prop]) => !isBackground(prop)));
      acc = { ...acc, ...map };
      out.push(acc);
    }
    return out;
  };
  const rootMaps = effective(root), bodyMaps = effective(body);
  const sources = devices.map((_, i) => paintsBackground(rootMaps[i]!) ? root : bodyMaps[i] && paintsBackground(bodyMaps[i]!) ? body : undefined);
  if (sources.every((source) => source === sources[0])) {
    if (sources[0] !== undefined) move(sources[0], isBackground);
    return html;
  }
  // The propagating element changes between devices: each block that changes the canvas restates it in full, and
  // each div paints its own background only in the blocks where it does not propagate, restated where that changes.
  let before = '';
  devices.forEach((device, i) => {
    const source = sources[i] === root ? rootMaps[i]! : sources[i] === body ? bodyMaps[i]! : {};
    const canvas = backgroundOf(source);
    const key = declarations(canvas);
    if (key === before) return;
    if (i > 0 && !Object.hasOwn(canvas, 'background')) html[device]['background'] = 'initial';
    Object.assign(html[device], canvas);
    before = key;
  });
  for (const [el, maps] of [[root, rootMaps], [body, bodyMaps]] as const) {
    if (el === undefined) continue;
    let painted: StyleMap = {};
    devices.forEach((device, i) => {
      const own = el.styles[device];
      for (const prop of Object.keys(own)) if (isBackground(prop)) delete own[prop];
      const wanted = sources[i] === el ? {} : backgroundOf(maps[i]!);
      if (declarations(wanted) === declarations(painted)) return;
      if (hasEntries(painted) && !Object.hasOwn(wanted, 'background')) own['background'] = 'initial';
      Object.assign(own, wanted);
      painted = wanted;
    });
  }
  return html;
}

function backgroundOf(map: StyleMap): StyleMap {
  return Object.fromEntries(Object.entries(map).filter(([prop]) => isBackground(prop)));
}

function isBackground(prop: string): boolean {
  return prop === 'background' || prop.startsWith('background-');
}

// Keywords and zero-alpha colors that paint nothing. A var() is taken to paint: its value is not resolved here.
const NO_PAINT = /^(?:transparent|none|initial|unset|revert|revert-layer|#[0-9a-f]{3}0|#[0-9a-f]{6}00|(?:rgb|hsl)a?\((?:(?:[^,/)]*,){3}|[^,/)]*\/)\s*(?:0+(?:\.0*)?|\.0+)%?\s*\))$/i;

// Whether a style map gives the element a background the browser would propagate to the canvas.
function paintsBackground(map: StyleMap): boolean {
  return ['background', 'background-color', 'background-image'].some((prop) => {
    const value = ownValue(map, prop);
    return value !== undefined && !NO_PAINT.test(value.trim());
  });
}

function tokenDeclarations(doc: DesignDoc): string[] {
  const decls: string[] = [];
  for (const [group, names] of sortedEntries(doc.tokens)) {
    for (const [name, value] of sortedEntries(names)) {
      decls.push(`--${group}-${name}:${value};`);
    }
  }
  return decls;
}

function preorderElements(out: Out): ElementOut[] {
  if (out.kind === 'text') return [];
  return [out, ...out.children.flatMap(preorderElements)];
}

function hasEntries(map: StyleMap): boolean {
  return Object.keys(map).length > 0;
}

function declarations(map: StyleMap): string {
  return sortedEntries(map).map(([prop, value]) => `${prop}:${value};`).join('');
}

function ruleFor(id: string, map: StyleMap): string {
  return `[data-d-id="${cssString(id)}"]{${declarations(map)}}`;
}

// Escapes the characters that would end a quoted CSS string or the <style> element around it.
// Hex escapes end with a space, so a hex digit that follows stays literal.
const CSS_STRING_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '<': '\\3C ',
  '>': '\\3E ',
  '\n': '\\A ',
  '\r': '\\D ',
  '\f': '\\C ',
};

function cssString(value: string): string {
  return value.replace(/["\\<>\n\r\f]/g, (ch) => CSS_STRING_ESCAPES[ch] ?? ch);
}
