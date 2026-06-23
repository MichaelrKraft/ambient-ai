/**
 * Promotion gate state machine (§2.2 of the integration plan).
 *
 *   captured → enriched → matched → held_local (60s) → queued → promoted
 *                                                            ↘ archived (30d)
 *   off-ramps: dropped (low conf / self / bot / cancel),
 *              held (review queue, conf 60–84),
 *              redacted (tombstone arrived).
 *
 * The 60s hold lives in JS-process memory (setTimeout). On daemon restart
 * a held_local row stays in `held_local` state until the next tick — the
 * promote ticker scans for stale held_local rows and either queues them
 * (timer would have fired) or leaves them.
 *
 * Companion files:
 *   - promote-policy.ts (decideOutcome: confidence math, routing)
 *   - promote-state.ts  (sql helpers)
 *   - promote-send.ts   (cloud POST + failure classification)
 */
import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { LeadSpotClient } from './client.js';
import type { SignalCandidate } from './extractors.js';
import type { Notifier } from './notifier.js';
import { VersionMismatchError } from './errors.js';
import { decideOutcome } from './promote-policy.js';
import {
  insertSignal,
  insertUnmatched,
  loadDueOutbox,
  setSignalState,
  staleHeldLocalIds,
  transitionFromHeldLocal,
} from './promote-state.js';
import {
  assertMirrorFresh,
  handleSendFailure,
  sendOne,
} from './promote-send.js';

const log = createLogger('leadspot:promote');

/** 60s local hold (§2.2). User can click toast within this window to cancel. */
const HOLD_WINDOW_MS = 60_000;

export interface PromoteContext {
  db: Database.Database;
  client: LeadSpotClient;
  daemonId: string;
  organizationId: string;
  notifier: Notifier;
}

export interface IngestResult {
  accepted: number;
  dropped: number;
}

export interface TickResult {
  promoted: number;
  errors: number;
}

/**
 * Insert candidates as signals, run the matching/confidence pipeline, and
 * either drop them, hold them in review, or schedule them for promotion.
 *
 * Idempotent on (observed_minute, matchKey, extractor, ocrTextHash).
 */
export async function ingestCandidates(
  ctx: PromoteContext,
  candidates: SignalCandidate[],
  ocrTextHash?: string,
): Promise<IngestResult> {
  let accepted = 0;
  let dropped = 0;

  for (const candidate of candidates) {
    const observedAt = Date.now();
    const idemKey = computeIdempotencyKey(observedAt, candidate, ocrTextHash);

    // Idempotency: skip if we already wrote this signal in a previous tick.
    const existing = ctx.db
      .prepare('SELECT id, state FROM leadspot_signals WHERE idempotency_key = ?')
      .get(idemKey) as { id: string; state: string } | undefined;
    if (existing !== undefined) {
      log.debug('idempotent skip', { id: existing.id, state: existing.state });
      continue;
    }

    const id = randomUUID();
    const result = decideOutcome(ctx.db, candidate);

    insertSignal(ctx.db, {
      id,
      idempotencyKey: idemKey,
      contactId: result.contactId,
      contactMatchKey: candidate.matchKey,
      sourceApp: null,  // Caller can stamp via extras if needed.
      extractor: candidate.extractor,
      summary: candidate.redactedSummary,
      confidence: result.confidence,
      state: result.state,
      observedAt,
      ocrSnippetHash: candidate.ocrSnippetHash ?? null,
      extras: result.extras,
    });

    if (result.state === 'held_local') {
      accepted += 1;
      scheduleHoldTimer(ctx, id);
      void ctx.notifier.show({
        signalId: id,
        contactId: result.contactId,
        summary: candidate.redactedSummary,
        sourceApp: candidate.candidateNameHint ?? '',
        onCancel: async (signalId) => {
          await cancelHeld(ctx, signalId);
        },
      });
    } else if (result.state === 'held') {
      accepted += 1;
    } else if (result.state === 'dropped') {
      dropped += 1;
      if (result.dropReason === 'unmatched') {
        insertUnmatched(ctx.db, {
          id,
          contactMatchKey: candidate.matchKey,
          sourceApp: null,
          extractor: candidate.extractor,
          summary: candidate.redactedSummary,
          observedAt,
        });
      }
    }
  }

  return { accepted, dropped };
}

