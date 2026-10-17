# Layers, focused inspector, Figma names and component mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Figma-like Design area: a layers panel on the left, an inspector that shows only applicable controls, Figma layer names from `data-name`, and in-place component editing.

**Architecture:** Names and the layer outline are computed in `@hub/design-model` and served by a new route; the importer fills `name`. The client gets a pure scope module (hit id → selection under a component-mode stack), controller hooks (scope, programmatic selection, double-tap, dimming), a layers panel (DOM-free model + view), and inspector filtering; DesignArea wires them.

**Tech Stack:** TypeScript, Preact (vitest node env, `.ts` tests walking vnodes via `ui/test-vnode.ts`), Hono + zod, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-17-layers-components-design.md`

## Global Constraints

- Layer ids are hit-map ids: page node `id`, inside instance `a` → `a/x`, nested → `a/b/y`; an instance's own id is its path.
- Layers dock at width ≥ 1200 as a 280px column (left canvas inset +280); below, a left sheet that closes on canvas tap.
- Double-tap: two taps within 350ms and 24px.
- Outside component mode the inspector uses non-shared targets only; inside, shared targets only.
- Component-scope edits commit immediately only when every selection target and op target lies in that component's definition; chat edits keep previewing.
- Copy: "Editing **<title>** · used N×", "Done", "Edit component", "Filled per instance from props", Raw section title "All CSS".
- Never push or merge; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A selection whose instance was removed by an edit while in component mode → mode exits, no crash (Task 7 test `leaves component mode when its instance disappears from the outline`).
- Tapping a row for a layer hidden in the current frame → selection is set, inspector loads, canvas shows no highlight, no pan (Task 4 test `selectNodes with no boxes selects without panning`).
- `data-name` with an empty string → ignored, falls back (Task 2 test `empty data-name falls back`).
- Rename to an empty name → `setName` with `null` (clears) rather than empty string (Task 6 test `renaming to blank clears the name`).
- Component-scope edit whose op targets a node outside the definition → 400, nothing committed (Task 3 test `component scope rejects ops outside the definition`).

---

### Task 1: Display names and layer outline (design-model + protocol)

**Files:**
- Create: `packages/design-model/src/names.ts`, `packages/design-model/src/names.test.ts`
- Modify: `packages/design-model/src/index.ts` (export), `packages/design-model/src/describe.ts` (setName copy), `packages/protocol/src/design.ts`

**Interfaces — Produces:**
- protocol: `interface LayerNode { id: string; name: string; kind: 'element' | 'text' | 'instance'; component?: string; text?: string; children: LayerNode[] }`, `interface DesignLayers { revision: string; root: LayerNode; components: Record<string, { title: string; uses: number }> }`; `DesignTarget` gains `name?: string; title?: string`.
- `displayName(doc: DesignDoc, node: DesignNode): string` — element `name ?? tag`; instance `name ?? componentTitle`; text node → its text trimmed to 40 chars.
- `componentTitle(doc: DesignDoc, id: string): string` — `def.root.name ?? id`.
- `componentUses(doc: DesignDoc): Record<string, number>` — instances across pages and definitions.
- `layerOutline(doc: DesignDoc, pageId: string): LayerNode | null` — text nodes are not rows; an element whose children are all text is `kind: 'text'` with `text` (joined, trimmed to 80); instance children are its definition root's outline with ids prefixed `<instancePath>/`.

- [ ] Step 1: tests in `names.test.ts`: `displayName` of named/unnamed element, instance with/without name, component title fallback to id; `componentUses` counts an instance nested in another definition; `layerOutline` on a page with `div > [h1 "Hi", instance a of C(root section > span "x")]` gives `div` → `h1` (kind text, text "Hi"), `a` (kind instance, component C, children `[a/<rootId> section → a/<spanId> span kind text]`); unknown page → null; `describeOp` of `setName` reads `Set data-name of h1 to "Title"`.
- [ ] Step 2: run `pnpm -F @hub/design-model test names` → FAIL.
- [ ] Step 3: implement; export from index.
- [ ] Step 4: run → PASS; `pnpm -F @hub/design-model typecheck`.
- [ ] Step 5: commit `feat(design-model): display names and layer outline`.

### Task 2: Names at import (sync)

**Files:** Modify `packages/sync/src/extract.ts`, `packages/sync/src/css.ts`; Test `packages/sync/src/extract.test.ts`.

**Interfaces — Consumes:** `ElementNode.name`, `InstanceNode.name`.

- Intrinsic element: `data-name` (non-empty string literal) sets `node.name` and is not added to `attrs`.
- Component call: strip `data-name` from props before any other handling; for a shared component set `instance.name`; for an inlined one set the expanded root's `name` (wins over the existing `nameOf(key)`).
- Shared definition root: `root.name ??= exportName`.
- `applyStyles`: before deleting `class`, if `node.name === undefined` and a class is `<scope>__<local>`, set `name = humanize(local)` (`favoriteName` → "Favorite Name", `bar-fill` → "Bar Fill") using the last such class.

- [ ] Step 1: tests: `data-name on an element becomes its name`, `data-name on a shared component call names the instance and is not a prop`, `data-name on an inlined component names its root`, `empty data-name falls back`, `a CSS module class names an unnamed element`, `a shared definition root is named after its export`.
- [ ] Step 2: `pnpm -F @hub/sync test extract` → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: PASS; full `pnpm -F @hub/sync test` (fixture snapshots/hashes may shift — update only expected names).
- [ ] Step 5: commit `feat(sync): layer names from data-name and CSS module classes`.

### Task 3: Server — layers route, target names, component scope

**Files:** Modify `apps/server/src/design/editing.ts`, `apps/server/src/design/routes.ts`; Tests `apps/server/src/design/editing.test.ts`; client `apps/client/src/net/api.ts`.

**Interfaces — Produces:**
- `DesignEditing.layers(app: string, pageId: string): Promise<DesignLayers>` (404 unknown page, 409 not imported).
- `GET /:app/design/layers?page=<id>`.
- Targets carry `name: displayName(...)`; instance targets carry `title: componentTitle(...)`.
- `type EditScope = { component: string }`; `edit(app, revision, raw, selection?, forcePreview = false, scope?: EditScope)`; edit schema gains `scope: z.object({ component: z.string().min(1).max(100) }).strict().optional()`.
- With `scope` and a selection: every selection target must be `shared` and its node inside `doc.components[scope.component].root` (by id), and every op target likewise, else 400 `"The edit reaches outside the component being edited."`; then it commits immediately.
- Client: `api.designLayers(app, pageId): Promise<DesignLayers>`; `api.editDesign(app, revision, ops, selection?, scope?: EditScope)`.

- [ ] Step 1: tests: `layers returns the page outline and component uses`, `selection targets carry display names and titles`, `component scope commits a shared edit immediately`, `component scope rejects ops outside the definition`, `without scope a shared edit still previews`.
- [ ] Step 2: `pnpm -F @hub/server test editing` → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: PASS; server + client typecheck.
- [ ] Step 5: commit `feat(server): layers outline, target names and component-scope edits`.

### Task 4: Client scope and canvas hooks

**Files:** Create `apps/client/src/areas/design/scope.ts` (+test); Modify `apps/client/src/canvas/controller.ts`, `runtime.ts`, `CanvasView.tsx`, `painter.ts` (dim mask), tests.

**Interfaces — Produces:**
- `scope.ts`: `scopedId(hit: string, scope: string): string | null` (null = outside; `scope = ''` outside mode); `prefixOf(stack: readonly string[]): string` (last or `''`); `pathLabel` not here.
- Controller deps: `onDoubleTap?(sel: NodeSelection): void`, `onOutside?(): void`. Methods: `setScope(prefix: string): void` (re-maps nothing; affects later taps/box selects; repaints dim), `selectNodes(pageId: string, nodeIds: string[], frameId?: string): void` (picks `frameId` if it shows the page, else the selected frame if same page, else the page's first frame; pans the union box into view if off-screen; no pan when it has no boxes), `boxesFor(frameId: string): readonly HitBox[] | null`.
- Highlight and dim use the union box of `id` and boxes under `id + '/'`.
- In scope, frames of other pages and everything outside the scope's union box in the scope page's frames are dimmed with `rgba(0,0,0,0.55)`.
- CanvasView props `scope?: string`, `onDoubleTap`, `onOutside`; handle gains `selectNodes`, `boxesFor`, and a `framesChanged` subscription is not needed (DesignArea reads `boxesFor` on selection).

- [ ] Step 1: tests: scope `scopedId('a/x/y','')==='a'`, `('s1','')==='s1'`, `('a/x','a')==='a/x'`, `('a/b/y','a')==='a/b'`, `('c/x','a')===null`, `('a','a')===null`; controller `tap maps hits through the scope`, `tap outside the scope calls onOutside and clears`, `two taps within 350ms and 24px report a double tap`, `box select dedupes scoped ids`, `selectNodes highlights the union of an instance's boxes`, `selectNodes with no boxes selects without panning`, `selectNodes pans an off-screen layer into view`.
- [ ] Step 2: run `npx vitest run src/areas/design/scope src/canvas` → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: PASS.
- [ ] Step 5: commit `feat(client): component scope, programmatic selection and double tap on the canvas`.

