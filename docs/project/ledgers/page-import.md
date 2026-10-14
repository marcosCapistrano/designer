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

Task 1 is the first focused PR, not a completed Design import flow. Continue on the same plan with incremental source hashes and operation replay, atomic persistence, shared components and source gaps, then authenticated server/render/canvas integration. Do not resume adhunters-v4 conversion or staging.
