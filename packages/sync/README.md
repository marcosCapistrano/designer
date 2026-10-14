# @hub/sync

Static page-import foundation. Reads source strings; never executes an app or calls an AI API.

`extractPages({ files }, [{ route: '/', file: 'web/Page.tsx', exportName: 'default' }])`
returns a validated `DesignDoc` and sorted dependency paths, or source diagnostics with no partial document.
`discoverNextRoutes({ files }, 'app')` supplies entries for Next App Router pages and ancestor layouts.

Supported now:
- Function/arrow components, relative component imports, static props and children, fragments, literal text, simple constants, static inline styles with explicit CSS strings.
- Plain CSS and CSS Modules: compound tag/class/ID selectors, canonical tablet/mobile max-width queries, specificity and inline precedence.
- Next route groups and dynamic route paths; static layouts returning model-safe HTML tags.
- Stable IDs from route, component path and JSX tree position; source classes compile into model style maps.

Unsupported source fails explicitly: dynamic lists/state/fetches, external component adapters, document-shell tags (`html`, `body`, `head`), selector combinators/pseudo-classes, CSS imports/variables defined through at-rules, custom breakpoints, `!important`, repeated fallback declarations, unresolved utility classes. Runtime JSX values are never guessed.

`synchronizePages({ project, entries, commit, previous? })` prepares an incremental `SyncState` containing clean source baselines, the edited document, and its ordered pending operations. Use the actual source checkout commit. Each page baseline records the commit at extraction and SHA-256 dependency hashes. Unchanged baselines are reused; route configuration, extractor version, dependency contents, or available-path changes invalidate the cache. Path changes conservatively rebuild all pages because they may change relative import resolution.

To add an edit, apply it with the design engine and retain the operation in `state.pending`. Sync always replays that log from the clean baselines, including unchanged pages, so structural edits are not applied twice. The document revision advances once when its content changes. Replay stops at the first conflict and reports its zero-based index, operation, reason, and blocked tail. Every failure returns no replacement state: retain the entire previous state and resolve the conflict before retrying. Inputs are never mutated. The API expects a trusted, previously validated state; it is not a decoder for external JSON.

Component occurrences are currently expanded into page elements. Shared component definitions, saved subscription-backed preview choices, automatic React route-file discovery, filesystem persistence, and server/canvas integration follow in the page-import plan. Atomic storage of the complete baseline/document/log is still required before exposing Import; this package alone does not expose an Import button.
