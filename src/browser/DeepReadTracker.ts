/**
 * DeepReadTracker — helpers for detecting browser deep reads.
 *
 * "Deep read" = the user dwelled on the same browser tab for >= 90 seconds.
 * Dwell time is tracked across analysis cycles via the daemon_state table.
 *
 * This module contains only pure helpers (browser detection, URL extraction,
 * title cleaning). Stateful dwell tracking lives in the Daemon class so it
 * can access the database and logger cleanly.
 */

import type { OcrEntry } from '../screenpipe/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Browser app names that Screenpipe may report. */
export const BROWSER_APPS = [
  'Google Chrome',
  'Chrome',
  'Arc',
  'Safari',
  'Firefox',
  'Brave Browser',
  'Brave',
  'Microsoft Edge',
  'Edge',
];

/** Minimum dwell time (seconds) before a page is considered a deep read. */
export const DEEP_READ_MIN_SECONDS = 90;

/** Prefix used when storing dwell state in daemon_state table. */
export const DWELL_STATE_PREFIX = 'browser_dwell:';

/** Window titles to never capture (browser chrome, new tab, etc.). */
const SKIP_TITLES = new Set(['New Tab', 'about:blank', '', 'Untitled']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the app name is a known browser. */
export function isBrowserApp(appName: string): boolean {
  return BROWSER_APPS.some(app => appName.includes(app));
}

/**
 * Strip browser name suffixes from window titles.
 * Chrome: "Page Title - Google Chrome" → "Page Title"
 */
export function cleanWindowTitle(windowName: string, appName: string): string {
  return windowName
    .replace(/ - Google Chrome$/, '')
    .replace(/ - Chromium$/, '')
    .replace(/ - Microsoft Edge$/, '')
    .replace(/ - Brave Browser$/, '')
    .replace(/ - Mozilla Firefox$/, '')
    .replace(/ - Apple Safari$/, '')
    .replace(new RegExp(` - ${appName}$`), '')
    .trim();
}

/** Returns true if a title should be skipped (new tab, empty, etc.). */
export function shouldSkipTitle(title: string): boolean {
  return SKIP_TITLES.has(title) || title.length < 3;
}

/**
 * Extract the first https URL visible in OCR text (typically from address bar).
 * Returns null if no URL is found.
 */
export function extractUrl(ocrText: string): string | null {
  const match = ocrText.match(/https?:\/\/[^\s"'<>)\]]+/);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, '');  // Strip trailing OCR punctuation noise
}

/**
 * Group browser OCR entries by (appName, windowName).
 * Returns a map from the dwell state key to { appName, windowName, ocrText }.
 */
export function groupBrowserEntries(
  entries: OcrEntry[],
): Map<string, { appName: string; windowName: string; ocrText: string }> {
  const groups = new Map<string, { appName: string; windowName: string; ocrText: string }>();

  for (const entry of entries) {
    if (!isBrowserApp(entry.appName)) continue;

    const stateKey = `${DWELL_STATE_PREFIX}${entry.appName}|||${entry.windowName}`;
    if (!groups.has(stateKey)) {
      groups.set(stateKey, {
        appName: entry.appName,
        windowName: entry.windowName,
        ocrText: '',
      });
    }
    groups.get(stateKey)!.ocrText += ' ' + entry.text;
  }

  return groups;
}
