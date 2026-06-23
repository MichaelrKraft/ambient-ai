/**
 * Decision policy for promote.ts: given a candidate + the local mirror,
 * decide which terminal/intermediate state the signal should land in.
 *
 * Pure-ish: reads the db, no writes, no network.
 *
 * §2.3 confidence math:
 *   start = candidate.baseConfidence + matchBonus
 *   +10 if contact had recent activity (last 14d)
 *   +5  if same source_app as previous signal (deferred — needs source_app
 *       on the candidate, out of scope for this slice)
 *   capped at 100
 *
 * Routing:
 *   conf ≥ 85  → held_local (60s + auto-promote)
 *   conf 60–84 → held       (review queue)
 *   conf < 60  → dropped
 */
import type Database from 'better-sqlite3';
import type { SignalCandidate } from './extractors.js';
import { lookupContact } from './mirror.js';
import { recentSignalForContact } from './promote-state.js';
import { isSelf } from './selfid.js';

export type DropReason
  = 'self'
  | 'ambiguous'
  | 'unmatched'
  | 'low_conf'
  | 'bot';

export interface OutcomeDecision {
  state: 'held_local' | 'held' | 'dropped';
  contactId: string | null;
  confidence: number;
  dropReason?: DropReason;
  extras: Record<string, unknown> | null;
}

export function decideOutcome(
  db: Database.Database,
  candidate: SignalCandidate,
): OutcomeDecision {
  // 1. Self-identity check (drop emails to ourselves).
  if (
    candidate.matchKeyType === 'email_hash'
    && !candidate.matchKey.startsWith('name:')
    && isSelf(db, candidate.matchKey)
  ) {
    return {
      state: 'dropped',
      contactId: null,
      confidence: 0,
      dropReason: 'self',
      extras: { drop_reason: 'self' },
    };
  }

  // 2. Resolve to a contact via mirror.
  const lookup = lookupContact(db, candidateForLookup(candidate));
  if (lookup === null) {
    // Distinguish ambiguous (name matched >1 contact) from unmatched.
    const isAmbiguous = candidate.candidateNameHint !== undefined
      && candidate.candidateNameHint.length > 0
      && candidate.matchKeyType === 'email_hash'
      && candidate.matchKey.startsWith('name:');
    if (isAmbiguous) {
      return {
        state: 'dropped',
        contactId: null,
        confidence: 50,
        dropReason: 'ambiguous',
        extras: { drop_reason: 'ambiguous' },
      };
    }
    return {
      state: 'dropped',
      contactId: null,
      confidence: candidate.baseConfidence,
      dropReason: 'unmatched',
      extras: { drop_reason: 'unmatched' },
    };
  }

  // 3. Confidence math.
  let confidence = candidate.baseConfidence + lookup.confidenceBonus;
  const recent = recentSignalForContact(db, lookup.contactId, 14);
  if (recent !== null) confidence += 10;
  if (confidence > 100) confidence = 100;

  // 4. Threshold routing.
  if (confidence >= 85) {
    return {
      state: 'held_local',
      contactId: lookup.contactId,
      confidence,
      extras: null,
    };
  }
  if (confidence >= 60) {
    return {
      state: 'held',
      contactId: lookup.contactId,
      confidence,
      extras: { reason: 'review_queue' },
    };
  }
  return {
    state: 'dropped',
    contactId: lookup.contactId,
    confidence,
    dropReason: 'low_conf',
    extras: { drop_reason: 'low_conf' },
  };
}

function candidateForLookup(candidate: SignalCandidate): {
  emailHash?: string;
  linkedinSlug?: string;
  nameNorm?: string;
  companyNorm?: string;
} {
  if (candidate.matchKeyType === 'linkedin_slug') {
    return { linkedinSlug: candidate.matchKey };
  }
  if (candidate.matchKey.startsWith('name:')) {
    return {
      nameNorm: (candidate.candidateNameHint ?? '').toLowerCase().trim(),
      ...(candidate.candidateCompanyHint !== undefined
        ? { companyNorm: candidate.candidateCompanyHint.toLowerCase().trim() }
        : {}),
    };
  }
  return { emailHash: candidate.matchKey };
}
