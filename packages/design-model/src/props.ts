import { ownValue } from './ops/util.js';
import { validateAttrValue } from './rules.js';
import { MAX_DEPTH } from './shape.js';
import { walkDoc, type Container } from './tree.js';
import type { ComponentDef, DesignDoc, DesignNode, InstanceNode } from './types.js';

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

// An attribute whose value has a {{prop}} placeholder: [node id, name, template].
export type TemplatedAttr = [id: string, name: string, template: string];

// The templated attributes of the elements in the subtree at `node`. Instances inside it are not
// entered: what they receive is checked where the page is exported. The walk stops at MAX_DEPTH,
// so a tree that is too deep (which validateDoc and the ops report) cannot overflow the stack here.
export function templatedAttrsIn(node: DesignNode): TemplatedAttr[] {
  const found: TemplatedAttr[] = [];
  const visit = (current: DesignNode, depth: number): void => {
    if (current.kind !== 'element' || depth > MAX_DEPTH) return;
    for (const [name, template] of Object.entries(current.attrs)) {
      if (PLACEHOLDER_TEST.test(template)) found.push([current.id, name, template]);
    }
    for (const child of current.children) visit(child, depth + 1);
  };
  visit(node, 1);
  return found;
}

// The templated attributes of the component's own elements.
export function templatedAttrs(def: ComponentDef): TemplatedAttr[] {
  return templatedAttrsIn(def.root);
}

// The one attribute `name` of node `id` set to `value`, as a list: empty when the value has no placeholder.
export function templatedAttr(id: string, name: string, value: string): TemplatedAttr[] {
  return PLACEHOLDER_TEST.test(value) ? [[id, name, value]] : [];
}

// Why filling `values` into the component's attributes would leave one that validateAttrValue
// rejects (javascript: in an href, for one), or null. `values` is the full set of props the
// component would be expanded with, so a value that is only unsafe next to another is found too.
// `attrs` is templatedAttrs(def), for a caller that checks many instances of one component.
export function propAttrIssue(
  def: ComponentDef,
  values: Record<string, string>,
  attrs: TemplatedAttr[] = templatedAttrs(def),
): string | null {
  for (const [id, name, template] of attrs) {
    const problem = validateAttrValue(name, substituteProps(template, values));
    if (problem !== null) return `${problem} (component ${def.name}, node ${id})`;
  }
  return null;
}

// Why adding the templated attributes `added` to the component that `container` names would leave an
// instance of it with an attribute that validateAttrValue rejects, or null. An edit inside a component
// can make an instance unsafe that was fine before, because the prop it sets only fed text until now.
// Every instance in the doc is checked, on pages and inside other components, and so is the component's
// own set of defaults. Only the added attributes are checked: the ones already there passed when they were added.
export function editedAttrsIssue(doc: DesignDoc, container: Container, added: TemplatedAttr[]): string | null {
  if (container.kind !== 'component' || added.length === 0) return null;
  const def = ownValue(doc.components, container.key);
  if (def === undefined) return null;
  const unsafeDefault = propAttrIssue(def, defaultProps(def), added);
  if (unsafeDefault !== null) return unsafeDefault;
  let issue: string | null = null;
  walkDoc(doc, (node) => {
    if (issue !== null || node.kind !== 'instance' || node.component !== container.key) return;
    issue = propAttrIssue(def, resolveProps(def, node), added);
  });
  return issue;
}
