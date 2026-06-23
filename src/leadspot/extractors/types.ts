/**
 * Shared types for the extractor sub-modules.
 *
 * The HARD RULE for everything in this directory:
 *   Haiku output is untrusted. A SignalCandidate is emitted ONLY if its
 *   value passes a syntactic validator (RFC-5322 email, LinkedIn slug,
 *   E.164 phone). Names alone NEVER produce a signal — they only refine
 *   an already-validated email/handle match.
 */

export interface ExtractorInput {
  haikuSummary: string;
  sourceApp: string;
  windowTitle?: string;
  ocrText?: string;
  observedAtMs: number;
}

export interface SignalCandidate {
  extractor:
    | 'explicit_email'
    | 'gmail_header'
    | 'slack_dm_peer'
    | 'calendly_invitee'
    | 'zoom_participant'
    | 'linkedin_url';
  matchKey: string;
  matchKeyType: 'email_hash' | 'linkedin_slug';
  baseConfidence: number;
  candidateNameHint?: string;
  candidateCompanyHint?: string;
  ocrSnippetHash?: string;
  redactedSummary: string;
}
