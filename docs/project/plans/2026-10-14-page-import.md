# Page import

Source: spec §5.4; architecture contract `packages/sync`. adhunters-v4 conversion is paused; do not touch that checkout, deploy, or use its staging database.

Implement in focused tasks:
1. Static source importer: explicit React route entries and Next App Router discovery; JSX and CSS Modules/plain CSS; deterministic IDs, dependency hashes, diagnostics. No source execution.
2. Incremental synchronization: reuse unchanged pages, replay pending operations, expose conflicts without losing edits, canonical files and failure-safe persistence.
3. Authenticated server endpoint and tablet Design import control; prevent imports during Build, show unsupported-source diagnostics. Render the imported pages through the existing renderer.
4. Fixture tests, full typecheck/CI, PR for user merge.

Rulings:
- Git history confirms PR #3 is merged. The handoff prompt's pending-merge statement must be updated.
- First importer accepts only statically resolvable JSX. Dynamic content is reported explicitly; subscription-backed gap filling is a later focused extension using the existing ClaudeRunner, never an API key or source execution.
- Never interpret utility classes as CSS. CSS declarations must come from plain CSS/CSS Modules or static inline style.
- Do not silently approximate unsupported selectors, media queries, external components or dynamic JSX. A failed import leaves the old design intact.
- IDs derive from route, component source path and JSX tree path, not source character offsets. Separate page occurrences are namespaced so model IDs remain globally unique.
- Only one implementation plan is being added: page import. Existing Deploy/New app plan remains deferred.
