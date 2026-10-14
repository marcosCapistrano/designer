#!/usr/bin/env bash
# Fresh Hetzner Ubuntu 24.04, as root. Two secrets arrive on stdin, one per line, and either may be empty:
#   line 1: the GitHub token    line 2: a one-off Tailscale auth key
# Typing them into a command line would leave them in the shell history and in `ps`, so docs/hub-bootstrap.md
# step 2 pipes them in:  printf '%s\n%s\n' "$GH" "$TS" | ssh root@<public-ip> 'bash /root/bootstrap.sh'
# On a terminal the script asks for them without echo. Re-running it is allowed, but it re-allows public SSH:
# repeat docs step 3 afterwards.
set -euo pipefail
HUB_REPO_URL="${HUB_REPO_URL:-https://github.com/marcosCapistrano/designer.git}"
HUB_GIT_NAME="${HUB_GIT_NAME:-Hub}"
HUB_GIT_EMAIL="${HUB_GIT_EMAIL:-hub@localhost}"
PNPM_VERSION="10.28.0"
[ "$(id -u)" -eq 0 ] || { echo "Run as root" >&2; exit 1; }
if grep -qs '^ANTHROPIC_API_KEY=' /etc/environment; then echo "Remove ANTHROPIC_API_KEY from /etc/environment first" >&2; exit 1; fi

# The secrets stay in these plain shell variables. They are never exported, because the installers below run
# with `curl | bash` and would inherit them, and each is unset after its last use.
secret_line() {
  local line=""
  if [ -t 0 ]; then
    read -rsp "$1" line || true
    echo >&2
  else
    IFS= read -r line || true
  fi
  printf '%s' "$line"
}
github_token="$(secret_line 'GitHub token (blank for none): ')"
ts_authkey="$(secret_line 'Tailscale auth key (blank to log in by URL): ')"
# Nothing after this point should read the rest of the pipe.
[ -t 0 ] || exec </dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git build-essential python3 ufw

if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g "pnpm@${PNPM_VERSION}"

command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
if ! tailscale status >/dev/null 2>&1; then
  ts_up=(up --ssh --hostname=hub)
  # The one place a secret is on a command line: `tailscale up` takes the key as an argument. The key is one-off
  # (docs step 2 revokes it) and the server has no other users yet.
  if [ -n "$ts_authkey" ]; then ts_up+=("--authkey=$ts_authkey"); fi
  tailscale "${ts_up[@]}"
fi
unset ts_authkey

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
if [ -n "$github_token" ]; then
  GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$github_token" | base64 -w0)"
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
if [ -n "$github_token" ]; then printf '%s' "$github_token" | /opt/hub/ops/hub/set-secret.sh GITHUB_TOKEN; fi
unset github_token GIT_AUTH_HEADER

sudo -u hub -H bash -c 'test -x ~/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash'
sudo -u hub -H git config --global user.name "$HUB_GIT_NAME"
sudo -u hub -H git config --global user.email "$HUB_GIT_EMAIL"

install -o root -g root -m 644 /opt/hub/ops/hub/hub.service /etc/systemd/system/hub.service
systemctl daemon-reload
systemctl enable hub
tailscale serve --bg --https=443 http://127.0.0.1:8787

echo "Bootstrap done. Continue with docs/hub-bootstrap.md step 3."
