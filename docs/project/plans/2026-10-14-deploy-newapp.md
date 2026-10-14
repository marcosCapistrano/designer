# Deploy Area, New App, Adopt and the App Template Implementation Plan (Plan 4 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the per-app convention and everything that rides on it: the `vite-hono-pg@1` template, a Deploy area (staging on every merge, tests against staging, SHA-pinned promote with a tap-only confirm card, one-card rollback, auto-rollback, deploy history with live logs), a New app flow (name → repo, shared Hetzner servers, databases, Caddy routes, first staging URL), Adopt (convention added on a Build branch as a PR), and Move to dedicated servers.

**Architecture:** `apps/server` gains `infra/` (Hetzner client, OpenSSH runner, GHCR registry check, cloud-init, Caddy sites, `ServerManager`), `deploy/` (store, confirm tokens, compose contract, remote commands, `StackOps`, relocation, pipeline, confirm cards, `DeployService`, routes), `newapp/` (template renderer, setup runs, repo bootstrap, `NewAppService`, `MoveService`, setup routes) and `adopt/` (manifest + prompt, `AdoptService`). A merge reaches `DeployService.onMerged` through plan 3's `BuildDeps.onMerged`; the service waits until CI is green on the merge SHA and the `:<sha>` image exists in GHCR, then SSHes (as root, over Tailscale) to the server named in `.hub/app.json` at that SHA, pulls, migrates, swaps, health-checks, rolls back on failure and runs the image's smoke tests. Production accepts only a SHA whose staging deploy passed CI and smoke tests, and only with a single-use confirm token issued for that SHA; requests marked as voice-originated are refused. Adopt and Move never touch a default branch: they start a plan 3 Build task whose branch is seeded with the hub-written `.hub/app.json`. The client gains `areas/deploy/` (Deploy area, confirm dialog, New app page, Adopt and Move panels) and a `#/new` route. Claude Code and every Build command run as the unprivileged user `hub-agent`, started through `setpriv` with no capabilities (Task 41). The hub runs git only in hub-owned mirrors of each checkout (Task 42). Nothing Claude writes therefore ever executes as `hub`, the user that holds the credentials.

**Tech Stack:** Plan 3's stack (Node 22, pnpm 10.28, TypeScript strict ESM, vitest 5, Hono 4, better-sqlite3, simple-git, Octokit, Preact). New hub dependency: `yaml ^2.9.1` (server), plus `@hub/design-model` as a server devDependency (template test). Hub host: util-linux `setpriv` (Ubuntu 24.04 base system) for the agent user. Remote side: Ubuntu 24.04, Docker Engine + Compose plugin (`get.docker.com`), Caddy from the official apt repo, Tailscale, ufw. Template: pnpm workspace with React `^19.3.0`, Vite `^8.3.4`, `@vitejs/plugin-react ^6.1.2`, Hono `^4.13.13`, `@hono/node-server ^2.1.5`, `pg ^8.23.1`, tsx `^4.23.15`, vitest `^5.0.4`, TypeScript `^7.0.2`, `postgres:17-alpine`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-hub-design.md` (also `/mnt/project-files/designer/spec.md`): §4 per-app convention, §7 Deploy area, §8 New app, Promote to dedicated servers and Adopt, §10 steps 3–4, §11 deploy rows, §12 "Deploy: integration test against a throwaway Hetzner server (manual trigger)". Binding names: `/mnt/project-files/designer/architecture.md`. This plan extends plan 3 (`/mnt/project-files/designer/plans/2026-10-14-hub-server-build.md`) and never recreates its files. Extension points used by their plan 3 names: `MIGRATIONS` (append), `ServerMsg` + `SERVER_MSG_TYPES`, `BuildDeps.onMerged`, `SECRET_ENV_KEYS` / `CREDENTIAL_KEYS` / `scrubEnv` / `loadConfig`, `ClaudeRunner` + `buildQueryOptions`, `checkToolUse`, `GitHub` + `FakeGitHub` + `OctokitGitHub`, `GitRepo` / `openRepo` / `gitEnv` / `makeTestRepo`, `AppRegistry`, `AppManifestSchema` / `parseAppManifest` / `APP_NAME_RE` (`@hub/protocol/manifest`), `BuildService.send`, `resolveBuildCommands`, `createApp` / `AppDeps`, `startHub` / `HubOptions`, `dev/fake-hub.ts`, client `ApiClient` / `WsClient`, `shell/route.ts`, `shell/AppView.tsx` (Deploy tab), and `ops/hub/*` + `docs/hub-bootstrap.md`. Plan 1's `parseDoc` validates the template's `design/` folder.

**Verified on 2026-10-14** (Context7, docs.hetzner.cloud, docs.github.com, caddyserver.com, nip.io/sslip.io, npm registry, live probes of ghcr.io):
- Hetzner Cloud API `https://api.hetzner.cloud/v1`, `Authorization: Bearer`. `POST /servers` takes `name`, `server_type`, `image`, `location`, `ssh_keys`, `firewalls: [{ firewall: id }]`, `user_data` (cloud-init, max 32 KiB), `labels`, `start_after_create`, `public_net`. It returns `{ server, action, next_actions, root_password }`. `GET /servers?label_selector=`, `GET/DELETE /servers/{id}`, `GET /actions/{id}` (the per-resource action routes are deprecated).
- Hetzner changelog: `datacenter` was removed from `POST /servers` on 2026-07-01, so this plan always sends `location`. `cx22`/`cx32` cannot be ordered since 2026-01-01; their successors are `cx23` (2 vCPU, 4 GB) and `cx33`. Spec §8's "CX22" therefore becomes `cx23`.
- Hetzner `POST /firewalls { name, labels, rules: [{ direction, protocol, port, source_ips, description }], apply_to }`. CIDRs may not have host bits set (from 2025-12-10). `POST /ssh_keys { name, public_key }`. A duplicate public key gives `uniqueness_error`. Errors are `{ error: { code, message, details } }`. `GET /server_types?name=` carries `prices[].price_monthly.gross` per location.
- GitHub REST: `POST /user/repos` and `POST /orgs/{org}/repos` (`name`, `description`, `private`, `auto_init`) need the fine-grained "Repository creation"/"Administration" write permission. `POST /repos/{template_owner}/{template_repo}/generate` exists but needs a template repository on GitHub, so it is not used. `PUT /repos/{o}/{r}/actions/secrets/{name}` takes `{ encrypted_value, key_id }`, sealed with libsodium `crypto_box_seal` against `GET …/actions/secrets/public-key`. It is verified but not used, because no Actions secret is needed (see Global Constraints). Pushing `.github/workflows/*` needs the "Workflows" write permission.
- GHCR: "GitHub Packages only supports authentication using a personal access token (classic)". Servers pull with a classic token that has only `read:packages`: `echo $TOKEN | docker login ghcr.io -u USER --password-stdin`. Workflows push with `GITHUB_TOKEN` and `permissions: packages: write`. A live probe showed that `GET https://ghcr.io/token?service=ghcr.io&scope=repository:<owner>/<name>:pull` returns `{"token":…}` and that `HEAD /v2/<owner>/<name>/manifests/<tag>` without a bearer token returns 401 with a `Bearer realm="https://ghcr.io/token"` challenge (Docker Registry v2 token auth).
- Current GitHub Actions majors: `actions/checkout@v6`, `actions/setup-node@v6` (v7.0.0 is the newest; v6 is kept for `cache: pnpm`), `pnpm/action-setup@v6` (reads `packageManager` when `version` is omitted), `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/build-push-action@v7`.
- Caddy: the official apt repo is cloudsmith `caddy/stable` and runs a systemd unit `caddy`. `systemctl reload caddy` reloads gracefully. A site address with an explicit port and no host (`:8001`) is plain HTTP on that port. A hostname address gets automatic HTTPS. `import sites/*.caddy` with an empty glob is not an error. `caddy validate --config … --adapter caddyfile` checks a config.
- sslip.io and nip.io are interchangeable: `app.203.0.113.7.sslip.io` resolves to `203.0.113.7`. Let's Encrypt raised the shared domain's limit to 250,000 certificates per week, and wildcard certificates are not supported.
- Claude Agent SDK `Options.env` replaces the child environment (plan 3). systemd: the `%d` specifier is the unit's credentials directory (`Environment=FOO=%d/foo`), and access is restricted to the service's user. `ImportCredential=NAME` searches `/etc/credstore.encrypted/` (decrypting) and skips a missing credential, whereas in systemd's `exec-credential.c` a missing file for `LoadCredentialEncrypted=` is fatal unless that credential is marked optional. It exists since systemd 254, and Ubuntu 24.04 ships 255.
- npm (2026-10-14): `yaml 2.9.1`, `react 19.3.0`, `vite 8.3.4` (needs Node ≥ 22.12), `@vitejs/plugin-react 6.1.2` (peer `vite ^8`), `hono 4.13.13`, `@hono/node-server 2.1.5`, `pg 8.23.1`, `@types/pg 8.23.1`, `@types/react(-dom) 19.3.0`, `@types/node 22.20.5`, `tsx 4.23.15`, `vitest 5.0.4` (peer `vite ^6.4 || ^7 || ^8`), `typescript 7.0.2`.
- Claude Agent SDK 0.3.299 (`sdk.d.ts`):
  - It has `Options.spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`. `SpawnOptions` is `{ command, args, cwd?, env, signal }`, and a Node `ChildProcess` satisfies `SpawnedProcess`.
  - Without the hook, the SDK runs its bundled native CLI from `@anthropic-ai/claude-agent-sdk-linux-x64` in `node_modules`.
- Linux capabilities, probed as root on kernel 6.18 with util-linux 2.39.3 `setpriv`. Per capabilities(7), only a change away from uid 0 clears capabilities. The test parent was non-root and held ambient `CAP_SETUID`/`CAP_SETGID`.
  - **Node's `spawn({ uid, gid })` is unsafe.** The child is left with `CapEff` = `CapAmb` = `0xc0`, so it could switch users again. libuv's `setgroups(0)` also drops every supplementary group.
  - **`setpriv` is safe.** The same parent running `setpriv --reuid=U --regid=G --groups=G2 --inh-caps=-all --ambient-caps=-all --no-new-privs -- cmd` gives a child with `CapInh`, `CapPrm`, `CapEff` and `CapAmb` all zero, `NoNewPrivs: 1`, and the requested groups.
  - **Stopping the child needs `CAP_KILL`.** Without it, signalling the child fails with `EPERM`.
- systemd 255 (`man/systemd.exec.xml`):
  - `ProtectProc=invisible` hides other users' processes from the unit's `/proc`, as long as `User=` is set and `CAP_SYS_PTRACE` is absent.
  - `AmbientCapabilities=` with a non-root `User=` adds `keep-caps` by itself.
- git 2.43 (Ubuntu 24.04), probed:
  - In a repo made with `git init --bare --shared=0640 --template=`, nothing is group-writable except `FETCH_HEAD`, and `fetch --no-write-fetch-head` avoids writing that file.
  - `git bundle create - <ref> --not --remotes=origin` streams the bundle to stdout. When there is nothing new, it exits 128 with `Refusing to create empty bundle.`
  - A bare mirror can fetch from that bundle file and then push `<sha>:refs/heads/<branch>`.

## Global Constraints

- Plan 3's Global Constraints still apply: Node 22, the pnpm 10 workspace, TypeScript strict ESM with `noUncheckedIndexedAccess`, tests as `*.test.ts` next to the code, `pnpm -r typecheck` and `pnpm -r test` from the root, no network in tests, the client's runtime dependencies (`preact`, `idb-keyval`, `@hub/protocol`), the < 150 000 byte gzipped client budget, client unit tests in vitest's `node` environment, and quoted strings as exact copy.
- Lockfiles: only Task 1 changes hub `package.json` dependencies or `pnpm-lock.yaml`. Only Task 21 writes `templates/vite-hono-pg/pnpm-lock.yaml`. `templates/` is not a workspace package: the root `pnpm-workspace.yaml` keeps `packages/*` and `apps/*` only, and the template has its own `pnpm-workspace.yaml`.
- **Deploy credentials never reach Claude's processes.**
  - **A separate user.** Claude Code runs as the system user `hub-agent` (`HUB_AGENT_USER`), which has no login shell and no sudo. So does every command that runs app code: Build install, typecheck and test, and the fix loop. Git pushes, GitHub, SSH, Hetzner and deploys stay in the hub process as `hub` (Task 41).
  - **No capabilities in the child.** The hub changes user only through `agentArgv`:
    - The child starts as `setpriv --reuid --regid --groups --inh-caps=-all --ambient-caps=-all --no-new-privs`.
    - The hub never uses Node's `spawn({ uid, gid })`, which would leave `CAP_SETUID` in the child (see the header).
    - The unit grants exactly `AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_KILL`. `CAP_KILL` lets the hub stop agent processes on a timeout or a Stop.
  - **Credentials.**
    - `HCLOUD_TOKEN`, `GHCR_READ_TOKEN`, `TS_AUTHKEY` and the SSH deploy key exist only as systemd encrypted credentials in `/etc/credstore.encrypted`.
    - The hub's unit imports them with `ImportCredential=`. `HUB_SSH_KEY_PATH=%d/HUB_SSH_KEY` points into the unit's credentials folder, which only `hub` can read.
    - The key is never written to `~/.ssh`, to any path under `HUB_APPS_DIR`, or to any other file. `loadConfig` rejects a `HUB_SSH_KEY_PATH` inside `HUB_APPS_DIR` or `~/.ssh`.
  - **Startup check.** When `HUB_AGENT_USER` is set, `main.ts` runs `checkAgentIsolation` before it serves anything.
    - The hub exits if `hub-agent` holds any capability, or can read or enter the credentials folder, `HUB_DATA_DIR`, `HUB_TEMPLATES_DIR` or the hub's home.
    - Without `HUB_AGENT_USER`, `deployProblems` keeps Deploy, New app, Adopt and Move off (Task 1).
  - **Hidden processes.** `ProtectProc=invisible` hides the hub's processes from `hub-agent`, including their command lines and environments. Even so, the hub never puts a token in a command line: mirror git gets it through `GIT_CONFIG_*` environment variables (Task 42).
  - **Git runs only in mirrors.** In production the hub never runs git inside a checkout.
    - Each app has a hub-owned bare mirror in `HUB_MIRRORS_DIR`, made with `git init --bare --shared=0640 --template=`.
    - The hub fetches from GitHub and pushes to GitHub only there. `hub-agent` runs every git command in the checkout.
    - Commits reach the mirror only as a `git bundle` streamed over a pipe (Task 42).
    - So hooks, config, filters and attributes in a checkout only ever run as `hub-agent`.
  - **Files.** The hub never executes code from a checkout and never follows a symlink inside one.
    - It writes there only through `writeCheckoutFile`, and it reads files it passes on through `readCheckoutFile` (Task 8).
    - Plans 5 and 6 must do the same for anything they read from a checkout and give to Claude or the client.
  - **Layout**, created by `ops/hub/bootstrap.sh` (Task 20). The unit runs with `UMask=0007`, so files either user creates in a checkout stay group-writable.
    - `/var/lib/hub`: `hub`, 0700. This is the hub's home, and `HUB_DATA_DIR=/var/lib/hub/data` (0700) sits inside it.
    - `HUB_APPS_DIR=/var/lib/hub-apps`: `hub:hub-apps`, 2750, so `hub-agent` cannot add, rename or remove checkouts. Each checkout root is `hub:hub-apps`, 2770.
    - `HUB_MIRRORS_DIR=/var/lib/hub-mirrors`: `hub:hub-apps`, 2750. `hub-agent` reads the mirrors and never writes them.
    - `/var/lib/hub-agent`: `hub-agent`, 0700. It holds Claude Code's `~/.claude`, the pnpm store, and a global `safe.directory=*`. The checkout roots belong to `hub`, and `hub-agent` is the less privileged side, so trusting every checkout is safe.
    - `/opt/hub/templates` (`HUB_TEMPLATES_DIR`): `hub`, 0700.
  - **Env scrub.**
    - `SECRET_ENV_KEYS` covers every deploy secret plus `SSH_AUTH_SOCK`, and `scrubEnv` removes them from every child: Claude, git, build commands and ssh.
    - The Claude child's env is `scrubEnv(...)` plus `CLAUDE_CODE_OAUTH_TOKEN`, which the SDK runner adds back explicitly. `agentEnv` then points `HOME` at `/var/lib/hub-agent`.
    - The SSH runner passes the key explicitly with `-i`, `-F /dev/null`, `IdentitiesOnly=yes` and `IdentityAgent=none`, and only to commands the hub itself runs.
  - **Guard.** The Build guard also denies tool calls that name credential paths (Task 9). This is defense in depth on top of the user split.
- Secrets reach app servers only on SSH stdin: the registry token for `docker login --password-stdin`, `.env`, and `secrets.env` during a move. They never appear in a command line, a deploy log line, an API response or a WebSocket message. `POSTGRES_PASSWORD` is generated on the server (`openssl rand -hex 24` into `secrets.env`, mode 600) and the hub never stores it.
- No GitHub Actions secrets are created: CI pushes images with the built-in `GITHUB_TOKEN`.
- **Confirm tokens.** Production promote, production rollback and every paid-server creation need a confirm token.
  - The server issues it for exactly `(app, action, subject)`, it is single-use, and it expires after 300 000 ms. The subject is the full SHA for promote/rollback and `servers:<sorted keys>` for provisioning.
  - Any request carrying the header `x-hub-origin: voice` is refused on token-consuming routes with 403, even when the token is valid.
  - The client sends a token only from a trusted pointer event (`event.isTrusted`) on the confirm dialog's Confirm button, and never sets `x-hub-origin`.
- Production only ever receives an image that already ran on staging. `promote` accepts a SHA only when a staging deploy of that SHA succeeded with `ciOk` and `testsOk`, and production deploys that record's image.
- The hub never pushes the default branch of an existing repo. Adopt and Move change files through `BuildService.send(..., { seedFiles })` on a `build/…` branch. The one default-branch push is the initial commit of a repository New app has just created and that is still empty on GitHub.
- Hetzner: server type `cx23`, image `ubuntu-24.04`, `location` from `HUB_HCLOUD_LOCATION` (default `nbg1`), never `datacenter`. Shared server keys are `shared-staging` and `shared-production`; dedicated keys are `<app>-<env>`. A server's key is its Hetzner name, its Tailscale hostname and its `hub-server` label.
- Remote commands run as `root` over SSH to `<key>.<HUB_TAILNET>`. Every interpolated value in a remote command goes through `shq`, and app names, server keys and SHAs are validated before use.
- Ports and URLs. App slot `n` (1–999, one per app, allocated once):
  - The container publishes `127.0.0.1:${20000 + n}:3000`.
  - Staging is `http://<server>.<tailnet>:${8000 + n}` (Caddy `:${8000+n}` site, reachable only over Tailscale).
  - Production is `https://<app>.<ipv4>.sslip.io`, plus `deploy.production.domain` when the manifest sets one.
- **Deploy contract** for every app, from the template or adopted:
  - `compose.yml` has the services `app`, `migrate` (profile `migrate`) and `smoke` (profile `smoke`), each with image `${APP_IMAGE}:${APP_TAG}`, plus an optional `db`. `app` publishes `"127.0.0.1:${APP_PORT}:3000"`.
  - The app answers `GET /api/health` with HTTP 200 (JSON `{ ok, sha }`).
  - Migrations live in `db/migrations/`.
  - The image tag is the full 40-character commit SHA.
- Times are epoch milliseconds. Deploy ids are SQLite row ids. APIs carry full 40-hex SHAs, and the UI shows `shortSha` (7 characters).
- A task that changes a list that a plan 3 test asserts exactly also updates that test, and the task names it.

## Review Focus

1. **The new version fails its health check after the swap.** Staging must keep (and production must restore) the previous version, and the record must say so. Tests: Task 33 `failed health rolls back to the previous sha` and `first deploy with failing health just fails`.
2. **CI turns green before the image job has pushed `:<sha>`.** The `image` job `needs: check`, so for a while the check runs are all green while the tag is still missing. The deploy must keep waiting, not fail or pull a missing tag. Test: Task 34 `keeps waiting while CI is green but the image is not pushed yet`.
3. **A confirm token is replayed, expired, bound to another SHA, or arrives with a voice origin.** Each must be refused, and a valid one works exactly once. Tests: Task 10 `issues single-use tokens bound to app, action and subject`, `tokens expire after 5 minutes`; Task 34 `voice can never promote`, `promote needs a valid confirm token`.
4. **New app fails halfway (Hetzner quota, CI red, hub restart) and the user tries again.** No second repository, no duplicate servers, and the run resumes. Tests: Task 36 `a failed run can be resumed without duplicates`; Task 25 `interrupted runs fail on restart`.
5. **A shared server is deleted and re-created under the same name, or two flows need it at once.** A stale host key must not lock the hub out, and only one server may be created. Tests: Task 22 `ensure forgets the old host key of a new server` and `concurrent ensure creates one server`.

---

## File Structure

```
apps/server/
  package.json                     (modify, Task 1) + yaml, + devDependency @hub/design-model
  src/config.ts                    (modify) deploy settings and credentials, deployProblems, provisionProblems
  src/claude/guard.ts              (modify) credential markers and paths
  src/claude/run-as.ts             RunAs, resolveRunAs, agentArgv, agentEnv, spawnAsAgent, runAsAgent, checkAgentIsolation
  src/claude/sdk.ts                (modify) runAs: the Claude CLI starts as hub-agent
  src/build/commands.ts            (modify) createRunCommand(runAs)
  src/git/checkouts.ts             Checkouts, plainCheckouts, MirroredCheckouts (hub-owned mirrors)
  src/apps/checkout-fs.ts          readCheckoutFile, writeCheckoutFile (never through a symlink)
  src/github/github.ts, fake.ts, octokit.ts   (modify) createRepo, getRepo
  src/build/service.ts             (modify) send(..., { seedFiles, seedMessage })
  src/db.ts                        (modify) MIGRATIONS gains one entry
  src/infra/hetzner.ts             Hetzner interface, HttpHetzner, HetznerError
  src/infra/fake-hetzner.ts        FakeHetzner
  src/infra/ssh.ts                 SshRunner, OpenSshRunner, NoSsh, shq, sshArgs, readPublicKey
  src/infra/fake-ssh.ts            FakeSsh
  src/infra/ghcr.ts                ImageRegistry, GhcrRegistry, FakeRegistry
  src/infra/cloud-init.ts          cloudInit, caddyfile
  src/infra/sites.ts               ports, URLs, siteConfig
  src/infra/servers.ts             ServerStore, ServerManager, firewallRules
  src/infra/live.test.ts           manual Hetzner integration test (skipped without a token)
  src/deploy/errors.ts             DeployError
  src/deploy/confirm.ts            ConfirmStore, isVoiceOrigin, confirm copy
  src/deploy/store.ts              DeployStore (deploys, logs, slots)
  src/deploy/compose.ts            checkComposeContract, composeServices
  src/deploy/remote.ts             remote command builders
  src/deploy/git-info.ts           AppGit, createAppGit
  src/deploy/fake-git.ts           FakeAppGit
  src/deploy/stack.ts              StackOps (one app stack on one server)
  src/deploy/relocate.ts           relocate (move a stack and its DB to another server)
  src/deploy/cards.ts              promoteCard, rollbackCard, provisionCard
  src/deploy/pipeline.ts           readDeployFiles, runPipeline
  src/deploy/service.ts            DeployService
  src/deploy/routes.ts             /api/apps/:app/deploy…
  src/newapp/template.ts           readTemplate, renderTemplate, imageFor
  src/newapp/runs.ts               SetupRunStore
  src/newapp/repo.ts               writeFiles, bootstrapRepo
  src/newapp/service.ts            NewAppService
  src/newapp/move.ts               MoveService
  src/newapp/routes.ts             setupRoutes (/api/newapp…, /api/setup/runs, adopt, move)
  src/adopt/prompt.ts              adoptManifest, adoptPrompt, packageManagerOf
  src/adopt/service.ts             AdoptService
  src/app.ts, src/server.ts, src/main.ts, src/dev/fake-hub.ts   (modify) composition
  src/ops.test.ts                  (modify) new credentials and settings
packages/protocol/src/deploy.ts    deploy and setup DTOs, labels, constants
packages/protocol/src/ws.ts        (modify) deploy.update, deploy.log, setup.progress
packages/protocol/src/index.ts     (modify) export deploy.ts
templates/vite-hono-pg/            the vite-hono-pg@1 template (own pnpm workspace, not in the hub workspace)
  package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, .gitignore, .dockerignore, README.md
  web/  (Vite React TS, CSS Modules, routes.tsx)   api/  (Hono, pg, migrate, smoke)   shared/  (types)
  db/migrations/0001_init.sql, design/meta.json, design/tokens.json
  Dockerfile, compose.yml, .github/workflows/ci.yml, .hub/app.json
apps/client/src/
  net/api.ts                       (modify) deploy and setup calls
  areas/deploy/state.ts            DeployView reducer and labels
  areas/deploy/setup-state.ts      setup run view helpers, quoteSummary, nameProblem
  areas/deploy/ConfirmDialog.tsx   tap-only confirm card
  areas/deploy/DeployArea.tsx      environments, promote, rollback, history, logs
  areas/deploy/SetupView.tsx       NewAppPage, AdoptPanel, MovePanel, SetupProgress
  areas/deploy/deploy.css
  shell/route.ts, AppList.tsx, AppView.tsx, App.tsx   (modify) #/new, New app link, Deploy tab
apps/client/e2e/deploy.spec.ts     New app → staging → promote smoke test
apps/client/e2e/build.spec.ts      (modify) the Deploy tab now shows the deploy area
ops/hub/hub.service, hub.env.example, set-secret.sh, bootstrap.sh   (modify) hub-agent, folders, capabilities
ops/hub/make-ssh-key.sh            deploy key as an encrypted credential
ops/hub/add-app.sh                 an existing repo: hub-owned mirror plus hub-agent's checkout
docs/hub-bootstrap.md              (modify) "Deploy and New app" section
.github/workflows/deploy-live.yml  manual live Hetzner test
```

## Dependency lanes

Tasks in the same wave can run in parallel. Each task's **Consumes** line is authoritative. Plan 3 must be complete before Wave 1. Tasks 41 and 42 come last in the document but run in Waves 1 and 2. Every task that runs Claude, Build commands or git in production sits in a later wave and gets its `RunAs` and `Checkouts` from them.

| Wave | Tasks |
|---|---|
| 1 | 1 (config + deps), 2 (protocol), 3 (template renderer), 4 (Hetzner), 6 (GHCR), 7 (GitHub repos), 8 (Build seed files + checkout files), 9 (guard), 26 (adopt prompt), 41 (hub-agent user) |
| 2 | 5 (SSH), 10 (confirm), 11 (deploy store), 14 (AppGit), 15 (template web), 16 (template api), 17 (client API), 18 (client deploy state), 19 (client setup state), 20 (ops), 42 (git mirrors) |
| 3 | 12 (cloud-init + sites), 13 (compose + remote), 24 (cards), 25 (setup runs + repo), 27 (ConfirmDialog + DeployArea) |
| 4 | 21 (template ops + lockfile), 22 (servers), 23 (StackOps), 32 (SetupView) |
| 5 | 28 (relocate), 29 (AdoptService), 30 (MoveService), 31 (live test) |
| 6 | 33 (pipeline) |
| 7 | 34 (DeployService) |
| 8 | 35 (deploy routes), 36 (NewAppService) |
| 9 | 37 (setup routes) |
| 10 | 38 (createApp + startHub) |
| 11 | 39 (main + fake hub) |
| 12 | 40 (shell wiring + e2e) |

---

### Task 1: Deploy settings, credentials and the two hub dependencies

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/package.json`, `pnpm-lock.yaml`
- Modify: `apps/server/src/config.test.ts` (the `loads a full environment` expectation)
- Test: `apps/server/src/config-deploy.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 3 (`HubConfig`, `loadConfig`, `CREDENTIAL_KEYS`, `SECRET_ENV_KEYS`, `scrubEnv`, `ConfigError`), plan 3 Task 10 (`buildQueryOptions`, test only).
- Produces:

```ts
export interface HubConfig {
  /* plan 3 fields unchanged */
  hcloudToken: string | null;      // credential HCLOUD_TOKEN
  ghcrToken: string | null;        // credential GHCR_READ_TOKEN (classic PAT, read:packages only)
  ghcrUser: string | null;         // HUB_GHCR_USER, else GITHUB_OWNER, else null
  tsAuthKey: string | null;        // credential TS_AUTHKEY
  sshKeyPath: string | null;       // resolved HUB_SSH_KEY_PATH when that file exists, else null
  tailnet: string | null;          // HUB_TAILNET, lowercased
  hcloudLocation: string;          // HUB_HCLOUD_LOCATION, default 'nbg1'
  acmeEmail: string | null;        // HUB_ACME_EMAIL
  templatesDir: string;            // HUB_TEMPLATES_DIR resolved, default DEFAULT_TEMPLATES_DIR
  agentUser: string | null;        // HUB_AGENT_USER ('hub-agent' in production; Task 41 resolves it)
  mirrorsDir: string;              // HUB_MIRRORS_DIR resolved, default join(dirname(appsDir), 'hub-mirrors')
}
export const DEFAULT_TEMPLATES_DIR: string;   // fileURLToPath(new URL('../../../templates', import.meta.url))
export const DEFAULT_HCLOUD_LOCATION = 'nbg1';
export const CREDENTIAL_KEYS: readonly string[] = ['HUB_PASSPHRASE_HASH', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HCLOUD_TOKEN', 'GHCR_READ_TOKEN', 'TS_AUTHKEY'];
export const SECRET_ENV_KEYS: readonly string[] = [/* plan 3's nine keys, in order */, 'GHCR_READ_TOKEN', 'TS_AUTHKEY', 'SSH_AUTH_SOCK'];
export function deployProblems(c: HubConfig): string[];
export function provisionProblems(c: HubConfig): string[];
```

Rules added to `loadConfig`, applied after plan 3's checks:
- `HCLOUD_TOKEN`, `GHCR_READ_TOKEN` and `TS_AUTHKEY` are read like plan 3's credentials (env first, then `${CREDENTIALS_DIRECTORY}/<KEY>`).
- `HUB_TAILNET` (trimmed, lowercased) must match `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/`, else `ConfigError('HUB_TAILNET must be your tailnet DNS name, like tail1234.ts.net')`.
- `HUB_SSH_KEY_PATH` is `path.resolve`d. If it lies inside `appsDir`, or inside `join(env.HOME, '.ssh')` when `HOME` is set, throw `ConfigError('HUB_SSH_KEY_PATH must not be inside HUB_APPS_DIR or ~/.ssh. Store the key with ops/hub/make-ssh-key.sh.')`. "Inside" means `relative(dir, p)` is `''` or neither starts with `..` nor is absolute. A path that does not exist gives `sshKeyPath: null`.
- `HUB_DATA_DIR` and `HUB_MIRRORS_DIR` must not be inside `appsDir` (the same "inside" rule), else `ConfigError('HUB_DATA_DIR and HUB_MIRRORS_DIR must not be inside HUB_APPS_DIR.')`. `hub-agent` can write in `appsDir`.
- Blank optional settings count as absent.

`deployProblems(c)` returns, in this order, one entry for each missing value:
1. `'GITHUB_TOKEN is not set.'`
2. `'GITHUB_OWNER is not set.'`
3. `'GHCR_READ_TOKEN is not set (a classic GitHub token with only read:packages).'`
4. `'HUB_GHCR_USER is not set.'`
5. `'HUB_TAILNET is not set (your tailnet DNS name, like tail1234.ts.net).'`
6. `'No SSH key for the app servers. Run sudo /opt/hub/ops/hub/make-ssh-key.sh.'`
7. `'HUB_AGENT_USER is not set, so Claude would run as the hub user. See "Deploy and New app" in docs/hub-bootstrap.md.'`

`provisionProblems(c)` returns `'HCLOUD_TOKEN is not set.'` and then `'TS_AUTHKEY is not set.'` for the missing ones.

- [ ] **Step 1: Add the dependencies.** Run `pnpm add -F @hub/server yaml@^2.9.1` and `pnpm add -D -F @hub/server @hub/design-model@workspace:*`. Expected: `apps/server/package.json` lists both and `pnpm-lock.yaml` changes. No other task in this plan changes hub dependencies.

