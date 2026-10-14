# adhunters-v4 Design Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open adhunters-v4's `/login` route, with its real root layout and Header, in the locally running hub's Design area. Render it at the three device widths, edit it there, and keep the source free of Tailwind for every file in that route's import closure.

**Architecture:** There are two workstreams, and they meet at one contract: the CSS and JSX subset that the conversion emits and the importer reads.
- **Hub side (this repo, `packages/sync` and `apps/server`).** Widen the importer from "static toy app" to "real Next App Router app". This adds path aliases, declarative preview adapters for external modules, `clsx`, async server components, the document shell, global and layered CSS, structural selectors, and per-route partial import. The importer still never executes source.
- **App side (adhunters-v4, branch `css-modules` only).** Resume the paused CSS Modules plan (`docs/project/plans/2026-10-14-adhunters-v4-css-modules.md`, "the CSS plan") with its BASE moved to current `master`. Then convert only the `/login` closure: root layout, shell components and the login page.
- **The loop.** The local hub imports the `css-modules` branch from its own clone. Every remaining diagnostic is either a hub feature task below or a conversion fix.

**Tech Stack:** TypeScript 7 (typecheck) with `@typescript/typescript6` (parser), css-tree, vitest, Preact client. On the app side: the CSS plan's toolchain (`@tailwindcss/node` 4.3.3 codemod, `@babel/parser`, recast, Playwright 1.56.1).

**Spec:** `docs/project/spec.md` §5.1, §5.4 (with its 2026-10-14 amendment: Tailwind is unsupported, so adhunters-v4 converts first) and §5.5. The CSS plan's Decisions D1 to D33 define the converted output this importer must read.

## Global Constraints

1. The importer never executes app source, app scripts or package code. Every non-static value comes from a saved preview choice or a declarative adapter. Every unsupported construct fails explicitly, with a diagnostic naming the file and the construct.
2. Never interpret Tailwind utility classes as CSS. Unconverted files keep failing with `Unresolved CSS class`.
3. adhunters-v4 work happens only on `css-modules` and its `css-modules--<task>` branches. Never push to `master` or `staging`, never run `staging-add` or `deploy-staging`, never open the conversion PR for merge. Merging `master` deploys production, and every push to `staging` deploys staging against the production database.
4. adhunters-v4's own rules apply there: AGENTS.md (no emojis; never run the site against a database) and the CSS plan's Global Constraints 1 to 20. Parity servers run with `DATABASE_URL` and `PG*` removed (CSS plan D15).
5. The local hub reads adhunters-v4 only from `~/hub-local/apps/adhunters-v4`, a clone whose push URL is disabled. It never reads the owner's checkout at `~/Projects/adhunters-v4`.
6. Device media stay exactly `(max-width: 1023px)` for tablet and `(max-width: 599px)` for mobile. Frames are 1440, 834 and 390 (spec §5.5).
7. The model's `NodeStyle` stays `{ base, tablet, mobile }`. This plan adds no interaction states to the design model.

## Rulings (recorded on the user's behalf)

- **R1 Slice before scale.** Prove the importer/conversion contract on one route closure before converting the remaining files. Master grew from 109 to 319 styled files (99 new `/lab` pages) since the CSS plan's BASE. A contract mismatch found after converting everything would cost the whole conversion. The slice is `/login`: it is the smallest route, and its closure is the root layout plus the shell every other route shares.
- **R2 Resting state only.** The renderer draws each device frame at rest. Rules that cannot match at rest are skipped when computing a node's style, and they are counted in the import summary as `sourceOnlyRules`. These are: state pseudo-classes (`:hover`, `:focus*`, `:active`, `:disabled`, `:checked`, `:placeholder-shown`), the media `(hover: hover)`, `(hover: none)`, `print`, `(prefers-reduced-motion: reduce)` and `(min-width: 1536px)`, and pseudo-elements other than `::before`/`::after`. The source keeps them, and Build edits source, so they survive edits. This is exact for every rendered frame, so it is not an approximation. `::before`/`::after` with `content` stay unsupported and fail.
- **R3 Structural selectors are matched, not approximated.** Descendant, child, `:where()`, `:is()`, `:not()`, `:first-child`, `:last-child` and attribute selectors are evaluated against the imported tree before any element is replaced by a component instance. Specificity follows Selectors Level 4 (`:where` contributes zero).
- **R4 Cascade layers.** `@layer` blocks flatten in layer order, as the CSS plan defines it: `reset`, `theme`, `base`, `components`, `utilities`, then unlayered. Layer order beats specificity.
- **R5 Document shell.** The root layout's `html` and `body` take part in selector matching and inheritance. They are emitted as `div` elements carrying their compiled styles, because the model forbids document tags.
- **R6 Adapters are data, not code.** `.hub/adapters.json` in the app repo maps an external module export to one of `element` (`{ tag, attrs: { prop → attr } }`), `children` (render the children only), `omit`, or `source` (read another file instead, for `@/` aliases this is automatic). They are committed in the app repo, so Build and review see them.
- **R7 Partial import.** Each route is atomic, and the import as a whole is not. A route that fails keeps its previous version (or stays absent), and the response lists its diagnostics. This replaces the earlier all-or-nothing rule, which made a 116-route app unimportable while any route failed. Pending edits still replay on the clean baseline. A replay conflict on a route blocks only that route.
- **R8 Route scope.** Add `design.include`, a list of route globs, to the manifest. The adhunters-v4 manifest starts with `["/login"]`. Unmatched routes are not imported and are not errors.
- **R9 Choice limits.** Raise the saved-choice limit from 100 to 2,000 entries and from 256 KB to 4 MB per app. Real apps have many dynamic sites, and the bound still stops runaway data.

