# adhunters-v4: Tailwind to CSS Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tailwind in `site/` with plain CSS Modules (one `<Name>.module.css` next to each styled file, plus a small global layer) with no visible change at the hub's device widths, written in the desktop-first media convention that the hub's design model reads.

**Architecture:** A codemod built on Tailwind 4.3.3's own design system (`@tailwindcss/node`) resolves the classes of every element into declarations per device tier and state. It writes the module CSS and rewrites `className` to `clsx(styles.…)`. Agents start each file from that output, finish what it flags, and prove the result twice: a static per-element check against the BASE source, and Playwright screenshots of all 15 routes compared with a baseline captured from BASE, with fixture data served inside the test browser. While files are mixed, module rules sit in `@layer utilities` so that converted and unconverted files compose as Tailwind did. The last waves remove Tailwind and wire a guard into `build`.

**Tech Stack:** Next 16.3.5 (Turbopack, CSS Modules), React 19.3, TypeScript 7.0.2 (native compiler, no JS compiler API, so the codemod parses with `@babel/parser` and rewrites with `recast`), clsx 2.1.1, `@tailwindcss/node` 4.3.3 (codemod only, removed at the end), `@playwright/test` 1.56.1 with Chromium build 1194 at `/opt/pw-browsers`, pnpm 12.5.1.

**Spec:** `/mnt/project-files/designer/spec.md`. The relevant parts are:
- §5.1: a node's `style` is a base value plus `tablet` and `mobile` overrides.
- §5.4 step 2 and its 2026-10-14 amendment: the extractor reads React with CSS Modules in Next App Router apps. Tailwind is not supported ("it will limit us"), so adhunters-v4 is converted first.
- §5.5: the device frames are desktop 1440, tablet 834 and mobile 390.
- §10, 2026-10-14 amendment: this conversion is the first step of Design.

The hub code this plan aligns with lives in `/home/claude/wt-p3/packages`:
- `design-model/src/export.ts`: `BREAKPOINTS`, tablet `(max-width: 1023px)` and mobile `(max-width: 599px)`.
- `design-model/src/css.ts`: `validateStyle`, which rejects `!important`, backslashes and braces.
- `renderer/src/html.ts`: `cssForDevice`.

