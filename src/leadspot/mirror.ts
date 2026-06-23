/**
 * Contact mirror sync — keeps a local copy of the user's CRM contacts so
 * the extractor pass can match without round-tripping cloud.
 *
 * Cursor: stored in mirror_sync_state under key 'contact_mirror_since'.
 * The cloud returns next_since=null when there's nothing more to send.
 *
 * Staleness rule (§2.2): if the mirror hasn't synced in >7 days, full reset
 * before draining the outbox. Old matches against changed contacts cause
 * mis-attribution — better to re-fetch.
 *
 * Lookup precedence (lookupContact):
 *   1. email_hash      → strongest signal
 *   2. linkedin_slug   → strong, slug uniqueness enforced server-side
 *   3. name + company  → weakest; ambiguous-name rule drops to null
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { LeadSpotClient } from './client.js';
import type { ContactSyncRow } from './types.js';

const log = createLogger('leadspot:mirror');

const CURSOR_KEY = 'contact_mirror_since';
const LAST_SYNC_KEY = 'contact_mirror_last_sync_ms';

/** 7 days; matches §2.2 force-resync threshold. */
const DEFAULT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncResult {
  newRows: number;
  deletions: number;
}

/**
 * One pass: drain pages until next_since is null, applying upserts/deletes
 * inside per-page transactions. Returns counts for telemetry.
 */
export async function syncContactsOnce(
  client: LeadSpotClient,
  db: Database.Database,
): Promise<SyncResult> {
  let cursor = readState(db, CURSOR_KEY);
  let newRows = 0;
  let deletions = 0;

  while (true) {
    const page = await client.syncContacts(cursor);
    if (page.contacts.length > 0) {
      const counts = applyPage(db, page.contacts);
      newRows += counts.newRows;
      deletions += counts.deletions;
    }
    cursor = page.next_since;
    if (cursor === null) break;
    writeState(db, CURSOR_KEY, cursor);
  }

  writeState(db, LAST_SYNC_KEY, String(Date.now()));
  log.info('Contact mirror sync complete', { newRows, deletions });
  return { newRows, deletions };
}

/**
 * If the mirror is older than maxAgeMs, blow it away and resync from scratch.
 * No-op if mirror is fresh.
 */
export async function ensureMirrorFresh(
  client: LeadSpotClient,
  db: Database.Database,
  maxAgeMs: number = DEFAULT_STALENESS_MS,
): Promise<void> {
  const lastSyncRaw = readState(db, LAST_SYNC_KEY);
  const lastSync = lastSyncRaw === null ? 0 : Number(lastSyncRaw);
  const ageMs = Date.now() - lastSync;
  if (lastSyncRaw !== null && ageMs < maxAgeMs) return;

  log.warn('Contact mirror stale; doing full reset before resync', {
    ageMs,
    maxAgeMs,
  });
  // Atomic reset.
  const reset = db.transaction(() => {
    db.exec('DELETE FROM contact_mirror; DELETE FROM email_alias_mirror;');
    db
      .prepare('DELETE FROM mirror_sync_state WHERE k IN (?, ?)')
      .run(CURSOR_KEY, LAST_SYNC_KEY);
  });
  reset();

  await syncContactsOnce(client, db);
}

export interface ContactCandidate {
  emailHash?: string;
  linkedinSlug?: string;
  nameNorm?: string;
  companyNorm?: string;
}

export interface ContactMatch {
  contactId: string;
  /** Bonus to add to the extractor base confidence. */
  confidenceBonus: number;
}

/**
 * Resolve a candidate to a contact_id, or null. See file header for precedence.
 *
 * Tombstoned rows (deleted=1) are ignored. Two same-name matches without a
 * company disambiguator return null — caller must drop with conf=50 per §2.3.
 */
