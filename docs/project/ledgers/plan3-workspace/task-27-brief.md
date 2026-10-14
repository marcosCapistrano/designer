### Task 27: Shell root, login, entry point

**Files:**
- Create: `apps/client/src/shell/App.tsx`, `apps/client/src/shell/Login.tsx`, `apps/client/src/shell/shell.css`
- Modify: `apps/client/src/main.tsx`

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `ApiError`, `WsClient`, `wsUrl`), Task 23 (`parseHash`, `Route`), Task 26 (`AppList`, `AppView`), Task 24 (service worker).
- Produces:

```tsx
export function App(): JSX.Element;
export function Login(props: { api: ApiClient; onDone: () => void }): JSX.Element;
```

`App`:
- `auth` state is `'checking' | 'in' | 'out' | 'offline'`.
- `api = useMemo(() => new ApiClient({ onUnauthorized: () => setAuth('out') }))` and `ws = useMemo(() => new WsClient({ url: wsUrl(location) }))`.
- On mount, `api.session()` sets `in` or `out`, and a rejection sets `offline`.
- When `auth === 'in'`, call `ws.connect()`; leaving `in` calls `ws.close()`.
- `route` comes from `parseHash(location.hash)` and updates on `hashchange`. On `visibilitychange` to visible, call `ws.kick()`.
- Render:
  - `checking` → `<p data-testid="loading">Loading…</p>`.
  - `offline` → `<div data-testid="offline">Can't reach the Hub. Check that Tailscale is connected.<button>Retry</button></div>`; Retry re-runs the session check.
  - `out` → `<Login api onDone={() => setAuth('in')} />`.
  - `in` → a header with the title `Hub` and `<button data-testid="logout">Log out</button>` (calls `api.logout()`, then sets `out`), then `<AppList>` or `<AppView>` by route.

`Login`:
- `<form data-testid="login">` holds `<input data-testid="passphrase" type="password" autocomplete="current-password" autofocus>` and `<button data-testid="login-submit">Unlock</button>`.
- Errors show in `data-testid="login-error"`: 401 → `'Wrong passphrase.'`, 429 → the server message, anything else → `'Could not reach the Hub.'`.

`main.tsx`:
1. `import './shell/shell.css'`.
2. `render(<App />, document.getElementById('app')!)`.
3. Keep `if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');`.

`shell.css`: tablet-first layout. The shell is a full-height flex column; content areas scroll internally (`overflow:auto`); touch targets are at least 44 px; system font.

- [ ] **Step 1: Implement** the files.
- [ ] **Step 2: Verify:** `pnpm -F @hub/client typecheck && pnpm -F @hub/client test && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
- [ ] **Step 3: Commit** `apps/client/src/shell apps/client/src/main.tsx` as `feat(client): shell with passphrase login, routing and reconnect on wake`, with the attribution trailer your harness provides.

---

