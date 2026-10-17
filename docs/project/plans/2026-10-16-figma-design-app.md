# Figma design app (adhunters-v7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the owner's Figma design for adhunters-v4 (file `2VzP3S0vJodEz8fCPDPbsT`, page "Spy - Ads": Ads List, Ads Grid, Ads Table) into the locally running hub as an adopted app, so the owner can open it on the canvas, tap-edit it, chat about it, undo, and give direction from there.

**Architecture:** A new, small Next App Router app, `adhunters-v7`, written in React + CSS Modules with the tokens from the Figma variables. It is a static prototype: no data fetching, no hooks, sample rows inline. Its file layout mirrors what adhunters-v4 will have after its CSS Modules conversion (`app/layout.tsx`, `app/ads/page.tsx`, `components/<Name>.tsx` + `<Name>.module.css`, `styles/tokens.css`), so pieces can move into adhunters-v4 later. The hub imports it with the importer built in `2026-10-14-adhunters-v7-slice.md` tasks 1–6 (no new importer features are required for the first play-test).

**Tech Stack:** Next 16, React 19, TypeScript, CSS Modules, pnpm. Figma MCP (`get_design_context`, `get_variable_defs`, `download_assets`) as the source of truth for layout, tokens and assets.

**Spec:** `docs/project/spec.md` §5 (design model, import, canvas). The Figma file is the design spec.

## Global Constraints