export function lookupContact(
  db: Database.Database,
  candidate: ContactCandidate,
): ContactMatch | null {
  // 1. email_hash via email_alias_mirror (which carries every alias).
  if (candidate.emailHash !== undefined && candidate.emailHash.length > 0) {
    const row = db
      .prepare(
        `SELECT cm.contact_id AS contact_id
         FROM email_alias_mirror eam
         JOIN contact_mirror cm ON cm.contact_id = eam.contact_id
         WHERE eam.email_hash = ? AND cm.deleted = 0
         LIMIT 1`,
      )
      .get(candidate.emailHash) as { contact_id: string } | undefined;
    if (row !== undefined) {
      return { contactId: row.contact_id, confidenceBonus: 0 };
    }
  }

  // 2. linkedin_slug.
  if (candidate.linkedinSlug !== undefined && candidate.linkedinSlug.length > 0) {
    const row = db
      .prepare(
        'SELECT contact_id FROM contact_mirror WHERE linkedin_slug = ? AND deleted = 0 LIMIT 1',
      )
      .get(candidate.linkedinSlug) as { contact_id: string } | undefined;
    if (row !== undefined) {
      return { contactId: row.contact_id, confidenceBonus: 0 };
    }
  }

  // 3. name + (optional) company.
  if (candidate.nameNorm !== undefined && candidate.nameNorm.length > 0) {
    const rows = db
      .prepare(
        'SELECT contact_id, company_norm FROM contact_mirror '
          + 'WHERE name_norm = ? AND deleted = 0',
      )
      .all(candidate.nameNorm) as Array<{
      contact_id: string;
      company_norm: string | null;
    }>;

    if (rows.length === 1) {
      return { contactId: rows[0].contact_id, confidenceBonus: 0 };
    }
    if (rows.length > 1) {
      // Try to disambiguate by company.
      if (
        candidate.companyNorm !== undefined
        && candidate.companyNorm.length > 0
      ) {
        const filtered = rows.filter((r) => r.company_norm === candidate.companyNorm);
        if (filtered.length === 1) {
          return { contactId: filtered[0].contact_id, confidenceBonus: 0 };
        }
      }
      // Still ambiguous → caller should drop (§2.3).
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyPage(
  db: Database.Database,
  contacts: readonly ContactSyncRow[],
): SyncResult {
  let newRows = 0;
  let deletions = 0;

  const upsertContact = db.prepare(
    `INSERT INTO contact_mirror
       (contact_id, email_hash, linkedin_slug, name_norm, company_norm, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(contact_id) DO UPDATE SET
       email_hash    = excluded.email_hash,
       linkedin_slug = excluded.linkedin_slug,
       name_norm     = excluded.name_norm,
       company_norm  = excluded.company_norm,
       updated_at    = excluded.updated_at,
       deleted       = 0`,
  );
  const tombstoneContact = db.prepare(
    `INSERT INTO contact_mirror (contact_id, updated_at, deleted)
     VALUES (?, ?, 1)
     ON CONFLICT(contact_id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at`,
  );
  const clearAliases = db.prepare(
    'DELETE FROM email_alias_mirror WHERE contact_id = ?',
  );
  const insertAlias = db.prepare(
    'INSERT OR REPLACE INTO email_alias_mirror (email_hash, contact_id, is_primary) VALUES (?, ?, ?)',
  );

  const apply = db.transaction((rows: readonly ContactSyncRow[]) => {
    for (const c of rows) {
      const updatedAtMs = Date.parse(c.updated_at);
      if (c.deleted) {
        tombstoneContact.run(c.contact_id, isFinite(updatedAtMs) ? updatedAtMs : Date.now());
        clearAliases.run(c.contact_id);
        deletions += 1;
        continue;
      }
      upsertContact.run(
        c.contact_id,
        c.email_hash,
        c.linkedin_slug,
        c.name_norm,
        c.company_norm,
        isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
      );
      // Replace alias set wholesale: simplest correct semantics. Cloud
      // returns the full alias list per row.
      clearAliases.run(c.contact_id);
      for (let i = 0; i < c.aliases.length; i += 1) {
        const hash = c.aliases[i];
        if (hash.length === 0) continue;
        insertAlias.run(hash, c.contact_id, i === 0 ? 1 : 0);
      }
      newRows += 1;
    }
  });
  apply(contacts);

  return { newRows, deletions };
}

function readState(db: Database.Database, key: string): string | null {
  const row = db
    .prepare('SELECT v FROM mirror_sync_state WHERE k = ?')
    .get(key) as { v: string } | undefined;
  return row === undefined ? null : row.v;
}

function writeState(db: Database.Database, key: string, value: string): void {
  db
    .prepare(
      'INSERT INTO mirror_sync_state (k, v) VALUES (?, ?) '
        + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    )
    .run(key, value);
}
