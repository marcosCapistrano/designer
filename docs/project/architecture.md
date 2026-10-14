# Hub architecture contract (binding for plans 2-6)

The spec (`docs/superpowers/specs/2026-10-14-hub-design.md`, also at /mnt/project-files/designer/spec.md) is the authority. This file pins the shared names that let the plans be written in parallel. Plans run in order 1 → 6, so a plan may rely on everything an earlier plan produces.

Code lives in the repo `marcosCapistrano/designer`, a pnpm 10 monorepo on Node 22 with TypeScript strict ESM and vitest.

## Packages and apps

| Path | Owner plan | Purpose |
|---|---|---|
| `packages/design-model` (`@hub/design-model`) | 1 | Pure design document, ops, undo, files, `exportPage(doc,pageId) -> {html,css}`, `describeOp`. See plan 1 for the exact API. |
| `packages/protocol` (`@hub/protocol`) | 2 creates; 3, 4, 6 extend | Shared TS types only (no runtime deps): HTTP DTOs and WebSocket messages `ServerMsg` / `ClientMsg` as discriminated unions on `type`. |
| `packages/renderer` (`@hub/renderer`) | 2 | Node + Playwright. Renders exported page HTML/CSS per device into WebP tiles at 3 zoom levels plus a hit map. |
| `packages/sync` (`@hub/sync`) | 5 | Static extractor: React (TS compiler API) + CSS Modules (css-tree) → `DesignDoc` pages/components with source-location IDs. |
| `apps/server` (`@hub/server`) | 3 creates; 4, 5, 6 extend | Hono on `@hono/node-server`, `ws` WebSocket at `/ws`, `better-sqlite3` for hub state, HTTP under `/api`. |
| `apps/client` (`@hub/client`) | 2 creates (canvas + dev harness); 3 adds shell/app list/Build; 4 Deploy/New app; 6 Design area + voice | Vite + Preact + TS PWA. Canvas 2D. Budget: under 150 KB JS gzipped. |
| `templates/vite-hono-pg` | 4 | New-app template (Vite React TS CSS Modules web, Hono api, shared types, Postgres migrations, Dockerfile, compose.yml, CI, `.hub/app.json`, `design/`). |

## Fixed decisions

- **Devices**: desktop 1440px (`base`), tablet 834px, mobile 390px. Media queries are `(max-width: 1023px)` and `(max-width: 599px)`.
- **Tiles**: 512×512 WebP at zoom levels `0.25`, `0.5`, `1`. Tile key is `sha256('r' + RENDER_VERSION + ':' + html + css + device + zoom)` in hex (RENDER_VERSION from `@hub/renderer`, bumped whenever rendering output can change), with tile index `x_y`. The hit map is `{ nodeId, x, y, w, h }[]` in page CSS pixels at zoom 1, in paint order.
- **Server-side Claude**: `@anthropic-ai/claude-agent-sdk` `query()`, using the subscription login of the server's Claude Code (never set `ANTHROPIC_API_KEY`). Everything goes through the interface `ClaudeRunner { run(opts: { cwd: string; prompt: string; resume?: string; mcpServers?: Record<string, unknown>; allowedTools?: string[]; systemPrompt?: string }): AsyncIterable<AgentEvent> }` in `apps/server/src/claude/runner.ts` (plan 3). Tests use a fake runner. `AgentEvent` = `{type:'text',text}` | `{type:'tool',name,input}` | `{type:'done',sessionId,ok:boolean,error?:string}`.
- **Auth**: the server binds to the address in `HUB_BIND` (the Tailscale IP in production). There is also a single-user passphrase (`HUB_PASSPHRASE_HASH`, scrypt) that issues an httpOnly session cookie. Both are required.
- **Config**: env vars loaded in `apps/server/src/config.ts` (plan 3): `HUB_BIND`, `HUB_PORT` (default 8787), `HUB_DATA_DIR` (sqlite + caches), `HUB_APPS_DIR` (git checkouts, one dir per app), `HUB_PASSPHRASE_HASH`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `HCLOUD_TOKEN` (plan 4), `HUB_SSH_KEY_PATH` (plan 4), `WHISPER_BIN` and `WHISPER_MODEL` (plan 6).
- **App registry**: an app is any directory in `HUB_APPS_DIR` that is a git checkout. It is "adopted" when `.hub/app.json` exists and validates. The manifest schema is in spec section 4. The zod schema lives in `@hub/protocol` (zod is allowed there as the single exception to "types only").
- **Server module layout** (`apps/server/src/`): `config.ts`, `db.ts`, `auth/`, `apps/` (registry and manifest), `ws/` (hub and broadcast), `claude/` (runner), `git/` (simple-git wrapper), `github/` (Octokit: PRs, checks), `build/` (Build sessions), `deploy/` + `infra/` (plan 4), `newapp/` + `adopt/` (plan 4), `sync/` (plan 5 glue), `design/` (plan 6: design sessions, MCP design tools, render queue), `voice/` (plan 6).
- **Client layout** (`apps/client/src/`): `canvas/` (plan 2), `shell/` (plan 3: login, app list, area tabs), `areas/build/` (3), `areas/deploy/` (4), `areas/design/` (6), `voice/` (6), `net/` (plan 3: typed fetch + WS client over `@hub/protocol`).
- **Design tools for Claude** (plan 6): an in-process MCP server built with the Agent SDK's `createSdkMcpServer`. It exposes `design_get_page`, `design_find_nodes`, `design_apply_ops` (Op[] JSON, validated by design-model, preview/immediate decided by `classifyBatch`) and `design_alloc_ids`. Claude never writes design files.
- **Deploy safety** (plan 4): production promote requires a confirm token that the server issues for a specific SHA and that the client sends back after the user taps Confirm. Voice-originated requests can never carry one.
- **Whisper** (plan 6): whisper.cpp CLI with the `small` multilingual model (language auto-detect). The client records Opus/WebM, and the server converts it to 16 kHz WAV with ffmpeg before transcribing.

## Testing conventions

- Unit tests are vitest files next to the code. Server tests use `app.request()` (Hono) and an in-memory sqlite. Anything that reaches the network (GitHub, Hetzner, SSH, Claude) goes behind an interface with a fake in tests.
- Playwright Chromium is at `/opt/pw-browsers` in CI-like containers (`PLAYWRIGHT_BROWSERS_PATH`). Renderer tests use the real browser.
- Client logic (tile math, culling, hit testing, stores) is tested in vitest with jsdom where needed. There is one Playwright smoke test per area.