- [ ] **Step 2: Write the failing tests** in `config-deploy.test.ts`. Use `FULL` from plan 3's config test (copy it) and temp dirs removed in `afterEach`.
  - `reads deploy credentials from CREDENTIALS_DIRECTORY`: a dir holding `HCLOUD_TOKEN` (`'hc\n'`), `GHCR_READ_TOKEN` (`'gh\n'`), `TS_AUTHKEY` (`'ts\n'`) and `HUB_SSH_KEY` (`'key'`), with `HUB_SSH_KEY_PATH = join(dir, 'HUB_SSH_KEY')` → `hcloudToken 'hc'`, `ghcrToken 'gh'`, `tsAuthKey 'ts'`, `sshKeyPath` equal to that path.
  - `ghcr user defaults to the GitHub owner`: `GITHUB_OWNER: 'Acme'` → `ghcrUser 'Acme'`. Adding `HUB_GHCR_USER: 'bob'` → `'bob'`.
  - `tailnet is lowercased and validated`: `'Tail1234.TS.net'` → `'tail1234.ts.net'`. `'notatailnet'` throws `'HUB_TAILNET must be your tailnet DNS name, like tail1234.ts.net'`.
  - `location and templates have defaults`: `hcloudLocation 'nbg1'`, `templatesDir === DEFAULT_TEMPLATES_DIR`, and `existsSync(join(DEFAULT_TEMPLATES_DIR, '..', 'pnpm-workspace.yaml'))` is true.
  - `a missing key file means no key`: `HUB_SSH_KEY_PATH: '/nonexistent/key'` → `sshKeyPath null`.
  - `refuses a key inside the apps dir or ~/.ssh`: a real file at `<appsDir>/k`, and a real file at `<home>/.ssh/id` with `HOME: home`. Both throw the exact message above.
  - `agent user and mirrors dir`:
    - `HUB_AGENT_USER: 'hub-agent'` gives `agentUser 'hub-agent'`. Without it → `null`.
    - `mirrorsDir` defaults to `join(dirname(appsDir), 'hub-mirrors')`.
    - `HUB_MIRRORS_DIR: join(appsDir, 'm')` and `HUB_DATA_DIR: join(appsDir, 'd')` each throw `'HUB_DATA_DIR and HUB_MIRRORS_DIR must not be inside HUB_APPS_DIR.'`.
  - `deploy and provision problems list what is missing`: `deployProblems(loadConfig(FULL))` equals the seven messages in order. With every value set (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GHCR_READ_TOKEN`, `HUB_TAILNET`, an existing key file, `HUB_AGENT_USER`) → `[]`. `provisionProblems(loadConfig(FULL))` equals `['HCLOUD_TOKEN is not set.', 'TS_AUTHKEY is not set.']`.
  - `deploy secrets never reach child processes`: `scrubEnv({ PATH: '/bin', HCLOUD_TOKEN: 'x', GHCR_READ_TOKEN: 'x', TS_AUTHKEY: 'x', HUB_SSH_KEY_PATH: 'x', CREDENTIALS_DIRECTORY: 'x', SSH_AUTH_SOCK: 'x', GITHUB_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x' })` toEqual `{ PATH: '/bin' }`, and every `CREDENTIAL_KEYS` entry is in `SECRET_ENV_KEYS`.
  - `the Claude runner gets none of them`: `buildQueryOptions({ cwd: '/tmp', prompt: 'x' }, { env: <the same object>, oauthToken: 'oat' }).env`. Its sorted keys toEqual `['CLAUDE_CODE_OAUTH_TOKEN', 'PATH']`, and `CLAUDE_CODE_OAUTH_TOKEN` is `'oat'`.

- [ ] **Step 3: Run** `pnpm -F @hub/server exec vitest run src/config-deploy.test.ts`. Expected: FAIL (`deployProblems` is not exported).

- [ ] **Step 4: Implement** the fields and functions in `config.ts`. Then update plan 3's `loads a full environment` expectation with `hcloudToken: null, ghcrToken: null, ghcrUser: null, tsAuthKey: null, sshKeyPath: null, tailnet: null, hcloudLocation: 'nbg1', acmeEmail: null, templatesDir: DEFAULT_TEMPLATES_DIR, agentUser: null, mirrorsDir: '/srv/hub-mirrors'` (FULL's `HUB_APPS_DIR` is `/srv/apps`). If a plan 3 test asserts `CREDENTIAL_KEYS` or `SECRET_ENV_KEYS` exactly, update it to the lists above.

- [ ] **Step 5: Run** `pnpm -F @hub/server exec vitest run src/config.test.ts src/config-deploy.test.ts src/claude` and `pnpm -F @hub/server typecheck`. Expected: all pass.

- [ ] **Step 6: Commit** the package file, lockfile, `config.ts` and both tests as `feat(server): deploy settings and credentials kept out of every child process`, with the attribution trailer your harness provides.

---

### Task 2: Deploy and setup types in `@hub/protocol`

**Files:**
- Create: `packages/protocol/src/deploy.ts`
- Modify: `packages/protocol/src/ws.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/ws.test.ts` (the `SERVER_MSG_TYPES` list)
- Test: `packages/protocol/src/deploy.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 1 (`APP_NAME_RE`, test only), plan 3 Task 2 (`ServerMsg`, `SERVER_MSG_TYPES`, `parseServerMsg`).
- Produces (`deploy.ts`, exact; types only plus these constants and `shortSha`):

```ts
export type DeployEnv = 'staging' | 'production';
export const DEPLOY_ENVS: readonly DeployEnv[] = ['staging', 'production'];
export type DeployKind = 'deploy' | 'promote' | 'rollback';
export type DeployStatus = 'waiting_ci' | 'running' | 'success' | 'failed' | 'rolled_back' | 'canceled';
export const ACTIVE_DEPLOY_STATUSES: readonly DeployStatus[] = ['waiting_ci', 'running'];
export const DEPLOY_STATUS_LABEL: Readonly<Record<DeployStatus, string>> = { waiting_ci: 'Waiting for CI', running: 'Deploying', success: 'Live', failed: 'Failed', rolled_back: 'Failed, rolled back', canceled: 'Canceled' };
export type DeployActor = 'merge' | 'user' | 'newapp' | 'hub';
export interface DeployRecord {
  id: number; app: string; env: DeployEnv; kind: DeployKind; sha: string; image: string; serverKey: string;
  status: DeployStatus; actor: DeployActor; previousSha: string | null; ciOk: boolean; testsOk: boolean;
  error: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null;
}
export interface DeployLogLine { deployId: number; seq: number; text: string; at: number }
export interface EnvState { env: DeployEnv; server: string | null; url: string | null; current: DeployRecord | null; active: DeployRecord | null }
export interface PromoteCandidate { sha: string; deployId: number; finishedAt: number; subject: string }
export interface DeployState {
  app: string; adopted: boolean; problems: string[]; staging: EnvState; production: EnvState;
  candidates: PromoteCandidate[]; rollbackTo: DeployRecord | null; history: DeployRecord[];
}
export type ConfirmAction = 'promote' | 'rollback' | 'provision';
export interface CommitInfo { sha: string; subject: string; author: string; at: number }
export interface MigrationInfo { file: string; contract: boolean }
export interface ServerQuote { key: string; role: DeployEnv; serverType: string; location: string; monthlyGross: string }
export interface ConfirmCard {
  action: ConfirmAction; app: string; subject: string; token: string; expiresAt: number; title: string;
  sha: string | null; fromSha: string | null; commits: CommitInfo[]; migrations: MigrationInfo[]; servers: ServerQuote[];
}
export type SetupKind = 'new' | 'adopt' | 'move';
export type SetupStep = 'servers' | 'repo' | 'secrets' | 'routes' | 'ci' | 'deploy' | 'task' | 'manifest' | 'done';
export const SETUP_STEPS: Readonly<Record<SetupKind, readonly SetupStep[]>> = {
  new: ['servers', 'repo', 'secrets', 'routes', 'ci', 'deploy'], adopt: ['servers', 'task'], move: ['servers', 'manifest'],
};
export const SETUP_STEP_LABEL: Readonly<Record<SetupStep, string>> = {
  servers: 'Servers', repo: 'GitHub repository', secrets: 'Databases and secrets', routes: 'Caddy routes',
  ci: 'First CI build', deploy: 'Staging deploy', task: 'Adopt task in Build', manifest: 'Manifest pull request', done: 'Done',
};
export type SetupStatus = 'running' | 'success' | 'failed';
export interface SetupRun {
  id: number; kind: SetupKind; app: string; status: SetupStatus; step: SetupStep;
  error: string | null; detail: string | null; url: string | null; createdAt: number; updatedAt: number;
}
export interface SetupPlan { kind: SetupKind; app: string; problems: string[]; servers: ServerQuote[]; confirm: ConfirmCard | null }
export interface DeployStagingRequest { sha?: string }
export interface PrepareProductionRequest { action: 'promote' | 'rollback'; sha?: string }
export interface ProductionRequest { action: 'promote' | 'rollback'; sha: string; token: string }
export interface DeployResponse { deploy: DeployRecord }
export interface ConfirmResponse { card: ConfirmCard }
export interface DeployLogsResponse { lines: DeployLogLine[] }
export interface NewAppRequest { name: string; token?: string }
export interface AdoptRequest { token?: string }
export interface MoveRequest { env: DeployEnv; token?: string }
export interface SetupRunResponse { run: SetupRun }
export interface SetupRunsResponse { runs: SetupRun[] }
export const HUB_ORIGIN_HEADER = 'x-hub-origin';
export const VOICE_ORIGIN = 'voice';
/** Same rule as APP_NAME_RE in ./manifest (kept as a string so the client bundle does not pull in zod). */
export const APP_NAME_PATTERN = '^[a-z][a-z0-9-]{0,38}[a-z0-9]$';
export function shortSha(sha: string): string;   // first 7 characters
```

- Produces (`ws.ts`): these three variants join `ServerMsg`, and `SERVER_MSG_TYPES` becomes `['render.ready', 'build.message', 'build.task', 'pong', 'deploy.update', 'deploy.log', 'setup.progress']`.

```ts
export interface DeployUpdateMsg { type: 'deploy.update'; app: string; deploy: DeployRecord }
export interface DeployLogMsg { type: 'deploy.log'; app: string; line: DeployLogLine }
export interface SetupProgressMsg { type: 'setup.progress'; run: SetupRun }
```

`index.ts` adds `export * from './deploy.js';`. It must still not re-export `./manifest`.

- [ ] **Step 1: Write the failing tests** in `deploy.test.ts`:
  - `APP_NAME_PATTERN matches the manifest rule`: `new RegExp(APP_NAME_PATTERN).source === APP_NAME_RE.source`.
  - `shortSha keeps 7 characters`: `shortSha('0123456789abcdef')` → `'0123456'`.
  - `every status and step has a label`: the keys of `DEPLOY_STATUS_LABEL` (sorted) equal `['canceled', 'failed', 'rolled_back', 'running', 'success', 'waiting_ci']`. Every step in every `SETUP_STEPS` list has a `SETUP_STEP_LABEL`.
  - `parses deploy and setup messages`: `parseServerMsg` returns non-null for a `deploy.update`, a `deploy.log` and a `setup.progress` object.

  Also update plan 3's `SERVER_MSG_TYPES` assertion in `ws.test.ts` to the list above.
- [ ] **Step 2: Run** `pnpm -F @hub/protocol exec vitest run`. Expected: FAIL (`./deploy.js` is missing).
- [ ] **Step 3: Implement** `deploy.ts`, the `ws.ts` additions and the `index.ts` export.
- [ ] **Step 4: Run** `pnpm -F @hub/protocol exec vitest run && pnpm -F @hub/protocol typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** as `feat(protocol): deploy, confirm card and setup run types`, with the attribution trailer your harness provides.

---

### Task 3: Template renderer

**Files:**
- Create: `apps/server/src/newapp/template.ts`
- Test: `apps/server/src/newapp/template.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export const TEMPLATE_NAME = 'vite-hono-pg';
export const TEMPLATE_ID = 'vite-hono-pg@1';
export interface TemplateVars { name: string; image: string; stagingServer: string; stagingUrl: string; productionServer: string; productionUrl: string }
export const PLACEHOLDERS: Readonly<Record<keyof TemplateVars, string>> = {
  name: '__APP_NAME__', image: '__APP_IMAGE__', stagingServer: '__STAGING_SERVER__', stagingUrl: '__STAGING_URL__',
  productionServer: '__PRODUCTION_SERVER__', productionUrl: '__PRODUCTION_URL__',
};
export function readTemplate(dir: string): Record<string, string>;   // posix relative path → UTF-8 text, sorted by path
export function renderTemplate(files: Record<string, string>, vars: TemplateVars): Record<string, string>;
export function imageFor(owner: string, name: string): string;       // `ghcr.io/${owner.toLowerCase()}/${name}`
```

Rules:
- `readTemplate` walks `dir` recursively. It skips any `node_modules/` or `dist/` directory and any `.DS_Store` file, and keeps dotfiles such as `.github/` and `.hub/`.
- `renderTemplate` replaces every placeholder in every file with `replaceAll`. Afterwards, any remaining match of `/__[A-Z][A-Z0-9_]*__/` throws `` Error(`Unreplaced placeholder ${match} in ${path}`) ``.

- [ ] **Step 1: Write the failing tests** with a temp fixture holding `a.txt` (`'__APP_NAME__ at __STAGING_URL__\n'`), `.hub/app.json`, `node_modules/x/index.js` and `web/dist/index.html`:
  - `reads every file except build output`: the keys equal `['.hub/app.json', 'a.txt']`.
  - `replaces every placeholder`: with `vars = { name: 'shop', image: 'ghcr.io/acme/shop', stagingServer: 'shared-staging', stagingUrl: 'http://shared-staging.tail1234.ts.net:8001', productionServer: 'shared-production', productionUrl: 'https://shop.203.0.113.2.sslip.io' }`, `a.txt` becomes `'shop at http://shared-staging.tail1234.ts.net:8001\n'`.
  - `throws on an unknown placeholder`: `{ 'b.txt': 'x __NOPE__' }` throws `'Unreplaced placeholder __NOPE__ in b.txt'`.
  - `imageFor lowercases the owner`: `imageFor('MarcosCapistrano', 'shop')` → `'ghcr.io/marcoscapistrano/shop'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/template.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `template.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 pass.
- [ ] **Step 5: Commit** as `feat(server): template reader and placeholder renderer`, with the attribution trailer your harness provides.

---

### Task 4: Hetzner Cloud client and fake

**Files:**
- Create: `apps/server/src/infra/hetzner.ts`, `apps/server/src/infra/fake-hetzner.ts`
- Test: `apps/server/src/infra/hetzner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
// hetzner.ts
export const HETZNER_API = 'https://api.hetzner.cloud/v1';
export interface HServer { id: number; name: string; status: string; ipv4: string | null; labels: Record<string, string> }
export interface FirewallRule { direction: 'in'; protocol: 'tcp' | 'udp' | 'icmp'; port?: string; source_ips: string[]; description: string }
export interface CreateServerInput {
  name: string; serverType: string; image: string; location: string; sshKeyIds: number[]; firewallIds: number[];
  userData: string; labels: Record<string, string>;
}
export class HetznerError extends Error { constructor(readonly status: number, readonly code: string, message: string) }
export interface Hetzner {
  listServers(labelSelector: string): Promise<HServer[]>;
  getServer(id: number): Promise<HServer | null>;
  createServer(input: CreateServerInput): Promise<{ server: HServer; actionId: number }>;
  deleteServer(id: number): Promise<void>;
  waitAction(id: number): Promise<void>;
  ensureSshKey(name: string, publicKey: string): Promise<number>;
  ensureFirewall(name: string, rules: FirewallRule[], labels: Record<string, string>): Promise<number>;
  monthlyPrice(serverType: string, location: string): Promise<string>;   // gross EUR, 2 decimals
}
export interface HttpHetznerOptions {
  fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; baseUrl?: string;
  actionPollMs?: number /* 2000 */; actionTimeoutMs?: number /* 600_000 */;
}
export class HttpHetzner implements Hetzner { constructor(token: string, opts?: HttpHetznerOptions) }
// fake-hetzner.ts
export class FakeHetzner implements Hetzner {
  readonly servers: Map<number, HServer>;
  readonly sshKeys: Map<number, { name: string; publicKey: string }>;
  readonly firewalls: Map<number, { name: string; rules: FirewallRule[]; labels: Record<string, string> }>;
  readonly created: CreateServerInput[];
  readonly calls: string[];                         // method names in call order
  monthlyGross: string;                             // default '4.59'
  failNext(method: keyof Hetzner, error: Error): void;   // the next call of that method rejects with error
}
```

`HttpHetzner` rules:
- Every request sends `Authorization: Bearer <token>`, plus `Content-Type: application/json` when it has a body.
- A non-2xx response with `{ error: { code, message } }` throws `` HetznerError(status, code, `Hetzner API: ${message}`) ``. Without that body it throws `` HetznerError(status, 'http_error', `Hetzner API: HTTP ${status}`) ``.
- A rejected `fetch` throws `` HetznerError(0, 'network', `Could not reach the Hetzner API: ${err.message}`) ``.
- No error message ever contains the token.

| Method | Request | Result |
|---|---|---|
| `listServers(sel)` | `GET /servers?label_selector=${encodeURIComponent(sel)}&per_page=50` | `servers.map(toHServer)` |
| `getServer(id)` | `GET /servers/${id}` | `toHServer(server)`; 404 → `null` |
| `createServer(i)` | `POST /servers` with body `{ name, server_type, image, location, ssh_keys: sshKeyIds, firewalls: firewallIds.map(f => ({ firewall: f })), user_data, labels, start_after_create: true, public_net: { enable_ipv4: true, enable_ipv6: true } }` | `{ server: toHServer(server), actionId: action.id }` |
| `deleteServer(id)` | `DELETE /servers/${id}` | 404 is ignored |
| `waitAction(id)` | `GET /actions/${id}` until `action.status` is not `running`, sleeping `actionPollMs` between polls | `success` → resolve. `error` → `` HetznerError(0, action.error.code, `Hetzner action failed: ${action.error.message}`) ``. More than `actionTimeoutMs / actionPollMs` polls → `` HetznerError(0, 'timeout', `Hetzner action ${id} did not finish within 10 minutes.`) `` |
| `ensureSshKey(name, pub)` | `GET /ssh_keys?name=${name}`. If found with the same key (compare the first two space-separated fields) → its id. If found with another key → `` HetznerError(409, 'conflict', `Hetzner already has an SSH key named ${name} with a different key. Delete it in the Hetzner console or rename it.`) ``. If not found → `POST /ssh_keys { name, public_key }`. On `uniqueness_error`, `GET /ssh_keys?per_page=50` and return the key whose `public_key` matches | the key id |
| `ensureFirewall(name, rules, labels)` | `GET /firewalls?name=${name}`. If found → `POST /firewalls/${id}/actions/set_rules { rules }` and return its id. If not found → `POST /firewalls { name, labels, rules }` | the firewall id |
| `monthlyPrice(type, loc)` | `GET /server_types?name=${type}`, then `server_types[0].prices.find(p => p.location === loc).price_monthly.gross` | `Number(gross).toFixed(2)`. Missing → `` HetznerError(404, 'not_found', `Hetzner has no price for ${type} in ${loc}.`) `` |

`toHServer(s)` = `{ id, name, status, ipv4: s.public_net?.ipv4?.ip ?? null, labels: s.labels ?? {} }`.

`FakeHetzner` behavior:
- One id counter from 1 is shared by servers, keys and firewalls.
- A server with id `n` gets `ipv4 '203.0.113.' + n`, `status 'running'`, and `actionId 1000 + n`. `createServer` also pushes its input to `created`.
- `listServers('a=b,c=d')` keeps servers whose labels match every pair.
- `ensureSshKey` and `ensureFirewall` behave like the HTTP version, including the conflict error.
- `waitAction` resolves. `monthlyPrice` returns `monthlyGross`.

- [ ] **Step 1: Write the failing tests.** A recording `fetchFn` returns queued `Response`s, and `sleep` is a stub that records its argument.
  - `creates a server with location, firewall and cloud-init`: the request is `POST https://api.hetzner.cloud/v1/servers` with `Authorization: Bearer tok`, and the parsed body toEqual the exact object from the table (for `{ name: 'shared-staging', serverType: 'cx23', image: 'ubuntu-24.04', location: 'nbg1', sshKeyIds: [7], firewallIds: [9], userData: '#cloud-config\n', labels: { 'hub-server': 'shared-staging' } }`). The body has no `datacenter` key. The result is `ipv4 '203.0.113.7'`, `actionId 42`.
  - `lists servers by label selector`: the URL is `https://api.hetzner.cloud/v1/servers?label_selector=hub-server%3Dshared-staging&per_page=50`.
  - `a missing server is null`: 404 → `null`.
  - `waits for an action`: `running`, `running`, then `success` → resolves, and `sleep` was called twice with 2000.
  - `a failed action throws its message`: `Hetzner action failed: boom`.
  - `reuses an ssh key with the same public key`, `refuses an ssh key name that holds another key` (exact message), `finds the existing key after uniqueness_error`.
  - `updates the rules of an existing firewall`: the second request is `POST …/firewalls/3/actions/set_rules`.
  - `reads the gross monthly price`: `'4.5900000000000'` for `nbg1` → `'4.59'`.
  - `errors never include the token`: a 403 body `{ error: { code: 'forbidden', message: 'insufficient permissions' } }` gives `HetznerError` status 403, code `'forbidden'`, and a message without `'tok'`. A rejecting fetch gives code `'network'`.
  - `fake hetzner numbers servers and filters by label`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/hetzner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 11 pass.
- [ ] **Step 5: Commit** as `feat(server): Hetzner Cloud client and fake`, with the attribution trailer your harness provides.

---

### Task 5: SSH runner and fake

**Files:**
- Create: `apps/server/src/infra/ssh.ts`, `apps/server/src/infra/fake-ssh.ts`
- Test: `apps/server/src/infra/ssh.test.ts`

**Interfaces:**
- Consumes: Task 1 (`scrubEnv` drops `SSH_AUTH_SOCK` and the deploy secrets).
- Produces:

```ts
// ssh.ts
export interface ExecOptions { stdin?: string; timeoutMs?: number /* DEFAULT_SSH_TIMEOUT_MS */; onLine?: (line: string, stream: 'stdout' | 'stderr') => void }
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface SshEnd { host: string; command: string }
export interface SshRunner {
  exec(host: string, command: string, opts?: ExecOptions): Promise<ExecResult>;   // never rejects
  pipe(from: SshEnd, to: SshEnd, opts?: { timeoutMs?: number }): Promise<{ code: number; stderr: string }>;   // from's stdout → to's stdin
  forgetHost(host: string): Promise<void>;
}
export const SSH_TIMEOUT_CODE = 124;
export const DEFAULT_SSH_TIMEOUT_MS = 600_000;
export const OUTPUT_LIMIT = 200_000;
export const HOST_RE = /^[A-Za-z0-9.-]+$/;
export function shq(value: string): string;   // `'${value.replaceAll("'", `'\\''`)}'`
export interface OpenSshOptions { keyPath: string; knownHostsPath: string; sshBin?: string /* 'ssh' */; keygenBin?: string /* 'ssh-keygen' */; env?: Record<string, string | undefined> /* process.env */ }
export function sshArgs(o: Pick<OpenSshOptions, 'keyPath' | 'knownHostsPath'>, host: string, command: string): string[];
export class OpenSshRunner implements SshRunner { constructor(opts: OpenSshOptions) }
export class NoSsh implements SshRunner {}   // exec/pipe → { code: 255, stderr: 'No SSH key for the app servers.' }; forgetHost no-op
export function readPublicKey(keyPath: string, keygenBin?: string): Promise<string>;
// fake-ssh.ts
export interface FakeCall { host: string; command: string; stdin?: string }
export type FakeReply = Partial<ExecResult> & { lines?: string[] };
export class FakeSsh implements SshRunner {
  readonly calls: FakeCall[];
  readonly pipes: { from: SshEnd; to: SshEnd }[];
  readonly forgotten: string[];
  pipeResult: { code: number; stderr: string };            // default { code: 0, stderr: '' }
  on(match: string | RegExp, reply: FakeReply | ((call: FakeCall) => FakeReply | void)): void;
}
```

`sshArgs` (exact):

```ts
['-F', '/dev/null', '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
 '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'ConnectTimeout=15',
 '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-l', 'root', '--', host, command]
```

`OpenSshRunner` rules:
- The constructor runs `mkdirSync(dirname(knownHostsPath), { recursive: true, mode: 0o700 })`.
- `exec` returns `{ code: 255, stdout: '', stderr: 'Bad host name' }` without spawning when `host` fails `HOST_RE`.
- It spawns `sshBin` with `sshArgs` and `env: scrubEnv(opts.env ?? process.env)`. It writes `stdin` (when given) and ends stdin.
- Output is split into lines for `onLine`, and a partial last line is flushed on close. `stdout` and `stderr` keep their last `OUTPUT_LIMIT` characters.
- On timeout it kills the child with `SIGKILL` and the code is 124. A spawn error (missing binary) gives code 127 and stderr `` `${sshBin} not found` ``.
- `pipe` spawns both ends the same way and pipes the first's stdout into the second's stdin. The code is the first end's code when it is non-zero, else the second's. `stderr` is both stderrs joined, last 4000 characters. A timeout kills both and gives 124.
- `forgetHost(host)` runs `keygenBin -R <host> -f <knownHostsPath>` and ignores any failure. It does nothing for a host that fails `HOST_RE`.
- `readPublicKey` runs `ssh-keygen -y -f <keyPath>` and returns the trimmed stdout. A failure throws `Error('Could not read the SSH key at HUB_SSH_KEY_PATH.')`.

`FakeSsh` rules:
- `exec` records the call, including stdin, and uses the newest `on` entry whose string is a substring of the command (or whose RegExp matches it).
- The reply's `lines` are sent to `onLine` as stdout. The result is `{ code: 0, stdout: '', stderr: '' }` merged with the reply.
- `pipe` records the pair and returns `pipeResult`. `forgetHost` records the host.

- [ ] **Step 1: Write the failing tests.** `beforeAll` writes an executable fake `ssh` script to a temp dir. It switches on its last argument:

```bash
#!/usr/bin/env bash
cmd="${@: -1}"
case "$cmd" in
  args) printf '%s\n' "$@" ;;
  stdin) cat ;;
  lines) echo one; echo two >&2; echo three ;;
  exit3) exit 3 ;;
  sleep) sleep 5 ;;
  env) env ;;
  tee:*) cat > "${cmd#tee:}" ;;
esac
```

  - `sshArgs is exact`: toEqual the literal array above for `{ keyPath: '/run/credentials/hub.service/HUB_SSH_KEY', knownHostsPath: '/var/lib/hub/data/ssh/known_hosts' }`.
  - `passes the key explicitly and ignores user config`: `exec('srv.tail1234.ts.net', 'args')` gives `stdout.trim().split('\n')` toEqual `sshArgs(opts, 'srv.tail1234.ts.net', 'args')`.
  - `sends stdin`: `exec(h, 'stdin', { stdin: 'secret\n' })` → stdout `'secret\n'`.
  - `streams lines with their stream`: the stdout lines are `['one', 'three']` and the stderr lines are `['two']`.
  - `returns the exit code`: `exit3` → 3.
  - `times out with 124`: `sleep` with `timeoutMs: 200` → 124.
  - `the child env has no secrets`: `env: { PATH: process.env.PATH, HCLOUD_TOKEN: 'x', SSH_AUTH_SOCK: '/s', GHCR_READ_TOKEN: 'y', CREDENTIALS_DIRECTORY: '/run/c' }`. The `env` output contains none of those four names.
  - `rejects a bad host without running ssh`: `'a;b'` → 255 `'Bad host name'`.
  - `a missing ssh binary gives 127`.
  - `pipes one host into another`: `pipe({ host: 'a', command: 'lines' }, { host: 'b', command: `tee:${file}` })` → code 0, and the file holds `'one\nthree\n'`.
  - `shq quotes single quotes`: `shq("it's")` → `` `'it'\\''s'` `` (that is, `'it'\''s'`).
  - `fake ssh answers by pattern, newest first`.
  - `reads a public key` (`it.skipIf` when `ssh-keygen` is not on PATH): generate an ed25519 key with `ssh-keygen -q -t ed25519 -N '' -f <tmp>/k`. `readPublicKey` returns text starting with `ssh-ed25519 `.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/ssh.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files with `node:child_process` `spawn` and `execFile`.
- [ ] **Step 4: Run** the same command. Expected: 13 pass.
- [ ] **Step 5: Commit** as `feat(server): OpenSSH runner with an explicit key and a scrubbed env`, with the attribution trailer your harness provides.

---

### Task 6: GHCR image check

**Files:**
- Create: `apps/server/src/infra/ghcr.ts`
- Test: `apps/server/src/infra/ghcr.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export interface ImageRegistry { hasTag(image: string, tag: string): Promise<boolean> }
export const GHCR_IMAGE_RE = /^ghcr\.io\/([a-z0-9_.-]+\/[a-z0-9_.-]+)$/;
export const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';
export class GhcrRegistry implements ImageRegistry { constructor(opts: { user: string; token: string; fetchFn?: typeof fetch }) }
export class FakeRegistry implements ImageRegistry {
  constructor(opts?: { all?: boolean });   // all: every tag exists
  add(image: string, tag: string): void;
  readonly checks: string[];               // `${image}:${tag}` per call
}
```

`GhcrRegistry.hasTag(image, tag)`:
1. An image failing `GHCR_IMAGE_RE` or a tag failing `TAG_RE` throws `` Error(`Not a ghcr.io image: ${image}:${tag}`) ``.
2. `GET https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull` with `Authorization: Basic ${base64(`${user}:${token}`)}`. A non-OK response throws `` Error(`ghcr.io refused the read token (${status}). Check GHCR_READ_TOKEN has read:packages.`) ``.
3. `HEAD https://ghcr.io/v2/${path}/manifests/${tag}` with `Authorization: Bearer ${json.token}` and `Accept: MANIFEST_ACCEPT`.
   - 200 → `true`.
   - 404 → `false`.
   - Anything else throws `` Error(`ghcr.io answered ${status} for ${image}:${tag}`) ``.

- [ ] **Step 1: Write the failing tests:**
  - `checks a tag with a pull token`: assert the exact URLs, headers and methods.
  - `a missing tag is false`.
  - `a refused token explains the scope`: 401 → `'ghcr.io refused the read token (401). Check GHCR_READ_TOKEN has read:packages.'`.
  - `other statuses throw`.
  - `rejects images outside ghcr.io`: `docker.io/x/y` throws.
  - `fake registry knows added tags`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/ghcr.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ghcr.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** as `feat(server): GHCR tag check with a read-only token`, with the attribution trailer your harness provides.

---

### Task 7: GitHub repository creation

**Files:**
- Modify: `apps/server/src/github/github.ts`, `apps/server/src/github/fake.ts`, `apps/server/src/github/octokit.ts`
- Test: `apps/server/src/github/github-repos.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 12 (`GitHub`, `RepoRef`, `FakeGitHub`, `OctokitGitHub`).
- Produces (added to the `GitHub` interface):

```ts
export interface CreatedRepo { owner: string; repo: string; htmlUrl: string; cloneUrl: string }
export function repoExistsMessage(name: string): string;   // `A repository named ${name} already exists on GitHub.`
// GitHub gains:
createRepo(p: { owner: string; name: string; description: string }): Promise<CreatedRepo>;   // private, empty (auto_init false)
getRepo(r: RepoRef): Promise<{ defaultBranch: string } | null>;                              // null when not found
// FakeGitHub gains:
readonly repos: Map<string, CreatedRepo & { defaultBranch: string }>;   // key `${owner}/${repo}` lowercased
```

`OctokitGitHub.createRepo`:
1. `login = (await rest.users.getAuthenticated()).data.login`.
2. If `login` equals `owner` (case-insensitive), call `rest.repos.createForAuthenticatedUser({ name, description, private: true, auto_init: false })`. Otherwise call `rest.repos.createInOrg({ org: owner, name, description, private: true, auto_init: false })`.
3. Map `owner.login`, `name`, `html_url` and `clone_url`.
4. A 422 whose message contains `already exists` throws `Error(repoExistsMessage(name))`.

`OctokitGitHub.getRepo`: `rest.repos.get` → `{ defaultBranch: data.default_branch }`. A 404 → `null`.

`FakeGitHub`:
- `createRepo` stores `{ owner, repo: name, htmlUrl: `https://github.com/${owner}/${name}`, cloneUrl: `https://github.com/${owner}/${name}.git`, defaultBranch: 'main' }`. A duplicate throws `repoExistsMessage(name)`.
- `getRepo` reads the map.
- Both methods push their name to `calls`.

- [ ] **Step 1: Write the failing tests** (Octokit with a recording `fetchFn`, as plan 3's `octokit.test.ts` does):
  - `creates a private repo for the authenticated user`: `GET https://api.github.com/user` returns `{ login: 'acme' }`, then `POST https://api.github.com/user/repos` with body `{ name: 'shop', description: 'Created by the Hub', private: true, auto_init: false }`.
  - `creates a private repo in an org`: `login: 'me'`, owner `'team'` → `POST https://api.github.com/orgs/team/repos`.
  - `a taken name gives a clear error`: 422 `{ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }` → `'A repository named shop already exists on GitHub.'`.
  - `getRepo returns the default branch or null`.
  - `fake github creates repos once`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/github`. Expected: the new file fails, plan 3's tests pass.
- [ ] **Step 3: Implement** in the three files.
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit** as `feat(server): create private app repositories on GitHub`, with the attribution trailer your harness provides.

---

### Task 8: Build tasks that start from hub-written files, and safe checkout files

**Files:**
- Create: `apps/server/src/apps/checkout-fs.ts`
- Modify: `apps/server/src/build/service.ts`
- Test: `apps/server/src/apps/checkout-fs.test.ts`, `apps/server/src/build/service-seed.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 18 (`BuildService`, `BuildError`), Task 11 (`makeTestRepo`, `TEST_IDENTITY`, `git`), Task 9 (`FakeClaudeRunner`), Task 12 (`FakeGitHub`), Task 13 (`BuildStore`), Task 4 (`openDb`), Task 7 (`AppRegistry`).
- Produces:

```ts
// apps/checkout-fs.ts. A checkout is writable by hub-agent, so the hub never follows a link inside one.
export class CheckoutPathError extends Error {}
export function checkoutParts(rel: string): string[];
export function readCheckoutFile(root: string, rel: string): string | null;        // UTF-8; null when missing
export function writeCheckoutFile(root: string, rel: string, data: string): void;   // creates folders as needed
// build/service.ts
export interface SendOptions { seedFiles?: Record<string, string>; seedMessage?: string }
// BuildService.send(app: string, text: string, opts?: SendOptions): Promise<BuildTask>
```

`checkoutParts(rel)` splits on `/`. It throws `CheckoutPathError('Bad file path')` for any of these:
- an empty path or an absolute path;
- a backslash;
- an empty, `.` or `..` segment;
- a first segment of `.git`.

`readCheckoutFile` and `writeCheckoutFile` open the file one name at a time below the root. Each step goes through `/proc/self/fd/<fd>/<name>`, so a symlink anywhere on the path fails, even one swapped in while the walk runs:

```ts
const DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
let cur = openSync(root, C.O_RDONLY | C.O_DIRECTORY);
for (const name of parts.slice(0, -1)) {             // writes first try mkdirSync(`/proc/self/fd/${cur}/${name}`) and ignore EEXIST
  const next = openSync(`/proc/self/fd/${cur}/${name}`, DIR);
  closeSync(cur); cur = next;                         // a folder the hub just made gets fchmodSync(next, 0o2770)
}
const fd = openSync(`/proc/self/fd/${cur}/${parts.at(-1)}`, flags | C.O_NOFOLLOW, 0o660);   // writes: O_WRONLY | O_CREAT | O_TRUNC
```

- Errors:
  - `ELOOP` or `ENOTDIR` throws `CheckoutPathError('Not a plain file path inside the checkout')`.
  - On a read, `ENOENT` returns `null`.
  - Every fd is closed in `finally`.
- After a write, `fchmodSync(fd, 0o660)` when `fstatSync(fd).uid === process.getuid()`, so `hub-agent` can edit the file whatever the umask.
- Where `/proc/self/fd` does not exist (macOS development), both functions check each component with `lstatSync` instead. That check is racy and only for development.

Additions to plan 3's `send` algorithm. Without `opts.seedFiles` nothing changes.
- Before step 4 (reserve): every seed path must pass `checkoutParts`. A `CheckoutPathError` becomes `BuildError('Bad seed file path', 400)`.
- In step 5: if an open task remains, release the reservation and throw `BuildError('Finish or close the open Build task first.', 409)`.
- In step 6, right after `createBranchFrom`:
  - Write each file with `writeCheckoutFile(entry.dir, path, content)`, then run `repo.commitAll(opts.seedMessage ?? 'Add Hub seed files')`.
  - A `CheckoutPathError` is handled like plan 3's git errors in that step: the task is failed, and the error is 409 `` `Git: ${message}` ``.

