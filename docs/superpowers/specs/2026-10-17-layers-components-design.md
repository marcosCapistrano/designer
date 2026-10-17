# Layers panel, focused inspector, Figma names and in-place component editing

Date: 2026-10-17. Builds on `feat/design-ui` (the floating-panel Design area). Owner-approved design, four parts.

## Goal

Working on a frame should feel like Figma: the left side shows every layer of the page with its Figma name, the
right side shows only the controls that apply to the selection, and components are edited by stepping into them.

Success:
- Selecting anything opens a layer tree of that page; tapping a row selects on the canvas and the other way round.
- The inspector for a plain container shows only the properties it has; Typography never appears on a box without text.
- adhunters-v7 layers carry the Figma file's layer names.
- Double-tapping a component instance enters it; edits there change every instance at once, with undo; Done leaves.

## 1. Layers panel (left)

**Visibility.** Opens when there is a selection, closes when it clears. A Layers toggle in the top bar keeps it open
without a selection. At widths ≥ 1200px it docks as a 280px left column and the canvas insets grow by 280 on the
left (fit leaves room). Below that it is a left sheet over the canvas that closes on a canvas tap. (Ruling: 1200, not
the inspector's 900, because a 280 + 360 split at 900 leaves the canvas 260px.)

**Content.** The layer tree of the selected frame's page:
- Row: icon (frame, text, component), display name, indent by depth. Element rows whose children are only text get
  the text icon and a one-line text preview after the name. Text nodes are not rows of their own.
- Instances show the component icon and expand to their definition's layers (ids nested by path, below).
- Ancestors of the selection are expanded; selected rows are highlighted and scrolled into view.
- A row with no box in the selected frame's hit map (hidden at that size) is greyed out but selectable.

**Selection both ways.** Tapping a row selects that layer in the current frame (the selected frame if it shows this
page, else the page's first frame), and pans it into view when off-screen. Canvas selections highlight their rows.

**Ids.** Layer ids are hit-map ids: page nodes by their id; nodes inside an instance `a` as `a/x`; inside a nested
instance `b` of `a`'s definition as `a/b/y`. An instance's own id is its path (`a`, `a/b`); it has no hit box of its
own, so its box is the union of boxes under its prefix.

**Data.** `GET /api/apps/:app/design/layers?page=<pageId>` returns
`{ revision, root: LayerNode, components: Record<string, { title: string; uses: number }> }` where
`LayerNode = { id, name, kind: 'element' | 'text' | 'instance', component?, text?, children: LayerNode[] }`.
`uses` counts instances across all pages and definitions. The client reloads the outline when the revision changes.

## 2. Inspector (right): only what you can edit

**Header.** Display name (tap to rename), kind (Frame / Text / component title), and inside a component a path
`Filter Panel › Verticais`. The Desktop / Tablet / Mobile switch stays.

**Sections by selection:**

| Selected | Sections |
|---|---|
| Text-bearing (text node, or element with own text) | Text, Typography, Fill, Spacing, Size, Border, Visibility |
| Element without own text | Fill, Spacing, Size, Border, Visibility |
| Instance (outside component mode) | Component card (title, props as fields, Edit component), Fill, Spacing, Size, Border, Visibility |
| Several targets | Sections every target gets |

Raw CSS ("All CSS") is always last and collapsed.

**Fields.** A section shows only fields with a value (own, or inherited from a wider tier, shown muted as today).
Its `+` menu lists the remaining fields; picking one shows it (empty, focused) until the selection changes. A section
with no shown fields collapses to its title row and `+`. Padding/margin show as one row when all sides are equal,
four when not (the existing all-sides toggle).

**Targets by mode.** Outside component mode the inspector uses only non-shared targets; in component mode only shared
ones. (The server keeps returning both for a component root.)

## 3. Figma names

**Import.** An element's `name` is, first match wins:
1. `data-name` on the JSX element or component call (`<FilterPanel data-name="Filtros" />`). It sets `name` and is
   not kept as an attribute nor passed as a component prop.
2. A component's display title for a definition root (the export name, `FilterPanel`) and the inlined-component
   root name the importer already sets.
3. The element's CSS Module class local name, humanized (`styles.favoriteName` → "Favorite Name").
4. Nothing: display falls back to the tag.

**Display name** (shared by outline and inspector, in design-model): element → `name ?? tag`; instance →
`name ?? definition root name ?? component id`; text-bearing elements keep their name (text shows as preview).
`DesignTarget` gains `name` (display) and, for instances, `title` (component title).

**Rename** uses the existing `setName` op (immediate, undoable). Pending ops replay on every import, and the Build
run turns them into source; `describeOp` reads "Set data-name of <layer> to "<name>"" so Build writes the attribute.

**adhunters-v7.** Read the layer names of Figma file `2VzP3S0vJodEz8fCPDPbsT` (Ads List, Ads Grid, Ads Table) with the
Figma tools, add `data-name` to the matching source elements in `~/hub-local/apps/adhunters-v7` as a local commit
(push is disabled there), re-import. Code-only wrappers keep their class names.

## 4. Component mode

**Enter:** double-tap an instance on the canvas (two taps within 350ms and 24px), Edit component on the inspector's
component card, or the component icon on a layers row.

**Scope.** The mode is a stack of instance paths (`['a']`, then `['a', 'a/b']`). With scope prefix `P` of depth `d`
(segments; `d = 0` outside), a hit id `h` maps to:
- in the mode (`d > 0`), if `h` does not start with `P + '/'` the tap is outside: it clears the selection and steps out
  one level (Escape and Done also step out one level);
- otherwise the selection is the first `d + 1` segments of `h`.
So outside the mode a tap inside a component selects the whole instance (`a`); inside `a` it selects `a/x` or the
nested instance `a/b` as a unit. Box selection maps and dedupes the same way.

**While in it:** frames of that page are dimmed except the scope instance's box; the top bar shows
"Editing **Filter Panel** · used 3×" with Done (a path `Filter Panel › Chip` when nested); the layers panel shows the
component's subtree only.

**Edits apply immediately.** Inspector edits sent in component mode carry `scope: { component: <component id> }`. The
server checks the selection's targets and every op target lie inside that definition, then commits instead of
previewing (the spec's "a component definition waits for Apply" rule now holds only outside component mode). Chat
edits keep previewing.

**Prop slots.** Text containing `{{prop}}` inside a definition shows its template with the hint "Filled per instance
from props".

**Out of scope:** making a component from a selection, detaching, adding/removing component props.

## Units

- design-model: `displayName(node, doc)`, `componentTitle(doc, id)`, `layerOutline(doc, pageId)`, `componentUses(doc)`.
- sync/extract + css: `data-name` and class-name naming.
- server: layers route; `name`/`title` on targets; component scope in `edit`.
- client: `layers/` (outline fetch + model + `LayersPanelView`), `scope.ts` (pure id mapping + stack), controller
  `setScope`, `selectNodes`, double-tap, dim mask, union highlight; inspector section/field filtering, header,
  component card; top bar mode chip; DesignArea wiring; layout insets for the left panel.

## Testing

Unit: outline/display names/uses; extract `data-name` (element, component call, inlined) and class fallback;
server layers route, component-scope commit and rejection; scope mapping; controller scope/double-tap/selectNodes;
section and field filtering; layers model (expansion, greyed rows); DesignArea wiring (panel open/close, mode).
e2e: row tap selects on canvas; double-tap enters a component, an edit applies with no banner and undoes; tap outside
leaves; narrow-width layers sheet.
