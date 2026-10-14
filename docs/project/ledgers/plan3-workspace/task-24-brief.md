### Task 24: Move the canvas harness, proxy to the hub, app-shell service worker

**Files:**
- Create: `apps/client/harness.html`, `apps/client/src/harness.tsx`
- Modify: `apps/client/vite.config.ts`, `apps/client/public/sw.js`, `apps/client/e2e/canvas.spec.ts`, `apps/client/e2e/perf.spec.ts`

**Interfaces:**
- Consumes: plan 2 Tasks 8, 10, 22–24 (current `main.tsx`, `index.html`, `vite.config.ts`, e2e specs).
- Produces:
  - `/harness.html` serves plan 2's canvas dev harness: `?tiles=`, `?debug=1`, `window.__hubCanvas`, and the selection bar.
  - `/` is left for the shell (Task 27).
  - The dev and preview servers proxy `/api` and `/ws` to `http://127.0.0.1:8787`.

Changes:
- `harness.html` is a copy of `index.html` with `<title>Hub canvas harness</title>` and `<script type="module" src="/src/harness.tsx">`.
- `src/harness.tsx` is plan 2's current `main.tsx` content (the `App` with `StaticTileSource`, `createIdbCache()` and the selection bar) without the service worker registration. Leave `main.tsx` unchanged in this task.
- `vite.config.ts`:
  - Add `build.rollupOptions.input = { main: fileURLToPath(new URL('./index.html', import.meta.url)), harness: fileURLToPath(new URL('./harness.html', import.meta.url)) }`.
  - Add `const hubProxy = { '/api': { target: 'http://127.0.0.1:8787' }, '/ws': { target: 'http://127.0.0.1:8787', ws: true } }`, used as both `server.proxy` and `preview.proxy`.
  - Keep the plugins.
- In `e2e/canvas.spec.ts` and `e2e/perf.spec.ts`, replace every `page.goto('/?debug=1')` with `page.goto('/harness.html?debug=1')`.
- `public/sw.js` (exact; caches the app shell for the tablet, never `/api`, `/ws` or tiles):

```js
const CACHE = 'hub-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.add('/'))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' && url.pathname === '/') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; })
      .catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});
```

- [ ] **Step 1: Make the changes above.**
- [ ] **Step 2: Verify.**
  - `pnpm -F @hub/client typecheck && pnpm -F @hub/client test` is clean.
  - `pnpm -F @hub/client build` lists `dist/harness.html`, and `pnpm -F @hub/client size` stays under 150000.
  - `pnpm -F @hub/client test:e2e e2e/canvas.spec.ts e2e/perf.spec.ts` passes 6 tests.
- [ ] **Step 3: Commit** `apps/client/harness.html apps/client/src/harness.tsx apps/client/vite.config.ts apps/client/public/sw.js apps/client/e2e` as `chore(client): move canvas harness to /harness.html, proxy /api and /ws, cache the app shell`, with the attribution trailer your harness provides.

---

