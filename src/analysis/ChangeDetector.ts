/**
 * ChangeDetector — decides whether a cycle's screens are the same as the
 * previous cycle's, so the daemon can skip a Haiku call that would only
 * re-summarize the same doc or video.
 *
 * "Same" means: the same set of app + window pairs, AND the screen words
 * overlap heavily. Digits are stripped before comparing, so clocks, video
 * timers and page counters don't count as change.
 *
 * Plain code on purpose: this is an exact-ish fact about the text, not a
 * judgment call, so no model is needed. State lives in memory only; after a
 * restart the first cycle always runs.
 */

import type { OcrEntry } from '../screenpipe/types.js';

/** Word overlap (intersection over the smaller set) at or above this = unchanged. */
export const SAME_TEXT_THRESHOLD = 0.8;
/** Force a real analysis after this many skips in a row (~28 min at 7-min polling). */
export const MAX_CONSECUTIVE_SKIPS = 3;

interface Fingerprint {
  windows: Set<string>;
  words: Set<string>;
}

function fingerprint(entries: OcrEntry[]): Fingerprint {
  const windows = new Set<string>();
  const words = new Set<string>();
  for (const e of entries) {
    windows.add(`${e.appName}\n${e.windowName}`);
    for (const w of e.text.toLowerCase().replace(/[0-9]/g, ' ').split(/[^\p{L}]+/u)) {
      if (w.length >= 3) words.add(w);
    }
  }
  return { windows, words };
}

function sameWindows(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

export class ChangeDetector {
  private last: Fingerprint | null = null;
  private skipsInARow = 0;

  /**
   * Returns true when this cycle can reuse the last summary. Always records
   * the new fingerprint when a real analysis will run, so the comparison is
   * against the last screens Haiku actually saw.
   */
  shouldSkip(entries: OcrEntry[]): boolean {
    const current = fingerprint(entries);
    const unchanged =
      this.last !== null &&
      sameWindows(current.windows, this.last.windows) &&
      wordOverlap(current.words, this.last.words) >= SAME_TEXT_THRESHOLD;

    if (unchanged && this.skipsInARow < MAX_CONSECUTIVE_SKIPS) {
      this.skipsInARow++;
      return true;
    }
    this.last = current;
    this.skipsInARow = 0;
    return false;
  }

  /** Forget the last screens so the next cycle runs (e.g. after an analysis failure). */
  reset(): void {
    this.last = null;
    this.skipsInARow = 0;
  }
}
