#!/usr/bin/env bash
# Run under systemd with LoadCredentialEncrypted=CLAUDE_CODE_OAUTH_TOKEN (docs/hub-bootstrap.md step 7).
set -euo pipefail
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
# Assigned before it is exported: `export X="$(cat …)"` would report export's success and hide a failed cat.
CLAUDE_CODE_OAUTH_TOKEN="$(cat "${CREDENTIALS_DIRECTORY:?not run under systemd with the credential}/CLAUDE_CODE_OAUTH_TOKEN")"
export CLAUDE_CODE_OAUTH_TOKEN
cd /var/lib/hub
exec /var/lib/hub/.local/bin/claude -p 'Reply with the single word OK.'
