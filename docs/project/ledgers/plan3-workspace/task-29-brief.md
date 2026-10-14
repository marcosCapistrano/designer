### Task 29: Hub server bootstrap (Hetzner + Tailscale + Claude subscription + systemd)

**Files:**
- Create: `ops/hub/bootstrap.sh`, `ops/hub/hub.service`, `ops/hub/hub.env.example`, `ops/hub/set-secret.sh`, `ops/hub/check-claude.sh`, `docs/hub-bootstrap.md`
- Test: `apps/server/src/ops.test.ts`

**Interfaces:**
- Consumes: Task 3 (`loadConfig`, `CREDENTIAL_KEYS`), Task 5 (`hash-passphrase` script, `hashPassphrase`). The service starts `src/main.ts` (Task 21) at deploy time.
- Produces: the exact runbook below. Everything is idempotent and safe to re-run.

`ops/hub/hub.env.example` (exact; non-secret settings only):

```
# /etc/hub/hub.env (root, mode 600). Secrets are NOT here: store them with ops/hub/set-secret.sh.
# Never add ANTHROPIC_API_KEY anywhere: the Hub uses your Claude subscription.
HUB_BIND=127.0.0.1
HUB_PORT=8787
HUB_DATA_DIR=/var/lib/hub/data
HUB_APPS_DIR=/var/lib/hub/apps
GITHUB_OWNER=
```

`ops/hub/hub.service` (exact):

```ini
[Unit]
Description=Hub server
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service

[Service]
Type=simple
User=hub
Group=hub
WorkingDirectory=/opt/hub/apps/server
EnvironmentFile=/etc/hub/hub.env
Environment=NODE_ENV=production
Environment=PATH=/var/lib/hub/.local/bin:/usr/local/bin:/usr/bin:/bin
LoadCredentialEncrypted=HUB_PASSPHRASE_HASH
LoadCredentialEncrypted=GITHUB_TOKEN
LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
ExecStart=/opt/hub/apps/server/node_modules/.bin/tsx /opt/hub/apps/server/src/main.ts
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

`ops/hub/set-secret.sh` (exact):

```bash
#!/usr/bin/env bash
# Usage: sudo ops/hub/set-secret.sh NAME   (value from stdin, or typed silently)
set -euo pipefail
name="${1:-}"
case "$name" in HUB_PASSPHRASE_HASH|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN) ;; *) echo "Unknown secret $name" >&2; exit 1 ;; esac
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
install -d -m 700 /etc/credstore.encrypted
if [ -t 0 ]; then read -rs -p "$name: " value; echo; else IFS= read -r value; fi
[ -n "$value" ] || { echo "Empty value" >&2; exit 1; }
printf '%s' "$value" | systemd-creds encrypt --name="$name" - "/etc/credstore.encrypted/$name"
echo "Stored $name encrypted. Apply with: sudo systemctl restart hub"
```

`ops/hub/check-claude.sh` (exact; run through `systemd-run` with the service's user and credential):

```bash
#!/usr/bin/env bash
set -euo pipefail
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/CLAUDE_CODE_OAUTH_TOKEN")"
cd /var/lib/hub
exec /var/lib/hub/.local/bin/claude -p 'Reply with the single word OK.'
```

`ops/hub/bootstrap.sh` (exact):

```bash
#!/usr/bin/env bash
# Fresh Hetzner Ubuntu 24.04, as root:  TS_AUTHKEY=tskey-auth-… GITHUB_TOKEN=github_pat_… bash bootstrap.sh
set -euo pipefail
HUB_REPO_URL="${HUB_REPO_URL:-https://github.com/marcosCapistrano/designer.git}"
HUB_GIT_NAME="${HUB_GIT_NAME:-Hub}"
HUB_GIT_EMAIL="${HUB_GIT_EMAIL:-hub@localhost}"
PNPM_VERSION="10.28.0"
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
if grep -qs '^ANTHROPIC_API_KEY=' /etc/environment; then echo "Remove ANTHROPIC_API_KEY from /etc/environment first" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential python3 ufw

if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g "pnpm@${PNPM_VERSION}"

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
tailscale status >/dev/null 2>&1 || tailscale up --ssh --hostname=hub ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"}

ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
ufw allow OpenSSH            # removed in docs step 3 once Tailscale SSH works
ufw --force enable

id hub >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hub --shell /bin/bash hub
install -d -o hub -g hub -m 750 /var/lib/hub/data /var/lib/hub/apps
install -d -o hub -g hub -m 755 /opt/hub
install -d -o root -g root -m 700 /etc/hub /etc/credstore.encrypted
systemd-creds setup

AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
fi
if [ ! -d /opt/hub/.git ]; then sudo -u hub git "${AUTH[@]}" clone "$HUB_REPO_URL" /opt/hub
else sudo -u hub git "${AUTH[@]}" -C /opt/hub pull --ff-only; fi
sudo -u hub -H bash -c 'cd /opt/hub && pnpm install --frozen-lockfile && pnpm -F @hub/client build'
(cd /opt/hub && pnpm -F @hub/renderer exec playwright install-deps chromium)
sudo -u hub -H bash -c 'cd /opt/hub && pnpm -F @hub/renderer exec playwright install chromium'
[ -s /etc/hub/hub.env ] || install -o root -g root -m 600 /opt/hub/ops/hub/hub.env.example /etc/hub/hub.env
if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN" | /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN; fi

sudo -u hub -H bash -c 'test -x ~/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash'
sudo -u hub -H git config --global user.name "$HUB_GIT_NAME"
sudo -u hub -H git config --global user.email "$HUB_GIT_EMAIL"

install -o root -g root -m 644 /opt/hub/ops/hub/hub.service /etc/systemd/system/hub.service
systemctl daemon-reload
systemctl enable hub
tailscale serve --bg --https=443 http://127.0.0.1:8787

echo "Bootstrap done. Continue with docs/hub-bootstrap.md step 3."
```

`docs/hub-bootstrap.md` contains these numbered steps with these exact commands. The prose around them is up to the implementer.
1. **Create the server:**
   - Hetzner Cloud Console → Add server: Ubuntu 24.04, **CX32** (4 vCPU, 8 GB; 4 GB is the minimum), with your SSH key.
   - In the Tailscale admin console:
     - Enable **MagicDNS** and **HTTPS Certificates** (DNS page).
     - Create a one-off **auth key** (Settings → Keys).
   - Create a GitHub **fine-grained token** for your app repos with these permissions: Contents read/write, Pull requests read/write, Checks read, Commit statuses read, Metadata read.
2. **Run the bootstrap** from your laptop clone:
   - `scp ops/hub/bootstrap.sh root@<public-ip>:/root/`
   - `ssh root@<public-ip> 'TS_AUTHKEY=tskey-auth-… GITHUB_TOKEN=github_pat_… bash /root/bootstrap.sh'`
3. **Close public SSH**, after `ssh root@hub` over Tailscale works: `sudo ufw delete allow OpenSSH`. Also remove port 22 from any Hetzner Cloud Firewall.
4. **Log Claude Code in with your subscription** (never an API key): `sudo -u hub -H /var/lib/hub/.local/bin/claude setup-token`.
   - It prints a URL. Open it on your laptop or tablet, sign in with the Claude account that has the subscription, and paste the code back at `Paste code here if prompted`.
   - Copy the printed token, then run `sudo /opt/hub/ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN` and paste it.
   - The token lasts one year. Repeat this step to renew it.
5. **Set the passphrase** you will type on the tablet (≥ 12 characters):
   `read -rs -p 'Hub passphrase: ' P; echo; printf '%s' "$P" | sudo -u hub -H pnpm --silent --dir /opt/hub -F @hub/server hash-passphrase | sudo /opt/hub/ops/hub/set-secret.sh HUB_PASSPHRASE_HASH; unset P`
6. **Set the GitHub owner:** run `sudo nano /etc/hub/hub.env` and set `GITHUB_OWNER=<your GitHub user>`. If the bootstrap ran without `GITHUB_TOKEN`, also run `sudo /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN`.
7. **Check that Claude uses the subscription:** `sudo systemd-run --wait --pipe --quiet -p User=hub -p LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN /opt/hub/ops/hub/check-claude.sh` must print `OK`.
8. **Clone app repos** (one per app):
   `read -rs -p 'GitHub token: ' T; echo; sudo -u hub -H env T="$T" bash -c 'cd /var/lib/hub/apps && git -c http.https://github.com/.extraheader="AUTHORIZATION: basic $(printf "x-access-token:%s" "$T" | base64 -w0)" clone https://github.com/<owner>/<app>.git'; unset T`
9. **Start the hub:**
   - `sudo systemctl start hub && journalctl -u hub -n 20` shows `Hub listening on http://127.0.0.1:8787`.
   - `curl -s http://127.0.0.1:8787/api/health` prints `{"ok":true}`.
10. **On the tablet:**
    - Install Tailscale and join the tailnet.
    - Open `https://hub.<tailnet>.ts.net` in Chrome and unlock with the passphrase.
    - Menu → **Add to Home screen**.
11. **Update later:**
    `sudo -u hub -H bash -c 'cd /opt/hub && git pull --ff-only && pnpm install --frozen-lockfile && pnpm -F @hub/client build' && sudo systemctl restart hub`
12. **Known limits** (one short paragraph each):
    - Claude runs as the same Unix user as the hub. The deploy guard is a tool policy, not a sandbox.
    - Secrets are encrypted with the systemd host key (Hetzner CX servers have no TPM).