- [ ] **Step 1: Write the failing tests.**
  - `checkout-fs.test.ts` (a temp `root` and a temp `outside` folder):
    - `writes and reads files, creating folders`: write `a/b/c.json`, then read it back. `statSync` shows the file mode `& 0o777` is `0o660`, and folder `a` has `(mode & 0o2770) === 0o2770`.
    - `missing files read as null`.
    - `refuses a symlinked file`: `symlinkSync(join(outside, 's'), join(root, 'x.json'))`. Reading and writing `x.json` both throw `CheckoutPathError`, and `outside/s` keeps its content.
    - `refuses a symlinked folder`: `symlinkSync(outside, join(root, 'design'))`. Writing `design/p.json` throws, and `existsSync(join(outside, 'p.json'))` is false.
    - `rejects paths that leave the checkout`: `checkoutParts` throws `'Bad file path'` for `'../x'`, `'/etc/x'`, `'a//b'`, `'a\\b'`, `'.git/config'` and `''`.
  - `service-seed.test.ts`. Build the deps by hand:
    - `appsDir` is a temp dir, with `makeTestRepo({ workDir: join(appsDir, 'demo') })`.
    - `store: new BuildStore(openDb(':memory:'))`, `hub: { broadcast() {} }`, `registry: new AppRegistry(appsDir)`.
    - `openRepo: d => openRepo(d, { identity: TEST_IDENTITY })`, `github: new FakeGitHub()`.
    - `runCommand: async () => ({ ok: true, code: 0, output: '', timedOut: false, aborted: false })`, `now: Date.now`.
    - The runner is `new FakeClaudeRunner([[o => { seen.push(existsSync(join(o.cwd, '.hub/app.json'))) }, { type: 'done', sessionId: 's', ok: true }]])`.

    Tests:
    - `seed files are committed on the new branch before Claude runs`: `send('demo', 'Adopt this app', { seedFiles: { '.hub/app.json': '{}\n' }, seedMessage: 'Add .hub/app.json for the Hub' })`, then `await service.idle('demo')`. Expect `seen` toEqual `[true]`, and `git(work, 'log', '--format=%s', 'origin/main..HEAD')` contains `Add .hub/app.json for the Hub`.
    - `seed files need a fresh task`: after a plain `send` creates an open task, a seeded send rejects with status 409 and message `'Finish or close the open Build task first.'`.
    - `seed paths must stay inside the checkout`: `'../x'`, `'/etc/x'` and `'.git/config'` each reject with status 400 `'Bad seed file path'`.
    - `seed files never follow links`:
      1. In `work`, run `symlinkSync(outside, join(work, '.hub'))`, then commit it and push it to `origin main`.
      2. A seeded send of `.hub/app.json` rejects with status 409 and a message containing `'Not a plain file path inside the checkout'`.
      3. `existsSync(join(outside, 'app.json'))` is false.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/apps/checkout-fs.test.ts src/build/service-seed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `checkout-fs.ts`, then the changes in `service.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/server exec vitest run src/build src/apps`. Expected: all pass.
- [ ] **Step 5: Commit** as `feat(server): Build tasks can start from hub-written seed files, never through a link`, with the attribution trailer your harness provides.

---

### Task 9: Guard against reading hub credentials

**Files:**
- Modify: `apps/server/src/claude/guard.ts`
- Test: `apps/server/src/claude/guard-credentials.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 9 (`checkToolUse`, `deployDenyReason`).
- Produces:

```ts
export const CREDENTIAL_DENY_REASON = 'Hub credentials are off limits in Build.';
export const CREDENTIAL_MARKERS: readonly string[] = ['/run/credentials', '/etc/credstore', 'CREDENTIALS_DIRECTORY', 'HUB_SSH_KEY',
  'HCLOUD_TOKEN', 'GHCR_READ_TOKEN', 'TS_AUTHKEY', 'api.hetzner.cloud'];
export const CREDENTIAL_PATHS: readonly string[] = ['/run/credentials', '/etc/credstore'];
export function credentialDenyReason(text: string): string | null;   // case-insensitive substring match on any marker
```

`checkToolUse` changes:
- `Bash` → `deployDenyReason(cmd) ?? credentialDenyReason(cmd)`. Plan 3's reasons win, so its tests keep their expected reasons.
- `Read`, `Edit`, `Write`, `NotebookEdit`, `Grep` and `Glob`: for each string field among `file_path`, `notebook_path` and `path`, `resolve(cwd, value)`. If it starts with any `CREDENTIAL_PATHS` entry → `CREDENTIAL_DENY_REASON`. This check runs before plan 3's checkout rules.
- Every other path is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `bash commands that name credentials are denied`: each of these gives exactly `CREDENTIAL_DENY_REASON`:
    - `cat /run/credentials/hub.service/HUB_SSH_KEY`
    - `ls /etc/credstore.encrypted`
    - `printenv GHCR_READ_TOKEN`
    - `grep -r ts_authkey /var/lib`
  - `scripts that name credentials are denied`: each of these gives a non-null reason (plan 3's guard may answer first):
    - `echo $CREDENTIALS_DIRECTORY`
    - `node -e "console.log(process.env.HCLOUD_TOKEN)"`
    - `python3 -c "print(open('/run/credentials/hub.service/GITHUB_TOKEN').read())"`
  - `the Hetzner API stays denied`: `checkToolUse(cwd, 'Bash', { command: 'curl https://api.hetzner.cloud/v1/servers' })` is not null.
  - `file tools cannot read credential paths`: each of these gives `CREDENTIAL_DENY_REASON`:
    - `Read { file_path: '/run/credentials/hub.service/GITHUB_TOKEN' }`
    - `Grep { pattern: 'x', path: '/etc/credstore.encrypted' }`
    - `Glob { pattern: '*', path: '/run/credentials' }`
  - `ordinary work still passes`: `Bash pnpm test` and `Read { file_path: join(cwd, 'src/a.ts') }` → `null`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude/guard-credentials.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes in `guard.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/server exec vitest run src/claude`. Expected: all pass, including plan 3's guard tests.
- [ ] **Step 5: Commit** as `feat(server): Build guard denies hub credential paths and names`, with the attribution trailer your harness provides.

---

### Task 10: Confirm tokens and deploy errors

**Files:**
- Create: `apps/server/src/deploy/confirm.ts`, `apps/server/src/deploy/errors.ts`
- Test: `apps/server/src/deploy/confirm.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ConfirmAction`, `VOICE_ORIGIN`).
- Produces:

```ts
// errors.ts
export class DeployError extends Error { constructor(message: string, readonly status: 400 | 403 | 404 | 409) }
// confirm.ts
export const CONFIRM_TTL_MS = 300_000;
export const MAX_CONFIRM_TOKENS = 100;
export const VOICE_CONFIRM_ERROR = 'Production and paid-server actions need a tap on the confirm card. Voice cannot confirm them.';
export const CONFIRM_EXPIRED_ERROR = 'This confirm card expired or was already used. Open it again.';
export class ConfirmStore {
  constructor(now?: () => number /* Date.now */);
  issue(app: string, action: ConfirmAction, subject: string): { token: string; expiresAt: number };
  consume(token: string, app: string, action: ConfirmAction, subject: string): boolean;
}
export function isVoiceOrigin(value: string | null | undefined): boolean;   // value?.trim().toLowerCase() === VOICE_ORIGIN
```

Rules:
- Tokens are `randomBytes(24).toString('base64url')` and live only in memory, so a hub restart voids them.
- `issue` first drops expired tokens. When `MAX_CONFIRM_TOKENS` remain, it drops the oldest (Map insertion order). `expiresAt = now() + CONFIRM_TTL_MS`.
- `consume` checks, in order:
  1. An unknown token → `false`.
  2. `now() >= expiresAt` → delete it, `false`.
  3. Any of `app`, `action` or `subject` differs → `false`, and the token stays valid.
  4. Otherwise delete it and return `true`.

- [ ] **Step 1: Write the failing tests:**
  - `issues single-use tokens bound to app, action and subject`: a token for `('shop', 'promote', sha)` fails for another app, another action and another sha. It then succeeds once and fails on the replay.
  - `tokens expire after 5 minutes`: with a mutable clock, `consume` at `+299_999` succeeds for one token, and `consume` at `+300_000` fails for another.
  - `keeps at most 100 tokens`: after 101 issues the first token fails and the last succeeds.
  - `tokens are long and random`: at least 32 characters, and two tokens differ.
  - `voice origin detection`: `'voice'` and `' Voice '` → true. `undefined`, `''` and `'tablet'` → false.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/confirm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 5 pass.
- [ ] **Step 5: Commit** as `feat(server): single-use confirm tokens bound to app, action and subject`, with the attribution trailer your harness provides.

---

### Task 11: Deploy tables and `DeployStore`

**Files:**
- Modify: `apps/server/src/db.ts` (append one `MIGRATIONS` entry)
- Create: `apps/server/src/deploy/store.ts`
- Test: `apps/server/src/deploy/store.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 4 (`Db`, `openDb`, `MIGRATIONS`), Task 2 (`DeployRecord`, `DeployLogLine`, `DeployEnv`, `DeployKind`, `DeployStatus`, `DeployActor`, `ACTIVE_DEPLOY_STATUSES`).
- Produces: the appended migration (exact SQL; Tasks 22 and 25 use the `servers` and `setup_runs` tables):

```sql
CREATE TABLE deploys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, env TEXT NOT NULL, kind TEXT NOT NULL, sha TEXT NOT NULL,
  image TEXT NOT NULL, server_key TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, previous_sha TEXT,
  ci_ok INTEGER NOT NULL DEFAULT 0, tests_ok INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX deploys_app_env ON deploys (app, env, id);
CREATE TABLE deploy_logs (
  deploy_id INTEGER NOT NULL REFERENCES deploys(id), seq INTEGER NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (deploy_id, seq));
CREATE TABLE servers (
  key TEXT PRIMARY KEY, hetzner_id INTEGER NOT NULL, role TEXT NOT NULL, ipv4 TEXT NOT NULL,
  ready_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE app_slots (app TEXT PRIMARY KEY, slot INTEGER NOT NULL UNIQUE);
CREATE TABLE setup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL,
  error TEXT, detail TEXT, url TEXT, state TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX setup_runs_app ON setup_runs (app, id);
```

- Produces (`store.ts`):

```ts
export const MAX_LOG_TEXT = 4000;
export const MAX_SLOT = 999;
export interface NewDeploy {
  app: string; env: DeployEnv; kind: DeployKind; sha: string; image: string; serverKey: string; actor: DeployActor;
  status?: DeployStatus /* 'running' */; previousSha?: string | null; ciOk?: boolean; error?: string | null;
}
export type DeployPatch = Partial<Pick<DeployRecord, 'status' | 'previousSha' | 'ciOk' | 'testsOk' | 'error' | 'startedAt' | 'finishedAt'>>;
export class DeployStore {
  constructor(db: Db, now?: () => number);
  create(d: NewDeploy): DeployRecord;                  // createdAt = now; startedAt = status === 'running' ? now : null
  get(id: number): DeployRecord | null;
  update(id: number, patch: DeployPatch): DeployRecord;
  history(app: string, limit?: number /* 50 */): DeployRecord[];   // newest first
  current(app: string, env: DeployEnv): DeployRecord | null;      // newest with status 'success'
  active(app: string, env?: DeployEnv): DeployRecord[];           // status in ACTIVE_DEPLOY_STATUSES, ascending id
  waiting(): DeployRecord[];                                      // every 'waiting_ci' row, ascending id
  interrupted(): DeployRecord[];                                  // every 'running' row, ascending id
  stagingPassed(app: string, sha: string): DeployRecord | null;   // newest staging success with ciOk and testsOk for sha
  candidates(app: string, limit?: number /* 20 */): DeployRecord[];
  rollbackTarget(app: string): DeployRecord | null;
  addLog(deployId: number, text: string): DeployLogLine;          // seq = previous max + 1 (from 1); text cut to MAX_LOG_TEXT
  logs(deployId: number, after?: number /* 0 */, limit?: number /* 1000 */): DeployLogLine[];   // seq > after, ascending
  slot(app: string): number;                                      // allocated once; lowest free 1..MAX_SLOT
  slotOf(app: string): number | null;
}
```

Rules:
- Rows map snake_case to camelCase, and `ci_ok`/`tests_ok` become booleans.
- `candidates(app, limit)`: staging rows with `success`, `ciOk` and `testsOk`. Keep only the newest row per sha, drop the sha of `current(app, 'production')`, and return them newest first.
- `rollbackTarget(app)`:
  1. `cur = current(app, 'production')`. If it is `null`, return `null`.
  2. `skip` holds `cur.sha` plus the `previousSha` of every successful production row with `kind 'rollback'`. These are versions the user rolled back from.
  3. Return the newest production `success` row with `id < cur.id` whose sha is not in `skip`, or `null`.
- `slot` throws `Error('No free app slots')` when 1–999 are all taken.

- [ ] **Step 1: Write the failing tests** (`new DeployStore(openDb(':memory:'), () => t)` with a mutable `t`):
  - `creates and updates deploy records`: the defaults are `status 'running'`, `startedAt = t`, `ciOk false`, `testsOk false`. `update` changes only the given keys.
  - `current is the newest successful deploy per env`.
  - `history is newest first and capped`: 60 rows → 50, starting with the newest id.
  - `staging passed needs ci and tests`: a success with `testsOk false` → `null`.
  - `candidates are distinct and exclude the production sha`.
  - `rollback target skips shas that were rolled back from`:
    - Production successes A (id 1), B (id 2) and C (id 3), then a `rollback` success to B with `previousSha` C (id 4).
    - `rollbackTarget` → the row of A.
    - With production successes A and B only → A. With no production success → `null`.
  - `logs are numbered from 1 and capped`: a 5000-character line is stored as 4000 characters, and `logs(id, 1)` returns seq 2 onward.
  - `waiting and interrupted list rows by status`.
  - `slots are allocated once`: `slot('a')` 1, `slot('b')` 2, `slot('a')` 1 again, `slotOf('c')` null.
  - `slots run out at 999`: insert 999 apps → the 1000th throws `'No free app slots'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/store.test.ts src/db.test.ts`. Expected: FAIL (the tables are missing).
- [ ] **Step 3: Implement**: append the SQL to `MIGRATIONS` (never edit plan 3's entry) and write `store.ts`.
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit** as `feat(server): deploy history, logs, servers, slots and setup run tables`, with the attribution trailer your harness provides.

---

### Task 12: Cloud-init and Caddy sites

**Files:**
- Create: `apps/server/src/infra/cloud-init.ts`, `apps/server/src/infra/sites.ts`
- Test: `apps/server/src/infra/cloud-init.test.ts`, `apps/server/src/infra/sites.test.ts`

**Interfaces:**
- Consumes: Task 1 (`yaml`), Task 2 (`DeployEnv`), Task 5 (`shq`).
- Produces:

```ts
// cloud-init.ts
export const READY_FILE = '/var/lib/hub/ready';
export const USER_DATA_LIMIT = 32_768;
export interface CloudInitOptions { hostname: string; role: DeployEnv; tailscaleAuthKey: string | null; acmeEmail: string | null; allowPublicSsh?: boolean }
export function caddyfile(acmeEmail: string | null): string;
export function setupScript(o: CloudInitOptions): string;
export function cloudInit(o: CloudInitOptions): string;
// sites.ts
export const SHARED_STAGING = 'shared-staging';
export const SHARED_PRODUCTION = 'shared-production';
export const STAGING_PORT_BASE = 8000;
export const UPSTREAM_PORT_BASE = 20000;
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function stagingPort(slot: number): number;                                 // 8000 + slot
export function upstreamPort(slot: number): number;                                // 20000 + slot
export function sslipHost(app: string, ipv4: string): string;                      // `${app}.${ipv4}.sslip.io`
export function stagingUrl(serverKey: string, tailnet: string, slot: number): string;   // `http://${serverKey}.${tailnet}:${stagingPort(slot)}`
export function productionUrl(app: string, ipv4: string): string;                  // `https://${sslipHost(app, ipv4)}`
export interface SiteInput { app: string; env: DeployEnv; slot: number; ipv4: string | null; domain: string | null }
export function siteConfig(s: SiteInput): string;
```

`caddyfile(email)` (exact): `` `{\n\temail ${email}\n}\n\nimport sites/*.caddy\n` ``, or `'import sites/*.caddy\n'` when `email` is `null`. An email that does not match `/^[^\s@'"]+@[^\s@'"]+$/` throws `'Bad ACME email'`.

`setupScript(o)` (exact). Bracketed lines appear only under their condition. `${…}` stands for the TypeScript value, and hostname and key go through `shq`. A hostname that fails `/^[a-z0-9-]{1,63}$/` throws `'Bad server name'`.

```bash
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
hostnamectl set-hostname ${shq(hostname)}
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
install -d -m 755 /etc/caddy/sites
install -d -m 700 /srv/hub/apps /var/lib/hub
cat > /etc/caddy/Caddyfile <<'CADDY'
${caddyfile(acmeEmail)}CADDY
systemctl enable caddy
systemctl reload-or-restart caddy
[key]  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
[key]  tailscale up --authkey=${shq(key)} --hostname=${shq(hostname)}
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
[production]  ufw allow 80/tcp
[production]  ufw allow 443/tcp
[allowPublicSsh]  ufw allow OpenSSH
ufw --force enable
touch /var/lib/hub/ready
```

`cloudInit(o)` = `'#cloud-config\n' + YAML.stringify({ package_update: true, packages: ['curl', 'ca-certificates', 'gnupg', 'ufw', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https'], write_files: [{ path: '/root/hub-setup.sh', permissions: '0700', owner: 'root:root', content: setupScript(o) }], runcmd: [['bash', '/root/hub-setup.sh']] })`. A result of `USER_DATA_LIMIT` bytes or more throws `'cloud-init user data is too large'`.

`siteConfig(s)` (exact):
- staging: `` `# Managed by the Hub: ${app} staging\n:${stagingPort(slot)} {\n\treverse_proxy 127.0.0.1:${upstreamPort(slot)}\n}\n` ``
- production: `` `# Managed by the Hub: ${app} production\n${hosts} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${upstreamPort(slot)}\n}\n` ``, where `hosts` is `sslipHost(app, ipv4)`, followed by `, ${domain}` when `domain` is set.
- Errors:
  - A slot outside 1–999 throws `'Bad app slot'`.
  - Production without `ipv4` throws `'Production needs the server IPv4'`.
  - A `domain` failing `DOMAIN_RE` throws `` `Bad domain ${domain}` ``.
  - An `ipv4` failing `/^\d{1,3}(\.\d{1,3}){3}$/` throws `'Bad IPv4'`.

- [ ] **Step 1: Write the failing tests:**
  - `cloud-init.test.ts`:
    - `is a cloud-config that runs the setup script`: the output starts with `'#cloud-config\n'`. `YAML.parse` gives `write_files[0]` with path `/root/hub-setup.sh` and permissions `'0700'`, and `runcmd` toEqual `[['bash', '/root/hub-setup.sh']]`.
    - `the script installs docker, caddy and tailscale and closes the firewall`, for staging with key `'tskey-auth-x'`:
      - The content contains `set -euo pipefail`, `curl -fsSL https://get.docker.com | sh`, `apt-get install -y caddy`, `tailscale up --authkey='tskey-auth-x' --hostname='shared-staging'`, `ufw allow in on tailscale0`, `ufw --force enable` and `touch /var/lib/hub/ready`.
      - It contains none of `set -x`, `ufw allow OpenSSH` and `ufw allow 80/tcp`.
    - `production opens 80 and 443`.
    - `public ssh only when asked`.
    - `no tailscale without a key`.
    - `the script parses`: write `setupScript` to a temp file. `bash -n` exits 0.
    - `stays under 32 KiB`.
    - `caddyfile imports the sites folder`: both exact strings.
    - `bad names are refused`: `hostname 'a b'` throws `'Bad server name'`.
  - `sites.test.ts`:
    - `ports and urls`: slot 1 → 8001 and 20001. `stagingUrl('shared-staging', 'tail1234.ts.net', 1)` → `'http://shared-staging.tail1234.ts.net:8001'`. `productionUrl('shop', '203.0.113.2')` → `'https://shop.203.0.113.2.sslip.io'`.
    - `staging site is plain HTTP on the app port`: exact text.
    - `production site serves sslip and the domain`: exact text with `domain 'shop.example.com'`.
    - `bad input is refused`: slot 0, missing ipv4, domain `'bad domain'` and ipv4 `'1.2.3'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/cloud-init.test.ts src/infra/sites.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit** as `feat(server): cloud-init for app servers and Caddy site configs`, with the attribution trailer your harness provides.

---

### Task 13: Compose contract and remote commands

**Files:**
- Create: `apps/server/src/deploy/compose.ts`, `apps/server/src/deploy/remote.ts`
- Test: `apps/server/src/deploy/compose.test.ts`, `apps/server/src/deploy/remote.test.ts`

**Interfaces:**
- Consumes: Task 1 (`yaml`), Task 2 (`DeployEnv`), Task 5 (`shq`).
- Produces:

```ts
// compose.ts
export const REQUIRED_SERVICES = ['app', 'migrate', 'smoke'] as const;
export const IMAGE_REF = '${APP_IMAGE}:${APP_TAG}';
export const APP_PORT_MAPPING = '127.0.0.1:${APP_PORT}:3000';
export function checkComposeContract(text: string): string[];   // [] when the file meets the deploy contract
export function composeServices(text: string): string[];        // service names; [] when unparsable
// remote.ts
export const APPS_ROOT = '/srv/hub/apps';
export const HEALTH_PATH = '/api/health';
export const MIGRATIONS_DIR = 'db/migrations';
export const SITE_REJECTED_CODE = 65;
export function stackDir(app: string, env: DeployEnv): string;      // `/srv/hub/apps/${app}-${env}`
export function projectName(app: string, env: DeployEnv): string;   // `${app}-${env}`
export function compose(app: string, env: DeployEnv, args: string, vars?: Record<string, string>): string;
export function writeFileCmd(path: string, mode: string): string;   // content arrives on stdin
export function ensureStackCmd(app: string, env: DeployEnv): string;
export function envFile(v: { app: string; env: DeployEnv; image: string; tag: string; port: number }): string;
export function dockerLoginCmd(user: string): string;
export function healthCmd(port: number): string;
export function sitePath(app: string, env: DeployEnv): string;      // `/etc/caddy/sites/${app}-${env}.caddy`
export function writeSiteCmd(app: string, env: DeployEnv): string;  // content arrives on stdin
export function removeSiteCmd(app: string, env: DeployEnv): string;
```

`checkComposeContract(text)` problem messages (exact), in this order:
1. A YAML parse error → `[`compose.yml is not valid YAML: ${message}`]` and stop.
2. No `services` mapping → `['compose.yml has no services']` and stop.
3. For each of `app`, `migrate` and `smoke`:
   - Missing → `` `compose.yml needs a "${s}" service` ``.
   - Otherwise:
     - `image !== IMAGE_REF` → `` `services.${s}.image must be \${APP_IMAGE}:\${APP_TAG}` ``.
     - A `build` key → `` `services.${s} must not build on the server; it runs the CI image` ``.
4. `app.ports` without the exact string `APP_PORT_MAPPING` → `'services.app.ports must publish 127.0.0.1:${APP_PORT}:3000'`.
5. `migrate` and `smoke` without their own name in `profiles` → `` `services.${s}.profiles must include "${s}"` ``.

Command builders (exact; app names and envs are validated by callers):
- `compose('shop', 'staging', 'pull app', { APP_TAG: 'abc' })` → `` cd '/srv/hub/apps/shop-staging' && APP_TAG='abc' docker compose -p 'shop-staging' --env-file secrets.env --env-file .env -f compose.yml pull app ``. Vars appear in insertion order as `` `${k}=${shq(v)} ` ``, and a key failing `/^[A-Z_][A-Z0-9_]*$/` throws `'Bad variable name'`.
- `writeFileCmd(p, mode)` → `` `umask 077 && cat > ${shq(p + '.tmp')} && chmod ${mode} ${shq(p + '.tmp')} && mv ${shq(p + '.tmp')} ${shq(p)}` ``. `mode` must match `/^[0-7]{3}$/`.
- `ensureStackCmd(app, env)` → `` `install -d -m 700 ${shq(dir)} && cd ${shq(dir)} && touch .env && chmod 600 .env && if [ ! -s secrets.env ]; then (umask 077 && printf 'POSTGRES_PASSWORD=%s\\n' "$(openssl rand -hex 24)" > secrets.env); fi` ``.
- `envFile(v)` → `` `APP_NAME=${app}\nAPP_ENV=${env}\nAPP_IMAGE=${image}\nAPP_TAG=${tag}\nAPP_PORT=${port}\n` ``.
- `dockerLoginCmd(user)` → `` `docker login ghcr.io -u ${shq(user)} --password-stdin` ``.
- `healthCmd(port)` → `` `curl -fsS --max-time 5 http://127.0.0.1:${port}/api/health` ``.
- `writeSiteCmd(app, env)` → with `f = shq(sitePath(app, env))`:

```
f=${f}; cat > "$f.new" && if [ -f "$f" ] && cmp -s "$f.new" "$f"; then rm -f "$f.new"; exit 0; fi; if [ -f "$f" ]; then cp "$f" "$f.bak"; fi; mv "$f.new" "$f"; if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy; then rm -f "$f.bak"; exit 0; fi; if [ -f "$f.bak" ]; then mv "$f.bak" "$f"; else rm -f "$f"; fi; systemctl reload caddy || true; exit 65
```

- `removeSiteCmd(app, env)` → `` `rm -f ${shq(sitePath(app, env))} && systemctl reload caddy` ``.

- [ ] **Step 1: Write the failing tests:**
  - `compose.test.ts` exports nothing but defines `const VALID_COMPOSE` with exactly this text. Task 21 copies it byte for byte into the template's `compose.yml`.

```yaml
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 20
  app:
    image: ${APP_IMAGE}:${APP_TAG}
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
      PORT: "3000"
    ports:
      - "127.0.0.1:${APP_PORT}:3000"
    depends_on:
      db:
        condition: service_healthy
  migrate:
    image: ${APP_IMAGE}:${APP_TAG}
    profiles: [migrate]
    command: ["api/node_modules/.bin/tsx", "api/src/migrate.ts"]
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  smoke:
    image: ${APP_IMAGE}:${APP_TAG}
    profiles: [smoke]
    command: ["api/node_modules/.bin/tsx", "api/src/smoke-main.ts"]
    environment:
      SMOKE_BASE_URL: http://app:3000
volumes:
  db-data:
```

    `checkComposeContract(VALID_COMPOSE)` → `[]`. Then add one test per message above, each built by mutating the parsed fixture and re-stringifying it. `composeServices(VALID_COMPOSE)` → `['db', 'app', 'migrate', 'smoke']`.
  - `remote.test.ts`:
    - `compose commands are exact`: the string above.
    - `bad variable names throw`.
    - `env file lists the five app variables`.
    - `ensureStackCmd generates the database password on the server`: contains `openssl rand -hex 24` and `if [ ! -s secrets.env ]`.
    - `writeSiteCmd validates, reloads and restores`: contains `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, `systemctl reload caddy`, `exit 65` and `'/etc/caddy/sites/shop-staging.caddy'`, and `bash -n` accepts it.
    - `every builder quotes its paths`: `writeFileCmd('/srv/x y', '600')` contains `'/srv/x y.tmp'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/compose.test.ts src/deploy/remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: all pass.
- [ ] **Step 5: Commit** as `feat(server): compose deploy contract and quoted remote commands`, with the attribution trailer your harness provides.

---

### Task 14: Reading an app's history at a SHA (`AppGit`)

**Files:**
- Create: `apps/server/src/deploy/git-info.ts`, `apps/server/src/deploy/fake-git.ts`
- Test: `apps/server/src/deploy/git-info.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 11 (`GitRepo`, `openRepo`, `gitEnv`, `makeTestRepo`, `git`, `TEST_IDENTITY`), plan 3 Task 12 (`RepoRef`, `parseGitHubRemote`), Task 2 (`CommitInfo`).
- Produces:

```ts
// git-info.ts
export const REV_RE = /^(?:[0-9a-f]{7,40}|origin\/[A-Za-z0-9._\/-]+)$/;
export interface AppGit {
  fetch(dir: string): Promise<void>;
  defaultBranch(dir: string): Promise<string>;
  repoRef(dir: string): Promise<RepoRef | null>;
  resolve(dir: string, rev: string): Promise<string | null>;            // full sha; null for a bad or unknown rev
  showFile(dir: string, sha: string, path: string): Promise<string | null>;
  commitsBetween(dir: string, from: string | null, to: string, limit?: number /* 50 */): Promise<CommitInfo[]>;   // newest first
  addedFiles(dir: string, from: string | null, to: string, prefix: string): Promise<string[]>;                   // sorted
}
export function createAppGit(openRepoFn: (dir: string) => GitRepo, readDir?: (dir: string) => string /* default d => d */): AppGit;
// fake-git.ts
export class FakeAppGit implements AppGit {
  head: string;                                   // what origin/<anything> resolves to
  defaultFiles: Record<string, string>;           // files of any sha without its own entry
  fetched: number;
  ref: RepoRef | null;                            // default { owner: 'acme', repo: 'demo' }
  setFiles(sha: string, files: Record<string, string>): void;
  setCommits(commits: CommitInfo[]): void;        // returned by commitsBetween (sliced to limit)
  setAdded(paths: string[]): void;                // returned by addedFiles (filtered by prefix)
}
```

`createAppGit` rules:
- `fetch`, `defaultBranch` and `repoRef` go through `openRepoFn(dir)`: `fetch()`, `defaultBranch()`, and `parseGitHubRemote(await remoteUrl() ?? '')`.
- Reads use `simpleGit(readDir(dir)).env(gitEnv())`. Production passes `checkouts.readDir` (Task 42), so the hub reads history from the hub-owned mirror, never from the checkout:
  - `resolve` → `rev-parse --verify --quiet <rev>^{commit}` when `rev` matches `REV_RE`, else `null`. An error → `null`.
  - `showFile` → `show <sha>:<path>`. A sha not matching `/^[0-9a-f]{40}$/`, a path containing `..`, or an error → `null`.
  - `commitsBetween` → `log --format=%H%x1f%s%x1f%an%x1f%ct -n <limit> <range>`, where the range is `from..to` (or just `to` when `from` is null). `at = ct * 1000`.
  - `addedFiles` → `diff --name-only --diff-filter=A <from> <to> -- <prefix>`. When `from` is null, `ls-tree -r --name-only <to> -- <prefix>`.

- [ ] **Step 1: Write the failing tests.** Use `makeTestRepo({ files: { 'db/migrations/0001_init.sql': 'create table a(x int);\n' } })`, then add a second commit in `work` (`db/migrations/0002_b.sql`, subject `add b`) and push it.
  - `resolves the default branch head`: after `fetch`, `resolve(work, 'origin/main')` equals `git(work, 'rev-parse', 'origin/main')`.
  - `rejects unsafe revisions`: `'--all'`, `'HEAD;rm -rf /'` and `'main'` → `null`.
  - `shows a file at a commit`: missing file → `null`, and a `'../x'` path → `null`.
  - `lists commits newest first with subjects`: `commitsBetween(work, first, second)` → one commit with subject `'add b'` and author `'Hub Test'`.
  - `lists added migration files`: `addedFiles(work, first, second, 'db/migrations/')` → `['db/migrations/0002_b.sql']`. With `from` null → both files.
  - `repoRef parses the GitHub remote`: `{ owner: 'acme', repo: 'demo' }`.
  - `fake git resolves origin refs to head`.
  - `reads can come from another repository`: `createAppGit(fn, () => origin)`. Then `resolve(work, second)` is `second`, and `showFile(work, second, 'db/migrations/0002_b.sql')` is that file's content.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/git-info.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** as `feat(server): read an app's commits, files and migrations at a SHA`, with the attribution trailer your harness provides.

---

### Task 15: Template root, shared types, web app and design folder

