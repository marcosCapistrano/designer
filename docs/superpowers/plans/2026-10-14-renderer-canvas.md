# Renderer + Canvas Client Implementation Plan (Plan 2 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render design pages per device into deterministic WebP tiles plus hit maps with a long-lived Playwright pool, and show them on a smooth Canvas 2D infinite canvas (Preact PWA) with device frames, LOD, culling, an IndexedDB tile cache, tap selection and box selection. A static dev harness makes it usable before the hub server exists.

**Architecture:** `@hub/renderer` loads `exportPage` output into Chromium (JS disabled, network blocked) at the device width. It takes one full-page PNG, slices it with sharp into 512px WebP tiles at zoom 0.25/0.5/1, and collects a hit map from `data-d-id` boxes. A render is addressed by `sha256(html + css + device + zoom)`, where `css` is first reduced to the rules that apply on that device. As a result, an edit re-renders exactly the page×devices whose input changed, and a component edit re-renders every page whose exported HTML contains it. The client reads a `RenderManifest` through a `TileSource` (a static folder now, the hub server in plan 3) and lays out one row per page with device frames side by side. It paints with a dirty-rect painter that blits the previous frame while panning and repaints only the exposed strips. Measured in headless Chromium at 4x CPU throttle, a full smoothed redraw runs at 20–30 fps and blit + strip runs at 60 fps.

**Tech Stack:** Node 22, pnpm 10, TypeScript strict ESM, vitest, Playwright 1.56.1 (Chromium), sharp 0.34.5 (WebP), Preact 10, Vite 7, idb-keyval, fake-indexeddb (tests), sirv (dev static serving), tsx (dev harness).

**Spec:** `docs/superpowers/specs/2026-10-14-hub-design.md` (also `/mnt/project-files/designer/spec.md`): §5.3 targeting, §5.5 rendering, §1 success criterion "Panning and zooming a canvas of 50+ pages stays smooth on a Tab S6 Lite", §3 client budget, §11 failed render, §12 client performance test. Binding names: `/mnt/project-files/designer/architecture.md`. Consumes plan 1: `docs/superpowers/plans/2026-10-14-design-engine.md` (`@hub/design-model`: `DesignDoc`, `Device`, `exportPage`, `applyOp`, `allIds`, `canonicalStringify`, `sampleDoc`).

**Later plans:** plan 3 adds a server-backed `TileSource` (HTTP + `render.ready` over the WebSocket) and replaces `apps/client/src/main.tsx`. Plan 6 mounts `CanvasView` in the Design area and sends `NodeSelection` with prompts.

## Global Constraints

- Node 22, pnpm 10 workspace (`packages/*`, `apps/*`), TypeScript strict ESM, `moduleResolution: "Bundler"`, `noUncheckedIndexedAccess: true` (inherited from plan 1's `tsconfig.base.json`; every package `tsconfig.json` extends `../../tsconfig.base.json`).
- Workspace packages have no build step: each `package.json` has `"exports": { ".": "./src/index.ts" }`, consumed as TS source by vitest, tsx and Vite.
- `vitest` and `typescript` use the same version specifiers as `packages/design-model/package.json`.
- Exact pins: `playwright` and `@playwright/test` `1.56.1` (matches the Chromium in `/opt/pw-browsers` via `PLAYWRIGHT_BROWSERS_PATH`), `sharp` `0.34.5`. Ranges: `preact ^10.29.8`, `vite ^7.3.7`, `@preact/preset-vite ^2.10.6`, `idb-keyval ^6.3.0`, `fake-indexeddb ^6.2.5`, `sirv ^3.0.2`, `tsx ^4`, `@types/node ^22`.
- `@hub/protocol` has zero dependencies. It holds types, constants and pure string helpers only.
- Devices: `base` = desktop 1440px, `tablet` 834px, `mobile` 390px. Media queries `(max-width: 1023px)` and `(max-width: 599px)`.
- Tiles: 512×512 WebP at zooms `0.25`, `0.5`, `1`. Level key = `sha256(html + css + device + String(zoom))` in hex, where `css` is `cssForDevice(exported css, device)`. Tile index `x_y`. Hit map `{ nodeId, x, y, w, h }[]` in page CSS px at zoom 1, in paint order.
- Renderer output depends only on (html, css, device). It contains no timestamps and no randomness. Chromium runs with JavaScript disabled and every network request aborted.
- Code run inside Chromium with `page.evaluate` is passed as a **string**, never as a function. tsx/esbuild `keepNames` injects `__name` helpers that do not exist in the page.
- Client runtime dependencies are only `preact`, `idb-keyval` and `@hub/protocol`. Total gzipped JS in `apps/client/dist` must be < 150 000 bytes. No Node APIs under `apps/client/src`.
- Client unit tests run in vitest's `node` environment with injected fakes (no jsdom). Browser behavior is covered by Playwright specs in `apps/client/e2e/`.
- Tests live next to code as `*.test.ts`. From the repo root: `pnpm -r typecheck`, `pnpm -r test`.

## Review Focus

1. **Tablet memory:** panning across 150 frames must keep decoded tiles bounded (≤ 128 images, and evicted images are `close()`d) so a 4 GB Tab S6 Lite tab does not crash. Test: Task 17 `evicts the least recently used image and closes it`.
2. **Failed render:** a failed export or a Chromium crash keeps the last good image and marks the frame with a warning badge (spec §11), never a blank frame. Tests: Task 7 `failed export keeps the last good render with an error`, Task 19 `failed render shows a badge`.
3. **Hostile design content:** text or CSS containing `</style>`, a `<script>`, or an external image URL must not break the document, run code, or stall the render on the network. Tests: Task 2 `escapes a closing style tag`, Task 4 `blocks network and scripts`.
4. **Very long pages:** a 20 000 px page (an endless list) is capped at 16 000 px instead of exhausting memory, and boxes beyond the cap are dropped. Test: Task 4 `caps very tall pages`.
5. **Chromium dying mid-render** (OOM on the hub box) must not wedge the pool, and the next render relaunches. Test: Task 3 `recovers after the browser disconnects`.

---

## File Structure

```
packages/protocol/                      @hub/protocol — shared types (plans 3, 4, 6 extend)
  src/render.ts                         Device/Zoom/tile constants, manifest + hit map types, path helpers
  src/ws.ts                             RenderReadyMsg, ServerMsg union
  src/index.ts
packages/renderer/                      @hub/renderer — Node + Playwright + sharp
  src/keys.ts                           tileKey
  src/html.ts                           cssForDevice, buildDocument
  src/pool.ts                           BrowserPool (one Chromium, N reusable pages)
  src/capture.ts                        capturePage → PNG + size + hit map
  src/tiles.ts                          sliceTiles → TileLevel[] + WebP TileFile[]
  src/store.ts                          TileStore, FsTileStore, MemoryTileStore
  src/render.ts                         renderJob, renderDoc (incremental, last-good on failure)
  src/index.ts
apps/client/                            @hub/client — Vite + Preact PWA
  index.html, vite.config.ts, vitest.config.ts, playwright.config.ts, tsconfig.json, tsconfig.node.json
  public/manifest.webmanifest, public/icon.svg, public/sw.js
  scripts/check-size.mjs                gzipped JS budget check
  dev/generate.ts                       deterministic generated DesignDoc (sampleDoc + N pages)
  dev/render-fixtures.ts                harness: render generated doc into .dev-renders/
  dev/serve-renders.ts                  Vite plugin serving .dev-renders at /dev-renders (dev + preview)
  src/main.tsx                          app entry (static TileSource; plan 3 replaces)
  src/canvas/geom.ts                    Camera, Rect, transforms, fit, snapping
  src/canvas/layout.ts                  Frame, layoutFrames, frameAt, layoutBounds
  src/canvas/tiles.ts                   pickZoom (LOD), frameTiles/visibleTiles (culling), fallbackFor
  src/canvas/hit.ts                     hitTest, boxSelect, toPagePoint
  src/canvas/cache.ts                   BlobCache (IndexedDB via idb-keyval, null fallback), gc
  src/canvas/source.ts                  TileSource interface, StaticTileSource
  src/canvas/hitmaps.ts                 HitMapStore
  src/canvas/loader.ts                  TileLoader (LRU of decoded images, concurrency, IDB → source)
  src/canvas/gestures.ts                pointer/wheel → pan, zoom, tap, marquee
  src/canvas/painter.ts                 BasePainter (blit-on-pan + dirty rects)
  src/canvas/overlay.ts                 paintOverlay (selection + marquee)
  src/canvas/controller.ts              CanvasController (state + wiring, DOM-free)
  src/canvas/CanvasView.tsx             Preact component, toolbar, debug hook
  src/canvas/index.ts                   public canvas API for plans 3 and 6
  src/canvas/test-utils.ts              fake 2D context for tests
  e2e/helpers.ts, e2e/canvas.spec.ts, e2e/perf.spec.ts
.github/workflows/ci.yml                (modify) Chromium install, size check, e2e
```

---

### Task 1: Protocol package (render types)

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/vitest.config.ts`
- Create: `packages/protocol/src/render.ts`, `packages/protocol/src/ws.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/render.test.ts`
- Modify (only if missing): `packages/design-model/package.json` → add `"exports": { ".": "./src/index.ts" }`

**Interfaces:**
- Produces (exact; copy into `src/render.ts`, implementing the three helpers as the comments say):

```ts
export type Device = 'base' | 'tablet' | 'mobile';
export const DEVICES: readonly Device[] = ['base', 'tablet', 'mobile'];
export const DEVICE_WIDTH: Readonly<Record<Device, number>> = { base: 1440, tablet: 834, mobile: 390 };
/** Minimum page height and the browser viewport height used while rendering. */
export const DEVICE_VIEWPORT_HEIGHT: Readonly<Record<Device, number>> = { base: 900, tablet: 1194, mobile: 844 };
export const DEVICE_LABEL: Readonly<Record<Device, string>> = { base: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };
export type Zoom = 0.25 | 0.5 | 1;
export const ZOOMS: readonly Zoom[] = [0.25, 0.5, 1];
export const TILE_SIZE = 512;
export const MAX_PAGE_HEIGHT = 16000;
export const MANIFEST_PATH = 'manifest.json';

/** Page CSS px at zoom 1. nodeId is the element's data-d-id (instance internals look like "n5/n6"). */
export interface HitBox { nodeId: string; x: number; y: number; w: number; h: number }
export interface TileLevel { zoom: Zoom; key: string; cols: number; rows: number }
/**
 * hash = the zoom-1 level key; it also names the hit map file.
 * Never rendered successfully: hash '', height 0, levels [].
 * error is set when the latest render failed; levels/hash are then the last good ones.
 */
export interface PageRender { device: Device; hash: string; width: number; height: number; levels: TileLevel[]; error?: string }
export interface ManifestPage { pageId: string; name: string; route: string; renders: Partial<Record<Device, PageRender>> }
export interface RenderManifest { version: 1; pages: ManifestPage[] }
/** What the canvas selected; sent with prompts in plan 6. */
export interface NodeSelection { pageId: string; device: Device; nodeIds: string[] }

export function tileId(key: string, x: number, y: number): string;   // `${key}/${x}_${y}`
export function tilePath(key: string, x: number, y: number): string; // `tiles/${key}/${x}_${y}.webp`
export function hitMapPath(hash: string): string;                   // `hitmaps/${hash}.json`
```

- Produces (`src/ws.ts`):

```ts
import type { RenderManifest } from './render.js';
export interface RenderReadyMsg { type: 'render.ready'; app: string; manifest: RenderManifest }
/** Server → client WebSocket messages. Plans 3, 4 and 6 add variants to this union. */
export type ServerMsg = RenderReadyMsg;
```

- [ ] **Step 1: Scaffold.** `package.json`: `"name": "@hub/protocol"`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, scripts `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, no `dependencies`, devDependencies `vitest` and `typescript` with the same specifiers as `packages/design-model/package.json`. `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`. `vitest.config.ts`: `export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })` (from `vitest/config`). If `packages/design-model/package.json` has no `"exports"` field, add `"exports": { ".": "./src/index.ts" }`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test** `src/render.test.ts`:

```ts
import { expect, test } from 'vitest';
import { DEVICES, DEVICE_WIDTH, ZOOMS, TILE_SIZE, tileId, tilePath, hitMapPath } from './index.js';

test('device constants match the spec', () => {
  expect(DEVICES).toEqual(['base', 'tablet', 'mobile']);
  expect(DEVICE_WIDTH).toEqual({ base: 1440, tablet: 834, mobile: 390 });
  expect(ZOOMS).toEqual([0.25, 0.5, 1]);
  expect(TILE_SIZE).toBe(512);
});

test('path helpers', () => {
  expect(tileId('abc', 2, 3)).toBe('abc/2_3');
  expect(tilePath('abc', 2, 3)).toBe('tiles/abc/2_3.webp');
  expect(hitMapPath('h')).toBe('hitmaps/h.json');
});
```

- [ ] **Step 3: Run** `pnpm -F @hub/protocol test`. Expected: FAIL (cannot resolve `./index.js`).
- [ ] **Step 4: Implement** `src/render.ts` and `src/ws.ts` as given. `src/index.ts`: `export * from './render.js'; export * from './ws.js';`
- [ ] **Step 5: Run** `pnpm -F @hub/protocol test && pnpm -F @hub/protocol typecheck`. Expected: 2 tests pass, no type errors.
- [ ] **Step 6: Commit**

```bash
git add packages/protocol packages/design-model/package.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(protocol): render types, device constants, path helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 2: Renderer scaffold, tile keys, per-device CSS, document builder

**Files:**
- Create: `packages/renderer/package.json`, `packages/renderer/tsconfig.json`, `packages/renderer/vitest.config.ts`, `packages/renderer/src/index.ts`
- Create: `packages/renderer/src/keys.ts`, `packages/renderer/src/html.ts`
- Test: `packages/renderer/src/keys.test.ts`, `packages/renderer/src/html.test.ts`

**Interfaces:**
- Consumes: `Device`, `Zoom`, `DEVICE_WIDTH` from `@hub/protocol`.
- Produces:

```ts
// keys.ts — node:crypto sha256 of the plain concatenation, lowercase hex
export function tileKey(html: string, css: string, device: Device, zoom: Zoom): string;
// html.ts
export const BASE_CSS =
  'html,body{margin:0;padding:0;background:#ffffff;}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}';
export function cssForDevice(css: string, device: Device): string;
export function buildDocument(html: string, css: string, device: Device): string;
```

`cssForDevice`: plan 1's `exportPage` puts each top-level CSS block on its own line, with the tablet block starting `@media (max-width: 1023px){` and the mobile block starting `@media (max-width: 599px){`. Split on `'\n'`. For `base`, drop lines starting with either prefix. For `tablet`, drop lines starting with the 599px prefix. For `mobile`, return `css` unchanged. Join with `'\n'`. The dropped rules never apply at that width, so the rendered pixels are identical, and the key only changes when that device's effective CSS changes.

`buildDocument` returns exactly ``'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=' + DEVICE_WIDTH[device] + '"><style>' + BASE_CSS + '</style><style>' + safeCss + '</style></head><body>' + html + '</body></html>'``, where `safeCss = css.replace(/<\/style/gi, '<\\/style')`.

- [ ] **Step 1: Scaffold.** `package.json`: name `@hub/renderer`, private, `"type": "module"`, exports `./src/index.ts`, scripts `test` (`vitest run`) and `typecheck` (`tsc --noEmit`). Run `pnpm add -F @hub/renderer @hub/protocol@workspace:* @hub/design-model@workspace:*`, then `pnpm add -F @hub/renderer --save-exact playwright@1.56.1 sharp@0.34.5`, then `pnpm add -D -F @hub/renderer @types/node@^22` plus `vitest` and `typescript` with design-model's specifiers. `tsconfig.json`: extends base, `"compilerOptions": { "types": ["node"] }`, `"include": ["src"]`. `vitest.config.ts`: `test: { include: ['src/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 }`.

- [ ] **Step 2: Write failing tests.**

`keys.test.ts`:
- `matches sha256 of the concatenation`: `tileKey('<p></p>', 'p{}', 'base', 0.25)` === `createHash('sha256').update('<p></p>p{}base0.25').digest('hex')`.
- `differs by device and zoom`: `tileKey('a','b','base',1)` ≠ `tileKey('a','b','tablet',1)` and ≠ `tileKey('a','b','base',0.5)`.
- `is 64 lowercase hex chars`: matches `/^[0-9a-f]{64}$/`.

`html.test.ts` with
`const CSS = ':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}\n@media (max-width: 1023px){[data-d-id="n1"]{padding:6px;}}\n@media (max-width: 599px){[data-d-id="n1"]{padding:4px;}}'`:
- `base drops both media blocks`: `cssForDevice(CSS,'base')` === `':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}'`.
- `tablet keeps only the tablet block`: === `':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}\n@media (max-width: 1023px){[data-d-id="n1"]{padding:6px;}}'`.
- `mobile keeps everything`: === `CSS`.
- `media-only css on base is empty`: `cssForDevice('@media (max-width: 599px){a{color:red;}}','base')` === `''`.
- `buildDocument sets width and wraps the body`: `buildDocument('<p>x</p>','p{}','tablet')` starts with `'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=834">'`, contains `BASE_CSS`, and ends with `'<style>p{}</style></head><body><p>x</p></body></html>'`.
- `escapes a closing style tag`: `out = buildDocument('', '--x{}</style><p>x</p>', 'base')` contains `'<\\/style><p>x</p>'` and `(out.match(/<\/style>/g) ?? []).length === 2`.

- [ ] **Step 3: Run** `pnpm -F @hub/renderer test`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `keys.ts` and `html.ts`. `index.ts`: `export * from './keys.js'; export * from './html.js';`
- [ ] **Step 5: Run** `pnpm -F @hub/renderer test && pnpm -F @hub/renderer typecheck`. Expected: 9 tests pass.
- [ ] **Step 6: Commit**

```bash
git add packages/renderer pnpm-lock.yaml
git commit -F - <<'EOF'
feat(renderer): scaffold, tile keys, per-device CSS, document builder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 3: Browser pool

**Files:**
- Create: `packages/renderer/src/pool.ts`
- Test: `packages/renderer/src/pool.test.ts`
- Modify: `packages/renderer/src/index.ts` (add `export * from './pool.js';`)

**Interfaces:**
- Produces:

```ts
import type { BrowserContextOptions, LaunchOptions, Page } from 'playwright';
export const CHROMIUM_ARGS: readonly string[] = ['--font-render-hinting=none', '--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars'];
export const CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, javaScriptEnabled: false,
  colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC',
};
export interface PoolOptions { size?: number /* default 2 */; launch?: LaunchOptions }
export interface PoolStats { launches: number; busy: number; idle: number; waiting: number }
export class BrowserPool {
  constructor(opts?: PoolOptions);
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
  stats(): PoolStats;
  close(): Promise<void>;
}
```

Behavior:
- The pool launches one Chromium lazily on the first `withPage`, with `chromium.launch({ args: [...CHROMIUM_ARGS], ...opts.launch })`. Concurrent first calls share one launch promise. `stats().launches` counts launches.
- A slot is one `BrowserContext` (`CONTEXT_OPTIONS`) with `await context.route('**/*', r => r.abort())` and one `Page` with `page.setDefaultTimeout(30_000)`. Idle slots are reused. At most `size` slots are busy at once, and further callers wait in FIFO order.
- If `fn` throws, close that slot's context (ignore errors), discard the slot, free its capacity, and rethrow the original error.
- On the browser's `'disconnected'` event, forget the browser and every idle slot. The next `withPage` relaunches.
- `close()` closes the browser. Later `withPage` calls reject with `new Error('BrowserPool is closed')`.

- [ ] **Step 1: Write failing tests** (`pool.test.ts`; each test makes its own pool and closes it):

```ts
test('runs at most size pages at once and launches once', async () => {
  const pool = new BrowserPool({ size: 2 });
  let busyMax = 0;
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => pool.withPage(async page => {
    busyMax = Math.max(busyMax, pool.stats().busy);
    await new Promise(r => setTimeout(r, 50));
    return page.evaluate('1 + 1');
  })));
  expect(results).toEqual([2, 2, 2, 2, 2]);
  expect(busyMax).toBe(2);
  expect(pool.stats().launches).toBe(1);
  await pool.close();
});
```

- `recovers after the browser disconnects`: `await pool.withPage(async p => { await p.context().browser()!.close(); })` (resolves or rejects; either is fine), then `await pool.withPage(p => p.evaluate('2 + 2'))` === `4` and `stats().launches === 2`.
- `a throwing job does not poison the pool`: `withPage(async () => { throw new Error('boom') })` rejects with `'boom'`. The next `withPage(p => p.evaluate('3'))` === `3`, and `stats().busy === 0`.
- `close rejects new work`: after `close()`, `withPage(...)` rejects with `'BrowserPool is closed'`.

- [ ] **Step 2: Run** `pnpm -F @hub/renderer exec vitest run src/pool.test.ts`. Expected: FAIL (cannot resolve `./pool.js`).
- [ ] **Step 3: Implement** `pool.ts` per the behavior list.
- [ ] **Step 4: Run** the same command. Expected: 4 tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/pool.ts packages/renderer/src/pool.test.ts packages/renderer/src/index.ts
git commit -F - <<'EOF'
feat(renderer): long-lived Chromium pool with crash recovery

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 4: Page capture and hit map

**Files:**
- Create: `packages/renderer/src/capture.ts`
- Test: `packages/renderer/src/capture.test.ts`
- Modify: `packages/renderer/src/index.ts` (add `export * from './capture.js';`)

**Interfaces:**
- Consumes: `buildDocument` (Task 2), `BrowserPool` (Task 3, tests only), `DEVICE_WIDTH`, `DEVICE_VIEWPORT_HEIGHT`, `MAX_PAGE_HEIGHT`, `HitBox`, `Device` from `@hub/protocol`.
- Produces:

```ts
export interface CaptureJob { html: string; css: string; device: Device }   // css is used as given
export interface Capture { png: Buffer; width: number; height: number; hitMap: HitBox[] }
export const HIT_MAP_SCRIPT: string;
export function capturePage(page: Page, job: CaptureJob): Promise<Capture>;
```

`HIT_MAP_SCRIPT` (exact; a string so no transpiler touches it):

```ts
export const HIT_MAP_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-d-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    let z = 0;
    for (let a = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') { z = parseInt(cs.zIndex, 10) || 0; break; }
    }
    const x = Math.floor(r.left + scrollX), y = Math.floor(r.top + scrollY);
    out.push({ nodeId: el.getAttribute('data-d-id'), x, y, w: Math.ceil(r.right + scrollX) - x, h: Math.ceil(r.bottom + scrollY) - y, z });
  }
  return out;
})()`;
```

