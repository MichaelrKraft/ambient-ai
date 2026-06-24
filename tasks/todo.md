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
