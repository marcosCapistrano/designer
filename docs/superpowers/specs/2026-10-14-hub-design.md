# Hub (with Designer): Spec

Date: 2026-10-14 · Status: draft for review

## 1. Goal

One tablet-first web app that is the control center for all of your apps. From a Galaxy Tab S6 Lite, by typing or speaking, you can:

- **Design** an app's pages on an infinite canvas, where every edit changes only what you asked for.
- **Build**: give any technical prompt, and Claude Code does the work in that app's repo.
- **Deploy** to staging, test, then promote the same build to production.
- **Create** a new app (repo, servers, databases, URLs, CI) in one flow.

Every app follows one convention, so the hub treats all apps the same and none of them drifts into spaghetti. Creative freedom is in the design and the prompts. Integrity is enforced by the hub, not left to discipline.

### Success criteria

- Panning and zooming a canvas of 50+ pages stays smooth on a Tab S6 Lite.
- An edit request never changes anything outside its target. Every change is visible as an exact operation and can be undone.
- Production only ever receives an image that already ran on staging and passed tests.
- "New app" goes from a name to a live staging URL without manual server work.
- AI usage runs on your Claude subscription through Claude Code. No API key is needed.

## 2. Decisions made

| # | Decision |
|---|----------|
| Q1 | Each app repo has a `design/` folder. The hub syncs it with the code before you design, and an agent implements the result. |
| Q2/3 | Sync reads the **source code** (React + plain CSS / CSS Modules) and does not need the app running. It is incremental: only pages whose source changed are rebuilt. |
| Q4 | The canvas shows **server-rendered page images**. Selection uses a hit map of element boxes saved with each image. |
| Q5 | Handoff is an **ordered changelist** of exact edits plus the updated pages. |
| Q6 | Voice is **push-to-talk**, transcribed by **local Whisper** on the server. Text lands in the chatbox to confirm. |
| Q7 | Small single-element edits apply immediately with undo. Edits touching several elements, pages, or a shared component show a **preview first**. |
| Q8 | Design, Build, and Deploy all ship as one release. The build order is internal (section 10). |
| Q9 | The hub runs on an **always-on Hetzner server**, reachable **only via Tailscale**. |
| Q10/11 | Apps run on Hetzner as **Docker images**. Staging and production are Docker Compose stacks behind Caddy, deployed over SSH, with one-tap rollback. |
| Q12 | **Shared** staging and production servers by default. An app can be promoted to dedicated servers. |
| Q13 | New-app template: **Vite + React + TS + CSS Modules**, **Hono** API, **Postgres** with versioned migrations, one repo, shared types, a separate DB per environment. |
| Q14 | GitHub + GitHub Actions + GHCR. **No domains yet**: staging is private on Tailscale, production uses `<app>.<ip>.sslip.io`. The domain is one manifest setting, for later. |
| Q15 | Existing apps open as they are. **Adopt** adds the convention on a branch for review. |

## 3. Architecture

```
Tablet (PWA, browser) ──Tailscale/HTTPS──► Hub server (Hetzner, always on)
                                            ├─ Hub API (Node + TS, Hono), SQLite for hub state
                                            ├─ Claude Code via Agent SDK (subscription login)
                                            ├─ Design engine (model, ops, validation, op log)
                                            ├─ Renderer (Playwright Chromium → WebP tiles + hit maps)
                                            ├─ Whisper (whisper.cpp, small multilingual model, CPU)
                                            ├─ Git checkouts of every app
                                            └─ Infra driver (Hetzner API, SSH, GitHub API)
                                                   │
                         ┌─────────────────────────┴──────────────────────┐
                 Shared staging server                          Shared production server
                 (Caddy, Docker, Postgres per app)              (Caddy, Docker, Postgres per app)
```

- **Hub server**: a Hetzner CX32 (4 vCPU, 8 GB) is recommended, and 4 GB is the minimum. Claude Code is logged in once with your subscription (`claude login` / `claude setup-token`).
- **Client**: a PWA in Preact (small bundle) with a Canvas 2D renderer. Target: under 150 KB of JS gzipped and 60 fps panning.
- **Realtime**: one WebSocket per tablet carries streamed Claude output, render-ready events, deploy logs, and transcripts.
- **Security**: the hub has no public port and is reachable only on Tailscale (Tailscale also provides the HTTPS cert the mic needs). Secrets (Hetzner token, GitHub fine-grained token, SSH keys) stay on the hub server, encrypted at rest, and never go to the client.

