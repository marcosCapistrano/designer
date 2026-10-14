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
