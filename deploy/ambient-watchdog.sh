#!/bin/bash
# ambient-watchdog.sh — health check for Screenpipe + the Ambient daemon.
# Run every 10 min by com.coder1.ambient-watchdog LaunchAgent.
#
# Checks:
#   1. Screenpipe is actually writing frames (newest mp4 chunk < 15 min old,
#      no "Error comparing images" stall loop in the recent log).
#      On failure: auto-restart via launchctl kickstart + alert.
#   2. Ambient daemon's build exists (dist/cli.js — its known silent-death mode)
#      and its DB has a recent activity session whenever Screenpipe is active.
#      On failure: alert (build loss needs a manual `npm run build`).
#
# Alerts: email via alert-mike.sh + macOS notification, max one email per
# check per 6h (cooldown markers in ~/.coder1/state/watchdog/).
#
# Logging: appends to ~/.coder1/logs/ambient-watchdog.log, self-truncated to
# the last 500 lines on every run. No PII/secrets — status lines only.

DATA="$HOME/.screenpipe/data"
SP_LOG_DIR="$HOME/.screenpipe"
AMBIENT_DIR="${AMBIENT_DIR:-$HOME/autonomous_vibe_interface/coder1-ambient}"
AMBIENT_DB="$HOME/.ambient/ambient.db"
STATE="$HOME/.coder1/state/watchdog"
LOG="$HOME/.coder1/logs/ambient-watchdog.log"
RECEIPT="$HOME/.claude/scripts/write-receipt.sh"
COOLDOWN_SECS=$((6 * 3600))

# Per-client config (client installs); absent on the dev box is fine.
[ -f "$HOME/.ambient/client.env" ] && . "$HOME/.ambient/client.env"

# Alert channel: parameterized alert.sh if the deploy kit is present,
# else Mike's alert-mike.sh (both no-op safely on failure).
ALERT="$AMBIENT_DIR/deploy/alert.sh"
[ -x "$ALERT" ] || ALERT="$HOME/.claude/scripts/alert-mike.sh"

# Pause switch: when the user has intentionally paused capture, do nothing —
# the watchdog must not fight ambient-pause by resurrecting screenpipe.
if [ -f "$HOME/.ambient/paused" ]; then
  echo "$(date "+%Y-%m-%d %H:%M:%S") paused (marker present) — all checks skipped" >> "$LOG"
  exit 0
fi

mkdir -p "$STATE" "$(dirname "$LOG")"
NOW=$(date "+%Y-%m-%d %H:%M:%S")
ISSUES=""

log() { echo "$NOW $1" >> "$LOG"; }

notify() { # notify <check-id> <message>
  local id="$1" msg="$2" marker="$STATE/$1.alerted"
  local last=0
  [ -f "$marker" ] && last=$(stat -f %m "$marker" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - last )) -ge "$COOLDOWN_SECS" ]; then
    "$ALERT" "ambient-watchdog/$id" "$msg"
    touch "$marker"
    log "ALERT sent [$id]: $msg"
  else
    log "ALERT suppressed (cooldown) [$id]: $msg"
  fi
  osascript -e "display notification \"$msg\" with title \"Ambient watchdog: $id\"" 2>/dev/null
}

healthy() { rm -f "$STATE/$1.alerted"; } # clear cooldown once check passes

# ---------- Check 1: Screenpipe actually recording ----------
# 35 min window: chunks can run 15+ min and in-progress files don't update
# mtime until flushed, so a tighter window false-positives during normal use.
NEWEST=$(find "$DATA" -name 'monitor_*.mp4' -mmin -35 2>/dev/null | head -1)
SP_LOG=$(ls -t "$SP_LOG_DIR"/screenpipe.*.log 2>/dev/null | head -1)
STALLED=$(tail -10 "$SP_LOG" 2>/dev/null | grep -c "Error comparing images")

if [ -z "$NEWEST" ] || [ "$STALLED" -ge 5 ]; then
  REASON="no chunk written in 35 min"
  [ "$STALLED" -ge 5 ] && REASON="stall loop in log (image-dimension errors — usually a display change)"
  launchctl kickstart -k "gui/$(id -u)/com.coder1.screenpipe" 2>/dev/null
  log "screenpipe UNHEALTHY ($REASON) — restarted"
  notify "screenpipe" "Screenpipe stopped recording ($REASON). Auto-restarted it; check ~/.screenpipe logs if this repeats."
  ISSUES="${ISSUES}screenpipe "
