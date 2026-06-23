/**
 * State-machine SQL helpers for promote.ts.
 *
 * Kept separate so promote.ts can stay focused on policy (when to drop /
 * hold / queue) while this file owns the data-layer mechanics.
 *
 * All functions are synchronous: better-sqlite3 is sync by design and the
 * promote pipeline is single-threaded by intent.
 */
import type Database from 'better-sqlite3';

const SOURCE = 'ambient_screen';

export interface InsertSignalArgs {
  id: string;
  idempotencyKey: string;
  contactId: string | null;
  contactMatchKey: string;
  sourceApp: string | null;
  extractor: string;
  summary: string;
  confidence: number;
  state: string;
  observedAt: number;
  ocrSnippetHash: string | null;
  extras: Record<string, unknown> | null;
}

export function insertSignal(
  db: Database.Database,
  args: InsertSignalArgs,
): void {
  db
    .prepare(
      `INSERT INTO leadspot_signals
        (id, idempotency_key, contact_id, contact_match_key, source, source_app,
         extractor, summary, confidence, state, observed_at, created_at,
         ocr_snippet_hash, extras)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.idempotencyKey,
      args.contactId,
      args.contactMatchKey,
      SOURCE,
      args.sourceApp,
      args.extractor,
      args.summary,
      args.confidence,
      args.state,
      args.observedAt,
      Date.now(),
      args.ocrSnippetHash,
      args.extras !== null ? JSON.stringify(args.extras) : null,
    );
}

export interface SetStateOpts {
  reason?: string;
  cancelledAt?: number;
}

export function setSignalState(
  db: Database.Database,
  signalId: string,
  state: string,
  opts: SetStateOpts = {},
): void {
  if (opts.cancelledAt !== undefined) {
    db
      .prepare(
        'UPDATE leadspot_signals SET state = ?, cancelled_at = ? WHERE id = ?',
      )
      .run(state, opts.cancelledAt, signalId);
    return;
  }
  db
    .prepare('UPDATE leadspot_signals SET state = ? WHERE id = ?')
    .run(state, signalId);
}

/**
 * Atomic transition out of held_local — only succeeds when the row is still
 * in held_local. Returns true if this caller won the transition.
 *
 * Race we're guarding: the 60s timer and `cancelHeld` both want to leave
 * held_local. With non-conditional UPDATE the late writer would clobber the
 * early one (e.g. cancel races with timer → row ends up `queued`, the user's
 * intent is lost). The `state = 'held_local'` predicate makes exactly one
 * caller win regardless of interleaving.
 */
export function transitionFromHeldLocal(
  db: Database.Database,
  signalId: string,
  toState: string,
  opts: SetStateOpts = {},
): boolean {
  let result;
  if (opts.cancelledAt !== undefined) {
    result = db
      .prepare(
        `UPDATE leadspot_signals SET state = ?, cancelled_at = ?
          WHERE id = ? AND state = 'held_local'`,
      )
      .run(toState, opts.cancelledAt, signalId);
  } else {
    result = db
      .prepare(
        `UPDATE leadspot_signals SET state = ?
          WHERE id = ? AND state = 'held_local'`,
      )
      .run(toState, signalId);
  }
  return result.changes === 1;
}

export function markPromoted(
  db: Database.Database,
  signalId: string,
  contactId: string | null,
): void {
  db
    .prepare(
      `UPDATE leadspot_signals
         SET state = 'promoted', promoted_at = ?, contact_id = COALESCE(?, contact_id)
       WHERE id = ?`,
    )
    .run(Date.now(), contactId, signalId);
}

export interface UnmatchedArgs {
  id: string;
  contactMatchKey: string;
  sourceApp: string | null;
  extractor: string;
  summary: string;
  observedAt: number;
}

export function insertUnmatched(
  db: Database.Database,
  args: UnmatchedArgs,
): void {
  db
    .prepare(
      `INSERT INTO leadspot_unmatched
         (id, contact_match_key, source_app, extractor, summary, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      args.contactMatchKey,
      args.sourceApp,
      args.extractor,
      args.summary,
      args.observedAt,
      Date.now(),
    );
}

/**
 * Return the most recent observed_at (ms) for a contact within `days`,
 * or null if none. Used by promote.ts for the +10 activity bonus.
 */
export function recentSignalForContact(
  db: Database.Database,
  contactId: string,
  days: number,
): number | null {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT observed_at FROM leadspot_signals
        WHERE contact_id = ? AND observed_at >= ?
        ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(contactId, cutoff) as { observed_at: number } | undefined;
  return row !== undefined ? row.observed_at : null;
}

export interface OutboxRow {
  signal_id: string;
  attempts: number;
  enqueued_at: number;
}

/**
 * Pull at most `limit` outbox rows whose next_attempt_at <= cutoffMs.
 * Caller iterates and dispatches.
 */
export function loadDueOutbox(
  db: Database.Database,
  cutoffMs: number,
  limit: number,
): OutboxRow[] {
  return db
    .prepare(
      `SELECT signal_id, attempts, enqueued_at FROM leadspot_outbox
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at ASC LIMIT ?`,
    )
    .all(cutoffMs, limit) as OutboxRow[];
}

export interface OutboxSignal {
  idempotency_key: string;
  contact_match_key: string;
  source: string;
  source_app: string | null;
  extractor: string;
  summary: string;
  confidence: number;
  observed_at: number;
  ocr_snippet_hash: string | null;
  extras: string | null;
}

export function signalForOutbox(
  db: Database.Database,
  signalId: string,
): OutboxSignal | null {
  const row = db
    .prepare(
      `SELECT idempotency_key, contact_match_key, source, source_app, extractor,
              summary, confidence, observed_at, ocr_snippet_hash, extras
         FROM leadspot_signals WHERE id = ?`,
    )
    .get(signalId) as OutboxSignal | undefined;
  return row !== undefined ? row : null;
}

export function removeFromOutbox(
  db: Database.Database,
  signalId: string,
): void {
  db.prepare('DELETE FROM leadspot_outbox WHERE signal_id = ?').run(signalId);
}

/**
 * Increment attempts and schedule next try according to backoff schedule.
 * If we've exhausted the schedule, hold at the cap.
 */
export function bumpOutboxBackoff(
  db: Database.Database,
  signalId: string,
  schedule: readonly number[],
  reason: string,
): void {
  const row = db
    .prepare('SELECT attempts FROM leadspot_outbox WHERE signal_id = ?')
    .get(signalId) as { attempts: number } | undefined;
  if (row === undefined) return;
  const idx = Math.min(row.attempts, schedule.length - 1);
  const delay = schedule[idx];
  db
    .prepare(
      `UPDATE leadspot_outbox
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?
       WHERE signal_id = ?`,
    )
    .run(Date.now() + delay, reason, signalId);
}

/**
 * Move a signal to the archive (terminal). The outbox row is removed.
 */
export function archiveSignal(
  db: Database.Database,
  signalId: string,
  reason: 'aged_out' | 'permanent_4xx',
): void {
  const tx = db.transaction(() => {
    db
      .prepare(
        `INSERT INTO leadspot_signal_archive (signal_id, archived_at, reason)
         VALUES (?, ?, ?)
         ON CONFLICT(signal_id) DO NOTHING`,
      )
      .run(signalId, Date.now(), reason);
    db
      .prepare("UPDATE leadspot_signals SET state = 'archived' WHERE id = ?")
      .run(signalId);
    db.prepare('DELETE FROM leadspot_outbox WHERE signal_id = ?').run(signalId);
  });
  tx();
}

/**
 * IDs of held_local signals whose 60s timer should already have fired
 * (process restart case). Caller transitions them to queued.
 */
export function staleHeldLocalIds(
  db: Database.Database,
  cutoffMs: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM leadspot_signals
        WHERE state = 'held_local' AND observed_at <= ?`,
    )
    .all(cutoffMs) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
