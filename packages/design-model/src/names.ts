// Layer names and the layer outline the Design area shows: what each node is called, and a page's tree with
// component instances expanded under hit-map ids (`instance/inner`).
import { ownValue } from './ops/util.js';
import type { DesignDoc, DesignNode, ElementNode } from './types.js';

export interface LayerOutline {
  id: string;
  name: string;
  kind: 'element' | 'text' | 'instance';
  component?: string;
  text?: string;
  children: LayerOutline[];
}

const clip = (text: string, max: number): string => {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A component's title: its definition root's name, else its id. */
export function componentTitle(doc: DesignDoc, id: string): string {
  return ownValue(doc.components, id)?.root.name || id;
}

/** What a node is called: its own name, else its tag (element), component title (instance) or text. */
export function displayName(doc: DesignDoc, node: DesignNode): string {
  if (node.kind === 'text') return clip(node.text, 40);
  if (node.name) return node.name;
  return node.kind === 'element' ? node.tag : componentTitle(doc, node.component);
}

/** How many instances of each component exist, on pages and inside other components. */
export function componentUses(doc: DesignDoc): Record<string, number> {
  const uses: Record<string, number> = {};
  const visit = (node: DesignNode): void => {
    if (node.kind === 'instance') uses[node.component] = (uses[node.component] ?? 0) + 1;
    else if (node.kind === 'element') node.children.forEach(visit);
  };
  for (const page of Object.values(doc.pages)) visit(page.root);
  for (const def of Object.values(doc.components)) visit(def.root);
  return uses;
}

// Deep enough for any real page; stops a component that (invalidly) contains itself.
const MAX_DEPTH = 64;

function outline(doc: DesignDoc, node: ElementNode | Extract<DesignNode, { kind: 'instance' }>, prefix: string, depth: number): LayerOutline {
  const id = prefix + node.id;
  if (node.kind === 'instance') {
    const def = ownValue(doc.components, node.component);
    const children = def && depth < MAX_DEPTH ? [outline(doc, def.root, `${id}/`, depth + 1)] : [];
    return { id, name: displayName(doc, node), kind: 'instance', component: node.component, children };
  }
  const textOnly = node.children.length > 0 && node.children.every((child) => child.kind === 'text');
  if (textOnly) {
    const text = clip(node.children.map((child) => (child.kind === 'text' ? child.text : '')).join(''), 80);
    return { id, name: displayName(doc, node), kind: 'text', text, children: [] };
  }
  const children = node.children.flatMap((child) => (child.kind === 'text' ? [] : [outline(doc, child, prefix, depth + 1)]));
  return { id, name: displayName(doc, node), kind: 'element', children };
}

/** The page's layer tree, or null for an unknown page. */
export function layerOutline(doc: DesignDoc, pageId: string): LayerOutline | null {
  const page = ownValue(doc.pages, pageId);
  return page ? outline(doc, page.root, '', 0) : null;
}
