#!/bin/bash
# ambient-pause.sh [pause|resume|status] — the privacy kill switch.
# pause  : stops screen capture immediately and marks the system paused
#          (the watchdog sees the marker and will NOT restart anything).
# resume : removes the marker and restarts capture + analysis.
# status : prints current state.
#
# Design note: we bootout the screenpipe LaunchAgent (not just kill the
# process) so launchd's KeepAlive can't resurrect it while paused.

MARKER="$HOME/.ambient/paused"
UID_N=$(id -u)
SP_LABEL="com.coder1.screenpipe"
SP_PLIST="$HOME/Library/LaunchAgents/$SP_LABEL.plist"

case "${1:-status}" in
  pause)
    mkdir -p "$HOME/.ambient"
    date "+paused at %Y-%m-%d %H:%M:%S" > "$MARKER"
    launchctl bootout "gui/$UID_N/$SP_LABEL" 2>/dev/null
    pkill -f "/opt/homebrew/bin/screenpipe" 2>/dev/null
    echo "Capture PAUSED. Nothing is being recorded. Resume with: ambient-pause.sh resume"
    ;;
  resume)
    rm -f "$MARKER"
    launchctl bootstrap "gui/$UID_N" "$SP_PLIST" 2>/dev/null \
      || launchctl kickstart "gui/$UID_N/$SP_LABEL" 2>/dev/null
    echo "Capture RESUMED. Recording is active again."
    ;;
  status)
    if [ -f "$MARKER" ]; then
      echo "PAUSED ($(cat "$MARKER"))"
    elif pgrep -f "/opt/homebrew/bin/screenpipe" >/dev/null; then
      echo "RECORDING"
    else
      echo "NOT RECORDING (not paused — capture may be down; watchdog will restart it)"
    fi
    ;;
  *)
    echo "Usage: ambient-pause.sh [pause|resume|status]"; exit 1
    ;;
esac
