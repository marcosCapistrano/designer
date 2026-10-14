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

`serializeSyncState` produces canonical model files plus `sync.json` (clean baselines) and `changes.jsonl`. `parseSyncState` validates the external files and verifies that the document equals its baseline plus the complete pending log. `FsSyncStore` persists that entire file bundle as one atomically replaced, flushed `snapshot.json` in a hub-owned directory outside the app checkout. It checks the expected content revision before saving and refuses concurrent writes. Keep one store instance per app in the single hub process. A failed import or write preserves the previous snapshot; corrupt storage is reported and never overwritten automatically. Conventional per-app files will be materialized on the reviewed Build handoff branch.

Incremental sync now extracts shared component definitions and linked occurrences. The lower-level extractor retains its expanded compatibility mode; pass `{ sharedComponents: true }` as its third argument for definitions. Shared components support a single element root, string props/defaults in text and attributes, nested instances, and route-independent CSS. Children slots, prop-driven CSS, non-string props, required props with no preview value, and differing definitions across routes fail explicitly. Definition IDs use the source module/export, independent of routes and occurrence positions. Cached baselines retain the source components, and pending component edits replay on those definitions.

The authenticated server and tablet Import pages control are implemented. Dynamic source gaps have stable file/expression keys. Accepted preview choices persist with the baseline and are reused deterministically; they never override statically resolvable expressions. Preview values are bounded JSON data, and literal sample fragments receive importer-controlled IDs and pass model validation. List templates can read chosen rows without executing callbacks, retaining JSX markup and stable React-key IDs; supported React state chooses an explicit preview value, and effects require a null acknowledgement and are never run. Conditional branches have distinct IDs so edits cannot silently move to another branch. Local import-graph CSS is tracked even when a component is not rendered.

The tablet can ask the subscription runner for a sample preview, review its values and rendered images, and apply it. Candidate generation never publishes the current design or render manifest. Source/revision checks gate Apply; regular imports reuse accepted choices without another AI call. Unsupported static syntax, selectors, external adapters, component shapes and module effects still fail explicitly. Automatic React route-file discovery remains outside this bounded importer.
