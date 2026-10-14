#!/usr/bin/env bash
set -euo pipefail
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/CLAUDE_CODE_OAUTH_TOKEN")"
cd /var/lib/hub
exec /var/lib/hub/.local/bin/claude -p 'Reply with the single word OK.'
