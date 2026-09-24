#!/bin/bash
# install.sh — white-glove Ambient install for a client Mac.
# Run from the repo's deploy/ directory:  bash deploy/install.sh
# Idempotent: safe to re-run (reloads agents, keeps existing config/keychain).
#
# What it sets up:
#   - Screenpipe (brew) + LaunchAgent (screen capture, 0.2 fps, no audio)
#   - Ambient daemon (built from this repo) + LaunchAgent
#   - Nightly cleanup (retention windows) + watchdog (self-healing, 10 min)
#   - ~/.ambient/{bin,logs}, client.env, API key in macOS Keychain

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$DEPLOY_DIR")"
BIN="$HOME/.ambient/bin"
LA="$HOME/Library/LaunchAgents"
UID_N=$(id -u)

step() { echo ""; echo "==> $1"; }

step "Preflight"
[ "$(uname)" = "Darwin" ] || { echo "macOS only"; exit 1; }
command -v brew >/dev/null || { echo "Homebrew required: https://brew.sh"; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ required (brew install node@20)"; exit 1; }
# 5 GB free minimum — capture + OCR DB need steady headroom (learned 2026-07-16)
FREE_GB=$(df -g / | awk 'NR==2 {print $4}')
[ "$FREE_GB" -ge 5 ] || { echo "Only ${FREE_GB}GB free — need 5GB+. Clean up first."; exit 1; }
NODE_BIN="$(command -v node)"
echo "app dir: $APP_DIR | node: $NODE_BIN | free: ${FREE_GB}GB"

step "Screenpipe"
command -v screenpipe >/dev/null || brew install screenpipe
SP_BIN="$(command -v screenpipe)"

step "Build Ambient"
(cd "$APP_DIR" && npm install --no-audit --no-fund && npm run build)
[ -f "$APP_DIR/dist/cli.js" ] || { echo "Build failed — dist/cli.js missing"; exit 1; }

step "Directories + scripts"
mkdir -p "$BIN" "$HOME/.ambient/logs"
for s in ambient-watchdog.sh cleanup-screenpipe.sh alert.sh ambient-pause.sh; do
  cp "$DEPLOY_DIR/$s" "$BIN/$s" && chmod +x "$BIN/$s"
done
sed -e "s|__NODE__|$NODE_BIN|" -e "s|__APP_DIR__|$APP_DIR|" \
  "$DEPLOY_DIR/templates/ambient-start.sh" > "$BIN/ambient-start.sh"
chmod +x "$BIN/ambient-start.sh"

step "Config"
if [ ! -f "$HOME/.ambient/client.env" ]; then
  sed "s|AMBIENT_DIR=\"\$HOME/ambient\"|AMBIENT_DIR=\"$APP_DIR\"|" \
    "$DEPLOY_DIR/client.env.example" > "$HOME/.ambient/client.env"
  chmod 600 "$HOME/.ambient/client.env"
  echo "Created ~/.ambient/client.env — EDIT IT (client name, alert Resend key)"
else
  echo "Keeping existing ~/.ambient/client.env"
fi

step "Anthropic API key (macOS Keychain)"
if ! security find-generic-password -a ambient-daemon -s anthropic-api-key -w >/dev/null 2>&1; then
  read -r -s -p "Paste the client's Anthropic API key: " KEY; echo ""
  [ -n "$KEY" ] || { echo "No key entered"; exit 1; }
  security add-generic-password -a ambient-daemon -s anthropic-api-key -w "$KEY"
  unset KEY
else
  echo "Keychain entry already present — keeping it"
fi

step "Privacy gate key — OpenRouter, for Jev (macOS Keychain)"
# Without it the daemon withholds ALL screen text from Claude (fail closed).
if ! security find-generic-password -a ambient-daemon -s openrouter-api-key -w >/dev/null 2>&1; then
  read -r -s -p "Paste the client's OpenRouter key (capped, privacy gate only): " KEY; echo ""
  [ -n "$KEY" ] || { echo "No key entered"; exit 1; }
  security add-generic-password -a ambient-daemon -s openrouter-api-key -w "$KEY"
  unset KEY
else
  echo "Keychain entry already present — keeping it"
fi

step "LaunchAgents"
mkdir -p "$LA"
for p in com.coder1.screenpipe com.coder1.ambient com.coder1.cleanup-screenpipe com.coder1.ambient-watchdog; do
  sed -e "s|__HOME__|$HOME|g" -e "s|/opt/homebrew/bin/screenpipe|$SP_BIN|" \
    "$DEPLOY_DIR/templates/$p.plist" > "$LA/$p.plist"
  launchctl bootout "gui/$UID_N/$p" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$LA/$p.plist"
  echo "loaded $p"
done

step "Done"
cat <<'EOF'
NEXT STEPS (manual, on the client's screen):
 1. macOS will ask for Screen Recording permission for screenpipe the first
    time it captures — System Settings > Privacy & Security > Screen Recording
    must show screenpipe enabled, then restart it:
      launchctl kickstart -k gui/$(id -u)/com.coder1.screenpipe
 2. Edit ~/.ambient/client.env (CLIENT_NAME, RESEND_API_KEY for alerts).
 3. Verify in ~30 min: dashboard at http://localhost:3741 shows activity.
 4. Privacy controls: ~/.ambient/bin/ambient-pause.sh [pause|resume|status]
EOF
