# Canvas frames of any size — design

**Status:** approved in conversation 2026-10-17; this document records it for review.
**Branch:** `feat/canvas-frames`, stacked on `feat/real-app-import`.

## Intent

The canvas is infinite, but every page shows exactly three frames at fixed widths (Desktop 1440, Tablet 834, Mobile 390) in a fixed row. The owner wants to view and edit a page at any size: a 1600 frame to compare with the Figma file, 1280, 768, a narrow 700, and to arrange frames freely.

What the owner chose:

- **Any-width frames.** Frames at any width and viewport height, resized by dragging on the canvas, placed anywhere. Styles stay in three tiers; a frame edits the tier its width falls into. No design-model, importer or export change.
- **Hub view state.** Frame sizes and positions are saved by the hub per app (the same on the tablet and the desktop browser), not in the design files or the app repo, and not in undo history.

Assumptions (not stated by the owner, chosen by the controller):

- Frame height is the page's full content height, as today; the user-set height is the viewport height (what `100vh` resolves to, and the minimum frame height).
- While a resize is in progress the frame shows the old render pinned to its left edge (not stretched) and the new render is requested on release.

Success: on adhunters-v7, the owner adds a 1600 × 900 frame next to `/ads`, sees the page reflow at 1600 (not a scaled 1440 image), taps a card title in that frame and edits it with Desktop styles, resizes it to 700 and sees it switch to Tablet styles and reflow; the layout is still there after a reload on another device.

## Non-goals

- Custom breakpoints. `NodeStyle` stays `{ base, tablet, mobile }`; device media stay exactly `(max-width: 1023px)` and `(max-width: 599px)`.
- Live (in-browser iframe) rendering during a drag.
- Frames in the design files, versioned layouts, undo of frame moves.
- Rotation, zooming a single frame, or clipping a frame to a fixed height.

## Concepts

**Frame.** `CanvasFrame = { id: string; pageId: string; x: number; y: number; width: number; viewportHeight: number }`, in world px (zoom 1 = page CSS px).

- `id`: random, `f` + 16 hex chars.
- `width`: integer 240–3840. `viewportHeight`: integer 320–4000. `x`, `y`: integers in ±1,000,000.
- At most 12 frames per page, 600 per app.

**Tier.** `tierForWidth(width)`: `width <= 599` → `mobile`; `width <= 1023` → `tablet`; otherwise `base`. This is the same boundary as the device media queries, so the CSS a frame renders and the styles it edits agree. Lives in `@hub/protocol` next to `DEVICE_WIDTH`.

**Size key.** `sizeKey({ width, viewportHeight })` = `` `${width}x${viewportHeight}` ``. Renders are keyed by size, not by device, so two frames of the same size share one render.

**Default layout.** A page with no saved frames gets three: 1440 × 900, 834 × 1194, 390 × 844, in one row (80 px gaps), rows stacked by page route order with 200 px gaps — today's layout. Defaults are materialized and saved the first time an app's layout is read, so they behave like any other frame afterwards.

## Components

### `@hub/protocol` (render.ts)

