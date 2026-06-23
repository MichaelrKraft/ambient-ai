/**
 * Tombstone replication (§2.2 cloud rejection / GDPR / cancellation flows).
 *
 * The cloud emits tombstones when:
 *   - A signal is soft-deleted server-side (drop button in UI)
 *   - A contact is deleted/merged
 *   - A user requests right-to-be-forgotten by email_hash (§11.2)
 *   - A subscription becomes inactive (§14)
 *
 * Daemon applies them on its local mirror + signals + unmatched log + (for
 * subscription) wipes leadspot_* entirely.
 *
 * Cursor lives in mirror_sync_state under 'tombstones_since'. Each applied
 * tombstone is recorded in leadspot_tombstones_seen so we never replay.
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { PromoteContext } from './promote.js';
import type { TombstoneRow } from './types.js';

const log = createLogger('leadspot:tombstones');

const CURSOR_KEY = 'tombstones_since';

const SUBSCRIPTION_TABLES: readonly string[] = [
  'leadspot_signals',
  'leadspot_outbox',
  'leadspot_signal_archive',
  'leadspot_unmatched',
  'leadspot_tombstones_seen',
  'self_identity',
  'contact_mirror',
  'email_alias_mirror',
];

export interface TombstoneTickResult {
  applied: number;
}

/**
 * Pull and apply tombstones. Returns a count of applied (skips dedup hits).
 * Throws on auth/network failure — caller logs and retries on next tick.
 */
export async function tickTombstones(
  ctx: PromoteContext,
): Promise<TombstoneTickResult> {
  let cursor = readCursor(ctx.db);
  let applied = 0;

  // Drain pages until next_since=null. Bounded — cloud paginates.
  while (true) {
    const page = await ctx.client.getTombstones(cursor);
    for (const t of page.tombstones) {
      if (alreadySeen(ctx.db, t.id)) continue;
      try {
        applyOne(ctx.db, t);
        markSeen(ctx.db, t.id);
        applied += 1;
      } catch (err) {
        log.error('failed to apply tombstone', err);
        // We don't mark as seen so it'll retry next tick.
      }
    }
    if (page.next_since === null) break;
    cursor = page.next_since;
    writeCursor(ctx.db, cursor);
  }

  if (cursor !== null) writeCursor(ctx.db, cursor);
  if (applied > 0) log.info('tombstones applied', { applied });
  return { applied };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function applyOne(db: Database.Database, t: TombstoneRow): void {
  switch (t.tombstone_type) {
    case 'signal':
      if (t.signal_id !== null) {
        db
          .prepare(
            "UPDATE leadspot_signals SET state = 'redacted' WHERE id = ?",
          )
          .run(t.signal_id);
        db
          .prepare('DELETE FROM leadspot_outbox WHERE signal_id = ?')
          .run(t.signal_id);
      }
      return;

    case 'contact':
      if (t.contact_id !== null) {
        db
          .prepare(
            "UPDATE leadspot_signals SET state = 'redacted' WHERE contact_id = ?",
          )
          .run(t.contact_id);
        db
          .prepare(
            'DELETE FROM leadspot_outbox WHERE signal_id IN (SELECT id FROM leadspot_signals WHERE contact_id = ?)',
          )
          .run(t.contact_id);
        db
          .prepare('DELETE FROM contact_mirror WHERE contact_id = ?')
          .run(t.contact_id);
        db
          .prepare('DELETE FROM email_alias_mirror WHERE contact_id = ?')
          .run(t.contact_id);
      }
      return;

    case 'email_hash':
      if (t.email_hash !== null) {
        db
          .prepare(
            `UPDATE leadspot_signals SET state = 'redacted'
              WHERE contact_match_key = ?`,
          )
          .run(t.email_hash);
        db
          .prepare(
            `DELETE FROM leadspot_outbox
              WHERE signal_id IN (
                SELECT id FROM leadspot_signals WHERE contact_match_key = ?
              )`,
          )
          .run(t.email_hash);
        db
          .prepare('DELETE FROM leadspot_unmatched WHERE contact_match_key = ?')
          .run(t.email_hash);
      }
      return;

    case 'subscription':
      // Wipe ALL leadspot_* tables and flag credentials inactive.
      // Contact mirror + self_identity also gone — we re-populate at next
      // login if the user resubscribes.
      const wipe = db.transaction(() => {
        for (const tbl of SUBSCRIPTION_TABLES) {
          db.exec(`DELETE FROM ${tbl}`);
        }
        // Mark daemon inactive — daemon main loop checks this and pauses.
        db.exec(
          `UPDATE daemon_credentials_local SET device_label = device_label || ' (inactive)'`,
        );
      });
      wipe();
      log.warn('subscription tombstone applied — daemon entering inactive state');
      return;

    default:
      log.warn('unknown tombstone_type', { type: t.tombstone_type });
  }
}

function alreadySeen(db: Database.Database, id: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM leadspot_tombstones_seen WHERE tombstone_id = ?')
    .get(id);
  return row !== undefined;
}

function markSeen(db: Database.Database, id: string): void {
  db
    .prepare(
      `INSERT INTO leadspot_tombstones_seen (tombstone_id, applied_at)
       VALUES (?, ?)
       ON CONFLICT(tombstone_id) DO NOTHING`,
    )
    .run(id, Date.now());
}

function readCursor(db: Database.Database): string | null {
  const row = db
    .prepare('SELECT v FROM mirror_sync_state WHERE k = ?')
    .get(CURSOR_KEY) as { v: string } | undefined;
  return row !== undefined ? row.v : null;
}

function writeCursor(db: Database.Database, cursor: string): void {
  db
    .prepare(
      `INSERT INTO mirror_sync_state (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    )
    .run(CURSOR_KEY, cursor);
}
