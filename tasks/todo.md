# Ambient Dashboard Enhancements (current task)

Three requested features. All additive, minimal-impact.

## 1. Time breakdown ("Time" tab)
- [ ] `getTimeBreakdown(hoursBack)` in AmbientStore — sum session durations grouped by category and by primary_app
- [ ] `GET /api/breakdown?hours=` endpoint in server.ts
- [ ] "Time" nav tab + section in index.html
- [ ] `loadBreakdown()` renderer with proportional bars in app.js
- [ ] bar styles in styles.css
- Note: Screenpipe stores app-level activity only (no per-URL), so "websites" = grouped by app/browser.

## 2. Global Ask bar (not a tab)
- [ ] Remove "Ask" nav tab + #ask section from index.html
- [ ] Add persistent ask bar between nav and main (sticky), collapsible answer panel
- [ ] Rewire sendAsk() to the global bar; drop ask from the tab router
- [ ] ask-bar styles

## 3. Goals — type out a goal
- [x] `POST /api/goals` endpoint (insertGoal + crypto.randomUUID, title required)
- [x] Add-goal form (title, optional description, optional target date) in goals section
- [x] Wire form submit → POST → reload goals

## Review (this task)
- All three done. `tsc --noEmit` exit 0, `npm run build` exit 0, web files copied to dist.
- Time breakdown SQL validated read-only against real DB: byCategory (coding/browsing/…) and byApp (Claude/Chrome/Terminal/…) return correct minutes.
- Files: `src/storage/AmbientStore.ts` (getTimeBreakdown), `src/web/server.ts` (GET /api/breakdown, POST /api/goals), `src/web/public/{index.html,app.js,styles.css}`.
- NOT YET LIVE: launchd daemon (com.coder1.ambient) still runs old dist; needs restart to serve the new dashboard. Awaiting confirmation per safety rule.

---

# Ambient Distribution - Todo List

## Phase 1: UX Improvements

- [x] Create `src/setup/validators.ts` - Check Screenpipe, API key, etc.
- [x] Create `src/setup/wizard.ts` - Interactive setup flow with prompts
- [x] Create `src/postinstall.ts` - Welcome message after npm install
- [x] Update `src/cli.ts` - Renamed to ambient, integrated wizard
- [x] Update `src/config/index.ts` - Better error messages

## Phase 2: Package Preparation

- [x] Update `package.json` - Renamed to ambient-ai, added metadata
- [x] Create `.npmignore` - Exclude src/, dev files
- [x] Create `README.md` - Full documentation
- [x] Update all CLI references from `coder1-ambient` to `ambient`
- [x] Update data directory from `.coder1-ambient` to `.ambient`
- [x] Add build step for web public files

## Phase 3: Test & Publish

- [x] Run `npm run build` - Build succeeds
- [x] Run `npm pack` - Creates tarball (124.6 kB)
- [x] Test global install locally - Works!
- [ ] Create GitHub repo `MichaelrKraft/ambient-ai`
- [ ] Push code to GitHub
- [ ] Publish to npm

## Phase 4: Homebrew Formula

- [ ] Create tap repo `MichaelrKraft/homebrew-ambient`
- [ ] Generate SHA256 from npm tarball
- [ ] Write `Formula/ambient-ai.rb`
- [ ] Test Homebrew install locally
- [ ] Push formula to tap

---

## Review

### Changes Made

1. **New Setup Wizard** (`src/setup/wizard.ts`)
   - Interactive prompts for Screenpipe installation
   - API key validation with test request
   - Offers to add key to shell profile
   - Visual feedback with checkmarks/X marks

2. **Validators** (`src/setup/validators.ts`)
   - Checks if Screenpipe is installed (not just running)
   - Validates API key format and tests with API call
   - Detects shell profile type (zsh/bash)
   - Checks Obsidian vault accessibility

3. **Package Metadata**
   - Name: `ambient-ai`
   - CLI command: `ambient`
   - Data directory: `~/.ambient`
   - Full README with documentation

4. **Build Process**
   - Copies web public files to dist/
   - Package size: 124.6 kB

### Next Steps

1. Create GitHub repo `MichaelrKraft/ambient-ai`
2. Push code
3. Run `npm publish`
4. Create Homebrew tap and formula

---

# Privacy Gate — Jev screens screen text before it leaves the Mac (planned 2026-09-24)

**Goal:** no private screen reaches Anthropic. Every screen snapshot passes a gate first:
excluded app → dropped; Jev says private → text withheld; only the rest goes to Claude.

**Evidence it works (2026-09-24 test, 30 real frames, hand-labeled):** Jev at threshold 0.4
caught 6/6 private screens (child's name, agent roster, client invoice email, draft contract,
Notes w/ medication, Finder w/ NDA) with ~5/24 false alarms. Current regex `PIIFilter` caught 0.
Cost ≈ $0.000065/frame, ~250 ms.

