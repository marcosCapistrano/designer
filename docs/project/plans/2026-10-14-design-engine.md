# Design Engine Implementation Plan (Plan 1 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure TypeScript package `@hub/design-model` that holds a design document, applies validated edit operations deterministically with undo/redo, keeps the changelist, serializes to canonical files, and exports pages to HTML/CSS.

**Architecture:** Immutable document in, new document out. Every op is validated before it is applied. Undo is generic: after any op, the top-level entries (pages, components, token groups) whose canonical JSON changed are captured into a `restore` op. Canonical JSON (sorted keys) makes the output byte-identical for identical input.

**Tech Stack:** Node 22, pnpm 10 workspaces, TypeScript 5 (strict, ESM), vitest, css-tree (CSS validation), fast-check (property tests, dev only).

**Spec:** `docs/superpowers/specs/2026-10-14-hub-design.md` (sections 5.1, 5.2, 5.3, 5.5 device widths, 5.6, 5.7)

**Roadmap (later plans, each its own document):** 2 Renderer + canvas client · 3 Hub server + Build area · 4 Convention, template, Deploy, New app, Adopt · 5 Sync from source · 6 Handoff + voice.

## Global Constraints

- Node 22, pnpm 10, TypeScript `strict: true`, `"type": "module"`, `moduleResolution: "Bundler"`.
- `packages/design-model` has exactly one runtime dependency: `css-tree`. Dev deps: `vitest`, `fast-check`, `typescript`, `@types/css-tree`.
- No `Date`, `Math.random`, or any I/O inside `packages/design-model/src`. Every function is pure and deterministic.
- Functions never mutate their inputs. Clone with `structuredClone`.
- Devices: `base` (desktop, 1440px wide), `tablet` (834px, media `(max-width: 1023px)`), `mobile` (390px, media `(max-width: 599px)`).
- New node IDs match `/^n\d+$/` and come from `allocIds`. `meta.seq` never decreases.
- CSS property names are kebab-case. Style values are strings. Custom properties (`--*`) and `var(--…)` values are allowed.
- Every test file lives next to the code in `src/*.test.ts`. Run from repo root: `pnpm -r test`, `pnpm -r typecheck`.

## Review Focus

1. Text or attributes containing `<`, `&`, `"` or emoji must be escaped in the HTML export, never break the markup (Task 11 test `escapes text and attributes`).
2. A unitless or garbage value like `padding: "12"` or `color: "blu"` must be rejected with a readable reason, not stored (Task 4 tests).
3. A batch where op 3 of 4 is invalid must leave the document completely unchanged and report index 2 (Task 10 test `atomic batch`).
4. Moving a node into its own descendant must be rejected instead of corrupting the tree (Task 6 test `rejects move into descendant`).
5. Editing a component definition used by many pages must be classified as `preview`, never `immediate` (Task 10 test `component edits need preview`).

---

## File Structure

```
package.json                    workspace root (scripts: test, typecheck)
pnpm-workspace.yaml             packages: ["packages/*", "apps/*"]
tsconfig.base.json              shared compiler options
.github/workflows/ci.yml        pnpm install, typecheck, test
packages/design-model/
  package.json, tsconfig.json, vitest.config.ts
  src/index.ts                  public exports only
  src/types.ts                  document + op types
  src/canonical.ts              canonicalStringify
  src/tree.ts                   findNode, walkDoc, allIds, allocIds
  src/css.ts                    validateStyle
  src/apply.ts                  applyOp, validateOp, dispatch to handlers
  src/ops/basic.ts              setStyle, setText, setAttr, setName, setToken, restore
  src/ops/structure.ts          insertNode, removeNode, moveNode, wrapNodes
  src/ops/components.ts         extractComponent, setInstanceProp, detachInstance
  src/ops/pages.ts              addPage, duplicatePage, removePage
  src/files.ts                  serializeDoc, parseDoc, oplog encode/decode
  src/session.ts                DesignSession, classifyBatch
  src/export.ts                 exportPage
  src/describe.ts               describeOp
  src/fixtures.ts               sampleDoc() used by tests
```

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `packages/design-model/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/smoke.test.ts}`