- Add `CanvasFrame`, `FrameSize`, `tierForWidth`, `sizeKey`, `parseSizeKey`, and the limits (`FRAME_WIDTH_MIN/MAX`, `FRAME_VIEWPORT_MIN/MAX`, `MAX_FRAMES_PER_PAGE`, `MAX_FRAMES_PER_APP`).
- `PageRender` gains `width` (already present) and `viewportHeight`; `device` becomes the tier derived from the width (kept for the client's label and selection).
- `ManifestPage.renders` becomes `Record<string /* sizeKey */, PageRender>`. `RenderManifest.version` becomes `2`. A version-1 manifest read by the server is treated as empty (`prev = undefined`), so the first render after upgrade re-captures everything.
- `DEVICES`, `DEVICE_WIDTH`, `DEVICE_VIEWPORT_HEIGHT`, `DEVICE_LABEL` stay; they now describe the tiers and the default frames.

### `@hub/renderer`

- A job takes `{ pageId, size: FrameSize, html, css }`. The tier is `tierForWidth(size.width)`; `cssForDevice(css, tier)` reduces the CSS as today.
- `capture` sets the viewport to `size.width × size.viewportHeight`; the page height is the content height, at least `viewportHeight`, at most `MAX_PAGE_HEIGHT`.
- `tileKey(html, css, size, zoom)` hashes `` `${width}x${viewportHeight}` `` instead of the device name. `RENDER_VERSION` is bumped.
- `renderDoc(pool, doc, { sizes, prev, store })` renders every page at every requested size, reusing a render when its hash and levels are unchanged; failure handling is unchanged (last good render kept, `error` set). `sizes` is per page: `Map<pageId, FrameSize[]>`, so a size used only by one page's frames is not rendered for every page.

### Server

- **Storage.** Migration adds `canvas_frames (app TEXT NOT NULL, id TEXT NOT NULL, page_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, viewport_height INTEGER NOT NULL, PRIMARY KEY (app, id))`.
- **`CanvasFrames` service** (`apps/server/src/design/frames.ts`): `list(app)` (materializes defaults for pages without frames, drops frames whose page no longer exists), `replace(app, frames)` (validates, writes all of the app's frames in one transaction), `sizesByPage(app)`.
- **Routes:** `GET /api/apps/:app/design/frames` → `{ frames }`; `PUT /api/apps/:app/design/frames` with `{ frames }` → `{ frames }` after validation. The client sends the whole layout (≤ 600 frames, small) instead of per-frame patches; last write wins. Invalid input → 400 naming the first bad frame and field.
- **Rendering.** The sync service renders with `sizes = frames.sizesByPage(app)` after import, after every applied edit, and after every `PUT` that changes the set of sizes. `renderDoc` reuses every unchanged page × size render, so only new sizes are captured, and the manifest it writes lists only the sizes still in use.
- **Selection** keeps `{ pageId, device, nodeIds }`; `device` is the tier of the frame the user tapped. Edits and chat therefore keep working unchanged.

### Client (canvas)

- **Layout.** `layoutFrames` takes the frame list and the manifest instead of the visible-device set: each frame is placed at its `x, y`, `w = width`, `h = max(render.height, viewportHeight)`, `render = page.renders[sizeKey(frame)]`. The device visibility toggles are removed (deleting or adding frames replaces them).
- **Selection** in the client is frame-scoped (`frameId` + node ids) so the highlight stays in the tapped frame when a page has two frames of the same tier; what is sent to the server is the tier.
- **Gestures** (pointer events, touch-first):
  - Drag the frame label → move. On release, snap to an 8 px grid and save.
  - Drag the right-edge handle → width; drag the bottom-edge handle → viewport height. A readout shows `width × height · Tier`. The old tiles stay at their CSS size, pinned to the frame's top-left. On release: clamp to limits, save, and show "Rendering…" on the frame until the manifest has that size.
  - The handles are 24 px touch targets outside the frame edge; they do not steal taps inside the page (which still select nodes).
- **Frame menu** (from the label): Duplicate (placed to the right, 80 px gap), Delete (disabled for the last frame of a page), Set size (numeric width × height).
- **Add frame** (page row action): presets 1920, 1600, 1440, 1280, 1024, 834, 768, 600, 390, 360 (viewport heights 1080, 900, 900, 800, 768, 1194, 1024, 960, 844, 780) and Custom. The new frame goes to the right of the page's rightmost frame.
- **Label:** `` `${name} · ${width} × ${viewportHeight} · ${DEVICE_LABEL[tier]} styles` ``.
- **Saving:** every change PUTs the full layout, debounced 300 ms; a failed save shows an error toast and reloads the server layout.

## Data flow

1. Canvas loads → `GET frames` + manifest → layout.
2. User resizes a frame → local layout updates live → release → `PUT frames` → server stores, renders missing page × size pairs → manifest updates → canvas swaps in the new tiles.
3. User edits a node in a frame → selection with that frame's tier → edit applies → server re-renders every page × size the edit affects (unchanged hash reuse) → manifest updates.
4. Import removes a page → its frames are dropped on the next `list`; a new page gets the default three frames.

## Errors and limits

- Out-of-range or non-integer sizes, unknown pages, duplicate ids, more than 12 frames on a page or 600 per app → 400, nothing saved.
- A render failure for one size shows on every frame of that size with the last good tiles, as today.
- Many distinct sizes multiply render work per edit. The 12-per-page cap bounds it; the canvas label shows "Rendering…" while a size is pending, so a slow render is visible rather than silent.

## Testing

- **protocol:** `tierForWidth` at 599/600 and 1023/1024; `sizeKey` round-trip; limits.
- **renderer:** a page whose layout depends on width (flex wrap) renders different heights at 1600 and 700; `100vh` follows `viewportHeight`; tile keys differ by size and match for equal sizes; tier CSS chosen by width.
- **server:** frames CRUD and validation messages; defaults materialized once; frames dropped for removed pages; PUT with a new size captures only the new pairs (the rest reused) and drops unused sizes from the manifest; edits re-render every saved size; v1 manifest treated as empty.
- **client:** layout from frames; move/resize gestures (pointer sequences, clamping, grid snap); handles don't block node taps; selection stays in the tapped frame; label text; debounced save and error reload.
- **manual (owner):** adhunters-v7 `/ads` at 1600 × 900 next to the Figma screenshot; resize to 700 and back; reload on the tablet.

## Rollout

New branch `feat/canvas-frames` stacked on `feat/real-app-import`, its own worktree (`~/Projects/designer-wt/canvas-frames`), rebased when the importer branch's fix wave lands. The local hub switches to this worktree for the owner's play-test once the client and server tasks pass. No push or PR without the owner's go-ahead.
