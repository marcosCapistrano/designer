### Task 26: App list and per-app view with area tabs

**Files:**
- Create: `apps/client/src/shell/AppList.tsx`, `apps/client/src/shell/AppView.tsx`
- Modify: `apps/client/src/canvas/CanvasView.tsx` (the root style `position:fixed` becomes `position:absolute`, so the canvas fills its container. The harness looks the same because `#app` fills the viewport.)

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `WsClient`, `ServerTileSource`), Task 23 (`Area`, `AREAS`, `AREA_LABEL`, `formatRoute`, `STATUS_LABEL`), Task 25 (`BuildArea`), Task 24; plan 2 `CanvasView`, `createIdbCache`.
- Produces:

```tsx
export function AppList(props: { api: ApiClient; ws: WsClient }): JSX.Element;
export function AppView(props: { app: string; area: Area; api: ApiClient; ws: WsClient }): JSX.Element;
```

`AppList`:
- Loads `api.apps()` on mount and again on every `build.task` WebSocket message.
- Renders `<ul data-testid="app-list">`. Each item is `<a data-testid={`app-${name}`} href={formatRoute({ name: 'app', app: name, area: 'build' })}>` and shows:
  - the name;
  - a badge `Adopted` or `Not adopted`, with `title={manifestError ?? ''}`;
  - `running ? 'Claude is working' : buildStatus ? STATUS_LABEL[buildStatus] : ''`.
- With no apps it renders `<p data-testid="no-apps">No apps yet. Clone a repo into HUB_APPS_DIR on the hub server.</p>`.
- Load errors show in `data-testid="apps-error"`.

`AppView`:
- Header: `<a href="#/" data-testid="back">All apps</a>` and the app name.
- `<nav role="tablist">` with one `<a role="tab" data-testid={`tab-${a}`} aria-selected={a === area} href={formatRoute({ name: 'app', app, area: a })}>{AREA_LABEL[a]}</a>` per area.
- A body container with `position:relative; flex:1; overflow:hidden`:
  - `design` → `<CanvasView key={app} source={useMemo(() => new ServerTileSource(app, ws), [app])} cache={useMemo(() => createIdbCache(`hub-tiles-${app}`), [app])} />`. The cache is per app, so plan 2's `cache.gc` on one app never evicts another app's tiles.
  - `build` → `<BuildArea key={app} app={app} api={api} ws={ws} />`.
  - `deploy` → `<p data-testid="deploy-placeholder">Deploy is not set up yet.</p>`. Plan 4 replaces it.

- [ ] **Step 1: Implement** both files and the one-line `CanvasView` change.
- [ ] **Step 2: Verify.**
  - `pnpm -F @hub/client typecheck && pnpm -F @hub/client test && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
  - `pnpm -F @hub/client test:e2e e2e/canvas.spec.ts` still passes 5 tests.
- [ ] **Step 3: Commit** `apps/client/src/shell/AppList.tsx apps/client/src/shell/AppView.tsx apps/client/src/canvas/CanvasView.tsx` as `feat(client): app list and per-app Design/Build/Deploy tabs`, with the attribution trailer your harness provides.

---

