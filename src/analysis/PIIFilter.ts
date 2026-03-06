/**
 * PIIFilter — strips sensitive values from OCR text before sending to Claude.
 *
 * Operates on plain text only (not images). Each pattern replaces just the
 * sensitive value with [REDACTED], preserving the surrounding context so
 * Claude still understands the structure of the text.
 */

// ── Pattern definitions ────────────────────────────────────────────────────

/** Credit card numbers: 16-digit groups separated by spaces or hyphens. */
const CREDIT_CARD = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

/** US Social Security numbers: NNN-NN-NNNN. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Passwords in common assignment forms.
 * Captures the value after the keyword so we only redact the value,
 * keeping the key name intact.
 */
const PASSWORD_PATTERNS: RegExp[] = [
  /\bpassword[=:\s]+(\S+)/gi,
  /\bpasswd[=:\s]+(\S+)/gi,
  /\bpwd[=:\s]+(\S+)/gi,
  /\bsecret[=:\s]+(\S+)/gi,
];

/**
 * API keys / tokens that appear after common key-name prefixes.
 * The token must be ≥ 20 chars of alphanumeric + _- characters.
 * bearer is matched as a prefix without an = sign (e.g. "Bearer sk-abc...").
 */
const API_KEY_PATTERNS: RegExp[] = [
  /\bkey=([A-Za-z0-9_\-]{20,})/gi,
  /\btoken=([A-Za-z0-9_\-]{20,})/gi,
  /\bapikey=([A-Za-z0-9_\-]{20,})/gi,
  /\bapi_key=([A-Za-z0-9_\-]{20,})/gi,
  /\bsecret=([A-Za-z0-9_\-]{20,})/gi,
  /\bbearer\s+([A-Za-z0-9_\-]{20,})/gi,
];

/** Standard email addresses. */
const EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Replaces all non-overlapping matches of a global regex in `text`.
 * Uses a replacement function so we can target only capture group 1
 * (the sensitive value) while keeping the rest of the match intact.
 */
function redactGroup1(text: string, patterns: RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    // Reset lastIndex before each pass (patterns are module-level with /g flag).
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, group1: string) => {
      return match.replace(group1, '[REDACTED]');
    });
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Filters PII from `text` and returns the sanitised string.
 * Only the sensitive value is replaced; surrounding context is preserved.
 */
export function filterPII(text: string): string {
  let result = text;

  // Whole-match replacements (no capture group needed).
  result = result.replace(CREDIT_CARD, '[REDACTED]');
  result = result.replace(SSN, '[REDACTED]');
  result = result.replace(EMAIL, '[REDACTED]');

  // Capture-group replacements — keep the keyword, redact the value.
  result = redactGroup1(result, PASSWORD_PATTERNS);
  result = redactGroup1(result, API_KEY_PATTERNS);

  return result;
}

/**
 * Returns true if any PII pattern is found in `text`.
 * Used to flag knowledge items that may contain sensitive content.
 */
export function isPIISuspicious(text: string): boolean {
  const allPatterns: RegExp[] = [
    CREDIT_CARD,
    SSN,
    EMAIL,
    ...PASSWORD_PATTERNS,
    ...API_KEY_PATTERNS,
  ];

  for (const pattern of allPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }

  return false;
}