Repository facts:
- Repo: `marcosCapistrano/adhunters-v4`. The default branch is `master`; at plan time its tip was `f79b876`.
- CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`, `pnpm --filter site exec tsc --noEmit -p .` and `pnpm --filter site build` on every PR.
- **Merging to `master` deploys production.** `deploy-site.yml` runs on any push to `master` that touches `site/**`, `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`. It rebuilds the site, rsyncs it to old-collector and restarts app.adhunters.pro.

## Global Constraints

1. **Branches.** Work lands on branch `css-modules`. Each task runs on its own branch `css-modules--<task id>` in its own worktree and is merged back. Never push to `master`. The delivery is one PR from `css-modules` into `master`.
2. **Commands.** Run every command from the repo root (AGENTS rule 4).
   - `PNPM` means `npx -y pnpm@12.5.1`.
   - `S <cmd>` means `npx -y pnpm@12.5.1 --filter site exec <cmd>`, which runs in `site/`.
   - Never run `npx` from inside `site/`: it fails with EBADDEVENGINES.
3. **No visible change.** Every route and scenario passes parity at four sizes: desktop 1440×900, tablet 834×1194, mobile 390×844 and wide 1920×1080. Pass means: per-pixel threshold 0.05, at most 50 differing pixels, and the same full-page height.
4. **Width media queries.** Use exactly these strings, desktop-first:
   - `@media (max-width: 1023px)` for tablet;
   - `@media (max-width: 599px)` for mobile;
   - `@media (min-width: 1536px)` for wide.

   In a module, base rules come first, then the tablet block, then the mobile block, then the wide block.

   The other media allowed are `(hover: hover)`, `(hover: none)`, `print` and `(prefers-reduced-motion: reduce)`. They may stand alone or be nested inside a width block. Nothing else is allowed: no other `min-width` and no `@container`.
5. **One module per file.** Each styled file gets one `<Basename>.module.css` beside it (`page.tsx` gets `page.module.css`). Import it as `import styles from "./<Basename>.module.css";` after the other imports. A file never imports another file's module CSS.
6. **No utility layer under another name.** No global single-purpose classes (`.flex`, `.mt-4`, `.text-muted`) and no `composes:` from a shared file.
7. **Where global CSS lives.** Only in:
   - `src/app/globals.css`;
   - `src/styles/tokens.css`, `animations.css`, `reset.css` and `ember.css`;
   - `src/components/toaster.css`.

   Do not edit `ember.css` or `toaster.css`.
8. **Merging classes.** Use `import { clsx } from "clsx";`. A converted file contains no `cn`, `twMerge` or `cva`.
9. **Values.**
   - Values come from the tokens listed in D9 (named `--{group}-{name}`), from the `--ember-*` variables in `ember.css`, or are literals.
   - No `--tw-*` name appears in any output.
10. **No `!important` in module CSS.** Module class names are camelCase and semantic, and never contain `ember-type`: `globals.css` matches `[class*="ember-type-mono"]`.
11. **Literal class names in `className`.** Besides `styles.*`, only these may appear:
    - `dark`, `ember`, `ember-type-*`, `card-link`, `card-link-host`, `app-toaster`, `spy-toast-indeterminate`, `sheet`, `no-print`;
    - `peer` and `group`, only where D11 allows them;
    - the next/font classes carried by `spyFontVariables` and `emberPortalClass`.
12. **Keyframes.** Only global CSS names keyframes. A module animates with `animation: var(--animate-…)` plus longhand overrides, and never writes `animation-name`.
13. **Zero emojis** anywhere: code, comments, commit messages, PR text (AGENTS rule 1).
14. **Where the site runs.** Never run the site on omarchy (AGENTS). Parity servers run only in the executor's own container.
15. **Files not to touch.** Leave alone, unless a task names them:
    - `design/` (penpot/, spy/);
    - `CLAUDE.md`;
    - `site/pnpm-lock.yaml` (stray; the workspace lock is the root `pnpm-lock.yaml`);
    - `site/src/styles/ember.css`;
    - `site/src/components/toaster.css`;
    - `site/src/app/api/**`.
16. **Playwright.** Use `@playwright/test@1.56.1` with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. Never run `playwright install`.
17. **Fixture data** exists only in the test browser, through route interception. No app code reads a fixture flag or variable.
18. **Every task ends green.** After each task, `S tsc --noEmit -p .` exits 0 and `S next build` succeeds. These are the CI steps.
19. **Dependencies.** Change them only with `PNPM --filter site add|remove …` from the root, and commit `pnpm-lock.yaml`.
20. **Commits.** Use the prefixes `style(css):`, `test(parity):`, `chore(css):` or `fix(css):`. End each message with the attribution lines your session prescribes, with any emoji removed.

## Review Focus

1. **Cross-file `className` overrides.** There are 362 call sites that pass `className` into a component.
   - A caller's class must still win where tailwind-merge let it win.
   - The component's own hover or open state must still win where tailwind-merge kept it.
   - DomainLink's hover colour is the one live collision.

   Pinned by: T2 tests `merge: caller state beats child state` and `merge: responsive child keeps its tiers`, T4 test `merge site fails without doubled class`, and task F8.
2. **Widths between the hub tiers change by design (D2).** These are 600–639, 600–767 and 1024–1279. No route may overflow horizontally more than it did at BASE. Pinned by `overflow.spec.ts` in T6 (widths 700 and 1100), which runs at every gate.
3. **Portaled overlays keep the Ember look.** Radix Select, Popover, Tooltip, Dialog and Sheet content renders in `body`, outside `.ember`. Each must keep its colours, fonts and resting position. Pinned by T6 scenarios `ads-select-open`, `ads-calendar-open`, `ads-vertical-open`, `ads-tooltip`, `publishers-dossier-open` and `ad-drawer-open`. Owned by A3, A4, C5, C6 and C10.
4. **Printing `/raposa/export`.** One sheet per page, no toolbar, white background. Pinned by scenario `export-print`. Owned by F6.
5. **Touch screens (`hover: none`).** OperatorLink's action icon is visible without hover, and the cards keep no hover look. Pinned by scenarios `ads-touch` and `operators-touch`. Owned by P2.

## Decisions

Each line reads: ruling — why — cost if wrong.

- **D1 Structure.** One `<Basename>.module.css` per styled file, default import `styles`. The global layer is:
  - `styles/tokens.css`, `styles/animations.css` and `styles/reset.css`, all new;
  - `styles/ember.css`, unchanged;
  - `app/globals.css`, keeping the shadcn triplets, base rules, scrollbars, `.ember` font variables and `card-link`;
  - `components/toaster.css`, unchanged.

  Why: the hub extractor reads per-component modules, and the globals hold only what is not per-component. Cost: moving a rule between files later is mechanical.
- **D2 Breakpoints.** Desktop-first, as in the hub's `export.ts`:
  - base is desktop (1024 px and up);
  - `(max-width: 1023px)` is tablet;
  - `(max-width: 599px)` is mobile;
  - `(min-width: 1536px)` is wide, kept for the single `2xl:` use.

  Each tier's value is Tailwind's value evaluated at 1440, 834, 390 and 1920. Why: the hub's `NodeStyle {base, tablet, mobile}` and `cssForDevice` expect exactly these strings. Cost: layouts change at 600–639 (`sm:`), 600–767 (`md:`) and 1024–1279 (`xl:`, 13 uses: 11 grid templates and 2 max-widths). The overflow checks at 700 and 1100 catch breakage. Undoing this needs min-width queries that the hub cannot read.
- **D3 Variants.** Each `cva` becomes typed `Record<Variant, string>` maps of module classes. `buttonVariants`, `badgeVariants` and `sheetVariants` stay functions with the same name and options, returning a clsx string. Why: callers stay unchanged. Cost: none; no file uses compound variants.
- **D4 Merging without tailwind-merge.** `cn` becomes `clsx`. Conflicts are avoided by these rules:
  - The codemod merges one element's own classes per branch into module rules, so nothing on one element conflicts.
  - An element that receives a caller's `className` writes its plain self rules as `:where(.x)`, so any caller class wins.
  - Its state, attribute and combinator rules keep Tailwind's specificity, so they still beat a caller's plain class where tailwind-merge kept them.
  - A caller overriding the same state doubles its class (`.x.x:hover`).
  - A caller emits a declaration only in the tiers where tailwind-merge would let it win. This covers the 8 components with responsive self rules.

  Why: this reproduces tailwind-merge's outcome statically. Cost: a missed site shows as a parity or static-check failure.
- **D5 The codemod uses Tailwind's own compiler.** It calls `__unstable__loadDesignSystem` with `candidatesToCss` from `@tailwindcss/node` 4.3.3, on the CSS at BASE, and resolves per element, tier and state. It handles:
  - arbitrary values and variants;
  - `--tw-*` composition, dropping transparent shadow layers;
  - the modern branch of `@supports` color-mix, dropping the fallback;
  - theme variables mapped to tokens;
  - dead classes and declarations overridden by an `ember-type-*` preset, both dropped;
  - `!` dropped when redundant;
  - responsive-only properties, given an explicit lower-tier value (the reset value, the tag's UA display, `inherit` or the initial value, never `revert-layer`).

  Why: exact, because it is Tailwind's own output. Cost: `__unstable__` is pinned to 4.3.3, and it leaves with the codemod at R1.
- **D6 Migration wrapper.** Until R1, each module wraps its rules in `@layer utilities { }`, and `layout.tsx` imports `./globals.css` before any component. Both orders were verified in a test build. Converted and unconverted files then compose as Tailwind did. R1 unwraps. Why: parity stays green at every commit. Cost: one mechanical unwrap at R1.
- **D7 Ember presets.** The `ember-type-*` presets stay global classes from `ember.css`. Why: the file is generated from `design/spy/tokens.css` and shared with the design handoff, and there are about 470 uses. Cost: the hub sees them as global classes, not module styles.
- **D8 Animations.** Global keyframes live in `styles/animations.css`:
  - `spin`, `ping` and `pulse`, with Tailwind's bodies;
  - `motion-enter` and `motion-exit`, which are tw-animate's `enter` and `exit` renamed so they do not clash during migration, driven by `--enter-*` and `--exit-*` registered with `@property … inherits: false`.

  Modules write `animation: var(--animate-…)`. Why: CSS Modules rename keyframe names inside `animation:` but leave `var()` alone, as verified. Cost: the names are global, and the `motion-` prefix keeps them apart.
- **D9 Tokens.** These are exactly the theme values the compiled BASE CSS uses, 101 tokens:
  - `--color-*`:
    - the 19 shadcn names as `hsl(var(--x))`: background, foreground, card, card-foreground, popover, popover-foreground, primary, primary-foreground, secondary, secondary-foreground, muted, muted-foreground, accent, accent-foreground, destructive, destructive-foreground, border, input, ring;
    - the palette: amber-300, 400, 500 and 950; emerald-300, 400, 500 and 950; sky-300, 500 and 950; blue-300, 500 and 950; black; white.
  - `--font-sans` and `--font-mono`.
  - `--text-xs`, `-sm` and `-lg`, each with a `-leading` partner.
  - `--tracking-tight`.
  - `--radius-sm`, `-md` and `-lg`.
  - `--shadow-2xs`, `-sm`, `-md`, `-lg` and `-xl`.
  - 31 `--space-*` steps: 0_5, 1, 1_5, 2, 2_5, 3, 3_5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72 and 96.
  - `--container-*`: sm, lg, xl, 2xl, 3xl, 4xl, 5xl and 6xl.
  - `--blur-sm` and `--blur-md`.
  - `--ease-in-out` and `--ease-default`.
  - `--duration-default`.
  - `--animate-*`: spin, ping, pulse, enter and exit.

  Font weights and the 16/9 aspect ratio stay literal. The shadcn triplets (`--background: 240 10% 3.9%`) stay in `globals.css` as inputs. Why: these are the names the hub's `tokens.json` emits as `--group-name`. Cost: a Tailwind value not used today needs a new token when someone first needs it.
- **D10 Dark mode.** No `dark:` variant is used. `.dark` stays hard-coded on `<html>`. Why: nothing to convert. Cost: none.
- **D11 Group and peer.** When the `group` ancestor is in the same file, it gets a module class, and the rule keeps Tailwind's shape: `.title:is(:where(.card):hover *)`. The only cross-file case is ui/label with ui/checkbox `peer`. There the literal `peer` marker stays, and the selector uses `:global(.peer)`. Why: the specificity is exactly Tailwind's. Cost: two allowlisted markers.
- **D12 Third-party components.**
  - Radix parts get module classes plus `[data-state]`, `[data-side]`, `[data-disabled]` and `[data-highlighted]` selectors. Portaled content keeps `emberPortalClass`.
  - recharts internals use `:global(.recharts-…)` under the module class. recharts SVG props are untouched.
  - sonner keeps its global `toaster.css`.
  - interface-kit is untouched; it is dev-only.
  - `@base-ui/react` is imported nowhere and is left alone.

  Why: each library's own styling surface. Cost: a recharts class rename on upgrade breaks those selectors, as it would today.
- **D13 Unused files are converted, not deleted.** These are:
  - `ui/` chart, checkbox, dialog, dropdown-menu, input, label, separator, sheet, slider, tabs, textarea, card, table and skeleton;
  - VelocitySparkline;
  - `skeletons.tsx`.

  Why: deletion is a product decision outside this brief, and the guard needs zero Tailwind. Cost: about 2,000 extra lines converted, proven only by the static check because no route renders them.
- **D14 `badgeClass` goes.** Remove it from `RegimeDetails` in `lib/time_series_econometrics.ts`. Why: it is Tailwind strings sent in the internal JSON of `/api/creatives/:id/inspect` and `/api/players/:id`, which no client reads, and it is not in `/api/v1`. Cost: an outside reader of that internal JSON loses one field.
- **D15 Fixture mode.** Playwright intercepts `/api/**`, `/_next/image` and external hosts in the test browser only. Servers run `next start` with `ADHUNTERS_LOGIN_USER=parity`, `ADHUNTERS_LOGIN_PASSWORD=parity-local-only`, and with `DATABASE_URL` and `PG*` removed. Why:
  - every data page is a client component fetching `/api` through SWR;
  - the server pages (login, `raposa/[id]`, proxies) need no database;
  - production behaviour is unchanged.

  Cost: fixtures can drift from real data shapes, which is limited by typing them against the app's types.
- **D16 Parity method.**
  - `toHaveScreenshot` from `@playwright/test` with the four sizes in constraint 3, full page.
  - `threshold: 0.05`, `maxDiffPixels: 50`.
  - Clock fixed at 2026-10-10T12:00:00Z, timezone UTC, locale en-US, animations disabled, caret hidden.
  - The baseline comes from BASE, built in a worktree under `PARITY_DIR=/tmp/adhunters-parity`.

  Why: the hub's widths plus a wide check. Cost: a change below the threshold passes unseen.
- **D17 Two proofs per task.**
  - Static: `check.mjs` compares the computed declarations of every element, per tier and state, between the BASE source and the new source.
  - Visual: parity on the routes whose import closure contains the file.

  The full suite runs at every gate. Why: the static check covers branches and unused files no screenshot reaches, and the visual check covers the cascade. Cost: about 2–4 minutes of build and screenshots per task.
- **D18 Removal list.**
  - Packages: tailwindcss, @tailwindcss/postcss, @tailwindcss/node, tw-animate-css, tailwind-merge, class-variance-authority, autoprefixer, shadcn (the CLI generates Tailwind code), cn (an unused npm package) and recast.
  - Files: `postcss.config.mjs`, `components.json`, `src/styles/ember-theme.css`, `src/lib/utils.ts` and `scripts/tw2css/`.
  - Kept: clsx, postcss, @babel/parser, postcss-selector-parser and @playwright/test.

  Why: nothing Tailwind-shaped stays reachable. Cost: `shadcn add` stops working until `components.json` is recreated, and its output must then be converted.
- **D19 Guard.** `site/scripts/check-styles.mjs --final` runs first in `"build"` (pnpm does not run `prebuild` hooks). It fails on:
  - Tailwind packages;
  - Tailwind directives;
  - Tailwind-shaped class literals or strings;
  - `styles.x` with no matching class;
  - media text outside constraint 4;
  - `:global` outside the allowlist;
  - undefined `var()` names;
  - `!important` in modules.

  Why: CI and deploy-site both run `build`. Cost: a false positive needs an allowlist edit.
- **D20 Delivery.**
  - One PR, `css-modules` into `master`.
  - Staging through `scripts/staging-add`, then `deploy-staging` from `master` with `ref=staging` (AGENTS 3.1a).
  - Auto-merge (squash) is turned on only after the owner approves.
  - **Merging deploys production.**

  Why: the repo's runbook. Cost: none.
- **D21 Dependency edits.** Only `npx -y pnpm@12.5.1 --filter site add|remove` from the root. Why: npx from `site/` fails, and CI uses `--frozen-lockfile`. Cost: none.
- **D22 Docs.** Update the lines that name Tailwind classes or packages: AGENTS rules 2 and 3, DESIGN_GUIDELINES §3, §5 and §6, and INFRASTRUCTURE "Styling". Add a "Styling" section. `CLAUDE.md` stays untouched because it is the owner's file. Why: the docs would otherwise teach Tailwind. Cost: none.
- **D23 Hub manifest left out.** No `.hub/app.json` and no hub design model in this PR. The hub's default `design.dir` of `design` collides with this repo's existing `design/` (penpot, spy handoff), so adopting the app must pick another folder. Why: out of scope, and recorded here for the adoption step. Cost: none now.
- **D24 Class names.** The codemod emits provisional names (`root`, `<component>`, `<tag><n>`, `<name>When<n>`), and the executor renames them to semantic camelCase. Why: the hub shows class names to the user. Cost: naming quality varies, but it is reviewable and changes no behaviour.
- **D25 Harness location.** `site/tests/parity/` has its own `tsconfig.json`, and `tests` is excluded from `site/tsconfig.json`. The BASE commit is pinned in `site/tests/parity/BASE`. Snapshots live outside the repo, in `PARITY_DIR`. Why: CI's tsc must not compile Playwright files, and snapshots are large and machine-specific. Cost: a fresh machine reruns the baseline (about 10 minutes).
- **D26 Hover rules** stay inside `@media (hover: hover)`, as Tailwind v4 emits them. Why: exact touch behaviour. Cost: none.
- **D27 No `!important` in modules**, because the hub's `validateStyle` forbids it. The export page's inline print `<style>` is plain CSS that needs `!important`, so it stays as it is, together with its global `sheet` and `no-print` markers. ui/chart's generated `<style>` also stays. Why: neither is Tailwind. Cost: the hub does not see print rules.
- **D28 Model tiers.** Tasks marked (J) run on a stronger model. Any other task that reports more than 5 TODO from `convert.mjs`, or fails `check.mjs` or parity twice, is handed to a stronger model. Why: Haiku does well on mechanical conversion, not on cascade puzzles. Cost: none.
- **D29 Parallel work.**
  - Each task has its own worktree and branch off the current `css-modules` tip.
  - The tasks in a wave touch disjoint files.
  - The coordinator merges each one after a rebase, fast-forward only.

  Why: many agents on one branch. Cost: one coordinator step per task.
- **D30 Codemod output is not pasted into this plan.** Each task's starting point is the deterministic output of `convert.mjs` at the pinned BASE. Why: 112 files of CSS would make the plan a transcript, and any codemod fix would make it stale. Cost: none, since the summary line shows exactly what the task starts with.
- **D31 DomainLink converts last (F8)**, after all 8 of its callers. Why: it is the only live state collision, and callers-first composes correctly in the mixed state while children-first does not. Cost: none.
- **D32 Sync with `master` at every gate.**
  - Merge `origin/master`.
  - Reconvert every styled file that `master` changed since BASE.
  - Move BASE to the merged `master` commit and recapture the baseline.

  Why: other threads ship to `master` during the conversion. Cost: rework on any file both sides touched.
- **D33 shadcn rule.** AGENTS rule 2 says "standard shadcn/ui". The `ui/` components keep their structure, Radix parts, props and exports; only the styling mechanism changes, and the docs are reworded to match. Why: the brief requires no Tailwind. Cost: the owner may have meant unaltered upstream source.

## File Structure

```
site/
  package.json                       devDeps (T1, R1); "build" runs the guard first (R1)
  tsconfig.json                      exclude "tests" (T1)
  src/app/globals.css                imports tokens.css and animations.css (T5); Tailwind parts removed (R1)
  src/app/layout.tsx                 `import "./globals.css"` becomes the first import (T5)
  src/styles/tokens.css              NEW, generated (T5): the 101 tokens of D9
  src/styles/animations.css          NEW (T5): @property for --enter-*/--exit-*, keyframes
  src/styles/reset.css               NEW (R1): BASE preflight inside @layer reset
  src/styles/ember-theme.css         DELETED (R1)
  src/lib/utils.ts                   DELETED (R1)
  src/**/<Name>.module.css           NEW, one per styled file (P*, A*-F*)
  scripts/check-styles.mjs           NEW (T4): guard; kept
  scripts/check-styles.test.mjs      NEW (T4); kept
  scripts/tw2css/                    NEW (T2-T5), DELETED (R1)
    design-system.mjs cascade.mjs resolve.mjs     (T2)
    extract.mjs emit.mjs convert.mjs              (T3)
    check.mjs                                     (T4)
    gen-tokens.mjs                                (T5)
    tests/*.test.mjs  tests/fixtures/*            (T2-T5)
  tests/parity/                      NEW (T6-T12); kept
    BASE tsconfig.json playwright.config.ts run.mjs auth.setup.ts
    routes.ts scenarios.ts mock-api.ts parity.spec.ts overflow.spec.ts make-assets.mjs
    fixtures/ids.ts fixtures/index.ts
    fixtures/{shell,lists,details,raposa,data}.ts  assets/*.png
postcss.config.mjs, components.json  DELETED (R1)
.gitignore                           + site/tests/parity/.out/, site/.tw2css-cache/, site/test-results/
```

Outside the repo, `PARITY_DIR` (default `/tmp/adhunters-parity`) holds the BASE worktree at `base/`, the snapshots at `snapshots/` and the overflow baseline at `overflow.json`.

## Execution

| Wave | Tasks (parallel unless noted) | Lane | Needs |
|---|---|---|---|
| W0 | T1 | setup | - |
| W1 | T2 (J), T6 (J) | tools | W0 |
| W2 | T3 (J), T5, T7, T8, T9, T10, T11 | tools, fixtures | T2 for T3 and T5; T6 for T7-T11 |
| W3 | T4 (J), T12 | tools | W2 |
| W4 | P1 (J), P2, P3 | pilots | W3 |
| W5 | A1-A9, B1 (J), B2-B9, C1, C2, then G1 (J) | ui, ember/spy, shell | W4 |
| W6 | C3-C13, D1-D8, E1-E9, then G2 (J) | shared, features, raposa | G1 |
| W7 | F1-F7 | routes | G2 |
| W8 | F8, then G3 (J) | DomainLink, gate | W7 |
| W9 | R1 (J), R2 | removal, docs | G3 |
| W10 | R3 | delivery | W9 |

That makes 77 tasks in 11 waves.
- Judgment tasks (J), on a stronger model: T2, T3, T4, T6, P1, B1, F6, G1, G2, G3, R1.
- Every other task suits Haiku: it touches 1–3 source files, starts from codemod output, and has a pass/fail check.

**Worktree protocol (coordinator, per task):**
1. Create the worktree: `git worktree add ../wt/<id> -b css-modules--<id> css-modules`. Then, inside it, run `PNPM install --frozen-lockfile`.
2. Hand the task text and this plan's Global Constraints, Decisions and SCP to the agent.
3. Merge the result:

   ```
   git -C ../wt/<id> rebase css-modules
   git merge --ff-only css-modules--<id>
   git worktree remove ../wt/<id>
   ```

`run.mjs` picks a free port for each server, so parallel parity runs do not collide. They share `PARITY_DIR` read-only after T12.

## Standard Conversion Procedure (SCP)

Every task in lanes P, A, B, C, D, E and F runs these steps with its own values:
- `FILES`: paths relative to `site/`.
- `ROUTES`: route keys from T6, or `all`, or `none` for files no route renders.

**Consumes:**
- `convert.mjs` (T3);
- `check.mjs` and `check-styles.mjs` (T4);
- `run.mjs compare` (T6, T12);
- the tokens (T5).

**Produces:**
- one module beside each file in `FILES`;
- every export name, prop and type unchanged;
- exported class maps keep their keys and now hold module class strings.

- [ ] **SCP-1 Start from the codemod.** Run `S node scripts/tw2css/convert.mjs $FILES`.
  - Expected: one line per file, `<file>: <e> elements, <r> rules, <d> dropped, <t> TODO`.
  - This output is the exact starting point. Do not hand-write CSS before it.
  - If any file reports more than 5 TODO, stop and hand the task up (D28).
- [ ] **SCP-2 Resolve every `TODO(tw2css)` marker** using the table in T3, then delete the marker. `grep -rn "TODO(tw2css)" site/src` must print nothing for these files.
- [ ] **SCP-3 Rename provisional classes** to semantic camelCase (D24) in the module and the source together. Keep `root` for a single component's outer element. Do not change declarations, selectors, rule order or media blocks.
- [ ] **SCP-4 Static parity.** `S node scripts/tw2css/check.mjs $FILES` prints `OK <file> …` for every file.
- [ ] **SCP-5 Guard.** `S node scripts/check-styles.mjs $FILES` exits 0 with no output.
- [ ] **SCP-6 Types and build.** `S tsc --noEmit -p .` exits 0, and `S next build` succeeds.
- [ ] **SCP-7 Visual parity** (skip when `ROUTES` is `none`). `S node tests/parity/run.mjs compare --routes $ROUTES` ends with `PASS <n>/<n>`; with `all`, use `compare --all`.
  - On failure, read the `*-diff.png` files under `site/tests/parity/.out/results/`. Fix the module, never the snapshot, and repeat from SCP-4.
- [ ] **SCP-8 Commit.** `git add -A site/src && git commit -m "style(css): convert <file names> to CSS Modules"`.

---

## Foundation

### Task T1: Branch, BASE pin, dev dependencies

**Files:**
- Create: `site/tests/parity/BASE`
- Modify: `site/package.json` (devDependencies), `pnpm-lock.yaml`, `site/tsconfig.json`, `.gitignore`

**Interfaces:**
- Produces: branch `css-modules`; `site/tests/parity/BASE`, holding one line with the full `master` sha that every later task treats as BASE; the dev dependencies `@playwright/test@1.56.1`, `@tailwindcss/node@4.3.3`, `@babel/parser@7.29.9`, `recast@0.23.11` and `postcss-selector-parser@7.1.0`.

- [ ] **Step 1: Branch.** `git fetch origin && git switch -c css-modules origin/master`, then `mkdir -p site/tests/parity && git rev-parse origin/master > site/tests/parity/BASE`.
- [ ] **Step 2: Add the dev dependencies.** `PNPM --filter site add -D @playwright/test@1.56.1 @tailwindcss/node@4.3.3 @babel/parser@7.29.9 recast@0.23.11 postcss-selector-parser@7.1.0`.
- [ ] **Step 3: Exclude the harness from tsc.** In `site/tsconfig.json`, set `"exclude": ["node_modules", "tests"]`.
- [ ] **Step 4: Ignore generated output.** Append `site/tests/parity/.out/`, `site/.tw2css-cache/`, `site/test-results/` and `site/playwright-report/` to `.gitignore`.
- [ ] **Step 5: Verify.**
  - `PNPM install --frozen-lockfile` exits 0.
  - `S tsc --noEmit -p .` exits 0.
  - `S next build` succeeds.
  - `S node -e "import('@tailwindcss/node').then(m=>console.log(typeof m.__unstable__loadDesignSystem))"` prints `function`.
- [ ] **Step 6: Commit.** `chore(css): branch setup, parity BASE pin, codemod dev dependencies`.

### Task T2 (J): Codemod resolver

**Files:**
- Create: `site/scripts/tw2css/design-system.mjs`, `cascade.mjs`, `resolve.mjs`
- Test: `site/scripts/tw2css/tests/resolve.test.mjs`, `tests/helpers.mjs`

**Interfaces:**
- Consumes: `tests/parity/BASE` (T1).
- Produces:
  - **`loadBaseDesignSystem(): Promise<DS>`** (design-system.mjs).
    - It writes `git show <BASE>:site/src/app/globals.css`, `…/src/styles/ember.css` and `…/src/styles/ember-theme.css` into `site/.tw2css-cache/<sha>/src/{app,styles}/`.
    - It returns `__unstable__loadDesignSystem(css, { base: <cache>/src/app })`, memoized.
    - `DS` is Tailwind's design system object, with `candidatesToCss` and `theme`.
  - **`rulesForClass(ds, cls: string): TwRule[] | null`**.
    - `TwRule = { media: string[]; selector: string; decls: [string, string][] }`.
    - The selector is relative to `&`, e.g. `"&"`, `"&:hover"`, `"& svg"`, `":where(& > :not(:last-child))"`, `"&:is(:where(.group):hover *)"`.
    - It returns `null` when Tailwind emits nothing. `@property` blocks are dropped. Of a color-mix `@supports` pair, only the modern branch is kept.
  - **`cascade(rules: CssRule[], ctx: Ctx): Map<string, string>`** (cascade.mjs) computes the winning declarations for one target of one element.
    - `CssRule = { layer: string | null; media: string[]; selector: string; order: number; decls: [string, string][]; important?: boolean }`.
    - `Ctx = { width: 390 | 834 | 1440 | 1920; states: Set<string>; media: Set<"hover" | "hover-none" | "print" | "reduced-motion"> }`.
    - State strings look like `":hover"`, `":focus-visible"`, `"[data-state=open]"`, `"group:hover"` and `"peer:disabled"`.
    - Layer order is `reset`, `theme`, `base`, `components`, `utilities`, then unlayered. Specificity follows `:is`/`:where` rules. Width media accept `(width >= Xrem)`, `(min-width: Npx)` and `(max-width: Npx)`, with 1rem = 16px. The `hover` medium is on unless `hover-none` is set.
  - **`resolveElement(ds, parts: Part[], opts: ElementOpts): ElementStyle`** (resolve.mjs).
    - `Part = { when: string; classes: string[]; external?: { rules: OutRule[] } }`. `when: ""` means always on; `external` holds the converted rules of a class taken from another file's map.
    - `ElementOpts = { tag: string; incoming: boolean; mergeChild?: { parts: Part[]; rules: OutRule[][] } }`.
    - `ElementStyle = { parts: OutRule[][]; globals: string[]; dropped: { cls: string; reason: "no-css" | "ember-type" }[]; todos: { code: "IMPORTANT" | "UNSUPPORTED-VARIANT" | "COMPOSE-UNKNOWN-CHILD"; cls?: string; detail: string }[] }`. `parts` follows the order of the input parts.
    - `OutRule = { tier: "base" | "tablet" | "mobile" | "wide"; media: string[]; selector: string; decls: [string, string][] }`. In the selector, `&` is the element's class, `:where(&)` is the same class at zero specificity, and `&&` is the class doubled.
  - **`flat(rules: OutRule[]): string[]`** (tests/helpers.mjs) produces `"<tier>|<media joined with ' and '>|<selector>|<prop>: <value>"`, sorted ascending.

**Resolution rules, which the tests pin:**
- **R-a Contexts.** Widths 1440 (base), 834 (tablet), 390 (mobile) and 1920 (wide). Each distinct state used by the element's classes is tried alone, and so is every combination that one class's variant chain uses. `print`, `hover-none` and `reduced-motion` are tried only when a class uses them.
- **R-b Expected values.** The Tailwind cascade over `rulesForClass` output for `twMerge(...activeParts)` (tailwind-merge, as `cn` did), in every combination of the conditional parts. Two parts whose conditions are `x` and `!x` never combine. The extractor (T3) never passes more than 4 conditional parts; it reports `DYNAMIC` instead.
- **R-c Targets.** The element and each combinator target (`& svg`, `& > tr`, `:where(& > :not(:last-child))`, `& .recharts-cartesian-grid line`) are resolved separately, each keeping Tailwind's selector shape.
- **R-d Emission is greedy.**
  - Visit the contexts in order: base, tablet, mobile, wide; within each, no state first, then the states.
  - Add a declaration only where the simulated cascade of the rules emitted so far, in emission order, differs from the expected value.
  - Conditional parts are emitted after the parts that come before them in `cn` order.
- **R-e Fallbacks.** When Tailwind declares nothing in a context but an emitted rule would, the fallback is the first of these that applies:
  - the BASE preflight value for that tag and property;
  - for `display`, the UA default for the tag (a table in resolve.mjs: `inline` for span, a, svg, img, code, strong, em, label, i, b; `block` for div, p, section, header, footer, nav, main, aside, ul, ol, h1–h6, form, figure; `list-item` for li; `table`, `table-row`, `table-cell`, `table-header-group` and `table-row-group` for the table parts; `inline-block` for button, input, select, textarea);
  - `inherit` for inherited properties;
  - the property's initial value.

  Anything still unknown raises `UNSUPPORTED-VARIANT`.
- **R-f Elements with a caller.** For an `incoming` element, only the plain self selector becomes `:where(&)`. State, attribute, group/peer, pseudo-element and combinator selectors keep Tailwind's specificity.
- **R-g Composition.**
  - `--tw-*` variables are substituted per context from the element's own classes, else their `@property` initial value, else the `var()` fallback. An empty `var(--tw-x,)` disappears.
  - In box-shadow lists, `0 0 #0000` layers are dropped; if all are dropped, the value is `0 0 #0000`.
  - Arithmetic is simplified: `calc(Npx + 0px)` becomes `Npx`, `calc(X * 0)` becomes `0`, and `calc(X * calc(1 - 0))` becomes `X`.
  - `--tw-*` entries are removed from `transition-property`.
  - `--tw-enter-*` and `--tw-exit-*` are renamed `--enter-*` and `--exit-*` and kept as declarations.
- **R-h Tokens.**

  | Tailwind form | Output |
  |---|---|
  | `calc(var(--spacing) * N)` | `var(--space-N)`, with `.` written `_` |
  | `calc(var(--spacing) * -N)` | `calc(var(--space-N) * -1)` |
  | `var(--text-X--line-height)` | `var(--text-X-leading)` |
  | `var(--default-transition-duration)` | `var(--duration-default)` |
  | `var(--default-transition-timing-function)` | `var(--ease-default)` |
  | `var(--font-weight-*)` | the number |
  | `var(--aspect-video)` | `16 / 9` |
  | a resolved shadow list equal to a theme shadow | `var(--shadow-X)` |
  | an `animate-*` value, including tw-animate's `enter …` | `var(--animate-X)`, plus `animation-duration` and `animation-timing-function` longhands only when they differ from the token |

  All other theme variables are kept, and `@theme inline` ember names already resolve to `--ember-*`.
- **R-i Ember presets.** Every declaration is dropped (reason `ember-type`) in every context when its property is a longhand of an `ember-type-*` preset on the merged element. That covers `font` and all its longhands, including `font-variant-*` and `line-height`, plus `letter-spacing` and `text-transform` when the preset sets them. The preset's own class goes to `globals`.
- **R-j Dead classes.** A token with no CSS at BASE that is not in the constraint 11 allowlist is dropped as `no-css`.
- **R-k Important.** `!` is dropped when the element is not `incoming`. Otherwise the element raises `IMPORTANT`.
- **R-l Merge sites, caller side (`mergeChild`).**
  - The expected values are the Tailwind cascade of `twMerge(child parts, own parts)`.
  - The child's rules are simulated first.
  - The caller emits only what it needs on top. It writes `&&` when a caller rule must beat a child rule of equal specificity.
- **R-m Media text.** Media text is normalized to the exact strings of constraint 4.

- [ ] **Step 1: Write the failing tests.** In `resolve.test.mjs`, define a helper `one(classes, tag = "div", incoming = false)` that returns `flat(resolveElement(ds, [{ when: "", classes }], { tag, incoming }).parts[0])`.

```js
const cases = [
  ["responsive tiers", one(["px-4", "sm:px-6", "lg:px-8"]), [
    "base||&|padding-inline: var(--space-8)",
    "mobile||&|padding-inline: var(--space-4)",
    "tablet||&|padding-inline: var(--space-6)"]],
  ["responsive-only property gets an initial value", one(["md:grid-cols-2"]), [
    "base||&|grid-template-columns: repeat(2, minmax(0, 1fr))",
    "mobile||&|grid-template-columns: none"]],
  ["display fallback by tag", one(["sm:flex"], "span"), [
    "base||&|display: flex", "mobile||&|display: inline"]],
  ["hidden then visible", one(["hidden", "sm:inline-flex"], "span"), [
    "base||&|display: inline-flex", "mobile||&|display: none"]],
  ["xl folds into desktop", one(["grid-cols-1", "md:grid-cols-2", "xl:grid-cols-4"]), [
    "base||&|grid-template-columns: repeat(4, minmax(0, 1fr))",
    "mobile||&|grid-template-columns: repeat(1, minmax(0, 1fr))",
    "tablet||&|grid-template-columns: repeat(2, minmax(0, 1fr))"]],
  ["hover stays in (hover: hover)", one(["text-ember-muted", "hover:text-ember-t1"], "a"), [
    "base|(hover: hover)|&:hover|color: var(--ember-text-primary)",
    "base||&|color: var(--ember-text-muted)"]],
  ["ring and shadow compose", one(["ring-1", "ring-ember-line", "shadow-sm"]), [
    "base||&|box-shadow: 0 0 0 1px var(--ember-border-default), var(--shadow-sm)"]],
  ["negative spacing", one(["-mx-6"]), ["base||&|margin-inline: calc(var(--space-6) * -1)"]],
  ["opacity modifier", one(["bg-amber-950/40"]), [
    "base||&|background-color: color-mix(in oklab, var(--color-amber-950) 40%, transparent)"]],
  ["arbitrary values", one(["max-w-[2560px]", "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"]), [
    "base||&|grid-template-columns: minmax(0,1.6fr) minmax(0,1fr)",
    "base||&|max-width: 2560px"]],
  ["data-state", one(["data-[state=open]:bg-ember-raised"]), [
    'base||&[data-state="open"]|background-color: var(--ember-bg-raised)']],
  ["transition tokens", one(["transition-colors", "duration-200"]), [
    "base||&|transition-duration: 200ms",
    "base||&|transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    "base||&|transition-timing-function: var(--ease-default)"]],
  ["tw-animate enter", one(["animate-in", "fade-in-0", "zoom-in-95"]), [
    "base||&|--enter-opacity: 0", "base||&|--enter-scale: .95", "base||&|animation: var(--animate-enter)"]],
  ["space-x keeps zero specificity", one(["space-x-2"]), [
    "base||:where(& > :not(:last-child))|margin-inline-end: var(--space-2)",
    "base||:where(& > :not(:last-child))|margin-inline-start: 0"]],
  ["group hover", one(["group-hover:text-ember-t1"]), [
    "base|(hover: hover)|&:is(:where(.group):hover *)|color: var(--ember-text-primary)"]],
  ["peer disabled", one(["peer-disabled:opacity-70"]), ["base||&:is(:where(.peer):disabled ~ *)|opacity: 70%"]],
  ["print and hover none", one(["print:hidden", "[@media(hover:none)]:opacity-100"]), [
    "base|(hover: none)|&|opacity: 100%", "base|print|&|display: none"]],
  ["incoming element: plain rules at zero specificity", one(["inline-flex", "hover:underline"], "a", true), [
    "base|(hover: hover)|&:hover|text-decoration-line: underline",
    "base||:where(&)|display: inline-flex"]],
  ["incoming element: combinator keeps specificity", one(["[&_svg]:size-4"], "button", true), [
    "base||& svg|height: var(--space-4)", "base||& svg|width: var(--space-4)"]],
  ["redundant important dropped", one(["bg-ember-card", "!bg-[var(--ember-bg-header)]"], "header"), [
    "base||&|background-color: var(--ember-bg-header)"]],
];
for (const [name, got, want] of cases) test(name, () => assert.deepEqual(got, want));
```

  Add these separate tests:
  - **`ember-type drops what the preset sets`.** For `["ember-type-body-small", "text-xs", "font-semibold", "uppercase", "tabular-nums"]`, the rules are `["base||&|text-transform: uppercase"]`, `globals` is `["ember-type-body-small"]`, and `dropped` lists `text-xs`, `font-semibold` and `tabular-nums`, all with reason `ember-type`.
  - **`dead class is dropped`.** `checked:bg-[url("data:image/svg+xml,%3csvg` yields no rules and `dropped[0].reason === "no-css"`.
  - **`important on incoming element is a TODO`.** `one(["!bg-[var(--ember-bg-header)]"], "div", true)`, run through `resolveElement`, has `todos[0].code === "IMPORTANT"`.
  - **`conditional part wins by order`.** The parts are `[{when:"", classes:["text-ember-muted","hover:text-ember-t1"]}, {when:"active", classes:["text-ember-accent"]}]`.
    - `parts[0]` is `["base|(hover: hover)|&:hover|color: var(--ember-text-primary)", "base||&|color: var(--ember-text-muted)"]`.
    - `parts[1]` is `["base||&|color: var(--ember-accent-default)"]`.
  - **`merge: caller state beats child state`.**
    - The child is `["inline-flex","items-center","gap-1","text-ember-muted","hover:text-ember-t1"]` with `incoming: true`.
    - The caller is `["text-ember-link","hover:text-ember-chip-text"]` with `mergeChild` set to the child.
    - The caller's `parts[0]` is `["base|(hover: hover)|&&:hover|color: var(--ember-accent-chip-text)", "base||&|color: var(--ember-accent-link)"]`.
  - **`merge: responsive child keeps its tiers`.**
    - The child is `["px-4","sm:px-6"]` with `incoming: true`, and its rules are `["base||:where(&)|padding-inline: var(--space-6)", "mobile||:where(&)|padding-inline: var(--space-4)"]`.
    - The caller is `["px-2"]`, and its rules are `["mobile||&|padding-inline: var(--space-2)"]`.
- [ ] **Step 2: Watch the tests fail.** `S node --test scripts/tw2css/tests/resolve.test.mjs` fails with "Cannot find module '../resolve.mjs'".
- [ ] **Step 3: Implement** design-system.mjs, cascade.mjs and resolve.mjs to the interfaces and rules above. Parse Tailwind's CSS with `postcss`, and compute selector specificity with `postcss-selector-parser`.
- [ ] **Step 4: Watch the tests pass.** `S node --test "scripts/tw2css/tests/*.test.mjs"` reports all passing.
- [ ] **Step 5: Commit.** `chore(css): tw2css resolver on Tailwind's design system`.

### Task T3 (J): Codemod extractor, emitter and CLI

**Files:**
- Create: `site/scripts/tw2css/extract.mjs`, `emit.mjs`, `convert.mjs`
- Test: `site/scripts/tw2css/tests/extract.test.mjs`, `emit.test.mjs`, `convert.test.mjs`, `tests/fixtures/Chip.tsx`, `tests/fixtures/Chip.expected.tsx`, `tests/fixtures/Chip.module.expected.css`

**Interfaces:**
- Consumes: `resolveElement`, `rulesForClass`, `loadBaseDesignSystem` and `flat` (T2).
- Produces:
  - **`extractSites(code: string, file: string): Site[]`** (extract.mjs). It parses with `@babel/parser` (`typescript`, `jsx`).
    - `Site = { id: string; line: number; tag: string; kind: "literal" | "cn" | "template" | "ternary" | "identifier" | "member" | "map" | "cva"; parts: Part[]; incoming: boolean; mergeTarget?: { file: string; component: string }; groupAncestor?: string; mapKey?: string[]; todos: Todo[] }`.
    - `id` is the element path (`Component>tag[i]>tag[j]`), which stays stable when only `className` changes.
    - `incoming` is true when the component's own `className` prop flows into this element.
    - It resolves same-file `const` strings, templates, ternaries and objects. It treats `spyFontVariables` and `emberPortalClass` as global.
    - A constant or map imported from another file under `src/` (`GRID_CLASS`, `FIELD_CLASS`, `TABLE_COLUMNS`, `DELTA_CLASS`, `STAGES`) is read from that file's BASE source as an `external` part. The reference stays as written, and the owner file's task converts the value.
    - Any other runtime value raises `DYNAMIC`.
    - `Todo` is T2's type, with three more codes: `DYNAMIC`, `CVA` and `CROSS-FILE-GROUP`.
  - **`emitModule(classes: { name: string; rules: OutRule[] }[], opts: { wrap: boolean }): string`** (emit.mjs).
    - Order: every base-tier rule, in class order and then rule order. Then one `@media (max-width: 1023px)` block, one `@media (max-width: 599px)` block and one `@media (min-width: 1536px)` block, each in the same order.
    - Non-width media nest inside.
    - The output is wrapped in `@layer utilities { }` when `wrap` is set.
    - `&` becomes `.name`, `&&` becomes `.name.name`, and `:where(.group)` becomes the same-file ancestor's class or `:global(.group)`.
    - Formatting: 2-space indent, one declaration per line.
  - **`convert.mjs` CLI:**
    - `node scripts/tw2css/convert.mjs <file…>` writes each file's sibling `<Basename>.module.css` (wrapped) and rewrites the source with recast. The rewrite:
      - turns literals into `styles.x`;
      - turns `cn(...)` into `clsx(...)`, mapping each part to `styles.x` or `cond && styles.xWhenN`;
      - turns map values into `styles.*`;
      - keeps global tokens as literals;
      - adds `import { clsx } from "clsx"` and `import styles from "./<Basename>.module.css"`;
      - removes an unused `cn` import.

      It prints one summary line per file and inserts `/* TODO(tw2css) <CODE>: <detail> */` in the CSS, or `// TODO(tw2css) <CODE>: <detail>` in the source.
    - `--dry-run` writes nothing.
    - `--all` processes every `.ts` and `.tsx` file under `src/` except `src/app/api/**`.
    - `--report <path>` writes a TSV with the columns file, elements, todos and codes.
    - `--explain "<class>"` prints Tailwind's CSS for the class at BASE, then `flat()` of `one([class])`.
    - `--merge-child <Tag>=<file>` names the component file for a JSX tag that cannot be resolved by import.
    - `--unwrap-all` removes the `@layer utilities { }` wrapper from every `*.module.css`.
  - Provisional names: `root` for a single exported component's outer element; the camelCased component name for that element in multi-component files; `<tag><n>` for other elements, in source order; `<name>When<n>` for conditional parts; `<mapName><Key>` for map entries.