**Interfaces:**
- Produces: package name `@hub/design-model`, scripts `test` (`vitest run`) and `typecheck` (`tsc --noEmit`) in it. Root scripts `test` = `pnpm -r test`, `typecheck` = `pnpm -r typecheck`.

- [ ] **Step 1:** Create the files. `tsconfig.base.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes: false`, `skipLibCheck`. `.gitignore`: `node_modules`, `dist`, `coverage`. CI: ubuntu-latest, `pnpm/action-setup@v4` (version 10), `actions/setup-node@v4` (node 22, cache pnpm), `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.
- [ ] **Step 2:** `src/smoke.test.ts`: `expect(1 + 1).toBe(2)`.
- [ ] **Step 3:** Run `pnpm install && pnpm add -F @hub/design-model css-tree && pnpm add -D -F @hub/design-model vitest fast-check typescript @types/css-tree`. Run `pnpm test && pnpm typecheck`. Expected: 1 test passes, no type errors.
- [ ] **Step 4:** Commit `chore: scaffold pnpm workspace and design-model package`.

---

### Task 2: Types, canonical JSON, fixture

**Files:**
- Create: `src/types.ts`, `src/canonical.ts`, `src/canonical.test.ts`, `src/fixtures.ts`

**Interfaces:**
- Produces (exact, copy into `types.ts`):

```ts
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
```

- Produces: `canonicalStringify(value: unknown): string` (object keys sorted by code point, recursively; arrays keep order; `undefined` properties omitted; 2-space indent; trailing `\n`).
- Produces: `sampleDoc(): DesignDoc` in `fixtures.ts`. Page `home` (route `/`, name `Home`) whose root `n1` (`main`) has children: `n2` header (name `Header`) containing `n3` button (name `LoginButton`, style base `{padding: '8px'}`) containing text `n4` "Log in"; and `n5` instance of component `Card` (props `{title: 'Hello'}`). Component `Card` (props `{title: {default: 'Title'}}`) root `n6` `div` (style base `{padding: '16px'}`) containing `n7` `h2` containing text `n8` `{{title}}`. Tokens `{color: {primary: '#3366ff'}}`. `meta.seq` = 9.

- [ ] **Step 1: Write failing tests** in `canonical.test.ts`:
  - `sorts keys recursively`: `canonicalStringify({b: 1, a: {d: 1, c: 2}})` === `'{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n'`
  - `keeps array order`: `canonicalStringify([3, 1])` === `'[\n  3,\n  1\n]\n'`
  - `omits undefined`: `canonicalStringify({a: undefined, b: 1})` === `'{\n  "b": 1\n}\n'`
  - `stable across insertion order`: two objects with the same keys inserted in different order give equal strings.
- [ ] **Step 2:** Run `pnpm -F @hub/design-model test`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `types.ts`, `canonical.ts`, `fixtures.ts`. Export all from `index.ts`.
- [ ] **Step 4:** Run tests. Expected: PASS. Run `pnpm typecheck`. Expected: clean.
- [ ] **Step 5:** Commit `feat(design-model): types, canonical JSON, fixture`.

---

### Task 3: Tree helpers

**Files:**
- Create: `src/tree.ts`, `src/tree.test.ts`

**Interfaces:**
- Produces:

```ts
export type Container = { kind: 'page'; key: string } | { kind: 'component'; key: string };
export interface Located { node: DesignNode; container: Container; parent: ElementNode | null; index: number; path: DesignNode[] /* ancestors root..parent */ }
export function findNode(doc: DesignDoc, id: string): Located | null;
export function walkDoc(doc: DesignDoc, visit: (node: DesignNode, container: Container) => void): void; // pages in sorted key order, then components in sorted key order, depth-first pre-order
export function allIds(doc: DesignDoc): string[];          // in walkDoc order
export function allocIds(doc: DesignDoc, count: number): string[]; // ['n'+seq, 'n'+(seq+1), ...]; does NOT change doc
export function nextSeq(doc: DesignDoc): number;           // max(doc.meta.seq, 1 + max numeric suffix of ids matching /^n(\d+)$/)
export function isDescendant(ancestor: DesignNode, id: string): boolean; // true if id is ancestor itself or inside it
```

- [ ] **Step 1: Write failing tests** using `sampleDoc()`:
  - `findNode finds nested node`: `findNode(doc,'n4')` has `parent.id === 'n3'`, `index === 0`, `container` `{kind:'page',key:'home'}`, path ids `['n1','n2','n3']`.
  - `findNode finds component node`: `findNode(doc,'n8').container` equals `{kind:'component',key:'Card'}`.
  - `findNode root`: `findNode(doc,'n1')` has `parent === null`, `index === 0`.
  - `findNode missing`: `findNode(doc,'zzz') === null`.
  - `allIds order`: equals `['n1','n2','n3','n4','n5','n6','n7','n8']`.
  - `allocIds`: `allocIds(doc, 2)` equals `['n9','n10']`, and `doc.meta.seq` is still 9.
  - `nextSeq uses max id`: a doc with `meta.seq = 1` and a node `n41` gives `42`.
  - `isDescendant`: n2 contains n4 → true; n4 contains n2 → false; node contains itself → true.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement `tree.ts`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): tree helpers`.

