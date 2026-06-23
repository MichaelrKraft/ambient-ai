/**
 * Bot/system-account + role-address denylists, plus the email syntactic
 * validator used by every extractor.
 *
 * These lists are intentionally conservative — false negatives (missing a
 * bot) cause noise in the CRM; false positives (silencing a real contact)
 * cause silent data loss. When in doubt, add to the list.
 */
import { createHash } from 'node:crypto';
import { emailHash, normalizeEmail } from '../normalize.js';

/**
 * RFC-5322 "simplified" email regex. Practical not legalese — rejects spaces,
 * consecutive dots, missing TLD.
 */
export const EMAIL_RE
  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

export const LINKEDIN_SLUG_RE = /linkedin\.com\/in\/([a-zA-Z0-9-]{3,100})/gi;

/**
 * Bot/system local-parts (lowercase). Match against email local-part OR
 * display name — both can carry bot identity.
 */
const BOT_NAMES = new Set<string>([
  'github',
  'linear',
  'notion',
  'notion-bot',
  'loom',
  '1password',
  'slackbot',
  'calendly',
  'intercom',
  'frontapp',
  'front',
  'hubspot',
  'mautic',
  'dropbox-bot',
  'do-not-reply',
  'no-reply',
  'noreply',
  'notifications',
]);

/** Role addresses — local-parts that aren't individuals. */
const ROLE_ADDRESSES = new Set<string>([
  'support',
  'info',
  'admin',
  'hello',
  'team',
  'sales',
  'help',
  'contact',
  'billing',
]);

/** Mailer-relay domains we never log as a contact. */
const MAILER_DOMAINS = new Set<string>([
  'sendgrid.net',
  'mailgun.org',
  'amazonses.com',
  'mandrillapp.com',
  'sparkpostmail.com',
  'postmarkapp.com',
]);

function isBotEmail(local: string, domain: string): boolean {
  if (BOT_NAMES.has(local)) return true;
  for (const bot of BOT_NAMES) {
    if (local.startsWith(`${bot}-`) || local.endsWith(`-${bot}`)) return true;
  }
  if (MAILER_DOMAINS.has(domain)) return true;
  return false;
}

export function isBotName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (BOT_NAMES.has(lower)) return true;
  for (const bot of BOT_NAMES) {
    if (lower.includes(bot)) return true;
  }
  return false;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

export function clean(summary: string): string {
  return truncate(summary.replace(/\s+/g, ' ').trim(), 240);
}

export function appMatches(app: string, needles: string[]): boolean {
  const lower = app.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

export interface ClassifiedEmail {
  local: string;
  domain: string;
  normalized: string;
  hash: string;
}

/**
 * Validate-and-classify an email candidate against role + bot + mailer
 * denylists. Returns the structured form on pass, null on reject.
 */
export function classifyEmail(raw: string): ClassifiedEmail | null {
  const normalized = normalizeEmail(raw);
  if (normalized.length === 0 || !normalized.includes('@')) return null;
  const at = normalized.lastIndexOf('@');
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return null;
  if (ROLE_ADDRESSES.has(local)) return null;
  if (isBotEmail(local, domain)) return null;
  return { local, domain, normalized, hash: emailHash(raw) };
}

/** Strip raw emails from a string — used to keep PII out of redacted summaries. */
export function stripEmails(s: string): string {
  return s.replace(EMAIL_RE, '').replace(/\s+/g, ' ').trim();
}
