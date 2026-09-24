#!/bin/bash
# Ambient Daemon Wrapper — installed by deploy/install.sh
# API key comes from the macOS Keychain, never from a file on disk.
# launchd manages the process lifecycle (restart on crash, start on login).

set -uo pipefail

ANTHROPIC_API_KEY=$(/usr/bin/security find-generic-password -a "ambient-daemon" -s "anthropic-api-key" -w 2>/dev/null || true)
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "ERROR: Keychain entry missing — run: security add-generic-password -a ambient-daemon -s anthropic-api-key -w <KEY>" >&2
  exit 1
fi
export ANTHROPIC_API_KEY

# Privacy gate key. If missing the daemon still starts, logs an error, and
# withholds ALL screen text from Claude (fail closed).
AMBIENT_GATE_API_KEY=$(/usr/bin/security find-generic-password -a "ambient-daemon" -s "openrouter-api-key" -w 2>/dev/null || true)
[ -n "$AMBIENT_GATE_API_KEY" ] && export AMBIENT_GATE_API_KEY

# set -a exports every client.env var so the node daemon sees them
# (OPERATOR_MODE, CLIENT_NAME, RETENTION_*_DAYS drive the dashboard).
if [ -f "$HOME/.ambient/client.env" ]; then
  set -a
  . "$HOME/.ambient/client.env"
  set +a
fi

exec "__NODE__" "__APP_DIR__/dist/cli.js" daemon