`capturePage` steps, in order:
1. `page.setViewportSize({ width: DEVICE_WIDTH[d], height: DEVICE_VIEWPORT_HEIGHT[d] })`.
2. `page.setContent(buildDocument(job.html, job.css, d), { waitUntil: 'load' })`.
3. `page.evaluate('document.fonts.ready.then(() => true)')`.
4. `full = Number(await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'))`. Set `width = DEVICE_WIDTH[d]` and `height = Math.min(MAX_PAGE_HEIGHT, Math.max(DEVICE_VIEWPORT_HEIGHT[d], full))`.
5. `raw = await page.evaluate(HIT_MAP_SCRIPT)`. Stable-sort by `z` ascending (`Array.prototype.sort` is stable), so the result is DOM pre-order with z-indexed layers after. Strip `z`. Keep only boxes with `x < width && y < height && x + w > 0 && y + h > 0`.
6. `png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width, height }, animations: 'disabled', caret: 'hide' })`.

- [ ] **Step 1: Write failing tests.** Use one `BrowserPool({ size: 1 })` created in `beforeAll` and closed in `afterAll`, with the helper `const cap = (html: string, css: string, device: Device = 'base') => pool.withPage(p => capturePage(p, { html, css, device }))`:
  - `full height at device width`: `cap('<main data-d-id="a"></main>', '[data-d-id="a"]{height:2000px}')` → `width 1440`, `height 2000`, and `await sharp(png).metadata()` has width 1440 and height 2000.
  - `short page uses the device viewport height`: `cap('<main data-d-id="a"></main>', '[data-d-id="a"]{height:100px}', 'mobile')` → `{ width: 390, height: 844 }`.
  - `caps very tall pages`: html `'<main data-d-id="a"></main><div data-d-id="b">end</div>'`, css `'[data-d-id="a"]{height:20000px}'` → `height === 16000`, the PNG height is 16000, and `hitMap.map(b => b.nodeId)` does not contain `'b'`.
  - `boxes in page px`: html `'<main data-d-id="a"><div data-d-id="b"></div></main>'`, css `'[data-d-id="a"]{padding:10px}[data-d-id="b"]{width:100px;height:50px;margin-left:5px}'` → hitMap toContainEqual `{nodeId:'b',x:15,y:10,w:100,h:50}` and `{nodeId:'a',x:0,y:0,w:1440,h:70}`.
  - `z-indexed elements come last`: html `'<main data-d-id="a"><div data-d-id="b"></div><div data-d-id="c"></div></main>'`, css `'[data-d-id="a"]{position:relative}[data-d-id="b"]{position:absolute;z-index:5;top:0;left:0;width:50px;height:50px}[data-d-id="c"]{height:100px}'` → ids `['a','c','b']`.
  - `skips hidden and empty elements`: html `'<main data-d-id="a"><div data-d-id="h1"></div><div data-d-id="h2">x</div><div data-d-id="h3">y</div></main>'`, css `'[data-d-id="h2"]{display:none}[data-d-id="h3"]{visibility:hidden}'` → ids `['a']`.
  - `tablet media query applies at 834px`: html `'<div data-d-id="b"></div>'`, css `'[data-d-id="b"]{width:100px;height:10px}\n@media (max-width: 1023px){[data-d-id="b"]{width:200px;}}'` → box `b` has `w === 200` on `tablet` and `w === 100` on `base`.
  - `blocks network and scripts`: inside one `pool.withPage(async p => …)`, capture html `'<img data-d-id="i" src="https://example.invalid/x.png" width="10" height="10"><script>document.body.setAttribute("data-ran","1")</script>'` with css `''`. Then `await p.evaluate('document.body.getAttribute("data-ran")')` → `null`. The test finishes well within the timeout.
- [ ] **Step 2: Run** `pnpm -F @hub/renderer exec vitest run src/capture.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `capture.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/capture.ts packages/renderer/src/capture.test.ts packages/renderer/src/index.ts
git commit -F - <<'EOF'
feat(renderer): capture full-page PNG and hit map per device

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 5: Tile slicing (sharp → WebP)

**Files:**
- Create: `packages/renderer/src/tiles.ts`
- Test: `packages/renderer/src/tiles.test.ts`
- Modify: `packages/renderer/src/index.ts` (add `export * from './tiles.js';`)

**Interfaces:**
- Consumes: `ZOOMS`, `TILE_SIZE`, `tilePath`, `TileLevel`, `Zoom` from `@hub/protocol`.
- Produces:

```ts
export interface TileFile { key: string; x: number; y: number; path: string /* tilePath(key,x,y) */; data: Buffer }
export const WEBP_OPTIONS = { quality: 80, effort: 4 } as const;
export function sliceTiles(png: Buffer, width: number, height: number, keyFor: (zoom: Zoom) => string):
  Promise<{ levels: TileLevel[]; tiles: TileFile[] }>;
```

Algorithm (levels in `ZOOMS` order, tiles row-major within a level):

```
for zoom of ZOOMS:
  lw = ceil(width * zoom); lh = ceil(height * zoom); key = keyFor(zoom)
  img = zoom === 1 ? sharp(png) : sharp(png).resize(lw, lh, { kernel: 'lanczos3', fit: 'fill' })
  { data } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })     // RGBA, lw × lh
  cols = ceil(lw / 512); rows = ceil(lh / 512); levels.push({ zoom, key, cols, rows })
  for ty in 0..rows-1, tx in 0..cols-1:
    buf = Buffer.alloc(512 * 512 * 4)                // zero = transparent padding on edge tiles
    tw = min(512, lw - tx*512); th = min(512, lh - ty*512)
    for row in 0..th-1: copy `tw*4` bytes from data offset ((ty*512+row)*lw + tx*512)*4 into buf offset row*512*4
    webp = await sharp(buf, { raw: { width: 512, height: 512, channels: 4 } }).webp(WEBP_OPTIONS).toBuffer()
```

- [ ] **Step 1: Write failing tests.** Fixture: `png = await sharp({ create: { width: 1440, height: 1100, channels: 3, background: '#336699' } }).png().toBuffer()`, `keyFor = (z: Zoom) => 'k' + z`, `r = await sliceTiles(png, 1440, 1100, keyFor)`:
  - `levels for a 1440x1100 page`: `r.levels` toEqual `[{zoom:0.25,key:'k0.25',cols:1,rows:1},{zoom:0.5,key:'k0.5',cols:2,rows:2},{zoom:1,key:'k1',cols:3,rows:3}]` and `r.tiles.length === 14`.
  - `row-major order`: `r.tiles.filter(t => t.key === 'k1').map(t => `${t.x}_${t.y}`)` toEqual `['0_0','1_0','2_0','0_1','1_1','2_1','0_2','1_2','2_2']`.
  - `every tile is a 512x512 webp`: for each tile, `sharp(t.data).metadata()` has format `'webp'`, width 512, height 512.
  - `edge tiles are transparent outside the page`: for tile `k1` (2,0), decode with `sharp(t.data).ensureAlpha().raw().toBuffer()`. Alpha at (x 415, y 0) is 255 and alpha at (x 416, y 0) is 0, using the index `(y*512 + x)*4 + 3`.
  - `paths`: the `k1` (2,0) tile has `path === 'tiles/k1/2_0.webp'`.
  - `deterministic`: a second `sliceTiles` call gives tiles whose `data` buffers are each `Buffer.compare(...) === 0` to the first.