### Task 5: Layers panel

**Files:** Create `apps/client/src/areas/design/layers/model.ts`, `LayersPanel.tsx`, `layers.css`, tests `model.test.ts`, `LayersPanel.test.ts`; icons in `ui/icons.tsx` (`FrameIcon`, `TextIcon`, `ComponentIcon`, `LayersIcon`).

**Interfaces — Produces:**
- `interface LayerRow { node: LayerNode; depth: number; expandable: boolean; open: boolean; selected: boolean; present: boolean }`
- `layerRows(root: LayerNode, opts: { open: ReadonlySet<string>; selected: readonly string[]; present(id: string): boolean }): LayerRow[]` — depth-first, children only when open.
- `autoOpen(root: LayerNode, selected: readonly string[]): Set<string>` — ancestors of selected ids.
- `subtree(root: LayerNode, id: string): LayerNode | null`.
- `presentIn(boxes: readonly HitBox[] | null): (id: string) => boolean` — `true` when boxes is null (unknown); else any box id equals id or starts with `id + '/'`.
- `LayersPanelView({ rows, title, onSelect(id), onToggle(id), onEnter(id), onClose })`: testids `layers`, `layer-<id>`, `layer-toggle-<id>`, `layer-enter-<id>`, `layers-close`; selected rows `aria-selected="true"`; non-present rows class `layers-row-absent`; instance rows carry the enter button.