**Found while planning:** raw screen text leaves the Mac in TWO places, not one.
PRIVACY.md only lists the first.
1. `ActivityAnalyzer.buildPrompt` → Claude (main summary, every cycle)
2. `daemon/index.ts extractBrowserTopics` → Claude (browser pages you dwell on; also writes OCR to the vault)
(`/ask` in server.ts sends stored summaries only — already derived, out of scope.)

## Decisions for Mike (before coding)
- [ ] **D1. Trade-off:** the gate sends ALL screen text to TypeSafe (via OpenRouter) so that
      private text stops going to Anthropic. Net: one more vendor sees everything, briefly.
      Plan: verify TypeSafe + OpenRouter data-retention terms from live docs, and turn on
      OpenRouter zero-data-retention for the key. If retention is unacceptable → stop here.
- [ ] **D2. If Jev is down or the key is missing:** recommended = fail closed (withhold text,
      Ambient summary says "screen content withheld"), never silently send unfiltered.
- [ ] **D3. Key:** new dedicated OpenRouter key "ambient-gate" with a $5/mo cap, stored in
      Keychain (`ambient-daemon` / `openrouter-api-key`), loaded by start-daemon.sh like the
      Anthropic key. Not the dev "Jev" key.

## Build (in a git worktree off `main` — the live checkout has uncommitted dashboard work
## on `feature/airjelly-proactive-agent` and the running daemon serves its dist/)
- [ ] 1. `src/analysis/PrivacyGate.ts` (~120 lines): `screen(entries) → { kept, withheld }`
      - excluded apps from `config.excludeApps` (enforces the existing, never-enforced list)
      - one Jev call per unique window text (dedupe), 4 nouls (round-2 wording), concurrency 5, 5 s timeout
      - any score ≥ 0.4 → replace entry with `[<App>] private content withheld` (no window title — titles leak, e.g. "Please print for Mayla")
      - error/timeout → withheld (fail closed, counted, logged by count only)
      - kept text still runs through `filterPII()` (belt and braces)
      - threshold + questions as constants at top of file
