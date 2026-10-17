# Design area UI redesign — design

**Status:** approved in conversation 2026-10-17; this document records it for review.
**Branch:** `feat/design-ui`, from `main` 027c16f.

## Intent

The Design tab's chrome (not the designs it shows) is in the way: the import form, sample-preview form and status paragraphs stack above the canvas; the editor is a 290 px column of raw text fields (`CSS property`, `Value`, `Edit target`); the chat is a textarea at the bottom of that column; nothing has a visual system. The owner uses it on a Galaxy Tab S6 Lite and asked for a redo.

What the owner chose:

- **All four problems are in scope:** the canvas is squeezed, editing is raw, it looks unstyled, chat is an afterthought.
- **Layout:** full-screen canvas with floating panels: a compact top bar, an inspector that slides in from the right, chat as a bottom sheet with the mic always visible.
- **Inspector:** curated controls with pickers and steppers showing current values, plus a collapsed "Any CSS property" row as the raw path.

Assumptions (controller's, for the owner to correct):

- Dark, tool-like look: the canvas content should be the bright thing.
- No new dependencies: Preact and plain CSS with a token file, as the rest of the client.
- Voice is not built here (spec step 8); the mic button is present and disabled.
- The inspector shows author styles (what the design sets), not computed styles.

Success: on the tablet, the owner opens adhunters-v7, sees only the canvas with the top bar and chat bar; taps a card title, the inspector slides in showing the `h3`'s text and typography with current values; changes the font size with a stepper and the color with a swatch, each one undo step; opens the chat sheet, asks for a change with the selection chip attached, and reviews the proposal on the main canvas before applying.

## Non-goals

- Voice input, computed styles, a full properties panel, new design-model ops or server endpoints.
- Build, Deploy, app list and login screens: they only receive the token palette so the app stays coherent.
- Changing the canvas engine (tiles, gestures, frames, frame menu). Only its toolbar and colors change.

## Visual system

`apps/client/src/shell/tokens.css` defines custom properties on `:root`:

- Surfaces: `--bg` #121316, `--surface` #1c1e23, `--surface-2` #262930, `--border` #33363e, `--overlay` rgba(18,19,22,0.82).
- Text: `--text` #e8eaed, `--text-2` #9aa0a6, `--text-3` #6b7076.
- Accent `--accent` #4c8dff (selection, primary buttons, focus), `--accent-text` #0b1220; `--danger` #ff6b6b; `--warning` #f2c94c; `--ok` #4cd98a.
- Type: `--font` system-ui stack; sizes `--text-s` 13px, `--text-m` 14px, `--text-l` 16px, `--text-xl` 20px; `--mono` for values.
- Spacing `--s1` 4px … `--s6` 32px (×2 steps); `--radius` 10px, `--radius-s` 6px; `--touch` 44px; shadow `--shadow` for floating panels.
- Hover styles live under `@media (hover: hover)`. Focus uses `:focus-visible` with a 2 px accent ring.

The canvas background becomes `--bg`; frame labels, handles, fold lines and the selection highlight use `--text-2`, `--border` and `--accent` (passed to the painter as constants, since it draws on a 2D context).

## Screen structure (Design tab)

`DesignArea` becomes a full-bleed canvas with floating layers, all `position: absolute` inside the area:

- **Top bar** (56 px, `--overlay` with blur): back link, app name, Design / Build / Deploy segmented control, then Undo, Redo, a zoom button (shows the current zoom as a percentage; tap = fit all frames), and an overflow menu (⋯) with Import pages, Retry preview, Sample preview. The app shell's header and tab row are hidden on the Design tab (they remain on Build and Deploy).
- **Tool pill** (bottom-center, above the chat bar): Pan / Select, and the mic button, disabled with a tooltip "Voice coming later".
- **Inspector** (right, 360 px, full height below the top bar; a bottom sheet at widths < 900 px): opens when a selection exists, closes with its handle or when the selection clears.
- **Chat sheet** (bottom): a 64 px collapsed bar always visible; expands to at most 60 % of the height. With the inspector open at ≥ 900 px it docks under the inspector (same 360 px column, inspector above, chat below).
- **Toasts**: bottom-center above the chat bar; 4 s for success, sticky for errors with a dismiss button; failures with details ("N routes not imported") carry a "Details" action that opens a modal with the list.
- **Empty state**: nothing imported → one centered card "Import pages to start designing" with an Import button that opens the import sheet.
- **Import sheet**: a modal with the source mode select, app directory (Next) or entry file + route (React), Import pages and Retry preview buttons, and the sample-preview form (text + Generate, proposal review with Accept/Cancel) below a divider. Requests are unchanged.

## Inspector

**Header.** A chip row with one chip per `DesignTarget` the selection returns, labeled `tag` or `component`, with a "Shared" badge when `shared`; the active chip is accented. A note under the chips when the active target is shared: "Edits preview before they apply." A close handle on the panel edge.

**Device row.** Segmented control Desktop / Tablet / Mobile, preset to `selection.device`. It sets the `device` of every `setStyle` from this panel (the spec's device rule with its explicit override). Fields show the active tier's value; a tier without its own value shows the inherited value (`tablet` ← `base`, `mobile` ← `tablet` ← `base`) in `--text-3` with placeholder "inherits Desktop" / "inherits Tablet".

**Sections** (collapsible; open/closed state kept in `localStorage` under `hub.inspector.sections`):

| Section | Controls | CSS property |
|---|---|---|
| Text | textarea (when `textNode`) | `setText` |
| Typography | font size stepper, weight select (400/500/600/700), line height stepper, color swatch+field | `font-size`, `font-weight`, `line-height`, `color` |
| Fill | background swatch+field | `background-color` |
| Spacing | padding ×4 + link toggle, margin ×4 + link toggle, gap stepper | `padding-*`, `margin-*`, `gap` |
| Size | width, height, max-width steppers | `width`, `height`, `max-width` |
| Border | width stepper, color swatch+field, radius stepper | `border-width`, `border-color`, `border-radius` |
| Visibility | toggle | `display: none` ↔ removes the override |
| Props (instances) | one text field per `declaredProps` entry | `setInstanceProp` |
| Any CSS property | property + value fields, collapsed by default | `setStyle` with the typed property |

**Value behaviour** (pure helpers in `inspector/values.ts`):

- `parseLength(value)` → `{ number, unit }` for `^-?\d*\.?\d+(px|rem|em|%|vh|vw)$`, else null. Steppers show the number and keep the unit; step 1 for px/%/vh/vw, 0.125 for rem/em; non-parsable values (`auto`, `calc(...)`, `var(...)`) render as plain text fields.
- `isLiteralColor(value)` → true for `#hex`, `rgb[a](...)`, `hsl[a](...)` and named colors; the swatch previews only those. `var(--x)` shows its name with a neutral swatch.
- `effectiveStyle(style, device)` → the value shown and whether it is inherited.
- Clearing a field sends `value: null` (removes that tier's override).
- Padding/margin with the link toggle on write all four sides in one batch (four `setStyle` ops, one undo step).

**Applying.** Each control applies on change-commit (stepper release, blur, Enter, select change, toggle) as one `editDesign` call. The control shows a 16 px spinner while in flight; a failure reverts it and shows an inline error line under the section. Other controls stay enabled. A result with `mode: 'preview'` enters the preview state below.

## Chat sheet

- **Collapsed bar:** a single-line input whose placeholder reflects the selection ("Edit the selected h3…" / "Describe a design change…"), a send button, the disabled mic. While `running`, the bar shows a progress indicator and a Stop button in place of send.
- **Selection chip** above the input when a selection exists: "h3 · Desktop" with ×; × sends the request with no selection (the chip hides until the next selection).
- **Expanded sheet** (drag handle or history button): messages as bubbles — `user` right-aligned on `--surface-2`, `assistant` left on `--surface`, `error` with `--danger` text. An assistant message whose turn produced an edit gets a tag: "Applied" or "Preview ready" (tapping the latter focuses the preview banner). The sheet keeps the last 200 messages as today.
- Everything else in `ChatPanel` (merge/de-dupe, websocket `design.message` / `design.status`, reconnect reload, 20,000-char limit, Stop) is kept; only the rendering moves.

## Previews, undo, status

- **Preview state** (a `DesignProposal` from the inspector, chat, or sample preview): the main `CanvasView` receives a `TileSource` built from the proposal manifest (as `EditorPanel` does today for its mini canvas) with `framesEditable={false}`; a banner at the top of the canvas (below the top bar, `--warning` border) lists `proposal.descriptions` and warnings with **Apply changes** and **Cancel preview**. Inspector and chat are locked (`disabled`) until one is chosen. Cancel calls `cancelDesign` and restores the live source. The separate preview canvas in the sidebar is removed.
- **Undo/Redo** in the top bar call `designHistory`; enabled when `revision` is set and nothing is busy. A success toast says "Undone" / "Redone" plus the first warning if any.
- **Status**: import results map to toasts: `ok` → "Imported N pages" (+ `importNote` counts), `failed.length > 0` → sticky warning with Details (modal listing routes and diagnostics), `ok: false` → sticky error with Details (diagnostics or conflicts). "Wait for Build to finish" becomes a sticky info toast while `building`.

## Components and files

```
apps/client/src/shell/tokens.css              palette, type, spacing (new)
apps/client/src/shell/shell.css               use tokens; hide header/tabs on the Design tab
apps/client/src/ui/                            small shared controls (new): Button, IconButton, Segmented, Stepper, ColorField, Toggle, Sheet, Modal, Toast(+useToasts), Menu
apps/client/src/areas/design/DesignArea.tsx   composition: canvas + layers; owns selection, revision, proposal, busy flags, toasts
apps/client/src/areas/design/TopBar.tsx
apps/client/src/areas/design/ImportSheet.tsx  import form + SourceSamples (moved in)
apps/client/src/areas/design/inspector/Inspector.tsx, sections/*.tsx, values.ts (+ tests)
apps/client/src/areas/design/ChatSheet.tsx    replaces ChatPanel's rendering; logic kept in chat-state.ts (extracted, tested)
apps/client/src/areas/design/PreviewBanner.tsx
apps/client/src/areas/design/design.css       layout of the layers
apps/client/src/canvas/CanvasView.tsx         toolbar restyle (tool pill + mic), colors from tokens; exposes `fitAll()` and an `onZoom(scale)` callback for the top bar
apps/client/src/canvas/controller.ts          gains public `fitAll()` (fit layoutBounds of every frame) and reports camera scale changes through a `onCamera` dep
apps/client/src/canvas/painter.ts, overlay.ts colors as named constants matching tokens
```

`EditorPanel.tsx` and `ChatPanel.tsx` are removed. The API client and server are unchanged.

## Errors

- Selection read fails → inspector shows the message with a Retry button.
- An edit fails → the control reverts, inline error under its section; a 409 (stale revision) also refreshes the selection.
- Chat send fails → error bubble with Retry (re-sends the same text).
- Preview apply/cancel fails → sticky error toast; the banner stays.

## Testing

- `values.ts` helpers: parseLength units and steps, isLiteralColor, effectiveStyle inheritance per tier.
- Inspector sections (vnode tests, existing style): current values shown per tier, inherited placeholder, stepper commit sends one setStyle with the device from the segmented control, linked padding sends four ops in one batch, clearing sends null, raw row sends the typed property.
- Chat state: merge/de-dupe and status handling move to `chat-state.ts` with tests (behaviour pinned from the current ChatPanel).
- DesignArea: preview state swaps the canvas source and locks panels; apply/cancel restore; toasts for each import outcome.
- Playwright e2e: updated for the new layout (top bar, inspector open on tap, chat bar), run before merge.
- Manual on the tablet: the success scenario above, in portrait and landscape.

## Rollout

Branch `feat/design-ui` in `~/Projects/designer-wt/design-ui`. The local hub switches to it for the play-test. No push or merge without the owner's go-ahead.
