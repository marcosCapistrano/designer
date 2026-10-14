### Task 28: Playwright smoke tests for the shell and Build area

**Files:**
- Modify: `apps/client/playwright.config.ts`
- Test: `apps/client/e2e/build.spec.ts`, `apps/client/e2e/pwa.spec.ts`

**Interfaces:**
- Consumes: Task 21 (`dev:fake`; passphrase `hub-dev-passphrase`; app `demo`; FakeGitHub turns CI green on the second poll; polls every 1 s), Task 24 (preview proxy), Tasks 25–27 (test ids).
- Produces: `webServer` becomes an array that keeps plan 2's preview entry unchanged and adds this one:

```ts
{ command: 'pnpm -F @hub/server dev:fake', url: 'http://127.0.0.1:8787/api/health', timeout: 120_000, reuseExistingServer: !process.env.CI }
```

- [ ] **Step 1: Write the tests.** Helper `login(page)`: `goto('/')`, fill `passphrase` with `'hub-dev-passphrase'`, then click `login-submit`.
  - `build.spec.ts`:
    - `wrong passphrase shows an error, the right one opens the app list`: the wrong passphrase → `login-error` has text `'Wrong passphrase.'`. Then `login(page)` → `app-demo` is visible.
    - `a Build prompt streams, opens a PR, and merges after CI`:
      1. Log in and click `app-demo`. `tab-build` has `aria-selected="true"`.
      2. Fill `build-input` with `'Add a notes file'` and click `build-send`.
      3. `msg-user` contains that text, and `build-messages` contains `'Done.'` (timeout 30 s).
      4. `pr-link` contains `'PR #'`, and `ci-state` has text `'success'` (timeout 30 s).
      5. `merge` is enabled. Click it, and `task-status` has text `'Merged'`.
    - `design tab shows the app's canvas`: click `tab-design` → `getByTestId('canvas')` is visible, and `canvas-error` has count 0.
    - `deploy tab shows the placeholder`.
    - `log out returns to the login screen`.
  - `pwa.spec.ts`, `the app shell loads offline after one visit`:
    1. `goto('/')`, `await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))`, then `page.reload()` so the page is controlled.
    2. `context.setOffline(true)`, then `page.reload()` → `getByTestId('offline')` is visible.
    3. `context.setOffline(false)`.
- [ ] **Step 2: Run** `pnpm -F @hub/client test:e2e e2e/build.spec.ts e2e/pwa.spec.ts`. Expected: 6 pass. If one fails, fix the code it exposes, not the assertion.
- [ ] **Step 3: Run everything:** `pnpm typecheck && pnpm test && pnpm -F @hub/client build && pnpm -F @hub/client size && pnpm -F @hub/client test:e2e`. Expected: all green, including plan 2's canvas and perf specs. CI needs no workflow change, because Playwright starts both servers.
- [ ] **Step 4: Commit** `apps/client/playwright.config.ts apps/client/e2e/build.spec.ts apps/client/e2e/pwa.spec.ts` as `test(client): e2e for login, Build flow to merge, offline shell`, with the attribution trailer your harness provides.

---


## Controller additions (requirements; they override the brief where they differ)

Worktree /home/claude/wt-p3-28, branch p3-28, off feat/hub-server 40f9a3b (Tasks 1-27 merged, Task 9 still in a fix round elsewhere — do not touch apps/server/src/claude/).

1. webServer entry for the fake hub: do NOT use `pnpm -F @hub/server dev:fake` as the command. A reviewer verified that on SIGTERM the pnpm wrapper dies but its tsx/node children keep port 8787 and the scratch dirs. Use `{ command: 'node --import tsx src/dev/fake-hub.ts', cwd: <path to apps/server, resolved from the config file>, url: 'http://127.0.0.1:8787/api/health', timeout: 120_000, reuseExistingServer: !process.env.CI }`. Keep plan 2's preview entry unchanged.
2. Do NOT set `changeOrigin` on the Vite proxy (vite.config.ts); with it, the hub refuses the page's WebSocket and live build updates silently stop.
3. The hub has a csrf layer: browser requests are fine (they send Sec-Fetch-Site), but any Playwright `request` fixture call that POSTs without a JSON body must send `Origin: http://localhost:4173` (or `Sec-Fetch-Site: same-origin`). Prefer driving everything through the page.
4. The session cookie is `Secure`; Chromium accepts it on http://localhost. If a test shows otherwise, report it rather than weakening the cookie.
5. Before running any Playwright: `lsof -i :4173` and `lsof -i :8787` must be empty; run with `CI=1`. Kill anything you start. Chromium is at /opt/pw-browsers; never run `playwright install`.
6. Plan 2's perf spec is load-sensitive. Another process (a fuzzer) may be loading this machine. If only perf.spec.ts phases fail in step 3, record `uptime` load averages, rerun perf.spec.ts alone once, and report both results; never change perf thresholds.
7. "Fix the code it exposes" applies to apps/client and apps/server/src outside claude/; if a fix would touch the server's guard (claude/), stop and report it instead.