**TODO codes and how to resolve them by hand (used by SCP-2):**

| Code | Meaning | Hand rule |
|---|---|---|
| `DYNAMIC` | A class built at runtime from something that is not a same-file or imported constant or map, or more than 4 conditional parts. | Add an explicit `Record<K, string>` map in this file with one module class per possible value. Take the values from the expression's type. Rerun `convert.mjs` on the file. |
| `IMPORTANT` | `!` on an element a caller can style. | Grep the callers. If none sets that property, drop the `!`. Otherwise double the class (`.x.x`). Never `!important`. |
| `COMPOSE-UNKNOWN-CHILD` | `className` is forwarded through more than one component. | Rerun with `--merge-child <Tag>=<file>` pointing at the final element's file. |
| `CVA` | A `cva(...)` call. | Replace it with typed maps and a function of the same name and options (D3; P1 shows the shape). |
| `UNSUPPORTED-VARIANT` | Tailwind emitted a selector or media the resolver does not model. | Write the rule from `--explain` output, keeping Tailwind's selector shape and specificity, and map widths to the tiers of constraint 4. |
| `CROSS-FILE-GROUP` | The `group` or `peer` element is in another file. | Keep the literal `group` or `peer` on that element, and use `:global(.group)` or `:global(.peer)` here (D11). |