- [ ] **Step 2: Run** `pnpm -F @hub/renderer exec vitest run src/tiles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `tiles.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/tiles.ts packages/renderer/src/tiles.test.ts packages/renderer/src/index.ts
git commit -F - <<'EOF'
feat(renderer): slice page PNG into 512px WebP tiles at three zoom levels

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 6: Tile store (filesystem and memory)

**Files:**
- Create: `packages/renderer/src/store.ts`
- Test: `packages/renderer/src/store.test.ts`
- Modify: `packages/renderer/src/index.ts` (add `export * from './store.js';`)

**Interfaces:**
- Consumes: `TileFile` (Task 5), `HitBox`, `RenderManifest`, `tilePath`, `hitMapPath`, `MANIFEST_PATH` from `@hub/protocol`.
- Produces:

```ts
export interface TileStore {
  hasLevel(key: string): Promise<boolean>;                 // true when tile 0_0 of that level exists
  putTiles(tiles: readonly TileFile[]): Promise<void>;     // levels that already exist are left untouched
  putHitMap(hash: string, hitMap: readonly HitBox[]): Promise<void>;
  readManifest(): Promise<RenderManifest | null>;          // null when missing, unparsable, or version !== 1
  writeManifest(m: RenderManifest): Promise<void>;
}
export class FsTileStore implements TileStore { constructor(dir: string); readonly dir: string }
export class MemoryTileStore implements TileStore { readonly files: Map<string, Buffer> }  // keys are the relative paths FsTileStore writes
```

On-disk layout under `dir`: `tiles/<key>/<x>_<y>.webp`, `hitmaps/<hash>.json` (`JSON.stringify(hitMap)`), and `manifest.json` (`JSON.stringify(m) + '\n'`). Writes are atomic:
- A level is written into `tiles/<key>.tmp-<pid>-<n>/` (n is a per-process counter), then `rename`d to `tiles/<key>`. If the rename fails because the target exists (`EEXIST`, `ENOTEMPTY`, `EPERM`), remove the temp dir and continue.
- Hit maps and the manifest are written to `<file>.tmp-<pid>-<n>` and then renamed over the target.
- Directories are created with `mkdir({ recursive: true })`.

- [ ] **Step 1: Write failing tests** (each uses `dir = await mkdtemp(join(tmpdir(), 'tiles-'))`, with the helper `t = (key, x, y) => ({ key, x, y, path: tilePath(key, x, y), data: Buffer.from(`${key}${x}${y}`) })`):
  - `writes a level and reports it`: `putTiles([t('k1',0,0), t('k1',1,0)])`. Then `readFile(join(dir,'tiles/k1/1_0.webp'))` equals `Buffer.from('k110')`, `hasLevel('k1')` is true, `hasLevel('k2')` is false, and `readdir(join(dir,'tiles'))` toEqual `['k1']` (no temp dir left).
  - `an existing level is left untouched`: put `t('k1',0,0)`, then put `{ ...t('k1',0,0), data: Buffer.from('other') }`. The file still contains `'k100'`.
  - `hit map json`: `putHitMap('h', [{nodeId:'a',x:0,y:0,w:1,h:1}])`. Then `JSON.parse(readFile('hitmaps/h.json'))` toEqual the same array.
  - `manifest roundtrip`: write `{version:1,pages:[]}` and read it back as an equal value.
  - `missing manifest is null`. `corrupt manifest is null` (write `'nope'` to `manifest.json` first). `wrong version is null` (write `'{"version":2,"pages":[]}'`).
  - `memory store uses the same paths`: `MemoryTileStore` after `putTiles([t('k1',0,0)])` and `putHitMap('h', [])` has `files` keys `'tiles/k1/0_0.webp'` and `'hitmaps/h.json'`, and `hasLevel('k1')` is true.
- [ ] **Step 2: Run** `pnpm -F @hub/renderer exec vitest run src/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/store.ts packages/renderer/src/store.test.ts packages/renderer/src/index.ts
git commit -F - <<'EOF'
feat(renderer): atomic filesystem tile store and in-memory store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 7: Render jobs and incremental document render

**Files:**
- Create: `packages/renderer/src/render.ts`
- Test: `packages/renderer/src/render.test.ts`
- Modify: `packages/renderer/src/index.ts` (add `export * from './render.js';`)

**Interfaces:**
- Consumes: `tileKey` (Task 2), `cssForDevice` (Task 2), `BrowserPool` (Task 3), `capturePage` (Task 4), `sliceTiles`, `TileFile` (Task 5), `TileStore`, `MemoryTileStore` (Task 6); `exportPage`, `DesignDoc`, `applyOp`, `sampleDoc` from `@hub/design-model`; protocol types.
- Produces:

```ts
export interface RenderJob { pageId: string; device: Device; html: string; css: string }  // css already cssForDevice-reduced
export interface JobResult { render: PageRender; tiles: TileFile[]; hitMap: HitBox[] }
export function renderJob(pool: BrowserPool, job: RenderJob): Promise<JobResult>;
export interface RenderDocOptions { devices: readonly Device[]; prev: RenderManifest | null; store: TileStore; concurrency?: number /* default 2 */ }
export interface RenderDocResult { manifest: RenderManifest; rendered: string[]; reused: string[]; failed: string[] }  // entries `${pageId}@${device}`, each array sorted
export function renderDoc(pool: BrowserPool, doc: DesignDoc, opts: RenderDocOptions): Promise<RenderDocResult>;
```

`renderJob`: capture with `pool.withPage(p => capturePage(p, job))`, then `sliceTiles(png, width, height, z => tileKey(html, css, device, z))`. Return `render = { device, hash: tileKey(html, css, device, 1), width, height, levels }` (no `error` key).

`renderDoc`:
1. Order pages by `route` (code-point compare), with ties broken by page id. Process devices in `DEVICES` order, filtered to `opts.devices`.
2. For each page, call `exportPage(doc, pageId)` once. For each device, `prevRender = opts.prev`'s page with the same `pageId` → `renders[device]`.
   - If the export failed: mark `failed`. The render is `{ ...prevRender, error: exportError }` when `prevRender` exists, otherwise `{ device, hash: '', width: DEVICE_WIDTH[device], height: 0, levels: [], error: exportError }`.
   - Otherwise set `css = cssForDevice(value.css, device)` and `hash = tileKey(value.html, css, device, 1)`. If `prevRender?.hash === hash` and `store.hasLevel(l.key)` holds for every level of `prevRender`, mark it `reused`. The render is `prevRender` without its `error` key. Otherwise queue a `RenderJob`.
3. Run the queued jobs with at most `concurrency` in parallel. On success, `store.putTiles(tiles)` and `store.putHitMap(hash, hitMap)`, then mark `rendered`. If the job throws, mark `failed` with `error = err.message`, using the same fallback as in step 2.
4. Return `manifest = { version: 1, pages: [{ pageId, name, route, renders }] }` in page order. Never write to the store's manifest; the caller does that.

- [ ] **Step 1: Write failing tests.** Use one `BrowserPool({ size: 2 })` per file (`beforeAll`/`afterAll`), a new `MemoryTileStore` per test, `const all = ['base','tablet','mobile'] as const`, and the helper `must = (r) => { if (!r.ok) throw new Error(r.error); return r.value.doc; }`:
  - `renders every page and device the first time`: `renderDoc(pool, sampleDoc(), { devices: all, prev: null, store })` → `rendered` toEqual `['home@base','home@mobile','home@tablet']`. `manifest.pages[0]` has `pageId 'home'`, `name 'Home'` and `route '/'`. `renders.base` has `width 1440`, `height 900` and `levels.length === 3`. `store.files` has `tilePath(renders.base.levels[2].key, 0, 0)` and `hitMapPath(renders.base.hash)`.
  - `unchanged doc re-renders nothing`: run twice with `prev` set to the first manifest and the same store. The second run has `rendered` `[]` and `reused` of length 3.
  - `mobile-only edit re-renders only mobile`: `doc2 = must(applyOp(doc, {op:'setStyle',node:'n3',device:'mobile',prop:'padding',value:'4px'}))` → `rendered` `['home@mobile']`, `reused` `['home@base','home@tablet']`.
  - `component edit re-renders only pages that use it`: first add an About page with `must(applyOp(sampleDoc(), {op:'addPage', page:{id:'about',name:'About',route:'/about',root:{id:'n9',kind:'element',tag:'main',attrs:{},style:{base:{}},children:[]}}}))`. Render it, then apply `setStyle n7 base color #ff0000` and render with `prev` → `rendered` `['home@base','home@mobile','home@tablet']`, `reused` `['about@base','about@mobile','about@tablet']`.
  - `pages are ordered by route`: in the About doc, `manifest.pages.map(p => p.pageId)` toEqual `['home','about']`.
  - `failed export keeps the last good render with an error`: render `sampleDoc()`, then `broken = structuredClone(sampleDoc()); delete broken.components.Card` and render with `prev` → `failed` has 3 entries. `renders.base.levels` toEqual the previous levels, `renders.base.hash` equals the previous hash, and `renders.base.error` contains `'Component Card not found'`.
  - `failed export without a previous render gives an empty placeholder`: `broken` with `prev: null` → `renders.base` toEqual `{ device:'base', hash:'', width:1440, height:0, levels:[], error: expect.stringContaining('Component Card not found') }`.
  - `renderJob is deterministic`: with `e = exportPage(sampleDoc(),'home')` and `job = { pageId:'home', device:'mobile', html: e.value.html, css: cssForDevice(e.value.css,'mobile') }`, two `renderJob` calls give equal `render` and `hitMap`, and each tile's `data` compares equal.
