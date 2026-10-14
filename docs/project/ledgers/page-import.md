# Page-import ledger

Plan: `docs/project/plans/2026-10-14-page-import.md`.
Base: `ed55a88` (PRs #1–#4 merged). Branch: `feat/page-import-extractor`. PR: [#5](https://github.com/marcosCapistrano/designer/pull/5).

## Task 1 — static extraction foundation

- Added `@hub/sync` with a pure source-string API, explicit React route entries, and Next App Router discovery (ancestor layouts, groups, dynamic paths).
- Reads statically resolvable JSX/component props and CSS Modules/plain CSS. Model validation gates every result; failure returns diagnostics and no partial document. No filesystem writes, app execution, deployment or AI calls.
- IDs use route + source path + JSX tree path. Classes compile to model styles because `class` is reserved by the model exporter.
- CSS support is intentionally bounded: simple compound selectors, specificity, canonical device breakpoints, inline precedence. Unsupported selectors, utility classes, fallback declarations, shorthand/longhand ambiguities and dynamic content fail explicitly.
- TypeScript 7 in this repo does not expose the classic parser API. Use `@typescript/typescript6` at runtime alongside TypeScript 7 for typechecking. Confirmed by local package exports and Microsoft's [compiler API documentation](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
- Components are expanded per occurrence for this foundation. Shared component definitions/instances remain required follow-up work before page import is complete. Next document shells (`html`, `body`, `head`) currently fail model validation; only model-safe static layouts are supported.
- Updated the saved continuation prompt and README: PR #3 is merged; adhunters-v4 conversion stays paused on draft PR #50; its master merge deploys production and staging shares the production DB.

Validation: 19 importer fixture tests pass; full workspace typecheck passes; server has 1,182 passing tests and one skipped live test; renderer has 94 passing tests; client has 352 passing tests and one skipped manual test. Client build and size check pass (23,993 bytes JS gzip). Local full-suite runs hit existing design-model performance limits (166/192 ms vs 150 ms) and sandbox-blocked Chromium. Browser suites passed outside the sandbox with the downloaded Playwright browser; performance assertions are unchanged. CI remains the required PR gate.
- Final review: preserve a single source element as the page root; do not apply source CSS to the synthetic wrapper required by top-level fragments. Added a regression fixture.

## Remaining tasks

Tasks 1 and 2a are focused PRs, not a completed Design import flow. Continue on the same plan with atomic persistence and external state decoding, shared components and source gaps, then authenticated server/render/canvas integration. Do not resume adhunters-v4 conversion or staging.

## Task 2a — incremental preparation and pending-op replay

- Verified PR #5 commit `d3e73a4`: both GitHub CI runs passed. No external review was present; the PR remains open for the user to merge.
- Follow-up branch `feat/page-import-incremental`, [PR #6](https://github.com/marcosCapistrano/designer/pull/6), is stacked on PR #5 (merge #5 first, then retarget #6 to main). Adds a pure `synchronizePages` preparation API; no filesystem writes or Import control yet.
- Clean baselines retain route configuration, extraction commit and SHA-256 source/CSS dependency hashes. Reuse unchanged pages; shared source changes rebuild dependent pages. A change to the set of available paths conservatively invalidates all pages to catch changed/ambiguous import resolution. Extractor semantics are versioned for cache invalidation.
- Always replay the complete ordered pending log on the clean source baseline, including unchanged pages. Never replay against the previously edited document. Keep edits to added pages/components/tokens in the log too. A changed document advances its sequence once; unchanged replay preserves it.
- Ruling: stop at the first failed operation, expose its index/op/reason and mark the tail blocked. Later operations may depend on the failed edit; skipping it would silently change intent. Failure supplies no replacement state and leaves the entire old document, baselines and log untouched. User-visible conflict resolution remains part of server/client integration.
- This API consumes trusted typed state. External JSON decoding and failure-safe atomic persistence remain the next focused task; shared component extraction and saved preview choices still follow. Preserve the user's existing uncommitted continuation-prompt edit.

Validation: all 30 sync fixture tests pass (11 new incremental/replay cases); full workspace typecheck passes. A local full-suite run has 809 passing design-model tests and the same two unchanged performance failures (174/163 ms vs 150 ms), plus 19 passing protocol tests; recursive execution then stops. CI must confirm the complete suite on the follow-up commit. No thresholds were weakened.

## Task 2b — validated atomic snapshots

- User authorized automatic merging and continued implementation. Verified green heads and merged PRs #5 and #6 without deleting branches. Both complete CI runs on #6 passed, including the unchanged performance assertions.
- Added canonical sync-state file encoding/decoding. External data must have valid routes, source paths, SHA-256 hashes, commits, model baselines and edit operations. The saved document must equal its baseline plus the entire pending log; malformed or mismatched snapshots are rejected.
- Ruling: live snapshots belong in hub-owned storage outside the app checkout. One atomic file contains the canonical design files, baseline metadata and log together; import never dirties the source checkout. Conventional `design/` files will be materialized on the Build handoff branch for review. This avoids partial multi-file writes and preserves Build's clean-checkout protections.
- `FsSyncStore` flushes a private temporary snapshot before atomically replacing the committed snapshot. Revision checks and a single-writer reservation prevent stale/concurrent writes in the single hub process. Corrupt existing state is reported, never overwritten or silently reset. Only private temporary files are cleaned up.
- Validation: 42 sync tests pass, including external-data corruption, stale writes, concurrent writes, failed persistence and restart recovery; workspace typecheck passes.

## Task 3 — authenticated import, rendering and tablet control

- PR #7 (atomic snapshots) passed both full CI runs and was automatically merged under the user's updated authorization.
- Added authenticated Design summary/import/retry-preview endpoints and the tablet Import pages control. Next App Router discovery supports `app`/`src/app`; explicit React entries remain available. Unsupported source diagnostics and pending-edit replay conflicts are visible and preserve the previous snapshot.
- Reads tracked source via git without invoking app scripts. Rejects dirty tracked checkouts, links escaping the checkout, tracked source symlinks, oversized inputs and excessive file counts; never reads hidden files/secrets. Rechecks the source commit and tracked status after reading.
- A synchronous checkout reservation excludes Build and queued retries while import/render is in progress, and imports cannot start during Build. Shutdown waits for reserved work and closes the renderer pool. Fixed the existing readiness/SIGINT race by installing shutdown handlers before startup can announce readiness.
- Save the prepared design atomically, then render all three device frames through the existing renderer/cache. Failed render keeps the saved design and last good imagery, reports warnings, and offers Retry preview. HTTP success refreshes the canvas even if its WebSocket notification was missed.
- Ruling: browser test servers must use separate owned ports and never reuse an existing service. An unrelated process already owned 8787 locally; the test fake now uses 8791 and preview uses 4174. `HUB_DEV_URL` configures the dev proxy while normal development retains its existing default.
- Validation in progress: workspace typecheck and 1,192 server tests pass. Client logic tests passed except a render-fixture check run without the downloaded browser path; that check passed with `PLAYWRIGHT_BROWSERS_PATH=/tmp/hub-pw-browsers`. Client JS gzip remains about 25 KB. Full browser smoke tests and CI are the remaining gates.

## Task 2c — shared definitions and instances

- PR #8 passed both complete CI runs (including performance and the new import browser smoke test) and was automatically merged. Local browser smoke passes after using the source selector's accessible role; two local canvas performance assertions measured about 30 fps against 50 fps and remain unchanged. CI passed those assertions.
- Incremental sync now imports supported source components as shared definitions and linked instances, including nested prop forwarding, string text/attribute props and source defaults. Definitions have IDs independent of page occurrences. Shared edits affect every occurrence, and source component baselines persist/replay with page baselines.
- Preserve lower-level `extractPages` expanded mode for compatibility; explicit `sharedComponents` enables definitions. Incremental sync always enables it and advances the extractor version to invalidate old caches. Existing edits targeting nodes that no longer exist after this representation upgrade are reported as replay conflicts, never silently migrated or discarded.
- Ruling: a shared definition must have one element root and identical source-derived props/CSS across routes. Unsupported children slots, prop-driven styles/classes, non-string props, missing required preview props and literal model-placeholder syntax fail explicitly. Do not invent values or reinterpret source literals.
- Validation: shared-component fixtures cover cross-page links, source defaults, nested instances, global edit propagation, component-source replay, snapshot roundtrip and explicit unsupported cases; full workspace typecheck passes.

## Import read-safety review

- Reviewing the deferred deployment preflight exposed a subtlety: `git status` may run checkout-configured filesystem-monitor or clean-filter commands, violating source import's no-execution guarantee. Replace it with immutable tree/blob reads and direct comparison of tracked source and index entries, with optional locks, object replacement, hooks and fsmonitor disabled.
- Source additions/modifications staged in the index or present in the working tree are rejected. Unrelated non-source dirty files are ignored by import. New untracked files remain outside the selected source commit and are never imported implicitly.
- Added regression cases proving configured fsmonitor/clean-filter scripts do not run, and staged source additions/modifications are refused. This read-only path is still superseded by the deployment plan's privilege-separated mirror access before live deploy credentials are enabled.

## Canvas editing — selection, exact operations and previews

- PRs #9 and #10 passed both full CI runs and were automatically merged. Shared components and safe committed-source reads are now on main.
- Added the tablet element editor for selected styles, literal text and declared instance props. Desktop selections write base style; tablet/mobile selections write their device override. Instance-root hit IDs resolve to both the page instance (local style/prop overrides) and shared definition (global edit, always preview).
- All edits use validated engine operations. Enforce selection boundaries for direct and structural targets, reject stale revisions/selections and internal restore operations, and preserve state on validation failure.
- One selected property on a page applies immediately. Shared/wider edits render candidate images and descriptions without publishing the candidate manifest or saved design, and wait for Apply. Proposals are app/revision-bound, single-use and expire after 30 minutes; Cancel changes no design data. Preview tiles use a separate client cache so they cannot evict committed canvas tiles.
- Persist undo batch boundaries and redo history with the snapshot. Undo rebuilds the clean baseline plus the remaining log; redo restores the exact batch. Every action atomically updates the document/log/history together and re-renders only changed content through the existing hash cache. Source sync clears redo while preserving active pending batches.
- Validation: 1,199 server tests and 51 importer tests pass; workspace typecheck passes. Both browser Design tests pass, including real tap selection, immediate instance edits, undo/redo and a shared preview whose committed manifest remains unchanged until Apply. The browser test waits for the complete history action before reselecting.
- Next: subscription-backed Design chat through restricted MCP tools, source preview choices, and Send to Build. Deployment/New app/Adopt remains after those flows, following the existing preflight.
