import { ownValue } from './ops/util.js';
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
  return {
    ok: true,
    value: { html: renderHtml(root.value), css: renderCss(doc, root.value) },
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

// Blocks are joined with '\n' and nothing else.
function renderCss(doc: DesignDoc, root: ElementOut): string {
  const blocks: string[] = [];
  const tokens = tokenDeclarations(doc);
  if (tokens.length > 0) blocks.push(`:root{${tokens.join('')}}`);

  const elements = preorderElements(root);
  for (const el of elements) {
    if (hasEntries(el.styles.base)) blocks.push(ruleFor(el.id, el.styles.base));
  }
  for (const [device, query] of BREAKPOINTS) {
    const rules = elements
      .filter((el) => hasEntries(el.styles[device]))
      .map((el) => ruleFor(el.id, el.styles[device]));
    if (rules.length > 0) blocks.push(`@media ${query}{${rules.join('')}}`);
  }
  return blocks.join('\n');
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

function ruleFor(id: string, map: StyleMap): string {
  const decls = sortedEntries(map).map(([prop, value]) => `${prop}:${value};`).join('');
  return `[data-d-id="${cssString(id)}"]{${decls}}`;
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
