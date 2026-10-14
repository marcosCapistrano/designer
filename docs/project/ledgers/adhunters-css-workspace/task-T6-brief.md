### Task T6 (J): Parity harness

**Files:**
- Create in `site/tests/parity/`: `tsconfig.json`, `playwright.config.ts`, `run.mjs`, `auth.setup.ts`, `routes.ts`, `scenarios.ts`, `mock-api.ts`, `parity.spec.ts`, `overflow.spec.ts` and `make-assets.mjs`
- Create in `fixtures/`: `ids.ts`, `index.ts`, and the empty area files `shell.ts`, `lists.ts`, `details.ts`, `raposa.ts` and `data.ts`
- Create: `assets/creative-1.png` to `creative-4.png`, generated

**Interfaces:**
- Produces:
  - **`routes.ts`:** `type RouteKey = "ads" | "operators" | "ad" | "operator" | "publishers" | "publisher" | "raposa" | "investigation" | "export" | "data" | "proxies" | "developers" | "search" | "watching" | "login"` and `ROUTES: { key: RouteKey; path: string; auth: boolean }[]`.

    | Key | Path |
    |---|---|
    | ads | `/` |
    | operators | `/advertisers` |
    | ad | `/ads/${CREATIVE_ID}` |
    | operator | `/advertisers/${OPERATOR_ID}` |
    | publishers | `/publishers` |
    | publisher | `/publishers/${PUBLISHER_ID}` |
    | raposa | `/raposa` |
    | investigation | `/raposa/${INVESTIGATION_ID}` |
    | export | `/raposa/export?ids=${INVESTIGATION_ID},${INVESTIGATION_ID_2}&print=0` |
    | data | `/data` |
    | proxies | `/proxies`, which redirects to `/data?tab=proxies` |
    | developers | `/developers` |
    | search | `/search?q=keto` |
    | watching | `/watching` |
    | login | `/login`, with `auth: false` |

  - **`fixtures/ids.ts`:** `CREATIVE_ID`, `OPERATOR_ID`, `PUBLISHER_ID`, `INVESTIGATION_ID`, `INVESTIGATION_ID_2`, `PAGE_ID` and `ASSET_HASH`. Each value matches the format its route handler parses; read the handler.
  - **`mock-api.ts`:**
    - `type Handler = { method?: string; path: string | RegExp; body: unknown | ((url: URL) => unknown); status?: number; contentType?: string; empty?: unknown }`.
    - `type MockMode = "data" | "empty" | "pending" | "error"`.
    - `installMocks(page: Page, mode?: MockMode): Promise<{ unmatched: string[]; external: string[] }>`. It routes `**/api/**` (except `/api/auth/*`) through `fixtures/index.ts` `handlers`. `/_next/image*` and every non-local image request get `assets/creative-N.png`, where N is a stable hash of the URL modulo 4. Other external requests are aborted and recorded. An unmatched `/api` request is answered 404 and recorded.
    - Modes: `empty` serves `handler.empty ?? body`; `pending` never fulfills; `error` answers 500 `{"error":"parity"}`.
  - **`fixtures/index.ts`:**
    - `handlers: Handler[]`, the concatenation of the five area files' `handlers` exports;
    - `ready: Partial<Record<RouteKey, string>>`, the merge of their `ready` exports. A `ready` selector is a CSS selector visible only when the page shows data. Area files own their routes' selectors.
  - **`scenarios.ts`:**
    - `type Device = "desktop" | "tablet" | "mobile" | "wide"`.
    - `interface Scenario { key: string; route: RouteKey; devices: Device[]; mode?: MockMode; query?: string; initScript?: string; context?: { hasTouch?: boolean; isMobile?: boolean; media?: "print" }; act?: (page: Page) => Promise<void> }`.
    - `SCENARIOS: Scenario[]`, with exactly the keys in the scenario table below.
  - **`playwright.config.ts`:**
    - Projects `setup` (auth.setup.ts), then `desktop` 1440×900, `tablet` 834×1194, `mobile` 390×844 and `wide` 1920×1080 (all `deviceScaleFactor: 1`, `isMobile: false`), plus `gap700` 700×900 and `gap1100` 1100×900, which run only `overflow.spec.ts`.
    - `use: { baseURL: process.env.PARITY_URL, timezoneId: "UTC", locale: "en-US", colorScheme: "dark", storageState: ".out/auth.json" }`.
    - `expect.toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 50, animations: "disabled", caret: "hide", fullPage: true }`.
    - `snapshotPathTemplate: "{env PARITY_DIR}/snapshots/{arg}-{projectName}{ext}"`, computed in the config from `process.env.PARITY_DIR`.
    - `workers: 4`, `retries: 0`, `outputDir: ".out/results"`.
  - **Test titles:** `[<route>] <route>` for page shots, `[<route>] <scenario key>` for scenarios and `[<route>] overflow`, so `--grep "\[(ads|ad)\]"` selects by route.
  - **`parity.spec.ts`:** for each route, and each scenario on its devices:
    - `page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z"))`;
    - `installMocks`;
    - `initScript` if any;
    - `goto(path + query)`;
    - wait for `ready[route]` (not in `pending` mode);
    - `act`;
    - `expect(page).toHaveScreenshot(\`${key}.png\`)`;
    - assert that `unmatched` is empty and no `pageerror` fired.
  - **`overflow.spec.ts`:** on `gap700` and `gap1100`, for every route, measure `document.documentElement.scrollWidth - innerWidth`. In baseline mode, write it to `$PARITY_DIR/overflow.json`. In compare mode, assert that head is no larger than base.
  - **`run.mjs`**, run from `site/`. Every mode starts servers with `next start -p <free port>`, with the D15 environment (and `DATABASE_URL` and `PG*` deleted), and waits for `/healthz`. The last line of output is `PASS n/n` or `FAIL k/n`.

    | Mode | What it does |
    |---|---|
    | `baseline [--force]` | Ensures `$PARITY_DIR/base` is a worktree at `$(cat tests/parity/BASE)`, then runs `PNPM install --frozen-lockfile` and `PNPM --filter site build` in it. Starts it, runs `playwright test --update-snapshots=all` with `PARITY_URL` and `PARITY_MODE=baseline`, then stops. |
    | `selftest` | Runs against the base server without updating snapshots. |
    | `compare --all` | Builds the current checkout (`PNPM --filter site build`), starts it and runs all tests. |
    | `compare --routes <k,…>` | The same, with `--grep "\[(k|…)\]"`. |
    | `probe --routes <k,…>` | Runs against the base server with no screenshot assertion. Prints per route and device: unmatched calls, external calls, page errors, and whether `ready` was found. Saves PNGs to `.out/probe/`. |

  - **`auth.setup.ts`:** fills the login form (`#user`, `#password`, then submit) with the D15 credentials and saves `.out/auth.json`.
  - **`make-assets.mjs`:** renders 4 fixed SVG gradients at 600×400 with Chromium and writes `assets/creative-1.png` to `creative-4.png`.