- [ ] **Step 1: Write the failing tests.**
  - `extract.test.mjs`:
    - **literal:** `<div className="flex gap-2" />` gives one site with kind `literal`, parts `[{when:"", classes:["flex","gap-2"]}]` and `incoming: false`.
    - **cn with className:** `function A({className}){return <span className={cn("px-1", active && "bg-ember-raised", className)}/>}` gives kind `cn`, parts `[{when:"",classes:["px-1"]},{when:"active",classes:["bg-ember-raised"]}]` and `incoming: true`.
    - **same-file constant:** `const FIELD = "h-8 rounded-ember"; … <input className={FIELD}/>` gives kind `identifier` with `classes: ["h-8","rounded-ember"]`.
    - **map:** `export const DELTA_CLASS = { accent: "text-ember-accent", new: "text-ember-new" }` gives kind `map` with `mapKey` `["accent"]` and `["new"]`.
    - **globals:** `` className={`dark ${spyFontVariables}`} `` gives no todos, and `dark` is kept.
    - **template ternary:** `` className={`size-3 ${isValidating ? "animate-spin" : ""}`} `` gives parts `["size-3"]` and `{when:"isValidating", classes:["animate-spin"]}`.
    - **unknown value:** `className={props.cls}` gives `todos[0].code === "DYNAMIC"`.
    - **merge target:** `import { DomainLink } from "@/components/DomainLink"; <DomainLink className="text-ember-link"/>` gives `mergeTarget.file === "src/components/DomainLink.tsx"`.
  - `emit.test.mjs`: one class `root` with the rules `base :where(&) display inline-flex`, `base (hover: hover) &:hover color X` and `mobile :where(&) padding-inline Y`, with `wrap: true`, produces exactly the text in the Chip golden for those rules.
  - `convert.test.mjs` (golden):
    - Running convert on `tests/fixtures/Chip.tsx` must produce `Chip.expected.tsx` and `Chip.module.expected.css`, byte for byte.
    - `Chip.tsx` is:

      ```tsx
      import { cn } from "@/lib/utils";
      export function Chip({ active, className }: { active?: boolean; className?: string }) {
        return (
          <span className={cn("inline-flex px-2 text-ember-muted hover:text-ember-t1 sm:px-3", active && "text-ember-accent", className)}>
            <svg className="size-3" />
          </span>
        );
      }
      ```

    - The expected source replaces the `cn` import with `import { clsx } from "clsx";`, adds `import styles from "./Chip.module.css";`, and uses `className={clsx(styles.root, active && styles.rootWhen1, className)}` and `className={styles.svg1}`.
    - The expected CSS is:

      ```css
      @layer utilities {
        :where(.root) {
          display: inline-flex;
          padding-inline: var(--space-3);
          color: var(--ember-text-muted);
        }
        @media (hover: hover) {
          .root:hover {
            color: var(--ember-text-primary);
          }
        }
        :where(.rootWhen1) {
          color: var(--ember-accent-default);
        }
        .svg1 {
          width: var(--space-3);
          height: var(--space-3);
        }
        @media (max-width: 599px) {
          :where(.root) {
            padding-inline: var(--space-2);
          }
        }
      }
      ```

      Declarations within a rule follow the order of Tailwind's sorted output for the element's classes.
