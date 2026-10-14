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