- [ ] 2. Wire into `daemon/index.ts` before `analyzer.analyze(batch)` AND pass gated entries to
      `runBrowserCapture` (closes path #2 and keeps private pages out of the vault)
- [ ] 3. Local audit table `privacy_gate_log` (ts, app, reason: excluded|jev|error, max score).
      No text, no window titles. Pruned at 30 days in the existing 3 AM retention job.
- [ ] 4. `/api/health` + dashboard privacy strip: "N screens withheld today"
- [ ] 5. Tests (vitest, fetch mocked): excluded app dropped; score ≥ threshold withheld;
      error → withheld; missing key → withheld + loud log; placeholder never contains window title
- [ ] 6. Eval script `scripts/privacy-gate-eval.ts`: runs the gate over labeled frames kept in
      `~/.ambient/eval/` (outside the repo — fixtures contain real PII) and prints caught/missed/false alarms
- [ ] 7. Update `deploy/PRIVACY.md`: add TypeSafe/OpenRouter row, add browser-topics path, mark both gaps closed
- [ ] 8. `tsc --noEmit`, `npm test`, `npm run build` (check no build already running first)

## Ship (needs Mike)
- [ ] PR to `main`. Getting it into the RUNNING daemon requires the live checkout's uncommitted
      dashboard work to be committed/merged first — decide order with Mike; do not stash or overwrite it.
- [ ] Restart `com.coder1.ambient`, confirm one cycle logs "gate: X kept / Y withheld", check a day summary still reads well.
- [ ] After 1 week: rerun the eval on a fresh 100-frame labeled set; tune threshold. Before any client install: 200 labeled frames.

## Review (2026-09-24)
- D1 checked live: OpenRouter stores nothing by default; `provider.zdr: true` is honored on the decisions endpoint (a fake provider filter 404s, zdr:true still serves Jev → TypeSafe is on OpenRouter's zero-retention list). TypeSafe policy: no training on inputs. Every gate call now requires ZDR.
- CORRECTION: excluded apps WERE enforced — `config.ignoreApps` in ScreenpipeClient (Finder, System Settings, loginwindow). Step "enforce excludeApps" dropped. PRIVACY.md corrected.
- Built on branch `feat/privacy-gate` (worktree `~/.ambient-worktrees/privacy-gate`, commit a3fe305) — off `feature/airjelly-proactive-agent`, because `main` is only "Initial release v0.1.0".
  Files: `src/analysis/PrivacyGate.ts` (new), `src/daemon/index.ts` (gate before analyze; browser capture gets passed-only entries; per-day counts in daemon_state), `src/config/index.ts` (`privacyGate: {enabled, threshold}`), `tests/privacyGate.test.ts` (9 tests), `scripts/privacy-gate-eval.ts`.
- tsc clean; full suite 230/230. Live eval: 5/6 caught (miss = Finder, dropped upstream anyway), 5/24 false alarms, 0 errors.
- Outside the branch (untracked/live files): `~/.ambient/start-daemon.sh` loads `openrouter-api-key` into AMBIENT_GATE_API_KEY (backup `.pregate-bak`); `deploy/install.sh` + `deploy/templates/ambient-start.sh` prompt/load it; `deploy/PRIVACY.md` updated.
- Dashboard count (step 4) NOT done — server.ts has uncommitted work; counts are in daemon_state `privacy_gate_counts:<date>` ready to read.
- Also fixed (live checkout, uncommitted): `/api/tasks/triage` ran headless Claude with the user's full permissions on OCR-derived task text. Now `--tools "" --strict-mcp-config --permission-mode dontAsk` + untrusted-data wrapper; injection test did nothing.
- NOT LIVE: needs (1) Mike's OpenRouter key in Keychain, (2) the live checkout's uncommitted work committed, then merge `feat/privacy-gate`, build, restart `com.coder1.ambient`.

---

# Skip Haiku on unchanged screens (2026-09-24)

Goal: stop paying Haiku to re-summarize the same doc/video every 7 minutes.

- [ ] `src/analysis/ChangeDetector.ts`: pure "same as last cycle?" check — same set of app+window pairs AND normalized word overlap >= 0.8 (digits stripped so clocks/video timers don't count as change). In-memory only; restart = run normally.
- [ ] Backstop: after 3 consecutive skips (~28 min), force a real Haiku call.
- [ ] Fail open: any error in the check = run normally.
- [ ] On skip, extend the latest activity session's `period_end` so time tracking loses nothing; still run scorecard + proactive; skip privacy gate, Haiku, LeadSpot hook, browser capture (screen unchanged).
- [ ] Log skip counts only (no text), keep a per-day `haiku_skips:<date>` tally to measure the saving.
- [ ] Tests for detector + session extend; tsc + vitest; build; restart daemon (ask first).

---

## Plan: cut notification + task noise (2026-09-24)

**Why (from ambient.db):** 285 notifications in 7 days (~41/day), 284 of them "Stuck error" alerts; 0 of 1,838 notifications ever got feedback. 475 auto-tasks ever: 4 done, 21 accepted, 323 dismissed unseen, 127 open unseen. 395 of 475 came from batches with Terminal on screen — mostly instructions to/from Claude Code ("Tune the privacy gate", "tell the assistant 'done'"). Stuck-error dedup fails because Haiku rewords each error (283 events, 251 distinct 50-char prefixes). One auto-task holds a truncated API key.

**Targets for a 2-week dogfood:** ≤2 notifications/day; >50% of suggestions accepted; nothing secret in a task.

### Phase 1 — Notifications
- [x] Config `notifications.stuckErrors` (default false): ProactiveEngine skips `checkStuckErrors` unless on. Errors still recorded and visible in the dashboard.
- [x] Global cap: max 2 notifications per local day across all checks (count today's rows before firing).
- [x] Tests: stuck-errors off by default; cap holds at 2.

### Phase 2 — Suggested tasks
- [x] Analyzer prompt: requests between the user and an AI assistant (Claude Code, ChatGPT, Claude app) and steps in a coding session are NOT tasks — the assistant is already handling them. Keep commitments to or from other people (email, messages, meetings, documents).
- [x] Drop any auto-task whose text looks like a secret (`sk-`, `key`, token-like strings) and run `filterPII` on task content before insert.
- [x] Suggestions older than 7 days with no action auto-expire (status `dismissed`, accepted 0). Inbox shows at most 3, highest confidence first.
- [x] One-time: expire the 127 stale suggestions; delete the row holding the key fragment.
- [x] Tests for the filter, expiry, and 3-item cap.

### Phase 3 — Measure
- [x] `/api/status` + dashboard strip: notifications/day (7d) and suggestion acceptance rate (7d).
- [x] tsc + vitest; build.
- [ ] Restart daemon (ask first).

**Not in this plan:** trust panel, weekly receipt, collapsing surfaces into the morning brief. Jev notification gate dropped — after Phase 1 volume is ~1–2/day, so it fails the "repeated" test.

### Review
- Notifications: new `notifications` config (`stuckErrors: false`, `maxPerDay: 2`); ProactiveEngine checks the day's count first (fails closed) and runs stuck-error alerts only when on.
- Tasks: analyzer prompt excludes AI-assistant conversations; `src/analysis/taskFilters.ts` drops auto-tasks that look like secrets, and task text goes through `filterPII`; inbox shows 3, highest confidence first; untouched suggestions expire after 7 days each cycle (dismissed, not deleted).
- Measure: `/api/status.quality` + operator status bar "N alerts/day · X% kept (7d)".
- Data: 119 open suggestions dismissed (ids in `~/.ambient/suggestions-cleared-2026-09-24.json` for undo); 1 task holding a key fragment deleted. Other "sk-" hits in knowledge/sessions were words like "task-automation", not keys.
- Tests: `tests/noiseCut.test.ts` (10); full suite 248 passing; build clean.
