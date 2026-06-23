/**
 * Promote state machine tests (§12.2 of ghostlog-integration-plan.md).
 *
 * Covers:
 *  1. Happy path: held_local → queued → promoted
 *  2. Cancel path: held_local → dropped (user clicked toast)
 *  3. CRITICAL: cancel-timer race — cancelHeld AND timer fire concurrently →
 *     exactly one wins, final state is 'dropped' (never 'queued')
 *  4. Self-identity: signals to own email are always dropped
 *  5. Unmatched signals: drop + write to unmatched log
 *  6. 426 VersionMismatchError bubbles out of tickPromote
 *  7. Stale held_local recovery (daemon restart simulation)
 *  8. Property-based: random lifecycle sequences always terminate cleanly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  countRows,
  getSignal,
  insertContact,
  openTestDb,
  stampMirrorFresh,
} from './helpers/db.js';
import { ingestCandidates, cancelHeld, tickPromote } from '../../src/leadspot/promote.js';
import type { PromoteContext } from '../../src/leadspot/promote.js';
import { NoopNotifier } from '../../src/leadspot/notifier.js';
import { emailHash } from '../../src/leadspot/normalize.js';
import { VersionMismatchError } from '../../src/leadspot/errors.js';
import { transitionFromHeldLocal } from '../../src/leadspot/promote-state.js';
import { addAlias } from '../../src/leadspot/selfid.js';
import type { SignalCandidate } from '../../src/leadspot/extractors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubClient(overrides: Partial<{
  postSignalResult: unknown;
  postSignalError: Error;
}> = {}) {
  return {
    postSignal: overrides.postSignalError
      ? vi.fn().mockRejectedValue(overrides.postSignalError)
      : vi.fn().mockResolvedValue(
          overrides.postSignalResult ?? {
            signal_id: randomUUID(),
            contact_id: null,
            state: 'promoted',
          },
        ),
    getTombstones: vi.fn().mockResolvedValue({ tombstones: [], next_since: null }),
    syncContacts: vi.fn().mockResolvedValue({ contacts: [], next_since: null }),
    getVersion: vi.fn().mockResolvedValue({
      server_version: '1.0.0',
      min_daemon_version: '1.0.0',
      current_daemon_version: '1.0.0',
    }),
    refreshAccessToken: vi.fn(),
    incrementCost: vi.fn().mockResolvedValue({ cost_capped: false }),
  } as unknown as import('../../src/leadspot/client.js').LeadSpotClient;
}

function makeContext(
  db: Database.Database,
  clientOverrides?: Parameters<typeof makeStubClient>[0],
): PromoteContext {
  return {
    db,
    client: makeStubClient(clientOverrides),
    daemonId: 'test-daemon-001',
    organizationId: 'test-org-001',
    notifier: new NoopNotifier(),
  };
}

function candidateForContact(contactEmailHash: string): SignalCandidate {
  return {
    extractor: 'explicit_email',
    matchKey: contactEmailHash,
    matchKeyType: 'email_hash',
    baseConfidence: 90,
    redactedSummary: 'Email mention · acme.com',
    ocrSnippetHash: undefined,
  };
}

// Stamp mirror fresh and insert a contact with confidence ≥85.
function setupContactWithHighConfidence(db: Database.Database): {
  contactId: string;
  hash: string;
  candidate: SignalCandidate;
} {
  stampMirrorFresh(db);
  const contactId = randomUUID();
  const hash = emailHash('jane@acme.com');
  insertContact(db, {
    contactId,
    emailHash: hash,
    aliases: [hash],
    nameNorm: 'jane smith',
  });
  return { contactId, hash, candidate: candidateForContact(hash) };
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('promote state machine — happy path', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('ingest → held_local → queued after 60s → promoted via tickPromote', async () => {
    const { candidate } = setupContactWithHighConfidence(db);

    await ingestCandidates(ctx, [candidate], 'ocr-hash-happy');

    // Signal should be held_local (confidence ≥ 85).
    const signals = db
      .prepare("SELECT id, state FROM leadspot_signals WHERE state = 'held_local'")
      .all() as Array<{ id: string; state: string }>;
    expect(signals).toHaveLength(1);
    const signalId = signals[0].id;

    // Advance clock 60 seconds → hold timer fires → queued.
    await vi.advanceTimersByTimeAsync(60_001);

    const afterHold = getSignal(db, signalId);
    expect(afterHold?.state).toBe('queued');
    expect(countRows(db, 'leadspot_outbox')).toBe(1);

    // Switch to real timers and re-stamp mirror fresh (fake time was used for ingest,
    // real time is needed for assertMirrorFresh to pass).
    vi.useRealTimers();
    stampMirrorFresh(db);

    // Make sure the outbox row's next_attempt_at is in the past (due for send).
    db.prepare('UPDATE leadspot_outbox SET next_attempt_at = ? WHERE signal_id = ?').run(
      Date.now() - 1,
      signalId,
    );

    const result = await tickPromote(ctx);
    expect(result.promoted).toBe(1);
    expect(result.errors).toBe(0);

    const afterPromote = getSignal(db, signalId);
    expect(afterPromote?.state).toBe('promoted');
    expect(afterPromote?.promoted_at).not.toBeNull();
    expect(countRows(db, 'leadspot_outbox')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Cancel path (user clicks toast)
// ---------------------------------------------------------------------------

describe('promote state machine — cancel path', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('cancelHeld transitions held_local → dropped and returns true', async () => {
    const { candidate } = setupContactWithHighConfidence(db);
    await ingestCandidates(ctx, [candidate], 'ocr-hash-cancel');

    const row = db
      .prepare("SELECT id FROM leadspot_signals WHERE state = 'held_local'")
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();
    const signalId = row!.id;

    const cancelled = await cancelHeld(ctx, signalId);
    expect(cancelled).toBe(true);

    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('dropped');
    expect(signal?.cancelled_at).not.toBeNull();
  });

  it('cancelHeld returns false when signal is already past held_local', async () => {
    const { candidate } = setupContactWithHighConfidence(db);
    await ingestCandidates(ctx, [candidate], 'ocr-hash-late-cancel');

    const row = db
      .prepare("SELECT id FROM leadspot_signals WHERE state = 'held_local'")
      .get() as { id: string } | undefined;
    const signalId = row!.id;

    // Timer fires first.
    await vi.advanceTimersByTimeAsync(60_001);

    // Now cancel arrives — too late.
    const cancelled = await cancelHeld(ctx, signalId);
    expect(cancelled).toBe(false);

    // State should be queued (timer won), not dropped.
    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// 3. CRITICAL: cancel-timer race — the transitionFromHeldLocal atomic fix
// ---------------------------------------------------------------------------

describe('promote state machine — cancel-timer race (critical)', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('when cancelHeld wins the race, final state is dropped not queued', async () => {
    const { candidate } = setupContactWithHighConfidence(db);
    await ingestCandidates(ctx, [candidate], 'ocr-hash-race-cancel-wins');

    const row = db
      .prepare("SELECT id FROM leadspot_signals WHERE state = 'held_local'")
      .get() as { id: string } | undefined;
    const signalId = row!.id;

    // cancelHeld runs first (wins the conditional UPDATE).
    const cancelWon = await cancelHeld(ctx, signalId);
    expect(cancelWon).toBe(true);

    // Now simulate the timer body running directly (as in a restart sweep).
    // transitionFromHeldLocal is conditional — it only transitions if state='held_local'.
    // Since cancelHeld already moved it to 'dropped', this is a no-op.
    const timerWon = transitionFromHeldLocal(db, signalId, 'queued');
    expect(timerWon).toBe(false);

    // Final state must be 'dropped', not 'queued'.
    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('dropped');
    expect(countRows(db, 'leadspot_outbox')).toBe(0);
  });

  it('when timer wins the race, final state is queued not dropped', async () => {
    const { candidate } = setupContactWithHighConfidence(db);
    await ingestCandidates(ctx, [candidate], 'ocr-hash-race-timer-wins');

    const row = db
      .prepare("SELECT id FROM leadspot_signals WHERE state = 'held_local'")
      .get() as { id: string } | undefined;
    const signalId = row!.id;

    // Timer body runs first.
    const timerWon = transitionFromHeldLocal(db, signalId, 'queued');
    expect(timerWon).toBe(true);

    // Now cancelHeld arrives — too late.
    vi.useRealTimers();
    const cancelWon = await cancelHeld(ctx, signalId);
    expect(cancelWon).toBe(false);

    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('queued');
  });

  it('race scenario: both cancelHeld and timer body invoked synchronously — exactly one wins', () => {
    const { candidate } = setupContactWithHighConfidence(db);

    // Insert a held_local signal directly (sync, no need to await ingestCandidates for this unit test).
    const signalId = randomUUID();
    db
      .prepare(
        `INSERT INTO leadspot_signals
          (id, idempotency_key, contact_id, contact_match_key, source, source_app,
           extractor, summary, confidence, state, observed_at, created_at)
         VALUES (?, ?, ?, ?, 'ambient_screen', null, 'explicit_email', 'summary', 90, 'held_local', ?, ?)`,
      )
      .run(
        signalId,
        'idem-key-race-sync',
        'contact-001',
        candidate.matchKey,
        Date.now(),
        Date.now(),
      );

    // Two callers race: cancel → queued. Both use the atomic conditional UPDATE.
    const won1 = transitionFromHeldLocal(db, signalId, 'dropped', { cancelledAt: Date.now() });
    const won2 = transitionFromHeldLocal(db, signalId, 'queued');

    // Exactly one should succeed.
    expect(won1 !== won2).toBe(true);

    const signal = getSignal(db, signalId);
    // State is whatever the winner set — either 'dropped' or 'queued', never both.
    expect(['dropped', 'queued']).toContain(signal?.state);
  });
});

// ---------------------------------------------------------------------------
// 4. Self-identity: signals to own email are always dropped
// ---------------------------------------------------------------------------

describe('promote state machine — self-identity drop', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    stampMirrorFresh(db);
  });

  afterEach(() => {
    db.close();
  });

  it('candidate matching user email hash is dropped with dropReason=self', async () => {
    const userEmail = 'mike@leadspot.ai';
    await addAlias(db, userEmail, 'oauth');

    const selfHash = emailHash(userEmail);
    const selfCandidate: SignalCandidate = {
      extractor: 'explicit_email',
      matchKey: selfHash,
      matchKeyType: 'email_hash',
      baseConfidence: 90,
      redactedSummary: 'Email mention · leadspot.ai',
      ocrSnippetHash: undefined,
    };

    const result = await ingestCandidates(ctx, [selfCandidate], 'ocr-self');
    expect(result.dropped).toBe(1);
    expect(result.accepted).toBe(0);

    const signal = db
      .prepare('SELECT state, extras FROM leadspot_signals')
      .get() as { state: string; extras: string } | undefined;
    expect(signal?.state).toBe('dropped');

    const extras = signal?.extras ? JSON.parse(signal.extras) as { drop_reason: string } : null;
    expect(extras?.drop_reason).toBe('self');
  });
});

// ---------------------------------------------------------------------------
// 5. Unmatched signals — drop + write to unmatched log
// ---------------------------------------------------------------------------

describe('promote state machine — unmatched candidates', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    stampMirrorFresh(db);
  });

  afterEach(() => {
    db.close();
  });

  it('candidate with no mirror match is dropped and written to unmatched log', async () => {
    const unknownHash = emailHash('stranger@nowhere.com');
    const candidate: SignalCandidate = {
      extractor: 'explicit_email',
      matchKey: unknownHash,
      matchKeyType: 'email_hash',
      baseConfidence: 90,
      redactedSummary: 'Email mention · nowhere.com',
      ocrSnippetHash: undefined,
    };

    await ingestCandidates(ctx, [candidate], 'ocr-unmatched');

    expect(countRows(db, 'leadspot_unmatched')).toBe(1);
    const signal = db
      .prepare('SELECT state FROM leadspot_signals')
      .get() as { state: string } | undefined;
    expect(signal?.state).toBe('dropped');
  });

  it('self-identity match is dropped but NOT written to unmatched log', async () => {
    await addAlias(db, 'mike@leadspot.ai', 'oauth');
    const selfHash = emailHash('mike@leadspot.ai');
    const candidate: SignalCandidate = {
      extractor: 'explicit_email',
      matchKey: selfHash,
      matchKeyType: 'email_hash',
      baseConfidence: 90,
      redactedSummary: 'Email mention · leadspot.ai',
      ocrSnippetHash: undefined,
    };

    await ingestCandidates(ctx, [candidate], 'ocr-self-no-unmatched');
    // Self drops → no unmatched entry (it's not "unknown", it's known-self)
    expect(countRows(db, 'leadspot_unmatched')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 426 VersionMismatchError bubbles out of tickPromote
// ---------------------------------------------------------------------------

describe('promote state machine — 426 version mismatch', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('tickPromote throws VersionMismatchError when client returns 426', async () => {
    const versionErr = new VersionMismatchError(
      'Daemon version rejected (426)',
      { minVersion: '2.0.0', currentVersion: '1.0.0' },
    );
    ctx = makeContext(db, { postSignalError: versionErr });

    // Insert a signal directly in queued state + outbox row so tickPromote has work.
    stampMirrorFresh(db);
    const signalId = randomUUID();
    const now = Date.now();
    db
      .prepare(
        `INSERT INTO leadspot_signals
          (id, idempotency_key, contact_id, contact_match_key, source, source_app,
           extractor, summary, confidence, state, observed_at, created_at)
         VALUES (?, ?, null, 'key', 'ambient_screen', null, 'explicit_email', 'test', 90, 'queued', ?, ?)`,
      )
      .run(signalId, 'idem-426-test', now, now);
    db
      .prepare(
        'INSERT INTO leadspot_outbox (signal_id, attempts, next_attempt_at, enqueued_at) VALUES (?, 0, ?, ?)',
      )
      .run(signalId, now - 1, now - 1);

    vi.useRealTimers();

    await expect(tickPromote(ctx)).rejects.toThrow(VersionMismatchError);
  });
});

// ---------------------------------------------------------------------------
// 7. Stale held_local recovery (daemon restart simulation)
// ---------------------------------------------------------------------------

describe('promote state machine — stale held_local recovery', () => {
  let db: Database.Database;
  let ctx: PromoteContext;

  beforeEach(() => {
    db = openTestDb();
    ctx = makeContext(db);
    stampMirrorFresh(db);
  });

  afterEach(() => {
    db.close();
  });

  it('held_local rows older than 60s are swept out of held_local on next tickPromote', async () => {
    // Insert a held_local row with observed_at 70s ago (timer would have fired during downtime).
    const signalId = randomUUID();
    const staleTs = Date.now() - 70_000;

    db
      .prepare(
        `INSERT INTO leadspot_signals
          (id, idempotency_key, contact_id, contact_match_key, source, source_app,
           extractor, summary, confidence, state, observed_at, created_at)
         VALUES (?, ?, null, 'key', 'ambient_screen', null, 'explicit_email', 'stale', 90, 'held_local', ?, ?)`,
      )
      .run(signalId, 'idem-stale-001', staleTs, staleTs);

    // tickPromote calls promoteStaleHeldLocal which sweeps to queued,
    // then immediately drains the outbox (so the signal may end up in 'promoted'
    // if the mock client succeeds). Either way, it must NOT remain 'held_local'.
    await tickPromote(ctx);

    const signal = getSignal(db, signalId);
    // State must be queued or promoted — never stuck in held_local.
    expect(signal?.state).not.toBe('held_local');
    expect(['queued', 'promoted']).toContain(signal?.state);
  });

  it('fresh held_local row (within 60s) is not swept by tickPromote', async () => {
    const signalId = randomUUID();
    const freshTs = Date.now() - 10_000; // Only 10s old.

    db
      .prepare(
        `INSERT INTO leadspot_signals
          (id, idempotency_key, contact_id, contact_match_key, source, source_app,
           extractor, summary, confidence, state, observed_at, created_at)
         VALUES (?, ?, null, 'key', 'ambient_screen', null, 'explicit_email', 'fresh', 90, 'held_local', ?, ?)`,
      )
      .run(signalId, 'idem-fresh-001', freshTs, freshTs);

    await tickPromote(ctx);

    const signal = getSignal(db, signalId);
    expect(signal?.state).toBe('held_local');
  });
});

// ---------------------------------------------------------------------------
// 8. Property-based: signal lifecycle sequences always terminate cleanly
// ---------------------------------------------------------------------------

describe('property-based: all lifecycle paths reach a terminal state', () => {
  it('any (ingest → optional-cancel → tickPromote) sequence terminates without stuck held_local', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate: should we cancel, and what confidence level?
        fc.boolean(),
        fc.integer({ min: 0, max: 2 }), // 0=unmatched, 1=matched-high, 2=self
        async (shouldCancel, contactScenario) => {
          const db = openTestDb();
          vi.useFakeTimers();

          try {
            stampMirrorFresh(db);
            const ctx = makeContext(db);
            let candidate: SignalCandidate;

            if (contactScenario === 2) {
              // Self identity scenario.
              const selfEmail = 'self@test.com';
              await addAlias(db, selfEmail, 'oauth');
              candidate = {
                extractor: 'explicit_email',
                matchKey: emailHash(selfEmail),
                matchKeyType: 'email_hash',
                baseConfidence: 90,
                redactedSummary: 'test',
              };
            } else if (contactScenario === 1) {
              // Matched contact with high confidence.
              const h = emailHash(`prop-test-${randomUUID()}@domain.com`);
              insertContact(db, {
                contactId: randomUUID(),
                emailHash: h,
                aliases: [h],
              });
              candidate = {
                extractor: 'explicit_email',
                matchKey: h,
                matchKeyType: 'email_hash',
                baseConfidence: 90,
                redactedSummary: 'test',
              };
            } else {
              // Unknown contact → unmatched → dropped.
              candidate = {
                extractor: 'explicit_email',
                matchKey: emailHash(`unknown-${randomUUID()}@nowhere.com`),
                matchKeyType: 'email_hash',
                baseConfidence: 90,
                redactedSummary: 'test',
              };
            }

            await ingestCandidates(ctx, [candidate], randomUUID());

            if (shouldCancel) {
              const held = db
                .prepare("SELECT id FROM leadspot_signals WHERE state = 'held_local'")
                .get() as { id: string } | undefined;
              if (held !== undefined) {
                await cancelHeld(ctx, held.id);
              }
            }

            // Advance time past hold window.
            await vi.advanceTimersByTimeAsync(65_000);
            vi.useRealTimers();

            await tickPromote(ctx);

            // No signal should remain in held_local.
            const stuckRows = db
              .prepare("SELECT COUNT(*) as n FROM leadspot_signals WHERE state = 'held_local'")
              .get() as { n: number };
            expect(stuckRows.n).toBe(0);

            // Every signal must be in a valid terminal or intermediate state.
            const allStates = db
              .prepare('SELECT state FROM leadspot_signals')
              .all() as Array<{ state: string }>;
            const validStates = new Set([
              'captured', 'enriched', 'matched', 'queued', 'promoted',
              'dropped', 'held', 'redacted', 'archived',
            ]);
            for (const row of allStates) {
              expect(validStates.has(row.state)).toBe(true);
            }

          } finally {
            vi.useRealTimers();
            db.close();
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('summary of promoted signals never contains a raw email address', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        async (rawEmail) => {
          const db = openTestDb();
          try {
            stampMirrorFresh(db);
            const h = emailHash(rawEmail);
            insertContact(db, {
              contactId: randomUUID(),
              emailHash: h,
              aliases: [h],
            });
            const ctx = makeContext(db);
            const candidate: SignalCandidate = {
              extractor: 'explicit_email',
              matchKey: h,
              matchKeyType: 'email_hash',
              baseConfidence: 90,
              redactedSummary: `Email mention · ${rawEmail.split('@')[1] ?? 'example.com'}`,
            };
            await ingestCandidates(ctx, [candidate], randomUUID());

            const rows = db
              .prepare('SELECT summary FROM leadspot_signals')
              .all() as Array<{ summary: string }>;
            for (const row of rows) {
              // Summary should NOT contain the raw email local@domain form.
              expect(row.summary).not.toContain(rawEmail);
            }
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it('idempotency: same idempotency_key ingested twice → exactly one row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (repetitions) => {
          const db = openTestDb();
          try {
            const now = Date.now();
            vi.setSystemTime(now);
            stampMirrorFresh(db);

            const h = emailHash(`idem-prop-${randomUUID()}@test.com`);
            insertContact(db, {
              contactId: randomUUID(),
              emailHash: h,
              aliases: [h],
            });
            const ctx = makeContext(db);
            const candidate: SignalCandidate = {
              extractor: 'explicit_email',
              matchKey: h,
              matchKeyType: 'email_hash',
              baseConfidence: 90,
              redactedSummary: 'Email mention · test.com',
            };
            const ocrHash = 'fixed-ocr-for-idem-prop';

            for (let i = 0; i < repetitions + 1; i += 1) {
              await ingestCandidates(ctx, [candidate], ocrHash);
            }

            vi.useRealTimers();
            const count = countRows(db, 'leadspot_signals');
            expect(count).toBe(1);
          } finally {
            vi.useRealTimers();
            db.close();
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