---

### Task 4: CSS validation

**Files:**
- Create: `src/css.ts`, `src/css.test.ts`

**Interfaces:**
- Produces: `validateStyle(prop: string, value: string): string | null`. It returns `null` when valid, otherwise a human-readable reason that includes the property name.

Rules: the property must be kebab-case (`/^-?-?[a-z][a-z0-9-]*$/`). Custom properties (`--x`) accept any non-empty value. Otherwise, use `csstree.lexer.matchProperty(prop, csstree.parse(value, { context: 'value' }))`. If `.error` is set, return `` `Invalid value "${value}" for ${prop}` ``. An unknown property returns `` `Unknown CSS property "${prop}"` ``. Values containing `var(` are accepted for known properties.

- [ ] **Step 1: Write failing tests:**
  - valid: `('padding','8px')`, `('padding','8px 12px')`, `('color','#fff')`, `('color','var(--color-primary)')`, `('display','flex')`, `('--brand','anything')` all return `null`.
  - `rejects unitless padding`: `validateStyle('padding','12')` contains `padding`.
  - `rejects bad color`: `validateStyle('color','blu')` is not null.
  - `rejects unknown property`: `validateStyle('colr','red')` contains `Unknown CSS property`.
  - `rejects camelCase`: `validateStyle('backgroundColor','red')` is not null.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): CSS property validation`.

---

### Task 5: Apply core and basic ops

**Files:**
- Create: `src/apply.ts`, `src/ops/basic.ts`, `src/apply.test.ts`

**Interfaces:**
- Consumes: `findNode`, `nextSeq` (Task 3), `validateStyle` (Task 4), `canonicalStringify` (Task 2).
- Produces:

```ts
export function validateOp(doc: DesignDoc, op: Op): string | null;
export function applyOp(doc: DesignDoc, op: Op): Result<{ doc: DesignDoc; inverse: Op /* always op:'restore' */ }>;
// handler contract used by all ops/*.ts files:
export interface OpHandler<K extends Op['op']> {
  validate(doc: DesignDoc, op: Extract<Op, { op: K }>): string | null;
  mutate(draft: DesignDoc, op: Extract<Op, { op: K }>): void;   // draft is a structuredClone; mutate in place
}
export const handlers: { [K in Op['op']]?: OpHandler<K> };   // filled by registerHandlers in each ops file
```

`applyOp` algorithm (write it this way):
1. `err = validateOp(doc, op)`. If set, return `{ok:false,error:err}`. `validateOp` returns `` `Unknown op "${op.op}"` `` when there is no handler.
2. `draft = structuredClone(doc)`, then `handler.mutate(draft, op)`.
3. `draft.meta.seq = nextSeq(draft)`.
4. For each key in the union of `doc.pages`/`draft.pages` keys: if `canonicalStringify(doc.pages[k]) !== canonicalStringify(draft.pages[k])`, push `{kind:'page', key:k, value: doc.pages[k] ?? null}`. Do the same for components and token groups. Sort entries by kind (`page`, `component`, `tokens`) then key.
5. Return `{ok:true, value:{doc: draft, inverse:{op:'restore', seq: doc.meta.seq, entries}}}`.

The `restore` handler sets or deletes each entry and sets `meta.seq = max(current, op.seq)`. The seq never decreases, so undo cannot cause ID reuse.

Basic op validation reasons (exact substrings tests check):
- missing node → `` `Node ${id} not found` ``
- `setStyle` on a text node → `cannot be styled`; invalid CSS → the `validateStyle` message
- `setText` on a non-text node → `is not a text node`
- `setAttr`: name must match `/^[a-z][a-z0-9-]*$/` and must not be `style`, `class`, or `data-d-id` → `` `Attribute "${name}" is not allowed` ``; non-element node → `is not an element`
- `setName` on a text node → `cannot be named`
- `setToken`: group and name match `/^[a-z][a-z0-9-]*$/`, else `Invalid token name`

`setStyle` with `value: null` deletes the prop. When a device map becomes empty for `tablet`/`mobile`, delete that map. `setToken` with `null` deletes the name, and deletes the group when it is empty.

- [ ] **Step 1: Write failing tests** with `sampleDoc()`:
  - `setStyle sets base padding`: after `{op:'setStyle',node:'n3',device:'base',prop:'padding',value:'12px'}`, `findNode(result.doc,'n3').node.style.base.padding === '12px'` and the input doc still has `'8px'`.
  - `setStyle mobile creates override`: the mobile map exists with that one prop. Then setting it to `null` removes the `mobile` key entirely.
  - `setStyle invalid`: value `'12'` → `ok:false`, error contains `padding`.
  - `setText`: `n4` → `'Sign in'` works; on `n3` the error contains `is not a text node`.
  - `setAttr rejects style`: error contains `is not allowed`.
  - `setToken adds and deletes`.
  - `inverse restores exactly`: for each op above, `canonicalStringify(applyOp(applyOp(doc, op).doc, inverse).doc.pages)` equals that of `doc.pages`, and the same for components and tokens.
  - `seq never decreases on undo`: insert-free op keeps seq 9; a restore with seq 3 on a doc with seq 9 keeps 9.
  - `unknown node`: error is exactly `Node zzz not found`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement `apply.ts` and `ops/basic.ts`. `index.ts` imports `./ops/basic.js` so the handlers register.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): apply core with generic undo and basic ops`.