- [ ] **Step 2: Run** `pnpm -F @hub/renderer exec vitest run src/render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `render.ts`. Final `index.ts` exports: `keys`, `html`, `pool`, `capture`, `tiles`, `store`, `render`.
- [ ] **Step 4: Run** `pnpm -F @hub/renderer test && pnpm -F @hub/renderer typecheck`. Expected: all renderer tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/render.ts packages/renderer/src/render.test.ts packages/renderer/src/index.ts
git commit -F - <<'EOF'
feat(renderer): incremental renderDoc keyed by content hash, last-good on failure

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 8: Client scaffold (Vite + Preact PWA, bundle-size check)

**Files:**
- Create: `apps/client/package.json`, `apps/client/tsconfig.json`, `apps/client/tsconfig.node.json`, `apps/client/vite.config.ts`, `apps/client/vitest.config.ts`, `apps/client/index.html`, `apps/client/.gitignore`
- Create: `apps/client/src/main.tsx`, `apps/client/public/manifest.webmanifest`, `apps/client/public/icon.svg`, `apps/client/public/sw.js`, `apps/client/scripts/check-size.mjs`
- Test: `apps/client/src/smoke.test.ts`

**Interfaces:**
- Produces: package `@hub/client` with scripts `dev` (`vite`), `build` (`vite build`), `preview` (`vite preview`), `test` (`vitest run`), `typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json`), and `size` (`node scripts/check-size.mjs dist 150000`).
- Produces: `node scripts/check-size.mjs <dir> <limitBytes>` sums `zlib.gzipSync(content, { level: 9 }).length` over every `.js` file under `<dir>` (recursive). It prints one line per file (`<bytes>\t<relative path>`) and then `JS gzip total: <N> bytes (limit <limit>)`. It exits with code 1 when `N >= limit` and 0 otherwise.

Details:
- Dependencies: `pnpm add -F @hub/client preact@^10.29.8 @hub/protocol@workspace:*`. Dev dependencies: `pnpm add -D -F @hub/client vite@^7.3.7 @preact/preset-vite@^2.10.6 @types/node@^22`, plus `vitest` and `typescript` with design-model's specifiers.
- `tsconfig.json`: extends base, with `"lib": ["ES2022","DOM","DOM.Iterable"]`, `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`, `"types": ["vite/client"]` and `"include": ["src"]`. `tsconfig.node.json`: extends base, with `"lib": ["ES2022","DOM"]`, `"types": ["node"]` and `"include": ["dev","e2e","vite.config.ts","vitest.config.ts","playwright.config.ts"]`.
- `vite.config.ts`: `defineConfig({ plugins: [preact()], build: { target: 'es2022' } })`.
- `vitest.config.ts` (from `vitest/config`): `test: { include: ['src/**/*.test.ts','dev/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000 }`.
- `index.html`:
  - Head: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<meta name="theme-color" content="#1a73e8">`, `<link rel="manifest" href="/manifest.webmanifest">`, `<link rel="icon" href="/icon.svg" type="image/svg+xml">`, `<title>Hub</title>`, and an inline `<style>html,body,#app{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;background:#e9e9ec;font-family:system-ui,sans-serif}</style>`.
  - Body: `<div id="app"></div><script type="module" src="/src/main.tsx"></script>`.
- `manifest.webmanifest`: `{"name":"Hub","short_name":"Hub","start_url":"/","display":"standalone","background_color":"#e9e9ec","theme_color":"#1a73e8","icons":[{"src":"/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"}]}`. `icon.svg` is any simple square icon.
- `sw.js`: `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));`. There is no fetch handler; plan 3 adds caching.
- `src/main.tsx` (placeholder; Task 22 replaces the render call): `render(<p>Hub</p>, document.getElementById('app')!)`, then `if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');`.
- `.gitignore`: `dist/`, `.dev-renders/`, `test-results/`, `playwright-report/`.

- [ ] **Step 1: Write the failing test** `src/smoke.test.ts`: `expect(DEVICE_WIDTH.mobile).toBe(390)` (imported from `@hub/protocol`).
- [ ] **Step 2: Run** `pnpm -F @hub/client test`. Expected: FAIL (package not set up).
- [ ] **Step 3: Create** the files listed above and run `pnpm install`.
- [ ] **Step 4: Verify.** `pnpm -F @hub/client test` passes 1 test. `pnpm -F @hub/client typecheck` reports no errors. `pnpm -F @hub/client build && pnpm -F @hub/client size` prints `JS gzip total: <N> bytes (limit 150000)` with N < 150000 and exits 0.
- [ ] **Step 5: Commit**

```bash
git add apps/client pnpm-lock.yaml
git commit -F - <<'EOF'
feat(client): Vite + Preact PWA scaffold with gzipped bundle budget check

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 9: Generated fixture pages

**Files:**
- Create: `apps/client/dev/generate.ts`
- Test: `apps/client/dev/generate.test.ts`

**Interfaces:**
- Consumes: from `@hub/design-model` (add as a dev dependency: `pnpm add -D -F @hub/client @hub/design-model@workspace:*`): `sampleDoc`, `applyOp`, `exportPage`, `allIds`, `canonicalStringify`, and the types `DesignDoc`, `Page`, `ElementNode`, `TextNode`, `InstanceNode`.
- Produces:

```ts
export function mulberry32(seed: number): () => number;   // standard mulberry32, returns [0, 1)
export function generateDoc(opts: { pages: number; seed: number }): DesignDoc;
```

Rules:
- Start from `sampleDoc()` (page `home`). Add pages `i = 2..opts.pages` with id `gen-${String(i).padStart(2,'0')}`, name `Generated ${String(i).padStart(2,'0')}` and route `/${id}`. The total page count equals `opts.pages`, and `pages: 1` returns only `home`.
- Use one `mulberry32(opts.seed)` stream consumed page by page in order, so the first pages are identical whatever `opts.pages` is. Text comes from a fixed array of ≥ 30 lowercase words declared in the file. Node ids are `n<k>`, allocated from a counter starting at `sampleDoc().meta.seq`. At the end, `meta.seq` is the next unused number.
- Page structure (`int(a,b)` is inclusive; every style value must pass plan 1's `validateStyle`):
  - Root `main`. Base `{display:'flex','flex-direction':'column',gap:'24px',padding:'32px','font-family':'system-ui, sans-serif'}`, mobile `{padding:'16px'}`.
  - `header`. Base `{display:'flex',gap:'16px','align-items':'center'}`. Children: a `strong` with 2 words, then `int(3,6)` `a` elements (`attrs {href:'#'}`, base `{color:'#1a73e8'}`, 1 word each).
  - `section` hero. Base `{display:'flex','flex-direction':'column',gap:'12px'}`. Children:
    - `h1` with `int(3,6)` words. Base `{'font-size':'40px',margin:'0'}`, mobile `{'font-size':'28px'}`.
    - `p` with `int(12,30)` words. Base `{margin:'0','line-height':'1.5'}`.
    - `button` with 2 words. Base `{padding:'12px 20px','border-radius':'8px'}`.
    - An instance of `Card` with `props {title: <3 words>}` and `style {base:{}}`.
  - `section` grid. Base `{display:'grid','grid-template-columns':'repeat(3, 1fr)',gap:'16px'}`, tablet `{'grid-template-columns':'repeat(2, 1fr)'}`, mobile `{'grid-template-columns':'1fr'}`. It holds `int(3,12)` cards. Each card is a `div` with base `{padding:'16px',border:'1px solid #dddddd','border-radius':'8px',background:<one of '#f1f3f4','#e8f0fe','#fce8e6','#e6f4ea','#fef7e0'>,'min-height':`${int(80,240)}px`}`. A card contains an `h3` (base `{margin:'0 0 8px 0'}`, `int(2,4)` words) and a `p` (base `{margin:'0'}`, `int(10,40)` words).
  - `footer`. Base `{'border-top':'1px solid #dddddd','padding-top':'16px'}`. It contains a `p` with base `{margin:'0',color:'#5f6368'}` and 6 words.

- [ ] **Step 1: Write failing tests:**
  - `sample home plus generated pages`: `Object.keys(generateDoc({pages:5,seed:1}).pages).sort()` toEqual `['gen-02','gen-03','gen-04','gen-05','home']`.
  - `pages: 1 is just home`: the keys equal `['home']`.
  - `deterministic per seed`: `canonicalStringify` of two `{pages:5,seed:1}` docs are equal, and `{pages:5,seed:2}` differs.
  - `prefix-stable`: `generateDoc({pages:3,seed:1}).pages['gen-02']` toEqual `generateDoc({pages:50,seed:1}).pages['gen-02']`.
  - `valid as addPage ops`: starting from `sampleDoc()`, applying `{op:'addPage', page}` for each generated page in id order with `applyOp` gives `ok: true` every time. This uses plan 1's validation of tags, styles and ids.
  - `every page exports`: `exportPage(doc, id).ok` for every page id of `generateDoc({pages:10,seed:1})`.
  - `ids unique and below meta.seq`: `new Set(allIds(doc)).size === allIds(doc).length`, and every `n<k>` id has `k < doc.meta.seq`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run dev/generate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `dev/generate.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/dev/generate.ts apps/client/dev/generate.test.ts apps/client/package.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(client): deterministic generated design pages for the dev harness

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 10: Dev render harness and static serving

**Files:**
- Create: `apps/client/dev/render-fixtures.ts`, `apps/client/dev/serve-renders.ts`
- Test: `apps/client/dev/render-fixtures.test.ts`, `apps/client/dev/serve-renders.test.ts`
- Modify: `apps/client/vite.config.ts`, `apps/client/package.json` (script `"dev:renders": "tsx dev/render-fixtures.ts"`; dev dependencies `@hub/renderer@workspace:*`, `tsx@^4`, `sirv@^3.0.2`)

**Interfaces:**
- Consumes: `generateDoc` (Task 9); `BrowserPool`, `FsTileStore`, `renderDoc` (Tasks 3, 6, 7); `DEVICES` from `@hub/protocol`.
- Produces:

```ts
// render-fixtures.ts
export interface FixtureOptions { pages: number; seed: number; out: string; poolSize?: number /* default 4 */ }
export interface FixtureSummary { pages: number; rendered: number; reused: number; failed: number }
export const DEFAULT_OUT: string;   // fileURLToPath(new URL('../.dev-renders', import.meta.url))
export function parseArgs(argv: readonly string[]): FixtureOptions;  // --pages (default 50) --seed (default 1) --out (default DEFAULT_OUT, resolved against process.cwd())
export function renderFixtures(opts: FixtureOptions): Promise<FixtureSummary>;
// serve-renders.ts
export const RENDERS_MOUNT = '/dev-renders';
export function serveRenders(dir: string): import('vite').Plugin;   // name 'hub-serve-renders'
```

`renderFixtures`: `doc = generateDoc(opts)`, `store = new FsTileStore(opts.out)`, `prev = await store.readManifest()`, `pool = new BrowserPool({ size: poolSize })`. Then `res = await renderDoc(pool, doc, { devices: DEVICES, prev, store, concurrency: poolSize })` and `await store.writeManifest(res.manifest)`. Close the pool in `finally`. Return the counts. CLI: when `import.meta.url === pathToFileURL(process.argv[1]!).href`, run with `parseArgs(process.argv.slice(2))`, print `JSON.stringify(summary)`, and exit 1 if `failed > 0`.

`serveRenders(dir)`: `configureServer(s)` and `configurePreviewServer(s)` both call `s.middlewares.use(RENDERS_MOUNT, (req, res, next) => handler(req, res, () => { res.statusCode = 404; res.end('Not found'); }))`, where `handler = sirv(dir, { dev: true })`. Missing files return 404 instead of falling through to Vite's index.html fallback. `vite.config.ts` adds `serveRenders(fileURLToPath(new URL('./.dev-renders', import.meta.url)))` to `plugins`.

- [ ] **Step 1: Write failing tests.**
  - `serve-renders.test.ts` `serves files under /dev-renders and 404s the rest`:
    - Write `manifest.json` (`'{"version":1,"pages":[]}'`) into a temp dir.
    - `server = await createServer({ configFile: false, root: dir, logLevel: 'silent', plugins: [serveRenders(dir)], server: { port: 0, host: '127.0.0.1' } })`, then `await server.listen()`. The port is `(server.httpServer!.address() as AddressInfo).port`.
    - `fetch('http://127.0.0.1:<port>/dev-renders/manifest.json')` returns status 200 with JSON `{version:1,pages:[]}`. `/dev-renders/nope.json` returns status 404. Finish with `server.close()`.
  - `render-fixtures.test.ts`:
    - `parseArgs defaults`: `parseArgs([])` toEqual `{ pages: 50, seed: 1, out: DEFAULT_OUT }`. `parseArgs(['--pages','3','--seed','7','--out','/tmp/x'])` toEqual `{ pages: 3, seed: 7, out: '/tmp/x' }`.
    - `renders then reuses` (real Chromium): the first `renderFixtures({ pages: 2, seed: 1, out: tmp, poolSize: 2 })` → `{ pages: 2, rendered: 6, reused: 0, failed: 0 }`. `JSON.parse(readFile(tmp/manifest.json)).pages.length === 2`. The second run → `{ pages: 2, rendered: 0, reused: 6, failed: 0 }`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run dev/serve-renders.test.ts dev/render-fixtures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files, wire `vite.config.ts`, and add the script and dependencies (`pnpm add -D -F @hub/client @hub/renderer@workspace:* tsx@^4 sirv@^3.0.2`).
- [ ] **Step 4: Verify.** The tests above pass (4 tests). `pnpm -F @hub/client dev:renders --pages 3` prints `{"pages":3,"rendered":9,"reused":0,"failed":0}`. Running it again prints `"rendered":0,"reused":9`. `pnpm -F @hub/client typecheck` is clean.
- [ ] **Step 5: Commit**

```bash
git add apps/client/dev apps/client/vite.config.ts apps/client/package.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(client): dev harness rendering generated pages, served at /dev-renders

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 11: Geometry and camera

**Files:**
- Create: `apps/client/src/canvas/geom.ts`
- Test: `apps/client/src/canvas/geom.test.ts`

**Interfaces:**
- Produces. All screen values are CSS px relative to the canvas top-left. A camera `{x, y}` is the world point at the screen origin, and `scale` is CSS px per world px.

```ts
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Camera { x: number; y: number; scale: number }
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 4;
export function clampScale(s: number): number;
export function worldToScreen(c: Camera, p: Point): Point;           // ((p.x-c.x)*s, (p.y-c.y)*s)
export function screenToWorld(c: Camera, p: Point): Point;
export function panBy(c: Camera, dx: number, dy: number): Camera;    // screen drag delta: x - dx/scale
export function zoomAt(c: Camera, p: Point, factor: number): Camera; // clamped scale; world point under p stays under p
export function viewRect(c: Camera, view: Size): Rect;               // visible world rect
export function snapCamera(c: Camera, dpr: number): Camera;          // x = round(x*scale*dpr)/(scale*dpr), same for y
export function fitRect(r: Rect, view: Size, padding: number): Camera;
// scale = clampScale(min((view.w-2p)/r.w, (view.h-2p)/r.h)); centered: x = r.x + r.w/2 - view.w/(2*scale), same for y
export function rectsIntersect(a: Rect, b: Rect): boolean;          // positive-area overlap only
export function intersectRect(a: Rect, b: Rect): Rect | null;
export function normalizeRect(a: Point, b: Point): Rect;
export function expandRect(r: Rect, fraction: number): Rect;        // grows each side by fraction*w (x) and fraction*h (y)
export function worldToDevice(r: Rect, c: Camera, dpr: number): Rect;
// s = c.scale*dpr; x0 = round((r.x-c.x)*s), x1 = round((r.x+r.w-c.x)*s) → {x:x0, w:x1-x0}; same for y
```

- [ ] **Step 1: Write failing tests:**
  - `screen/world roundtrip`: `c = {x:10,y:20,scale:2}`, so `screenToWorld(c, worldToScreen(c, {x:5,y:7}))` equals `{x:5,y:7}`, and `worldToScreen(c,{x:15,y:20})` equals `{x:10,y:0}`.
  - `panBy`: `panBy({x:100,y:50,scale:2}, 10, -4)` toEqual `{x:95,y:52,scale:2}`.
  - `zoomAt keeps the anchor`: `zoomAt({x:0,y:0,scale:1}, {x:100,y:100}, 2)` toEqual `{x:50,y:50,scale:2}`.
  - `zoomAt clamps`: factor 1000 → scale 4; factor 0.00001 → scale 0.02.
  - `viewRect`: `viewRect({x:10,y:20,scale:0.5}, {w:800,h:600})` toEqual `{x:10,y:20,w:1600,h:1200}`.
  - `snapCamera`: `snapCamera({x:10.3,y:0,scale:1}, 2)` toEqual `{x:10.5,y:0,scale:1}`.
  - `fitRect`: `fitRect({x:0,y:0,w:1000,h:500}, {w:1100,h:600}, 50)` toEqual `{x:-50,y:-50,scale:1}`.
  - `rectsIntersect`: touching edges (`{0,0,10,10}` and `{10,0,5,5}`) → false; overlapping → true.
  - `intersectRect`: `{0,0,10,10}` ∩ `{5,5,10,10}` = `{x:5,y:5,w:5,h:5}`; disjoint → `null`.
  - `normalizeRect`: `({x:10,y:5},{x:2,y:9})` → `{x:2,y:5,w:8,h:4}`.
  - `expandRect`: `({x:0,y:0,w:100,h:40}, 0.25)` → `{x:-25,y:-10,w:150,h:60}`.
  - `worldToDevice rounds edges`: `worldToDevice({x:1,y:1,w:3,h:3}, {x:0,y:0,scale:0.5}, 1)` toEqual `{x:1,y:1,w:1,h:1}` (`round(0.5)=1`, `round(2)=2`).
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/geom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `geom.ts`.
- [ ] **Step 4: Run** the same command. Expected: 12 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/geom.ts apps/client/src/canvas/geom.test.ts
git commit -F - <<'EOF'
feat(client): camera and rect geometry for the infinite canvas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 12: Device frame layout

**Files:**
- Create: `apps/client/src/canvas/layout.ts`
- Test: `apps/client/src/canvas/layout.test.ts`

**Interfaces:**
- Consumes: `Point`, `Rect` (Task 11); `RenderManifest`, `PageRender`, `Device`, `DEVICES`, `DEVICE_WIDTH`, `DEVICE_VIEWPORT_HEIGHT` from `@hub/protocol`.
- Produces:

```ts
export interface Frame { pageId: string; name: string; device: Device; x: number; y: number; w: number; h: number; render: PageRender | null }
export const FRAME_GAP = 80;   // world px between frames in a row
export const ROW_GAP = 200;    // world px between rows
export function layoutFrames(m: RenderManifest, visible: ReadonlySet<Device>): Frame[];
export function frameAt(frames: readonly Frame[], p: Point): Frame | null;  // x <= p.x < x+w and y <= p.y < y+h
export function layoutBounds(frames: readonly Frame[]): Rect;              // union; {0,0,0,0} when empty
```

Layout rules: one row per manifest page, in manifest order. Within a row, the visible devices appear in `DEVICES` order, starting at `x = 0` and advancing by `w + FRAME_GAP`. `w = DEVICE_WIDTH[device]`. `h = render && render.height > 0 ? render.height : DEVICE_VIEWPORT_HEIGHT[device]`. `render` is `page.renders[device] ?? null`. Row height is the max frame `h`, and the next row starts at `y + rowHeight + ROW_GAP`. When no device is visible, the result is `[]`.

- [ ] **Step 1: Write failing tests.** Use a fixture manifest with page `p1` (renders base height 2000, tablet 2400, mobile 3000) and page `p2` (base height 1000 only). A `render(device, height)` helper builds a `PageRender` with hash `'h'`, `width: DEVICE_WIDTH[device]` and `levels: []`.
  - `a row per page, devices side by side`: with all devices visible, `frames.map(f => [f.pageId, f.device, f.x, f.y, f.w, f.h])` toEqual `[['p1','base',0,0,1440,2000],['p1','tablet',1520,0,834,2400],['p1','mobile',2434,0,390,3000],['p2','base',0,3200,1440,1000],['p2','tablet',1520,3200,834,1194],['p2','mobile',2434,3200,390,844]]`. The `p2` tablet frame has `render === null`.
  - `hidden devices collapse`: visible `{base, mobile}` → the `p1` mobile frame has `x === 1520`, and there are 4 frames.
  - `no visible device`: `layoutFrames(m, new Set())` toEqual `[]`.
  - `frameAt`: `{x:1520,y:10}` → the `p1` tablet frame; `{x:1500,y:10}` (gap) → `null`.
  - `layoutBounds`: for all frames → `{x:0,y:0,w:2824,h:4394}` (the second row starts at 3200, and its tallest frame is the 1194 px tablet placeholder).
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/layout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `layout.ts`.
- [ ] **Step 4: Run** the same command. Expected: 5 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/layout.ts apps/client/src/canvas/layout.test.ts
git commit -F - <<'EOF'
feat(client): lay out page frames per device with toggles

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 13: Tile math — LOD, culling, fallback

**Files:**
- Create: `apps/client/src/canvas/tiles.ts`
- Test: `apps/client/src/canvas/tiles.test.ts`

**Interfaces:**
- Consumes: `Rect`, `rectsIntersect` (Task 11); `Frame` (Task 12); `Zoom`, `ZOOMS`, `TILE_SIZE`, `TileLevel` from `@hub/protocol`.
- Produces:

```ts
export function pickZoom(scale: number, dpr: number): Zoom;   // smallest z in ZOOMS with z >= scale*dpr, else 1
export interface TileRef { key: string; x: number; y: number; zoom: Zoom; world: Rect }
export function levelOf(frame: Frame, zoom: Zoom): TileLevel | undefined;
export function frameTiles(frame: Frame, zoom: Zoom, area: Rect): TileRef[];
export function visibleTiles(frames: readonly Frame[], area: Rect, zoom: Zoom): TileRef[];
export interface Fallback { ref: TileRef; sx: number; sy: number; sw: number; sh: number }
export function fallbackFor(frame: Frame, ref: TileRef, zoom: Zoom): Fallback | null;
```

`frameTiles`: with `level = levelOf(frame, zoom)`, return `[]` when it is missing. Set `size = TILE_SIZE / zoom`, `x0 = max(0, floor((area.x - frame.x) / size))` and `x1 = min(cols - 1, ceil((area.x + area.w - frame.x) / size) - 1)`, and the same for y with rows. Return `[]` when `x0 > x1` or `y0 > y1`. Otherwise loop rows, then columns, with `world = { x: frame.x + tx*size, y: frame.y + ty*size, w: size, h: size }`. `visibleTiles` concatenates `frameTiles` for the frames whose rect `rectsIntersect` the area, in frame order. `fallbackFor` (coarser level only) returns `null` when `zoom >= ref.zoom` or the level is missing. Otherwise `r = zoom / ref.zoom`, `tx = floor(ref.x*r)`, `ty = floor(ref.y*r)`; it returns `null` if `tx >= cols` or `ty >= rows`. Then `sx = ref.x*TILE_SIZE*r - tx*TILE_SIZE`, `sy` is the same in y, `sw = sh = TILE_SIZE*r`, and `ref` is the coarse tile's `TileRef`.

- [ ] **Step 1: Write failing tests.** Fixture frame `F`: base at `(0,0,1440,3000)` with levels `0.25 'q' 1×2`, `0.5 'k' 2×3` and `1 'h' 3×6`.
  - `pickZoom`: `(0.1,1)→0.25`, `(0.25,1)→0.25`, `(0.3,1)→0.5`, `(0.2,2)→0.5`, `(0.3,2)→1`, `(0.6,1)→1`, `(3,1)→1`.
  - `tiles in a small area`: `frameTiles(F, 0.5, {x:0,y:0,w:1000,h:1000})` maps to `[['k',0,0]]` as `[key,x,y]`.
  - `area straddling a tile edge`: `{x:1020,y:0,w:10,h:10}` → `[['k',0,0],['k',1,0]]`.
  - `edge exactly on a boundary is exclusive`: `{x:0,y:0,w:1024,h:10}` → `[['k',0,0]]`.
  - `clamped to the level grid`: `frameTiles(F, 0.5, {x:-1e6,y:-1e6,w:2e6,h:2e6})` → 6 tiles, the last with `world` `{x:1024,y:2048,w:1024,h:1024}`.
  - `no level, no tiles`: a frame with `render: null` → `[]`.
  - `visibleTiles skips frames outside the area`: `F` plus a frame at `x:5000` → only `F`'s tiles.
  - `fallback to a coarser level`: `ref = {key:'h',x:2,y:5,zoom:1,world:{x:1024,y:2560,w:512,h:512}}`. `fallbackFor(F, ref, 0.25)` `toMatchObject({ ref: {key:'q', x:0, y:1, zoom:0.25}, sx:256, sy:128, sw:128, sh:128 })`, and `fallbackFor(F, ref, 1)` → `null`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/tiles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `tiles.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/tiles.ts apps/client/src/canvas/tiles.test.ts
git commit -F - <<'EOF'
feat(client): zoom-level selection, tile culling, coarse fallback

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 14: Hit testing and box select

**Files:**
- Create: `apps/client/src/canvas/hit.ts`
- Test: `apps/client/src/canvas/hit.test.ts`

**Interfaces:**
- Consumes: `Point`, `Rect` (Task 11); `Frame` (Task 12); `HitBox` from `@hub/protocol`.
- Produces:

```ts
export function hitTest(map: readonly HitBox[], p: Point): string | null;
// page px; scans from the END (topmost paint first); contains = x <= p.x < x+w && y <= p.y < y+h
export function boxSelect(map: readonly HitBox[], r: Rect): string[];
// boxes fully inside r (x >= r.x, y >= r.y, x+w <= r.x+r.w, y+h <= r.y+r.h), then drop any box contained (<=) in
// another kept box with a smaller index; result in hit map order
export function toPagePoint(f: Frame, world: Point): Point;   // {x: world.x - f.x, y: world.y - f.y}
```

- [ ] **Step 1: Write failing tests.** `MAP = [{nodeId:'n1',x:0,y:0,w:1440,h:2000},{nodeId:'n2',x:0,y:0,w:1440,h:80},{nodeId:'n3',x:20,y:20,w:100,h:40},{nodeId:'n5',x:0,y:100,w:400,h:300},{nodeId:'ov',x:10,y:10,w:50,h:50}]`:
  - `topmost wins`: `hitTest(MAP,{x:30,y:30})` → `'ov'`; `{x:100,y:30}` → `'n3'`; `{x:500,y:50}` → `'n2'`; `{x:500,y:1000}` → `'n1'`.
  - `right edge is exclusive`: `{x:120,y:30}` → `'n2'`.
  - `outside everything`: `{x:2000,y:10}` → `null`.
  - `box select fully contained`: `boxSelect(MAP,{x:0,y:90,w:500,h:400})` → `['n5']`; `{x:0,y:0,w:200,h:70}` → `['n3','ov']`.
  - `keeps outermost`: `boxSelect([{nodeId:'a',x:0,y:0,w:100,h:100},{nodeId:'b',x:10,y:10,w:20,h:20}], {x:0,y:0,w:200,h:200})` → `['a']`.
  - `equal boxes keep the first`: two boxes `a` and `b` with the same box → `['a']`.
  - `toPagePoint`: a frame at `(1520, 3200)` and world `{x:1530,y:3210}` → `{x:10,y:10}`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/hit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `hit.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/hit.ts apps/client/src/canvas/hit.test.ts
git commit -F - <<'EOF'
feat(client): hit testing and box selection from hit maps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 15: IndexedDB blob cache

**Files:**
- Create: `apps/client/src/canvas/cache.ts`
- Test: `apps/client/src/canvas/cache.test.ts`
- Modify: `apps/client/package.json` (`pnpm add -F @hub/client idb-keyval@^6.3.0` and `pnpm add -D -F @hub/client fake-indexeddb@^6.2.5`)

**Interfaces:**
- Consumes: `RenderManifest` from `@hub/protocol`; `createStore`, `get`, `set`, `keys`, `delMany` from `idb-keyval`.
- Produces:

```ts
export interface BlobCache {
  get(id: string): Promise<Blob | undefined>;
  put(id: string, blob: Blob): Promise<void>;
  gc(live: ReadonlySet<string>): Promise<number>;   // deletes ids whose hashOfId is not live; returns the count deleted
}
export function createIdbCache(dbName?: string /* default 'hub-tiles' */): BlobCache;  // idb-keyval store (dbName, 'blobs')
export function createNullCache(): BlobCache;        // get → undefined, put → no-op, gc → 0
export function hashOfId(id: string): string;        // 'hitmap/<h>' → '<h>'; '<key>/<x>_<y>' → '<key>'
export function liveKeys(m: RenderManifest): Set<string>;  // every level key of every render
```

Ids are `tileId(key,x,y)` for tiles and `` `hitmap/${hash}` `` for hit maps. `createIdbCache` returns `createNullCache()` when `typeof indexedDB === 'undefined'` or `createStore` throws. Every `get`/`put`/`gc` catches errors (quota, private mode) and returns `undefined`/nothing/`0`, because the cache is only an optimization.

- [ ] **Step 1: Write failing tests** (`import 'fake-indexeddb/auto'` first; each test uses a unique `dbName`):
  - `put then get`: `put('k/0_0', new Blob(['abc']))`, then `(await get('k/0_0'))!.text()` === `'abc'`.
  - `missing is undefined`.
  - `gc removes entries that are not live`: put `'a/0_0'`, `'b/0_0'`, `'hitmap/a'`, `'hitmap/c'`. Then `gc(new Set(['a']))` === `2`. `'a/0_0'` and `'hitmap/a'` remain; `'b/0_0'` and `'hitmap/c'` are gone.
  - `no IndexedDB falls back to a null cache`: `vi.stubGlobal('indexedDB', undefined)`, then `c = createIdbCache('x')`, `await c.put('a/0_0', new Blob(['x']))` resolves, and `await c.get('a/0_0')` is `undefined`. Finish with `vi.unstubAllGlobals()`.
  - `hashOfId`: `'abc/1_2'` → `'abc'`; `'hitmap/abc'` → `'abc'`.
  - `liveKeys`: a manifest with one render whose levels have keys `q`, `k` and `h` → `new Set(['q','k','h'])`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/cache.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `cache.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/cache.ts apps/client/src/canvas/cache.test.ts apps/client/package.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(client): IndexedDB blob cache keyed by content hash with gc

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 16: TileSource and hit map store

**Files:**
- Create: `apps/client/src/canvas/source.ts`, `apps/client/src/canvas/hitmaps.ts`
- Test: `apps/client/src/canvas/source.test.ts`, `apps/client/src/canvas/hitmaps.test.ts`

**Interfaces:**
- Consumes: `BlobCache` (Task 15); `RenderManifest`, `HitBox`, `MANIFEST_PATH`, `tilePath`, `hitMapPath` from `@hub/protocol`.
- Produces:

```ts
// source.ts — the seam plan 3 replaces with a server-backed implementation
export interface TileSource {
  manifest(): Promise<RenderManifest>;
  tile(key: string, x: number, y: number): Promise<Blob>;
  hitMap(hash: string): Promise<HitBox[]>;
  subscribe(onManifest: (m: RenderManifest) => void): () => void;   // live updates (render.ready); returns unsubscribe
}
export class StaticTileSource implements TileSource {
  constructor(baseUrl: string, fetchFn?: (url: string) => Promise<Response>);   // default: url => fetch(url)
}
// hitmaps.ts
export class HitMapStore {
  constructor(source: Pick<TileSource, 'hitMap'>, cache: BlobCache, max?: number /* default 64 */);
  get(hash: string): readonly HitBox[] | undefined;   // memory only
  load(hash: string): Promise<readonly HitBox[]>;     // memory → cache 'hitmap/<hash>' (JSON blob) → source (then cache.put)
}
```

`StaticTileSource` strips trailing `/` from `baseUrl` and fetches `${base}/${MANIFEST_PATH}`, `${base}/${tilePath(...)}` and `${base}/${hitMapPath(hash)}`. A non-OK response throws `` new Error(`HTTP ${res.status} for ${url}`) ``. `subscribe` never calls back and returns a no-op. `HitMapStore` keeps an LRU of at most `max` maps, and concurrent `load`s of the same hash share one promise. A cache write stores `new Blob([JSON.stringify(map)], { type: 'application/json' })`.

- [ ] **Step 1: Write failing tests.**
  - `source.test.ts` uses a fake fetch that records URLs and returns `new Response(body, { status })`:
    - `manifest`: `new StaticTileSource('/dev-renders/', f).manifest()` fetches `'/dev-renders/manifest.json'` and returns the parsed object.
    - `tile`: `tile('k',1,2)` fetches `'/dev-renders/tiles/k/1_2.webp'` and resolves to a `Blob`.
    - `hitMap`: fetches `'/dev-renders/hitmaps/h.json'`.
    - `http error`: a 404 → rejects with `'HTTP 404 for /dev-renders/tiles/k/0_0.webp'`.
    - `subscribe is inert`: returns a function, and the callback is never called.
  - `hitmaps.test.ts` uses `createNullCache()` or a Map-backed fake `BlobCache`:
    - `loads from source and caches`: after `load('h')`, `get('h')` toEqual the map and the cache has `'hitmap/h'`.
    - `uses the cache before the source`: the cache holds the JSON → `source.hitMap` is not called.
    - `dedupes concurrent loads`: `Promise.all([load('h'), load('h')])` → `source.hitMap` is called once.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/source.test.ts src/canvas/hitmaps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 8 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/source.ts apps/client/src/canvas/source.test.ts apps/client/src/canvas/hitmaps.ts apps/client/src/canvas/hitmaps.test.ts
git commit -F - <<'EOF'
feat(client): TileSource interface, static source, hit map store

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 17: Tile loader

**Files:**
- Create: `apps/client/src/canvas/loader.ts`
- Test: `apps/client/src/canvas/loader.test.ts`

**Interfaces:**
- Consumes: `TileSource` (Task 16), `BlobCache` (Task 15), `tileId` from `@hub/protocol`.
- Produces:

```ts
export interface TileImage { readonly width: number; readonly height: number; close(): void }   // ImageBitmap satisfies it
export interface TileWant { key: string; x: number; y: number }
export interface LoaderStats { images: number; inFlight: number; queued: number; failed: number }
export interface LoaderOptions {
  source: Pick<TileSource, 'tile'>;
  cache: BlobCache;
  onLoad: (key: string, x: number, y: number) => void;
  decode?: (blob: Blob) => Promise<TileImage>;   // default: b => createImageBitmap(b)
  maxImages?: number;     // default 128
  maxInFlight?: number;   // default 6
  retryAfterMs?: number;  // default 5000
  now?: () => number;     // default Date.now
}
export class TileLoader {
  constructor(opts: LoaderOptions);
  get(key: string, x: number, y: number): TileImage | undefined;   // memory hit; marks it most recently used
  request(wants: readonly TileWant[]): void;  // replaces the queue (priority = order); skips duplicates, loaded, in-flight, recently failed
  whenIdle(): Promise<void>;                  // resolves when the queue is empty and nothing is in flight
  stats(): LoaderStats;
}
```

Load pipeline for one id: `blob = (await cache.get(id)) ?? await source.tile(key, x, y)`. When the blob came from the source, run `cache.put(id, blob)` and `decode(blob)` in parallel and wait for both. Otherwise just decode. Insert the image as most recently used. If `images > maxImages`, evict the least recently used entries and call `close()` on each. Then call `onLoad(key, x, y)`. Any error records `failed[id] = now()`; the id is skipped until `retryAfterMs` has passed. After each load, start the next queued want, up to `maxInFlight`.

- [ ] **Step 1: Write failing tests.** Fakes: `source.tile` returns `new Blob([tileId(k,x,y)])` (or a controllable deferred promise), a Map-backed cache, and `decode = async b => ({ id: await b.text(), width: 512, height: 512, close: vi.fn() })`. Flush with `await loader.whenIdle()`.
  - `loads from source, stores in cache, then serves from memory`: `request([{key:'k',x:0,y:0}])`, then `whenIdle()` → `onLoad` was called with `('k',0,0)`, `get('k',0,0)` has `id 'k/0_0'`, and the cache has `'k/0_0'`.
  - `uses the cache before the source`: the cache is pre-filled → `source.tile` is not called.
  - `limits in-flight requests`: with `maxInFlight: 2` and deferred sources, `request` 5 wants → `source.tile` is called 2 times. Resolving one starts the third.
  - `request replaces the queue`: with `maxInFlight: 1` and a deferred source, `request([a,b,c,d])` and then `request([d])`. After resolving `a`, the next source call is for `d`, and `b` and `c` are never requested.
  - `evicts the least recently used image and closes it`: with `maxImages: 2`, load `a` and `b`, call `get(a)`, then load `c` → `get(b)` is `undefined`, `b.close` was called once, and `get(a)` is defined.
  - `failed tile is not retried until retryAfterMs`: the source rejects. A second `request` at `now + 1000` makes no new source call; at `now + 6000` it calls the source again. `stats().failed === 1` after the first failure.
  - `request dedupes`: `request([a, a, a])` → the source is called once.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/loader.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `loader.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/loader.ts apps/client/src/canvas/loader.test.ts
git commit -F - <<'EOF'
feat(client): tile loader with bounded decoded-image LRU and IndexedDB first

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 18: Gestures

**Files:**
- Create: `apps/client/src/canvas/gestures.ts`
- Test: `apps/client/src/canvas/gestures.test.ts`

**Interfaces:**
- Produces:

```ts
export type Tool = 'pan' | 'select';
export const TAP_SLOP = 8;   // CSS px
export interface PointerIn { id: number; kind: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; pointerType: 'mouse' | 'touch' | 'pen'; button: number }
export interface WheelIn { x: number; y: number; deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }
export type GestureAction =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; x: number; y: number; factor: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'marquee'; phase: 'move' | 'end' | 'cancel'; x0: number; y0: number; x1: number; y1: number };
export class GestureTracker {
  constructor(getTool: () => Tool);
  handle(ev: PointerIn): GestureAction[];
}
export function wheelAction(ev: WheelIn): GestureAction;
```

Rules:
- **First pointer down:** record `start` and `last`. The mode is `pending`, and the drag kind is fixed now: `marquee` when `button === 0 && (tool === 'select' || pointerType === 'pen')`, otherwise `pan`.
- **Move while `pending`:** while `Math.hypot(pos - start) <= TAP_SLOP`, emit nothing. Past the slop, switch to the drag kind and emit `pan {dx: pos.x - start.x, dy: pos.y - start.y}` or `marquee move {start → pos}`.
- **Move while dragging:** `pan` emits the delta from the last position. `marquee` emits `move` from `start` to `pos`.
- **Up:**
  - `pending` emits `tap` at `start`, only if the down `button === 0`; otherwise nothing.
  - `marquee` emits `end` from `start` to the up position.
  - `pan` emits nothing.
  - In every case, return to idle.
- **Second pointer down** when both pointers are `touch`:
  - Emit `marquee cancel` (start → last) if a marquee was active.
  - Switch to `pinch` with centroid `c` and distance `d` of the two pointers.
  - In `pinch`, each move of either pointer emits `pan {c.x - prev.cx, c.y - prev.cy}`, then `zoom {x: c.x, y: c.y, factor: d / prev.d}`. Skip the zoom when either distance is 0.
  - Lifting one of the two pointers switches to `pan` mode with the remaining pointer as `last`, emitting nothing.
- **Other pointers** (a third pointer, or a second pointer that is not touch) are ignored.
- **`cancel`:** emits `marquee cancel` when a marquee is active, then behaves like `up` without any tap or end.
- **`wheelAction`:** multiplier `m = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1`. With `ctrlKey || metaKey` → `zoom {x, y, factor: Math.exp(-deltaY * m * 0.01)}`; otherwise `pan {dx: -deltaX * m, dy: -deltaY * m}`.

- [ ] **Step 1: Write failing tests.** Helper: `P = (id, kind, x, y, pointerType = 'touch', button = 0): PointerIn`. Variable `tool` with `t = new GestureTracker(() => tool)`.
  - `tap`: `down(1,100,100)` → `[]`, then `up(1,103,102)` → `[{type:'tap',x:100,y:100}]`.
  - `small moves stay a tap`: `down(1,0,0)`, `move(1,5,5)` → `[]`, `up(1,5,5)` → `[{type:'tap',x:0,y:0}]`.
  - `pan drag`: `down(1,100,100)`, `move(1,120,100)` → `[{type:'pan',dx:20,dy:0}]`, `move(1,125,90)` → `[{type:'pan',dx:5,dy:-10}]`, `up` → `[]`.
  - `select tool marquee`: with tool `'select'`, `down(1,10,10)`, `move(1,50,60)` → `[{type:'marquee',phase:'move',x0:10,y0:10,x1:50,y1:60}]`, and `up(1,50,60)` → `[{type:'marquee',phase:'end',x0:10,y0:10,x1:50,y1:60}]`.
  - `pen marquees in pan tool`: with tool `'pan'` and pointerType `'pen'` → the drag emits a marquee `move`.
  - `middle mouse pans in select tool`: `down(1,0,0,'mouse',1)`, `move(1,20,0,'mouse',1)` → `[{type:'pan',dx:20,dy:0}]`.
  - `middle click is not a tap`: `down(1,0,0,'mouse',1)`, `up(1,0,0,'mouse',1)` → `[]`.
  - `pinch zoom`: `down(1,100,100)`, `down(2,200,100)` → `[]`, then `move(2,300,100)` → `[{type:'pan',dx:50,dy:0},{type:'zoom',x:200,y:100,factor:2}]`.
  - `second finger cancels a marquee`: with tool `'select'`, `down(1,0,0)`, `move(1,40,40)`, then `down(2,100,100)` → `[{type:'marquee',phase:'cancel',x0:0,y0:0,x1:40,y1:40}]`.
  - `lifting one finger continues as pan`: `down 1 (100,100)`, `down 2 (200,100)`, `up(2,200,100)` → `[]`; then `move(1,110,100)` → `[{type:'pan',dx:10,dy:0}]` and `up(1,110,100)` → `[]`.
  - `wheel`: `wheelAction({x:5,y:6,deltaX:0,deltaY:100,deltaMode:0,ctrlKey:true,metaKey:false})` is a zoom at (5,6) whose factor `toBeCloseTo(Math.exp(-1))`. `{deltaX:5,deltaY:30,deltaMode:0,ctrlKey:false,…}` → `{type:'pan',dx:-5,dy:-30}`. `deltaMode:1, deltaY:3` → `dy: -48`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/gestures.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `gestures.ts`.
- [ ] **Step 4: Run** the same command. Expected: 11 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/gestures.ts apps/client/src/canvas/gestures.test.ts
git commit -F - <<'EOF'
feat(client): pointer and wheel gestures (pan, pinch, tap, marquee)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 19: Base painter (blit-on-pan, dirty rects)

**Files:**
- Create: `apps/client/src/canvas/painter.ts`, `apps/client/src/canvas/test-utils.ts`
- Test: `apps/client/src/canvas/painter.test.ts`

**Interfaces:**
- Consumes: `Camera`, `Rect`, `Size`, `snapCamera`, `worldToDevice`, `rectsIntersect` (Task 11); `Frame` (Task 12); `frameTiles`, `fallbackFor` (Task 13); `TileImage` (Task 17); `Zoom`, `ZOOMS`, `DEVICE_LABEL` from `@hub/protocol`.
- Produces:

```ts
export interface PaintInput { camera: Camera; viewport: Size; dpr: number; frames: readonly Frame[]; zoom: Zoom; smoothing: boolean }
export interface PaintStats { mode: 'full' | 'partial' | 'none'; blit: boolean; regions: number; tilesDrawn: number; missing: number }
export interface TileGetter { get(key: string, x: number, y: number): TileImage | undefined }
export const COLORS = { bg: '#e9e9ec', frame: '#ffffff', label: '#5f6368', badge: '#d93025' } as const;
export const LABEL_MIN_SCALE = 0.04;
export class BasePainter {
  constructor(ctx: CanvasRenderingContext2D, tiles: TileGetter);
  invalidate(): void;                 // next paint is full
  invalidateWorld(r: Rect): void;     // repaint this world rect on the next paint
  paint(input: PaintInput): PaintStats;
}
// test-utils.ts
export interface Call { m: string; a: unknown[]; fill: string; stroke: string; lw: number; smooth: boolean }
export function fakeCtx(width?: number /* 800 */, height?: number /* 600 */): { ctx: CanvasRenderingContext2D; calls: Call[] };
export function img(id: string): TileImage & { id: string };   // {id, width: 512, height: 512, close() {}}
```

`fakeCtx` is a plain object with `canvas: {width, height}`, the style fields `fillStyle`, `strokeStyle`, `lineWidth`, `font`, `textBaseline` and `imageSmoothingEnabled`, and the methods `save restore setTransform beginPath rect clip fillRect strokeRect clearRect fillText drawImage`. Each method pushes `{ m, a: args, fill, stroke, lw, smooth }`, capturing the current style fields. It is cast `as unknown as CanvasRenderingContext2D`.

`paint` algorithm. `W = ctx.canvas.width`, `H = ctx.canvas.height` (device px); `cam = snapCamera(input.camera, dpr)`; `s = cam.scale * dpr`.

```
ctx.setTransform(1,0,0,1,0,0)
full = invalidated || no previous paint || cam.scale !== last.scale || W,H changed || frames !== last.frames
       || zoom !== last.zoom || (smoothing && !last.smoothing)
regions (device px):
  full → [{0,0,W,H}]
  else → dx = round((last.x - cam.x)*s), dy = round((last.y - cam.y)*s)
         if |dx| >= W or |dy| >= H → full
         else if dx or dy: ctx.drawImage(ctx.canvas, dx, dy); blit = true
              strips: dx>0 {0,0,dx,H}; dx<0 {W+dx,0,-dx,H}; dy>0 {0,0,W,dy}; dy<0 {0,H+dy,W,-dy}
         plus each invalidated world rect → device (x0=floor, x1=ceil of (v-cam)*s, clamped to [0,W]/[0,H], empty skipped)
paintRegion(r) for each region:
  save; beginPath; rect(r); clip; imageSmoothingEnabled = smoothing; fillStyle bg; fillRect(r)
  world area = {x: cam.x + r.x/s, y: cam.y + r.y/s, w: r.w/s, h: r.h/s}
  for each frame: fr = worldToDevice(frame rect)
    if rectsIntersect(fr, r):
      fillStyle frame; fillRect(fr)
      for ref of frameTiles(frame, zoom, area): d = worldToDevice(ref.world)
        image → drawImage(image, d.x, d.y, d.w, d.h); tilesDrawn++
        else missing++; for z of coarser ZOOMS, largest first: fb = fallbackFor(frame, ref, z);
             if fb and its image exists → drawImage(img, fb.sx, fb.sy, fb.sw, fb.sh, d.x, d.y, d.w, d.h); stop
      if frame.render?.error → fillStyle badge; fillRect(fr.x + fr.w - 24*dpr, fr.y + 8*dpr, 16*dpr, 16*dpr)
    if cam.scale >= LABEL_MIN_SCALE and rectsIntersect({fr.x, fr.y - 20*dpr, fr.w, 20*dpr}, r):
      fillStyle label; font `${12*dpr}px system-ui, sans-serif`; textBaseline 'bottom'
      fillText(`${frame.name} · ${DEVICE_LABEL[frame.device]}`, fr.x, fr.y - 6*dpr)
  restore
remember {cam, W, H, frames, zoom, smoothing}; clear invalidations
mode = full ? 'full' : regions.length ? 'partial' : 'none'
```

- [ ] **Step 1: Write failing tests** (`painter.test.ts`). Fixtures:

```ts
const lv = (zoom: Zoom, key: string, cols: number, rows: number) => ({ zoom, key, cols, rows });
const frame = (over: Partial<Frame> = {}): Frame => ({ pageId: 'p', name: 'P', device: 'base', x: 0, y: 0, w: 1440, h: 1000,
  render: { device: 'base', hash: 'h', width: 1440, height: 1000, levels: [lv(0.25, 'q', 1, 1), lv(0.5, 'k', 2, 1), lv(1, 'h', 3, 2)] }, ...over });
const tilesOf = (...ids: string[]) => { const m = new Map(ids.map(id => [id, img(id)])); return { get: (k: string, x: number, y: number) => m.get(`${k}/${x}_${y}`) }; };
const input = (frames: Frame[], over: Partial<PaintInput> = {}): PaintInput =>
  ({ camera: { x: 0, y: 0, scale: 0.5 }, viewport: { w: 800, h: 600 }, dpr: 1, frames, zoom: 0.5, smoothing: true, ...over });
const draws = (calls: Call[]) => calls.filter(c => c.m === 'drawImage' && (c.a[0] as { id?: string }).id).map(c => [(c.a[0] as { id: string }).id, ...c.a.slice(1)]);
```

  - `full paint draws background, frame and tiles`: with `frames=[frame()]` and tiles `'k/0_0','k/1_0'` → stats `toMatchObject({mode:'full', blit:false, regions:1, tilesDrawn:2, missing:0})`.
    - The first `fillRect` has `a: [0,0,800,600]` and `fill '#e9e9ec'`.
    - The `fillRect` calls with fill `'#ffffff'` include `[0,0,720,500]`.
    - `draws(calls)` toEqual `[['k/0_0',0,0,512,512],['k/1_0',512,0,512,512]]`.
  - `labels frames above their top edge`: `camera {x:0,y:-40,scale:0.5}` → a `fillText` call with `a` toEqual `['P · Desktop', 0, 14]` and fill `'#5f6368'`.
  - `pan blits and repaints only the exposed strip`: tiles `'k/0_0'`. Paint with `camera {x:400,y:0,scale:0.5}`, clear `calls`, then paint with `camera {x:380,y:0,scale:0.5}` → `toMatchObject({mode:'partial', blit:true, regions:1})`. The first `drawImage` has `a` toEqual `[ctx.canvas, 10, 0]`. The `rect` calls toEqual `[[0,0,10,600]]`, and `draws` toContainEqual `['k/0_0',-190,0,512,512]`.
  - `no change paints nothing`: the same input twice → the second paint is `{mode:'none', regions:0}` and adds no `drawImage`.
  - `scale change repaints fully`: camera scale 0.6 → `mode 'full'`.
  - `large pan repaints fully`: camera `x: 2000` → `mode 'full'`.
  - `invalidateWorld repaints that rect`: after a paint, `invalidateWorld({x:0,y:0,w:100,h:100})` and the same input → `toMatchObject({mode:'partial', blit:false, regions:1})` and `rect` calls `[[0,0,50,50]]`.
  - `missing tile uses a coarser fallback`: tiles `'q/0_0'` only, `zoom: 1`, `camera {0,0,1}` → `tilesDrawn 0`, `missing 4`, and `draws` contains `['q/0_0',128,128,128,128,512,512,512,512]`.
  - `failed render shows a badge`: `frame({ render: { ...frame().render!, error: 'boom' } })` → there is a `fillRect` with fill `'#d93025'` and `a: [696,8,16,16]`.
  - `smoothing off during interaction`: tiles `'k/0_0'`, `smoothing:false` → there is at least one tile `drawImage` call, and every one has `smooth === false`.
  - `smoothing back on repaints fully`: paint with `smoothing:false`, then with `true` and the same camera → `mode 'full'`.
  - `new frames array repaints fully`: same camera, but `frames` is a new array → `mode 'full'`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/painter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `test-utils.ts` and `painter.ts`.
- [ ] **Step 4: Run** the same command. Expected: 12 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/painter.ts apps/client/src/canvas/painter.test.ts apps/client/src/canvas/test-utils.ts
git commit -F - <<'EOF'
feat(client): dirty-rect base painter with blit-on-pan, LOD fallback, failure badge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 20: Selection and marquee overlay

**Files:**
- Create: `apps/client/src/canvas/overlay.ts`
- Test: `apps/client/src/canvas/overlay.test.ts`

**Interfaces:**
- Consumes: `Camera`, `Rect`, `worldToDevice` (Task 11); `Frame` (Task 12); `fakeCtx` (Task 19); `HitBox` from `@hub/protocol`.
- Produces:

```ts
export interface OverlayInput {
  camera: Camera;              // pass the same snapped camera the painter used
  dpr: number;
  selection: { frame: Frame; boxes: readonly HitBox[] } | null;
  marquee: Rect | null;        // screen CSS px
}
export const SELECT_COLOR = '#1a73e8';
export function paintOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput): void;
```

Draw order:
1. `setTransform(1,0,0,1,0,0)` and `clearRect(0,0,W,H)` (W and H from `ctx.canvas`).
2. For each box, compute `d = worldToDevice({x: frame.x+box.x, y: frame.y+box.y, w: box.w, h: box.h}, camera, dpr)`. Fill `'rgba(26,115,232,0.08)'` with `fillRect(d)`. Then set stroke `SELECT_COLOR` and `lineWidth = 2*dpr`, and `strokeRect(d)`.
3. For the marquee, scale its rect by `dpr`. Fill `'rgba(26,115,232,0.12)'` with `fillRect`, then stroke `SELECT_COLOR` with `lineWidth = dpr` via `strokeRect`.

- [ ] **Step 1: Write failing tests.** Use `fakeCtx(1600, 1200)`, `camera {0,0,0.5}`, `dpr 2`, and a frame at `(0,0)`:
  - `clears the whole canvas`: a `clearRect` call with `a [0,0,1600,1200]`.
  - `outlines selected boxes`: box `{nodeId:'n3',x:20,y:20,w:100,h:40}` → a `strokeRect` with `a [20,20,100,40]`, `stroke '#1a73e8'` and `lw 4`.
  - `draws the marquee`: marquee `{x:10,y:10,w:50,h:30}` → a `fillRect` with `a [20,20,100,60]` and fill `'rgba(26,115,232,0.12)'`, and a `strokeRect` `[20,20,100,60]` with `lw 2`.
  - `nothing selected only clears`: `selection: null, marquee: null` → no `strokeRect` calls.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/overlay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `overlay.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/overlay.ts apps/client/src/canvas/overlay.test.ts
