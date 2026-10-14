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

# The GitHub header never goes on an argv. It is piped into a hub-side shell, which exports it as git's
# environment (GIT_CONFIG_COUNT/KEY/VALUE), so git reads it without any argument carrying the token.
GIT_AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
fi
hub_git() {
  printf '%s\n' "$GIT_AUTH_HEADER" | sudo -u hub -H bash -c '
    IFS= read -r header || true
    if [ -n "$header" ]; then
      export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="$header"
    fi
    exec git "$@"
  ' git "$@"
}
if [ ! -d /opt/hub/.git ]; then hub_git clone "$HUB_REPO_URL" /opt/hub
else hub_git -C /opt/hub pull --ff-only; fi
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