else
  healthy "screenpipe"
fi

# ---------- Check 2a: Ambient build present (auto-rebuild if missing) ----------
if [ ! -f "$AMBIENT_DIR/dist/cli.js" ]; then
  log "ambient UNHEALTHY (dist/cli.js missing — daemon is crash-looping)"
  # Auto-rebuild, but at most once per cooldown window so a genuinely broken
  # build can't loop (build-safety rule: max 2 attempts, then humans).
  REBUILD_MARKER="$STATE/ambient-rebuild.attempted"
  RB_LAST=0
  [ -f "$REBUILD_MARKER" ] && RB_LAST=$(stat -f %m "$REBUILD_MARKER" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - RB_LAST )) -ge "$COOLDOWN_SECS" ]; then
    touch "$REBUILD_MARKER"
    log "attempting ambient auto-rebuild..."
    (
      cd "$AMBIENT_DIR" || exit 1
      [ -d node_modules ] || npm install --no-audit --no-fund >> "$LOG" 2>&1
      npm run build >> "$LOG" 2>&1
    )
    if [ -f "$AMBIENT_DIR/dist/cli.js" ]; then
      launchctl kickstart -k "gui/$(id -u)/com.coder1.ambient" 2>/dev/null
      log "ambient auto-rebuild SUCCEEDED — daemon restarted"
      notify "ambient-build" "Ambient's build (dist/cli.js) went missing again. Watchdog rebuilt it automatically and restarted the daemon — no action needed, but something keeps deleting dist/."
    else
      notify "ambient-build" "Ambient's build (dist/cli.js) is missing and the automatic rebuild FAILED. Manual fix needed: cd $AMBIENT_DIR && npm install && npm run build, then launchctl kickstart -k gui/$(id -u)/com.coder1.ambient. Build output is in ~/.coder1/logs/ambient-watchdog.log"
    fi
  else
    log "ambient rebuild skipped (already attempted within cooldown)"
    notify "ambient-build" "Ambient build still missing and auto-rebuild was already attempted recently — needs manual attention: cd $AMBIENT_DIR && npm run build"
  fi
  ISSUES="${ISSUES}ambient-build "
else
  healthy "ambient-build"
  rm -f "$STATE/ambient-rebuild.attempted"
fi

# ---------- Check 2b: Ambient producing analysis while screen is active ----------
# Only meaningful when screenpipe has a fresh chunk (user active) and the build exists.
if [ -n "$NEWEST" ] && [ -f "$AMBIENT_DIR/dist/cli.js" ]; then
  LAST_EPOCH=$(sqlite3 "$AMBIENT_DB" "SELECT CAST(strftime('%s', MAX(period_start)) AS INTEGER) FROM activity_sessions;" 2>/dev/null)
  if [ -n "$LAST_EPOCH" ] && [ "$LAST_EPOCH" -gt 0 ] 2>/dev/null; then
    AGE_MIN=$(( ( $(date -u +%s) - LAST_EPOCH ) / 60 ))
    if [ "$AGE_MIN" -gt 90 ]; then
      # Restart at most once per hour. Screenpipe records the locked screen, so
      # overnight this check reads "screen active + no analysis" and would
      # otherwise bounce a healthy-but-idle daemon every 10 minutes.
      RESTART_MARK="$STATE/ambient-analysis.restarted"
      if [ -z "$(find "$RESTART_MARK" -mmin -60 2>/dev/null)" ]; then
        launchctl kickstart -k "gui/$(id -u)/com.coder1.ambient" 2>/dev/null
        touch "$RESTART_MARK"
        log "ambient UNHEALTHY (screen active but last analysis ${AGE_MIN} min ago) — restarted"
      else
        log "ambient still stale (${AGE_MIN} min) — restart skipped (cooldown)"
      fi
      notify "ambient-analysis" "Ambient hasn't analyzed anything in ${AGE_MIN} min while the screen is active. Auto-restarted the daemon; check ~/.coder1/logs/ambient-daemon.error.log if this repeats."
      ISSUES="${ISSUES}ambient-analysis "
    else
      healthy "ambient-analysis"
    fi
  fi
fi

# ---------- Wrap up ----------
if [ -z "$ISSUES" ]; then
  log "OK (screenpipe fresh, ambient build present, analysis current)"
fi
"$RECEIPT" "ambient-watchdog" "checks=3 issues=${ISSUES:-none}" 2>/dev/null

# keep the log bounded
tail -500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