- [ ] Step 1: tests: rows for open/closed, `autoOpen` opens ancestors through instances, absent rows, `subtree`, view renders testids and calls handlers.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(client): layers panel`.

### Task 6: Focused inspector

**Files:** Modify `inspector/sections.tsx`, `inspector/Inspector.tsx`, `inspector/model.ts`, `inspector/inspector.css`; Create `inspector/fields.ts` (+test); tests.

**Interfaces — Produces:**
- `fields.ts`: `FIELDS: Record<string, readonly { prop: string; label: string; kind: 'length' | 'color' | 'weight' }[]>` for typography (font-size, font-weight, line-height, color), fill (background-color), spacing (padding, margin, gap — `padding`/`margin` stand for their sides), size (width, height, max-width), border (border-width, border-color, border-radius). `hasValue(target, device, prop): boolean` (sides: any side or shorthand); `shownFields(section, target, device, added: ReadonlySet<string>): string[]`; `textBearing(target): boolean` (`!!target.textNode`).
- `SECTIONS` show rules per spec table; Typography only when `textBearing`; Props replaced by a component card section `component` (instance targets) with title, props fields, and `Edit component` button (testid `inspector-edit-component`); `raw` titled "All CSS".
- Section head gets a `+` IconButton (testid `section-<id>-add`) opening a Menu of unshown fields (testids `add-<section>-<prop>`); adding stores `section:prop` in an `added` set in the Inspector (cleared on selection change). Empty section renders only head.
- `SectionProps` gains `added: ReadonlySet<string>`; `field()` returns null when not shown.
- Header: name button (testid `inspector-name`) → inline input committing `setName` (`null` when blank) on target id; kind line; path `pathLabel` prop (string | null) shown when set (testid `inspector-path`).
- `InspectorProps` gains `mode: 'page' | 'component'`, `scope?: EditScope`, `path?: string | null`, `onEnterComponent?(instanceId: string): void`; model filters `info.targets` by `shared === (mode === 'component')` (falls back to all when that leaves none); `model.edit` passes `scope`.
- Text template hint: when `text` contains `{{`, show "Filled per instance from props" under the Text field (testid `text-template-hint`).
- Remove the "Shared component. Edits preview before they apply." note in component mode; keep it in page mode for shared fallback.

- [ ] Step 1: tests: `a box without text has no Typography`, `only fields with values show`, `inherited values count as values`, `+ lists unshown fields and adding shows one`, `an empty section shows only its head`, `instance targets show the component card with props and Edit component`, `page mode drops shared targets`, `component mode keeps only shared targets`, `renaming commits setName`, `renaming to blank clears the name`, `edits in component mode carry the scope`, `template text shows the per-instance hint`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS (inspector + ui suites).
- [ ] Step 5: commit `feat(client): inspector shows only what applies`.

### Task 7: Design area wiring

**Files:** Modify `areas/design/DesignArea.tsx`, `TopBar.tsx`, `layout.ts`, `design.css`; Create `areas/design/component-mode.ts` (+test); tests `DesignArea.test.ts`, `layout.test.ts`.

**Interfaces — Consumes:** Tasks 3–6. **Produces:**
- `layout.ts`: `LAYERS_BREAKPOINT = 1200`, `LAYERS_WIDTH = 280`, `layersLayout(width): 'docked' | 'sheet'`, `canvasInsets(width, layersOpen): Insets` (left 280 when docked and open).
- `component-mode.ts`: `type ModeStack = readonly string[]`; `enter(stack, instanceId)` (instanceId must start with `prefixOf(stack) + '/'` or stack empty), `leave(stack)` (pop), `modeLabel(stack, layers: DesignLayers): { title: string; uses: number; path: string } | null`, `alive(stack, root: LayerNode): ModeStack` (truncates at the first id missing from the outline).
- DesignArea: holds `layersOpen` (pinned toggle) and derived visibility (selection or pinned); fetches `designLayers` for the selection's page when the panel is visible or the mode is active, refetch on revision; passes `scope` to CanvasView; `onDoubleTap` → if the hit selection is an instance id (outline kind instance) enter it; `onOutside`/Escape/Done → leave; inspector `mode`, `scope`, `path`, `onEnterComponent`; layers `onSelect` → `canvas.selectNodes`, `onEnter` → enter.
- TopBar: Layers toggle IconButton (testid `topbar-layers`, `aria-pressed`); mode chip (testid `mode-chip`, Done testid `mode-done`).
- Narrow: layers sheet closes on canvas tap.

- [ ] Step 1: tests: `layersLayout`/`canvasInsets`; mode `enter`/`leave`/`alive`/`modeLabel`; DesignAreaView `selection shows the layers panel`, `docked layers sit left of the canvas at 1280`, `mode chip shows title and uses`, `leaves component mode when its instance disappears from the outline`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS; full `pnpm -F @hub/client test`, typecheck.
- [ ] Step 5: commit `feat(client): layers panel and component mode in the Design area`.

### Task 8: e2e

**Files:** Modify `apps/client/e2e/design.spec.ts`.

- [ ] Step 1: tests: `tapping a layer row selects it on the canvas` (row aria-selected + inspector shows its name); `double tap enters a component, an edit applies without a preview and undoes` (no `preview-banner`, pending +1, undo → initial); `tapping outside a component leaves component mode` (`mode-chip` gone); `on a narrow screen layers open as a sheet` (834×1194, `topbar-layers` opens `layers`, canvas tap closes it). Adjust the existing shared-preview test: entering a shared node now needs page-mode instance selection then props, or keeps the preview through the instance root shared fallback — update it to select the instance and use Edit component → immediate.
- [ ] Step 2: `npx playwright test e2e/design.spec.ts e2e/shell.spec.ts` → all pass.
- [ ] Step 3: commit `test(e2e): layers and component mode`.

### Task 9: adhunters-v7 Figma names

Not hub code. Read layer names of Figma file `2VzP3S0vJodEz8fCPDPbsT` (Ads List / Grid / Table frames) with the Figma tools; add `data-name` to the matching elements and component calls in `~/hub-local/apps/adhunters-v7`; `pnpm typecheck` there; local commit; rebuild the hub client, restart the hub from this worktree, re-import, screenshot the Design area with a selection to `~/hub-local/ui-shots/`.
