# Preflight: adhunters-v4 Tailwind to CSS Modules plan

Plan: `/mnt/project-files/designer/plans/2026-10-14-adhunters-v4-css-modules.md` (77 tasks, 11 waves).
Checked against: repo `/home/claude/adhunters-v4` at `master` f79b876 (clean tree), spec `/mnt/project-files/designer/spec.md`, hub code in `/home/claude/wt-p3/packages` (d82aca2), `AGENTS.md`, `CLAUDE.md`, `.github/workflows/*`, `scripts/staging-add`.
Date: 2026-10-14. This review was read-only. Experiments ran only in the session scratchpad: Tailwind 4.3.3, tw-animate-css 1.4.0, tailwind-merge 3.7.0, @babel/parser and TypeScript 7.0.2 were installed there, never in the repo.

## Summary

| Severity | Count | IDs |
|---|---|---|
| blocking | 1 | F01 |
| should-rule | 12 | F02 to F13 |
| note | 22 | N01 to N22 |

Blocking: **F01**. `OperatorLink` reads its caller's `className` string at runtime (`/\btruncate\b/.test(className)`). Converting the callers to `styles.x` silently turns off the truncation layout. Parity may not catch it. This must be ruled before P2 (W4). W0 to W3 are not affected.

Overall, the plan's facts check out against the repo. These all match: route count, styled-file count, `xl:` count, the D9 token set, the D13 unused list, D14, D10, D11, and the D31 collision claim. All 56 conversion tasks' ROUTES match the import closure exactly, except one harmless extra. The tool chain T2 to T3 to T4/T5 is internally consistent, and its test vectors agree with Tailwind 4.3.3's real output.

---

## Findings index

| ID | Sev | Finding (one line) | Affects |
|---|---|---|---|
| F01 | blocking | OperatorLink derives layout from the `truncate` token in the caller's className string. After callers convert, `clips` is always false. | P2, C3, C4, D7, D8, E9, F7 |
| F02 | should-rule | `outline-hidden` (ui/chart, 3 uses) compiles to `@media (forced-colors: active)`. Constraint 4 and the MEDIA guard forbid it, and the resolver does not model it. | T2, T3, T4, A6 |
| F03 | should-rule | `run.mjs` runs through `S`, so its cwd is `site/`. Spawning `PNPM`/`npx` from there fails with EBADDEVENGINES (verified). | T6, T12, every SCP-7 |
| F04 | should-rule | `probe` needs a built BASE server before T12's `baseline` exists. T6 and T7 to T11 (W1/W2, parallel) would all build `$PARITY_DIR/base`, which races. | T6, T7 to T11 |
| F05 | should-rule | G step 2 reconverts master-changed files before moving BASE. check.mjs and convert then read the old BASE, so the reconversion fails. | G1 to G3, R3 |
| F06 | should-rule | Class props other than `className` (`valueClass` in ad/bits) are not modeled: no incoming element, no caller site. | D1, D2 |
| F07 | should-rule | The shadcn colors are `@theme inline`, so the codemod emits `hsl(var(--x))` and the 19 D9 `--color-*` tokens go unused. R2's docs promise `var(--color-*)`. | T2, T5, R2 |
| F08 | should-rule | The wide tier `(min-width: 1536px)` is not in the hub's `BREAKPOINTS`/`NodeStyle`. Its only use is in unused `skeletons.tsx`. | constraint 4, D2, C12 |
| F09 | should-rule | check-styles `DIRECTIVE` ("in any CSS") and `UNDEFINED-VAR` would flag globals.css and toaster.css in `--converted` mode before R1. | T4, G1 to G3 |
| F10 | should-rule | The machine has 4 CPUs, 15 GB RAM and 23 GB free. W5 (20 tasks) and W6 (28 tasks) in parallel, each running `next build` plus Playwright with 4 workers, will thrash. | coordinator |
| F11 | should-rule | 29 task pairs in the same wave import each other. Each is validated only against an unconverted sibling and is not rechecked after the rebase. | W5, W6 merge protocol |
| F12 | should-rule | The DYNAMIC and COMPOSE-UNKNOWN-CHILD hand rules say "rerun convert.mjs" on a file the first run already rewrote. | SCP-2 |
| F13 | should-rule | check.mjs reuses the converter's `cascade`/`rulesForClass`, so the static proof is not independent. The ~2,000 unused lines of D13 rest on it alone. | T4, D13 |
| N01 to N22 | note | See section 4. | various |

---

## 1. Task-pair table (producer to consumer)

Legend: OK = consistent; F/N = see finding. "Same wave" means both tasks run in parallel off the same `css-modules` tip.

### 1a. Tool chain, fixtures, gates, removal

