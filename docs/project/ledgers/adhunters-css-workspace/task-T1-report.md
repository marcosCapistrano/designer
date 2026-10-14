# Task T1 report: branch setup, BASE pin, dev dependencies

Status: done. Committed on `css-modules`. Not pushed.

## Commit
- `8287574` chore(css): branch setup, parity BASE pin, codemod dev dependencies
  - Parent: `b51af4f` (origin/master at time of work)

## Changes
- `site/tests/parity/BASE`: `b51af4f87e332fb0567645977d2080344798d3e3`
- `site/package.json` devDependencies added, exact versions: `@playwright/test@1.56.1`, `@tailwindcss/node@4.3.3`, `@babel/parser@7.29.9`, `recast@0.23.11`, `postcss-selector-parser@7.1.0`
- `pnpm-lock.yaml` updated by `npx -y pnpm@12.5.1 --filter site add -D`. Side effect: next's peer set now includes `@playwright/test@1.56.1`.
- `site/tsconfig.json` exclude: `["node_modules", "tests", "scripts"]` (`scripts` per N13)
- `.gitignore`: appended `site/tests/parity/.out/`, `site/.tw2css-cache/`, `site/test-results/`, `site/playwright-report/`

## Checks
- `npx -y pnpm@12.5.1 install --frozen-lockfile`: exit 0
- `npx -y pnpm@12.5.1 --filter site exec tsc --noEmit -p .`: exit 0
- `NEXT_TELEMETRY_DISABLED=1 npx -y pnpm@12.5.1 --filter site exec next build`: exit 0
- `node -e "import('@tailwindcss/node')..."` printed `function`

## Concerns
1. origin/master moved from `f79b876` to `b51af4f` (Raposa and Watching commits) after the preflight was checked. The brief's step 1 (`git switch -c css-modules origin/master`) was applied as a fast-forward of the empty `css-modules` branch to `b51af4f`, and BASE is `b51af4f`. The preflight facts (route counts, F05 ordering, token and file counts) were verified against `f79b876` and need a recheck at `b51af4f`. If the coordinator wanted BASE at `f79b876`, the commit and BASE must be redone.
2. The build log was written to `/tmp/ah-css-build.log` rather than the session scratchpad. It is outside the repo and not committed.
