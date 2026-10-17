// Component mode: editing a component in place. The mode is a stack of instance paths (hit-map ids), outermost
// first: `['a']` inside instance a, `['a', 'a/b']` inside the instance b nested in a's component.
import type { DesignLayers, LayerNode } from '@hub/protocol';
import { prefixOf } from '../../canvas/scope.js';
import { subtree } from './layers/model.js';

export type ModeStack = readonly string[];

/** Steps into instance `id`, which must sit inside the current one (any instance, at the page level). */
export function enter(stack: ModeStack, id: string): ModeStack {
  const prefix = prefixOf(stack);
  return prefix === '' || id.startsWith(`${prefix}/`) ? [...stack, id] : stack;
}

/** Every instance on the way to layer `id`: the stack that shows it as an editable layer. */
export function enterPath(id: string): ModeStack {
  const segments = id.split('/');
  return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

export const leave = (stack: ModeStack): ModeStack => stack.slice(0, -1);

/** The stack up to the first instance the outline no longer has (an edit removed it). */
export function alive(stack: ModeStack, root: LayerNode): ModeStack {
  const at = stack.findIndex((id) => subtree(root, id)?.kind !== 'instance');
  return at === -1 ? stack : stack.slice(0, at);
}

export interface ModeLabel { title: string; uses: number; path: string; component: string }

/** The innermost component's title, how often it is used, its id, and the path of titles down to it. */
export function modeLabel(stack: ModeStack, layers: DesignLayers): ModeLabel | null {
  const titles = stack.map((id) => {
    const component = subtree(layers.root, id)?.component ?? '';
    return { component, title: layers.components[component]?.title ?? component, uses: layers.components[component]?.uses ?? 0 };
  });
  const last = titles.at(-1);
  return last ? { title: last.title, uses: last.uses, component: last.component, path: titles.map((t) => t.title).join(' › ') } : null;
}

/** The layer an instance draws as its root: what is selected on entering it. */
export function rootOf(root: LayerNode, instance: string): string | null {
  const node = subtree(root, instance);
  return node?.kind === 'instance' ? (node.root ?? null) : null;
}

/** The component mode a selection is edited in: the instances its layers sit inside, when they all share them. */
export function modeFor(nodeIds: readonly string[] | null): ModeStack {
  const [first, ...rest] = nodeIds ?? [];
  if (first === undefined) return [];
  const mode = enterPath(first);
  const prefix = mode.at(-1);
  return prefix === undefined || rest.every((id) => id.startsWith(`${prefix}/`)) ? mode : [];
}