1. The app must import into the hub with zero diagnostics. That bounds the source: static JSX only (no hooks, state, effects, fetch, `process.env`); CSS Modules or plain CSS only; the only media queries are `(max-width: 1023px)` and `(max-width: 599px)` plus `(hover: hover)`; no `!important`; no `@font-face`, `@keyframes` are allowed but not needed; selectors are classes, descendants, `:where()`, `:hover` inside `(hover: hover)`, `:first-child`/`:last-child`.
2. Runtime images are `data:` URLs (the hub renderer's CSP is `img-src data:`); SVG icons are inline `<svg>` JSX. No `next/image`, no `/public` images referenced from JSX.
3. External packages used from page/component files: `react` and `next/link` only (`next/link` is declared in `.hub/adapters.json` as `{ element: "a", attrs: { href: "href" } }`). No Tailwind, no clsx needed (plain template strings are fine).
4. Fonts: declare the design's stacks (`Michroma`, `IBM Plex Sans`, `IBM Plex Mono`) as `font-family` values with generic fallbacks. The hub renders with fallbacks until a fonts feature lands (ledger Ruling K). Do not add `@font-face` or `next/font`.
5. Tokens: every Figma variable becomes a `:root` custom property in `styles/tokens.css`, name = variable path with `/` replaced by `-` (`color/bg/header` → `--color-bg-header`, `space/6` → `--space-6`). Type styles (`ember/heading/card` …) become global classes in `styles/type.css` (`.ember-heading-card { font: … }`). Components use `var(--…)` and those classes; no literal colors.
6. The repo never touches adhunters-v4. It is a separate git repository at `~/Projects/adhunters-v7` (owner's) and the hub reads only its own clone at `~/hub-local/apps/adhunters-v7`.
7. No emojis anywhere (adhunters house rule). Portuguese UI strings as in the design.

## Rulings

- **Ruling J.** The Figma design is brought into the hub as this separate prototype app, not into adhunters-v4. — Why: it makes the hub testable with the real design now, with no dependency on the paused Tailwind conversion, and the components are shaped for adoption into adhunters-v4 later. — Cost if wrong: duplicate code until adoption; the prototype is the design reference, not production.
- **Ruling K.** Fonts fall back for now. — Why: the renderer's CSP allows only `data:` fonts and the design model has no font-face concept; a hub task adds a manifest `design.fonts` list served as data URLs. — Cost if wrong: renders differ from Figma in type until then; editing and layout testing are unaffected.
- **Ruling L.** Images are `data:` URLs in a `data/images.ts` constants file; SVG icons are inline JSX components. — Why: the renderer CSP; the model allows `data:` for `src` except `data:text/html`. — Cost if wrong: large source constants; replaced by real assets when adopted into adhunters-v4.
- **Ruling M.** Routes: `/ads` (list view), `/ads/grid`, `/ads/table`, so each Figma screen is one hub page; the view switch links between them. — Why: the hub edits pages, not view state. — Cost if wrong: none; a later app can collapse them to one route with state.

## Review Focus

1. **A construct the hub importer rejects** (a hook, an external package, an unsupported selector). Expected: the import of all three routes succeeds with zero diagnostics. Pinned by Task 3's import run.
2. **Visual drift from Figma** at 1440. Expected: the hub's desktop render of `/ads` matches the Figma screenshot in structure, spacing, colors (fonts excepted). Pinned by Task 3's side-by-side check.
3. **Responsive collapse.** Figma has desktop only; the tablet (834) and mobile (390) frames must still be readable: filter panel stacks above results at tablet, cards stack at mobile. Pinned by Task 2's module CSS and Task 3's three renders.
4. **Tap editing on a component copied into many pages.** Cards are inlined per occurrence (Ruling F); an edit to one card's title must change only that card. Pinned by Task 3's edit + undo check.
5. **Secrets/URLs.** No temporary Figma asset URLs remain in the source. Pinned by Task 2's grep.

---

### Task 1: Repository, tokens, shell

**Files:**
- Create: `~/Projects/adhunters-v7/` with `package.json` (name `adhunters-v7`, scripts `dev`/`build`/`start`/`typecheck`), `tsconfig.json` (`paths: {"@/*": ["./*"]}`), `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `styles/tokens.css`, `styles/type.css`, `components/Header.tsx` + `Header.module.css`, `components/icons.tsx`, `.hub/app.json`, `.hub/adapters.json`, `.gitignore`, `README.md`.

**Interfaces:**
- Produces: `--color-*`, `--space-*` tokens; `.ember-*` type classes; `Header` (brand, Spy/Raposa/Lab nav, bell, search field); the manifest `{ name: "adhunters-v7", template: "next-prototype@1", design: { dir: "design", routes: "app", devices: ["desktop","tablet","mobile"] }, build: { install: "pnpm install --frozen-lockfile", typecheck: "pnpm typecheck", test: "true" }, deploy: { image: "ghcr.io/marcoscapistrano/adhunters-v7", staging: { server: "none", url: "http://localhost" }, production: { server: "none", url: "http://localhost", domain: null } } }`.

- [ ] **Step 1:** `get_variable_defs` on `6:1766`, `6:4156`, `54:8619`; union → `styles/tokens.css` and `styles/type.css` per constraint 5.
- [ ] **Step 2:** `get_design_context` on Header `47:7388`; write `Header.tsx` + module CSS; icons from its SVG assets inlined in `components/icons.tsx`.
- [ ] **Step 3:** `app/layout.tsx`: `<html lang="pt-BR" className="dark"><body className={styles.body}><Header/>{children}</body></html>`, importing `./globals.css` (which `@import`s tokens, type, and a small reset).
- [ ] **Step 4:** `git init`, first commit.

### Task 2: Screens and components

**Files:**
- Create: `app/ads/page.tsx` (+ `page.module.css`), `app/ads/grid/page.tsx`, `app/ads/table/page.tsx`, `components/TitleNav.tsx`, `FilterPanel.tsx` (filter groups: Dias no ar, Visto entre, Fonte de tráfego, Dispositivo, Verticais tree, Publisher), `AppliedFilters.tsx` (chips, Limpar tudo, view switch, order select), `AdListCard.tsx`, `AdGridCard.tsx`, `AdTableRow.tsx`, `StageBadge.tsx`, `Sparkline.tsx` (inline SVG path), `Sentinel.tsx`, `data/ads.ts` (8 sample ads as in the design), `data/verticals.ts`, `data/images.ts` (data URL of the ad image).

**Figma nodes to read** (sparse parents: read their children): list screen `6:1766` → Content Shell `57:4866` children; Title Nav `I57:4866;60:2237`; Filter panel symbol `58:2047` and Filter element `58:1851`; applied filters `I57:4866;6:2106`; Ad list card `I57:4866;6:2117`; grid card `6:4521`; table header `54:9279` and row `54:9296`; sentinel `I57:4866;6:2564`.

- [ ] **Step 1:** For each node, `get_design_context` (with screenshot on the first call per screen), translate the Tailwind-style output into module CSS using tokens and type classes; absolute positioning only where the design needs it (sparkline labels).
- [ ] **Step 2:** Tablet/mobile rules per Review Focus 3.
- [ ] **Step 3:** `grep -rn "figma.com/api" .` prints nothing.
- [ ] **Step 4:** Commit per screen.

### Task 3: Adopt in the local hub and verify

- [ ] **Step 1:** Only after the hub branch `feat/real-app-import` is built: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build` in the app (one at a time; this machine has 7 GB).
- [ ] **Step 2:** `git clone ~/Projects/adhunters-v7 ~/hub-local/apps/adhunters-v7 && git -C ~/hub-local/apps/adhunters-v7 remote set-url --push origin DISABLED`.
- [ ] **Step 3:** Import through the hub API; expect `ok: true`, `failed: []`, three pages. Fix the app (never special-case the hub) until clean.
- [ ] **Step 4:** Render check: compare the hub's desktop tile of `/ads` with `~/hub-local/figma/ads-list.png`; tablet and mobile readable.
- [ ] **Step 5:** In the browser at `http://127.0.0.1:8790`: select a card title, edit it, undo. Record in the ledger.

### Task 4 (hub, later): fonts

Manifest `design.fonts: [{ family, file, weight, style }]` with tracked font files; the server reads them through the safe git path and the renderer embeds `@font-face` with `data:` sources. Separate hub plan task; not needed for the first play-test.
