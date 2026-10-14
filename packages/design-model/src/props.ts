import { ownValue } from './ops/util.js';
import { validateAttrValue } from './rules.js';
import { MAX_DEPTH } from './shape.js';
import type { ComponentDef, DesignNode, InstanceNode } from './types.js';

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
// Same pattern without the g flag, so test() keeps no state between calls.
const PLACEHOLDER_TEST = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;

// Replaces {{name}} with values[name]. A placeholder whose name is not an own key of values
// stays as written. Values are inserted once, so a value that contains a placeholder is not expanded again.
export function substituteProps(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (placeholder: string, name: string) =>
    ownValue(values, name) ?? placeholder,
  );
}

// The value of each declared prop: the instance's value when it sets one, otherwise the default.
// Props the instance sets but the component does not declare are left out.
export function resolveProps(def: ComponentDef, inst: InstanceNode): Record<string, string> {
  return Object.fromEntries(
    Object.entries(def.props).map(([name, decl]): [string, string] => [
      name,
      ownValue(inst.props, name) ?? decl.default,
    ]),
  );
}

// The declared default of every prop of the component.
export function defaultProps(def: ComponentDef): Record<string, string> {
  return Object.fromEntries(Object.entries(def.props).map(([name, decl]): [string, string] => [name, decl.default]));
}

// A copy of an instance's props with `prop` set to `value`, or removed when `value` is null.
export function withProp(
  props: Record<string, string>,
  prop: string,
  value: string | null,
): Record<string, string> {
  const entries = Object.entries(props).filter(([name]) => name !== prop);
  if (value !== null) entries.push([prop, value]);
  return Object.fromEntries(entries);
}

// The attributes of the component's own elements whose value has a {{prop}} placeholder, as
// [node id, name, template]. Instances inside the component are not entered: what they receive is
// checked where the page is exported. The walk stops at MAX_DEPTH, so a tree that is too deep
// (which validateDoc reports) cannot overflow the stack here.
export function templatedAttrs(def: ComponentDef): [string, string, string][] {
  const found: [string, string, string][] = [];
  const visit = (node: DesignNode, depth: number): void => {
    if (node.kind !== 'element' || depth > MAX_DEPTH) return;
    for (const [name, template] of Object.entries(node.attrs)) {
      if (PLACEHOLDER_TEST.test(template)) found.push([node.id, name, template]);
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(def.root, 1);
  return found;
}

// Why filling `values` into the component's attributes would leave one that validateAttrValue
// rejects (javascript: in an href, for one), or null. `values` is the full set of props the
// component would be expanded with, so a value that is only unsafe next to another is found too.
// `attrs` is templatedAttrs(def), for a caller that checks many instances of one component.
export function propAttrIssue(
  def: ComponentDef,
  values: Record<string, string>,
  attrs: [string, string, string][] = templatedAttrs(def),
): string | null {
  for (const [id, name, template] of attrs) {
    const problem = validateAttrValue(name, substituteProps(template, values));
    if (problem !== null) return `${problem} (component ${def.name}, node ${id})`;
  }
  return null;
}
