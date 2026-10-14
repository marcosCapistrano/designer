export type Device = 'base' | 'tablet' | 'mobile';
export const DEVICES: readonly Device[] = ['base', 'tablet', 'mobile'];
export type StyleMap = Record<string, string>;
export interface NodeStyle { base: StyleMap; tablet?: StyleMap; mobile?: StyleMap }

export interface ElementNode {
  id: string; kind: 'element'; name?: string; tag: string;
  attrs: Record<string, string>; style: NodeStyle; children: DesignNode[];
}
export interface TextNode { id: string; kind: 'text'; text: string }   // text may contain {{prop}} placeholders inside components
export interface InstanceNode {
  id: string; kind: 'instance'; name?: string; component: string;
  props: Record<string, string>; style: NodeStyle;
}
export type DesignNode = ElementNode | TextNode | InstanceNode;

export interface Page { id: string; name: string; route: string; root: ElementNode }
export interface ComponentDef { name: string; props: Record<string, { default: string }>; root: ElementNode }
export type Tokens = Record<string, Record<string, string>>;   // group -> name -> value, emitted as --group-name
export interface DesignDoc {
  meta: { version: 1; seq: number };
  pages: Record<string, Page>;
  components: Record<string, ComponentDef>;
  tokens: Tokens;
}

export type Op =
  | { op: 'setStyle'; node: string; device: Device; prop: string; value: string | null }
  | { op: 'setText'; node: string; text: string }
  | { op: 'setAttr'; node: string; name: string; value: string | null }
  | { op: 'setName'; node: string; name: string | null }
  | { op: 'setToken'; group: string; name: string; value: string | null }
  | { op: 'insertNode'; parent: string; index: number; node: DesignNode }
  | { op: 'removeNode'; node: string }
  | { op: 'moveNode'; node: string; parent: string; index: number }
  | { op: 'wrapNodes'; nodes: string[]; wrapper: ElementNode }
  | { op: 'extractComponent'; node: string; component: string; instanceId: string }
  | { op: 'setInstanceProp'; node: string; prop: string; value: string | null }
  | { op: 'detachInstance'; node: string; idMap: Record<string, string> }
  | { op: 'addPage'; page: Page }
  | { op: 'duplicatePage'; source: string; page: { id: string; name: string; route: string }; idMap: Record<string, string> }
  | { op: 'removePage'; page: string }
  | { op: 'restore'; seq: number; entries: RestoreEntry[] };

export type RestoreEntry =
  | { kind: 'page'; key: string; value: Page | null }
  | { kind: 'component'; key: string; value: ComponentDef | null }
  | { kind: 'tokens'; key: string; value: Record<string, string> | null };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
