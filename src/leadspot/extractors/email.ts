/**
 * Email-shaped extractors: gmail_header, explicit_email, calendly_invitee.
 * All three rely on RFC-5322 validation (in classifyEmail) before emitting.
 */
import {
  EMAIL_RE,
  appMatches,
  classifyEmail,
  clean,
  isBotName,
  sha256Hex,
  stripEmails,
  truncate,
} from './denylist.js';
import type { ExtractorInput, SignalCandidate } from './types.js';

const GMAIL_FROM_RE = /From:\s*([^<\n]{1,80})<([^>\s]+@[^>\s]+)>/i;
const GMAIL_SUBJECT_RE = /Subject:\s*([^\n\r]{1,200})/i;

const CALENDLY_TITLE_RE
  = /(?:meeting|event|invite|call)(?:\s+with|\s+for|:)?\s*([^\n\r]{2,80})/i;

export function extractGmailHeader(input: ExtractorInput): SignalCandidate[] {
  if (!appMatches(input.sourceApp, ['Chrome', 'Safari', 'Mail'])) return [];
  const fromMatch = GMAIL_FROM_RE.exec(input.haikuSummary);
  if (fromMatch === null) return [];
  const name = fromMatch[1].trim().replace(/^"|"$/g, '');
  const addr = fromMatch[2].trim();
  if (isBotName(name)) return [];
  const cls = classifyEmail(addr);
  if (cls === null) return [];

  const subjMatch = GMAIL_SUBJECT_RE.exec(input.haikuSummary);
  const subjRaw = subjMatch !== null ? subjMatch[1].trim() : '';
  const subj = stripEmails(subjRaw);
  const summary = subj.length > 0
    ? `Sent email · ${truncate(subj, 80)}`
    : `Sent email · ${cls.domain}`;

  return [{
    extractor: 'gmail_header',
    matchKey: cls.hash,
    matchKeyType: 'email_hash',
    baseConfidence: 95,
    candidateNameHint: name || undefined,
    ocrSnippetHash: sha256Hex(`${name}|${addr}`),
    redactedSummary: clean(summary),
  }];
}

export function extractExplicitEmail(input: ExtractorInput): SignalCandidate[] {
  // Skip if gmail_header would already cover this OCR window.
  if (GMAIL_FROM_RE.test(input.haikuSummary)) return [];

  const seen = new Set<string>();
  const out: SignalCandidate[] = [];
  for (const m of input.haikuSummary.matchAll(EMAIL_RE)) {
    const addr = m[0];
    const cls = classifyEmail(addr);
    if (cls === null) continue;
    if (seen.has(cls.hash)) continue;
    seen.add(cls.hash);
    out.push({
      extractor: 'explicit_email',
      matchKey: cls.hash,
      matchKeyType: 'email_hash',
      baseConfidence: 90,
      ocrSnippetHash: sha256Hex(addr),
      redactedSummary: clean(`Email mention · ${cls.domain}`),
    });
  }
  return out;
}

export function extractCalendlyInvitee(input: ExtractorInput): SignalCandidate[] {
  const inCalendly
    = appMatches(input.sourceApp, ['Calendly'])
    || (input.windowTitle !== undefined
      && input.windowTitle.toLowerCase().includes('calendly.com'));
  if (!inCalendly) return [];
  const out: SignalCandidate[] = [];
  const seen = new Set<string>();
  const titleMatch = CALENDLY_TITLE_RE.exec(input.haikuSummary);
  const titleHintRaw = titleMatch !== null ? titleMatch[1].trim() : '';
  // Strip raw emails / angle-bracket addresses from the surfaced summary —
  // the redacted summary must never carry PII.
  const titleHint = stripEmails(titleHintRaw.replace(/<[^>]*>/g, ''));
  for (const m of input.haikuSummary.matchAll(EMAIL_RE)) {
    const cls = classifyEmail(m[0]);
    if (cls === null) continue;
    if (seen.has(cls.hash)) continue;
    seen.add(cls.hash);
    const summary = titleHint.length > 0
      ? `Booked meeting · ${truncate(titleHint, 80)}`
      : `Booked meeting · ${cls.domain}`;
    out.push({
      extractor: 'calendly_invitee',
      matchKey: cls.hash,
      matchKeyType: 'email_hash',
      baseConfidence: 95,
      ocrSnippetHash: sha256Hex(m[0]),
      redactedSummary: clean(summary),
    });
  }
  return out;
}
