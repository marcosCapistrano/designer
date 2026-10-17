// Test helpers: walk a rendered vnode tree without a DOM. Components are called as functions, so only hook-free
// views can be inspected this way; function children are expanded by calling them with their props.
import type { ComponentChild, VNode } from 'preact';

type Props = Record<string, unknown>;

/**
 * Every element of a rendered tree, depth first. Function components are rendered by calling them, except those in
 * `shallow` (components with hooks, which cannot run outside a render): those are listed as they are, unexpanded.
 */
export function elements(node: ComponentChild, out: VNode[] = [], shallow: ReadonlySet<unknown> = new Set()): VNode[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out, shallow));
  else if (node !== null && typeof node === 'object') {
    const v = node as VNode;
    if (typeof v.type === 'function' && !shallow.has(v.type)) return elements((v.type as (p: Props) => ComponentChild)(v.props as Props), out, shallow);
    out.push(v);
    if (typeof v.type !== 'function') elements(v.props.children as ComponentChild, out, shallow);
  }
  return out;
}

/** The first unexpanded element of a component in a tree walked with `shallow`. */
export function byType(els: VNode[], type: unknown): VNode {
  const e = els.find((v) => v.type === type);
  if (!e) throw new Error('no element of that component');
  return e;
}

export const text = (node: ComponentChild): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node === null || node === undefined || typeof node === 'boolean'
      ? ''
      : typeof node === 'object'
        ? typeof (node as VNode).type === 'function'
          ? text(((node as VNode).type as (p: Props) => ComponentChild)((node as VNode).props as Props))
          : text((node as VNode).props.children as ComponentChild)
        : String(node);

export const props = (v: VNode): Props => v.props as Props;

export function byTestId(els: VNode[], id: string): VNode {
  const e = els.find((v) => props(v)['data-testid'] === id);
  if (!e) throw new Error(`no element ${id}`);
  return e;
}

/** A minimal stand-in for an input event: handlers read `currentTarget.value` and `key`. */
export const inputEvent = (value: string, key?: string) =>
  ({ currentTarget: { value }, key, preventDefault() {} }) as unknown as Event;
