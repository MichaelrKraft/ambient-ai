#!/bin/bash
# Cleanup old Screenpipe capture sessions and npm cache
# Runs daily via LaunchAgent

LOG="/tmp/cleanup-screenpipe.log"
echo "$(date): Starting cleanup" >> "$LOG"

# Per-client retention overrides (defaults preserve original 7/14-day windows)
[ -f "$HOME/.ambient/client.env" ] && . "$HOME/.ambient/client.env"
VIDEO_DAYS="${RETENTION_VIDEO_DAYS:-7}"
OCR_DAYS="${RETENTION_OCR_DAYS:-14}"

# Delete capture sessions older than retention window
find ~/.screenpipe/capture-sessions -type d -mtime +"$VIDEO_DAYS" -exec rm -rf {} + 2>/dev/null
echo "$(date): Cleaned capture sessions older than $VIDEO_DAYS days" >> "$LOG"

# Delete Screenpipe videos older than retention window
find ~/.screenpipe/data -type f -mtime +"$VIDEO_DAYS" -delete 2>/dev/null
echo "$(date): Cleaned video data older than $VIDEO_DAYS days" >> "$LOG"

# Prune the Screenpipe OCR database older than 14 days.
# This is the bulk of disk growth — the DB was never pruned before and had
# grown to 1.3GB / 878k rows, making screenpipe's /search take ~10s. Keeping
# 14 days holds it to ~50k rows and sub-second searches. DELETE only (no
# VACUUM): VACUUM requires screenpipe's sqlite-vec extension, and SQLite reuses
# the freed pages, so the file stays bounded without it. Runs safely while
# screenpipe is live (WAL mode allows concurrent writes).
DB="$HOME/.screenpipe/db.sqlite"
if [ -f "$DB" ]; then
  sqlite3 "$DB" "PRAGMA busy_timeout=15000;
DELETE FROM ocr_text_fts WHERE frame_id IN (SELECT id FROM frames WHERE timestamp < datetime('now','-$OCR_DAYS days'));
DELETE FROM ocr_text     WHERE frame_id IN (SELECT id FROM frames WHERE timestamp < datetime('now','-$OCR_DAYS days'));
DELETE FROM frames       WHERE timestamp < datetime('now','-$OCR_DAYS days');
DELETE FROM video_chunks WHERE id NOT IN (SELECT DISTINCT video_chunk_id FROM frames WHERE video_chunk_id IS NOT NULL);" 2>>"$LOG"
  echo "$(date): Pruned OCR database older than $OCR_DAYS days" >> "$LOG"
fi

# Delete old Screenpipe logs (keep last 3 days)
find ~/.screenpipe -name "*.log" -mtime +3 -delete 2>/dev/null
echo "$(date): Cleaned old logs" >> "$LOG"

# Clean npx cache older than 14 days (these can be re-downloaded)
find ~/.npm/_npx -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
echo "$(date): Cleaned npx cache older than 14 days" >> "$LOG"

echo "$(date): Cleanup complete" >> "$LOG"