---

### Task 6: Structural ops

**Files:**
- Create: `src/ops/structure.ts`, `src/ops/structure.test.ts`

**Interfaces:**
- Consumes: `OpHandler`, `handlers` (Task 5), `findNode`, `isDescendant`, `allIds` (Task 3).

Rules:
- `insertNode`: the parent must be an element. `0 <= index <= children.length`. Every id in the inserted subtree must be unique within the subtree and absent from the doc (error `` `Id ${id} already exists` ``). Element tags match `/^[a-z][a-z0-9-]*$/`. Every style in the subtree passes `validateStyle`. Instances must reference an existing component.
- `removeNode`: cannot remove a page root or component root (error `cannot remove a root`).
- `moveNode`: the target parent must be an element in the **same container**. `isDescendant(node, parent)` → error `cannot move a node into itself or its descendant`. `index` is interpreted after the node is detached, with `0 <= index <= children.length`.
- `wrapNodes`: `nodes` must be ≥1 siblings under the same parent, contiguous, given in document order (error `nodes must be contiguous siblings`). `wrapper` must be an element with `children: []` and a new id. The wrapper takes the first node's index.

- [ ] **Step 1: Write failing tests:**
  - `insert text into header`: insert a text node `n9` at index 1 of `n2`. `n2.children` ids become `['n3','n9']`, and the result's `meta.seq === 10`.
  - `insert rejects duplicate id`: inserting id `n3` → `Id n3 already exists`.
  - `insert into text node rejected`.
  - `remove button`: `n2.children` is empty; undo restores it (canonical equality).
  - `remove root rejected`: `n1` → `cannot remove a root`.
  - `move n5 to index 0 of n1`: the order becomes `['n5','n2']`.
  - `rejects move into descendant`: move `n2` into `n3` → error contains `descendant`.
  - `rejects cross-container move`: move `n7` into `n1` → error.
  - `wrap n2 and n5`: the wrapper `n9` is the only child of `n1` and holds `['n2','n5']`.
  - `wrap non-contiguous rejected`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement and register in `index.ts`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): structural ops`.

---

### Task 7: Component ops

**Files:**
- Create: `src/ops/components.ts`, `src/ops/components.test.ts`

Rules:
- `extractComponent`: the node must be an element inside a **page** (not a component). `component` must match `/^[A-Z][A-Za-z0-9]*$/` and not exist. `instanceId` must be new. Effect: the components entry `{name, props:{}, root: <the subtree>}` is created and the node is replaced in place by `{id: instanceId, kind:'instance', name: node.name, component, props:{}, style:{base:{}}}`.
- `setInstanceProp`: the node must be an instance and `prop` must be declared in the component's `props` (error `` `Component ${c} has no prop "${p}"` ``). `null` deletes the override.
- `detachInstance`: `idMap` must map every id in the component's tree to new unique ids (error `idMap must cover every component node`). Effect: the instance is replaced by a deep copy of the component root with ids remapped, `{{prop}}` placeholders in text nodes and attribute values substituted with the instance prop or the default, and the instance's style maps merged over the root's style (instance wins). The copy's root keeps the instance's `name` if it has one.
- `removeNode` of the last instance does not delete the component.

- [ ] **Step 1: Write failing tests:**
  - `extract header`: `extractComponent {node:'n2', component:'SiteHeader', instanceId:'n9'}` → `components.SiteHeader.root.id === 'n2'` and the page child 0 is an instance `n9` of `SiteHeader`.
  - `extract rejects lowercase name` and `rejects existing name 'Card'`.
  - `setInstanceProp sets title`: `n5.props.title === 'World'`. With `'subtitle'` → `Component Card has no prop "subtitle"`.
  - `detach card`: with `idMap {n6:'n9',n7:'n10',n8:'n11'}` → the page has element `n9` where `n5` was, and text `n11` is `'Hello'`.
  - `detach requires full idMap`.
  - `undo of extract restores page and removes component` (canonical equality of pages and components).
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): component ops`.

