### Task 19: Render file endpoints

**Files:**
- Create: `apps/server/src/design/render-files.ts`
- Test: `apps/server/src/design/render-files.test.ts`

**Interfaces:**
- Consumes: Task 3; plan 2's `RenderManifest`, `MANIFEST_PATH` and path layout (`tiles/<key>/<x>_<y>.webp`, `hitmaps/<hash>.json`, as written by `FsTileStore`).
- Produces:

```ts
export const EMPTY_MANIFEST: RenderManifest = { version: 1, pages: [] };
export function renderDir(dataDir: string, app: string): string;     // join(dataDir, 'renders', app); plan 6 writes FsTileStore here
export function renderRoutes(opts: { dataDir: string; hasApp: (app: string) => Promise<boolean> }): Hono;   // mount at /api/apps
```

Routes:
- `GET /:app/render/manifest.json` → the file, or `EMPTY_MANIFEST` when it is missing. `content-type: application/json`, `Cache-Control: no-cache`.
- `GET /:app/render/tiles/:key/:tile`: `key` must match `/^[0-9a-f]{64}$/` and `tile` must match `/^\d+_\d+\.webp$/`. Responds `image/webp` with `Cache-Control: private, max-age=31536000, immutable`.
- `GET /:app/render/hitmaps/:file`: `file` must match `/^[0-9a-f]{64}\.json$/`. Responds `application/json`, immutable.
- An unknown app → 404 `{ error: 'Unknown app' }`. A bad name or missing file → 404 `{ error: 'Not found' }`.

- [ ] **Step 1: Write the failing tests** (`new Hono().route('/api/apps', renderRoutes({ dataDir, hasApp: async a => a === 'demo' || a === 'empty' }))`, with `K = 'a'.repeat(64)` and files written under `renderDir(dataDir, 'demo')`):
  - `serves the manifest without caching`: 200, the JSON is equal, and `cache-control` is `'no-cache'`.
  - `missing manifest is empty`: `/api/apps/empty/render/manifest.json` → `{ version: 1, pages: [] }`.
  - `serves tiles as immutable webp`: `/tiles/${K}/0_0.webp` → `content-type 'image/webp'`, the immutable cache header, and equal bytes.
  - `serves hit maps`.
  - `unknown app is 404`.
  - `rejects malformed names`: `tiles/..%2F..%2Fetc/0_0.webp`, `tiles/abc/0_0.webp`, `tiles/${K}/x_y.webp` and `hitmaps/..%2Fx.json` → 404.
  - `missing tile is 404`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/design`. Expected: FAIL.
- [ ] **Step 3: Implement** `render-files.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 pass.
- [ ] **Step 5: Commit** `apps/server/src/design` as `feat(server): render manifest, tile and hit map endpoints`, with the attribution trailer your harness provides.

---

