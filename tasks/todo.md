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