---

### Task 8: Page ops

**Files:**
- Create: `src/ops/pages.ts`, `src/ops/pages.test.ts`

Rules:
- `addPage`: id matches `/^[a-z0-9-]+$/` and is new. The route starts with `/` and is unique across pages (error `` `Route ${route} already used` ``). All ids are new and unique. Tags and styles are valid (reuse Task 6's subtree validator; export it from `structure.ts` as `validateSubtree(doc, node): string | null`).
- `duplicatePage`: the source exists. The new id and route follow the `addPage` rules. `idMap` covers every node id in the source page and maps to new unique ids.
- `removePage`: the page exists.

- [ ] **Step 1: Write failing tests:** add `pricing` at `/pricing`; reject a duplicate route `/`; duplicate `home` as `home-b` at `/b` with a full idMap, so the copy's root id is the mapped one and the original is unchanged; reject an incomplete idMap; remove `home`, then undo restores it.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): page ops`.

---

### Task 9: Files and op log

**Files:**
- Create: `src/files.ts`, `src/files.test.ts`

**Interfaces:**
- Produces:

```ts
export function serializeDoc(doc: DesignDoc): Record<string, string>;
// keys: 'meta.json', 'tokens.json', `pages/${id}.json`, `components/${name}.json`; values via canonicalStringify
export function parseDoc(files: Record<string, string>): Result<DesignDoc>;   // rejects missing meta.json, version !== 1, file name / id mismatch, duplicate node ids
export function encodeOpLog(ops: Op[]): string;      // one canonical single-line JSON per op (sorted keys, no spaces), each followed by '\n'; '' for []
export function decodeOpLog(text: string): Result<Op[]>;   // ignores blank lines; error names the 1-based line number
```

Single-line canonical form: implement `canonicalLine(value)` in `canonical.ts`, which is the same as `canonicalStringify` but uses `JSON.stringify` with no indentation and no trailing newline.

- [ ] **Step 1: Write failing tests:** `roundtrip` (`parseDoc(serializeDoc(d))` deep-equals `d`); `byte-stable` (serializing twice gives identical maps); `rejects id mismatch` (`pages/home.json` holding page id `x`) → error mentions `pages/home.json`; `rejects duplicate ids across files`; `oplog roundtrip`; `oplog bad line` (`'{}\nnot json\n'` → error contains `line 2`).
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): canonical files and op log`.

---

### Task 10: Session (batches, undo/redo, changelist, preview policy)

**Files:**
- Create: `src/session.ts`, `src/session.test.ts`

**Interfaces:**
- Produces:

```ts
export type BatchResult = { ok: true; doc: DesignDoc } | { ok: false; index: number; error: string };
export function applyBatch(doc: DesignDoc, ops: Op[]): Result<{ doc: DesignDoc; inverse: Op[] }>; // inverse already in undo order (reverse)
export function classifyBatch(doc: DesignDoc, ops: Op[]): 'immediate' | 'preview';
export class DesignSession {
  constructor(doc: DesignDoc, changes?: Op[][]);   // changes = already-applied batches (from changes.jsonl), not undoable
  get doc(): DesignDoc;
  apply(ops: Op[]): BatchResult;     // atomic; on failure doc unchanged and redo stack untouched
  preview(ops: Op[]): BatchResult;   // same as apply but never commits
  undo(): boolean;                    // false when nothing to undo
  redo(): boolean;
  changelist(): Op[];                 // constructor changes flattened, then applied-and-not-undone batches flattened, in order
}
```

`applyBatch` error format: `` `op ${i}: ${error}` ``. `BatchResult` failure carries `index: i` (0-based) and the raw `error`. A successful `apply` clears the redo stack.

`classifyBatch` returns `immediate` only when `ops.length === 1`, the op is one of `setStyle`, `setText`, `setAttr`, `setName`, `setInstanceProp`, and its node is inside a page (`findNode(...).container.kind === 'page'`). Everything else returns `preview`.

- [ ] **Step 1: Write failing tests:**
  - `atomic batch`: `[valid setStyle, valid setText, setStyle with value '12', valid setName]` → `{ok:false,index:2}`, and `session.doc` is canonically equal to the starting doc.
  - `undo/redo`: apply two batches, undo once (the second is reverted), redo (re-applied). `changelist()` is the 2 batches flattened after redo and only the first after undo.
  - `new apply clears redo`.
  - `undo on empty returns false`.
  - `changelist includes loaded changes first`.
  - `single page edit is immediate`: setStyle on `n3`.
  - `component edits need preview`: setStyle on `n7` (inside `Card`) → `preview`.
  - `multi-op batch needs preview`, `setToken needs preview`, `removeNode needs preview`.
  - `preview does not commit`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): session with atomic batches, undo/redo, preview policy`.