## Review Focus

1. **A converted file that the importer reads differently from the browser.** Expected: the hub frame matches the parity screenshot. Pinned by Task 9's comparison of the hub's 1440/834/390 renders with the CSS plan's parity baseline for `/login`, with at most 0.5 % differing pixels.
2. **A failing route damaging a good one.** Expected: good routes import, and the failing one shows its diagnostics. Pinned by Task 6 test `partial import keeps good routes and the old failed route`.
3. **An adapter declaring an element tag the model forbids** (`script`, `html`). Expected: an explicit adapter diagnostic, and nothing saved. Pinned by Task 3 test `adapter tag must be model-safe`.
4. **A state rule wrongly applied at rest.** For example, `.x:hover` changing the resting colour. Pinned by Task 1 test `hover rule is source-only`.
5. **Hub reading the owner's checkout or pushing.** Pinned by Task 8's verification: the clone's push URL, and `git -C ~/Projects/adhunters-v4 status` unchanged before and after.

---

## Hub side (repo `designer`, branch `feat/real-app-import`)

### Task 1: CSS engine for real stylesheets

**Files:**
- Modify: `packages/sync/src/css.ts`
- Create: `packages/sync/src/selectors.ts` (matching and specificity)
- Test: `packages/sync/src/css.test.ts`, `packages/sync/src/selectors.test.ts`

**Interfaces:**
- Produces:
  - `parseStyles(text: string, scope: string | null, opts: { file: string; resolveImport(spec: string): { file: string; text: string } }): { rules: Rule[]; tokens: Record<string, string>; sourceOnly: number }`
  - `Rule` gains `layer: number` (0 to 5, per R4) and `selector: SelectorAst`.
  - `matchSelector(node: TreeNode, sel: SelectorAst): boolean` over a `TreeNode = { tag; attrs; parent: TreeNode | null; index; siblings }` view.
  - `specificity(sel): [number, number, number]`.
- `:root` custom properties come back in `tokens` (name without `--`). Task 5 maps them into model tokens.

- [ ] **Step 1: Write failing tests.** In `css.test.ts`:
  - `@import "./a.css"` inlines `a.css` in place.
  - A bare-package `@import "tailwindcss"` fails with `Unsupported CSS package import tailwindcss`.
  - `@layer utilities { .a { color: red } } .a { color: blue }` gives blue, and so does the reverse order (R4).
  - `hover rule is source-only`: `.a { color: red } @media (hover: hover) { .a:hover { color: blue } }` gives base `color: red` and `sourceOnly === 1`.
  - `(min-width: 1536px)` is source-only.
  - `:root { --space-4: 1rem }` gives `tokens['space-4'] === '1rem'`.
  - `.a::before { content: "x" }` fails.

  In `selectors.test.ts`:
  - `:where(.a > :not(:last-child))` matches the first of two children of `.a` with specificity `[0,0,0]`.
  - `.card:hover .t` is source-only.
  - `[data-state="open"]` matches a static attribute.
  - `.a .b` does not match a `.b` outside `.a`.
