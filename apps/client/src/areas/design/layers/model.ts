// The layers panel's rows, kept apart from the view so expansion and presence are testable without a DOM.
import type { HitBox, LayerNode } from '@hub/protocol';

export interface LayerRow {
  node: LayerNode;
  depth: number;
  expandable: boolean;
  open: boolean;
  selected: boolean;
  /** Whether the layer has a box in the frame shown; one hidden at that size has none. */
  present: boolean;
}

export interface RowOptions {
  open: ReadonlySet<string>;
  selected: readonly string[];
  present(id: string): boolean;
}

/** The visible rows, depth first: a layer's children appear only while it is open. */
export function layerRows(root: LayerNode, opts: RowOptions): LayerRow[] {
  const rows: LayerRow[] = [];
  const selected = new Set(opts.selected);
  const visit = (node: LayerNode, depth: number): void => {
    const expandable = node.children.length > 0;
    const open = expandable && opts.open.has(node.id);
    rows.push({ node, depth, expandable, open, selected: selected.has(node.id), present: opts.present(node.id) });
    if (open) for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return rows;
}

/** The ids of every ancestor of the selected layers, so they are expanded and in view. */
export function autoOpen(root: LayerNode, selected: readonly string[]): Set<string> {
  const open = new Set<string>();
  const want = new Set(selected);
  const visit = (node: LayerNode, path: string[]): void => {
    if (want.has(node.id)) path.forEach((id) => open.add(id));
    for (const child of node.children) visit(child, [...path, node.id]);
  };
  visit(root, []);
  return open;
}

export function subtree(root: LayerNode, id: string): LayerNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = subtree(child, id);
    if (found) return found;
  }
  return null;
}

/** Whether a layer has a box in this hit map: its own, or one under it (an instance). Unknown maps count all. */
export function presentIn(boxes: readonly HitBox[] | null): (id: string) => boolean {
  if (boxes === null) return () => true;
  const ids = boxes.map((b) => b.nodeId);
  return (id) => ids.some((b) => b === id || b.startsWith(`${id}/`));
}
