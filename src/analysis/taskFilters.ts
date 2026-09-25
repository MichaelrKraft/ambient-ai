/**
 * Guards on auto-captured task text before it is stored.
 *
 * A task is shown on the dashboard and in the morning brief, so it must never
 * carry a secret. One real auto-task held the start of an OpenRouter key
 * ("sk-or-v1-8f3...") copied off the screen.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{3,}/, // OpenAI / Anthropic / OpenRouter style keys, even truncated
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{6,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{6,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{12,}/, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /\b(password|passcode|api[ _-]?key|secret|token)\s*[:=]\s*\S{4,}/i, // "password: hunter2"
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/, // long random token
];

/** True when the text looks like it contains a secret value. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}