- [ ] **Step 2:** Run `pnpm -F @hub/sync test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Build on css-tree's selector AST. Classify a rule as source-only per R2 before matching. Keep the existing errors for every other construct.
- [ ] **Step 4:** Run `pnpm -F @hub/sync test`. Expected: all tests pass, old ones included.
- [ ] **Step 5:** Commit `feat(sync): layered, imported and structural CSS with resting-state rules`.

### Task 2: Path aliases and the document shell

**Files:**
- Modify: `packages/sync/src/extract.ts` (`resolveFile`), `packages/sync/src/types.ts`
- Test: `packages/sync/src/extract.test.ts`

**Interfaces:**
- `SourceProject` gains `aliases?: Record<string, string>`, for example `{ "@/": "site/src/" }`. Task 6 reads it on the server from `compilerOptions.paths` of the `tsconfig.json` nearest the app directory, statically; an `extends` fails with a diagnostic (ledger Ruling B). This task only consumes `aliases`.

- [ ] **Step 1: Write failing tests.**
  - `import { X } from "@/components/X"` with alias `@/` resolves to `site/src/components/X.tsx`.
  - A root layout `<html className="dark"><body className={styles.body}>` produces two `div` nodes, and a rule `.dark .t` matches a descendant (R5).
  - `"use client"` and `export const dynamic = "force-dynamic"` are accepted. `export const metadata = …` is ignored.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they pass.
- [ ] **Step 5:** Commit.

### Task 3: Declarative preview adapters

**Files:**
- Create: `packages/sync/src/adapters.ts`, `packages/protocol/src/adapters.ts` (zod schema)
- Modify: `packages/sync/src/extract.ts`
- Test: `packages/sync/src/adapters.test.ts`

**Interfaces:**
- `.hub/adapters.json` = `{ "modules": { "<specifier>": { "<export>|*": Adapter } }, "styles"?: { "ignore": string[] } }`. `styles.ignore` lists exact source-relative CSS paths the importer skips, both as imports from JSX and as `@import` targets (ledger Ruling A: the Tailwind-only `tailwind.css` during migration).
- `Adapter = { kind: "element"; tag: string; attrs?: Record<string, string> } | { kind: "children" } | { kind: "omit" }`
- `SourceProject` gains `adapters?: Adapters`.

- [ ] **Step 1: Write failing tests.**
  - `next/link` `Link` → `{element a, attrs {href: href}}` renders `<a href="/x">` with its children.
  - `react` `Suspense` → `children` renders the children and drops `fallback`.
  - `lucide-react` `*` → `{element svg}` renders an empty `svg` and keeps `className` styling.
  - An adapter with `kind: "omit"` renders nothing.
  - `adapter tag must be model-safe`: `{element script}` fails.
  - An unmapped external import still fails with `External import … needs a preview adapter`.
  - `styles.ignore: ["app/tailwind.css"]` makes `import "./tailwind.css"` in `app/layout.tsx` a no-op, while a utility class used in JSX still fails with `Unresolved CSS class`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they pass.
- [ ] **Step 5:** Commit.

### Task 4: `clsx`, async components and choice-backed calls

**Files:**
- Modify: `packages/sync/src/extract.ts`, `packages/sync/src/choices.ts` (limits, R9)
- Test: `packages/sync/src/extract.test.ts`, `packages/sync/src/choices.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `clsx(styles.a, cond && styles.b, "ember")` evaluates with static `cond`, and with `cond` from a saved choice.
  - `async function Page({ searchParams })` with `const p = await searchParams` reads `p.next` from the preview prop choice.
  - A call to an imported function (`loginSettings()`) raises a `PreviewRequired` gap, and a saved value choice satisfies it.
  - `process.env.NODE_ENV === "development"` raises a gap.
  - 2,000 choices are accepted, and 2,001 are refused.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they pass.
- [ ] **Step 5:** Commit.

### Task 5: Global classes, tokens and the converted-output fixture

