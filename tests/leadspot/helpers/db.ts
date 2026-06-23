/**
 * Test helper: create a fully-migrated in-memory SQLite database.
 *
 * Uses better-sqlite3 directly (sync API, compatible with promote-state.ts).
 * Each test that calls openTestDb() gets an isolated in-memory database with
 * all migrations from storage/schema.ts applied.
 */

import Database from 'better-sqlite3';
import { MIGRATIONS } from '../../../src/storage/schema.js';

export function openTestDb(): Database.Database {
  const db = new Database(':memory:');

  // Enable WAL mode + busy timeout as the production daemon does.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Bootstrap migration tracker.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    );
  `);

  // Apply every migration in order.
  for (const migration of MIGRATIONS) {
    const already = db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(migration.version);
    if (already !== undefined) continue;

    const run = db.transaction(() => {
      db.exec(migration.sql);
      db
        .prepare(
          'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
        )
        .run(migration.version, migration.description);
    });
    run();
  }

  return db;
}

/**
 * Insert a contact into contact_mirror and email_alias_mirror (for lookup tests).
 */
export function insertContact(
  db: Database.Database,
  opts: {
    contactId: string;
    emailHash?: string;
    linkedinSlug?: string;
    nameNorm?: string;
    companyNorm?: string;
    aliases?: string[];
  },
): void {
  db
    .prepare(
      `INSERT INTO contact_mirror
         (contact_id, email_hash, linkedin_slug, name_norm, company_norm, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(contact_id) DO UPDATE SET
         email_hash = excluded.email_hash,
         linkedin_slug = excluded.linkedin_slug,
         name_norm = excluded.name_norm,
         company_norm = excluded.company_norm,
         updated_at = excluded.updated_at,
         deleted = 0`,
    )
    .run(
      opts.contactId,
      opts.emailHash ?? null,
      opts.linkedinSlug ?? null,
      opts.nameNorm ?? null,
      opts.companyNorm ?? null,
      Date.now(),
    );

  const aliases = opts.aliases ?? (opts.emailHash ? [opts.emailHash] : []);
  for (let i = 0; i < aliases.length; i += 1) {
    db
      .prepare(
        'INSERT OR REPLACE INTO email_alias_mirror (email_hash, contact_id, is_primary) VALUES (?, ?, ?)',
      )
      .run(aliases[i], opts.contactId, i === 0 ? 1 : 0);
  }
}

/**
 * Stamp the mirror_sync_state so promote-send's assertMirrorFresh() is happy.
 * Pass msAgo=0 (default) to stamp "just synced".
 */
export function stampMirrorFresh(db: Database.Database, msAgo = 0): void {
  db
    .prepare(
      `INSERT INTO mirror_sync_state (k, v) VALUES ('contact_mirror_last_sync_ms', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    )
    .run(String(Date.now() - msAgo));
}

/** Read a signal row by id. */
export function getSignal(
  db: Database.Database,
  id: string,
): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM leadspot_signals WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
}

/** Count rows in a table. */
export function countRows(db: Database.Database, table: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}
