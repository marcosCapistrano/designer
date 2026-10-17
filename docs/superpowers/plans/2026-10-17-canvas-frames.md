# Canvas frames of any size — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner view and edit any page in frames of any width and viewport height, placed and resized freely on the canvas, with the layout saved by the hub per app.

**Architecture:** Renders are keyed by frame size (`"<width>x<viewportHeight>"`) instead of the three device names; the renderer captures any size and picks the style tier from the width. The server stores each app's frames in SQLite and renders every page × size its layout uses. The client lays frames out from that list, edits the tier the tapped frame's width falls into, and adds move/resize handles and a frame menu.

**Tech Stack:** pnpm monorepo, TypeScript, vitest, Preact (client), Hono + better-sqlite3 + zod (server), Playwright Chromium (renderer).

**Spec:** `docs/superpowers/specs/2026-10-17-canvas-frames-design.md`

## Global Constraints

- The design model, importer, export and `NodeStyle { base, tablet, mobile }` do not change. Device media stay exactly `(max-width: 1023px)` and `(max-width: 599px)`.
- `tierForWidth(width)`: `width <= 599` → `mobile`; `width <= 1023` → `tablet`; else `base`.
- Frame limits: width integer 240–3840; viewportHeight integer 320–4000; x, y integers within ±1,000,000; at most 12 frames per page and 600 per app; frame id `f` + 16 lowercase hex chars.
- Default frames per page (in this order): 1440 × 900, 834 × 1194, 390 × 844 — today's `DEVICE_WIDTH` / `DEVICE_VIEWPORT_HEIGHT`. Row gap between frames 80 (`FRAME_GAP`), between page rows 200 (`ROW_GAP`).
- Add-frame presets (width × viewportHeight): 1920 × 1080, 1600 × 900, 1440 × 900, 1280 × 800, 1024 × 768, 834 × 1194, 768 × 1024, 600 × 960, 390 × 844, 360 × 780.
- Frame label text: `` `${name} · ${width} × ${viewportHeight} · ${DEVICE_LABEL[tier]} styles` ``, with ` · Rendering…` appended while the frame's size has no render.
- Moves snap to an 8 px grid on release. Layout saves are the whole layout, debounced 300 ms; last write wins.
- Frame moves and resizes never enter design undo history.
- The machine has 7 GB RAM: run one package's suite at a time. `packages/design-model` `perf.test.ts` medians fail under load and pass alone; don't count those.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.

## Decisions beyond the spec

- **Default positions need render heights**, which exist only after a render. So `sizesByPage` (used to render) returns the default sizes for pages without saved frames *without* writing anything, and `list` (used by the client) materializes and saves defaults for those pages, placing their rows below the lowest existing frame using the manifest's heights (falling back to `viewportHeight`).
- **The spec's "Add frame (page row action)"** is reached from the frame menu of any frame of that page (every page keeps at least one frame), rather than a separate row control.
- **The height handle** is a 24 px tab outside the frame's right edge at the viewport line (`y + viewportHeight`), with a dashed fold line drawn across the frame there. The width handle is the rest of the band outside the right edge. Nothing inside the page area is a handle, so taps there still select nodes.
- **Re-render trigger:** after a frames GET or PUT, if any page × size in the layout is missing from the manifest (or the manifest is not version 2), the server schedules one background preview render for that app (deduplicated while one runs). This covers new sizes, the v1 → v2 upgrade, and stale layouts in one rule.

## Review Focus

1. **Two frames of the same tier on one page** (1440 and 1600). Expected: tapping a node in the 1600 frame highlights it in that frame only, and the edit applies to Desktop styles. Pinned in Task 4.
2. **Resizing across a tier boundary** (1024 → 1023, 600 → 599). Expected: the label switches tier on release, and the next tap's selection carries the new tier. Pinned in Task 5.
3. **A stale layout saved after an import removed a page** (or from a second device). Expected: the PUT is refused, the client shows the error and reloads the server layout, and further edits save normally. Pinned in Task 6.
4. **A gesture starting on a handle in Select tool or with a pen.** Expected: the handle wins over marquee and pan; a tap inside the page still selects. Pinned in Task 5.
5. **A new size with no render yet, or a failed render at one size.** Expected: the frame shows the frame's previous tiles pinned top-left (or a blank frame) with "Rendering…", then swaps in the new render; a failure shows the error badge on every frame of that size. Pinned in Tasks 2 and 4.

