#!/bin/bash
# alert.sh <job-name> <message> — operator alert for Ambient client installs.
# Reads ALERT_TO / RESEND_API_KEY / CLIENT_NAME from ~/.ambient/client.env.
# Falls back to Mike's alert-mike.sh if no client.env key is present (dev box).
# Always exits 0 — a broken alert must never break the calling job.

JOB="${1:-unknown-job}"
MSG="${2:-no details provided}"

CLIENT_ENV="$HOME/.ambient/client.env"
[ -f "$CLIENT_ENV" ] && . "$CLIENT_ENV"

if [ -z "$RESEND_API_KEY" ]; then
  # Dev-box fallback (Mike's machine keeps its existing channel)
  FALLBACK="$HOME/.claude/scripts/alert-mike.sh"
  [ -x "$FALLBACK" ] && "$FALLBACK" "$JOB" "$MSG"
  exit 0
fi

TO="${ALERT_TO:-poolkraftllc@gmail.com}"
FROM="alerts@done-deal.co"
TS=$(date "+%Y-%m-%d %H:%M:%S %Z")
SUBJ_CLIENT="${CLIENT_NAME:-unknown-client}"

PAYLOAD=$(python3 - "$JOB" "$MSG" "$TS" "$TO" "$FROM" "$SUBJ_CLIENT" <<'PY'
import json, sys
job, msg, ts, to, frm, client = sys.argv[1:7]
print(json.dumps({
    "from": f"Ambient Alerts <{frm}>",
    "to": [to],
    "subject": f"[{client}] {job} — {ts}",
    "text": f"Client: {client}\nJob: {job}\nTime: {ts}\n\n{msg}\n\n-- ambient alert.sh",
}))
PY
)

curl -sS --max-time 15 -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1

exit 0
