import type { ComponentDef, InstanceNode } from './types.js';

// Each declared prop's default, overlaid by the instance's own props.
export function resolveProps(def: ComponentDef, inst: InstanceNode): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, decl] of Object.entries(def.props)) values[name] = decl.default;
  for (const [name, value] of Object.entries(inst.props)) values[name] = value;
  return values;
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

// Replaces {{name}} with values[name]. A placeholder whose name is not a key of values is kept.
export function substituteProps(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (placeholder: string, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? placeholder) : placeholder,
  );
}
