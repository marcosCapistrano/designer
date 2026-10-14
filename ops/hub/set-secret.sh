#!/usr/bin/env bash
# Usage: sudo ops/hub/set-secret.sh NAME   (value from stdin, or typed silently)
set -euo pipefail
name="${1:-}"
case "$name" in HUB_PASSPHRASE_HASH|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN) ;; *) echo "Unknown secret $name" >&2; exit 1 ;; esac
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
install -d -m 700 /etc/credstore.encrypted
value=""
if [ -t 0 ]; then
  read -rs -p "$name: " value || true
  echo
elif ! { IFS= read -r value || [ -n "$value" ]; }; then
  # End of input with nothing before it. Inside an `if`, so set -e does not end the script before this message.
  echo "Empty value" >&2
  exit 1
fi
[ -n "$value" ] || { echo "Empty value" >&2; exit 1; }
printf '%s' "$value" | systemd-creds encrypt --name="$name" - "/etc/credstore.encrypted/$name"
echo "Stored $name encrypted. Apply with: sudo systemctl restart hub"