- [ ] **Step 1: Write the failing test** `apps/server/src/ops.test.ts` (`root = fileURLToPath(new URL('../../../', import.meta.url))`):
  - `scripts parse`: `execFileSync('bash', ['-n', f], { cwd: root })` succeeds for `ops/hub/bootstrap.sh`, `ops/hub/set-secret.sh` and `ops/hub/check-claude.sh`.
  - `nothing sets ANTHROPIC_API_KEY`: none of the six ops/docs files matches `/^\s*(export\s+)?ANTHROPIC_API_KEY=/m`.
  - `unit runs as hub with encrypted credentials and no API key`: `hub.service` contains each of these lines:
    - `User=hub`
    - `EnvironmentFile=/etc/hub/hub.env`
    - `LoadCredentialEncrypted=HUB_PASSPHRASE_HASH`
    - `LoadCredentialEncrypted=GITHUB_TOKEN`
    - `LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN`
    - `UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`
    - `ExecStart=/opt/hub/apps/server/node_modules/.bin/tsx /opt/hub/apps/server/src/main.ts`
    - `Restart=on-failure`
  - `env example holds only non-secret settings`: the keys matched by `/^([A-Z_]+)=/gm` toEqual `['HUB_BIND', 'HUB_PORT', 'HUB_DATA_DIR', 'HUB_APPS_DIR', 'GITHUB_OWNER']`, and none of them is in `CREDENTIAL_KEYS`.
  - `example env plus the passphrase credential loads`: `loadConfig({ ...parsedExample, HUB_PASSPHRASE_HASH: hashPassphrase('x'.repeat(12)) })` → `bind '127.0.0.1'`, `port 8787`.
  - `docs give the exact commands`: `docs/hub-bootstrap.md` contains `claude setup-token`, `set-secret.sh CLAUDE_CODE_OAUTH_TOKEN`, `check-claude.sh`, `tailscale serve --bg --https=443 http://127.0.0.1:8787` and `ufw delete allow OpenSSH`.
  - `set-secret only accepts known names`: `bash ops/hub/set-secret.sh BOGUS` exits 1 with stderr `Unknown secret BOGUS`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/ops.test.ts`. Expected: FAIL (files missing).
- [ ] **Step 3: Create** the six files. Mark the three scripts executable (`chmod +x`, committed with mode 755).
- [ ] **Step 4: Run** the same command. Expected: 7 pass. If `shellcheck` is installed, `shellcheck ops/hub/*.sh` is clean.
- [ ] **Step 5: Commit** `ops/hub docs/hub-bootstrap.md apps/server/src/ops.test.ts` as `docs(ops): hub server bootstrap with Tailscale, subscription login, encrypted credentials, systemd`, with the attribution trailer your harness provides.

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| §3 Hub API: Node + TS + Hono, SQLite for hub state | 3, 4, 20, 21 |
| §3 Claude Code via Agent SDK with subscription login; no API key (§1) | 9, 10, 29 (`setup-token`, `UnsetEnvironment`, `scrubEnv`) |
| §3 Git checkouts of every app, GitHub API | 7, 11, 12 |
| §3 Realtime: one WebSocket per tablet carrying streamed Claude output and render-ready events | 2, 8, 15, 22 (`render.ready` via `ServerTileSource`) |
| §3 Security: no public port, Tailscale only, Tailscale HTTPS cert | 3 (no wildcard bind), 29 (ufw, `tailscale serve`) |
| §3 Secrets stay on the hub, encrypted at rest, never sent to the client | 3 (credentials), 11 (header-only git auth), 20 (no secrets in responses), 29 (`systemd-creds`) |
| §3 Client: Preact PWA, < 150 KB gzipped | 24, 25, 26, 27 (size checks), 28 (offline shell) |
| Architecture: passphrase (scrypt) + httpOnly session cookie, both required with `HUB_BIND` | 3, 5, 6, 8 |
| Architecture: app registry with manifest zod schema in `@hub/protocol` | 1, 7 |
| §6 One chat per app, Claude Code session in the checkout, streamed, persisted, resumable | 13, 15, 18, 25 |
| §6 Branch only, never `main`; typecheck + tests, pushed branch, PR, CI | 9 (guard), 14, 16, 17, 18 |
| §6 Full permissions in the repo but cannot deploy | 9, 10 |
| §6 Merge only when CI is green (staging deploy hooks in via `onMerged`, plan 4) | 17, 20, 25 |
| §11 Usage limit is shown and the task is queued | 10, 15, 18 |
| Render manifests, tiles and hit maps served; server `TileSource` | 19, 22, 26 |
| §10 step 1: bootstrap, Tailscale, auth, PWA shell, app list, WebSocket | 21, 26, 27, 29 |