## 4. Per-app convention

Every app repo has `.hub/app.json`:

```json
{
  "name": "myapp",
  "template": "vite-hono-pg@1",
  "design": { "dir": "design", "routes": "web/src/routes.tsx", "devices": ["desktop", "tablet", "mobile"] },
  "build": { "install": "pnpm i", "test": "pnpm test", "typecheck": "pnpm typecheck" },
  "deploy": {
    "image": "ghcr.io/<user>/myapp",
    "staging":    { "server": "shared-staging",    "url": "http://myapp.staging.<tailnet>" },
    "production": { "server": "shared-production", "url": "https://myapp.<ip>.sslip.io", "domain": null }
  }
}
```

Template repo layout: `web/` (Vite React, CSS Modules), `api/` (Hono), `shared/` (types), `db/migrations/`, `design/`, `Dockerfile`, `compose.yml`, `.github/workflows/ci.yml` (typecheck, test, build image tagged with commit SHA, push to GHCR).

An app is **adopted** when the manifest, Dockerfile, compose file, and CI exist and CI is green. Non-adopted apps get Build and Design but not Deploy.

## 5. Design area

### 5.1 Design model (`design/` in each repo)

- `pages/<page>.json`: an HTML-shaped node tree. Each node has `id`, `tag`, `attrs`, `text`, `classes`, `style` (base + `tablet` + `mobile` overrides), `children`, or `component` + `props` for instances.
- `components/<Name>.json`: component definitions with declared props.
- `tokens.json`: colors, spacing, type scale, radii.
- `sync.json`: for each page, the git commit and source file hashes it was built from.
- `changes.jsonl`: the ordered op log since the last implementation (this is the changelist).

Files are written in canonical form (sorted keys, stable ordering), so git diffs show only real changes. Any page exports 1:1 to HTML + CSS, which is the representation the renderer and the implementing agent see.

### 5.2 Edit operations (the only way anything changes)

`setStyle(node, device, prop, value)`, `setText`, `setAttr`, `insertNode`, `removeNode`, `moveNode`, `wrapNodes`, `extractComponent`, `setInstanceProp`, `detachInstance`, `setToken`, `addPage`, `duplicatePage`, `removePage`.

- Claude never writes design files. It calls these ops as MCP tools that the hub provides. The engine validates every op (node exists, valid CSS property and value, no cycles) and rejects invalid ones with a reason Claude can correct.
- Applying an op is a pure function of (model, op), so the same ops always produce the same result.
- Each op stores its inverse, which gives undo/redo.
- Preview policy (Q7): an op batch that touches one node and one property applies immediately. Anything wider (several nodes, several pages, a component definition, tokens) is shown as a proposed list plus re-rendered previews and waits for Apply.

### 5.3 Targeting

- Tap a page image: the hit map resolves the node under your finger and the client draws a highlight overlay. Drag selects a box region. Selection is sent with the prompt as node IDs.
- Naming things ("the signup button") is resolved by Claude to node IDs and shown highlighted. In the preview flow, nothing applies until you confirm.
- **Device rule**: an edit made with a selection in the desktop frame writes the base style. With a selection in the tablet or mobile frame, it writes that device's override. Saying a device explicitly overrides this rule.

### 5.4 Sync from source (incremental, deterministic)

1. `git diff` from each page's recorded commit finds the pages whose source files changed. Other pages are not touched.
2. A **static extractor** (TypeScript compiler API for JSX, a CSS parser for CSS Modules) builds the node tree. Node IDs are derived from the source location (component file + JSX element path), so they stay the same across syncs.
3. Claude fills only what static analysis can't decide: sample data for lists and fetched content, and which conditional branch or state to show. Its choices are stored in `sync.json` and reused next time, so they don't flip between syncs.
4. If unimplemented changes exist, sync rebuilds the baseline and replays the pending ops on top. Any op whose target vanished is flagged for you, never silently dropped.

### 5.5 Rendering

- The hub renders each page × device with Playwright into WebP tiles at 3 zoom levels plus a hit map (`nodeId → box`).
- After an edit, only the affected pages × devices re-render. Component edits re-render every page that uses the component.
- The client draws tiles on Canvas 2D with viewport culling, picks the zoom level that fits, and caches tiles in IndexedDB keyed by content hash.
- Multi-device preview: each page is shown as desktop (1440), tablet (834), and mobile (390) frames side by side, and each device can be toggled.