git commit -F - <<'EOF'
feat(client): selection highlight and marquee overlay

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 21: Canvas controller

**Files:**
- Create: `apps/client/src/canvas/controller.ts`
- Test: `apps/client/src/canvas/controller.test.ts`

**Interfaces:**
- Consumes:
  - Task 11: `Camera`, `Point`, `Rect`, `panBy`, `zoomAt`, `clampScale`, `screenToWorld`, `viewRect`, `expandRect`, `fitRect`, `normalizeRect`, `intersectRect`, `snapCamera`.
  - Task 12: `Frame`, `layoutFrames`, `frameAt`, `layoutBounds`.
  - Task 13: `pickZoom`, `visibleTiles`.
  - Task 14: `hitTest`, `boxSelect`, `toPagePoint`.
  - Task 17: `TileImage`, `TileWant`.
  - Task 18: `GestureTracker`, `wheelAction`, `Tool`, `PointerIn`, `WheelIn`.
  - Task 19: `BasePainter`, `PaintStats`. Task 20: `paintOverlay`.
  - From `@hub/protocol`: `NodeSelection`, `RenderManifest`, `HitBox`, `Device`, `DEVICES`, `TILE_SIZE`.
- Produces:

```ts
export interface ControllerDeps {
  base: CanvasRenderingContext2D;
  overlay: CanvasRenderingContext2D;
  tiles: { get(key: string, x: number, y: number): TileImage | undefined; request(wants: readonly TileWant[]): void };
  hitMaps: { get(hash: string): readonly HitBox[] | undefined; load(hash: string): Promise<readonly HitBox[]> };
  requestFrame: (cb: () => void) => void;
  now: () => number;
  onSelect?: (s: NodeSelection | null) => void;
}
export interface ControllerStats { framesPainted: number; tilesDrawn: number; lastMode: PaintStats['mode'] | null }
export const SETTLE_MS = 150;
export const PREFETCH_MARGIN = 0.25;
export class CanvasController {
  constructor(deps: ControllerDeps);
  setManifest(m: RenderManifest): void;
  resize(w: number, h: number, dpr: number): void;
  setDevices(visible: ReadonlySet<Device>): void;
  setTool(t: Tool): void;
  get tool(): Tool;
  get camera(): Camera;
  setCamera(c: Camera): void;
  get frames(): readonly Frame[];
  get selection(): NodeSelection | null;
  pointer(ev: PointerIn): void;
  wheel(ev: WheelIn): void;
  panBy(dx: number, dy: number): void;
  zoomAt(x: number, y: number, factor: number): void;
  tap(x: number, y: number): Promise<void>;          // screen CSS px
  selectBox(a: Point, b: Point): Promise<void>;      // screen CSS px corners
  tileLoaded(key: string, x: number, y: number): void;
  frame(): void;                                     // the scheduled paint callback
  stats(): ControllerStats;
}
```

