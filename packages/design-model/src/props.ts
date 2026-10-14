import { ownValue } from './ops/util.js';
import type { ComponentDef, InstanceNode } from './types.js';

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

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