---

### Task 11: HTML/CSS export

**Files:**
- Create: `src/export.ts`, `src/export.test.ts`

**Interfaces:**
- Produces: `exportPage(doc: DesignDoc, pageId: string): Result<{ html: string; css: string }>`

Output rules:
- `html` is the page body markup only (no `<html>` wrapper). Every element gets `data-d-id="<id>"`. Instances expand to their component tree. Inner ids are written as `<instanceId>/<innerId>`, nested instances chain further, and the expanded root also gets the instance's style merged over the component root style (instance wins per prop). Attributes are written in sorted name order after `data-d-id`. Void tags (`area base br col embed hr img input link meta source track wbr`) have no closing tag. Text is escaped (`& < >`) and attributes are escaped (`& < > "`). `{{prop}}` placeholders are substituted inside component expansions; an unknown placeholder stays literal. Children are joined with no whitespace.
- `css`, in this order: a `:root{...}` block with tokens as `--group-name:value;` (sorted by group, then name), omitted when there are no tokens; then for each node in pre-order with a non-empty base map, `[data-d-id="<id>"]{prop:value;...}` with props sorted; then `@media (max-width: 1023px){...}` with tablet rules; then `@media (max-width: 599px){...}` with mobile rules. Media blocks are omitted when empty. No whitespace other than a `\n` between top-level blocks.
- Unknown page → `{ok:false, error:'Page <id> not found'}`. A missing component → error `Component <name> not found`.