| Producer to consumer | Producer gives | Consumer takes | Found |
|---|---|---|---|
| T1 to T2 | `site/tests/parity/BASE` (sha); dep `@tailwindcss/node@4.3.3`; `postcss` (already a devDep ^8.5.28) | `git show <BASE>:site/src/...` for 3 CSS files; `__unstable__loadDesignSystem` | OK. Verified that the export exists and that `{base}` resolves `@import "tailwindcss"` and `"tw-animate-css"` by walking up to `node_modules` (ran it on BASE css: 1,008 candidates resolved). |
| T1 to T3 | `@babel/parser@7.29.9`, `recast@0.23.11` | parser and printer for extract/convert | OK. Both versions exist. The lock already has recast 0.23.21 transitively (N21). |
| T1 to T4 | `postcss-selector-parser@7.1.0`, `@babel/parser` | check-styles imports only these plus postcss | OK |
| T1 to T6 | `@playwright/test@1.56.1`; tsconfig `exclude: tests`; `.gitignore` `.out/` | harness, `tsc -p tests/parity` | OK. playwright-core 1.56.1 wants chromium 1194, which is present in /opt/pw-browsers. The exclude misses `scripts/tw2css/tests/fixtures/*.tsx` (N13). |
| T1 to R1 | devDeps and `.gitignore` lines | R1 removes recast and `@tailwindcss/node`, drops the `.tw2css-cache` ignore line | OK |
| T2 to T3 | `resolveElement`, `rulesForClass`, `loadBaseDesignSystem`, `flat`; types `Part`/`ElementOpts`/`OutRule`/`Todo` | `extractSites` gives `Part[]` with `external`; `mergeChild`; emit maps `:where(.group)` | OK on shapes. Gaps: named groups (`group/opname`) appear in no T2 or T3 test (N03). `--explain` needs `one()`, which lives only in a test file (N12). |
| T2 to T4 | `cascade`, `rulesForClass`, `resolveElement`, the UA display table, R-h | check.mjs expected and actual cascades; normalization | Interface OK. Independence problem (F13). The R-h table is copied in three places (N11). |
| T2 to T5 | `loadBaseDesignSystem` (`ds.theme`); R-h token names | gen-tokens writes the same names R-h emits | OK on names (`--space-0_5`, `--text-xs-leading`, `--ease-default`, `--duration-default`, `--animate-enter`). The shadcn `--color-*` tokens are never emitted by R-h (F07). |
| T3 to T4 | `Site.id` (`Chip>span[0]`), `mergeTarget`, Chip fixtures | `checkFile` pairs by `Site.id`; `childModules` from `mergeTarget` | OK. The ids agree. The merge-site test needs a stated order for two modules at equal specificity (child last) (N12). |
| T5 to T4 | `src/styles/tokens.css` | UNDEFINED-VAR set; literal normalization | OK, since T5 (W2) runs before T4 (W3). |
| T3 to SCP | convert CLI, summary line, TODO codes and hand rules | SCP-1 and SCP-2 | SCP-1 fixes the summary format `<file>: <e> elements, …`, but T3's interface doesn't (N01). Rerun semantics (F12). |
| T4 to SCP | `check.mjs <files>`, `check-styles.mjs <files>` | SCP-4 and SCP-5 | SCP-5 asks for "no output", but UNUSED-CLASS prints warnings (N07). |
| T5 to T12 | tokens, animations, globals-first import in layout | T12 step 3 `compare --all` proves nothing visible changed | OK. Same-named theme vars carry identical values. toaster.css versus globals order is decided by specificity, not order. |
| T6 to T7 to T11 | `Handler`, `RouteKey`, `ids.ts`, `fixtures/index.ts` concatenation, `probe` | area files with `handlers` and `ready` | Interface OK. The base server for `probe` is unowned and races (F04). Handler precedence is undefined (N16). |
| T7 to T11 (pairwise) | separate area files; shared `ids.ts` and `index.ts` | n/a | Files are disjoint. Paths overlap: T7 `/api/watching/unread`, T9 `POST /api/watching`, T11 `/api/watching` (N16). |
| T6 to T12 | run.mjs modes; `scenarios.ts`/`parity.spec.ts` (T12 may edit them) | baseline, selftest, compare | OK across waves. n = 60 page shots + 65 scenario shots + 30 overflow (+1 setup test) = 155/156. |
| T12 to every SCP-7 | `$PARITY_DIR/snapshots`, `overflow.json` | `compare --routes` | OK. run.mjs spawn cwd (F03). Capacity (F10). |
| T3 to G3 | `convert --all --dry-run` | step 8 "0 elements still carrying Tailwind classes" | That metric is not a column of T3's report (N01). |
| T3 to R1 | `--unwrap-all` | R1 step 3 | OK. Unwrap comes before the tw2css deletion. |
| T4 to G1 to G3 | `check.mjs --converted`, `check-styles --converted` | gate steps 3 and 4 | check-styles mode scope (F09). |
| T4 to R1 | `check.mjs --unlayered`, `check-styles --final`, guard in build | R1 steps 3, 5, 6 | OK in order: `--unlayered` runs before `@tailwindcss/node` is removed. Per-context deletion (N17). |
| T5 to R1 | globals.css imports (T5 adds 2) | R1 rewrites the top 5 lines exactly | OK. `@layer` statement before `@import` is valid CSS. |
| T5 to F1 | `layout.tsx`: globals first | F1 keeps it first and adds the module import last | OK. Constraint 5 ("module import last") is compatible. |
| G1 to G2 to G3 to R1 to R3 | BASE sha, `$PARITY_DIR/base` build, re-captured snapshots | next gate; R1 copies preflight from the base `.next` | Step ordering (F05). |
| R1 to R2 (same wave W9) | build guard, file layout | docs describe them | Files disjoint. OK. R2 section numbering (N09). |
| R1, R2 to R3 | green branch | push, PR, staging | R3 health and pnpm details (N10). |

### 1b. Conversion lanes: cross-task interfaces

