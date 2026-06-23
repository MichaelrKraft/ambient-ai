# Phase 4 — Calendar + Meeting Prep (setup checklist)

This is the one remaining "Air Jelly" feature. It's deferred until the Google
Cloud OAuth client below exists. Nothing is built yet; this file is the
prerequisite checklist so the build can proceed cleanly when you're ready.

## What it will do (once built + connected)
- Ambient reads your Google Calendar (read-only) each cycle.
- ~15 min before a meeting, it generates a prep brief — attendees, related past
  notes (from your knowledge FTS), and any open tasks — and pushes it as a
  notification (system + Telegram) and an Obsidian note.
- It's the highest-priority proactive alert and is gated behind
  `config.calendar.enabled` (default off), so it never affects the
  Obsidian-only path until you opt in.

## Your one-time setup (≈10 min)
1. **Google Cloud project** — go to https://console.cloud.google.com, create (or
   reuse) a project.
2. **Enable the Google Calendar API** — APIs & Services → Library → "Google
   Calendar API" → Enable.
3. **OAuth consent screen** — APIs & Services → OAuth consent screen →
   External → add yourself as a Test user (no verification needed for personal
   use). Add scope `.../auth/calendar.events.readonly`.
4. **OAuth client ID** — Credentials → Create Credentials → OAuth client ID →
   **Desktop app**. Download the JSON (client_id + client_secret).
5. Tell me when that JSON exists. I'll then build the code and you'll run
   `ambient calendar connect` once — it opens a browser, you approve, and the
   refresh token is stored in macOS Keychain (service `ai.ambient.calendar`).
   Access tokens are refreshed silently after that.

## What I'll build when you're ready
- `src/config/index.ts` — opt-in `calendar` config section.
- Migration v7 — `calendar_events` table (event_id PK for dedup, summary, start,
  end, attendees JSON, briefed_at, is_pii_flagged). Event titles/attendees are
  PII → filtered before storage, same as knowledge.
- `src/calendar/keychain.ts` — own keychain namespace (not the LeadSpot one).
- `src/calendar/CalendarClient.ts` — `@googleapis/calendar`, read-only scope,
  silent token refresh.
- Daemon hook (gated on `calendar.enabled`) + `checkUpcomingMeetings()` as the
  #1 priority proactive check, deduped on `[mtg:<eventId>]` + `briefed_at`.
- `ambient calendar connect` CLI (interactive loopback OAuth).
- Meeting rows added to the enriched daily report's "Tomorrow's priorities".
