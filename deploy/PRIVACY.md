# Ambient — What Leaves This Machine (Privacy Audit)

_Audited 2026-07-16; updated 2026-09-24 for the privacy gate (branch `feat/privacy-gate`). Re-audit before any client install if the daemon code has changed._

## The short version

Everything is recorded and stored **locally**. Three things leave the machine:

1. **Screen text → privacy gate (Jev, via OpenRouter)** (`openrouter.ai`, served by TypeSafe AI). Before anything goes to Claude, each screen's text is checked by Jev with four yes/no questions (personal info, money, secrets, "should never be recorded"). Requests require OpenRouter's zero-data-retention routing (`provider.zdr: true`); OpenRouter refuses the call if no zero-retention endpoint is available, and the gate then withholds. TypeSafe's own policy: it does not train on inputs. Obvious patterns (emails, card numbers, SSNs, key=value secrets) are regex-scrubbed before this step.
2. **Screen text that passed the gate → Anthropic API** (`api.anthropic.com`). Every ~7 minutes, for the activity summary; and for web pages the user reads for a while, to pull out topics. Screens the gate judged private are sent only as `[App] (private content withheld)` — no text, no window title. Anthropic's API terms: API data is not used for model training by default.
3. **Operator alerts → Resend** (`api.resend.com`). The watchdog emails the operator (not the client) when a component breaks/self-heals. Content: component names and timestamps only — never screen content.

Screen **video never leaves the machine**. The dashboard is local-only (`localhost:3741`, bound locally).

## Full outbound inventory (from source)

| Destination | When | What | Gate |
|---|---|---|---|
| `openrouter.ai` → TypeSafe (Jev) | every ~7 min while active | each unique screen's OCR text (regex-scrubbed), app + window name | `config.privacyGate.enabled` (default on); key in Keychain `ambient-daemon` / `openrouter-api-key`; zero-retention routing required |
| `api.anthropic.com` | every ~7 min while active | gate-approved OCR text, app/window names, goals list; private screens as placeholders | always on (core function) |
| `api.anthropic.com` (web topics) | when a browser page is read ≥ dwell threshold | page title + OCR text of gate-approved pages only | always on |
| `api.resend.com` | on watchdog alert | job name, timestamp, component status | `RESEND_API_KEY` in client.env |
| `coder1.ai` (sync) | never by default | activity summaries | requires explicit token setup |
| `app.leadspot.ai` | never | — | `enabled: false` in defaults; product retired — module should be deleted before client v1 |

## Known gaps (fix before first client install)

- ~~PII filter runs on outputs, not inputs~~ — CLOSED by the privacy gate (`src/analysis/PrivacyGate.ts`), which covers BOTH outbound paths: the activity summary and the browser-topics call (`extractBrowserTopics`, which this audit originally missed). Fails closed: missing key, timeout or error → text withheld.
- ~~Excluded-apps list not yet enforced~~ — this was wrong. Apps in `config.json` `ignoreApps` (default Finder, System Settings, loginwindow) plus a built-in system list are dropped at fetch time in `ScreenpipeClient`, before any analysis. There is no client.env toggle; edit `ignoreApps`.
- **Gate accuracy is measured on 30 frames only** (2026-09-24: 5/6 private screens withheld, the miss was Finder which `ignoreApps` already drops; ~5/24 false alarms). Before a client install, label ~200 of that client's frames and rerun `scripts/privacy-gate-eval.ts`.
- **Screenpipe binary telemetry unverified.** The OSS screenpipe may emit its own telemetry — verify and disable via flag before client installs.
- **Dead LeadSpot module** still in the codebase — delete `src/leadspot/` for the client build.

## Local data & retention (enforced nightly at 3 AM)

| Data | Where | Kept |
|---|---|---|
| Screen video | `~/.screenpipe/data` | 7 days (configurable per client) |
| Screen text (OCR) | `~/.screenpipe/db.sqlite` | 14 days (configurable) |
| Analysis summaries | `~/.ambient/ambient.db` | indefinitely (text only, PII-scrubbed) |

## Client controls

- **Pause switch**: `~/.ambient/bin/ambient-pause.sh pause` — capture stops immediately; the watchdog will not restart it until `resume`.
- API keys (Anthropic, and OpenRouter for the gate) live in the macOS Keychain, not in any file.
- Gate off switch: set `"privacyGate": { "enabled": false }` in `~/.ambient/config.json` (NOT recommended — raw screen text then goes to Claude).
