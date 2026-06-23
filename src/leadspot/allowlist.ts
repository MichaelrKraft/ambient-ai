/**
 * Per-app allowlist / denylist for signal extraction (plan §2.5).
 *
 * Privacy is the architecture: the marketing claim "your screen never leaves
 * your machine" requires that we NEVER run signal extraction on banking,
 * password manager, or financial app windows. The allowlist below is the
 * default-deny gate that runs *before* extractCandidates() is even called.
 *
 * Three-state policy:
 *   - DENYLIST  → never extract (1Password, banks, crypto, incognito, screen-share)
 *   - ALLOWLIST → extract (Gmail, Slack, LinkedIn, Calendly, Zoom, etc.)
 *   - default   → do NOT extract (capture continues for goal/digest, but no
 *                 signals are produced for unknown apps)
 *
 * Storage: the lists are constants in this file for v1. Phase 2 will move
 * them to a settings UI and sync via the cloud so changes follow the user
 * across Macs.
 */

/** App bundle IDs / display names that NEVER produce signals. */
const APP_DENYLIST: readonly string[] = [
  '1password',
  '1password 7',
  '1password 8',
  'bitwarden',
  'lastpass',
  'dashlane',
  'keychain access',
  'mint',
  'personal capital',
  'coinbase',
  'robinhood',
  'fidelity',
  'schwab',
  'vanguard',
  'e*trade',
  'ledger live',
  'metamask',
  'venmo',
  'cash app',
];

/**
 * Window-title patterns that suppress extraction even when the app itself
 * is on the allowlist (e.g., Gmail viewing a banking statement attachment;
 * Chrome on coinbase.com).
 */
const WINDOW_TITLE_DENY_PATTERNS: readonly RegExp[] = [
  /\b(bank|banking|credit\s*card|wallet|crypto|coinbase|robinhood|fidelity|schwab|vanguard)\b/i,
  /\bincognito\b/i,
  /\bprivate\s*window\b/i,
  /\b(rdp|teamviewer|anydesk|chrome\s*remote|parallels)\b/i,
];

/** Apps where extraction is explicitly permitted. */
const APP_ALLOWLIST: readonly string[] = [
  // Email
  'mail',
  'apple mail',
  'microsoft outlook',
  'outlook',
  'spark',
  'superhuman',
  // Browsers (extraction limited to Gmail/Calendly/LinkedIn URLs by the extractors themselves)
  'google chrome',
  'chrome',
  'safari',
  'firefox',
  'arc',
  'brave',
  'edge',
  // Messaging
  'slack',
  'linear',
  'discord',
  // Calendaring
  'cron',
  'fantastical',
  'notion calendar',
  'calendar',
  // Video
  'zoom',
  'zoom.us',
  'zoom meetings',
  // Docs (sales-related signals only — extractors filter)
  'notion',
];

/** Lowercase normalize + strip emoji for comparison. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFC')
    // Strip emoji presentation forms
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
}

/**
 * Decide whether to run signal extraction for the current capture window.
 *
 * Returns true ONLY if the source app is on the explicit allowlist AND the
 * window title doesn't trigger any deny pattern. Default for unknown apps
 * is false (privacy-first).
 *
 * The reason field is for telemetry / debug logs — knowing WHY a window was
 * skipped lets us tune the lists without surprising the user.
 */
export function isExtractionAllowed(
  sourceApp: string | null | undefined,
  windowTitle: string | null | undefined,
): { allowed: boolean; reason: string } {
  const app = norm(sourceApp ?? '');
  const title = windowTitle ?? '';

  if (!app) {
    return { allowed: false, reason: 'no_source_app' };
  }

  // Hard deny on explicitly listed apps — even if the window title looks fine.
  for (const banned of APP_DENYLIST) {
    if (app === banned || app.includes(banned)) {
      return { allowed: false, reason: `app_denylist:${banned}` };
    }
  }

  // Hard deny on title patterns (banking-in-Chrome, incognito, screen-share).
  for (const pattern of WINDOW_TITLE_DENY_PATTERNS) {
    if (pattern.test(title)) {
      return { allowed: false, reason: `title_pattern:${pattern.source}` };
    }
  }

  // Allowlist match — extraction permitted.
  for (const allowed of APP_ALLOWLIST) {
    if (app === allowed || app.includes(allowed)) {
      return { allowed: true, reason: `app_allowlist:${allowed}` };
    }
  }

  // Default-deny: unknown apps never produce signals. Capture continues
  // (the existing analyzer still writes activity_sessions for goal/digest),
  // but no signal extraction.
  return { allowed: false, reason: 'app_not_allowlisted' };
}