The interfaces are className merge sites (C passes `className` to P's component), imported constants or maps (externals), and shared files. Merge-site counts come from a babel scan of every JSX `className` on a component. State collisions were checked by running `twMerge(child, caller)` with tailwind-merge 3.7.0.

| Producer to consumer | Interface | Wave order | Found |
|---|---|---|---|
| P1 (Button, Badge) to E5 (Distributions, 6 sites), F6 (export, 1 site) | merge sites; `buttonVariants`/`badgeVariants` shape | W4 to W6/W7 | OK. No state collisions. The caller classes `h-7 text-xs`, `size-6` and `font-normal` beat `:where`. `[&_svg]:size-4` keeps (0,1,1), as at BASE. |
| P2 (OperatorLink) to B7, C3, C4, C10, C11, C13, D1, D6, D7, D8, E3, E9, F7 (36 sites) | `className` prop, **read as data** | W4 to W5 to W7 | **F01** for the `truncate` callers C3, C4, D7, D8, E9, F7. Otherwise OK, with no state collisions. |
| P2 (FoxIcon) to E1 (`iconClass`) | `className` with a Tailwind default param | W4 to W6 | The default `"size-4"` is not covered by P2's note (N03). |
| P3 (`DELTA_CLASS`) to B4, B5, B7, C3, C4, D1, D6 | external map | W4 to W5/W6 | OK. Every consumer pairs it with `ember-type-mono-delta` (font only), so there is no property conflict and module order does not matter. |
| P3 (`STAGES`) to B6, B7, D4 | external map | W4 to W5/W6 | OK |
| P3 (StageBadge) to C7 | `formatShare*` functions only | W4 to W6 | OK. The StageBadge component and `momentumClass` are unused (N02). |
| A1 label to A1 checkbox | `peer` across files | same task | OK (D11). The label `cva` is not in T3's CVA list (N01). |
| A3 (select) to B8 (EmberSelect) | imports Radix-wrapped parts | **same wave W5** | F11. No callers pass className to EmberSelect. OK. |
| A4 (tooltip) to B8 (SpyTooltip); A4 (popover) to C5 | portaled content plus `emberPortalClass` | W5 same wave / W5 to W6 | F11 for A4 to B8. Otherwise OK. |
| A7 (TableRow, Card, Skeleton) to C12 (skeletons, 124 sites) | merge sites; TableRow `hover:bg-muted/50` vs callers' `hover:bg-transparent` | W5 to W6 (child first) | Children-first state collision in the mixed state between G1 and C12. Invisible because skeletons.tsx is unused (N18). |
| B1 (ember/ui) to C1 (same W5), then C7 to C11, C13, D1 to D8, E3, E6 to E8, F1 to F5, F7 (about 180 sites) | merge sites | W5 to W5/W6/W7 | No state collisions. `EmberPage`'s responsive self rules have no className callers. F11 for C1. |
| B2 (`FIELD_CLASS`, controls) to B6, B8 (same W5); C5 (W6) | external constant; Segmented etc. | W5 | OK. The consumers add no conflicting property (EmberSelect passes no callers' className). F11. |
| B3 (signals) to B4, B5, B7 (same W5); D1 | components plus merge sites | W5 | F11. No collisions. |
| B4 (cards: `TABLE_COLUMNS`, `ListImage`, `useCardLink`, `TrendCell`) to B5, B6, B7 (same W5); C4 (W6) | external constant (grid-template-columns only); components | W5 | OK. The consumers' own classes never set `grid-template-columns`. `ListImage` is responsive and incoming, but no caller passes className. F11. The B4 note about group-hover is wrong (N04). |
| B7 (`GRID_CLASS`, SpyImage, SpyStageBadge) to B3, B4, B5 (same W5); D5 (W6); F5 (W7); C3, C4, C8, D1, D7, D8, F2, F7 (merge sites) | external constant (used alone); components | W5 | OK. F11 for the same-wave consumers. |
| B8 (SpyTooltip, EmberSelect, RangeSlider) to B3, B6, B7 (same W5); C10 (W6) | components | W5 | F11 |
| C1 (WatchButton) to B5 (same W5, 2 sites) | merge sites | W5 | F11 |
| C2 (Toaster) to B9 (same W5) | `useToasterClass` | W5 | OK. The font-variable class is allowlisted. |
| C1 (Header container) and F1 (layout container) | the two containers must align (AGENTS rule 3) | W5 vs W7 | They differ at 600 to 639 px between G1 and F1. Transient, not shipped (N18). |
| C3 (AdCard) to D5 (OperatorAds) | component | **same W6** | F11 |
| C8, C9 to D2 (TrackingPanel) | components | **same W6** | F11 |
| D1 (ad/bits `Stat`) to D2 (3 `valueClass` sites), D1 AdHeader (1), and C7, C8, C9 (imports) | **`valueClass` prop flows into className** | same W6 | **F06** |
| D5 (DetailHeader) to D6, D7 | component | same W6 | F11 |
| D7 (PublisherHeader/Sections) to C10 | component | same W6 | F11 |
| E1 (RaposaButton, RunState, Sampling) to C3 (4 sites), C13, E8, E9; and B7 (2 sites, W5) | merge sites; components | same W6 (W5 for B7, caller first) | No state collisions, so order does not matter. F11. |
| E2 to C13, E9; E3 to C11, D4, D6, E4, E5, E6; E4 to E6; E5 to C10; E6/E7/E8/E9 to C13 | components | same W6 | F11. No collisions. |
| F8 (DomainLink) to 18 caller files (22 sites) in B5, C3, C4, C9, C13, D1, D6, D7, D8, E5, E6, E7, E9, F2, F7 | merge sites; 8 sites in 7 files override `hover:` | W8, after every caller | OK. Verified that the hover override is the only live state collision and that every caller file is converted by W7. |
| C7 (`lib/time_series_econometrics.ts`) to `lib/series.ts` (server, used by API routes) | shared module | n/a | Must not gain a CSS module import (N06). |

**D29 verdict.** No file is edited by two tasks in any wave: the 112 FILES are distinct, T5's extra files (globals.css, layout.tsx) are in W2, and C7's lib file is its own. The literal D29 claim holds. Its intent does not: the 29 same-wave importer/imported pairs above (W5: B3/B7, B3/B8, B4/B3, B4/B7, B5/B3, B5/B4, B5/B7, B5/C1, B6/B2, B6/B4, B6/B8, B7/B3, B7/B4, B7/B8, B8/A3, B8/A4, B8/B2, B9/B6, B9/C2, C1/B1; W6: C10/D7, C10/E5, C11/E3, C13/E1, C13/E2, C13/E6 to E9, C3/E1, C7/D1, C8/D1, C9/D1, D2/C8, D2/C9, D2/D1, D4/E3, D5/C3, D6/D5, D6/E3, D7/D5, E4/E3, E5/E3, E6/E3, E6/E4, E6/E7, E8/E1, E9/E1, E9/E2) are first checked together at the gate (F11). None of them has a twMerge state collision, so composition does not depend on order. The remaining risk is a hand-resolved child (DYNAMIC or CVA work) whose specificity differs from what the caller's codemod predicted.

---

## 2. Per-task self-consistency (77 rows)

"Root OK" means every command in the task runs from the repo root through `S`/`PNPM`/`git -C`, as AGENTS rule 4 requires. I verified that `npx -y pnpm@12.5.1` works from the root and fails with EBADDEVENGINES from `site/`.

| Task | Self-consistent? | Notes |
|---|---|---|
| T1 | yes | Root OK. All versions exist. It cannot use the per-task branch of constraint 1 because `css-modules` does not exist yet (N14). The exclude misses the fixtures (N13). |
| T2 | mostly | The 20 table cases and 7 extra cases agree with Tailwind 4.3.3 output and with each other (spot-checked: ring+shadow, space-x, transition, tw-animate, peer, group, hover:none, print, data-state, important, `checked:bg-[url(` gives null). The "important on incoming" case calls `one()`, which returns strings (N12). Step 2's expected error assumes helpers.mjs exists. Named groups and forced-colors are untested (N03, F02). |
| T3 | mostly | The Chip golden follows R-d/R-f and the emit order. emit.test's "exactly the text … for those rules" is underspecified (N12). The convert golden must run on a temp copy because convert rewrites in place (N12). The Step 5 expectations miss label's CVA and chart's UNSUPPORTED-VARIANT, and may count 111 (N01). |
| T4 | mostly | The check tests use T3's ids. Smoke step 5 contradicts DIRECTIVE "in any CSS" (F09). The merge-site test needs the equal-specificity order rule stated (N12). |
| T5 | yes | All 9 expected lines match tailwindcss/theme.css 4.3.3 and tw-animate 1.4.0 (12 `@property`, `enter`/`exit` bodies). D9 has 101 names. Placing the import after ember-theme is valid. F07 is about D9 content, not T5 itself. |
| T6 | partly | run.mjs spawn cwd (F03). `probe` base server unowned (F04). Handler precedence (N16). The interfaces are otherwise coherent: `#user`/`#password`, `?print=0`, the view-mode keys and `/healthz` exist, and healthz needs no DB. |
| T7 | yes | Endpoints match the routes. Precedence with T11 (N16). Parallel probe (F04). |
| T8 | yes | The same parallel-probe caveat applies (F04). Include one operator name long enough to truncate so F01 is pinned. |
| T9 | yes | `POST /api/watching` versus T11's GET (N16). |
| T10 | yes | The `ASSET_HASH` must be a UUID (proxy.ts `ASSET_PATH`). |
| T11 | yes | (N16) |
| T12 | yes | n = 60 + 65 + 30 (+1 setup). |
| P1 | yes | The cva keys match the shape (6 variants, 4 sizes; badge 4). ROUTES ad,export match the closure. |
| P2 | no | The note misses FoxIcon's default `className = "size-4"`. The repo has `[@media(hover:none)]:opacity-60`, not opacity-100. The named group `group/opname` is not covered (N03). className-as-data (F01). |
| P3 | partly | Unused `momentumClass()` returns Tailwind strings and will trip TW-STRING. format.ts line 40's "Tailwind" comment will fail R1 step 6's grep (N02). |
| A1 | partly | label.tsx uses `cva` (no variants), but only CROSS-FILE-GROUP is mentioned (N01). |
| A2 | yes | The `xl:max-w-6xl` in sheet is not mentioned in the notes. It folds into desktop like the other `xl:` uses. |
| A3 | yes | |
| A4 | yes | Tooltip is in the layout closure through Providers, so ROUTES all is correct. |
| A5 | yes | |
| A6 | no | `[&_.recharts-*]:outline-hidden` produces forced-colors media that no rule allows (F02). |
| A7 | yes | Children-first TableRow collision, invisible (N18). |
| A8 | yes | |
| A9 | yes | |
| B1 | yes | ROUTES lists `ads`, which is not in ember/ui's import closure (harmless extra, N22). |
| B2 | yes | |
| B3 | yes | The function-local `fill`/`common` are identifiers the extractor resolves. |
| B4 | partly | The note "group-hover becomes a same-file ancestor class" is wrong: cards.tsx has two `group` markers and no `group-*` consumer (N04). |
| B5 | yes | F11 |
| B6 | yes | |
| B7 | yes | |
| B8 | yes | |
| B9 | yes | |
| C1 | yes | The `!` is redundant: `.ember` background sits in `@layer base`. |
| C2 | yes | |
| C3 | partly | Caller of OperatorLink with `truncate` (AdRadarSignalView) (F01). |
| C4 | partly | No `ROW` constant exists, only `HEADER_LABEL` (N05). Two `truncate` callers (F01). |
| C5 | yes | |
| C6 | yes | |
| C7 | partly | The lib file must get no module (N06). |
| C8 | yes | |
| C9 | yes | |
| C10 | yes | |
| C11 | yes | |
| C12 | yes | Its `2xl:` use is the only wide-tier rule (F08). |
| C13 | yes | |
| D1 | partly | `valueClass` passthrough is not modeled by T3 (F06). |
| D2 | partly | Its "style map" is really 3 `valueClass` caller sites (F06, N05). |
| D3 | yes | |
| D4 | yes | |
| D5 | yes | |
| D6 | yes | |
| D7 | partly | `truncate` caller (F01). |
| D8 | partly | Two `truncate` callers (F01). |
| E1 | yes | |
| E2 | yes | |
| E3 | yes | |
| E4 | yes | |
| E5 | yes | |
| E6 | yes | The `matchMedia("(max-width: 1023px)")` at line 253 is confirmed. |
| E7 | yes | |
| E8 | yes | |
| E9 | partly | `truncate` caller (F01). |
| F1 | yes | |
| F2 | yes | |
| F3 | yes | |
| F4 | yes | |
| F5 | yes | |
| F6 | yes | |
| F7 | partly | `truncate` caller at watching/page.tsx:248 (F01). |
| F8 | yes | All 18 caller files are converted in W5 to W7. |
| G1 | partly | Step 2 ordering (F05). Step 1 repeats the per-task merge the worktree protocol already does. |
| G2 | partly | (F05) |
| G3 | partly | (F05). Step 8's metric is not defined by convert (N01). |
| R1 | yes | Deletion granularity (N17). |
| R2 | partly | Section numbering and coverage (N09). |
| R3 | partly | Staging health 200 vs 401, and pnpm 10 on PATH (N10). |

---

## 3. Facts verified against reality

| Fact | Result |
|---|---|
| `npm view` through the proxy | All exist: `@tailwindcss/node@4.3.3`, `recast@0.23.11`, `postcss-selector-parser@7.1.0`, `@babel/parser@7.29.9`, `clsx@2.1.1`, `@playwright/test@1.56.1`, `pnpm@12.5.1`, plus `tailwindcss@4.3.3` and `tw-animate-css@1.4.0`. |
| pnpm 12.5.1 installs and runs | `npx -y pnpm@12.5.1 --version` printed 12.5.1 from the repo root. From `site/` it fails with `EBADDEVENGINES`, so constraint 2 is true. The `pnpm` on PATH is **10.28.0** (`/opt/node22/bin/pnpm`). |
| `__unstable__loadDesignSystem` / `candidatesToCss` in @tailwindcss/node 4.3.3 | Inspected the tarball. `index.d.ts` declares `__unstable__loadDesignSystem(css, { base }): Promise<DesignSystem>`, `DesignSystem` has `candidatesToCss(classes): (string \| null)[]` and `theme`, and `index.mjs` exports it. It also ran in a scratch dir with BASE's globals/ember/ember-theme CSS. |
| Route count 15 | Yes. 15 `page.tsx` files, one for each RouteKey (`proxies` is a redirect). |
| Styled files 112 | Yes. 109 files with `className` (excluding `app/api`) plus `spy/stage.ts`, `spy/format.ts` and `lib/time_series_econometrics.ts`. Every one is in exactly one task's FILES. |
| `xl:` count 13 | Yes. 11 grid templates plus 2 max-widths (`sheet xl:max-w-6xl`, `InvestigationScreen xl:max-w-[640px]`). `2xl:` appears once, in skeletons.tsx. |
| Chromium at /opt/pw-browsers | `chromium-1194` and `chromium_headless_shell-1194`, both INSTALLATION_COMPLETE. playwright-core 1.56.1 `browsers.json` wants chromium 1194 (141.0.7390.37). `PLAYWRIGHT_BROWSERS_PATH` is set globally. |
| D9 (101 tokens) | The count is 101. The non-tw, non-ember theme vars referenced by the repo's candidates are exactly D9's palette, fonts, text, tracking, radius, container, blur, ease, duration, spacing and animate entries (shadows come from the R-h mapping). The 19 shadcn names are compiled inline as `hsl(var(--x))` (F07). |
| D10, D11, D13, D14 | No `dark:` variant. The only cross-file group or peer is label/checkbox. All 14 ui files plus VelocitySparkline and skeletons are unimported (card/table/skeleton are imported only by skeletons). `badgeClass` appears only in the lib file. |
| D31 and Review Focus 1 | A twMerge scan of every component call site finds DomainLink `hover:text-ember-t1` (8 sites, 7 files) and TableRow (unused skeletons) as the only state collisions. |
| D4's "8 components with responsive self rules" | 8 elements: VoiceFeedbackButton, EmberPage, ListImage, DialogContent/Header/Footer, SheetHeader/Footer. None of their callers passes className. |
| ROUTES columns | The import-closure graph (layout closure goes to every route) matches all 56 conversion tasks' ROUTES. The one difference is B1's extra `ads`. |
| CI / tsc | CI is green on master. TS 7.0.2 errors on `.css` imports without declarations (TS2307/TS2882, reproduced). `next`'s `types/global.d.ts` declares `*.module.css`, so CI's tsc stays green once modules exist. |
| Hub validateStyle compatibility | All ~100 CSS properties Tailwind emits for this repo are known to the hub's css-tree 3.2.1. No used candidate yields `!important` on an incoming element, a backslash, a brace or `url(`. The only `!` is on Header, which is not incoming, so the `!` is dropped. |
| Google Fonts (next/font at build) | Reachable through the proxy (`fonts.googleapis.com` returned 200). |
| Capacity | 4 CPUs, 15 GB RAM, 23 GB free on `/`. |

---

## 4. Findings with rulings

### F01 (blocking): OperatorLink reads the caller's className as data
`src/components/OperatorLink.tsx:69` has `const clips = /\btruncate\b/.test(className ?? "");`. When it is true, the pencil wrapper becomes `inline-flex min-w-0 max-w-full items-baseline` and the name truncates. Eight call sites in seven files pass `truncate`: AdRadarSignalView:41 (C3), MarketPulseStrip:150 and AdRadarTableView:87 (C4), PublisherSections:150 (D7), PublisherViews:82 and :194 (D8), InvestigationCard:213 (E9), watching/page.tsx:248 (F7). Once a caller converts, `className` becomes a hashed module class, `clips` is false, the wrapper goes inline, and `truncate` on the inline `<a>` stops working. Long names overflow instead of truncating.

No codemod rule or static check sees runtime string tests. Parity catches it only if a fixture name is long enough to truncate. SCP's "every … prop … unchanged" prevents the obvious fix. No other className-as-data site exists: I grepped `.test(className`, `className.includes/split/match`, `classList` and `closest`/`querySelector` on classes.

Ruling: P2 adds an optional `truncate?: boolean` prop to OperatorLink (additive, so constraint SCP "props unchanged" gets this one recorded exception). During the migration it keeps `clips = truncate ?? /\btruncate\b/.test(className ?? "")`. Each caller task above passes `truncate` wherever its BASE className for OperatorLink contains `truncate`. F8 or G3 removes the regex fallback. T8 adds an operator name long enough to truncate so parity pins the behaviour. — This is the only way to keep both callers and child correct in every mixed state, and to keep the result free of Tailwind tokens. — If wrong: up to 8 views lose name truncation, possibly unseen by parity, and ship to production.

### F02 (should-rule): `forced-colors` media from `outline-hidden`
Tailwind 4.3.3 compiles `outline-hidden` to `outline-style: none` plus a nested `@media (forced-colors: active) { outline: 2px solid transparent; outline-offset: 2px }` (verified). ui/chart.tsx uses it three times (`[&_.recharts-layer|sector|surface]:outline-hidden`). The resolver's `Ctx.media` has no forced-colors. T3 step 5 says no UNSUPPORTED-VARIANT is expected. Constraint 4 and the MEDIA guard forbid this media. A6 cannot satisfy all three.

Ruling: add `(forced-colors: active)` to constraint 4's list of allowed non-width media (standalone or nested), to the MEDIA guard, and to `Ctx.media` (tried only when a class uses it). Add a T2 test for `outline-hidden`. — This keeps exact Tailwind output and the high-contrast accessibility behaviour, and the hub never sees it as a width tier. — If wrong (we drop the rule instead): Windows high-contrast focus outlines on recharts change. There is no visual parity impact.

### F03 (should-rule): run.mjs spawning PNPM/npx from `site/`
SCP-7 runs `S node tests/parity/run.mjs …`, so its cwd is `site/`. `compare` "builds the current checkout (`PNPM --filter site build`)". From `site/`, `npx -y pnpm@12.5.1` fails with EBADDEVENGINES (verified). The same applies to running `npx playwright`.

Ruling: T6 states that run.mjs spawns `PNPM` with `cwd` set to the repo root (`path.resolve(siteDir, "..")`, or the base worktree root), and spawns Playwright as `node <site>/node_modules/@playwright/test/cli.js` (never `npx`). It also sets `NEXT_TELEMETRY_DISABLED=1` for builds (N20). — Constraint 2 and AGENTS rule 4. — If wrong: every SCP-7 fails until someone patches run.mjs mid-wave.

### F04 (should-rule): who builds the BASE server before T12
`probe` "runs against the base server", but only `baseline` "ensures `$PARITY_DIR/base` … install … build". T6 step 3 and T7 to T11 (five tasks in parallel in W2) all need a base server. If each one creates or builds `$PARITY_DIR/base`, they race on the same worktree and `.next`.

Ruling: add a `run.mjs prepare-base` mode, idempotent and guarded by a lock file in `$PARITY_DIR`. It creates the worktree at BASE, installs and builds. T6 runs it once and commits nothing for it. `probe`, `selftest` and `compare` treat `$PARITY_DIR/base` as read-only and fail with a clear message if it is missing. — There is one owner and no parallel writers. — If wrong: corrupted builds in W2 and flaky probes.

### F05 (should-rule): G step 2 moves BASE after reconverting
G step 2 reconverts each master-changed, already-converted file with SCP-1 to SCP-6. It only then writes the new sha to `BASE`. But convert reads the design system and externals from BASE, and check.mjs reads `oldCode` with `git show <BASE>:…`. With the old BASE, check.mjs compares master's new structure against the old file, which fails as a "structure change". Also unhandled: master changes to `site/package.json` or `pnpm-lock.yaml` (conflicts with T1), to global CSS (conflicts with T5's globals.css lines), and a Tailwind version bump on master (the codemod pins `@tailwindcss/node@4.3.3`).

Ruling: change the order to: merge `origin/master`, then write the new BASE, then reconvert the listed files, then run `baseline --force`, then commit. Resolve lockfile and package.json conflicts by taking master's version and re-running T1's `PNPM --filter site add -D …`. Resolve globals.css by reapplying T5's two imports. If master's tailwindcss version is no longer 4.3.3, stop and hand up. — BASE must equal the source the reconversion is checked against. — If wrong: each gate after a master change stalls in a J-model debugging loop. Several PRs a day land on master.

### F06 (should-rule): class props other than `className`
`ad/bits.tsx:72` has `cn("ember-type-mono-stat-l truncate tabular-nums text-ember-t1", valueClass)`. Callers pass `valueClass="text-ember-muted"` (TrackingPanel ×3, D2) and `valueClass={… "text-ember-accent" …}` (AdHeader, D1). T3 marks an element incoming only when "the component's own `className` prop flows into this element", and only `className` attributes are caller sites. Two things follow. bits' own `color` is emitted at (0,1,0) and ties, by undefined module order, with the caller's class. And the caller's `valueClass` strings stay Tailwind, so SCP-5 TW-STRING fails.

Ruling: extend T3 so that any destructured prop whose name matches `/^[a-z]+Class(Name)?$/` and flows into a className is treated like `className` (incoming, with `mergeTarget` call sites). Add an extract test with `valueClass`. — `valueClass` and `labelClassName` (ui/chart) are the only such props, so the rule is small. — If wrong: D1 and D2 go to the stronger model, or the color loses non-deterministically.

### F07 (should-rule): the shadcn `--color-*` tokens are dead
globals.css declares the 19 shadcn colors in `@theme inline`, so Tailwind compiles `bg-background` to `background-color: hsl(var(--background))` (verified). There is no `--color-background` reference. R-h says "all other theme variables are kept", so modules will contain `hsl(var(--x))` and color-mix of it. T5 still writes 19 `--color-*` tokens that nothing uses. R2 tells readers to use `var(--color-background)`. The hub would see raw values, not tokens.

Ruling: add an R-h row that maps `hsl(var(--X))` to `var(--color-X)` for the 19 names, including inside color-mix. Add one T2 test (`bg-background/80` gives `color-mix(in oklab, var(--color-background) 80%, transparent)`). — It makes D9, R2 and the hub token story true, at no visual cost because the values are identical. — If wrong: 19 dead tokens, and docs that contradict the code.

### F08 (should-rule): the wide tier is not readable by the hub
`export.ts` `BREAKPOINTS` has only tablet `(max-width: 1023px)` and mobile `(max-width: 599px)`. `NodeStyle` is `{base, tablet, mobile}`, matching spec §5.1. Constraint 4 adds `(min-width: 1536px)`, and D2's own cost line says "min-width queries … the hub cannot read". The only `2xl:` use is `skeletons.tsx:176` (`2xl:grid-cols-5`), and no route renders that file.

Ruling: keep the wide tier and the wide parity device, which give zero visible change, as the brief requires. Record in D23's adoption notes that the extractor must ignore or flag `(min-width: 1536px)` blocks, and that today the only one is in unused skeletons.tsx. Alternatively, if the owner deletes skeletons.tsx (A3 kept it), drop the tier. — There is no visible cost either way, and it is one hub line. — If wrong: the hub extractor rejects one module at adoption.

### F09 (should-rule): check-styles mode scope
The table scopes PACKAGE to `--final` and TW-STRING to `--final`/listed files. DIRECTIVE ("in any CSS") and UNDEFINED-VAR (which global files?) have no scope. Before R1, globals.css still contains `@import "tailwindcss"`, `@custom-variant` and `@theme`, and ember-theme.css contains `@theme`. toaster.css uses sonner's runtime vars `--lift`, `--offset` and `--y`. T4 step 5 (`--converted` prints nothing) and gate step 4 would fail.

Ruling: in `<files>` and `--converted` modes, check only the modules and their paired sources. DIRECTIVE scans global CSS only in `--final`. UNDEFINED-VAR applies to `*.module.css` only. Add one check-styles test that shows `--converted` ignores the Tailwind directives in globals.css. — This matches the guard's purpose: global CSS becomes Tailwind-free only at R1. — If wrong: T4's smoke step and every gate fail on files no task may touch.

### F10 (should-rule): parallelism against the machine
The machine has 4 vCPUs, 15 GB RAM and 23 GB free. Each SCP runs `next build` (Turbopack, multi-core, about 2 to 3 GB), then `next start`, then Playwright with `workers: 4` at four sizes. W5 has 20 tasks and W6 has 28, all "parallel".

Ruling: the coordinator allows unlimited parallel agents for SCP-1 to SCP-5, but SCP-6 and SCP-7 (and run.mjs builds) pass through a lock that admits at most 2 at a time. Use `flock $PARITY_DIR/build.lock` in run.mjs or the coordinator. — Screenshot timing and determinism degrade under CPU contention, and OOM kills look like test failures. — If wrong: only wall-clock time is lost.

### F11 (should-rule): same-wave pairs are not rechecked after the rebase
For every pair in section 1b's D29 verdict, the consumer's SCP-4 and SCP-7 ran with the producer still Tailwind. The worktree protocol rebases and fast-forwards with no re-validation.

Ruling: in protocol step 3, after `git -C ../wt/<id> rebase css-modules`, rerun SCP-4 and SCP-5 for the task's FILES inside the worktree. These are static, about seconds each, and use the now-converted children. Fast-forward only if they pass. Leave visual parity to the gate. — It catches a producer's hand-resolved specificity drift at the task that owns it, not at the J gate. — If wrong: gate failures with diffuse ownership.

### F12 (should-rule): convert rerun semantics
The DYNAMIC rule ("add a map … rerun convert.mjs") and the COMPOSE-UNKNOWN-CHILD rule ("rerun with --merge-child") both assume convert can run again. By then the file has already been rewritten to `clsx(styles…)`, and the module already exists.

Ruling: SCP-2 says that for these two codes, the executor first runs `git checkout -- <file>` and deletes its module (restoring task start), then edits the Tailwind source (adds the `Record` map) or picks the flag, then reruns convert. T3 makes convert refuse a file that already imports its own module, unless it gets `--force`. — It keeps "codemod output is the exact starting point" true. — If wrong: lost module rules, or double-converted files, on Haiku tasks.

### F13 (should-rule): the static proof shares code with the converter
check.mjs computes both "expected" and "actual" with T2's `cascade()` and `rulesForClass()`. A bug in layer order, `:where`/`:is` specificity or media matching would be invisible to the static check. D13 has about 2,000 converted lines (14 ui files, VelocitySparkline, skeletons, plus the unused StageBadge component) that only the static check proves.

Ruling: T4 adds `cascade.chromium.test.mjs`. It renders 10 to 15 fixture elements (covering layers, `:where`, `.x.x:hover`, `(hover: hover)`, print, `:is(:where(.group):hover *)`, `:where(& > :not(:last-child))`) in Chromium 1194 with `getComputedStyle` (forcing `:hover` through CDP), and asserts that `cascade()` agrees. — That makes the simulator independently pinned once, cheaply. — If wrong: an unused file ships with a subtle cascade error that nobody sees until it is used.

### Notes (each with a ruling)

- **N01.** T3 step 5's expectations are incomplete. `ui/label.tsx` also uses `cva` (so CVA appears in 4 files). ui/chart produces UNSUPPORTED-VARIANT (F02). The badgeClass strings sit inside a function in time_series_econometrics.ts, so `--all` may count 111. SCP-1's summary format and G3 step 8's "elements still carrying Tailwind" are not part of T3's interface. Ruling: amend T3 step 5 and the interface (summary line exactly as SCP-1; add a `tailwind_elements` report column) — prevents a J agent "fixing" correct behaviour — cost: a confused T3 run.
- **N02.** P3: `creative/StageBadge.tsx` exports the `StageBadge` component and `momentumClass()`, and both are unused. `momentumClass` returns Tailwind strings that TW-STRING will flag. `spy/format.ts:40`'s comment "Tailwind text colour" fails R1 step 6's grep. Ruling: P3 converts `momentumClass` to module classes (D13: convert, don't delete), updates both comments, and D13's list gains StageBadge/momentumClass — keeps the "unused" inventory honest — cost: a late R1 grep failure.
- **N03.** P2: FoxIcon's `className = "size-4"` default parameter is Tailwind (it becomes `className = styles.root`). The repo has `[@media(hover:none)]:opacity-60`, not opacity-100. `group/opname` is a named group: Tailwind emits `:where(.group\/opname)`, and no T2 or T3 test covers mapping it to a same-file class. Ruling: add a named-group case to T2 and the emit tests, and fix P2's notes — the pilot exists to find this, but a test is cheaper — cost: one pilot retry.
- **N04.** B4 has no `group-*` consumer. The `group` markers in cards.tsx (two) and PublisherSections.tsx (one) are dead. R-j keeps allowlisted `group`, while constraint 11 allows `group` only where D11 does. Ruling: a `group`/`peer` marker with no consumer is dropped as `no-css`; fix B4's note — removes the codemod/guard disagreement — cost: a TW-LITERAL failure in B4/D7.
- **N05.** C4 names a `ROW` constant that does not exist (only `HEADER_LABEL`). D2's "TrackingPanel's style map" is really the `valueClass` sites (F06). Ruling: correct the notes — cost: executor confusion.
- **N06.** C7: `lib/time_series_econometrics.ts` is imported by `lib/series.ts`, which serves API routes (`creatives-server`, `operators-server`). Removing `badgeClass` leaves no styling. Ruling: C7 edits the lib file by hand, runs no convert and creates no module, and its SCP-5 lists only AdVelocityChart — avoids a CSS import in server code — cost: a build or route error, or an empty module.
- **N07.** SCP-5 asks for "exits 0 with no output", but UNUSED-CLASS prints warnings. Ruling: SCP-5 passes on exit 0, and UNUSED-CLASS warnings must be explained in the commit body — cost: false stops.
- **N08.** Constraint 18 uses `S next build`, which bypasses the R1 guard. Ruling: from R1 on, the build check is `PNPM --filter site build` (the CI step) — cost: guard regressions slip past R2 and R3.
- **N09.** R2: DESIGN_GUIDELINES already has §7 ("Strict Emoji Prohibition"). §6's title is "Official shadcn/ui Standard Usage (No Alterations)", which D33 contradicts. Line 38 is in §2, not §3 as D22 says. Tailwind class names also remain at DESIGN_GUIDELINES lines 22, 76 and 84 and AGENTS line 265, which R2's grep does not cover. AGENTS rules 2 and 3 are the owner's "Non-Negotiable" directives. Ruling: add "Styling" as §8 (or renumber), reword §6's title, extend R2 to those lines, and call out the AGENTS rule changes in the PR body — cost: stale docs and an owner surprise.
- **N10.** R3: deploy-staging's own health step accepts 401 or 200, but the plan requires 200. The `pnpm` on PATH is 10.28.0, so `staging-add` with checks would run pnpm 10 against a pnpm-12 `node_modules`. There is no path for "owner declines": AGENTS 3.1a then requires a force-rebuild of `staging`. Ruling: accept 401 or 200; always run the PNPM checks and then `scripts/staging-add --no-check`; add a decline path that asks the owner before any force-push of `staging` — cost: a false failure, or an unasked force-push.
- **N11.** Duplicated logic (review rubric): the R-h token table would live in resolve.mjs, gen-tokens.mjs and check.mjs, and the className walker in extract.mjs and check-styles.mjs. Ruling: one `tokens-table.mjs` that the three import. check-styles.mjs exports its walker, and extract.mjs imports it, because check-styles outlives tw2css — cost: drift between proofs.
- **N12.** Test-text gaps. T3's emit.test "exactly the text in the Chip golden for those rules" needs its own golden string. T2's "important on incoming" must call `resolveElement`, not `one()`. `--explain` needs `one()` moved out of the test file (into helpers.mjs). The convert golden test must copy the fixtures to a temp dir. T4 must state that a child module wins ties at equal specificity, or the merge-site test cannot fail. Ruling: amend the task texts — prevents tests that assert nothing or test the wrong thing — cost: weak tests.
- **N13.** The tsconfig `exclude: ["node_modules","tests"]` does not exclude `scripts/tw2css/tests/fixtures/*.tsx`. App tsc and next build compile them. They pass today, because next types declare `*.module.css`. Ruling: exclude `scripts` too — cost: a fixture edit breaking CI's tsc.
- **N14.** T1 runs on `css-modules` itself, an obvious exception to constraint 1. The overflow probes (700, 1100) do not cover the 600 to 639 range D2 changes. Ruling: note T1's exception, and add a `gap620` project — cost: an unprobed range.
- **N15.** Hub alignment. `cssForDevice` filters the hub's own exported CSS, not module text, so D2's claim is imprecise but harmless. The future extractor must parse `:where(.x)`, `.x.x:hover`, combinator and state selectors, and `(hover: hover)`/print/reduced-motion blocks. validateStyle compatibility is verified (section 3). Ruling: add these to D23's adoption notes — cost: an adoption-time surprise.
- **N16.** `mock-api` handler matching is not specified (first match, method required?). T7 `/api/watching/unread`, T9 `POST /api/watching` and T11 `/api/watching` overlap. Ruling: exact-path or anchored regex, method compared when present, first match in concatenation order, and duplicate handlers are an error in `selftest` — cost: wrong fixture bodies, or flakes.
- **N17.** R1 step 3: a declaration reported dead in one context may be live in another (for example hover vs base). Ruling: delete it only from the reported context's rule, or split the rule — cost: a lost style.
- **N18.** Transient mixed states that are not shipped. A7's TableRow converts before C12's callers (children-first collision, unused file). C1's Header container and F1's layout container differ at 600 to 639 px between W5 and W7. Ruling: accept, since no gate captures these widths and the final state is consistent — cost: none.
- **N19.** tokens.css defines a global `--color-border`, while ui/chart uses a local inline `--color-border` (and `--color-bg`). Where the inline var is not set, `var(--color-border)` is undefined at BASE but defined after T5. The chart is unused, so nothing is visible. Ruling: accept and mention it in A6's notes — cost: none today.
- **N20.** `next build` sends anonymous telemetry. Ruling: `NEXT_TELEMETRY_DISABLED=1` in run.mjs and the worktree environment — cost: minor.
- **N21.** The pins `recast@0.23.11` and `postcss-selector-parser@7.1.0` are older than the lock's transitive 0.23.21 and 7.1.6, so the lock gains duplicates. Ruling: accept (recast is removed at R1) — cost: none.
- **N22.** B1's ROUTES includes `ads`, which is not in ember/ui's import closure. Ruling: accept (an extra route only costs time) — cost: none.

---

## 5. Outside-world and irreversible steps

| Where | Step | Effect | Gate |
|---|---|---|---|
| T1, G step 2, R3 step 1 | `git fetch origin [master]` | read | none needed |
| every worktree, T1, R1 | `npx -y pnpm@12.5.1 …`, `PNPM install/add/remove` | npm registry reads through the proxy | none |
| every build | `next build` | fetches Google Fonts, and sends Next telemetry unless disabled (N20) | none; disable telemetry |
| G1, G2, G3 step 7 | `git push origin css-modules` | creates or updates the remote branch. No workflow triggers: ci runs on pull_request or a push to master. | Ruling A1 (proceed) |
| R3 steps 3 and 4 | `git push -u origin css-modules`; `gh pr create` | PR visible to the owner; CI runs | Ruling A1 (proceed) |
| R3 step 5 | `scripts/staging-add` | merges master into the branch, pushes the branch, merges into the **shared `staging` branch** and pushes it | **owner** (controller already holds this) |
| R3 step 5 | `gh workflow run deploy-staging.yml --ref master -f ref=staging` | deploys to staging.adhunters.pro, which shares the **production database** | **owner** |
| R3 step 6 | `gh pr merge --auto --squash` | merge to master triggers `deploy-site` and a **production deploy** (rsync to old-collector, restart of app.adhunters.pro). Undoing it takes a revert and a redeploy. | **owner approval** (plan says so) |
| R3 step 6 | `git switch staging && git merge origin/master && git push` | pushes the shared `staging` branch | after the owner's merge |
| Not in plan (N10) | owner declines: rebuild `staging` without css-modules | **force-push of the shared `staging` branch** (AGENTS 3.1a) | **owner** |
| R1 | deletes `postcss.config.mjs`, `components.json`, `ember-theme.css`, `lib/utils.ts`, `scripts/tw2css/` | these files are tracked on master. They leave master only through the PR merge. | reversible through git; reaches master only at merge |
| G step 2 | `git checkout origin/master -- <file>` plus deleting its module | discards this branch's own conversion of that file | own work only |
| run.mjs `baseline --force`, worktree removals, `$PARITY_DIR` | overwrites snapshots, removes worktrees | local and own (`/tmp`, `../wt`) | none |

No step pushes to `master`, runs `bootstrap-old-collector`, `ops-status` or any ssh, or deletes anything outside this branch's files, apart from the owner-gated steps above.

---

## Appendix: how the facts were checked
- Scratch lab (outside the repo): BASE `globals.css`, `ember.css` and `ember-theme.css` from `git show f79b876:…`, loaded with `__unstable__loadDesignSystem(css, {base})`. I ran `candidatesToCss` on every whitespace token of every string in `site/src` (excluding `app/api`), which gave 1,008 candidates. From those I collected the theme vars, media queries and properties used.
- Babel scans (`@babel/parser` 7.29.9) of `className` sites gave: incoming elements with responsive classes, component call sites, `twMerge(child, caller)` state collisions, cross-task merge counts, Tailwind strings outside className/top-level constants, and className-as-data uses.
- An import-closure graph (relative and `@/` imports, type-only imports skipped) gave route membership per styled file and the same-wave import pairs.
- I ran TypeScript 7.0.2 against a CSS-module import with no declarations, and read next 16.3.5's `types/global.d.ts`.
- `npm pack` (scratch) of @tailwindcss/node 4.3.3, tailwindcss 4.3.3, playwright-core 1.56.1 and next 16.3.5, then inspected their exports and files.
- `gh run list` (read-only) to confirm CI is green on master.