- [ ] **Step 2: Watch them fail.** `S node --test "scripts/tw2css/tests/*.test.mjs"` fails on the missing modules.
- [ ] **Step 3: Implement** extract.mjs, emit.mjs and convert.mjs. For recast, use `recast.parse(code, { parser: { parse: (s) => babelParse(s, { sourceType: "module", plugins: ["typescript", "jsx"], tokens: true }) } })` and `recast.print`.
- [ ] **Step 4: Watch them pass.** `S node --test "scripts/tw2css/tests/*.test.mjs"` reports all passing.
- [ ] **Step 5: Whole-repo dry run.** Run `S node scripts/tw2css/convert.mjs --all --dry-run --report .tw2css-cache/report.tsv`. Expected:
  - 112 files with styling;
  - TODO only of codes `CVA` (ui/button, badge, sheet), `DYNAMIC`, `IMPORTANT` and `CROSS-FILE-GROUP` (ui/label).

  List every file above 5 TODO in the commit body. The coordinator runs those tasks on a stronger model (D28).
- [ ] **Step 6: Commit.** `chore(css): tw2css extractor, emitter and convert CLI`.

### Task T4 (J): Static parity check and style guard

**Files:**
- Create: `site/scripts/tw2css/check.mjs`, `site/scripts/check-styles.mjs`
- Test: `site/scripts/tw2css/tests/check.test.mjs`, `site/scripts/check-styles.test.mjs`