Behavior:
- **Scheduling:** `schedule()` calls `deps.requestFrame(() => { scheduled = false; this.frame(); })` at most once until that frame runs. Every state change below schedules.
- **`setManifest`:**
  - Relayout with `layoutFrames(m, visible)` (all `DEVICES` visible initially).
  - Rebuild a `key → {frame, level}[]` index over every level of every frame.
  - The first manifest sets `needsFit`.
  - Keep a selection whose page and device still have a frame, and call `hitMaps.load(newHash)`; when it resolves, mark the overlay dirty and schedule. Otherwise clear the selection.
- **`resize`:** set both `canvas.width = round(w*dpr)` and `canvas.height = round(h*dpr)`, then store `viewSize = {w, h}` and `dpr`.
- **`setDevices`:** relayout. Clear the selection if its frame is gone. `painter.invalidate()`.
- **`setCamera`** clamps the scale. **`panBy`** and **`zoomAt`** use the geom functions. `zoomAt` sets `lastZoom = now()`.
- **`pointer`** feeds `GestureTracker` and applies the actions:
  - `pan` → `panBy`; `zoom` → `zoomAt`; `tap` → `void tap(x,y)`.
  - `marquee move`: `marquee = normalizeRect(...)` and mark the overlay dirty.
  - `marquee end`: `marquee = null`, then `void selectBox(p0, p1)`.
  - `marquee cancel`: `marquee = null`.