**Files:**
- Create under `templates/vite-hono-pg/`: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.dockerignore`, `README.md`, `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`, `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/App.module.css`, `web/src/routes.tsx`, `web/src/routes.test.ts`, `web/src/pages/Home.tsx`, `web/src/pages/Home.module.css`, `web/src/styles/global.css`, `web/src/vite-env.d.ts`, `design/meta.json`, `design/tokens.json`
- Test: `apps/server/src/newapp/template-web.test.ts`

These are template files, not hub source. They are small, and this task only pins their contract.

**Interfaces:**
- Consumes: Task 1 (`DEFAULT_TEMPLATES_DIR`, `@hub/design-model` dev dependency), Task 3 (`readTemplate`, `TEMPLATE_NAME`).
- Produces: the template's workspace layout that Tasks 16 and 21 extend, and these contracts:
  - Root `package.json` (exact):

```json
{
  "name": "app-root",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.28.0",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "lint:migrations": "pnpm -F @app/api lint:migrations"
  }
}
```

  - `pnpm-workspace.yaml`: `packages: [web, api, shared]` and `allowBuilds: { esbuild: true }`.
  - `tsconfig.base.json` holds the hub's base options plus `"isolatedModules": true`.
  - `.gitignore`: `node_modules/`, `dist/`, `.env`, `*.log`.
  - `.dockerignore`: `**/node_modules`, `**/dist`, `.git`, `.github`, `.hub`, `design`.
  - `README.md` starts with `# __APP_NAME__` and lists `__STAGING_URL__`, `__PRODUCTION_URL__` and the root scripts.
  - `@app/shared`:
    - `exports: { ".": "./src/index.ts" }`, script `typecheck`, devDependency `typescript ^7.0.2`.
    - `src/index.ts` exports `interface Health { ok: boolean; sha: string }` and `interface Note { id: number; text: string; createdAt: string }`.
  - `@app/web`:
    - Scripts: `dev` (`vite`), `build` (`vite build`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`).
    - Dependencies: `@app/shared workspace:*`, `react ^19.3.0`, `react-dom ^19.3.0`.
    - devDependencies: `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`, `@vitejs/plugin-react ^6.1.2`, `typescript ^7.0.2`, `vite ^8.3.4`, `vitest ^5.0.4`.
  - `web/vite.config.ts`: the React plugin, `server.proxy['/api'] = 'http://127.0.0.1:3000'`, and `build.outDir 'dist'`.
  - `web/src/routes.tsx` (the manifest's `design.routes`):

```tsx
export interface AppRoute { path: string; page: string; title: string; component: ComponentType }
export const routes: AppRoute[] = [{ path: '/', page: 'home', title: 'Home', component: Home }];
export function matchRoute(pathname: string): AppRoute | null;   // exact match; a trailing '/' is ignored except for '/'
```

  - `App.tsx` renders `matchRoute(location.pathname)?.component`, or `<p>Not found</p>`.
  - `Home.tsx` shows `<h1>__APP_NAME__</h1>` and the API version from `GET /api/health` (`API ok, version <first 7 of sha>`). It imports `./Home.module.css`, and every page under `web/src/pages/` uses a sibling CSS Module.
  - `design/meta.json` (exact, canonical): `{\n  "seq": 0,\n  "version": 1\n}\n`.
  - `design/tokens.json` (exact, canonical):

```json
{
  "color": {
    "accent": "#2563eb",
    "bg": "#ffffff",
    "muted": "#6b7280",
    "text": "#111827"
  },
  "font": {
    "body": "system-ui, sans-serif"
  },
  "radius": {
    "md": "8px"
  },
  "space": {
    "lg": "24px",
    "md": "16px",
    "sm": "8px"
  }
}
```

  - `web/src/styles/global.css` declares each token in `:root` as `--<group>-<name>: <value>;` and uses them in the `body` styles.
  - `web/src/routes.test.ts`: `matchRoute('/')?.page === 'home'`, `matchRoute('/nope') === null`.

- [ ] **Step 1: Write the failing test** `template-web.test.ts`, with `dir = join(DEFAULT_TEMPLATES_DIR, TEMPLATE_NAME)` and `files = readTemplate(dir)`:
  - `design folder parses with the design model`: build the `design/` files with the prefix removed. `parseDoc(...)` is ok, `validateDoc(doc)` is `null`, and `canonicalStringify(doc.meta)` and `canonicalStringify(doc.tokens)` equal the two file texts.
  - `global css defines every design token`: for each group and name, `global.css` contains `--${group}-${name}: ${value};`.
  - `the routes file is where the manifest points`: `web/src/routes.tsx` contains `export const routes` and `export function matchRoute`.
  - `pages use CSS Modules`: every `web/src/pages/*.tsx` imports `./<Name>.module.css`, and that file exists.
  - `package files pin the toolchain`:
    - The root has `packageManager 'pnpm@10.28.0'` and `engines.node '>=22.12'`.
    - The web package's dependency and devDependency versions are exactly as listed.
  - `the workspace lists web, api and shared`: `YAML.parse(pnpm-workspace.yaml).packages` toEqual `['web', 'api', 'shared']`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/template-web.test.ts`. Expected: FAIL.
- [ ] **Step 3: Create** the template files.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** `templates/vite-hono-pg` and the test as `feat(template): vite-hono-pg web app, shared types and design folder`, with the attribution trailer your harness provides.

---

### Task 16: Template API, migrations, migration lint and smoke tests

**Files:**
- Create under `templates/vite-hono-pg/`: `api/package.json`, `api/tsconfig.json`, `api/src/app.ts`, `api/src/db.ts`, `api/src/server.ts`, `api/src/migrations.ts`, `api/src/migrate.ts`, `api/src/lint-migrations.ts`, `api/src/smoke.ts`, `api/src/smoke-main.ts`, `api/src/app.test.ts`, `api/src/migrations.test.ts`, `api/src/smoke.test.ts`, `db/migrations/0001_init.sql`
- Test: `apps/server/src/newapp/template-api.test.ts`

**Interfaces:**
- Consumes: Task 1 (`DEFAULT_TEMPLATES_DIR`).
- Produces (Task 24 and the deploy contract rely on these):

```ts
// api/src/migrations.ts — pure, no imports (the hub's tests import it directly)
export const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
export const CONTRACT_MARKER = '-- hub:contract';
export function isContract(sql: string): boolean;               // /^\s*--\s*hub:contract\b/m
export function sortMigrations(files: string[]): string[];      // by name
export function checkMigrationNames(files: string[]): string[];
export function stripSqlComments(sql: string): string;          // drops -- line comments and /* */ blocks
export function lintMigration(file: string, sql: string): string[];
// api/src/smoke.ts — no imports beyond the global fetch
export function runSmoke(base: string, fetchFn?: typeof fetch): Promise<string[]>;   // [] when every check passes
// api/src/app.ts
export interface NotesStore { list(): Promise<Note[]>; add(text: string): Promise<Note> }
export function createApp(opts: { sha: string; notes: NotesStore; webDist?: string | null }): Hono;
```

`@app/api` `package.json`:
- Scripts: `dev` (`tsx watch src/server.ts`), `start` (`tsx src/server.ts`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `migrate` (`tsx src/migrate.ts`), `smoke` (`tsx src/smoke-main.ts`), `lint:migrations` (`tsx src/lint-migrations.ts`).
- Dependencies: `@app/shared workspace:*`, `@hono/node-server ^2.1.5`, `hono ^4.13.13`, `pg ^8.23.1`, `tsx ^4.23.15`. `tsx` is a runtime dependency because the image runs TypeScript with it.
- devDependencies: `@types/node ^22.20.5`, `@types/pg ^8.23.1`, `typescript ^7.0.2`, `vitest ^5.0.4`.

Behavior:
- `createApp`:
  - `GET /api/health` → 200 `{ ok: true, sha }`.
  - `GET /api/notes` → the list.
  - `POST /api/notes { text }`: a non-empty string of at most 500 characters → 201 note. Anything else → 400 `{ error: 'text is required' }`.
  - With `webDist`: serve static files from it, and send `index.html` for any other GET outside `/api`.
- `server.ts` reads `PORT` (3000), `DATABASE_URL` (required; a missing one prints `DATABASE_URL is not set` and exits 1), `APP_SHA` (`'dev'`) and `WEB_DIST` (used only when it exists).
- `migrate.ts`:
  1. Connect with `pg.Client(DATABASE_URL)` and `SELECT pg_advisory_lock(727001)`.
  2. `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.
  3. Read `MIGRATIONS_DIR` (default: `db/migrations` relative to the repo root, via `new URL('../../db/migrations/', import.meta.url)`). A non-empty `checkMigrationNames` result prints the problems and exits 1.
  4. Apply each pending file in name order, each inside `BEGIN … COMMIT` together with its `schema_migrations` insert. Print `Applied <file>` per file.
  5. Unlock and exit 0. Any error prints its message and exits 1.
- `lint-migrations.ts` prints every `checkMigrationNames` and `lintMigration` problem and exits 1 when there is one. Otherwise it prints `Migrations OK (<n> files)`.
- `runSmoke(base)` failures (exact):
  - `` `GET /api/health answered ${status}` ``
  - `'GET /api/health did not report ok'`
  - `` `GET /api/notes answered ${status}` ``
  - `'GET /api/notes did not return a list'`
  - `` `Could not reach ${base}: ${message}` ``
- `smoke-main.ts` uses `SMOKE_BASE_URL ?? 'http://127.0.0.1:3000'`. It prints `Smoke tests passed.` and exits 0, or prints each failure and exits 1.
- `db/migrations/0001_init.sql`: `CREATE TABLE notes (id serial PRIMARY KEY, text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());` (formatted over several lines).

`checkMigrationNames` messages:
- `` `${f}: name must look like 0001_add_users.sql` ``
- `` `${f}: number ${n} is used twice` ``

`lintMigration(file, sql)`:
- Returns `[]` when `isContract(sql)`.
- Otherwise it checks `stripSqlComments(sql)` against these rules, in order, and adds one message per rule that hits:

| Rule name | Hit when |
|---|---|
| `DROP TABLE` | `/\bDROP\s+TABLE\b/i` |
| `DROP COLUMN` | `/\bDROP\s+COLUMN\b/i` |
| `RENAME` | `/\bRENAME\b/i` |
| `ALTER COLUMN TYPE` | `/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i` |
| `SET NOT NULL` | `/\bSET\s+NOT\s+NULL\b/i` |
| `TRUNCATE` | `/\bTRUNCATE\b/i` |
| `DROP SCHEMA` | `/\bDROP\s+SCHEMA\b/i` |
| `ADD COLUMN NOT NULL without DEFAULT` | some `;`-separated statement matches `/\bALTER\s+TABLE\b/i`, `/\bADD\s+(?:COLUMN\s+)?/i` and `/\bNOT\s+NULL\b/i`, but not `/\bDEFAULT\b/i` |

Each message (exact): `` `${file}: ${rule} breaks the version that is still running. Split it into expand and contract steps, and mark the contract migration with "-- hub:contract".` ``

- [ ] **Step 1: Write the failing test** `template-api.test.ts`. It imports `../../../../templates/vite-hono-pg/api/src/migrations.js` and `…/smoke.js`.
  - `lint flags each breaking statement`: one SQL sample per rule, giving exactly one message naming that rule.
  - `contract migrations are exempt`: `'-- hub:contract\nALTER TABLE a DROP COLUMN b;'` → `[]`.
  - `safe changes pass`: `ALTER TABLE a ADD COLUMN b text;`, `ALTER TABLE a ADD COLUMN c int NOT NULL DEFAULT 0;` and `CREATE TABLE x (id int NOT NULL);` → `[]`. A `DROP TABLE` inside a comment → `[]`.
  - `migration names are checked`: `['0001_init.sql', '0001_dup.sql', 'bad.sql']` gives the two kinds of message.
  - `the template's own migrations pass the lint`.
  - `smoke checks health and notes`: a fake fetch with both answering → `[]`. Health 500 → `['GET /api/health answered 500']`. A rejecting fetch → the `Could not reach` message.
  - `api package pins the toolchain`: the exact dependency versions above.

  The template's own tests (`app.test.ts`, `migrations.test.ts`, `smoke.test.ts`) cover the same behavior with vitest inside the template. They run in Task 21's manual verification and in the app's CI.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/template-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Create** the template files.
- [ ] **Step 4: Run** the same command and `pnpm -F @hub/server typecheck`. Expected: 7 pass, and typecheck is clean (the imported template modules compile under the hub's strict settings).
- [ ] **Step 5: Commit** as `feat(template): Hono API, ordered migrations with an expand/contract lint, smoke tests`, with the attribution trailer your harness provides.

---

### Task 17: Client API calls for deploy and setup

**Files:**
- Modify: `apps/client/src/net/api.ts`
- Test: `apps/client/src/net/api-deploy.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 22 (`ApiClient`, its private `json`/`request` helpers and `appPath`), Task 2 (DTOs).
- Produces (new `ApiClient` methods; paths are under `/api`, and app names go through `encodeURIComponent`):

| Method | Request | Returns |
|---|---|---|
| `deployState(app): Promise<DeployState>` | `GET /apps/:app/deploy` | body |
| `deployLogs(app, deployId, after?): Promise<DeployLogLine[]>` | `GET /apps/:app/deploy/:id/logs` (+ `?after=N` when given) | `body.lines` |
| `deployStaging(app, sha?): Promise<DeployRecord>` | `POST /apps/:app/deploy/staging` `{ sha }` (`{}` without one) | `body.deploy` |
| `prepareProduction(app, action, sha?): Promise<ConfirmCard>` | `POST /apps/:app/deploy/production/prepare` `{ action, sha }` | `body.card` |
| `production(app, action, sha, token): Promise<DeployRecord>` | `POST /apps/:app/deploy/production` `{ action, sha, token }` | `body.deploy` |
| `newAppPlan(name): Promise<SetupPlan>` | `POST /newapp/plan` `{ name }` | body |
| `newApp(name, token?): Promise<SetupRun>` | `POST /newapp` `{ name, token }` | `body.run` |
| `adoptPlan(app): Promise<SetupPlan>` | `POST /apps/:app/adopt/plan` `{}` | body |
| `adopt(app, token?): Promise<SetupRun>` | `POST /apps/:app/adopt` `{ token }` | `body.run` |
| `movePlan(app, env): Promise<SetupPlan>` | `POST /apps/:app/move/plan` `{ env }` | body |
| `move(app, env, token?): Promise<SetupRun>` | `POST /apps/:app/move` `{ env, token }` | `body.run` |
| `setupRuns(): Promise<SetupRun[]>` | `GET /setup/runs` | `body.runs` |

Optional fields that are `undefined` are left out of the JSON. The client never sends `x-hub-origin`; plan 6's voice client sets it.

- [ ] **Step 1: Write the failing test** with a recording `fetchFn`:
  - `deploy calls use the right paths and bodies`: one assertion per row (method, URL, parsed body).
  - `no request carries the voice origin header`: no recorded request has a `x-hub-origin` header.
  - `errors become ApiError`: a 403 `{ error: 'x' }` from `production` rejects with `ApiError` status 403 and message `'x'`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/net/api-deploy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the methods.
- [ ] **Step 4: Run** the same command and `pnpm -F @hub/client typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** as `feat(client): API calls for deploy, confirm cards and setup`, with the attribution trailer your harness provides.

---

### Task 18: Client deploy view state

**Files:**
- Create: `apps/client/src/areas/deploy/state.ts`
- Test: `apps/client/src/areas/deploy/state.test.ts`

**Interfaces:**
- Consumes: Task 2 (`DeployState`, `DeployRecord`, `DeployLogLine`, `EnvState`, `DeployStatus`, `DEPLOY_STATUS_LABEL`, `ACTIVE_DEPLOY_STATUSES`, `shortSha`, `ServerMsg`).
- Produces:

```ts
export interface DeployView { loaded: boolean; state: DeployState | null; logs: Record<number, DeployLogLine[]> }
export const EMPTY_DEPLOY_VIEW: DeployView;          // { loaded: false, state: null, logs: {} }
export const MAX_LOG_LINES = 2000;
export const MAX_HISTORY = 50;
export const ENV_LABEL: Readonly<Record<DeployEnv, string>>;     // { staging: 'Staging', production: 'Production' }
export const ACTOR_LABEL: Readonly<Record<DeployActor, string>>; // { merge: 'merge', user: 'you', newapp: 'New app', hub: 'the Hub' }
export function applyDeployState(v: DeployView, s: DeployState): DeployView;   // loaded true, state s, logs kept
export function applyDeployMsg(v: DeployView, app: string, m: ServerMsg): DeployView;   // returns v itself when m is irrelevant
export function mergeLogs(existing: DeployLogLine[], incoming: DeployLogLine[]): DeployLogLine[];   // by seq, deduped, ascending, last MAX_LOG_LINES
export function withLogs(v: DeployView, deployId: number, lines: DeployLogLine[]): DeployView;    // creates or merges logs[deployId]
export function isTerminal(status: DeployStatus): boolean;          // not in ACTIVE_DEPLOY_STATUSES
export function envSummary(e: EnvState): string;
export interface ProductionControls { canPromote: boolean; promoteHint: string | null; canRollback: boolean; rollbackHint: string | null }
export function productionControls(s: DeployState): ProductionControls;
export function historyLabel(d: DeployRecord): string;
```

Rules:
- `applyDeployMsg`. When `v.state` is `null` or the message is for another app, return `v`.
  - `deploy.update`:
    - Replace the record in `history` by id, or insert it, keeping history sorted by id descending and capped at `MAX_HISTORY`.
    - For the record's env: if the status is active and the record's id ≥ `active?.id ?? 0`, it becomes `active`. If it is terminal and `active?.id === id`, `active` becomes `null`. A `success` with an id greater than `current?.id ?? 0` becomes `current`.
  - `deploy.log`: merge into `logs[deployId]` only when that key exists, because the UI opened that deploy.
- `envSummary`:
  - With an `active` record → `` `${DEPLOY_STATUS_LABEL[active.status]} ${shortSha(active.sha)}` ``.
  - Else with `current` → `` `Live ${shortSha(current.sha)}` ``.
  - Else → `'Not deployed yet'`.
- `productionControls(s)`:
  - `promoteHint` is the first that applies:
    1. `s.problems.length > 0` → `'Fix the problems above first.'`
    2. `s.production.active` → `'A production deploy is running.'`
    3. No candidates → `'Deploy to staging and pass its tests first.'`
    4. Otherwise `null`.
  - `rollbackHint` uses the same first two rules, then `s.rollbackTo === null` → `'No earlier production version.'`.
  - `canX = xHint === null`.
- `historyLabel(d)` = `` `${ENV_LABEL[d.env]} ${d.kind} ${shortSha(d.sha)} by ${ACTOR_LABEL[d.actor]} · ${DEPLOY_STATUS_LABEL[d.status]}` ``, e.g. `'Production promote abc1234 by you · Live'`.

- [ ] **Step 1: Write the failing tests** (`state.test.ts`, with a `makeState()` fixture builder in the test):
  - `applies a fetched state`.
  - `a running deploy becomes active and then current`.
  - `a failed deploy clears active and keeps current`.
  - `history stays sorted and capped`.
  - `messages for other apps are ignored`: the same object is returned.
  - `logs merge only for opened deploys`.
  - `mergeLogs dedupes by seq and caps`.
  - `env summary texts`: all three exact forms.
  - `production controls explain why a button is off`: each hint, in priority order.
  - `history labels name env, kind, sha, actor and status`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/areas/deploy/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `state.ts`.
- [ ] **Step 4: Run** the same command. Expected: 10 pass.
- [ ] **Step 5: Commit** as `feat(client): deploy view state, summaries and button hints`, with the attribution trailer your harness provides.

---

### Task 19: Client setup run helpers

**Files:**
- Create: `apps/client/src/areas/deploy/setup-state.ts`
- Test: `apps/client/src/areas/deploy/setup-state.test.ts`

**Interfaces:**
- Consumes: Task 2 (`SetupRun`, `SetupStep`, `SETUP_STEPS`, `SETUP_STEP_LABEL`, `ServerQuote`, `APP_NAME_PATTERN`, `ServerMsg`).
- Produces:

```ts
export interface StepRow { step: SetupStep; label: string; state: 'done' | 'active' | 'todo' | 'failed' }
export const NAME_HINT = 'Use 2–40 lowercase letters, digits and dashes, starting with a letter.';
export function stepRows(run: SetupRun): StepRow[];
export function applySetupMsg(run: SetupRun | null, m: ServerMsg): SetupRun | null;
export function quoteSummary(servers: ServerQuote[]): string;
export function nameProblem(name: string): string | null;
```

Rules:
- `stepRows` lists `SETUP_STEPS[run.kind]` with labels:
  - `status 'success'` → every row is `done`.
  - Otherwise the steps before `run.step` are `done`, `run.step` is `active` (or `failed` when `run.status === 'failed'`), and later steps are `todo`.
- `applySetupMsg` returns the message's run when `m.type === 'setup.progress'`, `run` is non-null, the ids match, and `m.run.updatedAt >= run.updatedAt`. Otherwise it returns `run`.
- `quoteSummary([])` → `''`. Otherwise (exact) `` `Creates ${n} server${n === 1 ? '' : 's'} on Hetzner: ${list}` ``, where each item is `` `${key} (${serverType}, ${location}, €${monthlyGross}/month)` `` and items are joined with `', '`.
- `nameProblem(name)` → `NAME_HINT` unless `new RegExp(APP_NAME_PATTERN).test(name)`, else `null`.

- [ ] **Step 1: Write the failing tests:**
  - `step rows follow the run`: a `new` run at `ci` gives 4 done, 1 active and 1 todo. Failed at `repo` gives `failed`. A success gives all done.
  - `progress messages replace the matching run only`.
  - `quote summary`: two servers give `'Creates 2 servers on Hetzner: shared-staging (cx23, nbg1, €4.59/month), shared-production (cx23, nbg1, €4.59/month)'`.
  - `name rules match the server`: `'shop'` → null. `'Shop'`, `'1shop'`, `'s'` and `'shop-'` → `NAME_HINT`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/areas/deploy/setup-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `setup-state.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 pass.
- [ ] **Step 5: Commit** as `feat(client): setup run steps, server quote text, app name hint`, with the attribution trailer your harness provides.

---

### Task 20: Ops: deploy credentials, the agent user, SSH key and app scripts, docs

**Files:**
- Modify: `ops/hub/hub.service`, `ops/hub/hub.env.example`, `ops/hub/set-secret.sh`, `ops/hub/bootstrap.sh`, `docs/hub-bootstrap.md`, `apps/server/src/ops.test.ts`
- Create: `ops/hub/make-ssh-key.sh`, `ops/hub/add-app.sh` (both mode 755)

**Interfaces:**
- Consumes: Task 1 (credential and setting names, `loadConfig`), Task 41 (the `hub-agent` user and the `Agent isolation OK` log line), plan 3 Task 29 (the ops files and `ops.test.ts`). `add-app.sh` writes the mirror layout from Task 42's rules, which this plan spells out, so no Task 42 code is needed and the two can run in the same wave.
- Produces:
  - `hub.service`: these lines go right after `LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN`. `ImportCredential=` is used because it skips a missing credential, so the hub still starts before deploy is set up.

```ini
ImportCredential=HCLOUD_TOKEN
ImportCredential=GHCR_READ_TOKEN
ImportCredential=TS_AUTHKEY
ImportCredential=HUB_SSH_KEY
Environment=HUB_SSH_KEY_PATH=%d/HUB_SSH_KEY
```

  - `hub.service` also gains these lines right after `UnsetEnvironment=…`. They let the hub start and stop `hub-agent` processes and nothing more, and they hide the hub's processes from `hub-agent`:

```ini
SupplementaryGroups=hub-apps
UMask=0007
AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_KILL
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL
ProtectProc=invisible
```

  - `hub.env.example`: `HUB_APPS_DIR=/var/lib/hub/apps` becomes `HUB_APPS_DIR=/var/lib/hub-apps`, and these lines are appended (exact):

```
# Claude Code and Build commands run as this user; the hub's git uses mirrors here.
HUB_AGENT_USER=hub-agent
HUB_MIRRORS_DIR=/var/lib/hub-mirrors
# Deploy (docs/hub-bootstrap.md, "Deploy and New app"). HUB_GHCR_USER defaults to GITHUB_OWNER.
HUB_GHCR_USER=
HUB_TAILNET=
HUB_HCLOUD_LOCATION=nbg1
HUB_ACME_EMAIL=
```

  - `set-secret.sh`: the `case` line accepts `HUB_PASSPHRASE_HASH|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|HCLOUD_TOKEN|GHCR_READ_TOKEN|TS_AUTHKEY`.
  - `make-ssh-key.sh` (exact):

```bash
#!/usr/bin/env bash
# Usage: sudo ops/hub/make-ssh-key.sh [--replace]
# Creates the deploy key as an encrypted systemd credential. The plain key exists only in /dev/shm, briefly.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
out=/etc/credstore.encrypted/HUB_SSH_KEY
if [ -e "$out" ] && [ "${1:-}" != "--replace" ]; then
  echo "HUB_SSH_KEY already exists. --replace makes a new key, and existing app servers will stop accepting the Hub." >&2
  exit 1
fi
install -d -m 700 /etc/credstore.encrypted
tmp="$(mktemp -d /dev/shm/hub-key.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
ssh-keygen -q -t ed25519 -N '' -C hub-deploy -f "$tmp/key"
systemd-creds encrypt --name=HUB_SSH_KEY "$tmp/key" "$out"
echo "Stored HUB_SSH_KEY encrypted. Public key (the Hub uploads it to Hetzner itself):"
cat "$tmp/key.pub"
echo "Apply with: sudo systemctl restart hub"
```

  - `bootstrap.sh` (plan 3's exact script) changes in three places:
    1. Replace `install -d -o hub -g hub -m 750 /var/lib/hub/data /var/lib/hub/apps` with:

```bash
getent group hub-apps >/dev/null || groupadd --system hub-apps
id hub-agent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hub-agent --shell /usr/sbin/nologin --user-group hub-agent
usermod -aG hub-apps hub
usermod -aG hub-apps hub-agent
chmod 700 /var/lib/hub /var/lib/hub-agent
install -d -o hub -g hub -m 700 /var/lib/hub/data
install -d -o hub -g hub-apps -m 2750 /var/lib/hub-apps /var/lib/hub-mirrors
```

    2. Right after the line that runs `pnpm install --frozen-lockfile && pnpm -F @hub/client build`, add `chmod 700 /opt/hub/templates`.
    3. After the two `sudo -u hub -H git config --global` lines, add:

```bash
sudo -u hub-agent -H git config --global user.name "$HUB_GIT_NAME"
sudo -u hub-agent -H git config --global user.email "$HUB_GIT_EMAIL"
sudo -u hub-agent -H git config --global safe.directory '*'
```

  - `add-app.sh` (exact). The hub creates mirrors only for New app, so an existing repo comes in through this script. It writes the same mirror layout as Task 42:

```bash
#!/usr/bin/env bash
# Usage: sudo ops/hub/add-app.sh <owner>/<app>
# Adds an existing GitHub repo to the Hub: a hub-owned mirror, and hub-agent's checkout cloned from it.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
if [[ ! "${1:-}" =~ ^[A-Za-z0-9_.-]+/([a-z][a-z0-9-]{1,39})$ ]]; then
  echo "Usage: add-app.sh <owner>/<app>, where <app> uses lowercase letters, digits and dashes" >&2
  exit 1
fi
repo="$1"; name="${BASH_REMATCH[1]}"
mirror="/var/lib/hub-mirrors/$name.git"; work="/var/lib/hub-apps/$name"
[ ! -e "$work" ] || { echo "$work already exists" >&2; exit 1; }
umask 0007
cd /
as_hub() { setpriv --reuid=hub --regid=hub --init-groups -- env HOME=/var/lib/hub "$@"; }
as_agent() { setpriv --reuid=hub-agent --regid=hub-agent --init-groups -- env HOME=/var/lib/hub-agent "$@"; }
# The token travels in the environment only, never in a command line.
token="$(systemd-creds decrypt --name=GITHUB_TOKEN /etc/credstore.encrypted/GITHUB_TOKEN -)"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 -w0)"
export GIT_CONFIG_VALUE_0
unset token
if [ ! -e "$mirror/HEAD" ]; then
  as_hub git init -q --bare --shared=0640 --template= "$mirror"
  as_hub git --git-dir="$mirror" config remote.origin.url "https://github.com/$repo.git"
  as_hub git --git-dir="$mirror" config --add remote.origin.fetch '+refs/heads/*:refs/heads/*'
  as_hub git --git-dir="$mirror" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
fi
as_hub git --git-dir="$mirror" fetch -q --prune --no-write-fetch-head origin
as_hub git --git-dir="$mirror" remote set-head origin --auto >/dev/null
default="$(as_hub git --git-dir="$mirror" symbolic-ref --short refs/remotes/origin/HEAD)"
as_hub git --git-dir="$mirror" symbolic-ref HEAD "refs/heads/${default#origin/}"
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
install -d -o hub -g hub-apps -m 2770 "$work"
as_agent git clone -q --no-local "$mirror" "$work"
echo "Added $name. It appears in the Hub's app list."
```

  - `docs/hub-bootstrap.md` changes plan 3's text in two places:
    - Step 8 (clone app repos) becomes: `sudo /opt/hub/ops/hub/add-app.sh <owner>/<app>` for each app.
    - The known limit "Claude runs as the same Unix user as the hub…" becomes: `Claude runs as hub-agent, not as the hub user (see "Deploy and New app").`
  - `docs/hub-bootstrap.md` gains a section `## Deploy and New app` after step 12, with these numbered steps and exact commands:
    1. **Agent user:**
       - Run `sudo bash /opt/hub/ops/hub/bootstrap.sh` again. It creates `hub-agent`, the `hub-apps` group, `/var/lib/hub-apps` and `/var/lib/hub-mirrors`, and installs the new unit.
       - In `/etc/hub/hub.env`, set `HUB_APPS_DIR=/var/lib/hub-apps`, `HUB_AGENT_USER=hub-agent` and `HUB_MIRRORS_DIR=/var/lib/hub-mirrors`.
       - Add each app again with `sudo /opt/hub/ops/hub/add-app.sh <owner>/<app>`. Old checkouts under `/var/lib/hub/apps` are no longer used.
       - After the restart in the last step, `journalctl -u hub -n 20` shows `Agent isolation OK`. If it shows `Agent isolation check failed`, the hub has stopped and names what `hub-agent` can still reach.
    2. **GitHub token:** edit the fine-grained token from step 1 to cover **All repositories** and add **Administration: read and write** (creates repositories) and **Workflows: read and write** (pushes `.github/workflows/ci.yml`). Then run `sudo /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN` if you regenerated it.
    3. **Image pull token:** GHCR accepts only classic tokens. Create a classic token with only `read:packages`, run `sudo /opt/hub/ops/hub/set-secret.sh GHCR_READ_TOKEN`, and set `HUB_GHCR_USER=<the token's GitHub user>` in `/etc/hub/hub.env`.
    4. **Hetzner:** Cloud Console → your project → Security → API tokens → **Read & Write**, then `sudo /opt/hub/ops/hub/set-secret.sh HCLOUD_TOKEN`.
    5. **Tailscale key for app servers:** in the access controls, add `"tagOwners": { "tag:hub-app": ["autogroup:admin"] }`. Create a **reusable, pre-approved** auth key with tag `tag:hub-app`, then `sudo /opt/hub/ops/hub/set-secret.sh TS_AUTHKEY`.
    6. **Tailnet name:** set `HUB_TAILNET=<tailnet DNS name, like tail1234.ts.net>` (Tailscale admin → DNS) in `/etc/hub/hub.env`. Optionally set `HUB_ACME_EMAIL` and `HUB_HCLOUD_LOCATION` (default `nbg1`).
    7. **Deploy key:** `sudo /opt/hub/ops/hub/make-ssh-key.sh`.
    8. **Restart:** `sudo systemctl restart hub`. The Deploy tab lists anything still missing.
    - **Known limits** (one short paragraph each):
      - Claude and Build commands run as `hub-agent`, which cannot read the hub's credentials, data or templates, and the hub checks this every time it starts. To start and stop those processes, the hub holds `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`. A compromised hub process could therefore become any user, so treat the hub itself as equivalent to root.
      - The Tailscale auth key travels in each new server's cloud-init user data, so use a tagged key and rotate it.
      - Staging is plain HTTP inside the tailnet, which is encrypted.
      - Production HTTPS uses `sslip.io` names with Let's Encrypt, whose limits are shared by everyone using sslip.io. If a certificate is delayed, set `deploy.production.domain` once you own a domain.
      - If you delete an app server and the Hub creates it again, remove the old machine from the Tailscale admin console first, or the new one gets a `-1` name.

- [ ] **Step 1: Write the failing tests** in `ops.test.ts`:
  - Update `scripts parse` to include `ops/hub/make-ssh-key.sh` and `ops/hub/add-app.sh`.
  - Update `nothing sets ANTHROPIC_API_KEY` to include `ops/hub/make-ssh-key.sh` and `ops/hub/add-app.sh`.
  - Update `env example holds only non-secret settings`: its keys toEqual `['HUB_BIND', 'HUB_PORT', 'HUB_DATA_DIR', 'HUB_APPS_DIR', 'GITHUB_OWNER', 'HUB_AGENT_USER', 'HUB_MIRRORS_DIR', 'HUB_GHCR_USER', 'HUB_TAILNET', 'HUB_HCLOUD_LOCATION', 'HUB_ACME_EMAIL']`, and none of them is in `CREDENTIAL_KEYS`. The example contains `HUB_APPS_DIR=/var/lib/hub-apps`.
  - Add `unit lets the hub switch to hub-agent and nothing more`: `hub.service` contains the five lines above.
  - Add `bootstrap creates the agent user and private folders`:
    - `bootstrap.sh` contains the `useradd … hub-agent` line, `install -d -o hub -g hub -m 700 /var/lib/hub/data`, `install -d -o hub -g hub-apps -m 2750 /var/lib/hub-apps /var/lib/hub-mirrors`, `chmod 700 /opt/hub/templates` and `safe.directory '*'`.
    - It no longer contains `/var/lib/hub/apps`.
  - Add `add-app keeps the token out of command lines`:
    - `add-app.sh` contains `GIT_CONFIG_VALUE_0`, `--shared=0640 --template=`, `--no-write-fetch-head` and `git clone -q --no-local`, and no line matches `/extraheader=AUTHORIZATION/`.
    - `bash ops/hub/add-app.sh 'bad name'` exits 1. That holds whether or not the test runs as root.
  - Add `unit imports deploy credentials and points at the key`: the five lines above.
  - Add `the deploy key never goes to ~/.ssh`: `make-ssh-key.sh` does not match `/\.ssh\//` and contains `/dev/shm` and `systemd-creds encrypt --name=HUB_SSH_KEY`.
  - Add `set-secret accepts the deploy secrets`: the script text contains `HCLOUD_TOKEN|GHCR_READ_TOKEN|TS_AUTHKEY`.
  - Add `docs cover deploy setup`: the docs contain `make-ssh-key.sh`, `set-secret.sh HCLOUD_TOKEN`, `set-secret.sh GHCR_READ_TOKEN`, `set-secret.sh TS_AUTHKEY`, `read:packages`, `HUB_TAILNET`, `tag:hub-app`, `add-app.sh`, `HUB_AGENT_USER` and `Agent isolation OK`, and no longer contain `same Unix user`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/ops.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit** the ops files and docs. `chmod +x ops/hub/make-ssh-key.sh ops/hub/add-app.sh`.
- [ ] **Step 4: Run** the same command. Expected: all pass. If `shellcheck` is installed, `shellcheck ops/hub/*.sh` is clean.
- [ ] **Step 5: Commit** `ops/hub docs/hub-bootstrap.md apps/server/src/ops.test.ts` as `docs(ops): hub-agent user, deploy credentials as systemd credentials, deploy key and add-app scripts`, with the attribution trailer your harness provides.

---

### Task 21: Template Dockerfile, compose file, CI, manifest and lockfile

**Files:**
- Create under `templates/vite-hono-pg/`: `Dockerfile`, `compose.yml`, `.github/workflows/ci.yml`, `.hub/app.json`, `pnpm-lock.yaml` (generated)
- Test: `apps/server/src/newapp/template-ops.test.ts`

**Interfaces:**
- Consumes: Task 3 (`readTemplate`, `renderTemplate`, `TEMPLATE_NAME`, `TEMPLATE_ID`), Task 13 (`checkComposeContract`, and `VALID_COMPOSE` in `compose.test.ts`), Tasks 15–16 (the template workspace), plan 3 Task 1 (`parseAppManifest`).
- Produces: a complete template that renders into a repo meeting the deploy contract.
  - `compose.yml` is byte for byte the `VALID_COMPOSE` text from `apps/server/src/deploy/compose.test.ts`.
  - `.hub/app.json` (exact):

```json
{
  "name": "__APP_NAME__",
  "template": "vite-hono-pg@1",
  "design": { "dir": "design", "routes": "web/src/routes.tsx", "devices": ["desktop", "tablet", "mobile"] },
  "build": { "install": "pnpm install --frozen-lockfile", "test": "pnpm test", "typecheck": "pnpm typecheck" },
  "deploy": {
    "image": "__APP_IMAGE__",
    "staging": { "server": "__STAGING_SERVER__", "url": "__STAGING_URL__" },
    "production": { "server": "__PRODUCTION_SERVER__", "url": "__PRODUCTION_URL__", "domain": null }
  }
}
```

  - `Dockerfile` (exact):

```dockerfile
FROM node:22-slim AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/
COPY api/package.json api/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -F @app/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json web/
COPY api/package.json api/
COPY shared/package.json shared/
RUN pnpm install --frozen-lockfile --prod
COPY shared/ shared/
COPY api/ api/
COPY db/ db/
COPY --from=build /app/web/dist web/dist
ARG APP_SHA=dev
ENV APP_SHA=$APP_SHA WEB_DIST=/app/web/dist MIGRATIONS_DIR=/app/db/migrations PORT=3000
USER node
EXPOSE 3000
CMD ["api/node_modules/.bin/tsx", "api/src/server.ts"]
```

  - `.github/workflows/ci.yml` (exact):

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
env:
  IMAGE: __APP_IMAGE__
jobs:
  check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint:migrations
      - run: pnpm build
  image:
    needs: check
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
          build-args: APP_SHA=${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

  - `pnpm-lock.yaml` comes from `pnpm install --lockfile-only --ignore-scripts`, run inside `templates/vite-hono-pg`. The template's own `pnpm-workspace.yaml` makes it a separate workspace. This is the only task that writes this file.

- [ ] **Step 1: Write the failing test** `template-ops.test.ts`. Use `vars = { name: 'shop', image: 'ghcr.io/acme/shop', stagingServer: 'shared-staging', stagingUrl: 'http://shared-staging.tail1234.ts.net:8001', productionServer: 'shared-production', productionUrl: 'https://shop.203.0.113.2.sslip.io' }` and `files = renderTemplate(readTemplate(dir), vars)`.
  - `the manifest validates once rendered`: `parseAppManifest(files['.hub/app.json'])` is ok. `name 'shop'`, `template TEMPLATE_ID`, `build.install 'pnpm install --frozen-lockfile'`, the deploy fields equal `vars`, and `production.domain` is `null`.
  - `every placeholder is replaced`: no rendered file contains `__APP_`, `__STAGING_` or `__PRODUCTION_`.
  - `compose.yml meets the deploy contract`: `checkComposeContract(files['compose.yml'])` toEqual `[]`, and `services.db.image` is `'postgres:17-alpine'`.
  - `CI checks, then pushes the sha image with the built-in token`:
    - `on.push.branches` toEqual `['main']`.
    - The `check` steps' `run` values include `pnpm typecheck`, `pnpm test`, `pnpm lint:migrations` and `pnpm build`. Its `uses` values are `actions/checkout@v6`, `pnpm/action-setup@v6` and `actions/setup-node@v6`.
    - `jobs.image.needs` is `'check'`, `jobs.image.permissions.packages` is `'write'`, and the build-push step uses `docker/build-push-action@v7` with tags `'${{ env.IMAGE }}:${{ github.sha }}'`.
    - Rendered `env.IMAGE` is `'ghcr.io/acme/shop'`.
    - The only `secrets.` reference in the file is `secrets.GITHUB_TOKEN`.
  - `the image runs the API on port 3000 as node`: the Dockerfile contains `FROM node:22-slim`, `pnpm install --frozen-lockfile --prod`, `ARG APP_SHA`, `USER node` and `EXPOSE 3000`.
  - `the lockfile covers every workspace package`:
    - `YAML.parse(pnpm-lock.yaml).importers` has the keys `'.'`, `'api'`, `'shared'` and `'web'`.
    - For each of `web`, `api` and `shared`, every dependency and devDependency in its `package.json` appears in the importer with the same `specifier`.
  - `layout matches the convention`: these exist: `web/src/main.tsx`, `api/src/app.ts`, `shared/src/index.ts`, `db/migrations/0001_init.sql`, `design/meta.json`, `Dockerfile`, `compose.yml`, `.github/workflows/ci.yml` and `.hub/app.json`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/template-ops.test.ts`. Expected: FAIL.
- [ ] **Step 3: Create** the four files, then run `cd templates/vite-hono-pg && pnpm install --lockfile-only --ignore-scripts && cd -`.
- [ ] **Step 4: Run** the same test command. Expected: 7 pass.
- [ ] **Step 5: Verify the template builds** (needs the npm registry; skip in an offline sandbox and say so in the report):
  1. `cd templates/vite-hono-pg && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm lint:migrations && pnpm build`. Expected: all succeed, and `lint:migrations` prints `Migrations OK (1 files)`.
  2. Then `rm -rf node_modules */node_modules web/dist && cd -`.
  3. If Docker is available: `docker build -t hub-template-check templates/vite-hono-pg`. Expected: success.
- [ ] **Step 6: Commit** `templates/vite-hono-pg` and the test as `feat(template): Dockerfile, compose contract, CI to GHCR, manifest and lockfile`, with the attribution trailer your harness provides.

---

### Task 22: App servers on Hetzner (`ServerStore`, `ServerManager`)

**Files:**
- Create: `apps/server/src/infra/servers.ts`
- Test: `apps/server/src/infra/servers.test.ts`

**Interfaces:**
- Consumes: Task 4 (`Hetzner`, `FakeHetzner`, `FirewallRule`), Task 5 (`SshRunner`, `FakeSsh`), Task 10 (`DeployError`), Task 11 (the `servers` table), Task 12 (`cloudInit`, `READY_FILE`, `SHARED_STAGING`, `SHARED_PRODUCTION`), Task 2 (`DeployEnv`, `ServerQuote`), Task 1 (`HubConfig`).
- Produces:

```ts
export const SHARED_SERVERS: Readonly<Record<DeployEnv, string>>;   // { staging: 'shared-staging', production: 'shared-production' }
export const SERVER_TYPE = 'cx23';
export const SERVER_IMAGE = 'ubuntu-24.04';
export const READY_TIMEOUT_MS = 1_200_000;
export const READY_POLL_MS = 10_000;
export const SERVER_KEY_RE = /^(?:shared-staging|shared-production|[a-z][a-z0-9-]{0,38}[a-z0-9]-(?:staging|production))$/;
export function roleForKey(key: string): DeployEnv;           // throws `Bad server name ${key}` unless SERVER_KEY_RE matches
export function dedicatedKey(app: string, env: DeployEnv): string;   // `${app}-${env}`
export function firewallRules(role: DeployEnv, publicSsh: boolean): FirewallRule[];
export interface ServerRecord { key: string; hetznerId: number; role: DeployEnv; ipv4: string; readyAt: number | null; createdAt: number }
export class ServerStore {
  constructor(db: Db, now?: () => number);
  get(key: string): ServerRecord | null;
  list(): ServerRecord[];
  upsert(r: { key: string; hetznerId: number; role: DeployEnv; ipv4: string }): ServerRecord;   // resets readyAt to null when hetznerId changes
  markReady(key: string): ServerRecord;
}
export interface ServerManagerDeps {
  store: ServerStore; hetzner: Hetzner | null; ssh: SshRunner;
  config: Pick<HubConfig, 'tailnet' | 'hcloudLocation' | 'tsAuthKey' | 'acmeEmail'>;
  publicKey: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
  publicSsh?: boolean;            // live test only: SSH to the public IPv4 and open port 22
  sshKeyName?: string;            // default 'hub'
  firewallPrefix?: string;        // default 'hub'
  readyTimeoutMs?: number; readyPollMs?: number;
}
export class ServerManager {
  constructor(deps: ServerManagerDeps);
  host(key: string): string;                       // `${key}.${tailnet}`; with publicSsh the stored ipv4; no tailnet (and no publicSsh) → DeployError('HUB_TAILNET is not set.', 409)
  get(key: string): ServerRecord | null;
  ready(key: string): boolean;                     // readyAt !== null
  missing(keys: string[]): string[];               // keys that are not ready, deduped, sorted
  quote(keys: string[]): Promise<ServerQuote[]>;   // one quote per missing key
  ensure(key: string, onLog?: (line: string) => void): Promise<ServerRecord>;
}
```

`firewallRules(role, publicSsh)`:
- Always: `{ direction: 'in', protocol: 'udp', port: '41641', source_ips: ['0.0.0.0/0', '::/0'], description: 'Tailscale' }` and `{ direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'], description: 'Ping' }`.
- `production` adds tcp `80` (`'HTTP'`) and tcp `443` (`'HTTPS'`), both from anywhere.
- `publicSsh` adds tcp `22` (`'SSH'`).

`ensure(key, onLog)`:
1. `roleForKey(key)` validates the key. A stored record that is ready is returned at once.
2. Single flight: a second call for a key already in progress returns the same promise. The promise is removed when it settles.
3. `hetzner === null` → `DeployError('HCLOUD_TOKEN is not set.', 409)`.
4. `found = (await hetzner.listServers(`hub-server=${key}`))[0]`. Without one, create it:
   1. `sshKeyId = ensureSshKey(sshKeyName, await publicKey())`.
   2. `firewallId = ensureFirewall(`${firewallPrefix}-${role}`, firewallRules(role, publicSsh), { 'hub-role': role })`.
   3. `onLog(`Creating ${key} (${SERVER_TYPE}, ${location}) on Hetzner.`)`.
   4. `createServer({ name: key, serverType: SERVER_TYPE, image: SERVER_IMAGE, location, sshKeyIds: [sshKeyId], firewallIds: [firewallId], userData: cloudInit({ hostname: key, role, tailscaleAuthKey: tsAuthKey, acmeEmail, allowPublicSsh: publicSsh }), labels: { 'hub-server': key, 'hub-role': role } })`, then `waitAction(actionId)`.
5. If the store has no record for `key`, or its `hetznerId` differs from the server in use, call `ssh.forgetHost(host(key))`. A re-created server has a new host key.
6. `store.upsert({ key, hetznerId, role, ipv4 })`. A server without an IPv4 → `DeployError(`${key} has no public IPv4.`, 409)`.
7. `onLog(`Waiting for ${key} to finish setup.`)`. Then poll `ssh.exec(host(key), `test -f ${READY_FILE}`, { timeoutMs: 30_000 })` every `readyPollMs`.
   - Code 0 → `markReady`, `onLog(`${key} is ready.`)`, and return the record.
   - After `readyTimeoutMs / readyPollMs` polls → `DeployError(`${key} did not finish setup within 20 minutes. If it was re-created, remove the old ${key} machine in the Tailscale admin console and try again.`, 409)`.

`quote(keys)`: `hetzner === null` → `DeployError('HCLOUD_TOKEN is not set.', 409)`. Otherwise `monthlyPrice(SERVER_TYPE, location)` is fetched once, and each missing key gives `{ key, role, serverType: SERVER_TYPE, location, monthlyGross }`.

- [ ] **Step 1: Write the failing tests.** Use `FakeHetzner`, `FakeSsh` (`on('test -f /var/lib/hub/ready', { code: 0 })`), `new ServerStore(openDb(':memory:'))`, `config = { tailnet: 'tail1234.ts.net', hcloudLocation: 'nbg1', tsAuthKey: 'tskey-auth-x', acmeEmail: null }`, `publicKey: async () => 'ssh-ed25519 AAAA hub'`, and `sleep: async () => {}`.
  - `ensure creates a cx23 server with cloud-init, firewall and labels`: `created[0]` has `serverType 'cx23'`, `image 'ubuntu-24.04'`, `location 'nbg1'`, labels `{ 'hub-server': 'shared-staging', 'hub-role': 'staging' }`, and `userData` containing `tailscale up`. The record is ready with `ipv4 '203.0.113.3'` (ids 1 and 2 go to the key and the firewall).
  - `ensure reuses a ready server without calling Hetzner`: on the second call, `hetzner.calls` does not grow.
  - `concurrent ensure creates one server`: `Promise.all([ensure(k), ensure(k)])` → `created.length === 1`.
  - `ensure resumes a server that exists on Hetzner but not in the store`: no `createServer` call.
  - `ensure forgets the old host key of a new server`: the store holds `shared-staging` with `hetznerId 99` (not ready), and Hetzner has none. After `ensure`, `ssh.forgotten` toEqual `['shared-staging.tail1234.ts.net']`.
  - `ensure fails after the ready timeout`: the ready check answers code 1, with `readyTimeoutMs 30` and `readyPollMs 10`. It rejects with the exact message.
  - `missing and quote list only servers that are not ready`: `monthlyGross '4.59'`, `serverType 'cx23'`.
  - `without HCLOUD_TOKEN ensure and quote refuse`: `'HCLOUD_TOKEN is not set.'`.
  - `production firewall opens 80 and 443; public ssh adds 22`.
  - `server keys are validated`: `roleForKey('evil;rm')` throws. `roleForKey('shop-production')` → `'production'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/servers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `servers.ts`.
- [ ] **Step 4: Run** the same command. Expected: 10 pass.
- [ ] **Step 5: Commit** as `feat(server): create and track app servers on Hetzner, one at a time per name`, with the attribution trailer your harness provides.

---

### Task 23: One app stack on one server (`StackOps`)

**Files:**
- Create: `apps/server/src/deploy/stack.ts`
- Test: `apps/server/src/deploy/stack.test.ts`

**Interfaces:**
- Consumes: Task 5 (`SshRunner`, `FakeSsh`, `shq`), Task 12 (`upstreamPort`), Task 13 (all builders in `remote.ts`), Task 2 (`DeployEnv`, `shortSha`).
- Produces:

```ts
export class StackError extends Error { constructor(message: string, readonly step: string) }
export interface StackTarget { app: string; env: DeployEnv; host: string; image: string; slot: number }
export interface StackDeps {
  ssh: SshRunner; ghcrUser: string; ghcrToken: string; log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>; timeoutMs?: number /* DEFAULT_SSH_TIMEOUT_MS */;
}
export class StackOps {
  constructor(deps: StackDeps, target: StackTarget);
  readonly target: StackTarget;
  vars(tag: string): Record<string, string>;   // { APP_NAME, APP_ENV, APP_IMAGE, APP_TAG: tag, APP_PORT: String(upstreamPort(slot)) }, in that order
  command(args: string, tag: string): string;  // compose(app, env, args, vars(tag))
  prepare(composeYml: string): Promise<void>;
  login(): Promise<void>;
  pull(tag: string): Promise<void>;
  startDb(tag: string): Promise<void>;
  migrate(tag: string): Promise<void>;
  swap(tag: string): Promise<void>;
  health(tag: string, attempts?: number /* 30 */, delayMs?: number /* 2000 */): Promise<boolean>;
  smoke(tag: string): Promise<boolean>;
  logsTail(tag: string, lines?: number /* 50 */): Promise<void>;
  writeSite(config: string): Promise<void>;
  removeSite(): Promise<void>;
  stopApp(tag: string): Promise<void>;
  startApp(tag: string): Promise<void>;
  down(tag: string): Promise<void>;            // compose down (named volumes are kept)
  readSecrets(): Promise<string>;
  writeSecrets(text: string): Promise<void>;
}
```

Each method runs these commands, where `dir = stackDir(app, env)`:

| Method | Commands (stdin) | Failure |
|---|---|---|
| `prepare` | `ensureStackCmd`, then `writeFileCmd(`${dir}/compose.yml`, '644')` (stdin `composeYml`) | `Preparing the stack` |
| `login` | `dockerLoginCmd(ghcrUser)` (stdin `ghcrToken`), quiet | `StackError('docker login to ghcr.io failed. Check GHCR_READ_TOKEN.', 'login')` |
| `pull` | `command('pull app', tag)` | `Pulling the image` |
| `startDb` | `command('up -d --wait db', tag)` | `Starting the database` |
| `migrate` | `command('--profile migrate run --rm migrate', tag)` | `Migrations` |
| `swap` | `writeFileCmd(`${dir}/.env`, '600')` (stdin `envFile(...)`), then `command('up -d --wait --wait-timeout 120 app', tag)` | `Starting the new version` |
| `health` | `healthCmd(upstreamPort(slot))` per attempt, quiet, `timeoutMs 15_000` | returns `false` |
| `smoke` | `command('--profile smoke run --rm smoke', tag)` | returns `false` |
| `logsTail` | `command(`logs --no-color --tail ${n} app`, tag)` | ignored |
| `writeSite` | `writeSiteCmd(app, env)` (stdin `config`) | exit 65 → `StackError('Caddy rejected the site config.', 'routes')`; other → `Writing the Caddy site` |
| `removeSite` | `removeSiteCmd(app, env)` | `Removing the Caddy site` |
| `stopApp` / `startApp` / `down` | `command('stop app', tag)` / `command('up -d app', tag)` / `command('down', tag)` | `Stopping the app` / `Starting the app` / `Stopping the stack` |
| `readSecrets` | `` `cat ${shq(`${dir}/secrets.env`)}` ``, quiet | `Reading secrets` |
| `writeSecrets` | `` `install -d -m 700 ${shq(dir)} && ${writeFileCmd(`${dir}/secrets.env`, '600')}` `` (stdin `text`), quiet | `Copying secrets` |

Rules:
- A "Failure" text `X` means: throw `StackError(`${X} failed (exit ${code})${last ? `: ${last}` : ''}`, step)`, where `last` is the last non-empty stderr line.
- A non-quiet command streams every output line to `log`. Each line is first redacted, with every occurrence of `ghcrToken` replaced by `***`.
- `health` succeeds on the first attempt whose exit code is 0 and whose stdout parses as JSON with `ok === true` and `sha === tag`. It then logs `` `Health check passed on ${shortSha(tag)}.` `` and returns `true`. Between attempts it sleeps `delayMs`. After the last attempt it logs `'Health check failed.'` and returns `false`.

- [ ] **Step 1: Write the failing tests** (`FakeSsh`, target `{ app: 'shop', env: 'staging', host: 'shared-staging.tail1234.ts.net', image: 'ghcr.io/acme/shop', slot: 1 }`, `sha = 'a'.repeat(40)`, `sleep` stub):
  - `prepare writes compose.yml on stdin and ensures secrets`: the first call is `ensureStackCmd('shop', 'staging')`, and the second call's stdin is the compose text.
  - `login sends the token on stdin only`: the command contains no `tok`, and stdin is `'tok'`.
  - `compose calls carry every app variable`: `pull(sha)` gives exactly `` cd '/srv/hub/apps/shop-staging' && APP_NAME='shop' APP_ENV='staging' APP_IMAGE='ghcr.io/acme/shop' APP_TAG='aaaa…a' APP_PORT='20001' docker compose -p 'shop-staging' --env-file secrets.env --env-file .env -f compose.yml pull app ``.
  - `a failing step throws StackError with the step and last stderr line`: `migrate` with code 1 and stderr `'x\nrelation exists\n'` → `'Migrations failed (exit 1): relation exists'`, step `'migrate'`.
  - `swap writes .env before starting the app`.
  - `health retries until the new sha answers`: `{"ok":true,"sha":"old"}` twice, then the new sha → `true` after 3 calls.
  - `health gives up after the attempts`: `false`, and `'Health check failed.'` is logged.
  - `smoke passes on exit 0 and fails otherwise`.
  - `writeSite reports a Caddy rejection`.
  - `secrets and the token never reach the log`: `readSecrets` returns `'POSTGRES_PASSWORD=p\n'` and nothing is logged. A command line echoing `tok` is logged as `***`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/stack.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `stack.ts`.
- [ ] **Step 4: Run** the same command. Expected: 10 pass.
- [ ] **Step 5: Commit** as `feat(server): StackOps runs one app stack over SSH`, with the attribution trailer your harness provides.

---

### Task 24: Confirm cards for promote, rollback and new servers

**Files:**
- Create: `apps/server/src/deploy/cards.ts`
- Test: `apps/server/src/deploy/cards.test.ts`

**Interfaces:**
- Consumes: Task 10 (`ConfirmStore`, `DeployError`), Task 11 (`DeployStore`), Task 14 (`AppGit`, `FakeAppGit`), Task 16 (`CONTRACT_MARKER` in the template, test only), Task 2 (`ConfirmCard`, `ServerQuote`, `shortSha`).
- Produces:

```ts
export const CONTRACT_MARKER = '-- hub:contract';
export function isContractSql(sql: string): boolean;          // /^\s*--\s*hub:contract\b/m
export function provisionSubject(keys: string[]): string;     // `servers:${[...keys].sort().join(',')}`
export function notCandidateMessage(sha: string): string;     // `${shortSha(sha)} has not passed staging and its tests, so it cannot go to production.`
export const NO_ROLLBACK_MESSAGE = 'There is no earlier production version to roll back to.';
export interface CardDeps { git: AppGit; store: DeployStore; confirm: ConfirmStore }
export function promoteCard(d: CardDeps, app: string, dir: string, sha: string, targetServer: string): Promise<ConfirmCard>;
export function rollbackCard(d: CardDeps, app: string, dir: string): Promise<ConfirmCard>;
export function provisionCard(confirm: ConfirmStore, app: string, servers: ServerQuote[]): ConfirmCard;
```

`promoteCard`:
1. `store.stagingPassed(app, sha)` is `null` → `DeployError(notCandidateMessage(sha), 409)`.
2. `cur = store.current(app, 'production')` and `fromSha = cur?.sha ?? null`.
3. `commits`: `[]` when `fromSha === sha`, else `git.commitsBetween(dir, fromSha, sha)`.
4. `migrations`: for each `git.addedFiles(dir, fromSha, sha, 'db/migrations/')`, read `showFile(dir, sha, f)` → `{ file: basename(f), contract: isContractSql(text ?? '') }`, sorted by file.
5. `{ token, expiresAt } = confirm.issue(app, 'promote', sha)`.
6. `title`: `` `Promote ${shortSha(sha)} to production` ``, plus `` ` and move it to ${targetServer}` `` when `cur` exists and `cur.serverKey !== targetServer`.
7. Return `{ action: 'promote', app, subject: sha, token, expiresAt, title, sha, fromSha, commits, migrations, servers: [] }`.

`rollbackCard`:
1. `target = store.rollbackTarget(app)`. `null` → `DeployError(NO_ROLLBACK_MESSAGE, 409)`.
2. `cur = store.current(app, 'production')!`.
3. `commits = git.commitsBetween(dir, target.sha, cur.sha)` (the commits being undone), `migrations: []`, `title`: `` `Roll back production to ${shortSha(target.sha)}` ``, `fromSha: cur.sha`.
4. The token is issued for `('rollback', target.sha)`, and `subject` is `target.sha`.

`provisionCard`:
- `subject = provisionSubject(keys)`.
- `title` is `'Create 1 server on Hetzner'` or `` `Create ${n} servers on Hetzner` ``.
- `sha` and `fromSha` are `null`, `commits` and `migrations` are `[]`, and `servers` is the given list.

- [ ] **Step 1: Write the failing tests** (`FakeAppGit`, `DeployStore(openDb(':memory:'))`, `ConfirmStore`):
  - `promote card lists commits and pending migrations`: `setAdded(['db/migrations/0002_b.sql'])` → `migrations` toEqual `[{ file: '0002_b.sql', contract: false }]`, and the token consumes for `('promote', sha)`.
  - `a contract migration is flagged`.
  - `only shas that passed staging can be promoted`: the exact `notCandidateMessage`.
  - `moving production shows in the title`.
  - `rollback card targets the previous production sha`.
  - `no rollback without an earlier version`: `NO_ROLLBACK_MESSAGE`.
  - `provision card binds the sorted server keys`: `subject 'servers:shared-production,shared-staging'`.
  - `the contract marker matches the template's`: `CONTRACT_MARKER` equals the template module's `CONTRACT_MARKER` (import `../../../../templates/vite-hono-pg/api/src/migrations.js`).
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/cards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `cards.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** as `feat(server): confirm cards naming the SHA, commits, migrations and servers`, with the attribution trailer your harness provides.

---

### Task 25: Setup runs and the first commit of a new repo

**Files:**
- Create: `apps/server/src/newapp/runs.ts`, `apps/server/src/newapp/repo.ts`
- Test: `apps/server/src/newapp/runs.test.ts`, `apps/server/src/newapp/repo.test.ts`

**Interfaces:**
- Consumes: Task 11 (the `setup_runs` table), Task 2 (`SetupRun`, `SetupKind`, `SetupStep`, `SETUP_STEPS`), plan 3 Task 11 (`openRepo`, `gitEnv`, `GitIdentity`, `git`, `TEST_IDENTITY`).
- Produces:

```ts
// runs.ts
export const INTERRUPTED_SETUP_ERROR = 'Interrupted because the Hub restarted. Tap Try again to continue.';
export interface RunState { repoCreated?: boolean; sha?: string; slot?: number; taskId?: number; deployId?: number }
export type RunPatch = Partial<Pick<SetupRun, 'status' | 'step' | 'error' | 'detail' | 'url'>>;
export class SetupRunStore {
  constructor(db: Db, now?: () => number);
  create(kind: SetupKind, app: string): SetupRun;      // status 'running', step SETUP_STEPS[kind][0]
  get(id: number): SetupRun | null;
  update(id: number, patch: RunPatch): SetupRun;       // bumps updatedAt
  state(id: number): RunState;
  setState(id: number, patch: RunState): RunState;     // shallow merge, stored as JSON
  latest(app: string, kind?: SetupKind): SetupRun | null;
  active(app: string): SetupRun | null;                // newest with status 'running'
  list(limit?: number /* 20 */): SetupRun[];           // newest first
  failInterrupted(): number;                            // running → failed with INTERRUPTED_SETUP_ERROR
}
// repo.ts
export function writeFiles(dir: string, files: Record<string, string>): void;   // creates folders; '..' or absolute → Error('Bad file path')
export interface BootstrapInput { dir: string; files: Record<string, string>; remoteUrl: string; token: string | null; identity?: GitIdentity; message: string }
export function bootstrapRepo(i: BootstrapInput): Promise<string>;              // returns the pushed HEAD sha
```

`bootstrapRepo`:
1. If `dir/.git` does not exist:
   1. `mkdir -p dir` and `writeFiles`.
   2. `simpleGit(dir).env(gitEnv(identity))`: `init(['-b', 'main'])` and `addRemote('origin', remoteUrl)`.
   3. `openRepo(dir, { token, identity }).commitAll(message)`.
2. If `dir/.git` exists (a resumed run), it does not rewrite files, and it commits only when the tree is dirty.
3. `push('main')`, then return `headSha()`. Pushing a commit the remote already has is a no-op.

- [ ] **Step 1: Write the failing tests:**
  - `runs.test.ts`:
    - `creates runs at their first step`: a `new` run starts at `servers`.
    - `state merges`.
    - `latest and active`.
    - `interrupted runs fail on restart`: two running runs → `failInterrupted()` returns 2, and both are `failed` with `INTERRUPTED_SETUP_ERROR`.
  - `repo.test.ts` (a local bare repo as `remoteUrl`, `identity: TEST_IDENTITY`):
    - `bootstraps a repo and pushes main`: `git(origin, 'log', '--format=%s', 'main')` is `'Create shop from vite-hono-pg@1'`, and the returned sha equals `git(origin, 'rev-parse', 'main')`.
    - `a resumed bootstrap pushes the same commit once`: calling it again → the same sha, and `git(origin, 'rev-list', '--count', 'main')` is `'1'`.
    - `writeFiles refuses paths outside the folder`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/runs.test.ts src/newapp/repo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 7 pass.
- [ ] **Step 5: Commit** as `feat(server): resumable setup runs and the first push of a new repo`, with the attribution trailer your harness provides.

---

### Task 26: Adopt manifest and prompt

**Files:**
- Create: `apps/server/src/adopt/prompt.ts`
- Test: `apps/server/src/adopt/prompt.test.ts`

**Interfaces:**
- Consumes: plan 3 Task 1 (`AppManifest`, `parseAppManifest`).
- Produces:

```ts
export const ADOPTED_TEMPLATE = 'adopted@1';
export type PackageManager = 'pnpm' | 'yarn' | 'npm';
export function packageManagerOf(rootFiles: string[]): PackageManager;   // pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm
export interface AdoptInput {
  name: string; image: string; stagingServer: string; stagingUrl: string; productionServer: string; productionUrl: string;
  packageManager: PackageManager; hasPackageJson: boolean;
}
export function adoptManifest(i: AdoptInput): AppManifest;
export function adoptPrompt(i: AdoptInput): string;
```

`adoptManifest`:
- `template: ADOPTED_TEMPLATE`.
- `design: { dir: 'design', routes: 'web/src/routes.tsx', devices: ['desktop', 'tablet', 'mobile'] }`.
- `build` by package manager:
  - pnpm: `pnpm install --frozen-lockfile` / `pnpm test` / `pnpm typecheck`
  - yarn: `yarn install --frozen-lockfile` / `yarn test` / `yarn typecheck`
  - npm: `npm ci` / `npm test` / `npm run typecheck`
- `deploy` comes from the input, with `production.domain: null`.

`adoptPrompt(i)` (exact). `${image}`, `${packageManager}` and the bracketed sentence are interpolated. Every other `${…}`, including `${{ github.sha }}`, is literal text, so escape it in the template literal.

```
Adopt this app into the Hub convention. The Hub committed .hub/app.json on this branch. Keep its "name" and "deploy" fields exactly as written; correct "build" and "design.routes" if they do not match this repo.

Add whatever is missing so the app deploys like every Hub app:
1. A multi-stage Dockerfile that builds the app and serves it on port 3000 as a non-root user. It takes the build argument APP_SHA and passes it to the app.
2. GET /api/health answering HTTP 200 with JSON {"ok": true, "sha": "<APP_SHA>"}.
3. compose.yml with services "app", "migrate" (profiles: [migrate]) and "smoke" (profiles: [smoke]), each with image ${APP_IMAGE}:${APP_TAG} and none with a build key. "app" publishes "127.0.0.1:${APP_PORT}:3000". If the app needs Postgres, add a "db" service (postgres:17-alpine) with POSTGRES_PASSWORD from the environment and a named volume. Without a database, "migrate" may just exit 0.
4. SQL migrations in db/migrations/ named like 0001_init.sql, applied in order by "migrate". Each migration must keep the running version working (expand now, contract later); start a contract migration with the line "-- hub:contract".
5. A "smoke" command that calls the running app at http://app:3000 (at least /api/health) and exits non-zero on failure.
6. .github/workflows/ci.yml: on pull requests and pushes to main, install, typecheck and test; on pushes to main, then build the image and push it as ${image}:${{ github.sha }} to ghcr.io with the built-in GITHUB_TOKEN (permissions: packages: write). Add no other secrets.
7. A minimal passing test if the repo has none, and "typecheck" and "test" scripts that match .hub/app.json.

Image: ${image}. Package manager: ${packageManager}.[ There is no package.json at the root: pick build commands that fit this repo and update "build" in .hub/app.json.]
Do not deploy, push or switch branches. The Hub opens the pull request when you finish.
```

The bracketed sentence (without its brackets) appears only when `hasPackageJson` is false.

- [ ] **Step 1: Write the failing tests:**
  - `detects the package manager from lockfiles`.
  - `adopt manifest validates and uses adopted@1`: `parseAppManifest(JSON.stringify(adoptManifest(i)))` is ok, and the build commands match each package manager.
  - `prompt names the image and the deploy contract`: it contains `Image: ghcr.io/acme/demo.`, `${APP_IMAGE}:${APP_TAG}`, `127.0.0.1:${APP_PORT}:3000`, `/api/health`, `-- hub:contract`, `packages: write` and `ghcr.io/acme/demo:${{ github.sha }}`.
  - `the missing package.json note appears only when needed`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/adopt/prompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `prompt.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 pass.
- [ ] **Step 5: Commit** as `feat(server): adopt manifest and the prompt that adds the convention`, with the attribution trailer your harness provides.

---

### Task 27: Confirm dialog and Deploy area UI

**Files:**
- Create: `apps/client/src/areas/deploy/ConfirmDialog.tsx`, `apps/client/src/areas/deploy/DeployArea.tsx`, `apps/client/src/areas/deploy/deploy.css`

**Interfaces:**
- Consumes: Task 17 (`ApiClient` deploy methods), Task 18 (everything in `state.ts`), plan 3 Task 22 (`ApiError`, `WsClient`), plan 3 Task 25 (`errorText` from `../build/TaskCard.js`), Task 2 (`shortSha`).
- Produces:

```tsx
export function ConfirmDialog(props: { card: ConfirmCard; onConfirm: (token: string) => Promise<void>; onCancel: () => void }): JSX.Element;
export function DeployArea(props: { app: string; api: ApiClient; ws: WsClient }): JSX.Element;
```

`ConfirmDialog` (`role="dialog"`, `aria-modal="true"`, `data-testid="confirm-dialog"`) shows:
- `<h2 data-testid="confirm-title">{card.title}</h2>`.
- When `card.sha` is set, the full SHA in `<code data-testid="confirm-sha">`.
- `<ul data-testid="confirm-commits">`, one `<li>` per commit: `` `${shortSha(c.sha)} ${c.subject}` ``. For a promote without commits it shows `No new commits.` instead.
- `<ul data-testid="confirm-migrations">`, one `<li>` per migration with the file name, plus a `contract` badge when `contract`. If any migration is a contract migration, it adds the line `Contract migrations remove old schema. Rolling back cannot undo them.`
- `<ul data-testid="confirm-servers">`, one `<li>` per server: `` `${key}: ${serverType} in ${location}, €${monthlyGross}/month` ``.
- `<p data-testid="confirm-expiry">This card expires in 5 minutes.</p>`.
- `<button data-testid="confirm-cancel">Cancel</button>`; Escape also cancels.
- `<button data-testid="confirm-ok">Confirm</button>`:
  - Its `onClick` returns at once unless `event.isTrusted`, so a script or a voice command cannot press it.
  - While pending it shows `Confirming…`.
  - At `card.expiresAt` (a `setTimeout`) it becomes disabled and reads `Expired`.
  - Errors from `onConfirm` show in `data-testid="confirm-error"` (via `errorText`).
- Nothing else submits it: no form element, and Enter does not confirm.

`DeployArea` (`data-testid="deploy-area"`), a scrollable column:
- **Loading and live updates:**
  - On mount, load `api.deployState(app)` → `applyDeployState`. Subscribe to `ws.on(m => setView(v => applyDeployMsg(v, app, m)))`.
  - A `deploy.update` for this app with a terminal status, or `ws.onStatus('open')`, triggers a fresh `deployState` load. That refreshes candidates and the rollback target.
  - Unsubscribe on unmount.
- **Problems:** `<ul data-testid="deploy-problems">`, one `<li>` per problem, shown when there are any.
- **Not adopted:** `<p data-testid="deploy-not-adopted">This app is not adopted yet, so it cannot deploy.</p>` when `!state.adopted`.
- **One section per env** (`data-testid="env-staging"` and `data-testid="env-production"`):
  - The `ENV_LABEL` heading, `data-testid="env-<env>-server"` with the server name, and `data-testid="env-<env>-summary"` with `envSummary(env)`.
  - When the URL is set: `<a data-testid="env-<env>-url" href={url} target="_blank" rel="noreferrer">{url}</a>`.
- **Staging:** `<button data-testid="deploy-staging">Deploy latest to staging</button>` calls `api.deployStaging(app)`. It is disabled while there are problems or a staging deploy is active.
- **Production:**
  - `<select data-testid="promote-sha">` with one option per candidate (value sha, label `` `${shortSha(sha)} ${subject}` ``). The newest is selected.
  - `<button data-testid="promote">Promote to production</button>` and `<p data-testid="promote-hint">`. When enabled, it calls `api.prepareProduction(app, 'promote', sha)` and opens the `ConfirmDialog`.
  - `<button data-testid="rollback">Roll back</button>` and `<p data-testid="rollback-hint">`. It calls `api.prepareProduction(app, 'rollback')`.
  - Both buttons follow `productionControls(state)`.
  - The dialog's `onConfirm(token)` calls `api.production(app, card.action as 'promote' | 'rollback', card.sha!, token)` and then closes it.
- **History:** `<ul data-testid="deploy-history">` with one `<li data-testid={`deploy-row-${id}`}>` per record. Each row shows `historyLabel(d)`, the local time of `createdAt`, and `d.error`.
  - Tapping a row toggles `<pre data-testid="deploy-logs">`, loaded with `api.deployLogs` and stored with `withLogs`. The active deploy's logs open automatically.
- **Errors** from any call show in `data-testid="deploy-error"`.
- `deploy.css` holds the styles: the shell's tablet sizing, touch targets of at least 44 px, monospace logs and a modal overlay.

- [ ] **Step 1: Implement** the three files. They have no unit tests: their logic lives in Task 18's tested helpers, and Task 40's Playwright test drives them.
- [ ] **Step 2: Run** `pnpm -F @hub/client typecheck && pnpm -F @hub/client build && pnpm -F @hub/client size`. Expected: clean, and under 150 000 bytes gzipped.
- [ ] **Step 3: Commit** as `feat(client): Deploy area with a tap-only confirm card`, with the attribution trailer your harness provides.

---

### Task 28: Move a stack and its database to another server

**Files:**
- Create: `apps/server/src/deploy/relocate.ts`
- Test: `apps/server/src/deploy/relocate.test.ts`

**Interfaces:**
- Consumes: Task 23 (`StackOps`, `StackError`), Task 5 (`SshRunner`, `FakeSsh`).
- Produces:

```ts
export interface MoveHandle { finish(): Promise<void>; abort(): Promise<void> }
export interface RelocateInput { from: StackOps; to: StackOps; ssh: SshRunner; currentTag: string; hasDb: boolean; log: (line: string) => void }
export const COPY_FAILED_MESSAGE = 'Copying the database to the new server failed.';
export function relocate(i: RelocateInput): Promise<MoveHandle>;
```

The caller has already run `to.prepare`, `to.login` and `to.pull`.

`relocate` steps:
1. `log(`Moving ${app} ${env} from ${from.target.host} to ${to.target.host}.`)`, then `to.writeSecrets(await from.readSecrets())`. The DB password stays the same, so the dump restores as-is.
2. With `hasDb`:
   1. `from.stopApp(currentTag)`. Writes stop, so the copy cannot miss data.
   2. `to.startDb(currentTag)`.
   3. `ssh.pipe({ host: from.target.host, command: from.command('exec -T db pg_dump -U app -d app --format=custom', currentTag) }, { host: to.target.host, command: to.command('exec -T db pg_restore -U app -d app --clean --if-exists --no-owner', currentTag) })`.
   4. A non-zero code → `from.startApp(currentTag)`, then throw `StackError(COPY_FAILED_MESSAGE, 'move')`.
   5. Otherwise log `'Database copied.'`.
3. Return a handle:
   - `finish()`: `from.removeSite()`, `from.down(currentTag)`, then log `` `Old stack stopped on ${from.target.host}; its data volume is kept there.` ``.
   - `abort()`: `from.startApp(currentTag)`.

- [ ] **Step 1: Write the failing tests** (`FakeSsh`, two `StackOps` on hosts `shared-staging.t.ts.net` and `shop-staging.t.ts.net`):
  - `copies secrets and the database, then stops the old stack on finish`: calls are made in order:
    1. `cat` secrets on the old host.
    2. Secrets written on the new host, with the same stdin.
    3. `stop app` on the old host.
    4. `up -d --wait db` on the new host.
    5. One pipe from `pg_dump` to `pg_restore`.
    6. After `finish()`: `rm -f '/etc/caddy/sites/shop-staging.caddy'` and `down` on the old host.
  - `a failed copy restarts the old app`: with `pipeResult.code 1` it rejects with `COPY_FAILED_MESSAGE`, and the last old-host call contains `up -d app`.
  - `without a database only secrets move`: no pipe and no `stop app`.
  - `abort restarts the old app`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/relocate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `relocate.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 pass.
- [ ] **Step 5: Commit** as `feat(server): move an app stack and its Postgres data to a new server`, with the attribution trailer your harness provides.

---

### Task 29: `AdoptService`

**Files:**
- Create: `apps/server/src/adopt/service.ts`
- Test: `apps/server/src/adopt/service.test.ts`

**Interfaces:**
- Consumes: Task 8 (`BuildService.send` with `seedFiles`), Task 10 (`ConfirmStore`, `DeployError`, `VOICE_CONFIRM_ERROR`, `CONFIRM_EXPIRED_ERROR`), Task 11 (`DeployStore.slot`), Task 12 (`SHARED_STAGING`, `SHARED_PRODUCTION`, `stagingUrl`, `productionUrl`), Task 22 (`ServerManager`), Task 24 (`provisionCard`, `provisionSubject`), Task 25 (`SetupRunStore`), Task 26 (`adoptManifest`, `adoptPrompt`, `packageManagerOf`), Task 3 (`imageFor`), Task 1 (`deployProblems`, `provisionProblems`), plan 3 Task 7 (`AppRegistry`), plan 3 Task 8 (`WsHub`).
- Produces:

```ts
export interface SetupDeps {   // shared by AdoptService (here), MoveService (Task 30) and NewAppService (Task 36)
  config: HubConfig; registry: Pick<AppRegistry, 'get'>; servers: ServerManager; runs: SetupRunStore;
  deploys: DeployStore; confirm: ConfirmStore; hub: WsHub; now?: () => number;
}
export interface AdoptDeps extends SetupDeps { build: Pick<BuildService, 'send'> }
export const SETUP_RUNNING_MESSAGE = 'Setup is already running for this app.';
export function publishRun(hub: WsHub, run: SetupRun): void;   // hub.broadcast({ type: 'setup.progress', run })
export function checkProvisionConfirm(d: SetupDeps, app: string, missing: string[], token: string | null, voice: boolean): void;
export class AdoptService {
  constructor(deps: AdoptDeps);
  plan(app: string): Promise<SetupPlan>;
  start(app: string, token: string | null, voice: boolean): Promise<SetupRun>;   // resolves once the run row exists
  idle(): Promise<void>;                                                          // resolves when background runs end (tests)
}
```

`checkProvisionConfirm` (also used by Tasks 30 and 36). With `missing` empty it does nothing. Otherwise:
- `voice` → `DeployError(VOICE_CONFIRM_ERROR, 403)`.
- A null token, or `!confirm.consume(token, app, 'provision', provisionSubject(missing))` → `DeployError(CONFIRM_EXPIRED_ERROR, 403)`.

`plan(app)`:
1. `entry = registry.get(app)`. Missing → `DeployError('Unknown app', 404)`. `entry.adopted` → `DeployError('This app is already adopted.', 409)`.
2. `problems = deployProblems(config)`.
3. `missing = servers.missing([SHARED_STAGING, SHARED_PRODUCTION])`. If any are missing, also add `provisionProblems(config)`.
4. `servers = missing.length && !problems.length ? await servers.quote(missing) : []`.
5. `confirm = servers.length ? provisionCard(confirm, app, servers) : null`.

`start(app, token, voice)`:
1. Recompute as in `plan`. Problems → `DeployError(problems.join(' '), 409)`.
2. `checkProvisionConfirm(...)`, then `runs.active(app)` → `DeployError(SETUP_RUNNING_MESSAGE, 409)`.
3. `run = runs.create('adopt', app)`, publish it, start the background work, and return the run.

Background work. Every `runs.update` is followed by `publishRun`.
1. Step `servers`: `ensure(SHARED_STAGING)`, then `ensure(SHARED_PRODUCTION)`. Each `onLog` line becomes the run's `detail`.
2. Step `task`:
   1. `slot = deploys.slot(app)`.
   2. `input = { name: app, image: imageFor(config.githubOwner!, app), stagingServer: SHARED_STAGING, stagingUrl: stagingUrl(SHARED_STAGING, config.tailnet!, slot), productionServer: SHARED_PRODUCTION, productionUrl: productionUrl(app, servers.get(SHARED_PRODUCTION)!.ipv4), packageManager: packageManagerOf(readdirSync(entry.dir)), hasPackageJson: existsSync(join(entry.dir, 'package.json')) }`.
   3. `task = await build.send(app, adoptPrompt(input), { seedFiles: { '.hub/app.json': JSON.stringify(adoptManifest(input), null, 2) + '\n' }, seedMessage: 'Add .hub/app.json for the Hub' })`.
   4. `setState({ taskId: task.id })`.
3. Done: `{ status: 'success', step: 'done', detail: `Build task #${task.id} is adding the convention. Review its pull request in Build.` }`.
4. Any error → `{ status: 'failed', error: e.message }`.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `appsDir` holds `makeTestRepo({ workDir: join(appsDir, 'demo') })` with no manifest.
    - Config: `githubToken 't'`, `githubOwner 'acme'`, `ghcrToken 'g'`, `ghcrUser 'acme'`, `tailnet 'tail1234.ts.net'`, `sshKeyPath` an existing temp file, `hcloudToken 'h'`, `tsAuthKey 'k'`, `agentUser 'hub-agent'`.
    - Infra: `ServerManager` over `FakeHetzner` and `FakeSsh` (ready → 0).
    - A fake `build` records `(app, text, opts)` and returns a task with id 7.
  - Tests:
    - `plan quotes the missing shared servers and issues a confirm card`: 2 quotes, `confirm.subject 'servers:shared-production,shared-staging'`.
    - `adopting needs the confirm token when servers must be created`: no token → 403 `CONFIRM_EXPIRED_ERROR`. A valid token with `voice` → 403 `VOICE_CONFIRM_ERROR`.
    - `adopt seeds the manifest and starts a Build task`: after `idle()`, the seed `.hub/app.json` parses with `deploy.staging.url 'http://shared-staging.tail1234.ts.net:8001'` and `deploy.production.url 'https://demo.203.0.113.5.sslip.io'`. The prompt contains `Image: ghcr.io/acme/demo.`, and the run is `success` at step `done`.
    - `no confirm is needed when the servers exist`: both servers are already ready in the store, and `start(app, null, false)` succeeds.
    - `an adopted app cannot be adopted again`: 409.
    - `progress is broadcast`: the hub saw `setup.progress` messages ending in `success`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/adopt/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** as `feat(server): Adopt starts a Build task seeded with the hub-written manifest`, with the attribution trailer your harness provides.

---

### Task 30: `MoveService` (promote an app to dedicated servers)

**Files:**
- Create: `apps/server/src/newapp/move.ts`
- Test: `apps/server/src/newapp/move.test.ts`

**Interfaces:**
- Consumes: Task 29 (`SetupDeps`, `publishRun`, `checkProvisionConfirm`, `SETUP_RUNNING_MESSAGE`), Task 22 (`dedicatedKey`), Task 12 (`stagingUrl`, `productionUrl`), Task 24 (`provisionCard`), Task 8 (`BuildService.send`).
- Produces:

```ts
export interface MoveDeps extends SetupDeps { build: Pick<BuildService, 'send'> }
export function movePrompt(env: DeployEnv, key: string): string;
// `The Hub moved this app's ${env} to its own server, ${key}, and updated .hub/app.json on this branch. Check that nothing else in the repo names the old server or URL (README, docs, config) and update it if it does. Change nothing else.`
export class MoveService {
  constructor(deps: MoveDeps);
  plan(app: string, env: DeployEnv): Promise<SetupPlan>;
  start(app: string, env: DeployEnv, token: string | null, voice: boolean): Promise<SetupRun>;
  idle(): Promise<void>;
}
```

`plan(app, env)`:
1. Missing app → 404 `'Unknown app'`. Not adopted → 409 `'Adopt this app before moving it.'`.
2. `key = dedicatedKey(app, env)`. If `manifest.deploy[env].server === key` → 409 `` `${app} ${env} already runs on its own server.` ``.
3. `problems = [...deployProblems, ...provisionProblems]` (only when `key` is missing). `servers = quote([key])` when it is missing and there are no problems. `confirm = provisionCard(...)` when quotes exist.

`start` follows `AdoptService.start` (problems, `checkProvisionConfirm`, single active run, `runs.create('move', app)`). Background work:
1. Step `servers`: `ensure(key)`.
2. Step `manifest`:
   1. `slot = deploys.slot(app)`.
   2. `next = structuredClone(manifest)` with `deploy[env] = { ...deploy[env], server: key, url: env === 'staging' ? stagingUrl(key, tailnet, slot) : productionUrl(app, servers.get(key)!.ipv4) }`. Production keeps its `domain`.
   3. `build.send(app, movePrompt(env, key), { seedFiles: { '.hub/app.json': JSON.stringify(next, null, 2) + '\n' }, seedMessage: `Move ${env} to ${key}` })`.
3. Done: `{ status: 'success', step: 'done', detail: `Merge the pull request in Build. The next ${env} deploy moves the stack, its database and its route to ${key}.` }`.

- [ ] **Step 1: Write the failing tests** (Task 29's setup; `demo` has the template-style manifest on the shared servers):
  - `plan quotes the dedicated server`: `servers[0].key === 'demo-staging'`, and the confirm subject is `'servers:demo-staging'`.
  - `move needs a confirm token and never accepts voice`.
  - `move creates the server and seeds the new manifest`: the seed manifest has `staging.server 'demo-staging'` and `staging.url 'http://demo-staging.tail1234.ts.net:8001'`, and the seed message is `'Move staging to demo-staging'`.
  - `a production move keeps the domain`: a manifest with `domain 'demo.example.com'` keeps it.
  - `apps that are not adopted, or already moved, are refused`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/move.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `move.ts`.
- [ ] **Step 4: Run** the same command. Expected: 5 pass.
- [ ] **Step 5: Commit** as `feat(server): move an app to dedicated servers through a manifest pull request`, with the attribution trailer your harness provides.

---

### Task 31: Live Hetzner integration test (manual trigger)

**Files:**
- Create: `apps/server/src/infra/live.test.ts`, `.github/workflows/deploy-live.yml`
- Test: `apps/server/src/infra/live-workflow.test.ts`

**Interfaces:**
- Consumes: Task 4 (`HttpHetzner`, `HETZNER_API`), Task 5 (`OpenSshRunner`, `readPublicKey`), Task 11 (`openDb` with the `servers` table), Task 12 (`siteConfig`), Task 21 (the template's `compose.yml` and image), Task 22 (`ServerManager`, `ServerStore`), Task 23 (`StackOps`).
- Produces: spec §12's "integration test against a throwaway Hetzner server (manual trigger)".

`live.test.ts` is `describe.skipIf(!process.env.HUB_LIVE_HCLOUD_TOKEN)` with a single `it(…, 2_400_000)`. It reads these env vars:
- `HUB_LIVE_HCLOUD_TOKEN`, `HUB_LIVE_GHCR_USER`, `HUB_LIVE_GHCR_TOKEN`, `HUB_LIVE_IMAGE`, `HUB_LIVE_TAG`
- `HUB_LIVE_LOCATION` (default `nbg1`)

Steps:
1. `run = Date.now().toString(36)`, `key = `live${run}-staging``, and an ed25519 key from `ssh-keygen -q -t ed25519 -N '' -f <tmp>/key`.
2. `servers = new ServerManager({ store: new ServerStore(openDb(':memory:')), hetzner: new HttpHetzner(token), ssh: new OpenSshRunner({ keyPath, knownHostsPath: join(tmp, 'known_hosts') }), config: { tailnet: null, hcloudLocation, tsAuthKey: null, acmeEmail: null }, publicKey: () => readPublicKey(keyPath), publicSsh: true, sshKeyName: `hub-live-${run}`, firewallPrefix: `hub-live-${run}` })`.
3. `rec = await servers.ensure(key, console.log)`. Expect `rec.readyAt` to be set.
4. Build `stack = new StackOps({ ssh, ghcrUser, ghcrToken, log: console.log }, { app: `live${run}`, env: 'staging', host: rec.ipv4, image, slot: 1 })`. Then run, in order: `prepare(<template compose.yml>)`, `writeSite(siteConfig({ app, env: 'staging', slot: 1, ipv4: rec.ipv4, domain: null }))`, `login()`, `pull(tag)`, `startDb(tag)`, `migrate(tag)` and `swap(tag)`.
5. Expect:
   - `health(tag)` and `smoke(tag)` are true.
   - `ssh.exec(rec.ipv4, 'curl -fsS http://127.0.0.1:8001/api/health')` stdout contains `tag` (through Caddy).
   - `ssh.exec(rec.ipv4, 'ufw status')` contains `Status: active`.
6. `afterAll` (always runs): delete the server with `hetzner.deleteServer`. Then use raw `fetch` against `HETZNER_API` to delete the firewall `hub-live-${run}-staging` and the SSH key `hub-live-${run}`. Retry each delete up to 10 times, 5 s apart, while Hetzner still reports it in use.

`.github/workflows/deploy-live.yml` (exact):

```yaml
name: deploy-live
on: workflow_dispatch
permissions:
  contents: read
  packages: write
jobs:
  live:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Image name
        env:
          OWNER: ${{ github.repository_owner }}
        run: echo "HUB_LIVE_IMAGE=ghcr.io/${OWNER,,}/hub-live-app" >> "$GITHUB_ENV"
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v7
        with:
          context: templates/vite-hono-pg
          push: true
          tags: ${{ env.HUB_LIVE_IMAGE }}:${{ github.sha }}
          build-args: APP_SHA=${{ github.sha }}
      - run: pnpm -F @hub/server exec vitest run src/infra/live.test.ts
        env:
          HUB_LIVE_HCLOUD_TOKEN: ${{ secrets.HUB_LIVE_HCLOUD_TOKEN }}
          HUB_LIVE_GHCR_USER: ${{ github.actor }}
          HUB_LIVE_GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HUB_LIVE_TAG: ${{ github.sha }}
```

- [ ] **Step 1: Write the failing test** `live-workflow.test.ts`:
  - `the live test only runs by hand`: `YAML.parse(workflow).on` equals `'workflow_dispatch'`.
  - `it builds the template image and runs the live test`: there is a step with `context: templates/vite-hono-pg`, and the last step's `run` is `pnpm -F @hub/server exec vitest run src/infra/live.test.ts` with `HUB_LIVE_HCLOUD_TOKEN` taken from `secrets.HUB_LIVE_HCLOUD_TOKEN`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/infra/live-workflow.test.ts src/infra/live.test.ts`. Expected: the workflow test FAILs and the live test is skipped.
- [ ] **Step 3: Create** both files.
- [ ] **Step 4: Run** the same command. Expected: 2 pass, 1 skipped. The real run happens by hand (Actions → deploy-live → Run workflow) once the repo secret `HUB_LIVE_HCLOUD_TOKEN` is set. It costs a few cents and deletes everything it created.
- [ ] **Step 5: Commit** as `test(server): manual live Hetzner deploy test and workflow`, with the attribution trailer your harness provides.

---

### Task 32: New app page, Adopt and Move panels, and the `#/new` route

**Files:**
- Create: `apps/client/src/areas/deploy/SetupView.tsx`
- Modify: `apps/client/src/shell/route.ts`, `apps/client/src/shell/App.tsx`
- Test: `apps/client/src/shell/route.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 17 (`ApiClient` setup methods), Task 19 (`stepRows`, `applySetupMsg`, `quoteSummary`, `nameProblem`), Task 27 (`ConfirmDialog`), plan 3 Tasks 23 and 27 (`Route`, `parseHash`, `formatRoute`, `App`).
- Produces:

```tsx
// route.ts: Route gains { name: 'new' }; parseHash('#/new') → { name: 'new' }; formatRoute({ name: 'new' }) → '#/new'
export function NewAppPage(props: { api: ApiClient; ws: WsClient }): JSX.Element;
export function AdoptPanel(props: { app: string; api: ApiClient; ws: WsClient }): JSX.Element;
export function MovePanel(props: { app: string; env: DeployEnv; api: ApiClient; ws: WsClient }): JSX.Element;
export function SetupProgress(props: { run: SetupRun }): JSX.Element;
```

`SetupProgress` (`data-testid="setup-progress"`):
- `<ol>` with one `<li data-testid={`setup-step-${step}`} data-state={state}>{label}</li>` per `stepRows(run)` row.
- `run.detail` in `data-testid="setup-detail"` and `run.error` in `data-testid="setup-error"`.
- When `run.url` is set: `<a data-testid="setup-url" href={run.url} target="_blank" rel="noreferrer">{run.url}</a>`.

The three flows share one pattern:
1. Plan, showing `<ul data-testid="setup-problems">` and `<p data-testid="setup-quote">{quoteSummary(plan.servers)}</p>` when not empty.
2. Start: open `ConfirmDialog` with `plan.confirm` when it is set and pass its token; otherwise start without one.
3. Show `SetupProgress`, updated through `ws.on(m => setRun(r => applySetupMsg(r, m)))`.
4. A failed run shows `<button data-testid="setup-retry">Try again</button>`, which plans again.
5. Errors show in `data-testid="setup-error-message"`.

`NewAppPage` (`data-testid="new-app"`, routed at `#/new`):
- `<a href="#/" data-testid="new-app-back">All apps</a>` and the heading `New app`.
- `<input data-testid="newapp-name" placeholder="myapp" autocapitalize="off">`.
- `<p data-testid="newapp-name-problem">` shows `nameProblem` for non-empty input.
- `<button data-testid="newapp-check">Continue</button>` calls `newAppPlan`.
- `<button data-testid="newapp-create">Create app</button>` is enabled when the plan has no problems. It calls `newApp(name, token?)`.
- On success: `<a data-testid="newapp-open" href={formatRoute({ name: 'app', app: name, area: 'deploy' })}>Open {name}</a>`.

`AdoptPanel` (`data-testid="adopt-panel"`):
- `<button data-testid="adopt-start">Adopt this app</button>` runs `adoptPlan`.
- `<button data-testid="adopt-confirm">Adopt</button>` starts it.
- On success: `<a data-testid="adopt-open-build" href={formatRoute({ name: 'app', app, area: 'build' })}>Open Build</a>`.

`MovePanel` (`data-testid={`move-panel-${env}`}`):
- `<button data-testid={`move-${env}`}>Move to its own server</button>` runs `movePlan`.
- `<button data-testid={`move-${env}-confirm`}>Move</button>` starts it.

`App.tsx` renders `<NewAppPage api={api} ws={ws} />` for `route.name === 'new'`.

- [ ] **Step 1: Write the failing tests** in `route.test.ts`: `'#/new'` parses to `{ name: 'new' }`, `formatRoute({ name: 'new' })` is `'#/new'`, and `'#/news'` still parses to `{ name: 'apps' }`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/shell/route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route change, `SetupView.tsx` and the `App.tsx` branch.
- [ ] **Step 4: Run** `pnpm -F @hub/client exec vitest run && pnpm -F @hub/client typecheck && pnpm -F @hub/client build && pnpm -F @hub/client size`. Expected: all pass, under budget.
- [ ] **Step 5: Commit** as `feat(client): New app page, Adopt and Move panels with setup progress`, with the attribution trailer your harness provides.

---

### Task 33: The deploy pipeline

**Files:**
- Create: `apps/server/src/deploy/pipeline.ts`
- Test: `apps/server/src/deploy/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 10 (`DeployError`), Task 11 (`DeployStore`, test only), Task 12 (`siteConfig`), Task 13 (`checkComposeContract`, `composeServices`), Task 14 (`AppGit`, `FakeAppGit`), Task 22 (`ServerManager`, `ServerStore`), Task 23 (`StackOps`, `StackTarget`), Task 28 (`relocate`, `MoveHandle`), Task 5 (`SshRunner`, `FakeSsh`), Task 2 (`DeployRecord`, `shortSha`), plan 3 Task 1 (`parseAppManifest`, `AppManifest`).
- Produces:

```ts
export interface DeployFiles { manifest: AppManifest; compose: string; services: string[] }
export function readDeployFiles(git: AppGit, dir: string, sha: string): Promise<DeployFiles>;
export interface PipelineDeps {
  servers: Pick<ServerManager, 'get' | 'ready' | 'host'>; ssh: SshRunner; ghcrUser: string; ghcrToken: string;
  log: (line: string) => void; sleep?: (ms: number) => Promise<void>; healthAttempts?: number /* 30 */; healthDelayMs?: number /* 2000 */;
}
export interface PipelineInput { deploy: DeployRecord; files: DeployFiles; slot: number; previous: DeployRecord | null }
export interface PipelineResult { status: 'success' | 'failed' | 'rolled_back'; testsOk: boolean; error: string | null }
export type Pipeline = (deps: PipelineDeps, input: PipelineInput) => Promise<PipelineResult>;
export const runPipeline: Pipeline;
```

`readDeployFiles` errors are all `DeployError(…, 409)`, with `s = shortSha(sha)`:
- `` `.hub/app.json is missing at ${s}.` ``
- `` `.hub/app.json at ${s}: ${error}` ``
- `` `compose.yml is missing at ${s}.` ``
- `` `compose.yml at ${s}: ${problems.join('; ')}` ``

`runPipeline`. `previous` is the env's current successful deploy, or `null`. `make(t)` builds a `StackOps` with `{ ssh, ghcrUser, ghcrToken, log, sleep }`. `s` and `p` are short SHAs. The new version is never left serving after a failed check.

```ts
const server = servers.get(d.serverKey);
if (!server || !servers.ready(d.serverKey)) return failed(`Server ${d.serverKey} is not ready. Create it with New app or Move first.`);
const stack = make({ app, env, host: servers.host(d.serverKey), image: d.image, slot });
const moving = previous !== null && previous.serverKey !== d.serverKey;
const hasDb = files.services.includes('db');
let handle: MoveHandle | null = null; let swapped = false;
try {
  log(`Deploying ${s} to ${d.serverKey}.`);
  await stack.prepare(files.compose);
  await stack.writeSite(siteConfig({ app, env, slot, ipv4: server.ipv4, domain: env === 'production' ? files.manifest.deploy.production.domain : null }));
  await stack.login();
  await stack.pull(d.sha);
  if (hasDb) await stack.startDb(d.sha);
  if (moving) handle = await relocate({ from: make({ app, env, host: servers.host(previous.serverKey), image: previous.image, slot }), to: stack, ssh, currentTag: previous.sha, hasDb, log });
  await stack.migrate(d.sha);
  swapped = true;
  await stack.swap(d.sha);
  if (!(await stack.health(d.sha, attempts, delay))) return recover(`Health check failed on ${s}`);
  if (!(await stack.smoke(d.sha))) return recover(`Smoke tests failed on ${s}`);
  if (handle) await handle.finish();
  log(`${s} is live on ${env}.`);
  return { status: 'success', testsOk: true, error: null };
} catch (e) {
  if (swapped) return recover(message(e));
  await handle?.abort().catch(logIt);
  return failed(message(e));                       // the running version was never touched
}
```

`recover(reason)` runs `stack.logsTail(d.sha)` (errors ignored), then:
- `moving` → `stack.stopApp(d.sha)` (errors ignored) and `handle.abort()`. Return `rolled_back` with `` `${reason}; ${env} stays on ${previous.serverKey}.` ``.
- `previous` exists → log `` `Restoring ${p}.` ``. Run `swap(previous.sha)` on a stack for `previous.image`, then `health(previous.sha)`.
  - Healthy → `rolled_back` with `` `${reason}; ${p} is running again.` ``.
  - Otherwise, or on a throw → `failed` with `` `${reason}, and ${p} did not come back either.` ``.
- First deploy → `stack.stopApp(d.sha)` (errors ignored) and return `failed` with `` `${reason}.` ``.

`failed(msg)` is `{ status: 'failed', testsOk: false, error: msg }`. Every `PipelineResult` that is not a success has `testsOk: false`.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `FakeSsh` plus a helper `followSwaps(ssh)`. It records the `APP_TAG` of each `up -d --wait --wait-timeout 120 app` per host, and answers `/api/health` with `{"ok":true,"sha":<that tag>}`.
    - A real `ServerManager` (hetzner `null`) whose `ServerStore` holds ready `shared-staging` (`203.0.113.1`), `shared-production` (`203.0.113.2`) and `shop-staging` (`203.0.113.9`). `tailnet` is `'t.ts.net'`.
    - `FakeAppGit` with the template's rendered manifest and `VALID_COMPOSE`.
    - `healthAttempts 2`, `healthDelayMs 0`, `sleep` stub.
  - Tests:
    1. `readDeployFiles needs a valid manifest and the compose contract`.
    2. `readDeployFiles reports a missing compose.yml`.
    3. `deploys in order`: the first matching call indexes of these fragments are strictly increasing:
       1. `install -d -m 700`
       2. `compose.yml.tmp`
       3. `caddy validate`
       4. `docker login`
       5. `pull app`
       6. `up -d --wait db`
       7. `run --rm migrate`
       8. `.env.tmp`
       9. `up -d --wait --wait-timeout 120 app`
       10. `/api/health`
       11. `run --rm smoke`
    4. `first deploy succeeds and records tests`: `{ status: 'success', testsOk: true, error: null }`.
    5. `failed health rolls back to the previous sha`: health answers the wrong sha for the new tag. The result is `rolled_back` with the exact message, and the last `app` start uses `APP_TAG='<previous sha>'`.
    6. `first deploy with failing health just fails`: `failed`, `'Health check failed on aaaaaaa.'`, and a `stop app` call.
    7. `failed migrations keep the old version running`: no `.env.tmp` write and no app start.
    8. `failed smoke tests restore the previous version`.
    9. `failed smoke tests on a first deploy stop it`.
    10. `a Caddy rejection fails before anything changes`: no `pull app` call.
    11. `production site uses sslip and the manifest domain`: the `writeSite` stdin contains `shop.203.0.113.2.sslip.io, shop.example.com {`.
    12. `a server that is not ready fails the deploy`: no ssh calls.
    13. `moving relocates the database and stops the old stack after success`: one pipe, then `down` on `shared-staging.t.ts.net`.
    14. `a failed move keeps the old server running`: `pipeResult.code 1` → `failed` with `COPY_FAILED_MESSAGE`, and `up -d app` on the old host.
    15. `the registry token never appears in commands or log lines`: token `'ghcr-secret'`. No `ssh.calls[i].command` and no logged line contains it.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `pipeline.ts`.
- [ ] **Step 4: Run** the same command. Expected: 15 pass.
- [ ] **Step 5: Commit** as `feat(server): deploy pipeline with health check, smoke tests and automatic rollback`, with the attribution trailer your harness provides.

---

### Task 34: `DeployService`

**Files:**
- Create: `apps/server/src/deploy/service.ts`
- Test: `apps/server/src/deploy/service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`HubConfig`, `deployProblems`), Task 2 (DTOs), Task 6 (`ImageRegistry`, `FakeRegistry`), Task 10 (`ConfirmStore`, `DeployError`, `VOICE_CONFIRM_ERROR`, `CONFIRM_EXPIRED_ERROR`), Task 11 (`DeployStore`), Task 13 (`checkComposeContract`), Task 14 (`AppGit`, `FakeAppGit`), Task 22 (`ServerManager`), Task 24 (`promoteCard`, `rollbackCard`, `notCandidateMessage`), Task 33 (`readDeployFiles`, `runPipeline`, `Pipeline`), and plan 3 Tasks 7 (`AppRegistry`), 8 (`WsHub`) and 12 (`GitHub`, `FakeGitHub`, `FAILED_CONCLUSIONS`), and Task 8 (`readCheckoutFile`, `CheckoutPathError`).
- Produces:

```ts
export const CI_POLL_MS = 30_000;
export const CI_TIMEOUT_MS = 3_600_000;
export const PRODUCTION_BUSY = 'A production deploy is already running.';
export const INTERRUPTED_DEPLOY_ERROR = 'Interrupted because the Hub restarted. Deploy again.';
export interface DeployServiceDeps {
  config: HubConfig; store: DeployStore; registry: Pick<AppRegistry, 'get'>; git: AppGit; github: GitHub | null;
  images: ImageRegistry | null; servers: ServerManager; ssh: SshRunner; confirm: ConfirmStore; hub: WsHub;
  now?: () => number; sleep?: (ms: number) => Promise<void>; ciPollMs?: number; ciTimeoutMs?: number;
  healthAttempts?: number; healthDelayMs?: number; pipeline?: Pipeline;
}
export class DeployService {
  constructor(deps: DeployServiceDeps);
  state(app: string): Promise<DeployState>;
  logs(app: string, deployId: number, after?: number): DeployLogLine[];   // 404 'Deploy not found' unless the deploy belongs to app
  onMerged(e: { app: string; sha: string }): void;                        // BuildDeps.onMerged adapter
  deployStaging(app: string, opts?: { sha?: string; actor?: DeployActor }): Promise<DeployRecord>;
  prepareProduction(app: string, action: 'promote' | 'rollback', sha?: string): Promise<ConfirmCard>;
  production(app: string, req: ProductionRequest, voice: boolean): Promise<DeployRecord>;
  recover(): number;          // running rows → failed INTERRUPTED_DEPLOY_ERROR; returns the count
  resumeWaiting(): number;    // restarts the CI wait of every waiting_ci row; returns the count
  idle(app?: string): Promise<void>;
  stopAll(): Promise<void>;   // ends CI waits (rows stay waiting_ci for resumeWaiting) and awaits running work
}
```

Shared rules:
- `publish(rec)` → `hub.broadcast({ type: 'deploy.update', app, deploy: rec })`.
- `log(id, text)` replaces every occurrence of `config.ghcrToken` with `***`, then calls `store.addLog`, then broadcasts `{ type: 'deploy.log', app, line }`.
- Work for one `(app, env)` runs strictly one at a time, chained on a promise per key. `idle(app)` awaits that app's chains and CI waits.
- The default `sleep` is a timer that `stopAll` cancels.

`deployStaging(app, { sha, actor = 'user' })`:
1. Unknown app → 404 `'Unknown app'`. Not adopted → 409 `'This app is not adopted yet, so it cannot deploy.'`. `deployProblems(config)` → 409 with the problems joined by `' '`.
2. `git.fetch(dir)`, then `full = sha ? git.resolve(dir, sha) : git.resolve(dir, `origin/${await git.defaultBranch(dir)}`)`. `null` → 409 `` `Unknown commit ${sha ?? 'on the default branch'}` ``.
3. `files = readDeployFiles(git, dir, full)`.
4. Supersede: every `waiting_ci` staging row of the app becomes `canceled` with error `` `Superseded by ${shortSha(full)}.` `` and is published.
5. `rec = store.create({ app, env: 'staging', kind: 'deploy', sha: full, image: files.manifest.deploy.image, serverKey: files.manifest.deploy.staging.server, actor, status: 'waiting_ci', previousSha: store.current(app, 'staging')?.sha ?? null })`. Publish it, start `waitAndRun(rec.id, dir)` in the background, and return `rec`.

`waitAndRun(id, dir)`, the CI wait:

```ts
const start = now(); let notedImage = false;
for (;;) {
  const rec = store.get(id)!; if (rec.status !== 'waiting_ci' || stopping) return;
  try {
    const ref = await git.repoRef(dir);
    const ci = ref && github ? await github.checkStatus(ref, rec.sha) : null;
    if (ci?.state === 'failure') return finish(id, 'failed', false, `CI failed on ${s}: ${failedNames(ci).join(', ')}`);
    if (ci?.state === 'success') {
      if (await images!.hasTag(rec.image, rec.sha)) break;
      if (!notedImage) { log(id, 'CI is green; waiting for the image to be pushed.'); notedImage = true; }
    }
  } catch (e) { log(id, `Could not check CI yet: ${message(e)}`); }
  if (now() - start >= ciTimeoutMs) return finish(id, 'failed', false, `CI did not finish for ${s} within 60 minutes.`);
  await sleep(ciPollMs);
}
// CI is green and the image exists:
store.update(id, { ciOk: true }); enqueue(app, 'staging', () => runDeploy(id, dir));
```

`runDeploy(id, dir)`:
1. Re-read the row and skip it unless it is `waiting_ci` or `running`.
2. Set `previous = store.current(app, env)`, then update `{ status: 'running', startedAt: now(), previousSha: previous?.sha ?? null }` and publish.
3. `files = readDeployFiles(git, dir, rec.sha)` and `slot = store.slot(app)`.
4. `result = await pipeline({ servers, ssh, ghcrUser, ghcrToken, log: t => log(id, t), sleep, healthAttempts, healthDelayMs }, { deploy: rec, files, slot, previous })`.
5. Update `{ status: result.status, testsOk: result.testsOk, error: result.error, finishedAt: now() }` and publish. A throw is recorded as `failed` with its message.

`onMerged({ app, sha })` ignores the merge, with a `console.log` naming the reason, when `sha` does not match `/^[0-9a-f]{40}$/`, the app is unknown or not adopted, or `deployProblems` is non-empty. Otherwise it calls `deployStaging(app, { sha, actor: 'merge' })` and catches errors with `console.warn`.

`prepareProduction(app, action, sha)`:
1. Run the same app checks as `deployStaging`.
2. An active production row → 409 `PRODUCTION_BUSY`.
3. `promote`: `sha` must match `/^[0-9a-f]{40}$/` (400 `'Bad sha'`). `files = readDeployFiles(git, dir, sha)`, then `promoteCard(d, app, dir, sha, files.manifest.deploy.production.server)`.
4. `rollback`: `rollbackCard(d, app, dir)`.

`production(app, { action, sha, token }, voice)`, checked in this order:
1. `voice` → 403 `VOICE_CONFIRM_ERROR`. The token is not consumed.
2. `sha` not 40-hex → 400 `'Bad sha'`.
3. App checks as above.
4. `!confirm.consume(token, app, action, sha)` → 403 `CONFIRM_EXPIRED_ERROR`.
5. Active production row → 409 `PRODUCTION_BUSY`.
6. `promote`: `staged = store.stagingPassed(app, sha)` → `null` → 409 `notCandidateMessage(sha)`. Use `image = staged.image`.
7. `rollback`: `target = store.rollbackTarget(app)`. `!target || target.sha !== sha` → 409 `'The rollback target changed. Open the card again.'`. Use `image = target.image`.
8. `files = readDeployFiles(git, dir, sha)`.
9. Create `{ env: 'production', kind: action, sha, image, serverKey: files.manifest.deploy.production.server, actor: 'user', status: 'running', ciOk: true, previousSha: current?.sha ?? null }`. Publish it, `enqueue(app, 'production', () => runDeploy(id, dir))`, and return the row.

`state(app)`:
1. Unknown app → 404.
2. `problems`:
   - Not adopted → `[entry.manifestError ?? 'This app has no .hub/app.json yet. Adopt it to deploy.']`.
   - Adopted → `deployProblems(config)`, then the working tree's `'Dockerfile is missing.'`, `'compose.yml is missing.'` or each `` `compose.yml: ${problem}` ``, then `'.github/workflows/ci.yml is missing.'`. The hub reads the working tree's `compose.yml` with `readCheckoutFile` (Task 8), and a `CheckoutPathError` counts as `'compose.yml is missing.'`.
3. Each `EnvState` has:
   - `server` and `url` from the manifest (`null` when not adopted);
   - `current = store.current`;
   - `active` = the newest row of `store.active(app, env)`.
4. `candidates` come from `store.candidates(app)`, each with `subject = (await git.commitsBetween(dir, null, sha, 1))[0]?.subject ?? ''`.
5. `rollbackTo = store.rollbackTarget(app)` and `history = store.history(app)`.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `appsDir` with an adopted `shop` checkout. The test writes `.hub/app.json`, `Dockerfile`, `compose.yml` (`VALID_COMPOSE`) and `.github/workflows/ci.yml` into a `makeTestRepo` work dir.
    - `FakeAppGit` (head `'a'.repeat(40)`, files with that manifest and compose) and `FakeGitHub`.
    - `FakeRegistry`, `ConfirmStore` with a mutable clock, and a full config: every value `deployProblems` checks, including `agentUser`.
    - A fake `pipeline` that records inputs and returns a scripted result.
    - A `sleep` stub that runs a per-test hook, so the test controls CI and the registry between polls. `ciPollMs 1`.
  - Tests:
    1. `a merge deploys the merge sha to staging after CI and the image are ready`: the row goes `waiting_ci` → `running` → `success`, with `ciOk` and `testsOk` true and `actor 'merge'`.
    2. `keeps waiting while CI is green but the image is not pushed yet`: checks are green from the start, and the registry gains the tag only on the 3rd poll. The pipeline runs exactly once, after that poll, and the log has `'CI is green; waiting for the image to be pushed.'` exactly once.
    3. `red CI fails the deploy without touching servers`: `setChecks(sha, [{ name: 'ci', status: 'completed', conclusion: 'failure' }])` → `failed`, `'CI failed on aaaaaaa: ci'`, and the pipeline is not called.
    4. `a newer merge supersedes a waiting deploy`.
    5. `merges with a non-sha or an app that is not adopted are skipped`: `onMerged({ app: 'shop', sha: 'merged-1' })` creates no row.
    6. `CI that never reports times out`: no checks, `ciTimeoutMs 5` with a clock advanced by `sleep` → the exact timeout message.
    7. `promote needs a valid confirm token`:
       - A random token → 403 `CONFIRM_EXPIRED_ERROR`.
       - A token for another sha → 403.
       - A valid one → `kind 'promote'`, with the image taken from the staging row.
       - A replay → 403.
    8. `voice can never promote`: a valid token with `voice` → 403 `VOICE_CONFIRM_ERROR`. The same token then works without `voice`.
    9. `only shas that passed staging can be promoted`: `prepareProduction` → 409 `notCandidateMessage(sha)`.
    10. `rollback redeploys the previous production image`.
    11. `one production deploy at a time`: `PRODUCTION_BUSY`.
    12. `deploys of one app and env run one at a time`: two staging deploys, with the first pipeline held on a deferred promise. The second pipeline starts only after the first resolves.
    13. `state reports problems for apps that cannot deploy`: an app that is not adopted, and an adopted app without a `Dockerfile`.
    14. `state lists candidates and the rollback target`.
    15. `recover fails running deploys and resumes waiting ones`.
    16. `deploy updates and log lines are broadcast, with the registry token redacted`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`.
- [ ] **Step 4: Run** the same command. Expected: 16 pass.
- [ ] **Step 5: Commit** as `feat(server): DeployService (staging on merge, SHA-pinned promote, rollback)`, with the attribution trailer your harness provides.

---

### Task 35: Deploy routes

**Files:**
- Create: `apps/server/src/deploy/routes.ts`
- Test: `apps/server/src/deploy/routes.test.ts`

**Interfaces:**
- Consumes: Task 34 (`DeployService` method types), Task 10 (`DeployError`, `isVoiceOrigin`), Task 2 (`HUB_ORIGIN_HEADER`, DTOs).
- Produces:

```ts
export type DeployApi = Pick<DeployService, 'state' | 'logs' | 'deployStaging' | 'prepareProduction' | 'production'>;
export function deployRoutes(deploy: DeployApi): Hono;   // mounted at /api/apps
```

Routes. A body that is not JSON counts as `{}`.
- `GET /:app/deploy` → `c.json(await deploy.state(app))`.
- `GET /:app/deploy/:id/logs?after=N`:
  - `id` must be a positive integer, else 400 `{ error: 'Bad deploy id' }`. `after` is used only when it is an integer ≥ 0.
  - Responds `{ lines }`.
- `POST /:app/deploy/staging`, body `{ sha? }`:
  - A non-string `sha` → 400 `'sha must be a string'`.
  - Responds 202 `{ deploy: await deploy.deployStaging(app, { sha, actor: 'user' }) }`.
- `POST /:app/deploy/production/prepare`, body `{ action, sha? }`:
  - An `action` other than `promote`/`rollback` → 400 `'action must be promote or rollback'`.
  - Responds `{ card }`.
- `POST /:app/deploy/production`, body `{ action, sha, token }`:
  - The same `action` check, then a missing string `sha` → 400 `'sha is required'`, then a missing string `token` → 400 `'token is required'`.
  - `voice = isVoiceOrigin(c.req.header(HUB_ORIGIN_HEADER))`.
  - Responds 202 `{ deploy: await deploy.production(app, { action, sha, token }, voice) }`.

- [ ] **Step 1: Write the failing tests.** Use a fake `DeployApi` that records its arguments. Mount it as `new Hono().route('/api/apps', deployRoutes(fake))` with `onError((e, c) => e instanceof DeployError ? c.json({ error: e.message }, e.status) : c.json({ error: 'Internal error' }, 500))`.
  - `GET deploy returns the state`.
  - `production passes the voice header through`: `x-hub-origin: voice` → the fake receives `voice === true`. A fake that throws `DeployError(VOICE_CONFIRM_ERROR, 403)` → 403 with that message.
  - `production needs action, sha and token`: three 400s with the exact messages.
  - `logs need an integer id`: `abc` → 400, and `after=5` is passed as 5.
  - `staging accepts an optional sha`: 202, and `actor 'user'` is passed.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/deploy/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `routes.ts`.
- [ ] **Step 4: Run** the same command. Expected: 5 pass.
- [ ] **Step 5: Commit** as `feat(server): deploy HTTP routes; voice-marked requests cannot confirm`, with the attribution trailer your harness provides.

---

### Task 36: `NewAppService`

**Files:**
- Create: `apps/server/src/newapp/service.ts`
- Test: `apps/server/src/newapp/service.test.ts`

**Interfaces:**
- Consumes: Task 3 (`readTemplate`, `renderTemplate`, `imageFor`, `TEMPLATE_NAME`, `TEMPLATE_ID`), Task 7 (`createRepo`, `getRepo`, `repoExistsMessage`, `FakeGitHub.repos`), Task 12 (`SHARED_STAGING`, `SHARED_PRODUCTION`, `stagingUrl`, `productionUrl`, `siteConfig`), Task 21 (the template), Task 22 (`ServerManager`, `SHARED_SERVERS`), Task 23 (`StackOps`), Task 25 (`SetupRunStore`, `bootstrapRepo`), Task 29 (`SetupDeps`, `publishRun`, `checkProvisionConfirm`, `SETUP_RUNNING_MESSAGE`), Task 34 (`DeployService.deployStaging`), Task 1 (`deployProblems`, `provisionProblems`), plan 3 Task 1 (`APP_NAME_RE`), Task 42 (`Checkouts`, plus `plainCheckouts` in tests).
- Produces:

```ts
export const NEW_APP_NAME_HINT = 'Use 2–40 lowercase letters, digits and dashes, starting with a letter.';
export interface NewAppDeps extends SetupDeps {
  github: GitHub | null; ssh: SshRunner; deploy: Pick<DeployService, 'deployStaging'>;
  checkouts: Pick<Checkouts, 'clone'>;                    // Task 42: the app's checkout, through its mirror in production
  identity?: GitIdentity;
  remoteUrl?: (owner: string, name: string) => string;   // default `https://github.com/${owner}/${name}.git`
  sleep?: (ms: number) => Promise<void>;                  // between deploy status checks; default a 1000 ms timer
}
export class NewAppService {
  constructor(deps: NewAppDeps);
  plan(name: string): Promise<SetupPlan>;
  start(name: string, token: string | null, voice: boolean): Promise<SetupRun>;
  runs(): SetupRun[];          // runs.list()
  idle(): Promise<void>;
}
```

`plan(name)` problems, in order:
1. `!APP_NAME_RE.test(name)` → `NEW_APP_NAME_HINT` (return at once).
2. `resumable = runs.latest(name, 'new')?.status === 'failed'`. If not resumable and `registry.get(name)` exists → `` `An app named ${name} already exists on the Hub.` ``.
3. `deployProblems(config)`.
4. `missing = servers.missing([SHARED_STAGING, SHARED_PRODUCTION])`. If any are missing → add `provisionProblems(config)`, and when there are no problems, quote them and issue `provisionCard`.

`start(name, token, voice)`:
1. Problems → 409 joined by `' '`.
2. `checkProvisionConfirm`, then an active run → 409 `SETUP_RUNNING_MESSAGE`.
3. If the latest `new` run for the name failed, reuse it: `update(id, { status: 'running', error: null })`. Otherwise `runs.create('new', name)`.
4. Publish, start the work, and return the run.

The work below has one step per `SETUP_STEPS.new` entry, each set with `runs.update` + `publishRun`. Every step can be safely re-run, which is what makes "Try again" resume.
1. `servers`: `ensure(SHARED_STAGING)` and `ensure(SHARED_PRODUCTION)`. `onLog` lines become `detail`.
2. `repo`:
   1. `slot = deploys.slot(name)`.
   2. `vars = { name, image: imageFor(owner, name), stagingServer: SHARED_STAGING, stagingUrl: stagingUrl(SHARED_STAGING, tailnet, slot), productionServer: SHARED_PRODUCTION, productionUrl: productionUrl(name, servers.get(SHARED_PRODUCTION)!.ipv4) }`.
   3. If `!state.repoCreated`: `getRepo({ owner, repo: name })` non-null → throw `repoExistsMessage(name)`. Otherwise `createRepo({ owner, name, description: `Created by the Hub from ${TEMPLATE_ID}` })` and `setState({ repoCreated: true })`.
   4. `files = renderTemplate(readTemplate(join(config.templatesDir, TEMPLATE_NAME)), vars)`.
   5. `sha = bootstrapRepo({ dir: join(config.dataDir, 'newapp', name), files, remoteUrl: remoteUrl(owner, name), token: config.githubToken, identity, message: `Create ${name} from ${TEMPLATE_ID}` })`, then `setState({ sha })`. The first commit is built in the hub's private data folder, never in `HUB_APPS_DIR`, where `hub-agent` could plant hooks before the hub commits.
   6. `await checkouts.clone(join(config.appsDir, name), remoteUrl(owner, name))` creates the app's checkout. It does nothing when the checkout already exists.
3. `secrets`: for each env, build `StackOps({ ssh, ghcrUser, ghcrToken, log: l => detail(l) }, { app: name, env, host: servers.host(SHARED_SERVERS[env]), image, slot })`, then `prepare(files['compose.yml'])` and `startDb(sha)`. Each env's Postgres starts with its own password, generated on that server.
4. `routes`: for each env, `writeSite(siteConfig({ app: name, env, slot, ipv4: servers.get(key)!.ipv4, domain: null }))`.
5. `ci`:
   - If `state.deployId` names a `success` row, skip to step 7.
   - Otherwise `rec = await deploy.deployStaging(name, { sha, actor: 'newapp' })`, then `setState({ deployId: rec.id })`.
6. Poll `deploys.get(id)` with `sleep` until it reaches a terminal status. While the row is `waiting_ci` the step is `ci`; while it is `running` the step is `deploy`.
7. Finish:
   - A `success` row → `{ status: 'success', step: 'done', url: vars.stagingUrl, detail: 'Live on staging.' }`.
   - Otherwise → `failed` with `rec.error ?? 'Staging deploy failed.'`.
   - Any throw → `failed` with its message.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - Config as in Task 29, with `appsDir` a temp dir and `templatesDir: DEFAULT_TEMPLATES_DIR`.
    - Infra: `FakeHetzner`, `FakeSsh` (ready → 0), and `FakeGitHub`.
    - `remoteUrl: () => bare`, where `bare` comes from `git init --bare -b main`. Use `identity: TEST_IDENTITY`, a `sleep` stub, `checkouts: plainCheckouts({ token: null, identity: TEST_IDENTITY })` and a temp `config.dataDir`.
    - A fake `deploy.deployStaging` that creates a `success` staging row through `deploys.create` (or one that fails, per test).
  - Tests:
    - `plan validates the name and quotes the shared servers`: `'Bad'` → `[NEW_APP_NAME_HINT]`. `'shop'` → 2 quotes and a confirm card.
    - `plan refuses a name that already exists`.
    - `creating servers needs the confirm token; voice is refused`.
    - `new app creates repo, servers, secrets, routes and deploys staging`:
      - `FakeGitHub.repos` has `acme/shop`.
      - `git(bare, 'log', '--format=%s', 'main')` is `'Create shop from vite-hono-pg@1'`.
      - `git(join(appsDir, 'shop'), 'rev-parse', 'HEAD')` equals the pushed sha, and `join(dataDir, 'newapp', 'shop', '.git')` exists.
      - `git(bare, 'show', 'main:.hub/app.json')` parses with `deploy.image 'ghcr.io/acme/shop'`, `staging.url 'http://shared-staging.tail1234.ts.net:8001'` and `production.url 'https://shop.203.0.113.5.sslip.io'`.
      - Both server hosts got `openssl rand -hex 24` and `up -d --wait db`.
      - The staging `writeSite` stdin contains `:8001 {`.
      - `deployStaging` was called with `('shop', { sha: <pushed sha>, actor: 'newapp' })`.
      - The run is `success` at step `done` with `url 'http://shared-staging.tail1234.ts.net:8001'`.
    - `a failed run can be resumed without duplicates`:
      - First attempt: `hetzner.failNext('createServer', new HetznerError(403, 'resource_limit_exceeded', 'Hetzner API: server limit reached'))` → the run fails with that message.
      - Second attempt: `start` with a fresh token → success, reusing the same run id. `createRepo` was called once, and `created.length` is 2 (one per shared server).
      - Third case: a `deployStaging` that fails once → the run fails at `ci`. The retry skips `createRepo` and pushes nothing new (`rev-list --count main` stays `'1'`).
    - `a repo that already exists on GitHub stops the run`: the exact `repoExistsMessage`.
    - `setup progress is broadcast`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`.
- [ ] **Step 4: Run** the same command. Expected: 7 pass.
- [ ] **Step 5: Commit** as `feat(server): New app goes from a name to a live staging URL, resumable`, with the attribution trailer your harness provides.

---

### Task 37: Setup routes

**Files:**
- Create: `apps/server/src/newapp/routes.ts`
- Test: `apps/server/src/newapp/routes.test.ts`

**Interfaces:**
- Consumes: Task 29 (`AdoptService`), Task 30 (`MoveService`), Task 36 (`NewAppService`), Task 10 (`isVoiceOrigin`, `DeployError`), Task 2 (`HUB_ORIGIN_HEADER`, `DEPLOY_ENVS`).
- Produces:

```ts
export interface SetupApi {
  newApp: Pick<NewAppService, 'plan' | 'start' | 'runs'>;
  adopt: Pick<AdoptService, 'plan' | 'start'>;
  move: Pick<MoveService, 'plan' | 'start'>;
}
export function setupRoutes(s: SetupApi): Hono;   // mounted at /api
```

Routes. A body that is not JSON counts as `{}`. `voice` comes from the `x-hub-origin` header. A present `token` must be a string, else 400 `'token must be a string'`.

| Route | Validation | Response |
|---|---|---|
| `POST /newapp/plan` `{ name }` | `name` string, else 400 `'name is required'` | `SetupPlan` |
| `POST /newapp` `{ name, token? }` | same | 202 `{ run }` |
| `GET /setup/runs` | none | `{ runs }` |
| `POST /apps/:app/adopt/plan` | none | `SetupPlan` |
| `POST /apps/:app/adopt` `{ token? }` | none | 202 `{ run }` |
| `POST /apps/:app/move/plan` `{ env }` | `env` in `DEPLOY_ENVS`, else 400 `'env must be staging or production'` | `SetupPlan` |
| `POST /apps/:app/move` `{ env, token? }` | same | 202 `{ run }` |

- [ ] **Step 1: Write the failing tests** (fakes; the same `onError` wrapper as Task 35):
  - `new app plan and start`: `start` receives `(name, token ?? null, voice)`.
  - `voice header reaches every start`.
  - `bad bodies get 400s`: missing name, bad env, numeric token.
  - `runs are listed`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/newapp/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `routes.ts`.
- [ ] **Step 4: Run** the same command. Expected: 4 pass.
- [ ] **Step 5: Commit** as `feat(server): New app, Adopt and Move HTTP routes`, with the attribution trailer your harness provides.

---

### Task 38: Wire deploy and setup into `createApp` and `startHub`

**Files:**
- Modify: `apps/server/src/app.ts`, `apps/server/src/server.ts`
- Test: `apps/server/src/app-deploy.test.ts`, `apps/server/src/server-deploy.test.ts`

**Interfaces:**
- Consumes: Tasks 35, 37 (routes), Task 34 (`DeployService`), Tasks 29, 30, 36 (services), Task 22 (`ServerManager`, `ServerStore`), Task 25 (`SetupRunStore`), Task 11 (`DeployStore`), Task 10 (`ConfirmStore`, `DeployError`), Task 14 (`createAppGit` with `readDir`), Task 5 (`readPublicKey`), Task 42 (`Checkouts`, `plainCheckouts`), plan 3 Tasks 20–21 (`createApp`, `AppDeps`, `startHub`, `HubOptions`, `RunningHub`).
- Produces:

```ts
// app.ts
export interface AppDeps { /* plan 3 fields */ deploy?: DeployApi | null; setup?: SetupApi | null }
// server.ts
export interface InfraOptions {
  hetzner: Hetzner | null; ssh: SshRunner; images: ImageRegistry | null;
  checkouts?: Checkouts;                 // default plainCheckouts({ token: config.githubToken, identity, openRepo: opts.openRepo })
  git?: AppGit;                          // default createAppGit(d => checkouts.open(d), d => checkouts.readDir(d))
  identity?: GitIdentity;                // New app's first commit (default: the hub user's git config)
  publicKey?: () => Promise<string>;     // default: readPublicKey(config.sshKeyPath), rejecting when it is null
  sleep?: (ms: number) => Promise<void>;
  deployCiPollMs?: number;               // DeployService ciPollMs
  readyPollMs?: number;                  // ServerManager readyPollMs
}
export interface HubOptions { /* plan 3 fields */ infra?: InfraOptions }
export interface RunningHub { /* plan 3 fields */ deploy: DeployService | null }
```

`createApp` changes:
- Mount `deployRoutes(deps.deploy)` at `/api/apps` when set, and `setupRoutes(deps.setup)` at `/api` when set. Both go after `requireAuth` and before the `/api/*` 404.
- `onError` maps `DeployError` to `c.json({ error: e.message }, e.status)`, next to `BuildError`.

`startHub` changes, only when `opts.infra` is given:
1. Create the stores (`DeployStore`, `ServerStore`, `SetupRunStore`), a `ConfirmStore` and a `ServerManager`.
2. Create `DeployService` (with `github: opts.github`, `ciPollMs: infra.deployCiPollMs`), and `AdoptService`, `MoveService` and `NewAppService` (with `build`). `NewAppService` also gets `checkouts`.
3. `BuildService`'s `onMerged` becomes `e => { opts.onMerged?.(e); deploy.onMerged(e); }`. Look `deploy.onMerged` up at call time, so tests can spy on it.
4. After plan 3's `build.recover()`:
   - `deploy.recover()` → log `` `Marked ${n} interrupted deploy(s) as failed` `` when n > 0.
   - `runs.failInterrupted()` → log `` `Marked ${n} interrupted setup run(s) as failed` `` when n > 0.
   - `deploy.resumeWaiting()`.
5. `close()` awaits `deploy.stopAll()` before closing the db. `RunningHub.deploy` is the service, or `null` without `infra`.

- [ ] **Step 1: Write the failing tests:**
  - `app-deploy.test.ts` (plan 3's `createApp` test setup plus fake `deploy` and `setup` objects):
    - `deploy routes need a session`: 401 without a cookie, 200 with one.
    - `deploy errors keep their status`: a fake throwing `DeployError('x', 409)` → 409 `{ error: 'x' }`.
    - `setup routes are mounted`: `POST /api/newapp/plan` reaches the fake.
    - `without deploy deps the routes are absent`: 404 `{ error: 'Not found' }`.
  - `server-deploy.test.ts` (`startHub` on port 0 with `FakeClaudeRunner`, `FakeGitHub({ autoGreenAfter: 0 })`, and `infra: { hetzner: new FakeHetzner(), ssh: new FakeSsh(), images: new FakeRegistry({ all: true }), publicKey: async () => 'ssh-ed25519 AAAA t' }`):
    - `startHub exposes the deploy service`: `hub.deploy` is not null.
    - `interrupted deploys are failed at startup`: open the sqlite file, insert a `running` deploy row, and close it. After `startHub`, the row is `failed` with `INTERRUPTED_DEPLOY_ERROR`.
    - `a Build merge reaches the deploy service`:
      1. Spy on `hub.deploy.onMerged`.
      2. Drive plan 3's demo flow: `makeTestRepo` app `demo` with a manifest, a runner that writes a file, and `runCommand` stubbed to succeed.
      3. Send, `idle`, `pollCi`, then `hub.build.merge('demo', id)`.
      4. The spy was called with `{ app: 'demo', taskId: id, prNumber: 1, sha: 'merged-1' }`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/app-deploy.test.ts src/server-deploy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run** `pnpm -F @hub/server exec vitest run && pnpm -F @hub/server typecheck`. Expected: everything passes, including plan 3's app and server tests.
- [ ] **Step 5: Commit** as `feat(server): compose deploy, New app, Adopt and Move into the hub`, with the attribution trailer your harness provides.

---

### Task 39: Production entry and the fake hub's infra

**Files:**
- Modify: `apps/server/src/main.ts`, `apps/server/src/dev/fake-hub.ts`
- Create: `apps/server/src/dev/fake-infra.ts`
- Test: `apps/server/src/dev/fake-infra.test.ts`

**Interfaces:**
- Consumes: Task 38 (`InfraOptions`), Task 1 (`deployProblems`, `DEFAULT_TEMPLATES_DIR`), Tasks 4–6 (`HttpHetzner`, `FakeHetzner`, `OpenSshRunner`, `NoSsh`, `FakeSsh`, `GhcrRegistry`, `FakeRegistry`), Task 14 (`createAppGit`), Task 41 (`resolveRunAs`, `checkAgentIsolation`, `createRunCommand`, `SdkClaudeRunner` with `runAs`), Task 42 (`MirroredCheckouts`, `plainCheckouts`), plan 3 Tasks 11, 12, 21.
- Produces:

```ts
// dev/fake-infra.ts
export interface FakeInfra { infra: InfraOptions; github: FakeGitHub; config: Partial<HubConfig>; remotesDir: string }
export function makeFakeInfra(root: string): FakeInfra;
```

`makeFakeInfra(root)`:
1. Create `root/home` and `root/remotes`. Write `root/home/.gitconfig`:

```
[url "file://<root>/remotes/"]
	insteadOf = https://github.com/acme/
```

   Then set `process.env.HOME = root/home`. A repo's own `insteadOf` (plan 3's `demo`) is a longer prefix and still wins.
2. `github` is a `FakeGitHub({ autoGreenAfter: 1 })` subclass whose `createRepo` also runs `git init --bare -b main <root>/remotes/<name>.git`.
3. `ssh = new FakeSsh()`:
   - `on('test -f /var/lib/hub/ready', { code: 0 })`.
   - `on('up -d --wait --wait-timeout 120 app', call => { record /APP_TAG='([0-9a-f]{40})'/ for call.host })`.
   - `on('/api/health', call => ({ stdout: JSON.stringify({ ok: true, sha: <recorded tag for call.host> ?? '' }) }))`.
4. `infra = { hetzner: new FakeHetzner(), ssh, images: new FakeRegistry({ all: true }), git: createAppGit(d => openRepo(d, { identity: TEST_IDENTITY })), identity: TEST_IDENTITY, publicKey: async () => 'ssh-ed25519 AAAAfake hub', deployCiPollMs: 1000, readyPollMs: 10 }`.
5. `config = { githubToken: 'fake-token', githubOwner: 'acme', ghcrToken: 'fake-ghcr', ghcrUser: 'acme', tsAuthKey: 'fake-ts', hcloudToken: 'fake-hc', tailnet: 'tail0000.ts.net', hcloudLocation: 'nbg1', acmeEmail: null, sshKeyPath: <root/fake-key, written with 'fake'>, templatesDir: DEFAULT_TEMPLATES_DIR, agentUser: 'fake-agent' }`. The fake hub never resolves `agentUser`: it runs `FakeClaudeRunner`, plan 3's checkouts and stubbed commands as the test user.

`fake-hub.ts` calls `makeFakeInfra(root)` first. It spreads `config` into its `HubConfig`, uses the returned `github` in place of its own `FakeGitHub`, and passes `infra`. Everything else stays as plan 3 wrote it.

`main.ts` builds:
- `ssh`: `config.sshKeyPath ? new OpenSshRunner({ keyPath: config.sshKeyPath, knownHostsPath: join(config.dataDir, 'ssh', 'known_hosts') }) : new NoSsh()`.
- `hetzner`: `config.hcloudToken ? new HttpHetzner(config.hcloudToken) : null`.
- `images`: `config.ghcrToken && config.ghcrUser ? new GhcrRegistry({ user: config.ghcrUser, token: config.ghcrToken }) : null`.

Before `startHub`, `main.ts` sets up the agent user:
1. `runAs = config.agentUser ? resolveRunAs(config.agentUser) : null`. An error prints its message and runs `process.exit(1)`.
2. With `runAs`:
   - Run `problems = await checkAgentIsolation(runAs, [process.env.CREDENTIALS_DIRECTORY, config.dataDir, config.templatesDir, process.env.HOME].filter(p => !!p))`.
   - If there are problems, print `` `Agent isolation check failed: ${problems.join(' ')}` `` and exit 1.
   - Otherwise log `` `Agent isolation OK: Claude and Build commands run as ${runAs.user}.` ``.
3. Without `runAs`, log `'HUB_AGENT_USER is not set: Claude runs as the hub user, so Deploy stays off.'`
4. `checkouts = runAs ? new MirroredCheckouts({ mirrorsDir: config.mirrorsDir, tmpDir: join(config.dataDir, 'tmp'), token: config.githubToken, runAs }) : plainCheckouts({ token: config.githubToken })`.

`startHub` then gets:
- `runner: new SdkClaudeRunner({ oauthToken: config.claudeOauthToken, runAs })`;
- `openRepo: d => checkouts.open(d)`;
- `runCommand: createRunCommand(runAs)`;
- `infra: { hetzner, ssh, images, checkouts }`.

When `deployProblems(config)` is non-empty, `main.ts` logs `` `Deploy is not configured yet: ${problems.join(' ')}` ``.

- [ ] **Step 1: Write the failing test** `fake-infra.test.ts` (it restores `process.env.HOME` in `afterEach`):
  - `creating a repo makes a bare remote that github URLs reach`:
    1. `createRepo({ owner: 'acme', name: 'notes', description: '' })`.
    2. `git ls-remote https://github.com/acme/notes.git`, run with `env: { ...process.env, ...gitEnv() }`, exits 0.
  - `health answers the last started tag per host`.
  - `the fake config passes every deploy check`: `deployProblems({ ...baseConfig, ...config })` toEqual `[]`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/dev/fake-infra.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `fake-infra.ts`, then wire `fake-hub.ts` and `main.ts`.
- [ ] **Step 4: Run** the test and `pnpm -F @hub/server typecheck`. Then start `pnpm -F @hub/server dev:fake` and check `curl -s http://127.0.0.1:8787/api/health` prints `{"ok":true}`. Stop it.
- [ ] **Step 5: Commit** as `feat(server): production infra wiring and a fake infra for e2e`, with the attribution trailer your harness provides.

---

### Task 40: Shell wiring and the Deploy smoke test

**Files:**
- Modify: `apps/client/src/areas/deploy/DeployArea.tsx`, `apps/client/src/shell/AppView.tsx`, `apps/client/src/shell/AppList.tsx`
- Test: `apps/client/e2e/deploy.spec.ts` (create), `apps/client/e2e/build.spec.ts` (modify)

**Interfaces:**
- Consumes: Task 27 (`DeployArea`), Task 32 (`AdoptPanel`, `MovePanel`, `#/new`), Task 39 (fake hub with infra), plan 3 Tasks 26 and 28.
- Produces:
  - `AppView` renders `<DeployArea key={app} app={app} api={api} ws={ws} />` for the `deploy` area. `data-testid="deploy-placeholder"` is removed.
  - `AppList` shows `<a data-testid="new-app" href="#/new">New app</a>` above the list, and also in the empty state.
  - `DeployArea` renders `<AdoptPanel>` under `deploy-not-adopted`. In each env section whose server is `shared-staging` or `shared-production`, it renders `<MovePanel env=…>`.

- [ ] **Step 1: Write the failing e2e test** `deploy.spec.ts` with `test.describe.serial` and a 90 s timeout per test. It logs in with `hub-dev-passphrase` the way plan 3's `build.spec.ts` does.
  1. `new app reaches a staging URL`:
     1. Click `new-app`, fill `newapp-name` with `notes`, click `newapp-check`.
     2. Expect `setup-quote` to have the text `Creates 2 servers on Hetzner: shared-staging (cx23, nbg1, €4.59/month), shared-production (cx23, nbg1, €4.59/month)`.
     3. Click `newapp-create`. Expect `confirm-title` `Create 2 servers on Hetzner`, then click `confirm-ok`.
     4. Expect `[data-testid="setup-step-deploy"][data-state="done"]` within 60 s, and `setup-url` with the text `http://shared-staging.tail0000.ts.net:8001`.
  2. `promote the staging build to production`:
     1. Click `newapp-open`.
     2. Expect:
        - `env-staging-summary` matches `/^Live [0-9a-f]{7}$/`;
        - `env-production-url` reads `https://notes.203.0.113.5.sslip.io`;
        - `promote-sha` has 1 option.
     3. Click `promote`. Expect:
        - `confirm-title` matches `/^Promote [0-9a-f]{7} to production$/`;
        - `confirm-sha` matches `/^[0-9a-f]{40}$/`;
        - `confirm-migrations` contains `0001_init.sql`.
     4. Click `confirm-ok`. Expect `env-production-summary` to match `/^Live [0-9a-f]{7}$/` within 30 s, `rollback-hint` to read `No earlier production version.`, and `deploy-history` to hold 2 `li` rows.

  In `build.spec.ts`, replace plan 3's `deploy tab shows the placeholder` with `deploy tab shows the deploy area`. It opens `demo`'s Deploy tab and expects `deploy-area` and `deploy-problems` to be visible; `demo` has no Dockerfile.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec playwright test e2e/deploy.spec.ts e2e/build.spec.ts`. Expected: FAIL (no `new-app` link, and the Deploy tab still shows the placeholder).
- [ ] **Step 3: Implement** the three changes.
- [ ] **Step 4: Run** the full e2e suite, `pnpm -F @hub/client test:e2e`, then `pnpm -r typecheck && pnpm -r test && pnpm -F @hub/client build && pnpm -F @hub/client size`. Expected: all pass, and the client stays under 150 000 bytes gzipped. The deploy spec needs a fresh fake hub: stop any reused one first, because the app name `notes` must be free.
- [ ] **Step 5: Commit** as `feat(client): Deploy tab, New app entry point, and the deploy smoke test`, with the attribution trailer your harness provides.

---

### Task 41: Claude and Build commands run as `hub-agent`

**Files:**
- Create: `apps/server/src/claude/run-as.ts`
- Modify: `apps/server/src/claude/sdk.ts`, `apps/server/src/build/commands.ts`
- Test: `apps/server/src/claude/run-as.test.ts`, `apps/server/src/claude/sdk-run-as.test.ts`, `apps/server/src/build/commands-run-as.test.ts`

**Interfaces:**
- Consumes:
  - plan 3 Task 10: `RunnerContext`, `buildQueryOptions`, `SdkClaudeRunner`.
  - plan 3 Task 14: `RunCommand`, `runCommand`, `CommandResult`, `COMMAND_TIMEOUT_MS`, `OUTPUT_TAIL`.
  - plan 3 Task 3: `scrubEnv`.
  - `SpawnOptions` and `SpawnedProcess` come from `@anthropic-ai/claude-agent-sdk` (0.3.299, see the header).
- Produces:

```ts
// claude/run-as.ts
export interface RunAs { user: string; uid: number; gid: number; groups: readonly number[]; home: string }
export function resolveRunAs(user: string, exec?: (cmd: string, args: string[]) => string /* execFileSync, utf8 */): RunAs;
export function agentArgv(runAs: RunAs | null, command: string, args: readonly string[]): { command: string; args: string[] };
export function agentEnv(runAs: RunAs | null, env: Record<string, string | undefined>): Record<string, string | undefined>;
export function spawnAsAgent(runAs: RunAs | null, spawnFn?: typeof spawn): (o: SpawnOptions) => SpawnedProcess;
export interface AgentResult { code: number | null; stdout: Buffer; stderr: string }
export function runAsAgent(runAs: RunAs | null, command: string, args: readonly string[],
  o: { cwd: string; env: Record<string, string | undefined>; input?: string | Buffer; timeoutMs?: number /* 600_000 */ }): Promise<AgentResult>;
export interface Caps { inh: bigint; prm: bigint; eff: bigint; amb: bigint; noNewPrivs: boolean }
export function capsOf(procStatus: string): Caps;
export function canSwitchUsers(): boolean;
export function checkAgentIsolation(runAs: RunAs, paths: readonly string[]): Promise<string[]>;
// claude/sdk.ts
export interface RunnerContext { env: Record<string, string | undefined>; oauthToken: string | null; runAs?: RunAs | null }
// The SdkClaudeRunner constructor options gain runAs?: RunAs | null (default null).
// build/commands.ts
export function createRunCommand(runAs: RunAs | null): RunCommand;
export const runCommand: RunCommand;   // = createRunCommand(null), plan 3's behaviour
```

Rules:
- `resolveRunAs(user)`:
  - `getent passwd <user>` gives `name:x:uid:gid:gecos:home:shell`, and `id -G <user>` gives the group ids.
  - If `exec` throws, it throws `` Error(`User ${user} does not exist. Run sudo /opt/hub/ops/hub/bootstrap.sh.`) ``.
  - If the uid is 0 or `process.getuid()`, it throws `Error('HUB_AGENT_USER must be a separate unprivileged user.')`.
- `agentArgv`:
  - Without an agent, it returns `{ command, args: [...args] }`.
  - With one, it returns `` { command: 'setpriv', args: [`--reuid=${uid}`, `--regid=${gid}`, groups.length ? `--groups=${groups.join(',')}` : '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', command, ...args] } ``.
  - Nothing in the hub uses Node's `spawn` `uid`/`gid` options. The header explains why.
- `agentEnv`:
  - Without an agent, it returns `env` unchanged.
  - With one, it returns `` { ...env, HOME: home, USER: user, LOGNAME: user, PATH: `${home}/.local/bin:${env.PATH ?? '/usr/bin:/bin'}` } ``.
- `spawnAsAgent(runAs)` is the SDK hook. It returns `spawnFn(a.command, a.args, { cwd: o.cwd, env: agentEnv(runAs, o.env), stdio: ['pipe', 'pipe', 'inherit'], signal: o.signal })`, where `a = agentArgv(runAs, o.command, o.args)`.
- `runAsAgent`:
  - It spawns `agentArgv(...)` with `agentEnv(runAs, o.env)`. It writes `input` to stdin and ends it.
  - It collects stdout as a Buffer and stderr as text, and sends SIGKILL after `timeoutMs`.
  - It resolves with the exit code, and it never rejects for a non-zero exit.
- `capsOf` reads the hex `CapInh`, `CapPrm`, `CapEff` and `CapAmb` lines as bigints, and `NoNewPrivs` as `true` when it is 1.
- `canSwitchUsers()` is true on Linux when `setpriv --version` exits 0 and the `CapEff` of `/proc/self/status` has bits 6 (`CAP_SETGID`) and 7 (`CAP_SETUID`).
- `checkAgentIsolation(runAs, paths)` makes two runs as the agent and returns one problem per finding, in this order:
  1. `grep -E '^(Cap(Inh|Prm|Eff|Amb)|NoNewPrivs):' /proc/self/status`. Any non-zero set, or `NoNewPrivs` other than 1, gives `` `${user} still holds capabilities.` ``.
  2. `sh -c 'for p; do if [ -r "$p" ] || { [ -d "$p" ] && [ -x "$p" ]; }; then printf "%s\n" "$p"; fi; done' sh ...paths`. Each printed path gives `` `${user} can read or enter ${p}.` ``.
- `buildQueryOptions(opts, ctx)`:
  - When `ctx.runAs` is set, it adds `spawnClaudeCodeProcess: spawnAsAgent(ctx.runAs)`. `env` stays `{ ...scrubEnv(ctx.env), CLAUDE_CODE_OAUTH_TOKEN }`, and the hook applies `agentEnv`.
  - Without `ctx.runAs`, the result is exactly plan 3's, so plan 3's tests stand.
  - `SdkClaudeRunner` passes its `runAs` into the context.
- `createRunCommand(runAs)` behaves like plan 3's `runCommand`, with two differences:
  - It spawns `agentArgv(runAs, 'bash', ['-c', cmd])` with `env: agentEnv(runAs, { ...scrubEnv(process.env), CI: '1' })`.
  - It keeps `detached: true` and still kills the process group. That works on the agent's processes because the unit grants `CAP_KILL` (Task 20).

- [ ] **Step 1: Write the failing tests.** `AGENT = { user: 'hub-agent', uid: 65532, gid: 65532, groups: [65532, 65531], home: '/var/lib/hub-agent' }`.
  - `run-as.test.ts`:
    1. `agentArgv switches user and drops every capability`: `agentArgv(AGENT, 'bash', ['-c', 'pnpm test'])` toEqual `{ command: 'setpriv', args: ['--reuid=65532', '--regid=65532', '--groups=65532,65531', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', 'bash', '-c', 'pnpm test'] }`.
    2. `agentArgv without groups clears them, and without an agent changes nothing`:
       - With `{ ...AGENT, groups: [] }`, `args[2]` is `'--clear-groups'`.
       - `agentArgv(null, 'git', ['status'])` toEqual `{ command: 'git', args: ['status'] }`.
    3. `agentEnv gives the agent its own home`: `agentEnv(AGENT, { PATH: '/usr/bin:/bin', HOME: '/var/lib/hub', X: '1' })` toEqual `{ PATH: '/var/lib/hub-agent/.local/bin:/usr/bin:/bin', HOME: '/var/lib/hub-agent', USER: 'hub-agent', LOGNAME: 'hub-agent', X: '1' }`.
    4. `resolveRunAs reads passwd and groups`:
       - A fake `exec` answers `getent passwd hub-agent` with `'hub-agent:x:998:997::/var/lib/hub-agent:/usr/sbin/nologin\n'` and `id -G hub-agent` with `'997 996\n'`.
       - The result is `{ user: 'hub-agent', uid: 998, gid: 997, groups: [997, 996], home: '/var/lib/hub-agent' }`.
    5. `resolveRunAs refuses a missing user, root and the hub's own user`: a throwing `exec`, uid 0, and uid `process.getuid()` each throw the exact messages above.
    6. `capsOf parses /proc status`: `'CapInh:\t0000000000000000\nCapPrm:\t00000000000000e0\nCapEff:\t00000000000000e0\nCapBnd:\t000001ffffffffff\nCapAmb:\t00000000000000e0\nNoNewPrivs:\t1\n'` → `{ inh: 0n, prm: 0xe0n, eff: 0xe0n, amb: 0xe0n, noNewPrivs: true }`.
    7. `spawnAsAgent starts the SDK's command through setpriv`:
       - A recording `spawnFn` returns `{}`. Call the hook with `{ command: '/x/claude', args: ['--print'], cwd: '/r', env: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }, signal }`.
       - The recorded command is `'setpriv'`, and its args end with `['--', '/x/claude', '--print']`.
       - The options have `cwd` `'/r'` and `stdio` `['pipe', 'pipe', 'inherit']`, and their `env` has `HOME` `'/var/lib/hub-agent'` and `CLAUDE_CODE_OAUTH_TOKEN` `'o'`.
    8. `runAsAgent without an agent pipes input and output`: `runAsAgent(null, 'cat', [], { cwd: tmpdir(), env: process.env, input: 'hi' })` → `code 0`, and `stdout.toString()` is `'hi'`.
    - The live block is `describe.skipIf(!canSwitchUsers())('as another user (needs Linux, setpriv, and CAP_SETUID and CAP_SETGID in the test process, such as root in a CI container)', …)`.
      - It uses `LIVE = { user: 'hub-agent', uid: 65532, gid: 65532, groups: [65532], home: '/tmp' }`.
      - `HUB` stands in for the hub unit: a non-root parent that holds exactly the unit's ambient capabilities.
        - When `process.getuid() === 0`, `HUB = ['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--inh-caps=+setuid,+setgid,+kill', '--ambient-caps=+setuid,+setgid,+kill', '--']`. Otherwise `HUB = []`.
        - `asHub(argv)` runs `spawnSync` on `[...HUB, ...argv]` with `encoding: 'utf8'` and `cwd: '/'`.
      - `beforeAll` makes a `mkdtemp` folder `hubOnly` (0700) holding the file `s` (`'secret'`). When running as root, it `chownSync`s both to 65534.
    9. `the stand-in hub holds the unit's capabilities`: `capsOf(asHub(['cat', '/proc/self/status']).stdout).amb` is `0xe0n`. This shows the next tests start from the same position as the hub.
    10. `an agent child holds no capabilities`:
        - Run `out = asHub([a.command, ...a.args]).stdout`, where `a = agentArgv(LIVE, 'cat', ['/proc/self/status'])`.
        - `capsOf(out)` toEqual `{ inh: 0n, prm: 0n, eff: 0n, amb: 0n, noNewPrivs: true }`, and `out` matches `/^Uid:\t65532\t/m`.
    11. `the agent cannot read a hub-only folder`:
        - `asHub(['cat', join(hubOnly, 's')]).stdout` is `'secret'`.
        - The same `cat` through `agentArgv(LIVE, …)` exits 1, and its stderr contains `Permission denied`.
    12. `the hub can stop an agent process`:
        - Run `asHub(['sh', '-c', '"$@" & pid=$!; sleep 0.2; kill "$pid"; wait "$pid"; echo "status=$?"', 'sh', a.command, ...a.args])`, where `a = agentArgv(LIVE, 'sleep', ['30'])`.
        - Its stdout contains `status=143`.
    13. `checkAgentIsolation names what the agent can reach`: `checkAgentIsolation(LIVE, [hubOnly, '/etc'])` toEqual `['hub-agent can read or enter /etc.']`.
  - `sdk-run-as.test.ts`:
    14. `options start Claude as the agent`:
        - Call `o = buildQueryOptions({ cwd: '/repo', prompt: 'x' }, { env: { PATH: '/bin', GITHUB_TOKEN: 'g' }, oauthToken: 'o', runAs: AGENT })`.
        - `typeof o.spawnClaudeCodeProcess` is `'function'`, and `o.env` toEqual `{ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }`.
    15. `no spawn hook without an agent`: `'spawnClaudeCodeProcess' in buildQueryOptions({ cwd: '/repo', prompt: 'x' }, { env: {}, oauthToken: null })` is false.
  - `commands-run-as.test.ts`:
    16. `createRunCommand(null) is plan 3's runner`: `'echo hi'` → `ok` true, and the output is `'hi\n'`.
    17. `commands run as the agent with its own home` (live, the same `skipIf`):
        - With `vi.stubEnv('GITHUB_TOKEN', 'leak')`, run `createRunCommand(LIVE)('id -u; echo "$HOME"; echo "${GITHUB_TOKEN:-none}"', { cwd: '/tmp' })`.
        - The output is `'65532\n/tmp\nnone\n'`.
    18. `a timed-out agent command is killed` (live): `createRunCommand(LIVE)('sleep 10', { cwd: '/tmp', timeoutMs: 200 })` → `timedOut` true, resolved in under 3000 ms.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude src/build`. Expected: FAIL (`run-as.ts` does not exist).
- [ ] **Step 3: Implement** `run-as.ts`, then the `runAs` changes in `sdk.ts` and `commands.ts`.
- [ ] **Step 4: Run** the same command and `pnpm -F @hub/server typecheck`. Expected:
  - As root, as in the CI-like containers the architecture describes, all 18 new tests pass, and so do plan 3's `sdk.test.ts` and `commands.test.ts`.
  - Elsewhere, for example on a GitHub-hosted runner, which runs as a non-root user, the 7 live tests are reported as skipped, with the reason in the block name.
- [ ] **Step 5: Commit** as `feat(server): Claude and Build commands run as hub-agent with no capabilities`, with the attribution trailer your harness provides.

---

### Task 42: Hub-owned git mirrors (`Checkouts`)

**Files:**
- Create: `apps/server/src/git/checkouts.ts`
- Test: `apps/server/src/git/checkouts.test.ts`

**Interfaces:**
- Consumes: Task 41 (`RunAs`, `runAsAgent`), plan 3 Task 11 (`GitRepo`, `GitIdentity`, `openRepo`, `gitEnv`, `authConfig`, `makeTestRepo`, `git`, `TEST_IDENTITY`).
- Produces:

```ts
export interface Checkouts {
  open(dir: string): GitRepo;                       // what Build uses (HubOptions.openRepo)
  readDir(dir: string): string;                     // where the hub reads history (createAppGit's readDir, Task 14)
  clone(dir: string, url: string): Promise<void>;   // New app (Task 36); does nothing when dir/.git exists
}
export function plainCheckouts(o: { token: string | null; identity?: GitIdentity; openRepo?: (dir: string) => GitRepo }): Checkouts;
export interface MirrorOptions { mirrorsDir: string; tmpDir: string; token: string | null; runAs: RunAs | null; identity?: GitIdentity }
export function mirrorPathFor(mirrorsDir: string, dir: string): string;   // join(mirrorsDir, `${basename(dir)}.git`)
export function authEnv(token: string | null): Record<string, string>;
export function mirrorMissing(name: string): string;
export class MirroredCheckouts implements Checkouts { constructor(o: MirrorOptions) }
```

- `plainCheckouts` is plan 3's behaviour, used in development, tests and the fake hub:
  - `open` is `o.openRepo ?? (d => openRepo(d, { token, identity }))`, and `readDir` is the identity.
  - `clone` returns when `dir/.git` exists. Otherwise it runs `simpleGit({ config: authConfig(token) }).env(gitEnv(identity)).clone(url, dir)`.
- `authEnv(token)`: without a token, `{}`. With one, `{ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic <base64 of x-access-token:token>' }`.
- `mirrorMissing(name)` = `` `${name} has no Hub mirror yet. Run sudo /opt/hub/ops/hub/add-app.sh <owner>/${name}.` ``

`MirroredCheckouts`:
- The constructor creates `tmpDir` with mode 0700.
- **Hub git** is `execFile('git', ['--git-dir', mirror, ...args], { env: { ...gitEnv(), ...authEnv(token) } })`. The token is never in the args. A non-zero exit throws `` Error(`git ${args[0]}: ${stderr.trim()}`) ``. The hub never runs git with its `cwd` in a checkout, or with `--git-dir` pointing into one.
- **Agent git** is `runAsAgent(runAs, 'git', args, { cwd: dir, env: gitEnv(identity), input })`. A non-zero exit throws the same way.
- **Mirror layout.** `ops/hub/add-app.sh` (Task 20) makes the same one.
  - Create it with `git init -q --bare --shared=0640 --template= <mirror>`.
  - `remote.origin.url` is the given URL.
  - It has two fetch refspecs:
    - `+refs/heads/*:refs/heads/*`, so the agent's plain `git fetch origin` and `git clone` work.
    - `+refs/heads/*:refs/remotes/origin/*`, so `origin/<branch>` resolves in the mirror exactly as it does in a checkout.
  - `HEAD` points at the default branch.
- **sync** is hub `fetch --quiet --prune --no-write-fetch-head origin`.

`open(dir)` returns a `GitRepo`:
- `dir` is the checkout. Every method except `remoteUrl` first checks that `<mirror>/HEAD` exists, else it throws `Error(mirrorMissing(basename(dir)))`.
- These methods run agent git, with the same git commands as plan 3's `openRepo`:
  - `currentBranch`, `checkout`, `headSha` and `commitsAhead`.
  - `isDirty`: `status --porcelain` is non-empty.
  - `commitAll`: `add -A`, then `null` when `status --porcelain` is empty, else `commit -q -m <message>` and the HEAD sha.
  - `createBranchFrom`: `checkout --no-track -B <branch> origin/<base>`.
- `defaultBranch`: hub `symbolic-ref --short refs/remotes/origin/HEAD` minus `origin/`. Failing that, `main` when `refs/remotes/origin/main` exists, else `master`.
- `fetch`: sync, then agent `fetch --quiet --prune origin`.
- `remoteUrl`: hub `config --get remote.origin.url`, or `null` when the mirror is missing.
- `push(branch)`:
  1. The branch must match `/^[A-Za-z0-9._/-]+$/`, must not start with `-`, and must not contain `..`. Otherwise throw `Error('Bad branch name')`.
  2. `sha` = agent `rev-parse --verify refs/heads/<branch>`, which must be 40 hex characters.
  3. If hub `cat-file -e <sha>^{commit}` fails:
     1. The agent runs `bundle create - refs/heads/<branch> --not --remotes=origin`. Write its stdout to a new `mkdtemp(tmpDir)/push.bundle`.
     2. Hub `fetch --quiet --no-write-fetch-head <file> +refs/heads/<branch>:refs/hub/incoming`, then `cat-file -e <sha>^{commit}` again. If that fails, throw `Error('The commit did not reach the Hub mirror.')`.
     3. Hub `update-ref -d refs/hub/incoming`, and remove the temp folder in `finally`.
  4. Hub `push --quiet origin <sha>:refs/heads/<branch>`, then `fetch()`.

`readDir(dir)` = `mirrorPathFor(mirrorsDir, dir)`.

`clone(dir, url)`:
1. If the mirror is missing, create it with `url` as above, sync it, then run hub `remote set-head origin --auto` and `symbolic-ref HEAD refs/heads/<default branch>`. If the mirror exists, just sync it.
2. If `dir/.git` exists, stop (a resumed run).
3. Run `mkdirSync(dir)`, which throws for an existing folder, then `chmodSync(dir, 0o2770)`.
4. The agent runs `git clone -q --no-local <mirror> <dir>` with `cwd: dirname(dir)`.

- [ ] **Step 1: Write the failing tests.** They run with `runAs: null`, so both sides run as the test user. They check the protocol; Task 41 checks the user split.
  - Setup:
    - `makeTestRepo()` gives `origin`. `mirrorsDir`, `tmpDir` and `appsDir` are temp folders.
    - `c = new MirroredCheckouts({ mirrorsDir, tmpDir, token: null, runAs: null, identity: TEST_IDENTITY })`.
    - `work = join(appsDir, 'demo')`, `mirror = mirrorPathFor(mirrorsDir, work)`, then `await c.clone(work, origin)`.
    - `beforeAll` runs `process.umask(0o007)` to match the unit (vitest's default `forks` pool allows it), and `afterAll` restores the old value.
  - Tests:
    - `clone makes a mirror and a checkout of it`:
      - `git(work, 'remote', 'get-url', 'origin')` equals `mirror`.
      - `git(mirror, 'rev-parse', 'origin/main')` equals `git(origin, 'rev-parse', 'main')`.
      - `c.open(work).defaultBranch()` is `'main'`, and `c.readDir(work)` is `mirror`.
    - `push sends the agent's commits through a bundle`:
      1. `repo = c.open(work)`, then `createBranchFrom('build/x-1', 'main')`.
      2. Write `a.txt`, then `commitAll('add a')`, then `push('build/x-1')`.
      3. `git(origin, 'rev-parse', 'refs/heads/build/x-1')` equals `repo.headSha()`, and `git(mirror, 'for-each-ref', 'refs/hub')` is empty.
    - `the mirror is never group-writable and has no hooks`: after that push, walk the mirror. No entry has `mode & 0o022`, and there is no `hooks` folder and no `FETCH_HEAD`.
    - `pushing again without new commits works`: a second `push('build/x-1')` resolves.
    - `the hub ignores the checkout's hooks and push settings`:
      1. Before pushing, write `work/.git/hooks/pre-push` (mode 755, `touch <tmp>/hooked`).
      2. Run `git(work, 'config', 'remote.origin.pushurl', evil)`, where `evil` is a second bare repo.
      3. After a commit and `push('build/x-2')`: `<tmp>/hooked` does not exist, `origin` has the branch, and `git(evil, 'for-each-ref')` is empty.
    - `a missing mirror explains how to add the app`: `c.open(join(appsDir, 'other')).fetch()` rejects with `mirrorMissing('other')`.
    - `bad branch names are refused`: `push('--force')` and `push('a..b')` reject with `'Bad branch name'`.
    - `the token goes in the environment`:
      - `authEnv('t')` toEqual `{ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==' }`, and `authEnv(null)` toEqual `{}`.
      - Make a second instance with `token: 'secret-token'` and push through it. The mirror's `config` then contains neither the token nor its base64.
    - `clone resumes`: a second `c.clone(work, origin)` resolves and leaves `headSha()` unchanged.
    - `plain checkouts keep plan 3's behaviour`:
      - `p = plainCheckouts({ token: null, identity: TEST_IDENTITY })`.
      - `p.clone(join(appsDir, 'p'), origin)` makes a checkout whose `origin` remote is `origin`.
      - `p.readDir('x') === 'x'`, and `p.open(join(appsDir, 'p')).headSha()` resolves.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/git/checkouts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `checkouts.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/server exec vitest run src/git` and `pnpm -F @hub/server typecheck`. Expected: all pass (10 new tests), including plan 3's git tests.
- [ ] **Step 5: Commit** as `feat(server): hub-owned git mirrors so the hub never runs git in a checkout`, with the attribution trailer your harness provides.

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| §1 Production only ever receives an image that already ran on staging and passed tests | 24 (`stagingPassed`), 33 (smoke tests), 34 (promote takes the staging row's image) |
| §1 "New app" goes from a name to a live staging URL without manual server work | 22, 25, 36, 40 |
| §2 Q10/11 Docker images, Compose stacks behind Caddy, deployed over SSH, rollback | 12, 13, 23, 33, 34 |
| §2 Q12 Shared staging and production servers by default; promote to dedicated | 22, 28, 30, 33 (relocation) |
| §2 Q13 / §4 Template: Vite + React + TS + CSS Modules, Hono, Postgres migrations, shared types, a DB per env | 15, 16, 21 |
| §2 Q14 GitHub + Actions + GHCR; staging on Tailscale; production on `<app>.<ip>.sslip.io`; the domain is one manifest setting | 6, 7, 12 (`siteConfig` domain), 21, 33 |
| §2 Q15 / §8 Adopt adds the convention on a branch as a PR | 8, 26, 29 |
| §3 Infra driver (Hetzner API, SSH, GitHub API) | 4, 5, 7, 22 |
| §3 Realtime deploy logs on the WebSocket | 2, 18, 27, 34 |
| §3 Secrets stay on the hub, encrypted at rest, never sent to the client | 1, 5, 9, 20, 23 (stdin only), Global Constraints |
| §4 Manifest and template layout; "adopted" needs the manifest, Dockerfile, compose, CI, and green CI | 21, 34 (`state` problems, CI gate) |
| §6 Claude cannot deploy (now also cannot read deploy credentials) | 1, 9 |
| §6 Merge deploys to staging automatically | 34 (`onMerged`), 38 |
| §7 Staging: `:<sha>` image, SSH, migrations on the app's staging DB, restart, health check and logs to the tablet | 21, 23, 33, 34, 27 |
| §7 Production: only SHAs that ran on staging with green CI; confirm card with SHA, commits, migrations; a tap, never voice | 10, 24, 27, 34, 35 |
| §7 Rollback to the previous production SHA; expand/contract migration lint | 11, 16, 21 (CI runs the lint), 24, 34 |
| §7 Every deploy logged: who, when, SHA, result, logs | 11, 18, 27 |
| §8 New app steps 1–5 | 3, 7, 12, 21, 22, 23, 25, 36 |
| §8 Promote to dedicated servers | 22, 28, 30, 33 |
| §9 Production and paid actions still need their confirm card under voice | 10, 35, 37 (`x-hub-origin: voice`; plan 6 sets it) |
| §11 A failed staging deploy keeps the old version; a failed production health check auto-rolls back | 33 |
| §12 Deploy integration test against a throwaway Hetzner server (manual trigger) | 31 |
| §13 Risk: sslip.io rate limits | 20 (Known limits; set a domain) |
| Architecture: `HCLOUD_TOKEN`, `HUB_SSH_KEY_PATH` config; `deploy/`, `infra/`, `newapp/`, `adopt/`; `areas/deploy/` | 1, File Structure |
| Architecture: promote needs a confirm token issued for a specific SHA; voice-originated requests never carry one | 10, 17, 27, 34 |
| Architecture: one Playwright smoke test per area | 40 |
| Coordinator: Claude's processes can never reach deploy credentials | 41 (`hub-agent` through `setpriv` with no capabilities, live capability and `EACCES` tests, `checkAgentIsolation`), 42 (hub git only in mirrors, commits arrive as bundles, token in the environment), 8 (no links followed in checkouts), 1 (scrub and runner env tests; Deploy off without `HUB_AGENT_USER`), 5 (`-i`, `-F /dev/null`, scrubbed env), 9 (guard, now defense in depth), 20 (`ImportCredential`, unit capabilities, `ProtectProc=invisible`, folder modes, `add-app.sh`), 39 (startup isolation check) |

## Self-review

- **Spec coverage.** Every row above has a task. The spec's manifest example shows `http://myapp.staging.<tailnet>`, but MagicDNS gives one name per machine and no sub-names, so staging is port-based (Global Constraints). Plan 5 reads `web/src/routes.tsx` in the shape Task 15 pins (`routes: AppRoute[]` with `path`, `page`, `component`).
- **Step scan.** Each code step names a file, signature and pinned values. Bodies appear only for algorithms the tests leave open: the cloud-init script, the pipeline, the CI wait loop, the Caddy write-and-validate command, and the exact copy (prompts, messages, YAML, Dockerfile).
- **Type consistency.**
  - `DeployRecord`, `ConfirmCard`, `SetupRun` and `SetupPlan` come from Task 2 and are used unchanged in Tasks 10–40.
  - `StackOps` methods take the tag explicitly everywhere (Tasks 23, 28, 31, 33, 36).
  - `SetupDeps`, `publishRun` and `checkProvisionConfirm` live in Task 29 and are reused by Tasks 30 and 36.
  - `DeployApi` (Task 35) and `SetupApi` (Task 37) are what `AppDeps` takes (Task 38).
  - `Pipeline` (Task 33) is injectable into `DeployService` (Task 34).
  - `RunAs` (Task 41) reaches `MirroredCheckouts` (Task 42) and `main.ts` (Task 39). `Checkouts` (Task 42) is what `NewAppDeps.checkouts` (Task 36) and `InfraOptions.checkouts` (Task 38) take. `createAppGit(openRepoFn, readDir)` (Task 14) gets `checkouts.readDir` in Task 38.
- **Isolation.** Tasks 41 and 42 run in Waves 1 and 2, ahead of every task that runs Claude, Build commands or git in production.
  - Everything the hub runs inside a checkout goes through `agentArgv`: Claude (the SDK spawn hook), Build commands (`createRunCommand`), and git (`MirroredCheckouts`).
  - The hub's own git runs only in mirrors that `hub-agent` cannot write.
  - The two probes in the header back this design. They showed that Node's `spawn({ uid })` would leave `CAP_SETUID` in the child, and that `setpriv … --ambient-caps=-all` clears every capability.
- **Fake IDs in tests.** `FakeHetzner` shares one id counter, so for the two shared servers: SSH key 1, staging firewall 2, staging server 3, production firewall 4, production server 5 (`203.0.113.5`). Tasks 29, 36 and 40 use that address.
- **Review Focus.** Each of the five items names a test inside its owning task (Tasks 10, 22, 25, 33, 34, 36).
- **Proportion.** 42 tasks for 2 spec sections plus the template, ops and the agent user split. Most of the length is exact copy (messages, YAML, Dockerfile, scripts) that a small implementer cannot infer. Function bodies are left to the implementer except for the algorithms named above.
- **Plan 3 tests changed on purpose.**
  - `config.test.ts` `loads a full environment` (Task 1).
  - `ws.test.ts` `SERVER_MSG_TYPES` (Task 2).
  - `ops.test.ts`: env keys, scripts parse, no API key (Task 20).
  - `e2e/build.spec.ts`: the Deploy tab (Task 40).
  - Guard reasons are unchanged, because plan 3's reasons are checked first (Task 9).
  - `sdk.test.ts` and `commands.test.ts` are unchanged, because `runAs` defaults to none (Task 41).
- **Plan 3 files changed on purpose.**
  - `claude/sdk.ts` and `build/commands.ts` (Task 41).
  - `ops/hub/bootstrap.sh`, `hub.env.example` (`HUB_APPS_DIR=/var/lib/hub-apps`), and the docs' step 8 and known limits (Task 20).

## Residual risks

- **A compromised hub is root-equivalent.** The hub holds `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL` so it can start and stop `hub-agent` processes. A process with `CAP_SETUID` can become uid 0. `ProtectSystem=full` keeps `/usr` and `/etc` read-only, but not `/var`. The hub already holds every credential, so the user split protects against Claude, not against a compromised hub. `docs/hub-bootstrap.md` says so.
- **The hub's other children inherit those capabilities.** That includes git in the mirrors, ssh, and later Playwright's Chromium. Plan 4's own children are trusted programs that never run app code. Chromium renders design HTML that Claude influences, so plan 6 should start it through `setpriv --inh-caps=-all --ambient-caps=-all`.
- **Plan 3's reads still follow links.** `AppRegistry` and the render endpoints read checkout files with plain `readFile`. A link there can only show the first characters of a file in a parse error to the signed-in user, never to Claude. Plans 5 and 6 use `readCheckoutFile` for anything they hand to Claude.
- **`hub-agent` shares the hub's network.**
  - It can reach app servers over Tailscale, but their sshd needs the deploy key, and Tailscale SSH is off on them (Task 12).
  - It can reach the hub's API, which still needs the passphrase.
- **`hub-agent` can read the hub's source in `/opt/hub`.** The source holds no secrets, and only `templates/` is closed (0700). The SDK's bundled CLI lives in `/opt/hub/node_modules`, so `hub-agent` must be able to read that.
- **The Tailscale auth key travels in each new server's cloud-init user data.** Use a tagged, reusable key and rotate it.
- **sslip.io certificates share Let's Encrypt limits with every sslip.io user.** Set `deploy.production.domain` once you own a domain.
- **A re-created server needs Tailscale cleanup.** When a server is deleted and the Hub creates it again, remove the old Tailscale machine first, or the new one gets a `-1` name.