**Interfaces:**
- Consumes: `extractSites`, `cascade`, `rulesForClass` and `resolveElement` (T2, T3).
- Produces:
  - **`checkFile({ file, oldCode, newCode, css, childModules }): { ok: boolean; failures: { line: number; element: string; ctx: string; prop: string; expected: string; got: string }[] }`** (check.mjs).
    - It pairs elements by `Site.id` between the old and new source. A structure change is a failure.
    - `ctx` is the device (`desktop`, `tablet`, `mobile`, `wide`) followed by any active states, e.g. `"desktop :hover"`.
    - Expected values: the Tailwind cascade of the old classes per branch combination and context, applying `twMerge` where the old code used `cn`.
    - Actual values: the cascade of the module rules matching the new classes, plus the global classes, plus at merge sites the child's module or Tailwind rules, in the mixed-state layer order of D6.
    - Both sides are normalized to literal values through the theme and token tables before comparing.
  - **`--unlayered`** reruns the same comparison with the cascade R1 will produce: modules unlayered, no Tailwind, and the unlayered global rules of `ember.css`, `toaster.css` and `globals.css` matched against each element's literal global classes. It reports every module declaration that would newly win over such a rule; at BASE those declarations were dead.
  - **CLI** `node scripts/tw2css/check.mjs <file…> | --converted [--unlayered]`. `--converted` covers every file that has a sibling module. It reads `oldCode` with `git show <BASE>:site/<file>`. It prints `OK <file> (<elements> elements, <contexts> contexts)` or one `FAIL <file>:<line> <element> <ctx> <prop>: expected <a> got <b>` line per failure, and exits 1 on any failure.
  - **`checkStyles(opts: { files?: string[]; final: boolean }): { code: string; where: string; detail: string }[]`** (check-styles.mjs). The CLI is `node scripts/check-styles.mjs <file…> | --converted | --final`. It exits 1 and prints one `<CODE> <where> <detail>` line per problem.

    | Code | Fails on |
    |---|---|
    | `TW-LITERAL` | A `className` literal token outside the allowlist of constraint 11. |
    | `TW-STRING` | A string literal of two or more tokens, or one token containing `-`, `:` or `[`, where every token matches the Tailwind shape `^!?(([a-z0-9-]+\|\[[^\]]+\]):)*-?[a-z][a-z0-9-]*(-\[[^\]]+\]\|\/[0-9.]+)?$` and its root is in the utility root list in the file. Only in `--final`, or for the listed files. Exempt with `// style-guard: allow` on the line before. |
    | `DIRECTIVE` | `@tailwind`, `@import "tailwindcss"`, `@theme`, `@apply`, `@utility`, `@custom-variant`, `@variant`, `@source`, `@plugin` or `@config` in any CSS. |
    | `PACKAGE` | `--final` only: tailwindcss, @tailwindcss/*, tw-animate-css, tailwind-merge, class-variance-authority, shadcn or cn in `site/package.json`; a `postcss.config.*` naming tailwind; or `components.json` present. |
    | `MISSING-CLASS` | `styles.x` where the imported module has no `.x`. |
    | `UNUSED-CLASS` | A module class no source references. Warning only; does not fail. |
    | `MEDIA` | Media text outside constraint 4, or width blocks out of order. |
    | `GLOBAL` | `:global(...)` other than `.group`, `.peer`, `.recharts-*`, `.ember` or `.card-link*`. |
    | `UNDEFINED-VAR` | A `var(--x)` without a fallback whose `--x` is defined in no global CSS file, not in the same module, not in an inline `style` object of the paired source (as `--width` in Toaster and `--color-bg` in ui/chart), and is not `--radix-*` (the `--ember-*` set comes from `ember.css`). |
    | `IMPORTANT` | `!important` in a `*.module.css`. |
    | `TW-VAR` | Any `--tw-` in a `*.module.css`. |

- [ ] **Step 1: Write the failing tests.**
  - `check.test.mjs`:
    - **`golden passes`:** `Chip.tsx` against `Chip.expected.tsx` with `Chip.module.expected.css` gives `ok: true`.
    - **`changed value fails`:** with the mobile `var(--space-2)` replaced by `var(--space-1)`, `failures[0]` equals `{ element: "Chip>span[0]", ctx: "mobile", prop: "padding-inline", expected: "0.5rem", got: "0.25rem" }`, ignoring `line`.
    - **`missing hover fails`:** with the `(hover: hover)` block removed, there is a failure with `ctx: "desktop :hover"` and `prop: "color"`.
    - **`merge site fails without doubled class`:**
      - The caller is `<Chip className={styles.link} />`, and its module sets `.link { color: X } @media (hover: hover) { .link:hover { color: Y } }`. That fails at `ctx: "desktop :hover"`.
      - With `.link.link:hover` it passes.
    - **`unlayered: a declaration that was dead at BASE is reported`:** an element with the classes `ember-type-body-small` and `styles.x`, where the module has `@media (hover: hover) { .x:hover { font-weight: 600 } }`, passes in the default mode. With `--unlayered` it fails at `ctx: "desktop :hover"`, `prop: "font-weight"`, `expected: "400"`, `got: "600"`.
  - `check-styles.test.mjs` has one test per row of the code table above. Each test writes a tiny file set in a temp dir and asserts the code; there is also an allowlisted `ember-type-body-small` literal that must give no problem.
- [ ] **Step 2: Watch them fail.** `S node --test scripts/tw2css/tests/check.test.mjs scripts/check-styles.test.mjs` fails on the missing modules.
- [ ] **Step 3: Implement** check.mjs and check-styles.mjs. check-styles.mjs imports only `@babel/parser`, `postcss`, `postcss-selector-parser` and node built-ins, because it outlives the codemod.
- [ ] **Step 4: Watch them pass.** The same command reports all passing.
- [ ] **Step 5: Smoke run.** `S node scripts/check-styles.mjs --converted` prints nothing and exits 0, since nothing is converted yet.
- [ ] **Step 6: Commit.** `chore(css): static parity check and style guard`.

### Task T5: Global token and animation layer

**Files:**
- Create: `site/scripts/tw2css/gen-tokens.mjs`, `site/src/styles/tokens.css` (generated), `site/src/styles/animations.css`
- Modify: `site/src/app/globals.css` (two imports), `site/src/app/layout.tsx` (import order)
- Test: `site/scripts/tw2css/tests/tokens.test.mjs`

**Interfaces:**
- Consumes: `loadBaseDesignSystem` (T2).
- Produces:
  - the 101 custom properties of D9 on `:root`, unlayered;
  - the keyframes `spin`, `ping`, `pulse`, `motion-enter` and `motion-exit`;
  - `@property` registrations for `--enter-{opacity,scale,rotate,blur,translate-x,translate-y}` and the matching `--exit-*`.

- [ ] **Step 1: Write the failing test.** `tokens.test.mjs` runs `gen-tokens.mjs` and asserts:
  - The set of names equals the D9 list (101 entries).
  - It contains these exact lines:
    - `--space-0_5: 0.125rem;`
    - `--space-96: 24rem;`
    - `--text-xs-leading: calc(1 / 0.75);`
    - `--color-background: hsl(var(--background));`
    - `--shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);`
    - `--animate-enter: motion-enter 150ms ease;`
    - `--animate-spin: spin 1s linear infinite;`
    - `--duration-default: 150ms;`
    - `--ease-default: cubic-bezier(0.4, 0, 0.2, 1);`
  - `animations.css` contains `@keyframes motion-enter`, `@keyframes motion-exit` and 12 `@property --enter-`/`--exit-` blocks with `inherits: false`.
- [ ] **Step 2: Watch it fail.** `S node --test scripts/tw2css/tests/tokens.test.mjs`.
- [ ] **Step 3: Implement `gen-tokens.mjs`**, which writes the `:root { … }` text to stdout, in D9 group order. The values come from:
  - `ds.theme` for the palette, fonts, text, tracking, radius, container, blur, ease and the `spin`/`ping`/`pulse` animations;
  - `tailwindcss/theme.css` 4.3.3 for the shadow values;
  - `N × 0.25rem` written as a literal for each space step;
  - `hsl(var(--<name>))` for the 19 shadcn colors.

  Then run `S node scripts/tw2css/gen-tokens.mjs > src/styles/tokens.css`.
- [ ] **Step 4: Write `animations.css`.**
  - The 12 `@property` blocks (`syntax: "*"; inherits: false;`), with initial values opacity 1, scale 1, rotate 0, blur 0, translate-x 0 and translate-y 0, the same for exit.
  - `spin`, `ping` and `pulse`, copied from Tailwind 4.3.3's theme.
  - `motion-enter`, which is tw-animate 1.4.0's `enter` with `--tw-enter-*` renamed to `--enter-*`:

    ```css
    @keyframes motion-enter {
      from {
        opacity: var(--enter-opacity, 1);
        transform: translate3d(var(--enter-translate-x, 0), var(--enter-translate-y, 0), 0)
          scale3d(var(--enter-scale, 1), var(--enter-scale, 1), var(--enter-scale, 1))
          rotate(var(--enter-rotate, 0));
        filter: blur(var(--enter-blur, 0));
      }
    }
    ```

  - `motion-exit`, the same with `to` and `--exit-*`.
- [ ] **Step 5: Wire them in.**
  - In `globals.css`, after `@import "../styles/ember-theme.css";`, add `@import "../styles/tokens.css";` and `@import "../styles/animations.css";`.
  - In `layout.tsx`, move `import "./globals.css";` to the first line, before `import type { Metadata }` (D6).
- [ ] **Step 6: Verify.** The test passes, `S tsc --noEmit -p .` exits 0, and `S next build` succeeds. T12's `compare --all` proves there is no visual change.
- [ ] **Step 7: Commit.** `style(css): token and animation layer; globals imported first`.

### Task T6 (J): Parity harness

**Files:**
- Create in `site/tests/parity/`: `tsconfig.json`, `playwright.config.ts`, `run.mjs`, `auth.setup.ts`, `routes.ts`, `scenarios.ts`, `mock-api.ts`, `parity.spec.ts`, `overflow.spec.ts` and `make-assets.mjs`
- Create in `fixtures/`: `ids.ts`, `index.ts`, and the empty area files `shell.ts`, `lists.ts`, `details.ts`, `raposa.ts` and `data.ts`
- Create: `assets/creative-1.png` to `creative-4.png`, generated

**Interfaces:**
- Produces:
  - **`routes.ts`:** `type RouteKey = "ads" | "operators" | "ad" | "operator" | "publishers" | "publisher" | "raposa" | "investigation" | "export" | "data" | "proxies" | "developers" | "search" | "watching" | "login"` and `ROUTES: { key: RouteKey; path: string; auth: boolean }[]`.

    | Key | Path |
    |---|---|
    | ads | `/` |
    | operators | `/advertisers` |
    | ad | `/ads/${CREATIVE_ID}` |
    | operator | `/advertisers/${OPERATOR_ID}` |
    | publishers | `/publishers` |
    | publisher | `/publishers/${PUBLISHER_ID}` |
    | raposa | `/raposa` |
    | investigation | `/raposa/${INVESTIGATION_ID}` |
    | export | `/raposa/export?ids=${INVESTIGATION_ID},${INVESTIGATION_ID_2}&print=0` |
    | data | `/data` |
    | proxies | `/proxies`, which redirects to `/data?tab=proxies` |
    | developers | `/developers` |
    | search | `/search?q=keto` |
    | watching | `/watching` |
    | login | `/login`, with `auth: false` |

  - **`fixtures/ids.ts`:** `CREATIVE_ID`, `OPERATOR_ID`, `PUBLISHER_ID`, `INVESTIGATION_ID`, `INVESTIGATION_ID_2`, `PAGE_ID` and `ASSET_HASH`. Each value matches the format its route handler parses; read the handler.
  - **`mock-api.ts`:**
    - `type Handler = { method?: string; path: string | RegExp; body: unknown | ((url: URL) => unknown); status?: number; contentType?: string; empty?: unknown }`.
    - `type MockMode = "data" | "empty" | "pending" | "error"`.
    - `installMocks(page: Page, mode?: MockMode): Promise<{ unmatched: string[]; external: string[] }>`. It routes `**/api/**` (except `/api/auth/*`) through `fixtures/index.ts` `handlers`. `/_next/image*` and every non-local image request get `assets/creative-N.png`, where N is a stable hash of the URL modulo 4. Other external requests are aborted and recorded. An unmatched `/api` request is answered 404 and recorded.
    - Modes: `empty` serves `handler.empty ?? body`; `pending` never fulfills; `error` answers 500 `{"error":"parity"}`.
  - **`fixtures/index.ts`:**
    - `handlers: Handler[]`, the concatenation of the five area files' `handlers` exports;
    - `ready: Partial<Record<RouteKey, string>>`, the merge of their `ready` exports. A `ready` selector is a CSS selector visible only when the page shows data. Area files own their routes' selectors.
  - **`scenarios.ts`:**
    - `type Device = "desktop" | "tablet" | "mobile" | "wide"`.
    - `interface Scenario { key: string; route: RouteKey; devices: Device[]; mode?: MockMode; query?: string; initScript?: string; context?: { hasTouch?: boolean; isMobile?: boolean; media?: "print" }; act?: (page: Page) => Promise<void> }`.
    - `SCENARIOS: Scenario[]`, with exactly the keys in the scenario table below.
  - **`playwright.config.ts`:**
    - Projects `setup` (auth.setup.ts), then `desktop` 1440×900, `tablet` 834×1194, `mobile` 390×844 and `wide` 1920×1080 (all `deviceScaleFactor: 1`, `isMobile: false`), plus `gap700` 700×900 and `gap1100` 1100×900, which run only `overflow.spec.ts`.
    - `use: { baseURL: process.env.PARITY_URL, timezoneId: "UTC", locale: "en-US", colorScheme: "dark", storageState: ".out/auth.json" }`.
    - `expect.toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 50, animations: "disabled", caret: "hide", fullPage: true }`.
    - `snapshotPathTemplate: "{env PARITY_DIR}/snapshots/{arg}-{projectName}{ext}"`, computed in the config from `process.env.PARITY_DIR`.
    - `workers: 4`, `retries: 0`, `outputDir: ".out/results"`.
  - **Test titles:** `[<route>] <route>` for page shots, `[<route>] <scenario key>` for scenarios and `[<route>] overflow`, so `--grep "\[(ads|ad)\]"` selects by route.
  - **`parity.spec.ts`:** for each route, and each scenario on its devices:
    - `page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z"))`;
    - `installMocks`;
    - `initScript` if any;
    - `goto(path + query)`;
    - wait for `ready[route]` (not in `pending` mode);
    - `act`;
    - `expect(page).toHaveScreenshot(\`${key}.png\`)`;
    - assert that `unmatched` is empty and no `pageerror` fired.
  - **`overflow.spec.ts`:** on `gap700` and `gap1100`, for every route, measure `document.documentElement.scrollWidth - innerWidth`. In baseline mode, write it to `$PARITY_DIR/overflow.json`. In compare mode, assert that head is no larger than base.
  - **`run.mjs`**, run from `site/`. Every mode starts servers with `next start -p <free port>`, with the D15 environment (and `DATABASE_URL` and `PG*` deleted), and waits for `/healthz`. The last line of output is `PASS n/n` or `FAIL k/n`.

    | Mode | What it does |
    |---|---|
    | `baseline [--force]` | Ensures `$PARITY_DIR/base` is a worktree at `$(cat tests/parity/BASE)`, then runs `PNPM install --frozen-lockfile` and `PNPM --filter site build` in it. Starts it, runs `playwright test --update-snapshots=all` with `PARITY_URL` and `PARITY_MODE=baseline`, then stops. |
    | `selftest` | Runs against the base server without updating snapshots. |
    | `compare --all` | Builds the current checkout (`PNPM --filter site build`), starts it and runs all tests. |
    | `compare --routes <k,…>` | The same, with `--grep "\[(k|…)\]"`. |
    | `probe --routes <k,…>` | Runs against the base server with no screenshot assertion. Prints per route and device: unmatched calls, external calls, page errors, and whether `ready` was found. Saves PNGs to `.out/probe/`. |

  - **`auth.setup.ts`:** fills the login form (`#user`, `#password`, then submit) with the D15 credentials and saves `.out/auth.json`.
  - **`make-assets.mjs`:** renders 4 fixed SVG gradients at 600×400 with Chromium and writes `assets/creative-1.png` to `creative-4.png`.

**Scenarios (key, route, devices, action):**

| Key | Route | Devices | Action |
|---|---|---|---|
| ads-card-hover | ads | desktop | hover the first result card |
| ads-tooltip | ads | desktop | hover the first signal trigger; wait for `[role="tooltip"]` |
| ads-select-open | ads | desktop, mobile | open the first EmberSelect; wait for `[role="listbox"]` |
| ads-calendar-open | ads | desktop | open CalendarRangePicker; wait for its popover content |
| ads-vertical-open | ads | desktop | open VerticalFilter |
| ads-view-grid, ads-view-table | ads | all four | `initScript`: `localStorage.setItem("adhunters_view_mode", "grid" or "table")` |
| operators-view-grid, operators-view-table | operators | all four | the same, key `adhunters_operators_view_mode` |
| ads-table-row-hover | ads | desktop | table view; hover the first row |
| ads-empty | ads | desktop, mobile | mode `empty` |
| ads-error | ads | desktop | mode `error` |
| ads-pending, operators-pending, ad-pending, search-pending, publishers-pending | each route | desktop, mobile | mode `pending`; screenshot after `load` |
| publishers-dossier-open | publishers | desktop, mobile | open the first publisher dossier dialog |
| ad-drawer-open | ad | desktop, mobile | open the Raposa dossier drawer |
| investigation-funnel-step | investigation | desktop, tablet | select the second funnel step |
| operator-watch-toast | operator | desktop, mobile | click WatchButton (POST mocked 200); wait for the toast |
| data-header-hover | data | desktop | hover the second header nav link |
| raposa-form-focus | raposa | desktop | press Tab until the investigate input has `:focus-visible` |
| voice-focus | data | desktop, mobile | press Tab to the voice feedback button; do not activate it |
| data-publishers, data-raposa, data-found | data | all four | query `?tab=publishers`, `raposa`, `found` |
| export-print | export | desktop | `context.media: "print"` (`page.emulateMedia({ media: "print" })`) |
| ads-touch, operators-touch | ads, operators | tablet, mobile | `context: { hasTouch: true, isMobile: true }`; tap the first card's operator link area |

- [ ] **Step 1: Write the harness files** to the interfaces above, and run `S node tests/parity/make-assets.mjs`.
- [ ] **Step 2: Typecheck.** `S tsc --noEmit -p tests/parity` exits 0.
- [ ] **Step 3: Login works.** With `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, `S node tests/parity/run.mjs probe --routes login,developers` prints, for `login`, `ready` found (selector `#user`). For `developers` it lists unmatched `/api/keys…` calls, because T7 fills those.
- [ ] **Step 4: Commit.** `test(parity): screenshot harness with in-browser fixture mode`.

### Tasks T7–T11: Fixtures by area

Each fixture task follows the same steps, using its own file, routes and coverage list.

**Interfaces:**
- Consumes: `Handler`, `RouteKey`, `ids.ts` (T6).
- Produces: `export const handlers: Handler[]` and `export const ready: Partial<Record<RouteKey, string>>` in its area file.
- Bodies are typed with `satisfies` against the app's response types wherever the app exports them (`@/lib/creative-types`, `@/components/raposa/types`, `@/components/data/types` and others).
- All dates fall within the 30 days before 2026-10-10. There is no randomness.

| Task | File | Routes | Endpoints (start set; `probe` shows the rest) | Coverage required |
|---|---|---|---|---|
| T7 | `fixtures/shell.ts` | login, developers (and every route) | `/api/watching/unread`, `/api/verticals`, `/api/keys`, `/api/keys/usage`, `/api/keys/claude-log` | an unread count above 0; one revoked key and two active keys |
| T8 | `fixtures/lists.ts` | ads, operators, publishers, search | `/api/creatives`, `/api/creatives/facets`, `/api/creatives/pulse`, `/api/players`, `/api/publishers`, `/api/search` | at least 12 creatives covering all 5 stages (rising, new, steady, fading, deactivated) and all 4 delta tones (accent, fading, neutral, new); 6 operators; 6 publishers; an `empty` body for each list endpoint |
| T9 | `fixtures/details.ts` | ad, operator, publisher | `/api/creatives/:id/inspect`, `/api/players/:id`, `/api/players/:id/creatives`, `/api/raposa/burns`, `POST /api/watching` | all 4 lifecycle regimes across the creatives (ACCELERATION, STEADY_HARVEST, FATIGUE_DECAY, TESTING), each on its own creative id |
| T10 | `fixtures/raposa.ts` | raposa, investigation, export | `/api/raposa/investigate`, `/api/raposa/investigate/:id`, `…/windows`, `/api/raposa/page/:pageId/view`, `…/files`, `/api/raposa/asset/:hash`, `/api/raposa/:id/view`, `/api/raposa/export`, `/api/raposa/verdict-check` | investigations in running, failed, ended-while-running and done states, with cloaked and clean verdicts; a funnel of 3 or more steps; HTML bodies for the view endpoints |
| T11 | `fixtures/data.ts` | data, proxies, watching | `/api/data`, `/api/proxies`, `/api/watching`, `/api/watching/operators` | every data tab (collection, publishers, proxies, raposa, found) populated; 3 watched operators |

- [ ] **Step 1: List what is missing.** `S node tests/parity/run.mjs probe --routes <routes>` lists the unmatched calls.
- [ ] **Step 2: Write handlers and `ready` selectors** until a probe on all four devices shows zero unmatched calls, zero page errors and `ready` found on every route.
- [ ] **Step 3: Check coverage.** Open the probe PNGs in `.out/probe/`. Every route shows populated content, and every item in the coverage column is visible somewhere.
- [ ] **Step 4: Typecheck.** `S tsc --noEmit -p tests/parity` exits 0.
- [ ] **Step 5: Commit.** `test(parity): <area> fixtures`.

### Task T12: Baseline capture and determinism

**Files:**
- Modify only if needed for determinism: `site/tests/parity/scenarios.ts` (`act` waits) and `parity.spec.ts` (`mask` for any element that is truly time-random, with each mask listed in the commit message)

**Interfaces:**
- Consumes: T5 to T11.
- Produces: `$PARITY_DIR/snapshots/*.png` and `$PARITY_DIR/overflow.json`, which every later compare reads.

- [ ] **Step 1: Capture.** `S node tests/parity/run.mjs baseline` ends with `PASS n/n`, where n is 60 page shots plus the scenario shots plus 30 overflow checks.
- [ ] **Step 2: Determinism.** Run `S node tests/parity/run.mjs selftest` twice. Both runs end `PASS n/n`.
- [ ] **Step 3: Head equals base.** `S node tests/parity/run.mjs compare --all` ends with `PASS n/n`. This proves T5's import-order and token changes are invisible.
- [ ] **Step 4: Commit** any determinism fixes: `test(parity): baseline determinism`.

---

## Pilots (W4)

Each pilot runs the SCP. Pilots also record in their commit body any codemod behaviour that needed hand work, so that T3 can be fixed before W5 if a pattern repeats.

### Task P1 (J): ui/button and ui/badge

- **Files:** `src/components/ui/button.tsx`, `src/components/ui/badge.tsx`, plus their modules.
- **Routes:** ad, export.
- **Notes:**
  - Both files use `cva`, so SCP-2 resolves `CVA`.
  - The shape required by D3 is:

    ```ts
    type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    type ButtonSize = "default" | "sm" | "lg" | "icon";
    const VARIANT: Record<ButtonVariant, string>;
    const SIZE: Record<ButtonSize, string>;
    function buttonVariants(opts?: { variant?: ButtonVariant | null; size?: ButtonSize | null; className?: string }): string;
    ```

    `buttonVariants` returns `clsx(styles.root, VARIANT[variant ?? "default"], SIZE[size ?? "default"], className)`.
  - Take the variant and size key sets from the cva call at BASE. `ButtonProps` keeps `variant` and `size` with the same types.
  - `badgeVariants` takes `{ variant?, className? }` and is built the same way.
  - Base, variant and size rules are all incoming (`:where`). The caller `<Button size="sm" className="h-7 text-xs">` in `raposa/export` must still win.
- [ ] SCP with `FILES="src/components/ui/button.tsx src/components/ui/badge.tsx"` and `ROUTES="ad,export"`.

### Task P2: OperatorLink and FoxIcon

- **Files:** `src/components/OperatorLink.tsx`, `src/components/raposa/FoxIcon.tsx`.
- **Routes:** all routes except export, developers and login, so the SCP-7 run is `compare --routes ads,operators,ad,operator,publishers,publisher,raposa,investigation,data,proxies,search,watching`.
- **Scenarios:** ads-touch, operators-touch.
- **Notes:**
  - `[@media(hover:none)]:opacity-100` becomes `@media (hover: none)`.
  - `linkClass` and `className` are passthrough (incoming).
  - FoxIcon's `className` identifier passes through unchanged.
- [ ] SCP with these `FILES` and `ROUTES`.

### Task P3: Stage and delta style maps

- **Files:** `src/components/spy/stage.ts`, `src/components/spy/format.ts`, `src/components/creative/StageBadge.tsx`.
- **Routes:** ad, ads, data, investigation, operator, operators, proxies, publisher, publishers, raposa, search, watching.
- **Notes:**
  - `STAGES` has 5 stages, with keys `dot`, `text`, `tint`, `stroke` and `fill`. `DELTA_CLASS` has 4 tones. Each becomes a `<map><Key>` module class in `stage.module.css` and `format.module.css`.
  - The non-class fields (`label`, `sentence`, `value`) are unchanged.
  - Update the doc comment in `stage.ts` from "Tailwind utilities" to "module classes".
  - StageBadge's template literal becomes `clsx`.
- [ ] SCP with these `FILES` and `ROUTES`.

---

## Lane A: ui primitives (W5)

All tasks run the SCP. Elements that receive `className` are incoming.

| Task | FILES (under `src/components/ui/`) | ROUTES | Notes |
|---|---|---|---|
| A1 | `label.tsx`, `checkbox.tsx` | none | Cross-file `peer` (D11): checkbox keeps the literal `peer`, and label uses `:global(.peer)`. Resolve `CROSS-FILE-GROUP`. |
| A2 | `dialog.tsx`, `sheet.tsx` | none | `sheetVariants` is a cva (D3). `data-[state]` enter/exit animations use `var(--animate-enter/exit)` with `--enter-*`/`--exit-*`. Responsive self rules: DialogContent `sm:rounded-lg`, Header `sm:text-left`, Footer `sm:flex-row sm:justify-end sm:space-x-2`, and the same for Sheet. |
| A3 | `select.tsx` | ads, operators, publishers | Portaled content; offsets on `data-[side]`; `data-[state]` animations; `data-[disabled]`, `data-[highlighted]`. Scenario: ads-select-open. |
| A4 | `popover.tsx`, `tooltip.tsx` | all | Tooltip is in the layout closure. `data-[state=delayed-open]` and `data-[side]` slide-ins. Scenarios: ads-tooltip, ads-calendar-open. |
| A5 | `dropdown-menu.tsx` | none | `data-[highlighted]`, `data-[disabled]`, `focus:`. |
| A6 | `chart.tsx` | none | Eleven `[&_.recharts-*]` variants become `.root :global(.recharts-…)`. The generated `<style>` stays (D27). |
| A7 | `card.tsx`, `table.tsx`, `skeleton.tsx` | none | Used only by `skeletons.tsx`. TableRow's `hover:bg-muted/50` is overridden by C12's callers, which double their class. |
| A8 | `input.tsx`, `textarea.tsx`, `separator.tsx` | none | `file:` becomes `::file-selector-button`; `placeholder:` becomes `::placeholder`; `focus-visible:` ring composition; `disabled:`. |
| A9 | `slider.tsx`, `tabs.tsx` | none | `data-[state=active]`, `data-[disabled]`. |

- [ ] A1 to A9: each runs the SCP with the row's `FILES` (prefixed `src/components/ui/`) and `ROUTES`.

## Lane B: ember and spy (W5)

| Task | FILES | ROUTES | Notes |
|---|---|---|---|
| B1 (J) | `src/components/ember/ui.tsx` | ad, ads, data, developers, investigation, operator, operators, proxies, publisher, publishers, raposa, search, watching | `BUTTON_TONES` and `BADGE_TONES` are maps; 18 components take `className`. EmberPage's responsive self rules are `sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-7`. EmberCheckbox's dead `checked:bg-[url(...)]` is dropped (R-j). `cls` identifiers. |
| B2 | `src/components/spy/controls.tsx` | ads, operators, publishers | Local class constants become module classes. The exported `FIELD_CLASS` becomes `export const FIELD_CLASS = styles.field`; EmberSelect and CalendarRangePicker keep importing it. |
| B3 | `src/components/spy/signals.tsx` | ad, ads, investigation, operator, operators, publisher, publishers, raposa, search, watching | Heat-level maps; one member-expression `className`. |
| B4 | `src/components/spy/cards.tsx` | ads, investigation, operator, operators, publisher, publishers, raposa, search, watching | `card-link` and `card-link-host` stay global; `group-hover` becomes a same-file ancestor class. The exported `TABLE_COLUMNS` becomes a module class string; AdRadarTableView keeps importing it. Scenario: ads-card-hover. |
| B5 | `src/components/spy/OperatorViews.tsx` | operators | 11 `cn` sites. |
| B6 | `src/components/spy/ResultsToolbar.tsx`, `src/components/spy/ResultsState.tsx` | ads, operators, publishers | Scenarios: ads-empty, ads-error. |
| B7 | `src/components/spy/AdGridView.tsx`, `src/components/spy/SpyImage.tsx`, `src/components/spy/SpyStageBadge.tsx` | ad, ads, investigation, operator, operators, publisher, publishers, raposa, search, watching | The exported `GRID_CLASS` becomes `export const GRID_CLASS = styles.grid`; OperatorViews, OperatorAds and search/page keep importing it. SpyStageBadge consumes `STAGES` (P3). |
| B8 | `src/components/spy/SpyTooltip.tsx`, `src/components/spy/EmberSelect.tsx`, `src/components/spy/RangeSlider.tsx` | ad, ads, investigation, operator, operators, publisher, publishers, raposa, search, watching | Portaled content uses `emberPortalClass`. |
| B9 | `src/components/spy/SpyPage.tsx`, `src/components/spy/SpyPageSkeleton.tsx`, `src/components/AdCardSkeleton.tsx` | ads, operators, search | Scenarios: ads-pending, operators-pending, search-pending. |

- [ ] B1 to B9: each runs the SCP with the row's `FILES` and `ROUTES`.

## Lane C: shared components

| Task | Wave | FILES (under `src/components/`) | ROUTES | Notes |
|---|---|---|---|---|
| C1 | W5 | `Header.tsx`, `watching/WatchingBell.tsx`, `watching/WatchButton.tsx` | all | `!bg-[var(--ember-bg-header)]` is redundant, so drop `!`. Container `max-w-[2560px] mx-auto px-4 sm:px-6 lg:px-8` becomes desktop 2rem, tablet 1.5rem, mobile 1rem. Scenarios: data-header-hover, operator-watch-toast. |
| C2 | W5 | `Toaster.tsx`, `VoiceFeedbackButton.tsx` | all | `DOT` stays a map of module classes and `ACTION_CLASS` becomes a module class; `app-toaster` and `spy-toast-indeterminate` stay literal. `print:hidden`, `motion-reduce:hidden`, `animate-ping`, and a responsive self rule `sm:right-4 sm:bottom-4`. Scenario: voice-focus. |
| C3 | W6 | `AdCard.tsx`, `AdRadarSignalView.tsx` | ads, operator, search | `DELTA_CLASS` (P3) in `cn`: own declarations that DELTA overrides are dropped (R-b). |
| C4 | W6 | `AdRadarTableView.tsx`, `MarketPulseStrip.tsx` | ads, operators | Local `HEADER_LABEL` and `ROW` constants become module classes; `TABLE_COLUMNS` (B4) is referenced as imported. Scenarios: ads-view-table, ads-table-row-hover. |
| C5 | W6 | `CalendarRangePicker.tsx` | ads, operators, publishers | `FIELD_CLASS` (B2) is referenced as imported; popover content with `emberPortalClass`. Scenario: ads-calendar-open. |
| C6 | W6 | `VerticalFilter.tsx` | ads, operators, publishers | Scenario: ads-vertical-open. |
| C7 | W6 | `AdVelocityChart.tsx`, `../lib/time_series_econometrics.ts` | ad, operator | Regime tone map; recharts props untouched; `xl:grid-cols-4`. Remove `badgeClass` from `RegimeDetails` and its 5 values (D14). |
| C8 | W6 | `CombinationMatrix.tsx`, `CampaignTaxonomyDecompiler.tsx` | ad | |
| C9 | W6 | `VisualFunnelFlow.tsx`, `TrackingPixelDossier.tsx` | ad | DomainLink caller: the hover override is doubled (R-l). |
| C10 | W6 | `PublisherDossierDialog.tsx`, `RaposaDossierDrawer.tsx`, `PublishersSidebar.tsx` | ad, ads, operators, publishers | Radix Dialog with `emberPortalClass`; overlay and content `data-[state]` animations. Scenarios: publishers-dossier-open, ad-drawer-open. |
| C11 | W6 | `ProxyLines.tsx`, `VelocitySparkline.tsx` | data, proxies | VelocitySparkline is unused (static check only). |
| C12 | W6 | `skeletons.tsx` | none | 190 literals, unused; `2xl:grid-cols-5` goes in the wide block. TableRow callers double `hover:bg-transparent`. |
| C13 | W6 | `InvestigationScreen.tsx` | investigation | DomainLink caller (doubled hover); `xl:max-w-[640px]`. |

- [ ] C1 to C13: each runs the SCP with the row's `FILES` and `ROUTES`, in its wave.

## Lane D: feature folders (W6)

| Task | FILES (under `src/components/`) | ROUTES | Notes |
|---|---|---|---|
| D1 | `ad/AdHeader.tsx`, `ad/bits.tsx` | ad, operator | `DELTA_CLASS`; 2 DomainLink callers (doubled hover); `valueClass` passthrough. |
| D2 | `ad/AdPageSkeleton.tsx`, `ad/RaposaPanel.tsx`, `ad/TrackingPanel.tsx` | ad | TrackingPanel's style map; `xl:grid-cols-4`. Scenario: ad-pending. |
| D3 | `data/CollectionTab.tsx`, `data/charts.tsx` | data, proxies | Template literal with `className`; recharts; `xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]`. |
| D4 | `data/FindingsTab.tsx`, `data/PublishersTab.tsx`, `data/RaposaTab.tsx` | data, proxies | RaposaTab's local `FIELD` constant becomes a module class; `xl:grid-cols-4`. Scenarios: data-publishers, data-raposa, data-found. |
| D5 | `operator/DetailHeader.tsx`, `operator/OperatorAds.tsx` | operator, publisher, publishers | `GRID_CLASS` (B7) is referenced as imported. |
| D6 | `operator/OperatorEvidence.tsx`, `operator/OperatorRows.tsx` | operator, search | `DELTA_CLASS` in OperatorRows. |
| D7 | `publisher/PublisherHeader.tsx`, `publisher/PublisherSections.tsx` | publisher, publishers | A ternary between two grid templates. |
| D8 | `publisher/PublisherViews.tsx` | publishers | 48 literals. |

- [ ] D1 to D8: each runs the SCP with the row's `FILES` and `ROUTES`.

## Lane E: raposa (W6)

| Task | FILES (under `src/components/raposa/`) | ROUTES | Notes |
|---|---|---|---|
| E1 | `RaposaButton.tsx`, `RunState.tsx`, `Sampling.tsx` | ads, investigation, operator, operators, raposa, search | RaposaButton's template strings (`BASE`, `EMBER_BASE`, `EMBER_TEXT`, `iconClass` plus `animate-spin`) become maps and `clsx`. |
| E2 | `StopButton.tsx`, `list/RecheckButton.tsx`, `list/ResolveButton.tsx` | investigation, raposa | |
| E3 | `BurnedLines.tsx`, `CaptureFrame.tsx` | ad, data, investigation, operator, proxies | |
| E4 | `Compare.tsx`, `investigation/CaptureThumb.tsx` | investigation | The local `boxClass = cn(…)` becomes `clsx` of module classes. |
| E5 | `Distributions.tsx` | ad | 72 literals; `xl:grid-cols-2`. |
| E6 | `investigation/FunnelInspector.tsx` | investigation | The JS `matchMedia("(max-width: 1023px)")` already matches D2; keep it. DomainLink caller (doubled hover). Scenario: investigation-funnel-step. |
| E7 | `investigation/PageFiles.tsx`, `investigation/DisguiseTable.tsx` | investigation | DomainLink caller in PageFiles; a ternary in DisguiseTable. |
| E8 | `investigation/VerdictBox.tsx`, `list/InvestigateForm.tsx` | investigation, raposa | Scenario: raposa-form-focus. |
| E9 | `list/InvestigationCard.tsx` | investigation, raposa | DomainLink caller (doubled hover). |

- [ ] E1 to E9: each runs the SCP with the row's `FILES` and `ROUTES`.

## Lane F: routes (W7 and W8)

| Task | FILES (under `src/`) | ROUTES | Notes |
|---|---|---|---|
| F1 | `app/layout.tsx`, `app/loading.tsx`, `app/login/page.tsx` | all | Body classes, the Suspense fallback `ember h-14 border-b …`, and the container (as C1). `import "./globals.css"` stays the first import. Login's local `field` constant becomes a module class. |
| F2 | `app/ads/[id]/page.tsx`, `app/advertisers/[id]/page.tsx`, `app/publishers/[id]/page.tsx` | ad, operator, publisher | DomainLink caller in the ad page (doubled hover). |
| F3 | `app/data/page.tsx`, `app/publishers/page.tsx` | data, proxies, publishers | `xl:grid-cols-5` twice; a ternary with `animate-spin`. |
| F4 | `app/developers/page.tsx` | developers | 61 literals; local `FIELD` and `LABEL` constants become module classes; the `opacity-60` ternary. |
| F5 | `app/raposa/page.tsx`, `app/search/page.tsx` | raposa, search | Template literal with `animate-spin`; `GRID_CLASS` (B7) is referenced as imported. |
| F6 (J) | `app/raposa/export/page.tsx` | export | `print:static print:overflow-visible print:bg-white` go in a `print` block. Literal colours `#e5e5e5`, `#111`, `#bbb`, `#b91c1c` and `11pt` sizes stay literal. The inline `<style>` with `@page` and `!important` stays verbatim with its `sheet` and `no-print` markers (D27). Scenario: export-print. |
| F7 | `app/watching/page.tsx` | watching | 41 literals. |
| F8 (W8) | `components/DomainLink.tsx` | ad, ads, investigation, operator, operators, publisher, publishers, raposa, search, watching | Converts last (D31). Before starting, confirm with `grep -rln "<DomainLink" site/src` that every caller file has a module. Its self rules are incoming; its hover stays at natural specificity. |

- [ ] F1 to F7 in W7, then F8 in W8: each runs the SCP with the row's `FILES` and `ROUTES`.

---

## Gates

### Tasks G1, G2, G3 (J): Wave gate

G1 runs after W5, G2 after W6 and G3 after W8.

**Interfaces:**
- Consumes: every task branch of the wave.
- Produces: a `css-modules` that passes everything, pushed to `origin`.

- [ ] **Step 1: Merge.** Merge every task branch of the wave (worktree protocol), then remove the worktrees.
- [ ] **Step 2: Sync with `master` (D32).**
  - Run `git fetch origin master` and `git diff --name-only $(cat site/tests/parity/BASE) origin/master -- site/src`.
  - If that lists files, run `git merge origin/master`.
  - For each listed file that already has a module: `git checkout origin/master -- <file>`, delete its module, and rerun SCP-1 to SCP-6 for it.
  - A listed styled file that is new joins the next wave as an extra task. At G3, the gate converts it itself.
  - Then write the new `master` sha to `site/tests/parity/BASE`, run `S node tests/parity/run.mjs baseline --force`, and commit `chore(css): move parity BASE to <sha>`.
- [ ] **Step 3: Static check.** `S node scripts/tw2css/check.mjs --converted` prints only `OK` lines.
- [ ] **Step 4: Guard.** `S node scripts/check-styles.mjs --converted` exits 0.
- [ ] **Step 5: Types and build.** `S tsc --noEmit -p .` and `S next build` both succeed.
- [ ] **Step 6: Full parity.** `S node tests/parity/run.mjs compare --all` ends with `PASS n/n`, including overflow at 700 and 1100.
- [ ] **Step 7: Fix and push.** Fix each failure in the file that owns it and commit `fix(css): …`. Then `git push origin css-modules`.
- [ ] **Step 8 (G3 only): Nothing left to convert.**
  - `grep -rn "@/lib/utils" site/src` prints nothing.
  - `S node scripts/tw2css/convert.mjs --all --dry-run` reports 0 elements still carrying Tailwind classes.

---

## Removal and delivery

### Task R1 (J): Remove Tailwind and turn on the guard

**Files:**
- Create: `site/src/styles/reset.css`
- Modify: `site/src/app/globals.css`, every `site/src/**/*.module.css` (unwrap), `site/package.json`, `pnpm-lock.yaml`, `.gitignore`
- Delete: `site/postcss.config.mjs`, `site/components.json`, `site/src/styles/ember-theme.css`, `site/src/lib/utils.ts`, `site/scripts/tw2css/`

**Interfaces:**
- Consumes: G3's green branch, and `$PARITY_DIR/base/site/.next` (the compiled BASE CSS).
- Produces: a site with no Tailwind, and `"build": "node scripts/check-styles.mjs --final && next build"`.

- [ ] **Step 1: Write `reset.css`.**
  - From the compiled BASE CSS (the chunk under `$PARITY_DIR/base/site/.next/static/chunks/` that contains `@layer theme`), copy the preflight rules: the start of `@layer base`, up to the app's own `:root { --background`.
  - Wrap them in `@layer reset { … }`.
  - Replace the default variables:

    | Compiled form | Replacement |
    |---|---|
    | `var(--default-font-family, …)` | `var(--font-sans)` |
    | `var(--default-mono-font-family, …)` | `var(--font-mono)` |
    | `var(--default-font-feature-settings, normal)` | `normal` |
    | `var(--default-font-variation-settings, normal)` | `normal` |
    | `var(--default-mono-font-feature-settings, normal)` | `normal` |
    | `var(--default-mono-font-variation-settings, normal)` | `normal` |

  - Keep the `::placeholder` `@supports` block as compiled.
- [ ] **Step 2: Rewrite the top of `globals.css`.** It becomes exactly:

  ```css
  @layer reset, base, components;
  @import "../styles/reset.css";
  @import "../styles/tokens.css";
  @import "../styles/animations.css";
  @import "../styles/ember.css";
  ```

  Delete `@import "tailwindcss"`, `@import "tw-animate-css"`, the `ember-theme.css` import, `@custom-variant dark` and the `@theme inline` block. Keep the rest unchanged.
- [ ] **Step 3: Unwrap and delete.**
  - First run `S node scripts/tw2css/check.mjs --converted --unlayered`. Delete every module declaration it reports (each was dead at BASE), and rerun until it prints only `OK` lines.
  - `S node scripts/tw2css/convert.mjs --unwrap-all`, so modules become unlayered.
  - Delete the files listed above.
  - Remove `site/.tw2css-cache/` from `.gitignore`.
- [ ] **Step 4: Remove the packages.** `PNPM --filter site remove tailwindcss @tailwindcss/postcss @tailwindcss/node tw-animate-css tailwind-merge class-variance-authority autoprefixer shadcn cn recast`.
- [ ] **Step 5: Wire the guard.** Set `"build": "node scripts/check-styles.mjs --final && next build"` in `site/package.json`.
- [ ] **Step 6: Verify.**
  - `S node scripts/check-styles.mjs --final` exits 0.
  - `S node --test scripts/check-styles.test.mjs` passes.
  - `S tsc --noEmit -p .` exits 0.
  - `PNPM --filter site build` succeeds, which runs the guard.
  - `S node tests/parity/run.mjs compare --all` ends with `PASS n/n`.
  - `grep -rliE "tailwind|tw-animate|twMerge|class-variance" site --exclude-dir=node_modules --exclude-dir=.next --include=*.ts --include=*.tsx --include=*.css --include=*.json --include=*.mjs | grep -v check-styles` prints nothing.
- [ ] **Step 7: Prove the guard bites.** Add `className="flex"` to any page. `PNPM --filter site build` must fail with `TW-LITERAL`. Revert the change.
- [ ] **Step 8: Commit.** `chore(css): remove Tailwind; style guard runs in build`.

### Task R2: Docs

**Files:**
- Modify: `AGENTS.md`, `DESIGN_GUIDELINES.md`, `INFRASTRUCTURE.md`

**Interfaces:**
- Consumes: D2, D9, D19 and the file layout.
- Produces: docs that name CSS Modules and the tokens instead of Tailwind.

- [ ] **Step 1: AGENTS.md.**
  - Rule 2, second bullet: the semantic tokens become `var(--color-background)`, `var(--color-card)`, `var(--color-accent)`, `var(--color-foreground)`, `var(--color-muted-foreground)` and `var(--color-border)`, used in CSS Modules.
  - Rule 3, first bullet: the container is `max-width: 2560px; margin-inline: auto` with `padding-inline` 2rem on desktop, 1.5rem below 1024px and 1rem below 600px, in `layout.module.css` and `Header.module.css`.
  - Rule 2 gains a bullet: ui/ components keep the shadcn structure and Radix parts but are styled with CSS Modules; anything `shadcn add` generates must be converted before commit, because the build guard rejects Tailwind.
- [ ] **Step 2: DESIGN_GUIDELINES.md.**
  - Update line 38, the container, as in AGENTS.
  - Update line 128: the Ember tokens are used directly as `var(--ember-*)` in modules, and `ember-theme.css` is gone.
  - Update §6 "Color Tokens": use the `var(--color-*)` names.
  - Add a §7 "Styling" section of at most 12 lines, covering:
    - one `<Name>.module.css` per file;
    - the global files of constraint 7;
    - the tokens in `src/styles/tokens.css`;
    - the breakpoints of constraint 4, desktop-first;
    - `clsx` for merging;
    - no `!important`;
    - `ember-type-*` as global presets;
    - `scripts/check-styles.mjs` as the build guard.
- [ ] **Step 3: INFRASTRUCTURE.md, line 272.** Change it to `- **Styling**: CSS Modules (Next built-in), tokens in site/src/styles/tokens.css, build guard site/scripts/check-styles.mjs`. Leave line 273 as it is.
- [ ] **Step 4: Verify.** `grep -n -i "tailwind\|max-w-\[2560px\]\|bg-background\|ember-theme" AGENTS.md DESIGN_GUIDELINES.md INFRASTRUCTURE.md` prints nothing.
- [ ] **Step 5: Commit.** `docs: styling is CSS Modules`.

### Task R3: Final proof, PR, staging

**Files:** none in the repo. The PR body is written to a temp file.

**Interfaces:**
- Consumes: R1 and R2 merged on `css-modules`.
- Produces: an open PR into `master`, and the branch on staging.

- [ ] **Step 1: Last sync with `master`.** Run the G-step-2 diff.
  - If `master` changed styled files, merge it and convert those changes by hand, following the SCP rules (the codemod is gone).
  - Move BASE, recapture the baseline, and confirm `PNPM --filter site build` passes (the guard catches any Tailwind left behind).
- [ ] **Step 2: Final parity.** `S node tests/parity/run.mjs compare --all` ends with `PASS n/n`. Keep the summary line.
- [ ] **Step 3: Push.** `git push -u origin css-modules`.
- [ ] **Step 4: Open the PR.** `gh pr create --base master --head css-modules --title "Convert site styling from Tailwind to CSS Modules" --body-file <tmp>`. The body has these sections:
  - **What:** modules, tokens, globals, guard.
  - **Why:** the hub Design import reads CSS Modules only.
  - **How:** the codemod on Tailwind's compiler; two proofs per file.
  - **Proof:** the parity summary line, the `check.mjs --converted` count from G3, and the count of routes, scenarios and devices.
  - **Intended change:** the D2 width ranges 600–639, 600–767 and 1024–1279.
  - **Deploy:** "Merging this PR deploys production through deploy-site.yml."
  - **Staging:** the URL once deployed.

  End the body with your session's attribution line, without emoji.
- [ ] **Step 5: Staging.** Run `scripts/staging-add`. If `pnpm` is not on PATH, first run `S tsc --noEmit -p .` and `PNPM --filter site build` yourself, then `scripts/staging-add --no-check`. Then:
  - `gh workflow run deploy-staging.yml --ref master -f ref=staging`;
  - `gh run watch` until it succeeds;
  - `curl -sI https://staging.adhunters.pro/healthz` returns 200.
- [ ] **Step 6: Hand over.** Post the PR URL and the staging URL for the owner. Do not enable auto-merge. When the owner approves:
  - `gh pr merge --auto --squash` (AGENTS 3.1a);
  - after the merge, `git fetch && git switch staging && git merge origin/master && git push`.

---

## Coverage

These files have no styling, so they get no task. Each was checked: no `className` and no class strings.
- In `src/app/`: `(spy)/page.tsx`, `(spy)/loading.tsx`, `ads/[id]/loading.tsx`, `advertisers/page.tsx`, `advertisers/loading.tsx`, `proxies/page.tsx`, `raposa/[id]/page.tsx`, `apple-icon.tsx`.
- In `src/components/`: `AdRadar.tsx`, `AdsSidebar.tsx`, `AdvertisersSidebar.tsx`, `Providers.tsx`, `DevInterfaceKit.tsx`, `spy/pies.tsx`, `spy/toast.tsx`, `spy/window-context.tsx`, `spy/fonts.ts`, `operator/operator-name.ts`, `publisher/labels.ts`, `data/format.ts`, `data/types.ts`, `raposa/format.ts`, `raposa/types.ts`, `raposa/investigation/funnel.ts`.
- `src/lib/raposa-compare.ts` holds plain CSS for generated report HTML. It is not Tailwind and stays.

Styled files and their tasks (112 in all: 109 with `className`, plus `spy/stage.ts`, `spy/format.ts` and `lib/time_series_econometrics.ts`):

| Group | Files | Tasks |
|---|---|---|
| Pilots | 7 | P1–P3 |
| ui | 17 | A1–A9 |
| ember/spy | 16 | B1–B9 (ember/ui, 14 spy files and AdCardSkeleton) |
| shared | 24 | C1–C13 (23 components and `lib/time_series_econometrics.ts`) |
| feature folders | 17 | D1–D8 |
| raposa | 17 | E1–E9 |
| app | 13 | F1–F7 |
| DomainLink | 1 | F8 |

Global CSS: `globals.css` (T5, R1), `ember-theme.css` (R1, deleted), `toaster.css` and `ember.css` (unchanged).
