/**
 * Email + name normalization. Pure functions; never touch DB or network.
 *
 * IMPORTANT: must mirror the backend implementation at
 *   /Users/michaelkraft/leadspot/backend/app/utils/email_normalize.py
 *
 * Otherwise daemon hashes won't match cloud hashes and matching is broken.
 *
 * Algorithm (from section 2.3 of ghostlog-integration-plan.md):
 *   - NFKC-normalize
 *   - strip Unicode invisibles (Cf/Cc/Zl/Zp + ZWJ/ZWNJ/BOM)
 *   - trim, lowercase
 *   - strip "+suffix" from local part
 *   - sha256(normalized utf-8) -> email_hash hex string
 */
import { createHash } from 'node:crypto';

// Explicit invisible characters that are not always in Cf/Cc.
// U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM.
const EXPLICIT_INVISIBLE = new Set<string>([
  '​',
  '‌',
  '‍',
  '﻿',
]);

// Unicode categories considered "invisible" for our purposes.
// Node has no per-codepoint category lookup in the std lib, so we approximate:
//   - the explicit set above
//   - C0/C1 controls (U+0000-U+001F, U+007F-U+009F)
//   - Zl (U+2028), Zp (U+2029)
//   - common Cf code points: U+00AD soft hyphen, U+061C, U+180E,
//     U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+2066-U+2069, U+FEFF
const INVISIBLE_REGEX = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E'
    + '\\u200B-\\u200F\\u202A-\\u202E\\u2028-\\u2029'
    + '\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'gu',
);

function stripInvisibles(s: string): string {
  let out = s.replace(INVISIBLE_REGEX, '');
  for (const ch of EXPLICIT_INVISIBLE) {
    if (out.includes(ch)) {
      out = out.split(ch).join('');
    }
  }
  return out;
}

/**
 * Normalize an email for hashing/matching.
 *
 * Defensive contract (matches Python):
 * - empty / whitespace-only -> ""
 * - no "@" -> returns lowercased + stripped (no fabricated @)
 * - "+only@x" -> "@x" (placeholder; never collides with empty)
 */
export function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return '';

  const cleaned = stripInvisibles(raw.normalize('NFKC')).trim().toLowerCase();
  if (cleaned.length === 0) return '';

  if (!cleaned.includes('@')) return cleaned;

  const atIdx = cleaned.lastIndexOf('@');
  let local = cleaned.slice(0, atIdx);
  const domain = cleaned.slice(atIdx + 1);

  if (local.length === 0) return cleaned;

  const plusIdx = local.indexOf('+');
  if (plusIdx >= 0) {
    local = local.slice(0, plusIdx);
  }

  if (local.length === 0) {
    // All-suffix local: preserve domain so the hash is recognizable.
    return `@${domain}`;
  }

  return `${local}@${domain}`;
}

/**
 * sha256(normalize_email(raw)) hex.
 * Returns "" for empty input -- distinguishable from a real 64-char hex.
 */
export function emailHash(raw: string | null | undefined): string {
  const normalized = normalizeEmail(raw);
  if (normalized.length === 0) return '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export interface NormalizedName {
  /** "first last" -- Western order. */
  primary: string;
  /** "last first" -- handles surname-first (e.g. Asian) name ordering. */
  reversed: string;
}

/**
 * Build the two name variants used for matching against contact_mirror.
 * Each variant: NFC-normalized, lowercased, trimmed, single-space.
 *
 * Caller decides which variant to compare against name_norm in the mirror --
 * we emit both because we don't know which order the source app used.
 */
export function normalizeName(first: string, last: string): NormalizedName {
  const f = first.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const l = last.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

  if (f.length === 0 && l.length === 0) {
    return { primary: '', reversed: '' };
  }
  if (f.length === 0) return { primary: l, reversed: l };
  if (l.length === 0) return { primary: f, reversed: f };

  return {
    primary: `${f} ${l}`,
    reversed: `${l} ${f}`,
  };
}
