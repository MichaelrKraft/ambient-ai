/**
 * Self-identity table — emails belonging to the daemon's user.
 *
 * Any signal whose contact_match_key matches a self-identity email_hash
 * is dropped before promotion (§2.4 of the integration plan). This is the
 * "don't auto-log emails to yourself" rule.
 *
 * Sources:
 *  - 'oauth'      → user_email + user_email_aliases from POST /auth/token
 *  - 'user_added' → from `ambient identity add work@personal.com`
 *  - 'domain'     → from `ambient identity add-domain @example.com` (future)
 *
 * The DB takes only email_hash (sha256 of normalized email). We never
 * persist the raw email — privacy hygiene; matching is hash-only.
 */
import type Database from 'better-sqlite3';
import { emailHash, normalizeEmail } from './normalize.js';

export type SelfIdentitySource = 'oauth' | 'user_added' | 'domain';

export interface SelfIdentityRow {
  emailHash: string;
  source: SelfIdentitySource;
  addedAt: number;
}

/**
 * Returns true if the given email_hash is in self_identity. O(1) — uses
 * the PRIMARY KEY index. Hot-path call; do not log here.
 */
export function isSelf(db: Database.Database, hash: string): boolean {
  if (hash.length === 0) return false;
  const row = db
    .prepare('SELECT 1 FROM self_identity WHERE email_hash = ?')
    .get(hash);
  return row !== undefined;
}

/**
 * Insert (or update source on conflict) a self-identity entry.
 *
 * Idempotent: re-adding the same email is a no-op except that source may
 * be upgraded to 'oauth' if previously 'user_added'.
 */
export async function addAlias(
  db: Database.Database,
  email: string,
  source: SelfIdentitySource,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0) {
    throw new Error(`addAlias: invalid email "${email}"`);
  }
  const hash = emailHash(normalized);
  db
    .prepare(
      `INSERT INTO self_identity (email_hash, source, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email_hash) DO UPDATE SET source = excluded.source`,
    )
    .run(hash, source, Date.now());
}

/**
 * Remove a self-identity entry. Returns true if a row was deleted.
 */
export async function removeAlias(
  db: Database.Database,
  email: string,
): Promise<boolean> {
  const hash = emailHash(email);
  if (hash.length === 0) return false;
  const result = db
    .prepare('DELETE FROM self_identity WHERE email_hash = ?')
    .run(hash);
  return result.changes > 0;
}

export function listAliases(db: Database.Database): SelfIdentityRow[] {
  const rows = db
    .prepare(
      'SELECT email_hash, source, added_at FROM self_identity ORDER BY added_at ASC',
    )
    .all() as Array<{ email_hash: string; source: string; added_at: number }>;
  return rows.map((r) => ({
    emailHash: r.email_hash,
    source: r.source as SelfIdentitySource,
    addedAt: r.added_at,
  }));
}
