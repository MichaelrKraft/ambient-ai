/**
 * Outbox-send mechanics for promote.ts.
 *
 * Owns: cloud POST + classification of failures into the right backoff /
 * archive / re-auth path. promote.ts wraps this to drain the outbox.
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { LeadSpotClient } from './client.js';
import { AuthError, NetworkError } from './errors.js';
import {
  archiveSignal,
  bumpOutboxBackoff,
  markPromoted,
  removeFromOutbox,
  signalForOutbox,
} from './promote-state.js';
import type {
  PostSignalRequest,
  PostSignalResponse,
} from './types.js';

const log = createLogger('leadspot:promote-send');

/** 30 days from enqueue → archive (§2.2 outbox cap). */
export const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 7 days = §2.2 force-resync staleness threshold. */
export const MIRROR_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export const SCHEMA_VERSION = 1;

/** Backoff schedule (ms): 300, 1.2s, 4.8s, 19.2s, 76.8s, 5min, 20min, 1h. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  300, 1_200, 4_800, 19_200, 76_800, 300_000, 1_200_000, 3_600_000,
];

/**
 * Check the mirror staleness rule. Throws if the mirror was last synced
 * more than MIRROR_STALE_MS ago. Caller (the daemon scheduler) should run
 * `mirror.ensureMirrorFresh(...)` before calling tickPromote again.
 */
export function assertMirrorFresh(db: Database.Database): void {
  const row = db
    .prepare("SELECT v FROM mirror_sync_state WHERE k = 'contact_mirror_last_sync_ms'")
    .get() as { v: string } | undefined;
  if (row === undefined) return;  // Never synced; caller bootstraps separately.
  const age = Date.now() - Number(row.v);
  if (age > MIRROR_STALE_MS) {
    throw new Error(
      `Mirror is stale (${Math.round(age / 86400000)}d); call ensureMirrorFresh() before tickPromote()`,
    );
  }
}

/**
 * Build the wire payload from a local signal row and POST it. On 2xx or
 * 409 (idempotent replay), mark promoted + drop from outbox. Returns
 * true if a row was promoted.
 */
export async function sendOne(
  db: Database.Database,
  client: LeadSpotClient,
  daemonId: string,
  signalId: string,
): Promise<boolean> {
  const sig = signalForOutbox(db, signalId);
  if (sig === null) {
    removeFromOutbox(db, signalId);
    return false;
  }

  const payload: PostSignalRequest = {
    idempotency_key: sig.idempotency_key,
    contact_match_key: sig.contact_match_key,
    source: sig.source,
    source_app: sig.source_app,
    extractor: sig.extractor,
    summary: sig.summary,
    confidence: sig.confidence,
    observed_at: new Date(sig.observed_at).toISOString(),
    ocr_snippet_hash: sig.ocr_snippet_hash,
    extras:
      sig.extras !== null
        ? (JSON.parse(sig.extras) as Record<string, unknown>)
        : null,
    daemon_id: daemonId,
    schema_version: SCHEMA_VERSION,
  };

  const res: PostSignalResponse = await client.postSignal(payload);
  markPromoted(db, signalId, res.contact_id);
  removeFromOutbox(db, signalId);
  log.debug('signal promoted', { signalId, cloudId: res.signal_id });
  return true;
}

/**
 * Classify a send failure and update the outbox row accordingly.
 * VersionMismatchError is the caller's responsibility to re-throw.
 */
export function handleSendFailure(
  db: Database.Database,
  signalId: string,
  err: unknown,
): void {
  const status = err instanceof NetworkError ? err.status : undefined;
  const retryAfterSec
    = err instanceof NetworkError ? err.retryAfterSec : undefined;

  // 401 / AuthError: leave in outbox; retry next tick after token refresh.
  if (err instanceof AuthError) {
    bumpOutboxBackoff(db, signalId, BACKOFF_SCHEDULE_MS, String(err.message));
    return;
  }

  // Permanent 4xx (anything other than 401/429) → archive.
  if (
    status !== undefined && status >= 400 && status < 500
    && status !== 401 && status !== 429
  ) {
    archiveSignal(db, signalId, 'permanent_4xx');
    log.warn('signal archived (permanent 4xx)', { signalId, status });
    return;
  }

  // 429: honor Retry-After if provided, else fall through to backoff.
  if (status === 429 && retryAfterSec !== undefined) {
    const next = Date.now() + retryAfterSec * 1000;
    db
      .prepare(
        'UPDATE leadspot_outbox SET next_attempt_at = ?, attempts = attempts + 1, last_error = ? WHERE signal_id = ?',
      )
      .run(next, '429 Retry-After honored', signalId);
    return;
  }

  // 30-day TTL: aged-out signals never promote.
  const enqueued = db
    .prepare('SELECT enqueued_at FROM leadspot_outbox WHERE signal_id = ?')
    .get(signalId) as { enqueued_at: number } | undefined;
  if (enqueued !== undefined && Date.now() - enqueued.enqueued_at > OUTBOX_TTL_MS) {
    archiveSignal(db, signalId, 'aged_out');
    return;
  }

  // 5xx / network → exponential backoff.
  bumpOutboxBackoff(
    db,
    signalId,
    BACKOFF_SCHEDULE_MS,
    err instanceof Error ? err.message : String(err),
  );
}
