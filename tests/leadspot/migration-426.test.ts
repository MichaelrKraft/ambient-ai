/**
 * Migration / 426 version-mismatch tests (§12.6 of ghostlog-integration-plan.md).
 *
 * Tests:
 *  1. postSignal stub returning 426 → tickPromote throws VersionMismatchError
 *  2. VersionMismatchError carries minVersion from server response
 *  3. 2xx from server → signal promoted, no error
 *  4. 409 (idempotent replay) → treated as success, signal promoted
 *  5. Permanent 4xx (e.g. 403) → signal archived, not retried indefinitely
 *  6. NetworkError on fetch → outbox entry bumped with backoff, not thrown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openTestDb, stampMirrorFresh, getSignal, countRows } from './helpers/db.js';
import { tickPromote } from '../../src/leadspot/promote.js';
import type { PromoteContext } from '../../src/leadspot/promote.js';
import { NoopNotifier } from '../../src/leadspot/notifier.js';
import { NetworkError, VersionMismatchError } from '../../src/leadspot/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContextWithClient(
  db: Database.Database,
  client: import('../../src/leadspot/client.js').LeadSpotClient,
): PromoteContext {
  return {
    db,
    client,
    daemonId: 'test-daemon-001',
    organizationId: 'test-org-001',
    notifier: new NoopNotifier(),
  };
}

/** Insert a signal directly into queued state and add an outbox row. */
function insertQueuedSignal(db: Database.Database): string {
  const signalId = randomUUID();
  const now = Date.now();
  db
    .prepare(
      `INSERT INTO leadspot_signals
        (id, idempotency_key, contact_id, contact_match_key, source, source_app,
         extractor, summary, confidence, state, observed_at, created_at)
       VALUES (?, ?, null, 'email-hash-test', 'ambient_screen', null,
               'explicit_email', 'Email mention · test.com', 90, 'queued', ?, ?)`,
    )
    .run(signalId, randomUUID(), now, now);

  db
    .prepare(
      'INSERT INTO leadspot_outbox (signal_id, attempts, next_attempt_at, enqueued_at) VALUES (?, 0, ?, ?)',
    )
    .run(signalId, now - 1, now - 1);

  return signalId;
}

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
  stampMirrorFresh(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// 1 & 2. 426 → VersionMismatchError with minVersion
// ---------------------------------------------------------------------------

describe('migration-426: 426 response handling', () => {
  it('tickPromote throws VersionMismatchError when postSignal gets 426', async () => {
    const versionErr = new VersionMismatchError(
      'Daemon version 1.0.0 rejected by cloud (426)',
      { minVersion: '2.0.0', currentVersion: '1.0.0' },
    );

    const client = {
      postSignal: vi.fn().mockRejectedValue(versionErr),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    insertQueuedSignal(db);

    const ctx = makeContextWithClient(db, client);
    await expect(tickPromote(ctx)).rejects.toThrow(VersionMismatchError);
  });

  it('VersionMismatchError exposes minVersion from server', async () => {
    const versionErr = new VersionMismatchError('426', { minVersion: '3.0.0' });
    expect(versionErr.minVersion).toBe('3.0.0');
    expect(versionErr).toBeInstanceOf(VersionMismatchError);
    expect(versionErr.name).toBe('VersionMismatchError');
  });

  it('VersionMismatchError is NOT caught by non-426 catch paths', async () => {
    // Verify that VersionMismatchError propagates even through the generic error handler.
    const versionErr = new VersionMismatchError('426 from cloud');

    // tickPromote re-throws VersionMismatchError; other errors go through handleSendFailure.
    const client = {
      postSignal: vi.fn().mockRejectedValue(versionErr),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    try {
      await tickPromote(ctx);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionMismatchError);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 2xx → signal promoted
// ---------------------------------------------------------------------------

describe('migration-426: successful promotion', () => {
  it('2xx response marks signal as promoted and removes outbox row', async () => {
    const cloudSignalId = randomUUID();
    const client = {
      postSignal: vi.fn().mockResolvedValue({
        signal_id: cloudSignalId,
        contact_id: null,
        state: 'promoted',
      }),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    const signalId = insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    const result = await tickPromote(ctx);
    expect(result.promoted).toBe(1);
    expect(result.errors).toBe(0);

    expect(getSignal(db, signalId)?.state).toBe('promoted');
    expect(countRows(db, 'leadspot_outbox')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 409 → treated as success (idempotent replay)
// ---------------------------------------------------------------------------

describe('migration-426: 409 idempotent replay', () => {
  it('409 NetworkError from postSignal is treated as promoted', async () => {
    // postSignal in client.ts converts 409 to a success response internally.
    // So from tickPromote's perspective, sendOne resolves successfully.
    const conflictResponse = {
      signal_id: randomUUID(),
      contact_id: null,
      state: 'promoted',
    };
    const client = {
      postSignal: vi.fn().mockResolvedValue(conflictResponse),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    const signalId = insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    const result = await tickPromote(ctx);
    expect(result.promoted).toBe(1);
    expect(getSignal(db, signalId)?.state).toBe('promoted');
  });
});

// ---------------------------------------------------------------------------
// 5. Permanent 4xx → archived, not retried
// ---------------------------------------------------------------------------

describe('migration-426: permanent 4xx archival', () => {
  it('403 NetworkError from postSignal archives the signal', async () => {
    const permanentErr = new NetworkError('403 on /api/signals: forbidden', { status: 403 });
    const client = {
      postSignal: vi.fn().mockRejectedValue(permanentErr),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    const signalId = insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    // tickPromote counts any caught send failure as errors (the catch block always
    // increments errors). handleSendFailure archives the signal for permanent 4xx.
    const result = await tickPromote(ctx);
    expect(result.errors).toBe(1);   // Counted as error in the loop.
    expect(result.promoted).toBe(0);

    expect(getSignal(db, signalId)?.state).toBe('archived');
    expect(countRows(db, 'leadspot_outbox')).toBe(0);
    expect(countRows(db, 'leadspot_signal_archive')).toBe(1);
  });

  it('404 NetworkError from postSignal archives the signal', async () => {
    const notFoundErr = new NetworkError('404 on /api/signals: not found', { status: 404 });
    const client = {
      postSignal: vi.fn().mockRejectedValue(notFoundErr),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    const signalId = insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    await tickPromote(ctx);
    expect(getSignal(db, signalId)?.state).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// 6. NetworkError on fetch → backoff, outbox entry updated
// ---------------------------------------------------------------------------

describe('migration-426: transient network errors apply backoff', () => {
  it('generic NetworkError (5xx-ish) increments outbox attempts and reschedules', async () => {
    const networkErr = new NetworkError('Request failed after retries');
    const client = {
      postSignal: vi.fn().mockRejectedValue(networkErr),
      getTombstones: vi.fn(),
      syncContacts: vi.fn(),
      getVersion: vi.fn(),
      refreshAccessToken: vi.fn(),
      incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
    } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;

    const signalId = insertQueuedSignal(db);
    const ctx = makeContextWithClient(db, client);

    await tickPromote(ctx);

    // Outbox row should still exist (retrying), with attempts incremented.
    const outboxRow = db
      .prepare('SELECT attempts FROM leadspot_outbox WHERE signal_id = ?')
      .get(signalId) as { attempts: number } | undefined;
    expect(outboxRow).toBeDefined();
    expect(outboxRow!.attempts).toBeGreaterThan(0);

    // Signal stays in 'queued' (not promoted, not archived).
    expect(getSignal(db, signalId)?.state).toBe('queued');
  });
});
