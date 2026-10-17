// Test helpers: walk a rendered vnode tree without a DOM. Components are called as functions, so only hook-free
// views can be inspected this way; function children are expanded by calling them with their props.
import type { ComponentChild, VNode } from 'preact';

type Props = Record<string, unknown>;

/** Every element of a rendered tree, depth first. Function components are rendered by calling them. */
export function elements(node: ComponentChild, out: VNode[] = []): VNode[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (node !== null && typeof node === 'object') {
    const v = node as VNode;
    if (typeof v.type === 'function') return elements((v.type as (p: Props) => ComponentChild)(v.props as Props), out);
    out.push(v);
    elements(v.props.children as ComponentChild, out);
  }
  return out;
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
