You're continuing work on "the hub": a tablet-first web app (Galaxy Tab S6 Lite) for designing, building and deploying my apps by chat/voice. Repo: github.com/marcosCapistrano/designer.

Read first:
- Spec: docs/project/spec.md and docs/project/architecture.md
- Plans: docs/project/plans/ (design-engine, renderer-canvas, hub-server-build, deploy-newapp)
- Ledgers/briefs: docs/project/ledgers/ (trust these and git log over memory)

Constraints:
- No paid AI API key. The hub's AI features run Claude Code headless (CLI/Agent SDK) under my Claude subscription login, on an always-on Hetzner server reachable only via Tailscale. Keep it that way.
- Apps use React + plain CSS / CSS Modules. No Tailwind, ever.
- Every app: .hub/app.json manifest, Docker, GitHub Actions + GHCR, staging then production. Prod only gets images that passed staging + tests, and needs my tap to confirm.
- No domains or budget: staging on Tailscale, prod on sslip.io.

State as of 2026-10-14:
- Merged to main: PR #1 design engine, PR #2 renderer + tablet canvas.
- Merged to main: PR #3 hub server (login, app list, Build area).
- adhunters-v4's conversion from Next.js + Tailwind + shadcn to plain CSS Modules is draft PR #50. This work is paused: do not continue the conversion for now.
- For adhunters-v4, merging to master deploys to production, and staging uses the production database. Do not merge PR #50 or run staging actions that could change production data.
- Next, in order: page import (sync an app's pages into the design folder, CSS-only), canvas editing (select an element, edit by tap or by chat, preview, send to Build; voice later), then Deploy/New app/Adopt (plan 4 is written; its pre-flight rulings are in docs/project/plans/plan4-preflight.md).
- I still need to rent a Hetzner server and run the setup script.

How I work: be autonomous and decide forks yourself (record the rulings). Break implementation into small focused tasks. Keep only one plan written ahead. Open PRs and drive them to green; I merge. Stop only for irreversible or outside-world actions (prod deploys, paid resources, deletions).