### 5.6 Components

Each React component found during sync becomes a design component, and instances link to it. `extractComponent` creates new ones from a selection. Instance overrides are limited to declared props and text, so a component edit propagates predictably.

### 5.7 Handoff

"Send to Build" starts a Build task with `changes.jsonl` plus the exported HTML/CSS of the affected pages. Claude Code implements on branch `design/<date>-<slug>` and follows the normal Build flow. Once that is merged, the changelist is archived and the affected pages re-sync from the new code.

## 6. Build area

- There is one chat per app, backed by a Claude Code session (Agent SDK) running in the app's checkout. Output streams to the tablet, and sessions persist and can be resumed.
- Claude works on a branch, never directly on `main`. Every task ends with typecheck + tests passing locally, a pushed branch, a PR, and CI green.
- Claude Code has full permissions inside the repo but **cannot deploy**. Deploy is a hub action only, so a prompt can't skip staging.
- "Merge" in the hub merges the PR once CI is green, and that deploys to staging automatically.

## 7. Deploy area

- **Staging**: every merge to `main` produces image `:<sha>`. The hub SSHes to the staging server, runs migrations on the app's staging DB, and restarts the stack. Health check and logs stream to the tablet.
- **Production**: "Promote to production" lists only SHAs that ran on staging with green CI. A confirm card names the SHA, the commits included, and the pending migrations. **It requires a tap, and voice alone never triggers it.**
- **Rollback**: one tap redeploys the previous production SHA. Migrations must be backward-compatible (expand/contract), and the template's migration lint checks this.
- Every deploy is logged (who, when, SHA, result, logs) in the hub DB.

## 8. New app and Adopt

**New app** (name → live staging URL):
1. Create a GitHub repo from the template and fill in `.hub/app.json`.
2. If the shared servers don't exist yet, create them through the Hetzner API (CX22 each, firewall, Docker, Caddy, Tailscale).
3. Create staging and production Postgres DBs and secrets for the app.
4. Configure the Caddy routes (staging on the tailnet, production on sslip.io).
5. CI builds the first image, and the hub deploys it to staging.

**Promote to dedicated servers** creates new servers, moves the stacks and DBs, and switches the routes.

**Adopt** (existing app): Claude adds the manifest, Dockerfile, compose file, CI, and a minimal test on a branch and opens a PR for your review.

## 9. Voice

Push-to-talk records audio with MediaRecorder (Opus) on the tablet. The server transcribes it with whisper.cpp (small multilingual model) and the text appears in the chatbox. You tap send, or say "send". Any destructive or production action still needs its confirm card.

## 10. Build order (one release, built in this order)

1. Hub server bootstrap, Tailscale, auth, PWA shell, app list, WebSocket.
2. Build area (Claude Code sessions, branches, PRs, CI status).
3. Convention, template repo, Adopt.
4. Deploy (staging, promote, rollback, logs) and New app with Hetzner provisioning.
5. Design engine (model, ops, op log, undo, validation) with tests.
6. Renderer and canvas client (tiles, hit maps, selection, devices).
7. Sync from source (static extractor + Claude gap-filling).
8. Handoff, voice, and polish on the real tablet.

## 11. Error handling

- Invalid ops are rejected with reasons, and Claude retries. After 2 failed retries, the hub asks you.
- A failed sync leaves the previous design untouched.
- A failed staging deploy keeps the old version running. A failed production health check auto-rolls back.
- If Claude Code hits a subscription usage limit, the hub shows it and queues the task.
- A failed render shows the last good image with a warning badge.

## 12. Testing

- Design engine: unit tests for every op and its inverse, plus property tests (apply then undo returns the identical canonical file).
- Sync: fixture React apps to check that extraction gives the same output twice and that IDs stay stable across unrelated edits.
- Deploy: integration test against a throwaway Hetzner server (manual trigger).
- Client: performance test on a Tab S6 Lite (or a throttled Chrome profile) with 50 pages × 3 devices.

## 13. Open questions

- Where the hub's own code lives (a new GitHub repo name).
- Your spoken language(s) for Whisper (this picks the model).
- Risk: Let's Encrypt rate limits on sslip.io names could delay production HTTPS. The fallback is plain HTTP for production until you buy a domain.