---

### Task 1: Frame vocabulary in `@hub/protocol`

**Files:**
- Create: `packages/protocol/src/frames.ts`, `packages/protocol/src/frames.test.ts`
- Modify: `packages/protocol/src/index.ts` (export `./frames.js`)

**Interfaces:**
- Produces:
  - `interface FrameSize { width: number; viewportHeight: number }`
  - `interface CanvasFrame extends FrameSize { id: string; pageId: string; x: number; y: number }`
  - Constants `FRAME_WIDTH_MIN = 240`, `FRAME_WIDTH_MAX = 3840`, `FRAME_VIEWPORT_MIN = 320`, `FRAME_VIEWPORT_MAX = 4000`, `FRAME_COORD_MAX = 1_000_000`, `MAX_FRAMES_PER_PAGE = 12`, `MAX_FRAMES_PER_APP = 600`, `FRAME_GAP = 80`, `ROW_GAP = 200`, `FRAME_GRID = 8`.
  - `DEFAULT_FRAME_SIZES: readonly FrameSize[]` (from `DEVICE_WIDTH`/`DEVICE_VIEWPORT_HEIGHT` in base, tablet, mobile order) and `FRAME_PRESETS: readonly FrameSize[]` (the ten presets, in Global Constraints order).
  - `tierForWidth(width: number): Device`
  - `sizeKey(size: FrameSize): string` → `"1440x900"`; `parseSizeKey(key: string): FrameSize | null` (null unless `^\d+x\d+$` and within limits).
  - `validateFrames(frames: unknown, pageIds: ReadonlySet<string>): { ok: true; frames: CanvasFrame[] } | { ok: false; error: string }` — the error names the first bad frame by index and field, e.g. `frames[3].width must be an integer from 240 to 3840`, `frames[2].pageId is not a page of this app`, `frames[5].id duplicates frames[1].id`, `page page-1 has more than 12 frames`, `more than 600 frames`.
  - `defaultFrames(pages: readonly { pageId: string }[], existing: readonly CanvasFrame[], heightOf: (pageId: string, size: FrameSize) => number, newId: () => string): CanvasFrame[]` — returns `existing` plus the three default frames for every page that has none, in the given page order, one row per page: frames left to right with `FRAME_GAP`, row height = max of `heightOf` for its frames, first new row at `y = 0` if `existing` is empty, else at (lowest existing frame bottom, using `heightOf(frame.pageId, frame)`) + `ROW_GAP`, each next row + `ROW_GAP`.

- [ ] **Step 1: Write the failing tests** in `frames.test.ts`:
  - `tierForWidth` returns `mobile` for 240 and 599, `tablet` for 600 and 1023, `base` for 1024 and 3840.
  - `sizeKey({width:1600,viewportHeight:900})` is `'1600x900'`; `parseSizeKey('1600x900')` round-trips; `parseSizeKey('base')`, `parseSizeKey('100x900')`, `parseSizeKey('1600x900x1')` are null.
  - `validateFrames` accepts a valid list; rejects with the exact messages above for: width 239, width 1600.5, viewportHeight 4001, x 1_000_001, unknown pageId, duplicate id, id `'g0123456789abcdef'`, 13 frames on one page, 601 frames, a non-array.
  - `defaultFrames` with two pages and no existing frames: page 1 frames at (0,0) 1440 wide, (1520,0) 834, (2434,0) 390; page 2 row at `y = max(heights of page 1) + 200`. With one existing frame for page 1, only page 2 gets defaults, placed below the existing frame's bottom + 200. Ids come from `newId` in order.