- **`wheel`** applies `wheelAction(ev)` the same way.
- **`tap`:**
  - Increment a shared `selectToken`.
  - Find the frame with `frameAt(frames, screenToWorld(camera, p))`. If there is none, or its render has no levels, select `null`.
  - Otherwise use the map from `hitMaps.get(hash) ?? await hitMaps.load(hash)`. On error, select `null`.
  - Ignore the result if the token changed meanwhile.
  - `id = hitTest(map, toPagePoint(frame, world))`. Select `{pageId, device, nodeIds:[id]}`, or `null` when there is no id.
- **`selectBox`:**
  - Take the world rect of the two corners.
  - Pick the frame under the first corner. If there is none, pick the frame with the largest `intersectRect` area with the rect. If none, select `null`.
  - Clip the rect to the frame and translate it to page coords.
  - Select `boxSelect(map, pageRect)`, or `null` when empty.
  - The same token guard applies.
- **Selecting** stores the selection, marks the overlay dirty, and calls `onSelect`.
- **`tileLoaded(key, x, y)`:** for each indexed `{frame, level}`, call `painter.invalidateWorld({x: frame.x + x*TILE_SIZE/level.zoom, y: frame.y + y*TILE_SIZE/level.zoom, w: TILE_SIZE/level.zoom, h: TILE_SIZE/level.zoom})`.
- **`frame()`:**
  1. Return if there is no manifest or `viewSize.w === 0`.
  2. If `needsFit`, set `camera = fitRect(layoutBounds(frames of the first manifest page), viewSize, 40)` and clear `needsFit`.
  3. `zoom = pickZoom(scale, dpr)`; `smoothing = now() - lastZoom >= SETTLE_MS` (`lastZoom` starts at `-Infinity`).
  4. `stats = painter.paint({camera, viewport: viewSize, dpr, frames, zoom, smoothing})`.
  5. If the overlay is dirty, or `stats.mode !== 'none'` while a selection or marquee exists, call `paintOverlay(overlay, {camera: snapCamera(camera, dpr), dpr, selection: frame + boxes of the selected ids from hitMaps.get, marquee})`.
  6. `area = viewRect(camera, viewSize)`, then `tiles.request([...visibleTiles(frames, area, zoom), ...(zoom !== 0.25 ? visibleTiles(frames, area, 0.25) : []), ...visibleTiles(frames, expandRect(area, PREFETCH_MARGIN), zoom)])`.
  7. Update the stats, and `schedule()` again while `!smoothing`.

- [ ] **Step 1: Write failing tests.** Fixtures:
  - `render(device, hash)` returns `{device, hash, width: DEVICE_WIDTH[device], height: 1000, levels: [{zoom:0.25,key:hash+'q',cols:1,rows:1},{zoom:0.5,key:hash+'h',cols:2,rows:1},{zoom:1,key:hash,cols:3,rows:2}]}`.
  - The manifest has page `home` (name `Home`, route `/`) with renders `base: 'hb'`, `tablet: 'ht'`, `mobile: 'hm'`.
  - Hit maps: `hb` → `[{nodeId:'n1',x:0,y:0,w:1440,h:1000},{nodeId:'n2',x:0,y:0,w:1440,h:80},{nodeId:'n3',x:20,y:20,w:100,h:40}]`.
  - Frame queue: `q: (() => void)[]`, `requestFrame: cb => q.push(cb)`, `flush = () => { while (q.length) q.shift()!(); }`. Use `fakeCtx()` for both contexts. `tiles = { get: () => undefined, request: vi.fn() }`.
  - Standard setup: `resize(800,600,1)`, `setManifest(M)`, `flush()`, `setCamera({x:0,y:0,scale:0.5})`, `flush()`.

  Tests:
  - `fits the first page on the first frame`: after `resize` + `setManifest` + `flush`, `camera` toEqual `fitRect({x:0,y:0,w:2824,h:1000}, {w:800,h:600}, 40)`.
  - `tap selects the topmost node`: `await c.tap(15, 15)` → `selection` toEqual `{pageId:'home',device:'base',nodeIds:['n3']}`, and `onSelect` was called with the same value.
  - `tap on empty canvas clears the selection`: `tap(15,15)` then `tap(790,590)` → `null`.
  - `box select picks outermost contained nodes`: `selectBox({x:0,y:0},{x:730,y:45})` → `nodeIds ['n2']`.
  - `marquee starting outside frames uses the frame it overlaps most`: `selectBox({x:-10,y:-10},{x:730,y:45})` (world `(-20,-20)`) → `nodeIds ['n2']`.
  - `marquee gesture in select tool`: `setTool('select')`, then pointer `down(1,0,0)`, `move(1,730,45)` and `up(1,730,45)` (touch, button 0). After `await new Promise(r => setTimeout(r, 0))`, `nodeIds` is `['n2']`.
  - `pans coalesce into one frame`: `panBy(10,0)` twice → `q.length === 1` and `camera.x === -40`.
  - `requests visible tiles, then the coarse level`: after `frame()`, the first 5 ids of the last `tiles.request` call, mapped to `` `${key}/${x}_${y}` ``, toEqual `['hbh/0_0','hbh/1_0','hth/0_0','hbq/0_0','htq/0_0']`.
  - `hiding a device clears a selection on it`: `tap(15,15)`, then `setDevices(new Set(['tablet','mobile']))` → `selection === null` and `frames.length === 2`.
  - `zoom paints without smoothing until settled`: `now` returns a variable `t = 1000`. `zoomAt(100,100,2)` and run one queued frame → the last `fillRect` call on the base ctx has `smooth === false` and a new frame is queued. Set `t = 1200` and `flush()` → the last base `fillRect` has `smooth === true` and `stats().lastMode === 'full'`.
  - `tileLoaded repaints part of the canvas`: `tileLoaded('hbh',0,0)` → `q.length === 1`; after `flush()`, `stats().lastMode === 'partial'`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/canvas/controller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `controller.ts`.
