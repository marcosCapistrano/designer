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

