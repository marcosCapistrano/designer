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

Component occurrences are currently expanded into page elements. Shared component definitions, saved subscription-backed preview choices, automatic React route-file discovery, incremental hash tracking/replay, filesystem persistence, and server/canvas integration follow in the page-import plan. This package alone does not expose an Import button.