**Scenarios (key, route, devices, action):**

| Key | Route | Devices | Action |
|---|---|---|---|
| ads-card-hover | ads | desktop | hover the first result card |
| ads-tooltip | ads | desktop | hover the first signal trigger; wait for `[role="tooltip"]` |
| ads-select-open | ads | desktop, mobile | open the first EmberSelect; wait for `[role="listbox"]` |
| ads-calendar-open | ads | desktop | open CalendarRangePicker; wait for its popover content |
| ads-vertical-open | ads | desktop | open VerticalFilter |
| ads-view-grid, ads-view-table | ads | all four | `initScript`: `localStorage.setItem("adhunters_view_mode", "grid" or "table")` |
| operators-view-grid, operators-view-table | operators | all four | the same, key `adhunters_operators_view_mode` |
| ads-table-row-hover | ads | desktop | table view; hover the first row |
| ads-empty | ads | desktop, mobile | mode `empty` |
| ads-error | ads | desktop | mode `error` |
| ads-pending, operators-pending, ad-pending, search-pending, publishers-pending | each route | desktop, mobile | mode `pending`; screenshot after `load` |
| publishers-dossier-open | publishers | desktop, mobile | open the first publisher dossier dialog |
| ad-drawer-open | ad | desktop, mobile | open the Raposa dossier drawer |
| investigation-funnel-step | investigation | desktop, tablet | select the second funnel step |
| operator-watch-toast | operator | desktop, mobile | click WatchButton (POST mocked 200); wait for the toast |
| data-header-hover | data | desktop | hover the second header nav link |
| raposa-form-focus | raposa | desktop | press Tab until the investigate input has `:focus-visible` |
| voice-focus | data | desktop, mobile | press Tab to the voice feedback button; do not activate it |
| data-publishers, data-raposa, data-found | data | all four | query `?tab=publishers`, `raposa`, `found` |
| export-print | export | desktop | `context.media: "print"` (`page.emulateMedia({ media: "print" })`) |
| ads-touch, operators-touch | ads, operators | tablet, mobile | `context: { hasTouch: true, isMobile: true }`; tap the first card's operator link area |

- [ ] **Step 1: Write the harness files** to the interfaces above, and run `S node tests/parity/make-assets.mjs`.
- [ ] **Step 2: Typecheck.** `S tsc --noEmit -p tests/parity` exits 0.
- [ ] **Step 3: Login works.** With `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, `S node tests/parity/run.mjs probe --routes login,developers` prints, for `login`, `ready` found (selector `#user`). For `developers` it lists unmatched `/api/keys…` calls, because T7 fills those.
- [ ] **Step 4: Commit.** `test(parity): screenshot harness with in-browser fixture mode`.