/**
 * User clicked the toast within the 60s window. Transition to dropped.
 * Returns true if cancellation succeeded (signal was still held_local).
 *
 * Race-safe: the UPDATE is conditional on `state = 'held_local'`, so if the
 * 60s timer already fired and moved the row to `queued`, this caller
 * harmlessly returns false rather than overwriting `queued` with `dropped`.
 */
export async function cancelHeld(
  ctx: PromoteContext,
  signalId: string,
): Promise<boolean> {
  const won = transitionFromHeldLocal(ctx.db, signalId, 'dropped', {
    cancelledAt: Date.now(),
    reason: 'user_cancelled',
  });
  if (won) log.info('signal cancelled by user', { signalId });
  return won;
}

/**
 * Drain due outbox rows. Promotes successful signals, applies backoff to
 * transient failures, archives terminal ones.
 *
 * Throws VersionMismatchError if cloud rejects with 426 — caller pauses.
 */
export async function tickPromote(ctx: PromoteContext): Promise<TickResult> {
  assertMirrorFresh(ctx.db);
  promoteStaleHeldLocal(ctx);

  const due = loadDueOutbox(ctx.db, Date.now(), 50);
  let promoted = 0;
  let errors = 0;

  for (const row of due) {
    try {
      const ok = await sendOne(ctx.db, ctx.client, ctx.daemonId, row.signal_id);
      if (ok) promoted += 1;
    } catch (err) {
      if (err instanceof VersionMismatchError) throw err;
      errors += 1;
      handleSendFailure(ctx.db, row.signal_id, err);
    }
  }

  return { promoted, errors };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scheduleHoldTimer(ctx: PromoteContext, signalId: string): void {
  setTimeout(() => {
    try {
      // Atomic: only transitions if still held_local. If cancelHeld won
      // the race, this no-ops harmlessly and the user's drop intent stands.
      const won = transitionFromHeldLocal(ctx.db, signalId, 'queued');
      if (won) enqueueOutbox(ctx.db, signalId);
    } catch (err) {
      log.error('hold timer firing failed', err);
    }
  }, HOLD_WINDOW_MS).unref();
}

function enqueueOutbox(db: Database.Database, signalId: string): void {
  db
    .prepare(
      `INSERT INTO leadspot_outbox (signal_id, attempts, next_attempt_at, enqueued_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(signal_id) DO NOTHING`,
    )
    .run(signalId, Date.now(), Date.now());
}

function promoteStaleHeldLocal(ctx: PromoteContext): void {
  // If the daemon was killed during a held window the timer never fired.
  // Sweep anything older than 60s — but use the same atomic predicate so we
  // can't race a same-tick cancelHeld either.
  const cutoff = Date.now() - HOLD_WINDOW_MS;
  for (const id of staleHeldLocalIds(ctx.db, cutoff)) {
    const won = transitionFromHeldLocal(ctx.db, id, 'queued');
    if (won) enqueueOutbox(ctx.db, id);
  }
}

/**
 * Idempotency key — sha256 of (observedMinute|matchKey|extractor|ocrHash).
 * Truncating to the minute means two captures of the same screen within
 * the same minute don't double-write.
 */
function computeIdempotencyKey(
  observedAtMs: number,
  candidate: SignalCandidate,
  ocrTextHash?: string,
): string {
  const minute = Math.floor(observedAtMs / 60_000);
  const payload
    = `${minute}|${candidate.matchKey}|${candidate.extractor}|${ocrTextHash ?? ''}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