- [ ] **Step 4: Run** the same command. Expected: 11 tests pass. Run `pnpm -F @hub/client typecheck`. Expected: clean.
- [ ] **Step 5: Commit**

```bash
git add apps/client/src/canvas/controller.ts apps/client/src/canvas/controller.test.ts
git commit -F - <<'EOF'
feat(client): canvas controller wiring camera, gestures, selection and painting

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 22: CanvasView component and app entry

**Files:**
- Create: `apps/client/src/canvas/CanvasView.tsx`, `apps/client/src/canvas/index.ts`
- Modify: `apps/client/src/main.tsx`

**Interfaces:**
- Consumes: `CanvasController` (Task 21), `TileLoader`, `LoaderStats` (Task 17), `HitMapStore`, `TileSource`, `StaticTileSource` (Task 16), `BlobCache`, `createIdbCache`, `liveKeys` (Task 15), `Camera` (Task 11), `Frame` (Task 12), `Tool` (Task 18); `NodeSelection`, `DEVICES`, `DEVICE_LABEL`, `Device` from `@hub/protocol`.
- Produces:

```ts
export interface CanvasViewProps { source: TileSource; cache: BlobCache; onSelect?: (s: NodeSelection | null) => void; debug?: boolean }
export function CanvasView(props: CanvasViewProps): JSX.Element;   // JSX from 'preact'
export interface HubCanvasDebug {
  panBy(dx: number, dy: number): void;
  setCamera(c: Camera): void;
  camera(): Camera;
  frames(): readonly Frame[];
  selection(): NodeSelection | null;
  stats(): ControllerStats & { loader: LoaderStats };
  idle(): Promise<void>;    // TileLoader.whenIdle()
}
declare global { interface Window { __hubCanvas?: HubCanvasDebug } }
// index.ts re-exports: CanvasView, CanvasViewProps, HubCanvasDebug, TileSource, StaticTileSource, BlobCache, createIdbCache, createNullCache
```

Markup:
- Root: `<div data-testid="canvas" style="position:fixed;inset:0;touch-action:none;user-select:none">`.
- Two `<canvas>` elements, each `position:absolute;inset:0;width:100%;height:100%`. The second (the overlay) adds `pointer-events:none`. Get the base with `getContext('2d', { alpha: false })` and the overlay with `getContext('2d')`.
- Toolbar: `position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:8px;padding:6px;background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.2)`, with `onPointerDown={e => e.stopPropagation()}`. It holds one button per device (`data-testid="device-<device>"`, label `DEVICE_LABEL[device]`, `aria-pressed` = visible) and two tool buttons (`data-testid="tool-pan"` / `"tool-select"`, labels `Pan` / `Select`, `aria-pressed` = active).
- An error box (`data-testid="canvas-error"`) appears when the manifest fails to load.

Mount effect (`useEffect`, empty deps):
- Create `loader = new TileLoader({ source, cache, onLoad: (k,x,y) => controller.tileLoaded(k,x,y) })` and `hitMaps = new HitMapStore(source, cache)`.
- Create `controller = new CanvasController({ base, overlay, tiles: loader, hitMaps, requestFrame: cb => requestAnimationFrame(() => cb()), now: () => performance.now(), onSelect })`.
- Attach a `ResizeObserver` on the root that calls `controller.resize(root.clientWidth, root.clientHeight, devicePixelRatio || 1)`, and call it once immediately.
- `source.manifest().then(m => { controller.setManifest(m); void cache.gc(liveKeys(m)); })`, setting the error state on rejection. `unsubscribe = source.subscribe(m => controller.setManifest(m))`.
- Root listeners:
  - `pointerdown` (call `setPointerCapture(e.pointerId)` first), `pointermove`, `pointerup` and `pointercancel` → `controller.pointer({ id: e.pointerId, kind, x: e.clientX - rect.left, y: e.clientY - rect.top, pointerType: e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse', button: e.button })`.
  - `wheel` with `{ passive: false }` → `preventDefault()` and `controller.wheel(...)`.
- When `debug`, set `window.__hubCanvas`.
- Cleanup removes listeners, disconnects the observer, unsubscribes, and deletes `window.__hubCanvas`.

`main.tsx`:
- `App` holds `useState<NodeSelection | null>(null)` and renders `<CanvasView source={new StaticTileSource(new URLSearchParams(location.search).get('tiles') ?? '/dev-renders')} cache={createIdbCache()} onSelect={setSel} debug={new URLSearchParams(location.search).has('debug')} />`. Create the source and cache once with `useMemo`.
- A selection bar `<div data-testid="selection" style="position:fixed;top:12px;right:12px;pointer-events:none;background:#fff;padding:6px 10px;border-radius:8px;font-size:13px">` shows `` `${s.pageId} · ${DEVICE_LABEL[s.device]} · ${s.nodeIds.join(', ')}` `` or `No selection`.
- Keep the service worker registration.

- [ ] **Step 1: Implement** `CanvasView.tsx`, `index.ts` and `main.tsx` as specified. Browser behavior is tested in Task 23.
- [ ] **Step 2: Verify the build.** Run `pnpm -F @hub/client typecheck && pnpm -F @hub/client test && pnpm -F @hub/client build && pnpm -F @hub/client size`. Expected: clean, all unit tests pass, and `JS gzip total` < 150000.
- [ ] **Step 3: Manual check.** `pnpm -F @hub/client dev:renders --pages 5`, then `pnpm -F @hub/client dev`, and open `http://localhost:5173/?debug=1`. Five rows of three frames appear. Drag pans, wheel+ctrl zooms, clicking a button shows its id in the selection bar, and the device buttons hide frames.
- [ ] **Step 4: Commit**

```bash
git add apps/client/src/canvas/CanvasView.tsx apps/client/src/canvas/index.ts apps/client/src/main.tsx
git commit -F - <<'EOF'
feat(client): CanvasView with device and tool toolbar, static source entry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 23: Playwright smoke tests for the canvas

**Files:**
- Create: `apps/client/playwright.config.ts`, `apps/client/e2e/helpers.ts`
- Test: `apps/client/e2e/canvas.spec.ts`
- Modify: `apps/client/package.json` (dev dependency `@playwright/test@1.56.1` exact; script `"test:e2e": "tsx dev/render-fixtures.ts --pages 50 --seed 1 && playwright test"`)

**Interfaces:**
- Consumes: `window.__hubCanvas` (`HubCanvasDebug`, Task 22), the test ids from Task 22, and the harness output at `/dev-renders` (Task 10). The home page comes from plan 1's `sampleDoc()`: `n2` is the header and `n3` the button inside it.
- Produces:

```ts
// playwright.config.ts
export default defineConfig({
  testDir: 'e2e', timeout: 120_000, workers: 1,
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 } },
  webServer: { command: 'pnpm build && pnpm preview --port 4173 --strictPort', url: 'http://localhost:4173',
               timeout: 180_000, reuseExistingServer: !process.env.CI },
});
// e2e/helpers.ts
export interface E2EFrame { pageId: string; device: string; x: number; y: number; w: number; h: number; render: { hash: string } | null }
export interface E2EBox { nodeId: string; x: number; y: number; w: number; h: number }
export function ready(page: Page): Promise<void>;
// waitForFunction(() => ((window as any).__hubCanvas?.stats().framesPainted ?? 0) > 0), then evaluate(() => (window as any).__hubCanvas.idle())
export function frameOf(page: Page, pageId: string, device: string): Promise<E2EFrame>;
export function hitMapOf(page: Page, hash: string): Promise<E2EBox[]>;   // page.request.get(`/dev-renders/hitmaps/${hash}.json`)
export function toScreen(cam: { x: number; y: number; scale: number }, f: E2EFrame, px: number, py: number): { x: number; y: number };
// ((f.x + px - cam.x) * cam.scale, (f.y + py - cam.y) * cam.scale)
```

- [ ] **Step 1: Write the tests** (`canvas.spec.ts`; each starts with `await page.goto('/?debug=1'); await ready(page);`):
  - `shows 50 pages x 3 devices and draws tiles`: `frames().length === 150`, `stats().tilesDrawn > 0`, `stats().loader.failed === 0`.
  - `tap selects the node under the pointer`:
    - Call `setCamera({x:-40,y:-40,scale:0.5})`, then `idle()`.
    - With `f = frameOf(page,'home','base')` and `b` = the `n3` box from `hitMapOf(page, f.render!.hash)`, click `toScreen(cam, f, b.x + b.w/2, b.y + b.h/2)` with `page.mouse.click`.
    - `expect.poll(() => selection())` toEqual `{pageId:'home',device:'base',nodeIds:['n3']}`, and `getByTestId('selection')` contains the text `n3`.
  - `drag in select tool selects a box`:
    - Same camera. Click `tool-select`.
    - With `h` = the `n2` box, `mouse.move` to `toScreen(cam,f,-20,-20)`, `mouse.down()`, `mouse.move` to `toScreen(cam,f,1460,h.y+h.h+5)` with `{steps: 5}`, then `mouse.up()`.
    - `expect.poll` selection `nodeIds` toEqual `['n2']`.
  - `device toggle hides frames`: click `device-mobile` → `frames().length === 100`; click again → `150`.
  - `reload serves visible tiles from IndexedDB`: record the URLs of requests containing `/dev-renders/tiles/` (`page.on('request', …)`) after the first `ready`. Then `page.reload()` and `ready(page)` → the recorded list is empty.
- [ ] **Step 2: Run** `pnpm -F @hub/client test:e2e e2e/canvas.spec.ts`. Expected: the harness prints its summary, then 5 tests pass. If a test fails, fix the client code it exposes, not the assertion.
- [ ] **Step 3: Commit**

```bash
git add apps/client/playwright.config.ts apps/client/e2e/helpers.ts apps/client/e2e/canvas.spec.ts apps/client/package.json pnpm-lock.yaml
git commit -F - <<'EOF'
test(client): Playwright smoke tests for tiles, tap, box select, devices, IDB cache

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

### Task 24: Throttled panning performance test and CI

**Files:**
- Test: `apps/client/e2e/perf.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `ready` (Task 23), `window.__hubCanvas` (Task 22), and the 50-page harness output (`test:e2e` script, Task 23).

- [ ] **Step 1: Write the test** `perf.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { ready } from './helpers';

test('pans 50 pages x 3 devices at >= 50 fps median with 4x CPU throttle', async ({ page }) => {
  await page.goto('/?debug=1');
  await ready(page);
  expect(await page.evaluate(() => (window as any).__hubCanvas.frames().length)).toBe(150);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (const s of [{ scale: 0.3, dx: 0, dy: -12 }, { scale: 0.08, dx: 0, dy: -10 }]) {
    await page.evaluate(sc => (window as any).__hubCanvas.setCamera({ x: -40, y: -40, scale: sc }), s.scale);
    await page.evaluate(() => (window as any).__hubCanvas.idle());
    const median = await page.evaluate(({ dx, dy }) => new Promise<number>(resolve => {
      const times: number[] = []; const start = performance.now();
      const tick = (t: number) => {
        times.push(t); (window as any).__hubCanvas.panBy(dx, dy);
        if (t - start < 4000) requestAnimationFrame(tick);
        else { const d = times.slice(1).map((v, i) => v - times[i]!).sort((a, b) => a - b); resolve(d[Math.floor(d.length / 2)]!); }
      };
      requestAnimationFrame(tick);
    }), s);
    console.log(`scale ${s.scale}: median frame ${median.toFixed(1)} ms = ${(1000 / median).toFixed(0)} fps`);
    expect(1000 / median).toBeGreaterThanOrEqual(50);
  }
});
```

- [ ] **Step 2: Run** `pnpm -F @hub/client test:e2e e2e/perf.spec.ts`. Expected: PASS, logging about 60 fps for both scales. If it fails, profile the painter (it must stay blit + strip while panning; see Task 19) rather than loosening the threshold.
- [ ] **Step 3: Update CI.** In `.github/workflows/ci.yml`:
  - Right after the `pnpm install --frozen-lockfile` step, add `- run: pnpm -F @hub/renderer exec playwright install --with-deps chromium`.
  - After the test step, add `- run: pnpm -F @hub/client build && pnpm -F @hub/client size` and `- run: pnpm -F @hub/client test:e2e`.
- [ ] **Step 4: Verify everything** from the repo root: `pnpm typecheck && pnpm test && pnpm -F @hub/client build && pnpm -F @hub/client size && pnpm -F @hub/client test:e2e`. Expected: all green, the size line < 150000, and 6 e2e tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/client/e2e/perf.spec.ts .github/workflows/ci.yml
git commit -F - <<'EOF'
test(client): 4x-throttled panning perf test; CI runs Chromium tests, size budget, e2e

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EgHXhuc9bdgup2DFjf8JrU
EOF
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| §5.5 page × device rendered with Playwright into WebP tiles at 3 zoom levels plus a hit map | 2–7 |
| §5.5 only affected pages × devices re-render; component edits re-render every page using it | 2 (`cssForDevice`), 7 (hash reuse tests) |
| §5.5 Canvas 2D, viewport culling, zoom level that fits, IndexedDB cache keyed by content hash | 13, 15–17, 19, 23 (reload test) |
| §5.5 desktop/tablet/mobile frames side by side, each device toggleable | 12, 21, 22, 23 |
| §5.3 tap → hit map → node, highlight overlay; drag selects a box; selection as node IDs with device | 14, 18, 20, 21, 23 (`NodeSelection`) |
| §11 failed render shows the last good image with a warning badge | 7, 19 |
| §1 / §12 50 pages × 3 devices smooth on a throttled Chrome profile | 9, 10, 24 |
| §3 client under 150 KB JS gzipped, Preact PWA | 8, 22, 24 |
| Dev harness + `TileSource` seam for plan 3 | 9, 10, 16 |
