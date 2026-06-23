/**
 * Entity-extraction pipeline (§2.3 of the integration plan).
 *
 * HARD RULE — non-negotiable:
 *   Haiku output is treated as untrusted. A SignalCandidate is emitted ONLY
 *   if its value passes a syntactic validator:
 *     - emails:    RFC-5322 simplified regex
 *     - LinkedIn:  /linkedin\.com\/in\/[a-zA-Z0-9-]{3,100}/
 *   Names alone NEVER produce a signal. They only refine an already-validated
 *   email/handle match.
 *
 * Pure function — no DB or network. Testable via golden corpus.
 *
 * Per-extractor logic lives in ./extractors/{email,social}.ts; the shared
 * denylist + email validator live in ./extractors/denylist.ts.
 */
import {
  extractCalendlyInvitee,
  extractExplicitEmail,
  extractGmailHeader,
} from './extractors/email.js';
import {
  extractLinkedInUrl,
  extractSlackDm,
  extractZoomParticipants,
} from './extractors/social.js';
import type { ExtractorInput, SignalCandidate } from './extractors/types.js';

export type { ExtractorInput, SignalCandidate } from './extractors/types.js';

/**
 * Run all extractors and return a deduplicated, validated candidate list.
 * Pure — no IO. Use the result as input to `ingestCandidates`.
 */
export function extractCandidates(input: ExtractorInput): SignalCandidate[] {
  const out: SignalCandidate[] = [];
  out.push(...extractGmailHeader(input));
  out.push(...extractExplicitEmail(input));
  out.push(...extractSlackDm(input));
  out.push(...extractCalendlyInvitee(input));
  out.push(...extractZoomParticipants(input));
  out.push(...extractLinkedInUrl(input));

  // De-dupe by (extractor, matchKey) — same source can fire multiple regex
  // hits within one window. Keep the first; subsequent ones are noise.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${c.extractor}|${c.matchKey}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