- [ ] **Step 1: Write failing tests:**
  - `exports sample page`: `html` === `'<main data-d-id="n1"><header data-d-id="n2"><button data-d-id="n3">Log in</button></header><div data-d-id="n5/n6"><h2 data-d-id="n5/n7">Hello</h2></div></main>'`.
  - `css for sample`: contains `:root{--color-primary:#3366ff;}`, `[data-d-id="n3"]{padding:8px;}`, `[data-d-id="n5/n6"]{padding:16px;}`.
  - `mobile override goes in media block`: after setStyle mobile `n3` padding `4px`, the css ends with `@media (max-width: 599px){[data-d-id="n3"]{padding:4px;}}`.
  - `escapes text and attributes`: text `<b> & "x" 🎉` → html contains `&lt;b&gt; &amp; "x" 🎉`; attr `title` = `a"b` → `title="a&quot;b"`.
  - `void tags`: an `img` with `src` renders `<img data-d-id="…" src="…">`.
  - `deterministic`: two calls return identical strings.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): HTML/CSS export`.

---

### Task 12: Human-readable changelist

**Files:**
- Create: `src/describe.ts`, `src/describe.test.ts`

**Interfaces:**
- Produces: `describeOp(before: DesignDoc, op: Op): string`. `before` is the doc the op was applied to.

Node label: the `name` (or `tag` for unnamed elements, `"text"` for text nodes) of each named ancestor plus the node itself, joined with ` › `, prefixed by the page name or `Component <Name>`. Example: `Home › Header › LoginButton`.

Formats (exact):
- setStyle: `` `${label}: ${prop} ${old ?? 'unset'} → ${value ?? 'unset'}${device === 'base' ? '' : ` (${device})`}` ``
- setText: `` `${label}: text "${old}" → "${text}"` ``
- insertNode: `` `${parentLabel}: insert ${nodeLabel} at ${index}` ``
- removeNode: `` `${label}: remove` ``
- moveNode: `` `${label}: move to ${parentLabel} at ${index}` ``
- extractComponent: `` `${label}: extract as component ${component}` ``
- setToken: `` `Token --${group}-${name}: ${old ?? 'unset'} → ${value ?? 'unset'}` ``
- addPage / removePage / duplicatePage: `` `Add page ${name} (${route})` `` / `` `Remove page ${name}` `` / `` `Duplicate page ${src} as ${name} (${route})` ``
- any other op: `` `${label}: ${op.op}` ``

- [ ] **Step 1: Write failing tests:** setStyle on n3 → `'Home › Header › LoginButton: padding 8px → 12px'`; mobile variant ends with `' (mobile)'`; setText on n4 → `'Home › Header › LoginButton › text: text "Log in" → "Sign in"'`; setToken → `'Token --color-primary: #3366ff → #000'`; a component node n7 → starts with `'Component Card › h2'`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design-model): human-readable op descriptions`.

---

### Task 13: Property tests and public API

**Files:**
- Create: `src/properties.test.ts`
- Modify: `src/index.ts` (final exports), `packages/design-model/README.md` (one paragraph plus a usage example)

- [ ] **Step 1: Write property tests** with fast-check (`numRuns: 200`). Build an arbitrary that picks from valid ops against the current doc: setStyle on a random element or instance id with values from `['4px','8px','1rem','red','#000', null]` on prop `padding` or `color` and a random device; setText on a random text node; insertNode of a text node under a random element with an id from `allocIds`; removeNode of a random non-root node; moveNode of a non-root node to a random valid element in the same container that is not its descendant. Apply sequences of 1 to 15 ops with `DesignSession`, one op per batch.
  - `undo all returns the original`: after undoing every batch, `serializeDoc(session.doc)` equals `serializeDoc(start)` except `meta.json`.
  - `replay is deterministic`: replaying `changelist()` from the start on a fresh session gives a byte-identical `serializeDoc`.
  - `serialize roundtrip`: `parseDoc(serializeDoc(doc))` deep-equals `doc` at every step.
  - `export never throws`: `exportPage(doc,'home').ok === true` at every step.
- [ ] **Step 2:** Run `pnpm test`. Expected: PASS. If a property fails, fix the op handler it reveals (not the test) and note the fix in the commit message.
- [ ] **Step 3:** `index.ts` exports exactly: all types from `types.ts`, `canonicalStringify`, `findNode`, `allIds`, `allocIds`, `validateStyle`, `validateOp`, `applyOp`, `applyBatch`, `classifyBatch`, `DesignSession`, `serializeDoc`, `parseDoc`, `encodeOpLog`, `decodeOpLog`, `exportPage`, `describeOp`, `sampleDoc`.
- [ ] **Step 4:** Run `pnpm typecheck && pnpm test`. Expected: all green.
- [ ] **Step 5:** Commit `test(design-model): property tests; finalize public API`.