- [ ] **Step 2: Run** `cd packages/protocol && npx vitest run src/frames.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `frames.ts`** with the interfaces above; import `Device`, `DEVICE_WIDTH`, `DEVICE_VIEWPORT_HEIGHT` from `./render.js`. Integer checks use `Number.isInteger`; the id pattern is `/^f[0-9a-f]{16}$/`.
- [ ] **Step 4: Run** the test file (PASS), then `npx vitest run` and `npx tsc --noEmit` in `packages/protocol` — all pass.
- [ ] **Step 5: Commit** `feat(protocol): canvas frame sizes, tiers, validation and default layout`.

### Task 2: Renders keyed by size (behavior unchanged: default sizes)

One slice through protocol, renderer, server and client so every suite stays green: renders are keyed by size, and every caller still asks for the three default sizes.

**Files:**
- Modify: `packages/protocol/src/render.ts` (`PageRender`, `ManifestPage`, `RenderManifest`)
- Modify: `packages/renderer/src/{keys,html,capture,render}.ts` and their tests; `apps/client/dev/render-fixtures.ts`
- Modify: `apps/server/src/sync/service.ts:105`
- Modify: `apps/client/src/canvas/layout.ts` (+ test), `apps/client/src/canvas/painter.ts:260` (label), any client test fixture that builds manifests

**Interfaces:**
- Consumes: Task 1 `FrameSize`, `sizeKey`, `tierForWidth`, `DEFAULT_FRAME_SIZES`.
- Produces:
  - `PageRender` gains `viewportHeight: number`; `device` stays and is always `tierForWidth(width)`.
  - `ManifestPage.renders: Record<string, PageRender>` keyed by `sizeKey`. `RenderManifest.version: 2`.
  - `RENDER_VERSION = 2`; `tileKey(html: string, css: string, size: FrameSize, zoom: Zoom): string` hashes `` `r${RENDER_VERSION}:` + html + css + sizeKey(size) + String(zoom) ``.
  - `buildDocument(html: string, css: string, width: number): string` (viewport meta uses the width).
  - `CaptureJob { html; css; size: FrameSize }`; capture sets the viewport to `size.width × size.viewportHeight`; height = `min(MAX_PAGE_HEIGHT, max(viewportHeight, content))`.
  - `RenderJob { pageId; size: FrameSize; html; css }` (css already reduced with `cssForDevice(css, tierForWidth(size.width))`).
  - `RenderDocOptions { sizes: (pageId: string) => readonly FrameSize[]; prev: RenderManifest | null; store: TileStore; concurrency?: number }`. Duplicate sizes for a page are rendered once. A `prev` whose `version !== 2` is ignored. The manifest lists, per page, exactly the requested sizes (no carry-over of unrequested ones). Result entries are `` `${pageId}@${sizeKey}` ``.
  - Server `SyncService.preview` passes `sizes: () => DEFAULT_FRAME_SIZES` (Task 3 replaces it).
  - Client `layoutFrames` keeps its current signature for now and reads `page.renders[sizeKey(DEFAULT_FRAME_SIZES[i])]` for the device at index i; the label uses `frame.device` as before.

- [ ] **Step 1: Write the failing renderer tests** (`render.test.ts`, `keys.test.ts`, `capture.test.ts`):
  - `tileKey` differs for `{1600,900}` vs `{1440,900}` vs `{1600,1000}` and is equal for equal sizes.
  - Reflow: a flex-wrap row of three `800px × 100px` children (body margin 0) captured with viewportHeight 150 is 300 tall at width 1000 (one per row) and 200 tall at width 1700 (two on the first row).
  - `100vh` follows viewportHeight: `<div style="height:100vh"></div>` at `{width:800, viewportHeight:700}` renders height 700.
  - Tier CSS by width: for css `.a{color:red}` + `@media (max-width: 1023px){.a{color:blue}}`, `renderDoc` passes the job the css reduced for `tierForWidth(width)`: the job css at width 1023 equals `cssForDevice(css, 'tablet')`, and at 1024 equals `cssForDevice(css, 'base')`; the captured `.a` pixel is blue at 1023 and red at 1024.
  - `renderDoc` with `sizes: () => [{1600,900},{1600,900},{390,844}]` renders two entries per page; manifest `renders` keys are `'1600x900'` and `'390x844'`; a second call with `prev` reuses both; a `prev` with `version: 1` re-renders; a call that drops `390x844` returns a manifest without it.
  - A failed render at one size keeps the previous render for that key with `error` set (existing failure test, re-keyed).
- [ ] **Step 2: Run** `cd packages/renderer && npx vitest run` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the protocol and renderer changes listed in Produces. Bump `RENDER_VERSION` to 2 and update the key comment in `keys.ts`.
- [ ] **Step 4: Run** `packages/renderer` tests — PASS.
- [ ] **Step 5: Update callers**: server `service.ts` passes `sizes: () => DEFAULT_FRAME_SIZES`; `apps/client/dev/render-fixtures.ts` likewise; client `layout.ts` reads renders by `sizeKey`; client and server test fixtures building `PageRender`/manifests use `version: 2`, size keys and `viewportHeight`.
- [ ] **Step 6: Run** one at a time: `pnpm -F @hub/protocol test`, `pnpm -F @hub/server test`, `pnpm -F @hub/client test`, then `pnpm -r typecheck` — all pass.
- [ ] **Step 7: Commit** `feat(renderer): key renders by frame size instead of device`.

### Task 3: Server frame layout (storage, routes, rendering from frames)

**Files:**
- Modify: `apps/server/src/db.ts` (append one migration)
- Create: `apps/server/src/design/frames.ts`, `apps/server/src/design/frames.test.ts`, `apps/server/src/design/frame-routes.ts`, `apps/server/src/design/frame-routes.test.ts`
- Modify: `apps/server/src/sync/service.ts` (sizes from frames), `apps/server/src/app.ts` (mount routes), `apps/server/src/main.ts` (wire service)

**Interfaces:**
- Consumes: Task 1 (`CanvasFrame`, `FrameSize`, `validateFrames`, `defaultFrames`, `DEFAULT_FRAME_SIZES`, `sizeKey`); Task 2 (`RenderManifest` v2, `RenderDocOptions.sizes`).
- Produces:
  - Migration: `CREATE TABLE canvas_frames (app TEXT NOT NULL, id TEXT NOT NULL, page_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, viewport_height INTEGER NOT NULL, PRIMARY KEY (app, id));`
  - `class CanvasFrames { constructor(deps: { db: Db; pages: (app: string) => Promise<{ pageId: string }[] | null>; manifest: (app: string) => Promise<RenderManifest | null>; newId?: () => string }) }` with
    - `list(app): Promise<CanvasFrame[]>` — loads saved frames, drops frames of pages that no longer exist, materializes defaults (Task 1 `defaultFrames`, heights from the manifest render at that size, else `viewportHeight`) for pages with none, saves if anything changed, returns frames sorted by page order then x. No imported design → `[]`.
    - `replace(app, frames: unknown): Promise<{ ok: true; frames: CanvasFrame[] } | { ok: false; error: string }>` — `validateFrames` against the current page ids; on success deletes and inserts the app's frames in one transaction.
    - `sizesByPage(app): Promise<(pageId: string) => readonly FrameSize[]>` — saved sizes per page (deduplicated by `sizeKey`), `DEFAULT_FRAME_SIZES` for pages with none. Never writes.
    - `missingRenders(app, manifest: RenderManifest | null): Promise<boolean>` — true when the manifest is null/not v2 or any page × saved size has no render.
  - `SyncService.preview` uses `await frames.sizesByPage(app)`. `SyncService` gains `ensureRendered(app): void` — if `missingRenders` and no render is running for the app, runs `retryPreview(app)` in the background, swallowing a "no import yet" 409 and logging other errors.
  - Routes (mounted under `/api/apps`, behind auth): `GET /:app/design/frames` → `200 { frames }`, then `ensureRendered`; `PUT /:app/design/frames` with `{ frames: CanvasFrame[] }` (zod: object with `frames` array, max 600; per-frame shape checked by `validateFrames`) → `200 { frames }` and `ensureRendered`, or `400 { error }`. Unknown app → 404 as other routes.

- [ ] **Step 1: Write the failing tests** (`frames.test.ts` with an in-memory `better-sqlite3` db migrated by `migrate`; fake `pages` and `manifest`):
  - First `list` for an app with pages `[p1, p2]` and no manifest returns six frames (defaults) and persists them (a second `list` returns identical ids).
  - Defaults placed with manifest heights: p1's mobile render height 5401 → p2's row at `5401 + 200`.
  - After `pages` drops `p2`, `list` returns only p1's frames and the db no longer has p2's.
  - `replace` with a frame of width 239 → `{ ok:false, error:'frames[0].width must be an integer from 240 to 3840' }` and nothing changes; a valid replace round-trips through `list`.
  - `sizesByPage`: p1 saved `[1600x900, 1600x900, 390x844]` → `[1600x900, 390x844]`; p3 with none → `DEFAULT_FRAME_SIZES`; db unchanged.
  - `missingRenders`: v1 manifest → true; v2 manifest with all sizes → false; layout with a new `1280x800` → true.
- [ ] **Step 2: Run** `cd apps/server && npx vitest run src/design/frames.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration and `CanvasFrames`. Ids from `'f' + randomBytes(8).toString('hex')`.
- [ ] **Step 4: Write the failing route tests** (`frame-routes.test.ts`, using the app test helpers the other route tests use): GET returns `{ frames }`; PUT valid → 200 and the same frames on the next GET; PUT invalid → 400 with the validation message; PUT without a session → 401; both trigger `ensureRendered` once (spy); PUT with a new size schedules one render even when called twice quickly (dedupe).
- [ ] **Step 5: Implement** the routes, mount them in `app.ts` after `designRoutes`, wire `CanvasFrames` into `SyncService` and `main.ts` (pages from the saved design state's doc pages; manifest from `FsTileStore.readManifest`).
- [ ] **Step 6: Run** `pnpm -F @hub/server test` then `pnpm -F @hub/server typecheck` — PASS (a server test that pinned "renders three devices" now pins the default sizes).
- [ ] **Step 7: Commit** `feat(server): store canvas frames per app and render the sizes they use`.

### Task 4: Canvas laid out from frames

**Files:**
- Create: `apps/client/src/canvas/frames.ts` (+ test) — the `FrameStore` interface and an in-memory store
- Create: `apps/client/src/net/frame-store.ts` (+ test) — server-backed store
- Modify: `apps/client/src/canvas/layout.ts` (+ test), `controller.ts` (+ test), `painter.ts` (+ test), `runtime.ts`, `CanvasView.tsx`, `apps/client/src/areas/design/DesignArea.tsx`, `apps/client/src/areas/design/EditorPanel.tsx`, `apps/client/src/harness.tsx`

**Interfaces:**
- Consumes: Task 1, Task 2 manifest shape, Task 3 routes.
- Produces:
  - `interface FrameStore { load(): Promise<CanvasFrame[]>; save(frames: readonly CanvasFrame[]): Promise<CanvasFrame[]> }`; `class MemoryFrameStore implements FrameStore` (defaults via `defaultFrames` from a manifest given at construction; used by the harness and tests); `class ServerFrameStore implements FrameStore` (`GET`/`PUT /api/apps/:app/design/frames` through the existing api client; non-2xx → `ApiError` with the server's `error`).
  - `Frame` (layout.ts) becomes `{ frameId: string; pageId: string; name: string; device: Device /* tier */; x: number; y: number; w: number; h: number; viewportHeight: number; render: PageRender | null; stale: PageRender | null; pending: boolean }`.
  - `layoutFrames(frames: readonly CanvasFrame[], m: RenderManifest, lastRenders?: ReadonlyMap<string, PageRender>): Frame[]` — one Frame per CanvasFrame whose page is in the manifest; `w = width`; `render = page.renders[sizeKey(frame)] ?? null`; `h = max(render?.height ?? 0, viewportHeight)`; `pending = render === null`; `stale = pending ? lastRenders?.get(frameId) ?? null : null`.
  - `CanvasController.setFrames(frames: readonly CanvasFrame[]): void` replaces `setDevices`; the controller keeps `lastRenders` (frameId → last non-null render it laid out).
  - Selection: the controller's internal selection is `{ frameId, nodeIds }`; `onSelect` still receives `NodeSelection { pageId, device: frame.device, nodeIds }`. `select()` keeps the highlight in `frameId` only.
  - Painter: draws `stale` tiles at their own size pinned to the frame's top-left, clipped to the frame; draws the label from Global Constraints; draws a dashed fold line at `y + viewportHeight` when the frame is taller.
  - `CanvasView` gets a `frames: FrameStore` prop and loads it with the manifest; the device toggle buttons are removed.

- [ ] **Step 1: Write the failing tests**:
  - `layout.test.ts`: frames at their saved positions; a frame whose page is missing is skipped; `h = max(render height, viewportHeight)`; a size with no render → `pending: true`, `stale` from `lastRenders`.
  - `controller.test.ts`: two frames of page p1 at 1440 and 1600; tapping a hit box inside the 1600 frame emits `{ pageId:'p1', device:'base', nodeIds:[id] }` and the overlay highlight is drawn only inside the 1600 frame (Review Focus 1). A 700 frame tap emits `device:'tablet'`.
  - `painter.test.ts`: label text `'/ads · 1600 × 900 · Desktop styles'`; pending frame label ends with `' · Rendering…'`; stale tiles drawn at the frame origin; a render with `error` shows the badge (existing test, re-keyed) on every frame of that size.
  - `frame-store.test.ts`: `ServerFrameStore.save` PUTs `{ frames }` and returns the server's list; a 400 rejects with `ApiError` carrying the server message.
- [ ] **Step 2: Run** `cd apps/client && npx vitest run src/canvas src/net` — FAIL.
- [ ] **Step 3: Implement** the interfaces above; `DesignArea` and `EditorPanel` pass `new ServerFrameStore(app, api)`; `harness.tsx` passes a `MemoryFrameStore`.
- [ ] **Step 4: Run** `pnpm -F @hub/client test` then `pnpm -F @hub/client typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(client): lay the canvas out from saved frames`.

### Task 5: Move and resize frames on the canvas

**Files:**
- Create: `apps/client/src/canvas/frame-drag.ts` (+ test)
- Modify: `apps/client/src/canvas/controller.ts` (+ test), `painter.ts` (handles and readout), `CanvasView.tsx` (debounced save)

**Interfaces:**
- Consumes: Task 4 `Frame`, `FrameStore`, `CanvasController.setFrames`.
- Produces:
  - `type HandleKind = 'move' | 'width' | 'height'`; `HANDLE_PX = 24`.
  - `hitHandle(frames: readonly Frame[], p: Point /* world */, scale: number): { frameId: string; kind: HandleKind } | null` — label band (20 CSS px above the frame, full frame width) → `move`; band `HANDLE_PX / scale` wide outside the right edge: within `HANDLE_PX / scale` of `y + viewportHeight` → `height`, else → `width`. Inside the frame → null.
  - `dragFrame(frame: CanvasFrame, kind: HandleKind, dx: number, dy: number /* world */): CanvasFrame` — move adds dx/dy; width adds dx; height adds dy; sizes clamped to limits; integers.
  - `settleFrame(frame: CanvasFrame): CanvasFrame` — snaps x and y to `FRAME_GRID`.
  - Controller: a pointerdown on a handle (any tool, any pointer type) starts a frame drag that the gesture tracker never sees; moves update the layout live (the frame keeps its pre-drag render as `stale` and the readout `"${width} × ${viewportHeight} · ${tier label}"` is painted next to the handle); pointerup settles and calls `deps.onFramesChange?.(frames: CanvasFrame[])`; pointercancel restores the pre-drag frame.
  - `CanvasView` saves through `FrameStore.save` debounced 300 ms; a rejected save shows the error via the existing error banner and reloads `FrameStore.load()`.

- [ ] **Step 1: Write the failing tests**:
  - `frame-drag.test.ts`: `hitHandle` at scale 1 and 0.25 (bands scale with zoom); a point inside the frame → null; `dragFrame` width 1440 + 3000 → 3840, height 900 − 1000 → 320; `settleFrame` snaps (13, −5) → (16, −8).
  - `controller.test.ts`: in `select` tool with a pen, pointerdown on the right band and moving 200 px at scale 1 changes the width live, emits no marquee, and on pointerup calls `onFramesChange` once with width 1640; a tap inside the frame after that still selects a node (Review Focus 4); a width drag from 1024 to 1023 then a tap emits `device:'tablet'` (Review Focus 2); pointercancel restores the original frame and emits nothing.
  - `CanvasView`-level test (or runtime test): three quick changes produce one `save`; a rejected save shows the message and calls `load`.
- [ ] **Step 2: Run** `cd apps/client && npx vitest run src/canvas` — FAIL.
- [ ] **Step 3: Implement** `frame-drag.ts`, the controller handling and painter handles/readout, and the debounced save.
- [ ] **Step 4: Run** `pnpm -F @hub/client test` and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(client): move and resize canvas frames`.

### Task 6: Frame menu — size, add, duplicate, delete

**Files:**
- Create: `apps/client/src/canvas/FrameMenu.tsx` (+ test)
- Modify: `apps/client/src/canvas/controller.ts` (label tap → menu), `CanvasView.tsx`

**Interfaces:**
- Consumes: Task 4/5 (`FrameStore`, `setFrames`, `onFramesChange`, `FRAME_PRESETS`, `validateFrames`, limits).
- Produces:
  - Controller dep `onFrameMenu?: (frameId: string, screen: Point) => void`, fired by a tap (not a drag) on a frame's label band.
  - `FrameMenu` props `{ frame: CanvasFrame; frames: readonly CanvasFrame[]; onChange(frames: CanvasFrame[]): void; onClose(): void }`. Sections:
    - **Size:** the ten presets (`"1600 × 900"` buttons) and a custom width × height pair of number inputs with an Apply button; out-of-range input shows the limit (`Width must be 240–3840`) and does not apply.
    - **Add frame:** the same presets; adds a frame of that size to this frame's page, to the right of the page's rightmost frame (`x = right edge + FRAME_GAP`, same `y` as this frame), disabled with "12 frames per page" at the cap.
    - **Duplicate:** same size, placed to the right of this frame the same way.
    - **Delete:** disabled when it is the page's last frame.
  - All changes go through `onChange`, which updates the controller and the debounced save from Task 5. Touch targets ≥ 44 px, as the existing toolbar buttons.

- [ ] **Step 1: Write the failing tests** (`FrameMenu.test.ts` in the client's existing component-test style): choosing preset 1600 × 900 calls `onChange` with that frame resized; custom 239 shows `Width must be 240–3840` and no `onChange`; Add frame places the new frame at the right of the page's rightmost frame with a fresh id; Delete is disabled for a page's only frame; Add frame is disabled at 12. Controller test: a tap on the label band fires `onFrameMenu`, a drag on it moves the frame and does not.
- [ ] **Step 2: Run** `cd apps/client && npx vitest run src/canvas` — FAIL.
- [ ] **Step 3: Implement** `FrameMenu.tsx` and wire it in `CanvasView` (positioned at the tap's screen point, closed on outside tap or Escape).
- [ ] **Step 4: Stale-layout recovery test (Review Focus 3):** with a `FrameStore` whose `save` rejects once with `ApiError('frames[0].pageId is not a page of this app')`, a menu change shows that message, reloads, and the next change saves. Run it — PASS after Step 3 wiring.
- [ ] **Step 5: Run** `pnpm -F @hub/client test`, `pnpm -F @hub/client typecheck`, `pnpm -F @hub/client build` — PASS.
- [ ] **Step 6: Commit** `feat(client): frame menu to size, add, duplicate and delete frames`.

### Task 7: Play-test on the local hub (controller)

- [ ] **Step 1:** Rebase `feat/canvas-frames` onto the final `feat/real-app-import` head; run protocol, renderer, server and client suites one at a time and `pnpm -r typecheck`.
- [ ] **Step 2:** Restart the local hub from `~/Projects/designer-wt/canvas-frames` (see `~/hub-local/README`), update the README's start line, open adhunters-v7: the canvas shows the default three frames per page and a render is scheduled for the v1 → v2 manifest.
- [ ] **Step 3:** Add a 1600 × 900 frame to `/ads`; compare with `~/hub-local/figma/ads-list.png`; resize it to 700 and back; tap a card title in the 1600 frame and edit it, undo. Reload and confirm the layout persisted.
- [ ] **Step 4:** Record the results in the ledger and report to the owner.