**Files:**
- Modify: `packages/sync/src/extract.ts`, `packages/sync/src/css.ts`
- Create: `packages/sync/src/fixtures/converted/` (a trimmed copy of the CSS plan's Chip golden plus a global `ember.css`)
- Test: `packages/sync/src/converted.test.ts`

- [ ] **Step 1: Write failing tests.**
  - A global class from plain CSS imported by the layout (`ember-type-body-small`) styles elements in pages.
  - `:root` tokens become model tokens: a name `group-rest` goes to `tokens[group][rest]`, and a name with no dash fails explicitly.
  - The fixture mirrors CSS plan D4, D6, D8 and D11: `@layer utilities`, `:where(.x)`, `.x.x:hover`, `.t:is(:where(.card):hover *)` and `animation: var(--animate-spin)`. It imports and renders the resting styles, and `sourceOnlyRules` counts the hover rules.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they pass.
- [ ] **Step 5:** Commit.

### Task 5b: Inline fallback for components that cannot be shared yet

Ledger Ruling F. In incremental sync (always shared mode), a source component that cannot become a shared definition because of a children slot or prop-driven `className`/`style` is expanded in place per occurrence (the existing expanded mode), instead of failing the route. Every other shared-definition failure still fails.

**Files:**
- Modify: `packages/sync/src/extract.ts`, `packages/sync/src/synchronize.ts`, `packages/sync/src/types.ts`
- Test: `packages/sync/src/components.test.ts`

**Interfaces:**
- `ExtractResult` (ok) and `synchronizePages` (ok) gain `inlined: { route: string; component: string; file: string; reason: 'children' | 'prop-css' }[]`.
- The expanded root element of each inlined occurrence gets `name` = the component name (`ElementNode.name` exists in the model).

- [ ] **Step 1: Write failing tests.**
  - The fixture Chip (`className` and `children` from callers) imports through `synchronizePages`, with `inlined` listing it once per route with reason `prop-css`.
  - A `Card` with `{children}` is inlined with reason `children`, and its root carries `name: "Card"`.
  - A component with no slot and no prop-driven CSS still becomes a shared definition plus instances.
  - A component failing for any other reason (for example, route-dependent CSS) still fails.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they pass.
- [ ] **Step 5:** Commit.

### Task 6: Partial import and route scope (server)

**Files:**
- Modify: `packages/sync/src/synchronize.ts`, `apps/server/src/sync/service.ts`, `packages/protocol/src/manifest.ts` (`design.include?: string[]`), `apps/server/src/sync/read-source.ts` (or wherever `readSourceProject` lives: it reads `.hub/adapters.json` and `tsconfig.json` paths)
- Modify: `apps/client/src/areas/design/DesignArea.tsx` (list failed routes under the import result)
- Test: `packages/sync/src/synchronize.test.ts`, `apps/server/src/sync/service.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `partial import keeps good routes and the old failed route`: two routes, one broken, give `ok: true`, `failed: [{ route, diagnostics }]`, the good one saved and the old version of the broken one kept.
  - `design.include: ["/login"]` imports only `/login`.
  - The summary carries `sourceOnlyRules`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3:** Implement R7 and R8.
- [ ] **Step 4:** Run the tests and confirm they pass, then run `pnpm -r typecheck` and `pnpm -r test`.
- [ ] **Step 5:** Commit, open the PR and drive CI to green.

## App side (repo adhunters-v4, branch `css-modules` only)

### Task 7: Rebase the CSS plan onto current master

- [ ] **Step 1:** In a worktree under `~/Projects/adhunters-v4-wt/css-modules` (not the owner's checkout), merge `origin/master` into `css-modules`. Move `site/tests/parity/BASE` to that `master` sha (CSS plan D32).
- [ ] **Step 2:** Re-run the CSS plan's preflight checks for the slice closure only: `site/src/app/layout.tsx`, `site/src/app/login/page.tsx` and the transitive `@/components` imports of both. Record the file list and any new F-level finding in `docs/project/ledgers/adhunters-design-slice.md`.
- [ ] **Step 3:** Push `css-modules` (a branch push triggers no deploy; verify `.github/workflows/*` triggers before pushing).

### Task 8: Tooling and parity for the slice

- [ ] **Step 1:** Run CSS plan tasks T2 to T5 as written: resolver, extractor/emitter/CLI, check and guard, tokens.
- [ ] **Step 2:** Run CSS plan T6 and T12, limited to the routes `login` plus the layout scenario, for the parity harness and BASE baseline.
- [ ] **Step 2b:** Split `site/src/app/globals.css` (ledger Ruling A): Tailwind-only parts move to `site/src/app/tailwind.css`, imported by `layout.tsx` right after `globals.css`; a `site/src/styles/reset.css` copied from BASE preflight is imported by `globals.css` now instead of at CSS-plan R1. Parity must stay green.
- [ ] **Step 3:** Add `.hub/app.json` with `design.include: ["/login"]` and `design.dir: "design-hub"` (CSS plan D23: `design/` is taken). Add `.hub/adapters.json` for `next/link`, `next/image`, `react` `Suspense`, `lucide-react` and the Radix modules the closure uses. Commit both on `css-modules`.

### Task 9: Convert the `/login` closure, then iterate to a clean import

- [ ] **Step 1:** Convert the closure files with the CSS plan's SCP (SCP-1 to SCP-8), callers before children, as in D31.
- [ ] **Step 2:** Point the local hub clone at `css-modules`, then import from the tablet UI or `POST /api/apps/adhunters-v4/design/import`.
- [ ] **Step 3:** For each diagnostic, either fix the conversion (the file violates the CSS plan) or add a hub task to this plan (the importer lacks a general feature). Never special-case adhunters-v4 in the hub.
- [ ] **Step 4: Done when** `/login` imports with zero diagnostics, the hub's three device renders match the parity baseline within 0.5 % differing pixels, and a tap edit plus Undo work on it in the browser.

## After the slice

Write the next plan only after Task 9 passes. It scales the conversion to the remaining shell, `(spy)`, the detail routes and `/lab`, in the CSS plan's waves. Each wave widens `design.include`.
