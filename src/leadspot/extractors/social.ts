/**
 * Non-email extractors: slack_dm_peer, zoom_participant, linkedin_url.
 *
 * slack_dm and zoom_participant produce name-typed match keys (the mirror
 * resolves them via name_norm lookup). linkedin_url produces a slug-typed
 * match key (linkedin_slug column).
 */
import {
  LINKEDIN_SLUG_RE,
  appMatches,
  clean,
  isBotName,
  sha256Hex,
  stripEmails,
  truncate,
} from './denylist.js';
import type { ExtractorInput, SignalCandidate } from './types.js';

/**
 * "DM with X" / "direct message with X". The trigger phrase is matched
 * case-insensitively but the captured peer name is case-anchored so we stop
 * at the first lowercase token (e.g. "about pricing").
 */
const SLACK_DM_TRIGGER_RE = /(?:DM with|direct message with)\s+/i;
const SLACK_DM_NAME_RE = /^([A-Z][\w.\-]+(?:\s+[A-Z][\w.\-]+){0,2})/;

const PERSON_NAME_RE = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/g;
const ZOOM_TITLE_RE
  = /Zoom\s+Meeting(?::?\s+(.{2,80}))?|Topic:\s*([^\n\r]{2,80})/i;

export function extractSlackDm(input: ExtractorInput): SignalCandidate[] {
  if (!appMatches(input.sourceApp, ['Slack'])) return [];
  const trigger = SLACK_DM_TRIGGER_RE.exec(input.haikuSummary);
  if (trigger === null) return [];
  const tail = input.haikuSummary.slice(trigger.index + trigger[0].length);
  const m = SLACK_DM_NAME_RE.exec(tail);
  if (m === null) return [];
  const peer = m[1].trim();
  if (peer.length === 0 || isBotName(peer)) return [];
  const nameNorm = peer.toLowerCase().replace(/\s+/g, ' ').trim();
  return [{
    extractor: 'slack_dm_peer',
    // matchKey carries a name marker; promote.ts unpacks via candidateNameHint
    // and falls back to mirror.lookupContact(nameNorm = ...).
    matchKey: `name:${sha256Hex(nameNorm)}`,
    matchKeyType: 'email_hash',
    baseConfidence: 70,
    candidateNameHint: peer,
    ocrSnippetHash: sha256Hex(peer),
    redactedSummary: clean(`Slack DM · ${peer}`),
  }];
}

export function extractZoomParticipants(input: ExtractorInput): SignalCandidate[] {
  if (!appMatches(input.sourceApp, ['zoom.us', 'Zoom Meetings', 'Zoom'])) {
    return [];
  }
  const titleMatch = ZOOM_TITLE_RE.exec(input.haikuSummary);
  const meetingTitleRaw = titleMatch !== null
    ? (titleMatch[1] ?? titleMatch[2] ?? '').trim()
    : '';
  const meetingTitle = stripEmails(meetingTitleRaw);

  // Need at least 2 person-name-shaped lines to consider this a participant
  // list (avoids matching "Zoom Meeting" running text).
  const names: string[] = [];
  for (const m of input.haikuSummary.matchAll(PERSON_NAME_RE)) {
    names.push(`${m[1]} ${m[2]}`);
  }
  if (names.length < 2) return [];

  const seen = new Set<string>();
  const out: SignalCandidate[] = [];
  for (const name of names) {
    if (isBotName(name)) continue;
    const nameNorm = name.toLowerCase().trim();
    const key = `name:${sha256Hex(nameNorm)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = meetingTitle.length > 0
      ? `Joined call · ${truncate(meetingTitle, 80)}`
      : `Joined call · ${input.sourceApp}`;
    out.push({
      extractor: 'zoom_participant',
      matchKey: key,
      matchKeyType: 'email_hash',
      baseConfidence: 60,
      candidateNameHint: name,
      ocrSnippetHash: sha256Hex(name),
      redactedSummary: clean(summary),
    });
  }
  return out;
}

export function extractLinkedInUrl(input: ExtractorInput): SignalCandidate[] {
  const seen = new Set<string>();
  const out: SignalCandidate[] = [];
  for (const m of input.haikuSummary.matchAll(LINKEDIN_SLUG_RE)) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      extractor: 'linkedin_url',
      matchKey: slug,
      matchKeyType: 'linkedin_slug',
      baseConfidence: 85,
      ocrSnippetHash: sha256Hex(`linkedin:${slug}`),
      redactedSummary: clean(`LinkedIn touchpoint · ${slug}`),
    });
  }
  return out;
}
